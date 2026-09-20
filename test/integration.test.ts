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

  test('unknown paths 404 without disclosing what does exist', async () => {
    const res = await fetch(`${server.baseUrl}/nope/mcp`, { method: 'POST' });
    assert.equal(res.status, 404);

    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'not_found');
    assert.equal('mounts' in body, false, '404 must not leak the mount table');
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

  test('the mount listing is withheld from an unauthenticated caller', async () => {
    // Liveness is public; what is served here is not. Without this, anyone who
    // found the hostname could enumerate the plugins behind it.
    const body = (await (await fetch(`${server.baseUrl}/healthz`)).json()) as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.equal('mounts' in body, false);
  });

  test('the mount listing is served to a caller holding the token', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { mounts: { route: string }[] };
    assert.ok(body.mounts.length > 0, 'a caller who can reach the mounts may list them');
  });

  test('a wrong token does not reveal the mount listing either', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`, { headers: { authorization: 'Bearer wrong-token-value' } });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal('mounts' in body, false);
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

describe('secret path prefix', () => {
  let server: RunningServer;
  const prefix = 'k7f3q9x2';

  before(async () => {
    server = await startServer({ PORTCALL_PATH_PREFIX: prefix, PORTCALL_ALIAS_ROOT_MCP: 'vault' });
  });
  after(async () => server.stop());

  test('mounts are served behind the prefix', async () => {
    const res = await modernRequest(server.baseUrl, `/${prefix}/vault/mcp`, 'tools/list');
    assert.equal(res.status, 200);
  });

  test('the alias moves behind the prefix too', async () => {
    const res = await modernRequest(server.baseUrl, `/${prefix}/mcp`, 'tools/list');
    assert.equal(res.status, 200);
  });

  test('the unprefixed paths are gone', async () => {
    for (const path of ['/vault/mcp', '/mcp']) {
      const res = await modernRequest(server.baseUrl, path, 'tools/list');
      assert.equal(res.status, 404, `${path} should no longer be served`);
    }
  });

  test('a wrong prefix does not reach the plugin', async () => {
    const res = await modernRequest(server.baseUrl, '/wrongprefix/vault/mcp', 'tools/list');
    assert.equal(res.status, 404);
  });

  test('the prefix does not land in the log file in the clear', async () => {
    // It is a bearer secret that happens to travel in the URL, and this log
    // is the one place the process controls. Reducing it the way a token is
    // reduced keeps the line useful without writing the secret down.
    await modernRequest(server.baseUrl, `/${prefix}/vault/mcp`, 'tools/list');
    const logged = server.output();

    assert.ok(logged.includes('"pathname"'), 'requests are being logged at all');
    assert.equal(logged.includes(prefix), false, 'the prefix itself never appears');
    assert.ok(logged.includes('<prefix '), 'and the line still says the prefix matched');
    assert.ok(logged.includes('/vault/mcp'), 'while naming the mount that was hit');
  });

  test('a path that does not carry the prefix is logged as it came', async () => {
    // That is the caller's guess rather than our secret, and seeing it is
    // the reason the line exists.
    await modernRequest(server.baseUrl, '/someone-elses-guess/vault/mcp', 'tools/list');
    assert.ok(server.output().includes('/someone-elses-guess/vault/mcp'));
  });

  test('the public health endpoint stays alive but hides the mounts', async () => {
    const res = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.equal('mounts' in body, false, 'public health must not leak the secret path');
    assert.equal(JSON.stringify(body).includes(prefix), false, 'the prefix must not appear in the public payload');
  });

  test('the mount listing is available behind the prefix', async () => {
    const res = await fetch(`${server.baseUrl}/${prefix}/healthz`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { mounts: { route: string }[] };
    assert.deepEqual(body.mounts.map((m) => m.route).sort(), [`/${prefix}/mcp`, `/${prefix}/vault/mcp`]);
  });

  test('a 404 body reveals nothing about the prefix', async () => {
    const res = await fetch(`${server.baseUrl}/guess/mcp`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal((await res.text()).includes(prefix), false);
  });
});

describe('a misconfigured prefix stops the server rather than serving something unintended', () => {
  test('a prefix containing a slash is refused at startup', async () => {
    await assert.rejects(
      () => startServer({ PORTCALL_PATH_PREFIX: 'a/b' }),
      /server exited early/,
    );
  });
});

describe('the KIS plugin', () => {
  // Credentials are never used here: listing tools touches no KIS endpoint.
  const credentials = { KIS_APP_KEY: 'test-key', KIS_APP_SECRET: 'test-secret' };

  test('is mounted only once credentials are configured', async () => {
    const without = await startServer({});
    try {
      const body = (await (await fetch(`${without.baseUrl}/healthz`)).json()) as { mounts: { route: string }[] };
      assert.deepEqual(body.mounts.map((m) => m.route), ['/vault/mcp']);
    } finally {
      await without.stop();
    }

    const server = await startServer(credentials);
    try {
      const body = (await (await fetch(`${server.baseUrl}/healthz`)).json()) as { mounts: { route: string }[] };
      assert.deepEqual(body.mounts.map((m) => m.route).sort(), ['/kis/mcp', '/vault/mcp']);
    } finally {
      await server.stop();
    }
  });

  test('serves quotations only until an account is configured', async () => {
    const server = await startServer(credentials);
    try {
      const payload = await readRpc(await modernRequest(server.baseUrl, '/kis/mcp', 'tools/list'));
      const tools = (payload.result as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }).tools;

      // Prices are public; a portfolio is not. Exposing one must not expose the other.
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        [
          'fx_rate',
          'overseas_daily_prices',
          'overseas_index',
          'overseas_orderbook',
          'overseas_quote',
          'overseas_quote_detail',
        ],
      );
      // The list above is the whole surface: a tool that could place, amend or
      // cancel an order is not registered, so it cannot be called. Everything
      // that is registered says so to the client.
      for (const tool of tools) {
        assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be marked read-only`);
      }
    } finally {
      await server.stop();
    }
  });
  test('adds the account tools once KIS_ACCOUNT is set, and still nothing that trades', async () => {
    const server = await startServer({ ...credentials, KIS_ACCOUNT: '12345678-01' });
    try {
      const payload = await readRpc(await modernRequest(server.baseUrl, '/kis/mcp', 'tools/list'));
      const tools = (payload.result as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }).tools;

      assert.deepEqual(tools.map((t) => t.name).sort(), [
        'fx_rate',
        'overseas_balance',
        'overseas_daily_prices',
        'overseas_executions',
        'overseas_holdings',
        'overseas_index',
        'overseas_orderbook',
        'overseas_quote',
        'overseas_quote_detail',
        'overseas_realized_pnl',
      ]);
      for (const tool of tools) {
        assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be marked read-only`);
      }
    } finally {
      await server.stop();
    }
  });

  test('a malformed account number stops the server rather than mounting half-configured', async () => {
    await assert.rejects(
      () => startServer({ ...credentials, KIS_ACCOUNT: 'not-an-account' }),
      /server exited early/,
    );
  });
});

describe('abuse control', () => {
  const token = 'guard-test-token-value';

  test('repeated wrong tokens get the client blocked, and the block covers every path', async () => {
    const server = await startServer({ PORTCALL_TOKEN: token, PORTCALL_GUARD_FAILURES: '3' });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, {
          authorization: 'Bearer wrong-token-value',
        });
        assert.equal(res.status, 401, `attempt ${attempt} should still be a plain rejection`);
      }

      // The fourth try never reaches the token check.
      const blocked = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, {
        authorization: 'Bearer wrong-token-value',
      });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'a blocked client is told when to return');

      // Holding the real token does not help once blocked, and neither does
      // switching to an endpoint that needs none.
      const withToken = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, {
        authorization: `Bearer ${token}`,
      });
      assert.equal(withToken.status, 429);
      assert.equal((await fetch(`${server.baseUrl}/healthz`)).status, 429);
    } finally {
      await server.stop();
    }
  });

  test('a caller holding the token is not locked out by earlier stray failures', async () => {
    const server = await startServer({ PORTCALL_TOKEN: token, PORTCALL_GUARD_FAILURES: '3' });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, { authorization: 'Bearer nope' });
      }

      const ok = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, {
        authorization: `Bearer ${token}`,
      });
      assert.equal(ok.status, 200);

      // The success cleared the history, so two more failures still do not trip it.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await modernRequest(server.baseUrl, '/vault/mcp', 'tools/list', {}, { authorization: 'Bearer nope' });
        assert.equal(res.status, 401);
      }
    } finally {
      await server.stop();
    }
  });

  test('the rate cap refuses a flood without a token being involved', async () => {
    const server = await startServer({ PORTCALL_GUARD_RATE: '5', PORTCALL_GUARD_RATE_WINDOW_MS: '60000' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i += 1) codes.push((await fetch(`${server.baseUrl}/healthz`)).status);

      // The harness already spent part of the budget waiting for the server to
      // come up, so what matters is the shape: served until the cap, refused
      // after it, and never served again inside the window.
      assert.equal(codes[0], 200, 'the first call must be served');
      assert.ok(codes.includes(429), 'the cap must engage within eight calls');
      const firstRefusal = codes.indexOf(429);
      assert.deepEqual(codes.slice(firstRefusal), codes.slice(firstRefusal).map(() => 429));
    } finally {
      await server.stop();
    }
  });
});

describe('a hostile request target', () => {
  let server: RunningServer;
  const token = 'survive-token';

  before(async () => {
    server = await startServer({ PORTCALL_TOKEN: token, PORTCALL_ALIAS_ROOT_MCP: 'vault' });
  });

  after(async () => {
    await server.stop();
  });

  test('does not take the process down', async () => {
    // `GET //` is answered before authentication, so a crash here is an
    // unauthenticated kill — and, since the guard keeps its state in memory,
    // a way to clear a block that is meant to stop credential guessing.
    for (const target of ['//', '///', '//evil.com/mcp', '/%2e%2e/', '/a%20b']) {
      const res = await fetch(`${server.baseUrl}${target}`);
      assert.ok(res.status >= 200 && res.status < 500, `${target} answered ${res.status}`);
      await res.text();
    }

    const health = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(health.status, 200, 'the server is still up afterwards');
  });

  test('a double slash does not reach the root alias', async () => {
    // Resolved against a base, `//evil.com/mcp` would become `/mcp`.
    const res = await fetch(`${server.baseUrl}//evil.com/mcp`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });

  test('the operator can see how many clients are blocked', async () => {
    const authorised = { Authorization: `Bearer ${token}` };

    const open = await fetch(`${server.baseUrl}/healthz`);
    const anonymous = (await open.json()) as Record<string, unknown>;
    assert.equal('blockedClients' in anonymous, false, 'a caller is not told whether anyone is blocked');

    const detailed = await fetch(`${server.baseUrl}/healthz`, { headers: authorised });
    const payload = (await detailed.json()) as Record<string, unknown>;
    assert.equal(typeof payload['blockedClients'], 'number');
    assert.ok(Array.isArray(payload['mounts']));
  });

  test('a block cannot be cleared by crashing the process', async () => {
    const guessing = { Authorization: 'Bearer wrong' };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await fetch(`${server.baseUrl}/vault/mcp`, { method: 'POST', headers: guessing }).then((r) => r.text());
    }

    const blocked = await fetch(`${server.baseUrl}/vault/mcp`, { method: 'POST', headers: guessing });
    assert.equal(blocked.status, 429, 'guessing trips the block');
    await blocked.text();

    await fetch(`${server.baseUrl}//`).then((r) => r.text());

    const stillBlocked = await fetch(`${server.baseUrl}/vault/mcp`, { method: 'POST', headers: guessing });
    assert.equal(stillBlocked.status, 429, 'the block survives the malformed target');
    await stillBlocked.text();
  });
});
