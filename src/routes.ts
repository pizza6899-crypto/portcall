import type { Plugin } from './types.js';

export interface MountOptions {
  /** Also serve the named plugin at the prefix root, e.g. `/mcp`. */
  aliasRootMcp?: string | undefined;
  /**
   * Secret path segment every mount is served under.
   *
   * Clients that cannot send a request header (Claude's custom connector among
   * them) can still carry a secret in the URL. It is a bearer secret in a
   * weaker location than a header — it reaches proxy logs — so it raises the
   * bar without replacing real authentication.
   */
  pathPrefix?: string | undefined;
}

function assertSegment(value: string, what: string): void {
  if (value === '' || value.includes('/')) {
    throw new Error(`${what} must be a single non-empty path segment, got: ${value}`);
  }
}

/**
 * Work out which URL path serves which plugin.
 *
 * Kept free of transport concerns so the mount table — including the alias and
 * the secret prefix, whose silent breakage would look like a dead connector
 * rather than an error — can be checked directly.
 */
export function resolveMounts(plugins: Plugin[], options: MountOptions = {}): Map<string, Plugin> {
  const { aliasRootMcp, pathPrefix } = options;

  if (pathPrefix !== undefined) assertSegment(pathPrefix, 'PORTCALL_PATH_PREFIX');
  const base = pathPrefix === undefined ? '' : `/${pathPrefix}`;

  const mounts = new Map<string, Plugin>();

  for (const plugin of plugins) {
    assertSegment(plugin.path, `Plugin "${plugin.name}" mount path`);
    const route = `${base}/${plugin.path}/mcp`;
    if (mounts.has(route)) {
      throw new Error(`Two plugins are mounted at ${route}`);
    }
    mounts.set(route, plugin);
  }

  if (aliasRootMcp !== undefined) {
    const target = mounts.get(`${base}/${aliasRootMcp}/mcp`);
    if (target === undefined) {
      throw new Error(`PORTCALL_ALIAS_ROOT_MCP points at unknown plugin path: ${aliasRootMcp}`);
    }
    mounts.set(`${base}/mcp`, target);
  }

  return mounts;
}

/**
 * Where the mount-listing health payload lives.
 *
 * With a secret prefix configured it moves behind that prefix: the listing
 * names every mount, so serving it at a guessable path would hand out the
 * secret to anyone who found the hostname.
 */
export function detailedHealthRoute(pathPrefix?: string | undefined): string {
  return pathPrefix === undefined ? '/healthz' : `/${pathPrefix}/healthz`;
}

/** Normalise a request URL to the form the mount table is keyed by. */
export function routeKey(url: string | undefined): string {
  const pathname = new URL(url ?? '/', 'http://localhost').pathname;
  return pathname.replace(/\/+$/, '') || '/';
}
