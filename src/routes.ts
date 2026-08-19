import type { Plugin } from './types.js';

/**
 * Work out which URL path serves which plugin.
 *
 * Kept free of transport concerns so the mount table — including the alias,
 * whose silent breakage would look like a dead connector rather than an
 * error — can be checked directly.
 */
export function resolveMounts(plugins: Plugin[], aliasRootMcp?: string | undefined): Map<string, Plugin> {
  const mounts = new Map<string, Plugin>();

  for (const plugin of plugins) {
    if (plugin.path === '' || plugin.path.includes('/')) {
      throw new Error(`Plugin "${plugin.name}" has an invalid mount path: ${plugin.path}`);
    }
    const route = `/${plugin.path}/mcp`;
    if (mounts.has(route)) {
      throw new Error(`Two plugins are mounted at ${route}`);
    }
    mounts.set(route, plugin);
  }

  if (aliasRootMcp !== undefined) {
    const target = mounts.get(`/${aliasRootMcp}/mcp`);
    if (target === undefined) {
      throw new Error(`PORTCALL_ALIAS_ROOT_MCP points at unknown plugin path: ${aliasRootMcp}`);
    }
    mounts.set('/mcp', target);
  }

  return mounts;
}

/** Normalise a request URL to the form the mount table is keyed by. */
export function routeKey(url: string | undefined): string {
  const pathname = new URL(url ?? '/', 'http://localhost').pathname;
  return pathname.replace(/\/+$/, '') || '/';
}
