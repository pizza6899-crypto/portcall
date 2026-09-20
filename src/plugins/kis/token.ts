import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { digest, log } from '../../log.js';

/**
 * KIS access tokens.
 *
 * A token is valid for 24 hours, but KIS refuses to issue another one within a
 * minute of the last (`EGW00133`). Caching is therefore not an optimisation:
 * without it the second request of the day is locked out. The cache has to
 * outlive the request too — `inProcess` builds a fresh MCP server per request,
 * so anything held on the server instance is gone by the next call.
 */

/** Renew this far ahead of the stated expiry so no request races the cutover. */
const RENEW_MARGIN_MS = 10 * 60_000;

/** Assumed lifetime when the response omits `expires_in`. */
const ASSUMED_LIFETIME_MS = 24 * 60 * 60_000;

/** How long the token request may take. It is a single small POST. */
const TOKEN_TIMEOUT_MS = 15_000;

export interface KisToken {
  value: string;
  /** Epoch millis at which the token stops being valid. */
  expiresAt: number;
}

export interface TokenStoreOptions {
  baseUrl: string;
  appKey: string;
  appSecret: string;
  /**
   * File the token is mirrored to. A daemon restart would otherwise ask for a
   * new token, which is the one thing KIS rate-limits hardest.
   */
  cachePath?: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface TokenStore {
  /** A token that is valid now, issuing or reloading one if needed. */
  get(): Promise<string>;
}

interface CacheFile {
  /** Which app key this token belongs to, so a key swap cannot reuse a stale token. */
  appKey: string;
  value: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  error_code?: unknown;
  error_description?: unknown;
  msg_cd?: unknown;
  msg1?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function createTokenStore(options: TokenStoreOptions): TokenStore {
  const { baseUrl, appKey, appSecret, cachePath, fetchImpl = fetch, now = Date.now } = options;
  const owner = digest(appKey);

  let cached: KisToken | undefined;
  let inflight: Promise<KisToken> | undefined;
  let diskChecked = false;

  function usable(token: KisToken | undefined): token is KisToken {
    return token !== undefined && token.expiresAt - RENEW_MARGIN_MS > now();
  }

  async function fromDisk(): Promise<KisToken | undefined> {
    if (cachePath === undefined) return undefined;
    try {
      const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as CacheFile;
      if (parsed.appKey !== owner || typeof parsed.value !== 'string') return undefined;
      return { value: parsed.value, expiresAt: parsed.expiresAt };
    } catch {
      // A missing or unreadable cache is normal on first run; issue a token instead.
      return undefined;
    }
  }

  async function toDisk(token: KisToken): Promise<void> {
    if (cachePath === undefined) return;
    const body: CacheFile = { appKey: owner, value: token.value, expiresAt: token.expiresAt };
    try {
      await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
      await writeFile(cachePath, JSON.stringify(body), { mode: 0o600 });
    } catch (error) {
      // Losing the mirror costs one extra issue after a restart, not correctness.
      log.warn('could not persist KIS token', { error: (error as Error).message });
    }
  }

  async function issue(): Promise<KisToken> {
    const issuedAt = now();
    // Every KIS tool call waits on this one request when the cache is cold,
    // so a stall here stalls all of them, not just the caller that triggered it.
    const response = await fetchImpl(`${baseUrl}/oauth2/tokenP`, {
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
    });

    const body = (await response.json().catch(() => ({}))) as TokenResponse;
    const token = text(body.access_token);

    if (!response.ok || token === undefined) {
      const code = text(body.error_code) ?? text(body.msg_cd);
      const reason = text(body.error_description) ?? text(body.msg1) ?? `HTTP ${response.status}`;
      const hint =
        code === 'EGW00133'
          ? ' — KIS allows one token per minute; the previous one has to be reused until the window passes'
          : '';
      throw new Error(`KIS token request failed${code === undefined ? '' : ` (${code})`}: ${reason}${hint}`);
    }

    // `expires_in` is a duration, so it needs no timezone reasoning. The
    // response also carries `access_token_token_expired`, but that is KST
    // wall-clock text and only worth parsing if the duration ever goes missing.
    const lifetimeMs = typeof body.expires_in === 'number' ? body.expires_in * 1000 : ASSUMED_LIFETIME_MS;
    return { value: token, expiresAt: issuedAt + lifetimeMs };
  }

  return {
    async get(): Promise<string> {
      if (usable(cached)) return cached.value;

      if (!diskChecked) {
        diskChecked = true;
        const stored = await fromDisk();
        if (usable(stored)) {
          cached = stored;
          return stored.value;
        }
      }

      // Single-flight: concurrent tool calls on a cold cache must not each ask
      // KIS for a token, since the second ask is the one that gets refused.
      inflight ??= issue()
        .then(async (token) => {
          cached = token;
          await toDisk(token);
          return token;
        })
        .finally(() => {
          inflight = undefined;
        });

      return (await inflight).value;
    },
  };
}
