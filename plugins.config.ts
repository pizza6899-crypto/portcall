/**
 * Which plugins are mounted, and where.
 *
 * Host-specific values (vault paths, ports, tokens) come from the environment
 * so this file stays safe to commit.
 */
import { required } from './src/config.js';
import { vaultPlugin } from './src/plugins/vault.js';
import type { Plugin } from './src/types.js';

export const plugins: Plugin[] = [
  vaultPlugin({
    vaultPath: required('PORTCALL_VAULT_PATH'),
    path: 'vault',
  }),
];
