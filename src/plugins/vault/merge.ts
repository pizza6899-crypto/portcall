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
 * How long one upstream call may wait.
 *
 * The server is an object in this process, so a call that has not answered by
 * now is not slow — it is never going to answer, and the HTTP request behind
 * it would hang for as long as the client will hold the connection.
 */
const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * Speak to a server in this process over a linked transport pair.
 *
 * The SDK publishes a client package, but the only thing needed here is two
 * request methods against an object already in memory, so the handshake and
 * id matching are done directly rather than pulling in a second dependency.
 *
 * Every way a call can fail has to end in a rejection. `send` throws once the
 * transport is closed, and a discarded rejection is fatal under Node's default
 * `--unhandled-rejections=throw`: the daemon would exit because one client
 * disconnected mid-request.
 */
async function openUpstream(server: Server): Promise<Upstream> {
  const [near, far] = InMemoryTransport.createLinkedPair();

  interface Waiter {
    resolve: (message: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }
  const pending = new Map<number, Waiter>();
  let nextId = 0;
  let broken: Error | undefined;

  /** Fail every outstanding call, and every later one, with the same cause. */
  function abandon(error: Error): void {
    broken ??= error;
    for (const [id, waiter] of [...pending]) {
      pending.delete(id);
      waiter.reject(error);
    }
  }

  near.onmessage = (message: unknown) => {
    const response = message as JsonRpcResponse;
    if (response.id === undefined) return;
    const waiter = pending.get(response.id);
    if (waiter === undefined) return;
    pending.delete(response.id);
    waiter.resolve(response);
  };
  near.onclose = () => abandon(new Error('The vault server closed the connection before answering.'));
  near.onerror = (error: unknown) => abandon(error instanceof Error ? error : new Error(String(error)));

  await server.connect(far);
  await near.start();

  async function call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (broken !== undefined) throw broken;

    const id = (nextId += 1);
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const deadline = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The vault server did not answer ${method} within ${UPSTREAM_TIMEOUT_MS}ms.`));
      }, UPSTREAM_TIMEOUT_MS);
      deadline.unref();

      const settle: Waiter = {
        resolve: (message) => {
          clearTimeout(deadline);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(deadline);
          reject(error);
        },
      };
      pending.set(id, settle);

      near.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage).catch((error: unknown) => {
        pending.delete(id);
        settle.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    if (response.error !== undefined) throw new Error(response.error.message);
    return response.result ?? {};
  }

  try {
    await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'portcall', version: '0.1.0' },
    });
    await near.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  } catch (error) {
    // A half-open pair would otherwise sit there holding the upstream server.
    await near.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    throw error;
  }

  return {
    call,
    close: async () => {
      abandon(new Error('The vault server was closed while a call was in flight.'));
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
