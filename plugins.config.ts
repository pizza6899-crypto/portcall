/**
 * Which plugins are mounted, and where.
 *
 * Host-specific values (vault paths, ports, tokens) come from the environment
 * so this file stays safe to commit.
 */
import { optional, required } from './src/config.js';
import { kisPlugin } from './src/plugins/kis/index.js';
import { vaultPlugin } from './src/plugins/vault.js';
import type { Plugin } from './src/types.js';

/**
 * KIS credentials are optional: a host that has not set them up mounts the
 * vault alone rather than failing to boot on a missing variable.
 */
const kisAppKey = optional('KIS_APP_KEY');

/**
 * `KIS_ACCOUNT` is the account number as the app shows it, `12345678-01`.
 * Without it the mount serves quotations only — prices are public, a
 * portfolio is not, so exposing one is opt-in separately from the other.
 */
function kisAccount(): { cano: string; productCode: string } | undefined {
  const raw = optional('KIS_ACCOUNT');
  if (raw === undefined) return undefined;

  const match = /^(\d{8})-?(\d{2})$/.exec(raw);
  if (match === null) {
    // The value is not echoed: startup errors land in a log file, and an
    // account number — or a secret pasted into the wrong variable — does not
    // belong there.
    throw new Error('KIS_ACCOUNT must look like 12345678-01');
  }
  return { cano: match[1]!, productCode: match[2]! };
}

export const plugins: Plugin[] = [
  vaultPlugin({
    vaultPath: required('PORTCALL_VAULT_PATH'),
    path: 'vault',
  }),
  ...(kisAppKey === undefined
    ? []
    : [
        kisPlugin({
          appKey: kisAppKey,
          appSecret: required('KIS_APP_SECRET'),
          account: kisAccount(),
          path: 'kis',
        }),
      ]),
];
