import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';

import type { Endpoint, KisClient } from '../src/plugins/kis/client.js';
import { registerTools } from '../src/plugins/kis/tools.js';

interface Call {
  endpoint: Endpoint;
  params: Record<string, string>;
}

/** Drive the registered tools with a client that records rather than calls. */
async function openTools(body: Record<string, unknown> = { rt_cd: '0', output: {}, output1: [], output2: {} }) {
  const calls: Call[] = [];
  const client: KisClient = {
    get: async (endpoint, params) => {
      calls.push({ endpoint, params });
      return body;
    },
    getAll: async (endpoint, params) => {
      calls.push({ endpoint, params });
      return [body];
    },
  };

  const server = new McpServer({ name: 'kis-test', version: '0' });
  registerTools(server, client, { cano: '12345678', productCode: '01' });

  const [near, far] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (message: Record<string, any>) => void>();
  near.onmessage = (message: any) => {
    const settle = pending.get(message.id);
    if (settle !== undefined) {
      pending.delete(message.id);
      settle(message);
    }
  };
  await server.connect(far);
  await near.start();

  let id = 0;
  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      void near.send({ jsonrpc: '2.0', id, method, params } as any);
    });

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await near.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as any);

  return {
    calls,
    names: async () => ((await rpc('tools/list', {}))['result'].tools as { name: string }[]).map((t) => t.name),
    listed: async () => (await rpc('tools/list', {}))['result'].tools as Record<string, any>[],
    call: async (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args }),
    close: async () => {
      await near.close();
      await server.close();
    },
  };
}

/** The date in Seoul right now, worked out independently of the code under test. */
function seoulToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replaceAll('-', '');
}

describe('KIS date defaults', () => {
  test('a default end date is the Korean business date, not the host date', async () => {
    // KIS works in KST. This host runs at UTC+7, so for two hours after
    // midnight in Korea the local date is still yesterday — and that window
    // is the middle of the US session.
    const tools = await openTools();
    try {
      await tools.call('overseas_executions', {});
      const call = tools.calls.at(-1);
      assert.equal(call?.params['ORD_END_DT'], seoulToday());
    } finally {
      await tools.close();
    }
  });

  test('a period query starts on 1 January of the Korean year', async () => {
    const tools = await openTools();
    try {
      await tools.call('overseas_realized_pnl', {});
      const call = tools.calls.at(-1);
      assert.equal(call?.params['INQR_STRT_DT'], `${seoulToday().slice(0, 4)}0101`);
      assert.equal(call?.params['INQR_END_DT'], seoulToday());
    } finally {
      await tools.close();
    }
  });

  test('a rolling window ends today and starts thirty days back', async () => {
    const tools = await openTools();
    try {
      await tools.call('fx_rate', { currency: 'KRW' });
      const call = tools.calls.at(-1);
      assert.equal(call?.params['FID_INPUT_DATE_2'], seoulToday());

      const from = call?.params['FID_INPUT_DATE_1'] ?? '';
      assert.match(from, /^\d{8}$/);
      assert.ok(from < seoulToday(), 'the window starts before it ends');
    } finally {
      await tools.close();
    }
  });
});

describe('what the KIS mount exposes', () => {
  test('ten tools, every one of them read-only', async () => {
    const tools = await openTools();
    try {
      const listed = await tools.listed();
      assert.equal(listed.length, 10);
      for (const tool of listed) {
        assert.equal(tool['annotations']?.readOnlyHint, true, `${tool['name']} is not marked read-only`);
      }
    } finally {
      await tools.close();
    }
  });

  test('nothing that could move money is registered', async () => {
    const tools = await openTools();
    try {
      // Pinned by name rather than by pattern: a fuzzy check once matched
      // `overseas_orderbook`, which is a quotation.
      assert.deepEqual((await tools.names()).sort(), [
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
    } finally {
      await tools.close();
    }
  });

  test('the account tools stay away without an account', async () => {
    const client: KisClient = { get: async () => ({}), getAll: async () => [] };
    const server = new McpServer({ name: 'kis-test', version: '0' });
    registerTools(server, client);

    const [near, far] = InMemoryTransport.createLinkedPair();
    const pending = new Map<number, (message: Record<string, any>) => void>();
    near.onmessage = (message: any) => {
      const settle = pending.get(message.id);
      if (settle !== undefined) {
        pending.delete(message.id);
        settle(message);
      }
    };
    await server.connect(far);
    await near.start();

    let id = 0;
    const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, any>> =>
      new Promise((resolve) => {
        id += 1;
        pending.set(id, resolve);
        void near.send({ jsonrpc: '2.0', id, method, params } as any);
      });
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    await near.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as any);

    const names = ((await rpc('tools/list', {}))['result'].tools as { name: string }[]).map((t) => t.name);
    assert.ok(names.includes('overseas_quote'), 'quotations need no account');
    for (const account of ['overseas_balance', 'overseas_holdings', 'overseas_executions', 'overseas_realized_pnl']) {
      assert.ok(!names.includes(account), `${account} must not be served without an account`);
    }

    await near.close();
    await server.close();
  });
});
