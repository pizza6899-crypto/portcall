import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Endpoint, KisClient } from '../src/plugins/kis/client.js';
import { createHistoryStore, HISTORY_FLOOR } from '../src/plugins/kis/history.js';

/** Sessions, weekends skipped, oldest first. */
function sessions(count: number, lastDate: string): string[] {
  const end = Date.UTC(
    Number(lastDate.slice(0, 4)),
    Number(lastDate.slice(4, 6)) - 1,
    Number(lastDate.slice(6, 8)),
  );
  const days: string[] = [];
  for (let back = 0; days.length < count; back += 1) {
    const at = new Date(end - back * 86_400_000);
    const weekday = at.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(at.toISOString().slice(0, 10).replaceAll('-', ''));
  }
  return days.reverse();
}

interface Venue {
  /** date → close. Everything else is derived, since only the close is compared. */
  closes: Map<string, number>;
}

interface Fake {
  client: KisClient;
  calls: { exchange: string; endDate: string }[];
  venue: (exchange: string) => Venue;
}

/** A KIS that serves 100 bars a page from a synthetic series, as the real one does. */
function fakeKis(series: Record<string, string[]>): Fake {
  const venues = new Map<string, Venue>();
  for (const [exchange, dates] of Object.entries(series)) {
    venues.set(exchange, { closes: new Map(dates.map((date, i) => [date, 100 + i])) });
  }
  const calls: { exchange: string; endDate: string }[] = [];

  const client: KisClient = {
    get: async (_endpoint: Endpoint, params: Record<string, string>) => {
      const exchange = params['EXCD'] ?? '';
      const endDate = params['BYMD'] ?? '';
      calls.push({ exchange, endDate });

      const venue = venues.get(exchange);
      if (venue === undefined) return { rt_cd: '0', output1: {}, output2: [] };

      const upTo = [...venue.closes.keys()].filter((date) => endDate === '' || date <= endDate).sort();
      const page = upTo.slice(-100).reverse(); // KIS answers newest first
      return {
        rt_cd: '0',
        output1: {},
        output2: page.map((date) => {
          const close = venue.closes.get(date)!;
          return {
            xymd: date,
            open: close.toFixed(2),
            high: (close + 1).toFixed(2),
            low: (close - 1).toFixed(2),
            clos: close.toFixed(2),
            tvol: '1000',
          };
        }),
      };
    },
    getAll: async () => [],
  };

  return { client, calls, venue: (exchange) => venues.get(exchange)! };
}

async function store(client: KisClient) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'portcall-history-'));
  return { store: createHistoryStore({ client, cacheDir }), cacheDir };
}

describe('assembling a long history', () => {
  test('pages backwards until the series runs out, then keeps it', async () => {
    const kis = fakeKis({ NAS: sessions(250, '20260918') });
    const { store: history, cacheDir } = await store(kis.client);

    const series = await history.get({ symbol: 'SOXX' });

    assert.equal(series.bars.length, 250);
    assert.equal(series.bars[0]![0] < series.bars.at(-1)![0], true, 'oldest first');
    assert.equal(series.complete, true, 'the walk reached the end of what KIS holds');
    assert.ok(series.fetched >= 3, `250 bars is at least three pages, spent ${series.fetched}`);
    assert.deepEqual(
      (await readdir(cacheDir)).filter((name) => name.endsWith('.tmp')),
      [],
      'the cache is renamed into place, not left aside',
    );
  });

  test('a repeat request spends one call, not forty-eight', async () => {
    const kis = fakeKis({ NAS: sessions(250, '20260918') });
    const { store: history } = await store(kis.client);

    await history.get({ symbol: 'SOXX' });
    const before = kis.calls.length;
    const again = await history.get({ symbol: 'SOXX' });

    assert.equal(again.bars.length, 250);
    assert.equal(kis.calls.length - before, 1, 'only the newest page is re-read');
    assert.equal(again.fetched, 1);
  });

  test('bars come back as the six fields a price series needs', async () => {
    const kis = fakeKis({ NAS: sessions(10, '20260918') });
    const { store: history } = await store(kis.client);

    const series = await history.get({ symbol: 'SOXX' });
    for (const bar of series.bars) assert.equal(bar.length, 6, 'date, open, high, low, close, volume');
  });

  test('a date range slices what is held without re-fetching it', async () => {
    const kis = fakeKis({ NAS: sessions(250, '20260918') });
    const { store: history } = await store(kis.client);

    await history.get({ symbol: 'SOXX' });
    const window = await history.get({ symbol: 'SOXX', startDate: '20260801', endDate: '20260831' });

    assert.ok(window.bars.length > 0 && window.bars.length < 30);
    assert.ok(window.bars.every((bar) => bar[0] >= '20260801' && bar[0] <= '20260831'));
    assert.equal(window.cachedFrom! < '20260801', true, 'the cache still reaches further back than the slice');
  });
});

describe('history that changed underneath the cache', () => {
  test('a split restates every close, so the cache is rebuilt rather than trusted', async () => {
    // This is the "big event" that makes stale history wrong rather than
    // merely short: adjusted prices are restated all the way back, and the
    // leveraged ETFs this exists for split often.
    const kis = fakeKis({ NAS: sessions(250, '20260918') });
    const { store: history } = await store(kis.client);

    const before = await history.get({ symbol: 'TQQQ' });
    const oldOldest = before.bars[0]![4];

    const venue = kis.venue('NAS');
    for (const [date, close] of venue.closes) venue.closes.set(date, close / 2);

    const after = await history.get({ symbol: 'TQQQ' });

    assert.equal(after.bars.length, 250, 'the whole series is back');
    assert.equal(after.bars[0]![4], (Number(oldOldest) / 2).toFixed(2), 'and it is the restated one');
    assert.ok(after.fetched >= 3, 'a restatement costs a rebuild, not one page');
  });

  test('a quiet stretch longer than one page is bridged, not left as a hole', async () => {
    // Away long enough and the newest page no longer touches what is stored.
    // Merging the two regardless would leave a gap in the middle of a series
    // whose whole purpose is to be continuous.
    const kis = fakeKis({ NAS: sessions(120, '20260301') });
    const { store: history } = await store(kis.client);
    await history.get({ symbol: 'SOXX' });

    // Six more months arrive — far more than the 100 bars one page carries.
    const venue = kis.venue('NAS');
    let next = 1000;
    for (const date of sessions(140, '20260918')) if (!venue.closes.has(date)) venue.closes.set(date, next++);

    const series = await history.get({ symbol: 'SOXX' });
    const dates = series.bars.map((bar) => bar[0]);

    assert.deepEqual(dates, [...dates].sort(), 'still in order');
    assert.equal(new Set(dates).size, dates.length, 'no date twice');
    const expected = [...venue.closes.keys()].sort();
    assert.deepEqual(dates, expected, 'every session is present, with nothing missing in the middle');
  });

  test('a server that ignores endDate does not spin forever', async () => {
    // A page that never gets older would otherwise be requested until the
    // budget ran out, or not at all.
    let calls = 0;
    const stuck: KisClient = {
      get: async () => {
        calls += 1;
        return {
          rt_cd: '0',
          output2: sessions(100, '20260918').map((date) => ({
            xymd: date, open: '1', high: '1', low: '1', clos: '1', tvol: '1',
          })),
        };
      },
      getAll: async () => [],
    };
    const { store: history } = await store(stuck);

    const series = await history.get({ symbol: 'SOXX', startDate: HISTORY_FLOOR });
    assert.equal(series.bars.length, 100);
    assert.ok(calls <= 3, `stopped after ${calls} calls instead of walking the budget`);
  });
});

describe('finding the venue a symbol lists on', () => {
  test('a bare symbol is looked up across the US venues', async () => {
    // SOXL lists on AMS while its peers list on NAS, and the wrong code
    // returns an empty page rather than an error — silence that reads as
    // "no data" when it means "wrong place".
    const kis = fakeKis({ AMS: sessions(120, '20260918') });
    const { store: history } = await store(kis.client);

    const series = await history.get({ symbol: 'SOXL' });

    assert.equal(series.exchange, 'AMS');
    assert.equal(series.bars.length, 120);
    assert.deepEqual(kis.calls.slice(0, 2).map((c) => c.exchange), ['NAS', 'AMS'], 'NAS first, then AMS');
  });

  test('the venue is remembered, so the next call does not probe again', async () => {
    const kis = fakeKis({ AMS: sessions(120, '20260918') });
    const { store: history } = await store(kis.client);

    await history.get({ symbol: 'SOXL' });
    const before = kis.calls.length;
    await history.get({ symbol: 'SOXL' });

    assert.deepEqual(kis.calls.slice(before).map((c) => c.exchange), ['AMS']);
  });

  test('a symbol on no US venue says which ones were tried', async () => {
    const kis = fakeKis({});
    const { store: history } = await store(kis.client);
    await assert.rejects(() => history.get({ symbol: 'NOSUCH' }), /NAS, AMS, NYS/);
  });

  test('a ticker that could escape the cache directory is refused', async () => {
    const kis = fakeKis({ NAS: sessions(10, '20260918') });
    const { store: history } = await store(kis.client);
    for (const symbol of ['../../etc/passwd', 'a/b', '']) {
      await assert.rejects(() => history.get({ symbol }), /usable ticker/, symbol);
    }
  });
});
