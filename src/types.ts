import type { McpHttpHandler } from '@modelcontextprotocol/server';

/**
 * A mounted MCP server.
 *
 * `path` is the mount segment, not a full URL: a plugin with `path: 'vault'`
 * is served at `/vault/mcp`.
 */
export interface Plugin {
  /** Display name, used in logs and the health endpoint. */
  name: string;
  /** Mount segment. Must not contain slashes. */
  path: string;
  /** The web-standard MCP handler serving this mount. */
  handler: McpHttpHandler;
}
