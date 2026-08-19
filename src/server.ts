import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NodeIncomingMessageLike, NodeMcpRequestHandler } from '@modelcontextprotocol/node';

import { plugins } from '../plugins.config.js';
import { isAuthorized } from './auth.js';
import { config } from './config.js';
import { log } from './log.js';
import { resolveMounts, routeKey } from './routes.js';
import type { Plugin } from './types.js';

const startedAt = Date.now();

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

interface Route {
  plugin: Plugin;
  handle: NodeMcpRequestHandler;
}

/**
 * Adapt each mounted plugin to a Node request handler.
 *
 * Aliased routes share one plugin instance, so they share one adapter too.
 */
function buildRoutes(mounts: Map<string, Plugin>): Map<string, Route> {
  const adapters = new Map<Plugin, NodeMcpRequestHandler>();
  const routes = new Map<string, Route>();

  for (const [route, plugin] of mounts) {
    let handle = adapters.get(plugin);
    if (handle === undefined) {
      handle = toNodeHandler(plugin.handler, {
        onerror: (error) => log.error('request failed', { plugin: plugin.name, error: error.message }),
      });
      adapters.set(plugin, handle);
    }
    routes.set(route, { plugin, handle });
  }

  return routes;
}

const routes = buildRoutes(resolveMounts(plugins, config.aliasRootMcp));

const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
  const pathname = routeKey(req.url);

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

  if (!isAuthorized(req.headers.authorization, config.token)) {
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
