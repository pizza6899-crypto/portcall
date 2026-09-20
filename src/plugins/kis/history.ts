import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ENDPOINTS, type KisClient } from './client.js';
import { log } from '../../log.js';

/**
 * Long price histories, cached on disk.
 *
 * KIS serves 100 bars per call with no continuation cursor, so nineteen years
 * of daily bars is forty-eight round trips. That is tolerable once and absurd
 * on every request, and the answer never changes: a bar from 2014 is settled.
 * So the series is assembled once, kept, and afterwards only its tail is
 * refreshed.
 *
 * The one thing that does rewrite history is a split. `adjusted` prices are
 * restated all the way back, and the leveraged ETFs this exists for split
 * often. Checking the newest page against what is already stored catches
 * that for the cost of the call the refresh needs anyway.
 */

/** The oldest date KIS serves on this endpoint, measured against several symbols. */
export const HISTORY_FLOOR = '20070820';

/** Bars in one KIS response. */
const PAGE_ROWS = 100;

/** Ceiling on the round trips one cold fetch may spend. Nineteen years is ~48. */
const MAX_PAGES = 70;

/** US venues, in the order a bare symbol is looked for. */
const US_EXCHANGES = ['NAS', 'AMS', 'NYS'] as const;

export type Period = 'day' | 'week' | 'month';

const PERIOD_CODE: Record<Period, string> = { day: '0', week: '1', month: '2' };

/** One bar: date, then OHLC and volume, exactly as KIS spells them. */
export type Bar = [string, string, string, string, string, string];

export const COLUMNS = 'date,open,high,low,close,volume';

interface CacheFile {
  symbol: string;
  exchange: string;
  period: Period;
  adjusted: boolean;
  /** True once a walk backwards came back empty, so there is nothing older. */
  complete: boolean;
  /** Oldest first. A time series reads forwards. */
  bars: Bar[];
}

function isBar(row: unknown): row is Bar {
  return Array.isArray(row) && row.length === 6 && row.every((cell) => typeof cell === 'string');
}

/** KIS row → bar, dropping the nine fields a price series has no use for. */
function toBar(row: unknown): Bar | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const source = row as Record<string, unknown>;
  const cells = ['xymd', 'open', 'high', 'low', 'clos', 'tvol'].map((key) =>
    typeof source[key] === 'string' ? (source[key] as string).trim() : '',
  );
  return cells[0] === '' ? undefined : (cells as Bar);
}

/** A symbol as it may appear in a filename. Tickers are plain; anything else is refused. */
function safeSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(upper)) throw new Error(`Not a usable ticker: ${symbol}`);
  return upper;
}

export interface HistoryOptions {
  client: KisClient;
  /** Directory the per-symbol series live in. */
  cacheDir: string;
}

export interface HistoryQuery {
  symbol: string;
  /** Left out, the US venues are tried in turn and the answer remembered. */
  exchange?: string | undefined;
  period?: Period;
  startDate?: string | undefined;
  endDate?: string | undefined;
  adjusted?: boolean;
}

export interface HistoryResult {
  symbol: string;
  exchange: string;
  period: Period;
  bars: Bar[];
  /** Everything held for this symbol, which may reach further than `bars`. */
  cachedFrom: string | undefined;
  cachedTo: string | undefined;
  /** True once nothing older exists to fetch. */
  complete: boolean;
  /** Round trips this call spent. Zero means it came entirely from disk. */
  fetched: number;
}

export interface HistoryStore {
  get(query: HistoryQuery): Promise<HistoryResult>;
}

export function createHistoryStore(options: HistoryOptions): HistoryStore {
  const { client, cacheDir } = options;

  /** Symbol → venue, so a resolved ticker is not probed again this run. */
  const venues = new Map<string, string>();

  function cachePath(symbol: string, period: Period, adjusted: boolean): string {
    return join(cacheDir, `${symbol}-${period}${adjusted ? '' : '-raw'}.json`);
  }

  async function load(path: string): Promise<CacheFile | undefined> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as CacheFile;
      if (!Array.isArray(parsed.bars) || !parsed.bars.every(isBar)) return undefined;
      return parsed;
    } catch {
      // No cache, or one this version cannot read. Rebuilding is only slow.
      return undefined;
    }
  }

  async function save(path: string, file: CacheFile): Promise<void> {
    // Beside the target and moved into place: a series torn in half reads as
    // corrupt and costs the full forty-eight calls to rebuild.
    const pending = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(pending, JSON.stringify(file), { mode: 0o600 });
      await rename(pending, path);
    } catch (error) {
      await rm(pending, { force: true }).catch(() => undefined);
      log.warn('could not cache a KIS history', { error: (error as Error).message });
    }
  }

  /** One page of bars ending at `endDate`, oldest first. */
  async function page(symbol: string, exchange: string, period: Period, endDate: string, adjusted: boolean): Promise<Bar[]> {
    const body = await client.get(ENDPOINTS.dailyPrice, {
      AUTH: '',
      EXCD: exchange,
      SYMB: symbol,
      GUBN: PERIOD_CODE[period],
      BYMD: endDate,
      MODP: adjusted ? '1' : '0',
    });
    const rows = Array.isArray(body['output2']) ? body['output2'] : [];
    const bars = rows.map(toBar).filter((bar): bar is Bar => bar !== undefined);
    // KIS answers newest first; a series is stored and served forwards.
    return bars.sort((a, b) => a[0].localeCompare(b[0]));
  }

  /** The calendar day before a YYYYMMDD stamp, for the next page's end. */
  function dayBefore(stamp: string): string {
    const at = Date.UTC(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)));
    return new Date(at - 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
  }

  /** Two series into one, oldest first, one bar per date, later wins on a clash. */
  function merge(older: readonly Bar[], newer: readonly Bar[]): Bar[] {
    const byDate = new Map<string, Bar>();
    for (const bar of older) byDate.set(bar[0], bar);
    for (const bar of newer) byDate.set(bar[0], bar);
    return [...byDate.values()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  /**
   * Whether what is stored still matches what KIS is serving.
   *
   * A split restates every earlier close, so a disagreement on any shared
   * date means the whole stored series is stale, not just that one bar. No
   * shared date at all answers nothing, so it counts as agreement and the
   * gap is filled instead.
   */
  function agrees(stored: readonly Bar[], fresh: readonly Bar[]): boolean {
    const byDate = new Map(stored.map((bar) => [bar[0], bar]));
    for (const bar of fresh) {
      const held = byDate.get(bar[0]);
      if (held !== undefined && held[4] !== bar[4]) return false;
    }
    return true;
  }

  interface Walk {
    bars: Bar[];
    pages: number;
    /** True when KIS ran out of history rather than the walk reaching its target. */
    hitFloor: boolean;
  }

  /** Page backwards from `endDate` until `until` is covered, or there is no more. */
  async function walkBack(
    symbol: string,
    exchange: string,
    period: Period,
    adjusted: boolean,
    endDate: string,
    until: string,
    budget: number,
  ): Promise<Walk> {
    let bars: Bar[] = [];
    let cursor = endDate;
    let pages = 0;

    while (pages < budget) {
      const fetched = await page(symbol, exchange, period, cursor, adjusted);
      pages += 1;
      if (fetched.length === 0) return { bars, pages, hitFloor: true };

      const before = bars[0]?.[0];
      bars = merge(fetched, bars);
      const oldest = bars[0]![0];
      // KIS handed back nothing older than last time; another page would
      // repeat it, so treat the series as finished rather than loop.
      if (before !== undefined && oldest >= before) return { bars, pages, hitFloor: true };
      if (oldest <= until) return { bars, pages, hitFloor: false };
      if (fetched.length < PAGE_ROWS) return { bars, pages, hitFloor: true };
      cursor = dayBefore(oldest);
    }
    return { bars, pages, hitFloor: false };
  }

  /** Find which venue lists a bare symbol, remembering the answer. */
  async function discover(
    symbol: string,
    period: Period,
    adjusted: boolean,
  ): Promise<{ exchange: string; head: Bar[]; pages: number }> {
    let pages = 0;
    for (const exchange of US_EXCHANGES) {
      const head = await page(symbol, exchange, period, '', adjusted);
      pages += 1;
      if (head.length > 0) return { exchange, head, pages };
    }
    // Silence rather than an error is how KIS reports the wrong venue, so
    // saying which ones were tried is the whole diagnostic.
    throw new Error(
      `No history for ${symbol} on ${US_EXCHANGES.join(', ')}. Pass an exchange if it lists somewhere else.`,
    );
  }

  return {
    async get(query: HistoryQuery): Promise<HistoryResult> {
      const symbol = safeSymbol(query.symbol);
      const period = query.period ?? 'day';
      const adjusted = query.adjusted ?? true;
      const path = cachePath(symbol, period, adjusted);
      const wanted = query.startDate ?? HISTORY_FLOOR;

      let cache = await load(path);
      // An explicit venue that disagrees with what is stored is a different
      // instrument, not the same one seen differently.
      if (cache !== undefined && query.exchange !== undefined && cache.exchange !== query.exchange) cache = undefined;

      // The newest page is fetched every time. It is what extends the tail,
      // and it is what reveals a restatement.
      let exchange = query.exchange ?? cache?.exchange ?? venues.get(symbol);
      let head: Bar[];
      let fetched = 0;
      if (exchange === undefined) {
        const found = await discover(symbol, period, adjusted);
        ({ exchange, head } = found);
        fetched = found.pages;
      } else {
        head = await page(symbol, exchange, period, '', adjusted);
        fetched = 1;
      }
      venues.set(symbol, exchange);

      let bars = head;
      let complete = false;

      if (cache !== undefined && cache.bars.length > 0) {
        const cachedTo = cache.bars.at(-1)![0];

        // Unused for long enough that the newest page does not reach what is
        // stored. Close the gap before trusting either half.
        if (bars.length > 0 && bars[0]![0] > cachedTo) {
          const bridge = await walkBack(symbol, exchange, period, adjusted, dayBefore(bars[0]![0]), cachedTo, MAX_PAGES - fetched);
          fetched += bridge.pages;
          bars = merge(bridge.bars, bars);
        }

        if (agrees(cache.bars, bars)) {
          bars = merge(cache.bars, bars);
          complete = cache.complete;
        } else {
          // A split restated everything. What is held is not a shorter truth,
          // it is a wrong one.
          log.info('KIS history restated, rebuilding', { symbol, period });
        }
      }

      if (!complete && bars.length > 0 && bars[0]![0] > wanted && fetched < MAX_PAGES) {
        const older = await walkBack(symbol, exchange, period, adjusted, dayBefore(bars[0]![0]), wanted, MAX_PAGES - fetched);
        fetched += older.pages;
        bars = merge(older.bars, bars);
        if (older.hitFloor) complete = true;
      }

      if (bars.length === 0) {
        throw new Error(`KIS returned no ${period} bars for ${symbol} on ${exchange}.`);
      }

      await save(path, { symbol, exchange, period, adjusted, complete, bars });

      const from = query.startDate ?? '';
      const to = query.endDate ?? '99999999';
      return {
        symbol,
        exchange,
        period,
        bars: bars.filter((bar) => bar[0] >= from && bar[0] <= to),
        cachedFrom: bars[0]![0],
        cachedTo: bars.at(-1)![0],
        complete,
        fetched,
      };
    },
  };
}
