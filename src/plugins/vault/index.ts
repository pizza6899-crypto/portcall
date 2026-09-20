import { createServer } from '@bitbonsai/mcpvault';

import { inProcess } from '../../adapters/inProcess.js';
import type { Plugin } from '../../types.js';
import { imageTools } from './image.js';
import { mergeTools } from './merge.js';

export interface VaultPluginOptions {
  /** Absolute path to the Obsidian vault to serve. */
  vaultPath: string;
  /** Mount segment. Defaults to `vault`, serving `/vault/mcp`. */
  path?: string;
  /** Expose read-only tools and reject calls to mutating ones. */
  readOnly?: boolean;
  /**
   * Directories outside the vault that `write_image` may copy from, for
   * getting a screenshot off the desktop and into a note. Empty by default.
   */
  importRoots?: readonly string[];
}

/**
 * mcpvault plus this project's image tools, served in-process on one mount.
 *
 * mcpvault reads and writes notes but has nothing for attachments, so an
 * embedded screenshot reaches a model as the literal text `![[shot.png]]`.
 * The image tools fill that in. They are merged into mcpvault's listing
 * rather than mounted separately so the vault stays one connector.
 */
export function vaultPlugin(options: VaultPluginOptions): Plugin {
  const { vaultPath, path = 'vault', readOnly = false, importRoots = [] } = options;
  const name = `mcpvault(${path})`;
  const extras = imageTools({ vaultPath, readOnly, importRoots });

  return {
    name,
    path,
    handler: inProcess(name, () =>
      mergeTools(() => createServer(vaultPath, { readOnly }), extras, {
        name: 'portcall-vault',
        version: '0.1.0',
      }),
    ),
  };
}
