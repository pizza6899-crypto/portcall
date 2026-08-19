import { createServer } from '@bitbonsai/mcpvault';

import { inProcess } from '../adapters/inProcess.js';
import type { Plugin } from '../types.js';

export interface VaultPluginOptions {
  /** Absolute path to the Obsidian vault to serve. */
  vaultPath: string;
  /** Mount segment. Defaults to `vault`, serving `/vault/mcp`. */
  path?: string;
  /** Expose read-only tools and reject calls to mutating ones. */
  readOnly?: boolean;
}

/**
 * mcpvault, served in-process.
 *
 * `createServer` is mcpvault's public library entry point and returns an MCP
 * SDK v2 `Server`, so it plugs straight into the handler with no bridge.
 */
export function vaultPlugin(options: VaultPluginOptions): Plugin {
  const { vaultPath, path = 'vault', readOnly = false } = options;
  const name = `mcpvault(${path})`;

  return {
    name,
    path,
    handler: inProcess(name, () => createServer(vaultPath, { readOnly })),
  };
}
