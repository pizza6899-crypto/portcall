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
  test('eleven tools, every one of them read-only', async () => {
    const tools = await openTools();
    try {
      const listed = await tools.listed();
      assert.equal(listed.length, 11);
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
        'overseas_dividends',
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

  test('the account number KIS echoes back does not travel with the answer', async () => {
    // Every account call sends the account number and gets it handed straight
    // back, on rows and on totals alike. Whoever configured the mount already
    // knows it and the answer goes on to a transcript, so it is dropped on the
    // way out. Pinned across all four tools and both shapes: the drop was
    // wired into the two position lists and nowhere else, which reads from the
    // outside exactly like a measure that is in place.
    const echoed = { cano: '12345678', acnt_prdt_cd: '01' };
    const tools = await openTools({
      rt_cd: '0',
      output: [{ ...echoed, pdno: 'SOXL' }],
      output1: [{ ...echoed, ovrs_pdno: 'SOXL' }],
      output2: [{ ...echoed, tot_pftrt: '1.0' }],
      output3: [{ ...echoed, tot_asst_amt: '100' }],
    });
    try {
      for (const name of ['overseas_holdings', 'overseas_balance', 'overseas_executions', 'overseas_realized_pnl']) {
        const answer = JSON.stringify((await tools.call(name))['result']);
        assert.ok(!answer.includes('"cano"'), `${name} passes the account number through`);
        assert.ok(!answer.includes('"acnt_prdt_cd"'), `${name} passes the product code through`);
      }
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

describe('overseas dividends', () => {
  const DIVIDEND_BODY = {
    rt_cd: '0',
    output: [
      {
        pdno: 'SGOV',
        prdt_name: 'ISHARES TRUST ISHARES 0-3 MONTH TREASURY BOND ETF',
        prdt_type_cd: '529',
        bass_dt: '20260902',
        acpl_bass_dt: '20260901',
        crcy_cd: 'USD',
        alct_frcr_unpr: '0.34664',
        stkp_dvdn_frcr_amt2: '0.00000',
        dfnt_yn: 'Y',
      },
    ],
    output1: [
      { ca_title: '현금배당', record_dt: '20260901', div_lock_dt: '20260901', pay_dt: '20260904' },
      { ca_title: '현금배당', record_dt: '20261001', div_lock_dt: '20261001', pay_dt: '20261006' },
    ],
  };

  test('the per-share amount is the allotment price, not the field named for a dividend', async () => {
    // KIS calls `stkp_dvdn_frcr_amt2` 주당배당외화금액 and sends 0.00000 in it
    // on every cash dividend; the money is in 배정외화단가. Taking the
    // documented name would report every dividend as zero.
    const tools = await openTools(DIVIDEND_BODY);
    try {
      const data = (await tools.call('overseas_dividends', { symbols: ['SGOV'], calendar: false }))['result']
        .structuredContent;
      const [dividend] = data.symbols[0].dividends;

      assert.equal(dividend.perShare, '0.34664');
      assert.equal(dividend.currency, 'USD');
      assert.equal(dividend.perShare, DIVIDEND_BODY.output[0]!.alct_frcr_unpr);
      assert.notEqual(dividend.perShare, DIVIDEND_BODY.output[0]!.stkp_dvdn_frcr_amt2);
      // Passed through under KIS's own name rather than mapped to something
      // that would read as the amount.
      assert.equal(dividend.stkp_dvdn_frcr_amt2, '0.00000');
    } finally {
      await tools.close();
    }
  });

  test('a payment date is attached on the local record date, and unmatched events are kept', async () => {
    const tools = await openTools(DIVIDEND_BODY);
    try {
      const data = (await tools.call('overseas_dividends', { symbols: ['SGOV'] }))['result'].structuredContent;
      const held = data.symbols[0];

      assert.equal(held.dividends[0].payDate, '20260904', 'joined on acpl_bass_dt, not bass_dt');
      assert.equal(held.dividends[0].exDividendDate, '20260901');
      assert.equal(held.scheduled.length, 1, 'a declared-but-unpaid dividend is still worth returning');
      assert.equal(held.scheduled[0].recordDate, '20261001');
    } finally {
      await tools.close();
    }
  });

  test('asks the rights calendar per symbol and the ICE calendar beside it', async () => {
    const tools = await openTools(DIVIDEND_BODY);
    try {
      await tools.call('overseas_dividends', { symbols: ['SGOV', 'TQQQ'], startDate: '20260101', endDate: '20260601' });

      const rights = tools.calls.filter((call) => call.endpoint.path.endsWith('/period-rights'));
      const ice = tools.calls.filter((call) => call.endpoint.path.endsWith('/rights-by-ice'));

      assert.deepEqual(
        rights.map((call) => call.params['PDNO']),
        ['SGOV', 'TQQQ'],
      );
      assert.equal(rights[0]?.params['RGHT_TYPE_CD'], '03', 'dividends only unless asked otherwise');
      assert.equal(rights[0]?.params['INQR_DVSN_CD'], '02', 'record date, not a subscription window');
      assert.equal(rights[0]?.params['INQR_STRT_DT'], '20260101');
      assert.equal(rights[0]?.params['INQR_END_DT'], '20260601');
      assert.deepEqual(
        ice.map((call) => call.params['SYMB']),
        ['SGOV', 'TQQQ'],
      );
      assert.equal(ice[0]?.params['NCOD'], 'US');
      // ICE filters on the announcement date, which runs ahead of the record
      // date by anything from a day to eleven months, so it is asked for a
      // year more than the amounts are. Asked for the same range it answers
      // for one dividend in twelve.
      assert.equal(ice[0]?.params['ST_YMD'], '20250101', 'a year before the window opens');
      assert.equal(ice[0]?.params['ED_YMD'], '20260601', 'and no further than it closes');
    } finally {
      await tools.close();
    }
  });

  test('without symbols it sweeps the window once and asks ICE nothing', async () => {
    const tools = await openTools(DIVIDEND_BODY);
    try {
      const data = (await tools.call('overseas_dividends', {}))['result'].structuredContent;

      assert.equal(tools.calls.length, 1, 'one sweep, not one call per ticker in the market');
      assert.equal(tools.calls[0]?.params['PDNO'], '');
      assert.equal(tools.calls[0]?.params['INQR_END_DT'], seoulToday());
      assert.equal(data.dividends.length, 1);
    } finally {
      await tools.close();
    }
  });

  test('the calendar can be turned off', async () => {
    const tools = await openTools(DIVIDEND_BODY);
    try {
      await tools.call('overseas_dividends', { symbols: ['SGOV'], calendar: false });
      assert.equal(
        tools.calls.filter((call) => call.endpoint.path.endsWith('/rights-by-ice')).length,
        0,
      );
    } finally {
      await tools.close();
    }
  });
});

describe('the dividend calendar is not a clean feed', () => {
  const MESSY = {
    rt_cd: '0',
    output: [
      {
        pdno: 'TQQQ',
        prdt_name: 'PROSHARES TRUST ULTRAPRO QQQ USD',
        bass_dt: '20260326',
        acpl_bass_dt: '20260325',
        crcy_cd: 'USD',
        alct_frcr_unpr: '0.07162',
        dfnt_yn: 'Y',
      },
    ],
    output1: [
      // Matches the row above.
      { ca_title: '현금배당', anno_dt: '20260120', record_dt: '20260325', div_lock_dt: '20260325', pay_dt: '20260331' },
      // Not a dividend at all.
      { ca_title: '주식분할', anno_dt: '20251105', record_dt: '20301118', div_lock_dt: '', pay_dt: '' },
      // Known to the month only, with no record date set yet.
      { ca_title: '현금배당', anno_dt: '20251117', record_dt: '', div_lock_dt: '20301200', pay_dt: '20310100' },
      // A real upcoming dividend.
      { ca_title: '현금배당', anno_dt: '20260120', record_dt: '20301223', div_lock_dt: '20301223', pay_dt: '20301230' },
      // Announced inside the widened calendar window but settled long before
      // the window the amounts were asked for.
      { ca_title: '현금배당', anno_dt: '20240101', record_dt: '20240115', div_lock_dt: '20240115', pay_dt: '20240120' },
    ],
  };

  test('a stock split is not returned as a scheduled dividend', async () => {
    const tools = await openTools(MESSY);
    try {
      const data = (await tools.call('overseas_dividends', { symbols: ['TQQQ'] }))['result'].structuredContent;
      const events = data.symbols[0].scheduled.map((event: Record<string, any>) => event.event);

      assert.equal(events.includes('주식분할'), false, 'ICE files splits and mergers in the same list');
      assert.ok(events.every((event: string) => event === '현금배당'));
    } finally {
      await tools.close();
    }
  });

  test('a date ICE knows only to the month is marked, not passed off as a date', async () => {
    const tools = await openTools(MESSY);
    try {
      const data = (await tools.call('overseas_dividends', { symbols: ['TQQQ'] }))['result'].structuredContent;
      const placeholder = data.symbols[0].scheduled.find((event: Record<string, any>) => event.payDate === '20310100');

      // 20310100 is not a date. Parsed it is either invalid or silently
      // December, so the row says so rather than reading as a schedule.
      assert.ok(placeholder, 'a dividend expected but not yet scheduled is still worth returning');
      assert.equal(placeholder.approximate, true);
      assert.equal(placeholder.recordDate, '');

      const real = data.symbols[0].scheduled.find((event: Record<string, any>) => event.payDate === '20301230');
      assert.equal(real.approximate, undefined, 'a real schedule is not flagged');
    } finally {
      await tools.close();
    }
  });

  test('an event that predates the window is dropped rather than called scheduled', async () => {
    const tools = await openTools(MESSY);
    try {
      const held = (await tools.call('overseas_dividends', {
        symbols: ['TQQQ'],
        startDate: '20250101',
        endDate: '20260601',
      }))['result'].structuredContent.symbols[0];

      for (const list of [held.scheduled, held.unpriced]) {
        assert.equal(
          list.some((event: Record<string, any>) => event.recordDate === '20240115'),
          false,
          'it is only there because the calendar window was widened to catch announcements',
        );
      }
    } finally {
      await tools.close();
    }
  });

  test('a dividend ICE reports inside the window with no amount is surfaced, not dropped', async () => {
    // The two feeds disagree: ICE reports SOXL dividends in March and June
    // that the rights list has no row for. Dropping them understates a year.
    const tools = await openTools({
      rt_cd: '0',
      output: [],
      output1: [
        { ca_title: '현금배당', anno_dt: '20260126', record_dt: '20260324', div_lock_dt: '20260324', pay_dt: '20260331' },
      ],
    });
    try {
      const held = (await tools.call('overseas_dividends', {
        symbols: ['SOXL'],
        startDate: '20260101',
        endDate: '20260601',
      }))['result'].structuredContent.symbols[0];

      assert.equal(held.dividends.length, 0);
      assert.equal(held.unpriced.length, 1);
      assert.equal(held.unpriced[0].payDate, '20260331');
      assert.equal(held.scheduled.length, 0, 'it is past, not upcoming');
    } finally {
      await tools.close();
    }
  });

  test('a placeholder whose month has passed is a superseded draft, not a schedule', async () => {
    const tools = await openTools({
      rt_cd: '0',
      output: [],
      output1: [
        // Points at a month already gone by: the real schedule has since
        // been published and is listed in its own right.
        { ca_title: '현금배당', anno_dt: '20251209', record_dt: '', div_lock_dt: '20251200', pay_dt: '20251200' },
        // Still ahead.
        { ca_title: '현금배당', anno_dt: '20260901', record_dt: '', div_lock_dt: '20261200', pay_dt: '20261200' },
      ],
    });
    try {
      const held = (await tools.call('overseas_dividends', {
        symbols: ['SOXL'],
        startDate: '20260101',
        endDate: '20260601',
      }))['result'].structuredContent.symbols[0];

      assert.deepEqual(
        held.scheduled.map((event: Record<string, any>) => event.payDate),
        ['20261200'],
      );
    } finally {
      await tools.close();
    }
  });
});
