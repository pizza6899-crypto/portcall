import { homedir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/server';

import { inProcess } from '../../adapters/inProcess.js';
import type { Plugin } from '../../types.js';
import { PAPER_BASE_URL, REAL_BASE_URL, createKisClient } from './client.js';
import { createHistoryStore } from './history.js';
import { registerTools, type KisAccount } from './tools.js';
import { createTokenStore } from './token.js';

export interface KisPluginOptions {
  /** App key from the KIS developer portal. */
  appKey: string;
  /** App secret paired with that key. */
  appSecret: string;
  /** Mount segment. Defaults to `kis`, serving `/kis/mcp`. */
  path?: string;
  /** Use the paper-trading domain. Quotation coverage there is thinner than on real. */
  paper?: boolean;
  /**
   * Account to expose holdings, executions and realised P&L for. Omitted, the
   * plugin serves quotations only and nothing about a portfolio.
   */
  account?: KisAccount | undefined;
  /** Where the access token is mirrored between restarts. */
  tokenCachePath?: string;
  /** Where assembled price histories are kept between restarts. */
  historyCacheDir?: string;
}

function cacheRoot(): string {
  const base = process.env['XDG_CACHE_HOME'];
  return join(base !== undefined && base.trim() !== '' ? base : join(homedir(), '.cache'), 'portcall');
}

/**
 * Korea Investment & Securities quotations, served in-process.
 *
 * Read-only: the plugin implements inquiry tools only, and its client rejects
 * both endpoints outside the allowlist and tr_ids that are not inquiries, so
 * nothing here can place or cancel an order — including the account tools,
 * which share KIS's `/trading/` namespace with the order endpoints.
 *
 * The token store and client are built once, here, rather than inside the
 * factory. `inProcess` constructs a fresh MCP server per request, so a cache
 * held on the server instance would be discarded between calls — and asking
 * KIS for a token per call is exactly what it refuses (`EGW00133`).
 */
export function kisPlugin(options: KisPluginOptions): Plugin {
  const {
    appKey,
    appSecret,
    path = 'kis',
    paper = false,
    account,
    tokenCachePath = join(cacheRoot(), 'kis-token.json'),
    historyCacheDir = join(cacheRoot(), 'history'),
  } = options;
  const name = `kis(${path})`;
  const baseUrl = paper ? PAPER_BASE_URL : REAL_BASE_URL;

  const tokens = createTokenStore({ baseUrl, appKey, appSecret, cachePath: tokenCachePath });
  const client = createKisClient({ baseUrl, appKey, appSecret, getToken: () => tokens.get() });
  // Built here for the same reason the token store is: `inProcess` makes a
  // fresh server per request, so a venue lookup held on the server instance
  // would be thrown away between calls.
  const history = createHistoryStore({ client, cacheDir: historyCacheDir });

  return {
    name,
    path,
    handler: inProcess(name, () => {
      const server = new McpServer({ name: 'portcall-kis', version: '0.1.0' });
      registerTools(server, client, account, history);
      return server;
    }),
  };
}
