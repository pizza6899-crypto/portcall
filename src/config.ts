/** Environment-derived settings. Nothing host-specific is baked into the source. */

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

export function required(name: string): string {
  const value = optional(name);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  }
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean, got: ${raw}`);
}

export const config = {
  /** TCP port to listen on. */
  port: integer('PORTCALL_PORT', 7100),
  /** Interface to bind. Defaults to loopback — put a tunnel or proxy in front to expose it. */
  host: optional('PORTCALL_HOST') ?? '127.0.0.1',

  /**
   * Static bearer token. When set, every MCP request must carry
   * `Authorization: Bearer <token>`. Unset means no authentication — only safe
   * when something in front of Portcall is doing the gating.
   */
  token: optional('PORTCALL_TOKEN'),

  /**
   * Mount the plugin with this `path` at `/mcp` as well as `/<path>/mcp`.
   * Useful when migrating clients that are already pointed at `/mcp`.
   */
  aliasRootMcp: optional('PORTCALL_ALIAS_ROOT_MCP'),

  /**
   * Secret path segment to serve every mount under, turning `/vault/mcp` into
   * `/<prefix>/vault/mcp`. Unset serves the mounts at their bare paths.
   *
   * For clients that cannot send an `Authorization` header, the URL is the only
   * channel left that can carry a secret. Treat it as one: it reaches proxy
   * logs, so it raises the bar rather than replacing authentication.
   */
  pathPrefix: optional('PORTCALL_PATH_PREFIX'),

  /**
   * SSE comment-frame keepalive interval, in milliseconds. `0` disables it.
   * Some reverse proxies withhold response headers until the first body byte
   * arrives; a shorter interval makes streams surface faster behind those.
   */
  keepAliveMs: integer('PORTCALL_KEEPALIVE_MS', 15_000),

  /** Reject 2025-era (pre-`2026-07-28`) requests instead of serving them statelessly. */
  modernOnly: boolean('PORTCALL_MODERN_ONLY', false),
};

export type Config = typeof config;
