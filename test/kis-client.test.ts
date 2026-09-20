import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ENDPOINTS, TRADING_NAMESPACE, createKisClient, type Endpoint } from '../src/plugins/kis/client.js';

const BASE = 'https://openapi.example.invalid';

interface Recorded {
  url: URL;
  headers: Headers;
}

function clientAnswering(payload: unknown, status = 200, trConts: string[] = []) {
  const seen: Recorded[] = [];
  let call = 0;
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    seen.push({ url: new URL(input), headers: new Headers(init.headers) });
    const trCont = trConts[call];
    call += 1;
    return new Response(JSON.stringify(payload), {
      status,
      ...(trCont === undefined ? {} : { headers: { tr_cont: trCont } }),
    });
  }) as unknown as typeof fetch;

  const client = createKisClient({
    baseUrl: BASE,
    appKey: 'key',
    appSecret: 'secret',
    getToken: async () => 'token',
    fetchImpl,
    minIntervalMs: 0,
  });

  return { client, seen };
}

describe('KIS client', () => {
  test('sends the tr_id, credentials and query the endpoint expects', async () => {
    const { client, seen } = clientAnswering({ rt_cd: '0', output: { last: '123.45' } });

    const body = await client.get(ENDPOINTS.price, { AUTH: '', EXCD: 'NAS', SYMB: 'AAPL' });

    assert.deepEqual(body['output'], { last: '123.45' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url.pathname, '/uapi/overseas-price/v1/quotations/price');
    assert.equal(seen[0]!.url.searchParams.get('EXCD'), 'NAS');
    assert.equal(seen[0]!.url.searchParams.get('SYMB'), 'AAPL');
    assert.equal(seen[0]!.headers.get('tr_id'), 'HHDFS00000300');
    assert.equal(seen[0]!.headers.get('authorization'), 'Bearer token');
    assert.equal(seen[0]!.headers.get('appkey'), 'key');
    assert.equal(seen[0]!.headers.get('custtype'), 'P');
  });

  test('refuses a path outside the read allowlist', async () => {
    const { client, seen } = clientAnswering({ rt_cd: '0' });

    const ordering = { path: '/uapi/overseas-stock/v1/trading/order', trId: 'TTTT1002U' } satisfies Endpoint;

    await assert.rejects(() => client.get(ordering, {}), /outside the read allowlist/);
    assert.equal(seen.length, 0, 'the request must not leave the process');
  });

  test('refuses an order tr_id even on an allowlisted path', async () => {
    const { client, seen } = clientAnswering({ rt_cd: '0' });

    // Account inquiries share the /trading/ namespace with the order
    // endpoints, so the path alone no longer separates reading from trading.
    const disguised = { path: ENDPOINTS.holdings.path, trId: 'TTTT1002U' } satisfies Endpoint;

    await assert.rejects(() => client.get(disguised, {}), /not an inquiry: TTTT1002U/);
    assert.equal(seen.length, 0);
  });

  test('a rejection carried in a 200 body is surfaced as an error', async () => {
    // KIS answers 200 with rt_cd set; unchecked, that reads as an empty result.
    const { client } = clientAnswering({ rt_cd: '1', msg_cd: 'OPSQ0001', msg1: '조회할 자료가 없습니다.  ' });

    await assert.rejects(
      () => client.get(ENDPOINTS.price, { AUTH: '', EXCD: 'NAS', SYMB: 'NOPE' }),
      /OPSQ0001: 조회할 자료가 없습니다\./,
    );
  });

  test('an HTTP failure keeps the status and an excerpt of the body', async () => {
    const { client } = clientAnswering({ error: 'gateway' }, 502);

    await assert.rejects(
      () => client.get(ENDPOINTS.price, { AUTH: '', EXCD: 'NAS', SYMB: 'AAPL' }),
      /HHDFS00000300 responded 502/,
    );
  });

  test('every allowlisted endpoint is an inquiry', () => {
    for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
      if (endpoint.path.startsWith(TRADING_NAMESPACE)) {
        // Orders live here too, and only the tr_id suffix tells them apart.
        assert.match(endpoint.trId, /R$/, `${name} must be an inquiry tr_id`);
      } else {
        // The quotation namespace has no ordering call to be confused with.
        assert.match(endpoint.path, /^\/uapi\/overseas-price\/v1\/quotations\//, `${name} is in no known read namespace`);
      }
    }
  });

  test('a paged call follows the continuation cursor and stops', async () => {
    const { client, seen } = clientAnswering(
      { rt_cd: '0', output: [{ odno: '1' }], ctx_area_fk200: 'FK', ctx_area_nk200: 'NK' },
      200,
      ['M', 'M', 'D'],
    );

    const pages = await client.getAll(ENDPOINTS.executions, { CANO: '12345678' });

    assert.equal(pages.length, 3, 'must stop once tr_cont is no longer F or M');
    assert.equal(seen[0]!.headers.get('tr_cont'), null, 'the first page carries no continuation header');
    assert.equal(seen[1]!.headers.get('tr_cont'), 'N');
    assert.equal(seen[1]!.url.searchParams.get('CTX_AREA_NK200'), 'NK');
    assert.equal(seen[1]!.url.searchParams.get('CTX_AREA_FK200'), 'FK');
  });

  test('the exchange rate endpoint is a quotation, not an account call', () => {
    // It shares an endpoint family with the index charts, so it is worth
    // pinning that it stayed out of the /trading/ namespace.
    assert.ok(ENDPOINTS.fxRate.path.startsWith('/uapi/overseas-price/v1/quotations/'));
    assert.equal(ENDPOINTS.fxRate.path.startsWith(TRADING_NAMESPACE), false);
  });

  test('a paged call cannot run away', async () => {
    const { client, seen } = clientAnswering({ rt_cd: '0', output: [] }, 200, Array(50).fill('M'));

    const pages = await client.getAll(ENDPOINTS.executions, {}, 3);

    assert.equal(pages.length, 3);
    assert.equal(seen.length, 3);
  });
});
