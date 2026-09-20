import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import type { CallToolResult, JSONRPCMessage, ListToolsResult, Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';

export type ToolResult = CallToolResult;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool this project adds alongside the ones an upstream server already serves. */
export interface ExtraTool<Args = never> {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType<Args>;
  annotations: ToolAnnotations;
  run: (args: Args) => Promise<ToolResult>;
}

interface Upstream {
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Speak to a server in this process over a linked transport pair.
 *
 * The SDK publishes a client package, but the only thing needed here is two
 * request methods against an object already in memory, so the handshake and
 * id matching are done directly rather than pulling in a second dependency.
 */
async function openUpstream(server: Server): Promise<Upstream> {
  const [near, far] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  let nextId = 0;

  near.onmessage = (message: unknown) => {
    const response = message as JsonRpcResponse;
    if (response.id === undefined) return;
    const settle = pending.get(response.id);
    if (settle === undefined) return;
    pending.delete(response.id);
    settle(response);
  };

  await server.connect(far);
  await near.start();

  async function call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = (nextId += 1);
    const response = await new Promise<JsonRpcResponse>((resolve) => {
      pending.set(id, resolve);
      void near.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });
    if (response.error !== undefined) throw new Error(response.error.message);
    return response.result ?? {};
  }

  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'portcall', version: '0.1.0' },
  });
  await near.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);

  return {
    call,
    close: async () => {
      await near.close();
      await server.close();
    },
  };
}

/** A schema failure reads as prose, not as the issue array behind it. */
function explain(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`))
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function describe(tool: ExtraTool<never>): Tool {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>;
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchema as Tool['inputSchema'],
    annotations: tool.annotations,
  };
}

/**
 * One MCP server presenting an upstream server's tools plus a few of our own.
 *
 * The upstream server registers `tools/list` and `tools/call` directly on a
 * low-level `Server`, so there is no seam to register extra tools into. This
 * fronts it instead: the listing is concatenated and a call goes to whichever
 * side owns the name, which keeps everything on one mount and one connector.
 */
export function mergeTools(
  buildUpstream: () => Server,
  extras: readonly ExtraTool<never>[],
  serverInfo: { name: string; version: string },
): Server {
  const server = new Server(serverInfo, { capabilities: { tools: {} } });
  const owned = new Map(extras.map((tool) => [tool.name, tool]));
  let upstream: Promise<Upstream> | undefined;
  const connect = (): Promise<Upstream> => (upstream ??= openUpstream(buildUpstream()));

  server.setRequestHandler('tools/list', async (): Promise<ListToolsResult> => {
    const listed = await (await connect()).call('tools/list', {});
    const inherited = Array.isArray(listed['tools']) ? (listed['tools'] as Tool[]) : [];
    return { tools: [...inherited, ...extras.map(describe)] };
  });

  server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
    const tool = owned.get(request.params.name);
    if (tool === undefined) {
      const forwarded = await (await connect()).call('tools/call', { ...request.params });
      return forwarded as CallToolResult;
    }

    try {
      return await tool.run(tool.schema.parse(request.params.arguments ?? {}) as never);
    } catch (error) {
      // An invalid argument or a missing file is the caller's to fix, so it
      // comes back as tool output rather than a protocol error.
      return { content: [{ type: 'text', text: `Error: ${explain(error)}` }], isError: true };
    }
  });

  server.onclose = () => {
    void upstream?.then((link) => link.close()).catch(() => undefined);
  };

  return server;
}
