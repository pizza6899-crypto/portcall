import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createTokenStore } from '../src/plugins/kis/token.js';

const BASE = 'https://openapi.example.invalid';

interface Issued {
  calls: number;
  fetchImpl: typeof fetch;
}

/** A token endpoint that hands out a new value on every call. */
function issuing(body: Record<string, unknown> = {}, status = 200): Issued {
  const state = { calls: 0 } as Issued;
  state.fetchImpl = (async () => {
    state.calls += 1;
    const payload = status === 200 ? { access_token: `token-${state.calls}`, expires_in: 86_400, ...body } : body;
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return state;
}

async function cacheFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'portcall-kis-')), 'token.json');
}

describe('KIS token store', () => {
  test('issues once and reuses the token', async () => {
    const kis = issuing();
    const store = createTokenStore({ baseUrl: BASE, appKey: 'key', appSecret: 'secret', fetchImpl: kis.fetchImpl });

    assert.equal(await store.get(), 'token-1');
    assert.equal(await store.get(), 'token-1');
    assert.equal(kis.calls, 1);
  });

  test('concurrent callers share one issue', async () => {
    const kis = issuing();
    const store = createTokenStore({ baseUrl: BASE, appKey: 'key', appSecret: 'secret', fetchImpl: kis.fetchImpl });

    // The second ask is the one KIS refuses, so the race must collapse to one call.
    const tokens = await Promise.all([store.get(), store.get(), store.get()]);

    assert.deepEqual(tokens, ['token-1', 'token-1', 'token-1']);
    assert.equal(kis.calls, 1);
  });

  test('renews once the expiry margin is reached', async () => {
    const kis = issuing();
    let clock = 1_000_000;
    const store = createTokenStore({
      baseUrl: BASE,
      appKey: 'key',
      appSecret: 'secret',
      fetchImpl: kis.fetchImpl,
      now: () => clock,
    });

    assert.equal(await store.get(), 'token-1');
    clock += 86_400_000 - 9 * 60_000; // inside the ten-minute renewal margin
    assert.equal(await store.get(), 'token-2');
    assert.equal(kis.calls, 2);
  });

  test('a restart reloads the token from disk rather than issuing', async () => {
    const cachePath = await cacheFile();
    const first = issuing();
    await createTokenStore({
      baseUrl: BASE,
      appKey: 'key',
      appSecret: 'secret',
      cachePath,
      fetchImpl: first.fetchImpl,
    }).get();

    const second = issuing();
    const restarted = createTokenStore({
      baseUrl: BASE,
      appKey: 'key',
      appSecret: 'secret',
      cachePath,
      fetchImpl: second.fetchImpl,
    });

    assert.equal(await restarted.get(), 'token-1');
    assert.equal(second.calls, 0, 'a restart must not spend an issue');
  });

  test('the token file never holds the app key in the clear', async () => {
    const cachePath = await cacheFile();
    const kis = issuing();
    await createTokenStore({
      baseUrl: BASE,
      appKey: 'super-secret-key',
      appSecret: 'secret',
      cachePath,
      fetchImpl: kis.fetchImpl,
    }).get();

    assert.equal((await readFile(cachePath, 'utf8')).includes('super-secret-key'), false);
  });

  test('a token cached under a different app key is ignored', async () => {
    const cachePath = await cacheFile();
    await writeFile(cachePath, JSON.stringify({ appKey: 'someone-else', value: 'stale', expiresAt: Date.now() + 86_400_000 }));

    const kis = issuing();
    const store = createTokenStore({
      baseUrl: BASE,
      appKey: 'key',
      appSecret: 'secret',
      cachePath,
      fetchImpl: kis.fetchImpl,
    });

    assert.equal(await store.get(), 'token-1');
  });

  test('the one-per-minute lockout is explained rather than reported as a bare failure', async () => {
    const kis = issuing({ error_code: 'EGW00133', error_description: '접근토큰 발급 잦은 요청' }, 403);
    const store = createTokenStore({ baseUrl: BASE, appKey: 'key', appSecret: 'secret', fetchImpl: kis.fetchImpl });

    await assert.rejects(() => store.get(), /EGW00133.*one token per minute/s);
  });

  test('a failed issue does not wedge the store', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error_code: 'EGW00201' }), { status: 500 })
        : new Response(JSON.stringify({ access_token: 'recovered', expires_in: 86_400 }), { status: 200 });
    }) as unknown as typeof fetch;

    const store = createTokenStore({ baseUrl: BASE, appKey: 'key', appSecret: 'secret', fetchImpl });

    await assert.rejects(() => store.get());
    assert.equal(await store.get(), 'recovered');
  });

  test('the cache is replaced in one step, leaving nothing half-written', async () => {
    const cachePath = await cacheFile();
    const kis = issuing();

    await createTokenStore({ baseUrl: BASE, appKey: 'key', appSecret: 'secret', cachePath, fetchImpl: kis.fetchImpl }).get();

    // A truncated file reads back as no cache and costs an issue, so the
    // write goes to a sibling and is moved into place.
    const written = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(written.value, 'token-1');
    assert.deepEqual(
      (await readdir(dirname(cachePath))).filter((name) => name.endsWith('.tmp')),
      [],
      'no temporary file is left behind',
    );
  });

  test('a cache that already exists is still left readable only by its owner', async () => {
    const cachePath = await cacheFile();
    await writeFile(cachePath, '{}');
    await chmod(cachePath, 0o644);

    const kis = issuing();
    await createTokenStore({ baseUrl: BASE, appKey: 'key', appSecret: 'secret', cachePath, fetchImpl: kis.fetchImpl }).get();

    // `writeFile`'s mode applies only when it creates the file, so rewriting
    // in place would have kept 0644.
    assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
  });
});
