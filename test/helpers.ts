import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Ask the OS for a port that is free right now. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** A throwaway vault with a couple of notes in it. */
export async function makeVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'portcall-vault-'));
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'notes', 'alpha.md'), '# Alpha\n\nFirst note.\n');
  await writeFile(join(root, 'notes', 'beta.md'), '# Beta\n\nSecond note.\n');
  return root;
}

export interface RunningServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

/**
 * Start the built server as a child process and wait until it answers.
 *
 * This is deliberately black-box: the test drives the same artifact the daemon
 * runs, over real HTTP, rather than importing internals.
 */
export async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const port = await freePort();
  const vaultPath = env.PORTCALL_VAULT_PATH ?? (await makeVault());

  // Start from a clean slate so the developer's own PORTCALL_* vars cannot leak in.
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('PORTCALL_')) childEnv[key] = value;
  }

  const child: ChildProcess = spawn(
    process.execPath,
    ['dist/src/server.js'],
    {
      cwd: process.cwd(),
      env: { ...childEnv, ...env, PORTCALL_PORT: String(port), PORTCALL_VAULT_PATH: vaultPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) => reject(new Error(`server exited early (code ${code}):\n${output}`)));
  });

  await Promise.race([waitForHealth(baseUrl), exited]);

  return {
    baseUrl,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      if (env.PORTCALL_VAULT_PATH === undefined) await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

async function waitForHealth(baseUrl: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'portcall-test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** Send a modern (2026-07-28) request, which needs matching headers and envelope. */
export function modernRequest(
  baseUrl: string,
  path: string,
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    ...extraHeaders,
  };
  if (typeof params.name === 'string') headers['Mcp-Name'] = params.name;

  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }),
  });
}

/** Send a 2025-era request, which carries no protocol headers at all. */
export function legacyRequest(
  baseUrl: string,
  path: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** Read a JSON-RPC payload from either a plain JSON body or a single-message SSE stream. */
export async function readRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text.startsWith('event:') || text.startsWith('data:')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (line === undefined) throw new Error(`no data frame in SSE response:\n${text}`);
    return JSON.parse(line.slice('data:'.length).trim());
  }
  return JSON.parse(text);
}
