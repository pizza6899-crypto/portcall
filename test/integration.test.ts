import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { legacyRequest, modernRequest, readRpc, startServer, type RunningServer } from './helpers.js';

describe('mounts and routing', () => {
  let server: RunningServer;

  before(async () => {
    server = await startServer({ PORTCALL_ALIAS_ROOT_MCP: 'vault' });
  });
  after(async () => server.stop());

  test('health reports every mount', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { status: string; authRequired: boolean; mounts: { route: string }[] };
    assert.equal(body.status, 'ok');
    assert.equal(body.authRequired, false);
    assert.deepEqual(body.mounts.map((m) => m.route).sort(), ['/mcp', '/vault/mcp']);
  });

  test('the alias serves the same plugin as the canonical route', async () => {
    const canonical = await readRpc(await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list'));
    const alias = await readRpc(await modernRequest(server.baseUrl, '/mcp', 'tools/list'));

    const names = (payload: Record<string, unknown>) =>
      ((payload.result as { tools: { name: string }[] }).tools).map((t) => t.name).sort();

    assert.deepEqual(names(alias), names(canonical));
    assert.ok(names(canonical).length > 0, 'expected the vault plugin to expose tools');
  });

  test('unknown paths 404 and list the mounts that do exist', async () => {
    const res = await fetch(`${server.baseUrl}/nope/mcp`, { method: 'POST' });
    assert.equal(res.status, 404);

    const body = (await res.json()) as { error: string; mounts: string[] };
    assert.equal(body.error, 'not_found');
    assert.ok(body.mounts.includes('/vault/mcp'));
  });

  test('a trailing slash resolves to the same mount', async () => {
    const res = await fetch(`${server.baseUrl}/healthz/`);
    assert.equal(res.status, 200);
  });
});

describe('protocol eras', () => {
  let server: RunningServer;

  before(async () => {
    server = await startServer({});
  });
  after(async () => server.stop());

  test('modern (2026-07-28) discovery reports the modern revision', async () => {
    const payload = await readRpc(await modernRequest(server.baseUrl, '/vault/mcp', 'server/discover'));
    const result = payload.result as { supportedVersions: string[] };
    assert.ok(result.supportedVersions.includes('2026-07-28'));
  });

  test('modern tool calls reach the vault', async () => {
    const res = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/call', {
      name: 'get_vault_stats',
      arguments: {},
    });
    const payload = await readRpc(res);
    const result = payload.result as { content: { text: string }[] };
    const stats = JSON.parse(result.content[0]!.text) as { notes: number };

    // The throwaway vault is created with two notes.
    assert.equal(stats.notes, 2);
  });

  test('legacy (2025) initialize is still served', async () => {
    const payload = await readRpc(
      await legacyRequest(server.baseUrl, '/vault/mcp', 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'portcall-test', version: '0' },
      }),
    );
    const result = payload.result as { protocolVersion: string };
    assert.equal(result.protocolVersion, '2025-06-18');
  });

  test('GET is rejected — there is no standing session stream to open', async () => {
    const res = await fetch(`${server.baseUrl}/vault/mcp`);
    assert.equal(res.status, 405);
  });
});

describe('bearer authentication', () => {
  let server: RunningServer;
  const token = 'test-token-value';

  before(async () => {
    server = await startServer({ PORTCALL_TOKEN: token });
  });
  after(async () => server.stop());

  test('health advertises that auth is on', async () => {
    const body = (await (await fetch(`${server.baseUrl}/healthz`)).json()) as { authRequired: boolean };
    assert.equal(body.authRequired, true);
  });

  test('health itself stays open, so probes do not need the token', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(res.status, 200);
  });

  test('a request without a token is refused', async () => {
    const res = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  });

  test('a wrong token is refused', async () => {
    const res = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, {
      authorization: 'Bearer wrong-token-value',
    });
    assert.equal(res.status, 401);
  });

  test('a token of a different length is refused', async () => {
    const res = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, {
      authorization: 'Bearer short',
    });
    assert.equal(res.status, 401);
  });

  test('a non-bearer scheme is refused', async () => {
    const res = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, {
      authorization: `Basic ${token}`,
    });
    assert.equal(res.status, 401);
  });

  test('the correct token is accepted', async () => {
    const res = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, {
      authorization: `Bearer ${token}`,
    });
    assert.equal(res.status, 200);
  });

  test('the bearer scheme is matched case-insensitively', async () => {
    const res = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, {
      authorization: `bearer ${token}`,
    });
    assert.equal(res.status, 200);
  });
});
