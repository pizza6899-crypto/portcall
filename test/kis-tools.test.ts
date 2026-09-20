import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';

import type { Endpoint, KisClient } from '../src/plugins/kis/client.js';
import type { Bar, HistoryStore } from '../src/plugins/kis/history.js';
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

/** A ten-deep book as KIS lays it out: flat `pbid1`…`dask10` keys on `output2`. */
function book(levels: { bid?: string; bidSize?: string; ask?: string; askSize?: string }[]): Record<string, string> {
  const flat: Record<string, string> = {};
  for (let i = 1; i <= 10; i += 1) {
    const level = levels[i - 1];
    flat[`pbid${i}`] = level?.bid ?? '0.0000';
    flat[`vbid${i}`] = level?.bidSize ?? '0';
    flat[`dbid${i}`] = '0';
    flat[`pask${i}`] = level?.ask ?? '0.0000';
    flat[`vask${i}`] = level?.askSize ?? '0';
    flat[`dask${i}`] = '0';
  }
  return flat;
}

describe('the order book', () => {
  test('the ladder KIS puts in output2 actually comes back', async () => {
    // The bug this pins: the tool renamed `output1` only, so the ten levels
    // were dropped and the summary read `bid ? / ask ?` on every call.
    const tools = await openTools({
      rt_cd: '0',
      output1: { last: '336.13', base: '337.0000' },
      output2: book([
        { bid: '336.10', bidSize: '200', ask: '336.20', askSize: '150' },
        { bid: '336.05', bidSize: '400', ask: '336.25', askSize: '300' },
      ]),
      output3: {},
    });
    try {
      const response = await tools.call('overseas_orderbook', { exchange: 'NAS', symbol: 'AAPL' });
      const data = response['result'].structuredContent;

      assert.equal(data.levels.length, 2, 'both quoted levels are returned');
      assert.deepEqual(data.levels[0], {
        level: 1,
        bid: '336.10',
        bidSize: '200',
        bidChange: '0',
        ask: '336.20',
        askSize: '150',
        askChange: '0',
      });
      assert.match(response['result'].content[0].text as string, /bid 336\.10 × 200 \/ ask 336\.20 × 150/);
    } finally {
      await tools.close();
    }
  });

  test('a closed venue reads as an empty book, not as a book priced at zero', async () => {
    // KIS pads every rung with 0.0000 outside session hours rather than
    // omitting them, which would otherwise render as ten real orders at zero.
    const tools = await openTools({ rt_cd: '0', output1: { last: '336.13' }, output2: book([]), output3: {} });
    try {
      const response = await tools.call('overseas_orderbook', { exchange: 'NAS', symbol: 'AAPL' });
      assert.deepEqual(response['result'].structuredContent.levels, []);
      assert.match(response['result'].content[0].text as string, /no resting quotes/);
    } finally {
      await tools.close();
    }
  });

  test('one side quoting on its own keeps its rung', async () => {
    const tools = await openTools({
      rt_cd: '0',
      output1: {},
      output2: book([{ ask: '336.20', askSize: '150' }]),
      output3: {},
    });
    try {
      const data = (await tools.call('overseas_orderbook', { exchange: 'NAS', symbol: 'AAPL' }))['result']
        .structuredContent;
      assert.equal(data.levels.length, 1);
      assert.equal(data.levels[0].ask, '336.20');
      assert.equal('bid' in data.levels[0], false, 'an unquoted side is left out rather than sent as zero');
    } finally {
      await tools.close();
    }
  });

  test('the r-prefixed fields are labelled as percentages, because that is what they are', async () => {
    // base 337.0000 with open 337.9050 arrives as ropen "+0.27" on the live
    // API — a change against the previous close, not a fifth set of prices.
    const tools = await openTools({
      rt_cd: '0',
      output1: { base: '337.0000', open: '337.9050', ropen: '+0.27', rhigh: '+0.44', rlow: '-1.33', rclose: '-0.26' },
      output2: book([]),
      output3: {},
    });
    try {
      const data = (await tools.call('overseas_orderbook', { exchange: 'NAS', symbol: 'AAPL' }))['result']
        .structuredContent;
      assert.equal(data.openPercent, '+0.27');
      assert.equal(data.closePercent, '-0.26');
      assert.equal(data.open, '337.9050', 'the price itself is still the price');
      assert.equal('ropen' in data, false, 'nothing is left under its KIS abbreviation');
    } finally {
      await tools.close();
    }
  });
});

describe('a chart range KIS will not serve in full', () => {
  /** `count` sessions of padding, newest first, ending on the given date. */
  function series(count: number, endDate: string): Record<string, string>[] {
    const end = new Date(`${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6)}T00:00:00Z`);
    return [...Array(count)].map((_, i) => {
      const day = new Date(end.getTime() - i * 86_400_000);
      return { stck_bsop_date: day.toISOString().slice(0, 10).replaceAll('-', ''), ovrs_nmix_prpr: '1390.0' };
    });
  }

  test('a range that came back short says so instead of implying it is complete', async () => {
    // The endpoint caps a call at 100 rows and echoes the requested dates, so
    // a three-year ask used to read as a three-year answer.
    const tools = await openTools({ rt_cd: '0', output1: {}, output2: series(100, '20260918') });
    try {
      const response = await tools.call('fx_rate', {
        currency: 'KRW',
        startDate: '20240101',
        endDate: '20260920',
      });
      const data = response['result'].structuredContent;

      assert.equal(data.truncated, true);
      assert.equal(data.covered.to, '20260918');
      assert.equal(data.covered.from, '20260611', 'the oldest row that actually arrived');
      assert.equal(data.from, '20240101', 'what was asked for is still reported, as what was asked for');
      assert.match(response['result'].content[0].text as string, /KIS capped this at 20260611–20260918/);
    } finally {
      await tools.close();
    }
  });

  test('a range that fits is not flagged', async () => {
    const tools = await openTools({ rt_cd: '0', output1: {}, output2: series(34, '20260918') });
    try {
      const response = await tools.call('fx_rate', {
        currency: 'KRW',
        startDate: '20260801',
        endDate: '20260920',
      });
      assert.equal(response['result'].structuredContent.truncated, false);
      assert.doesNotMatch(response['result'].content[0].text as string, /capped/);
    } finally {
      await tools.close();
    }
  });

  test('the index tool reports its coverage the same way', async () => {
    const tools = await openTools({ rt_cd: '0', output1: {}, output2: series(100, '20260918') });
    try {
      const data = (await tools.call('overseas_index', { index: 'SPX', startDate: '20200101' }))['result']
        .structuredContent;
      assert.equal(data.truncated, true);
      assert.equal(data.covered.from, '20260611');
    } finally {
      await tools.close();
    }
  });
});

describe('the history tool', () => {
  /** A store that answers from a fixed series, so only the rendering is under test. */
  function stubHistory(count: number): HistoryStore {
    const bars: Bar[] = [...Array(count)].map((_, i) => {
      const day = new Date(Date.UTC(2010, 0, 4) + i * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
      return [day, '10.00', '11.00', '9.00', String(10 + i) + '.00', '1000'];
    });
    return {
      get: async () => ({
        symbol: 'SOXL',
        exchange: 'AMS',
        period: 'day',
        bars,
        cachedFrom: bars[0]![0],
        cachedTo: bars.at(-1)![0],
        complete: true,
        fetched: 0,
      }),
    };
  }

  async function openWithHistory(count: number) {
    const client: KisClient = { get: async () => ({}), getAll: async () => [] };
    const server = new McpServer({ name: 'kis-test', version: '0' });
    registerTools(server, client, undefined, stubHistory(count));

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
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    await near.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as any);

    return {
      call: (args: Record<string, unknown>) => rpc('tools/call', { name: 'overseas_history', arguments: args }),
      close: async () => {
        await near.close();
        await server.close();
      },
    };
  }

  test('bars come back as CSV, not as a JSON object per bar', async () => {
    // Fourteen fields of JSON per bar is 284 bytes; six columns of CSV is 65.
    // Over four thousand bars that is the difference between 1.3 MB and 300 kB.
    const tools = await openWithHistory(5);
    try {
      const text = (await tools.call({ symbol: 'SOXL' }))['result'].content[0].text as string;
      const lines = text.split('\n');
      assert.equal(lines[2], 'date,open,high,low,close,volume', 'a header row names the columns');
      assert.equal(lines[3], '20100104,10.00,11.00,9.00,10.00,1000');
      assert.equal(lines.length, 3 + 5, 'one line per bar, nothing else');
    } finally {
      await tools.close();
    }
  });

  test('the bars are not also repeated in the structured payload', async () => {
    // `result` renders structuredContent into the same text block, so carrying
    // the series in both would put every byte on the wire twice.
    const tools = await openWithHistory(5);
    try {
      const data = (await tools.call({ symbol: 'SOXL' }))['result'].structuredContent;
      assert.equal('bars' in data, false);
      assert.equal(data.count, 5);
      assert.equal(data.columns, 'date,open,high,low,close,volume');
    } finally {
      await tools.close();
    }
  });

  test('more bars than asked for are clipped to the newest, and said so', async () => {
    const tools = await openWithHistory(300);
    try {
      const response = await tools.call({ symbol: 'SOXL', maxBars: 100 });
      const data = response['result'].structuredContent;
      assert.equal(data.truncated, true);
      assert.equal(data.count, 100);
      assert.equal(data.matched, 300, 'and how many there really were');
      assert.equal(data.cachedFrom, '20100104', 'the cache still holds the rest');
      assert.match(response['result'].content[0].text as string, /clipped from 300 to the newest 100/);

      const lines = (response['result'].content[0].text as string).split('\n');
      assert.equal(lines.at(-1)!.startsWith(data.to), true, 'the newest bar is the last line');
    } finally {
      await tools.close();
    }
  });

  test('a series that fits is not flagged', async () => {
    const tools = await openWithHistory(50);
    try {
      const data = (await tools.call({ symbol: 'SOXL' }))['result'].structuredContent;
      assert.equal(data.truncated, false);
      assert.equal('matched' in data, false);
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
