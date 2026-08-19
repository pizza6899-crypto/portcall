import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NodeIncomingMessageLike, NodeMcpRequestHandler } from '@modelcontextprotocol/node';

import { plugins } from '../plugins.config.js';
import { config } from './config.js';
import { log } from './log.js';
import type { Plugin } from './types.js';

const startedAt = Date.now();

/** Constant-time string compare that tolerates differing lengths. */
function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still compare, so the branch cost does not leak the length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function isAuthorized(req: IncomingMessage): boolean {
  if (config.token === undefined) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return false;
  return secretEquals(rest.join(' ').trim(), config.token);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Build the `/<path>/mcp` route table, plus the optional `/mcp` alias. */
function buildRoutes(mounted: Plugin[]): Map<string, { plugin: Plugin; handle: NodeMcpRequestHandler }> {
  const routes = new Map<string, { plugin: Plugin; handle: NodeMcpRequestHandler }>();

  for (const plugin of mounted) {
    if (plugin.path.includes('/')) {
      throw new Error(`Plugin "${plugin.name}" has an invalid mount path: ${plugin.path}`);
    }
    const route = `/${plugin.path}/mcp`;
    if (routes.has(route)) {
      throw new Error(`Two plugins are mounted at ${route}`);
    }
    const handle = toNodeHandler(plugin.handler, {
      onerror: (error) => log.error('request failed', { plugin: plugin.name, error: error.message }),
    });
    routes.set(route, { plugin, handle });
  }

  const alias = config.aliasRootMcp;
  if (alias !== undefined) {
    const target = routes.get(`/${alias}/mcp`);
    if (target === undefined) {
      throw new Error(`PORTCALL_ALIAS_ROOT_MCP points at unknown plugin path: ${alias}`);
    }
    routes.set('/mcp', target);
  }

  return routes;
}

const routes = buildRoutes(plugins);

const httpServer = createHttpServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/healthz') {
    json(res, 200, {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      authRequired: config.token !== undefined,
      mounts: [...routes.entries()].map(([route, { plugin }]) => ({ route, plugin: plugin.name })),
    });
    return;
  }

  const route = routes.get(pathname);
  if (route === undefined) {
    json(res, 404, { error: 'not_found', mounts: [...routes.keys()] });
    return;
  }

  if (!isAuthorized(req)) {
    res.setHeader('www-authenticate', 'Bearer');
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  // `IncomingMessage` declares `method`/`url` as `string | undefined`, which the
  // adapter's duck type rejects under `exactOptionalPropertyTypes`. The shapes are
  // otherwise identical, so narrow at this single boundary.
  void route.handle(req as NodeIncomingMessageLike, res).catch((error: unknown) => {
    log.error('unhandled dispatch failure', {
      plugin: route.plugin.name,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) json(res, 500, { error: 'internal_error' });
    else res.end();
  });
});

httpServer.listen(config.port, config.host, () => {
  log.info('portcall listening', {
    address: `http://${config.host}:${config.port}`,
    mounts: [...routes.keys()],
    authRequired: config.token !== undefined,
  });
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    httpServer.close(() => {
      Promise.allSettled(plugins.map((plugin) => plugin.handler.close()))
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });

    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
