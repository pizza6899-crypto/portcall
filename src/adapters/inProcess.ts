import { createMcpHandler } from '@modelcontextprotocol/server';
import type { McpHttpHandler, McpServerFactory } from '@modelcontextprotocol/server';

import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Adapter for MCP servers that export a server factory as a library.
 *
 * The server is constructed by calling the factory in this process — no child
 * process is spawned, so there is nothing to reap. The SDK builds one instance
 * per request and disposes it with the request.
 */
export function inProcess(name: string, factory: McpServerFactory): McpHttpHandler {
  return createMcpHandler(factory, {
    legacy: config.modernOnly ? 'reject' : 'stateless',
    keepAliveMs: config.keepAliveMs,
    onerror: (error) => log.error('handler error', { plugin: name, error: error.message }),
  });
}
