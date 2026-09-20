/**
 * HTTP client for the KIS read APIs.
 *
 * Read-only is enforced structurally, in three ways:
 *
 *  - the tools implement no ordering endpoint, so none can be called;
 *  - this client refuses any path outside the allowlist below;
 *  - and it refuses any tr_id that is not an inquiry.
 *
 * The third guard covers the `/uapi/overseas-stock/v1/trading/` namespace,
 * where account inquiries sit alongside the order endpoints so the path no
 * longer tells reading and trading apart on its own. There KIS suffixes every
 * inquiry tr_id with `R` and every order, amendment and cancellation with `U`
 * — `TTTS3012R` reads a balance, `TTTT1002U` buys. The quotation namespace
 * contains no ordering call at all and uses an unrelated tr_id series
 * (`HHDFS…`, `FHKST…`), so the path allowlist is the whole guard there.
 *
 * There is also no request-body parameter: every call this client can make is
 * a GET.
 */

/** Real-money domain. */
export const REAL_BASE_URL = 'https://openapi.koreainvestment.com:9443';
/** Paper-trading domain. Quotation tr_ids are shared, but coverage is thinner. */
export const PAPER_BASE_URL = 'https://openapivts.koreainvestment.com:29443';

/**
 * The width suffix on an endpoint's continuation cursor, or `null` when the
 * endpoint returns everything in one page.
 *
 * KIS names the cursor pair after how wide the opaque value is. Most account
 * inquiries take `CTX_AREA_FK200`/`CTX_AREA_NK200`, the daily transaction
 * ledger takes 100, the rights calendar 50, and the settlement calendar
 * leaves the number off altogether.
 *
 * Sending the wrong width is not an error. The server ignores parameters it
 * does not recognise, answers with the first page again, and `getAll` ends
 * the walk on its repeated-resume-point guard — so the caller is handed page
 * one with nothing to say the rest exists. That failure is silent, which is
 * why this is declared per endpoint instead of defaulting to the common one.
 */
export type CursorWidth = '200' | '100' | '50' | '' | null;

export interface Endpoint {
  path: string;
  trId: string;
  cursor: CursorWidth;
}

/** Every endpoint this plugin may call. All of them read. */
export const ENDPOINTS = {
  // Quotations — no account involved.
  price: { path: '/uapi/overseas-price/v1/quotations/price', trId: 'HHDFS00000300', cursor: null },
  priceDetail: { path: '/uapi/overseas-price/v1/quotations/price-detail', trId: 'HHDFS76200200', cursor: null },
  dailyPrice: { path: '/uapi/overseas-price/v1/quotations/dailyprice', trId: 'HHDFS76240000', cursor: null },
  askingPrice: { path: '/uapi/overseas-price/v1/quotations/inquire-asking-price', trId: 'HHDFS76200100', cursor: null },
  fxRate: { path: '/uapi/overseas-price/v1/quotations/inquire-daily-chartprice', trId: 'FHKST03030100', cursor: null },
  // Account inquiries — real-money tr_ids; the paper domain uses a `V` prefix.
  holdings: { path: '/uapi/overseas-stock/v1/trading/inquire-balance', trId: 'TTTS3012R', cursor: '200' },
  balance: { path: '/uapi/overseas-stock/v1/trading/inquire-present-balance', trId: 'CTRP6504R', cursor: null },
  executions: { path: '/uapi/overseas-stock/v1/trading/inquire-ccnl', trId: 'TTTS3035R', cursor: '200' },
  realizedPnl: { path: '/uapi/overseas-stock/v1/trading/inquire-period-profit', trId: 'TTTS3039R', cursor: '200' },
  // Rights — dividends among them. The per-share amount and the calendar come
  // from different calls, and neither knows what is held: both are quotations.
  rights: { path: '/uapi/overseas-price/v1/quotations/period-rights', trId: 'CTRGT011R', cursor: '50' },
  rightsCalendar: { path: '/uapi/overseas-price/v1/quotations/rights-by-ice', trId: 'HHDFS78330900', cursor: null },
} as const satisfies Record<string, Endpoint>;

const ALLOWED_PATHS = new Set<string>(Object.values(ENDPOINTS).map((e) => e.path));

/**
 * Minimum gap between calls. A real-money account is metered per second, so
 * spacing requests is cheaper than discovering the ceiling under load.
 */
const DEFAULT_MIN_INTERVAL_MS = 60;

/** How long one KIS call may take. Their quotation endpoints answer in well under a second. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** How many continuation pages one paged call will walk before giving up. */
const DEFAULT_MAX_PAGES = 20;

export interface KisClientOptions {
  baseUrl: string;
  appKey: string;
  appSecret: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  /** How long one KIS call may take before it is abandoned. */
  timeoutMs?: number;
}

export interface KisClient {
  /** Call one allowlisted endpoint and return its parsed body. */
  get(endpoint: Endpoint, params: Record<string, string>): Promise<Record<string, unknown>>;
  /**
   * Walk a continuation-paged endpoint and return every page.
   *
   * KIS signals "more to come" with `tr_cont` of `F` or `M` in the response
   * header, and expects the next request to echo the cursor from the previous
   * body. A year of executions does not fit in one page.
   */
  getAll(endpoint: Endpoint, params: Record<string, string>, maxPages?: number): Promise<Record<string, unknown>[]>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reason(body: Record<string, unknown>): string {
  const message = body['msg1'];
  const code = body['msg_cd'];
  const detail = typeof message === 'string' && message.trim() !== '' ? message.trim() : 'no message';
  return typeof code === 'string' ? `${code}: ${detail}` : detail;
}

function cursor(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The namespaces KIS serves both account inquiries and orders from.
 *
 * There is one per market. A path outside these is a quotation, where no
 * ordering call exists to be confused with — but "outside these" has to mean
 * a namespace nobody listed yet, not a market this list forgot. A domestic
 * trading path added while only the overseas one was named here would pass
 * the allowlist and skip the tr_id check entirely, which is the guard going
 * quiet rather than failing.
 */
export const TRADING_NAMESPACES = [
  '/uapi/overseas-stock/v1/trading/',
  '/uapi/domestic-stock/v1/trading/',
] as const;

/** Whether a path sits in a namespace where reading and ordering share a prefix. */
export function isTradingNamespace(path: string): boolean {
  return TRADING_NAMESPACES.some((namespace) => path.startsWith(namespace));
}

/** Reject anything that is not an allowlisted inquiry, before it leaves the process. */
function assertReadable(endpoint: Endpoint): void {
  if (!ALLOWED_PATHS.has(endpoint.path)) {
    throw new Error(`Refusing a KIS call outside the read allowlist: ${endpoint.path}`);
  }
  if (isTradingNamespace(endpoint.path) && !endpoint.trId.endsWith('R')) {
    throw new Error(`Refusing a KIS tr_id that is not an inquiry: ${endpoint.trId}`);
  }
}

export function createKisClient(options: KisClientOptions): KisClient {
  const {
    baseUrl,
    appKey,
    appSecret,
    getToken,
    fetchImpl = fetch,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  // Requests queue behind one another so the spacing holds across concurrent
  // tool calls, not just sequential ones.
  let gate: Promise<void> = Promise.resolve();
  let lastSentAt = 0;

  function reserveSlot(): Promise<void> {
    gate = gate.then(async () => {
      const wait = lastSentAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastSentAt = Date.now();
    });
    return gate;
  }

  async function request(
    endpoint: Endpoint,
    params: Record<string, string>,
    continuation: string,
  ): Promise<{ body: Record<string, unknown>; trCont: string }> {
    assertReadable(endpoint);

    const token = await getToken();
    await reserveSlot();

    const url = new URL(endpoint.path, baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    // Without a deadline a stalled connection leaves the tool call hanging
    // for as long as the client will wait, with nothing said about why.
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: endpoint.trId,
        custtype: 'P',
        ...(continuation === '' ? {} : { tr_cont: continuation }),
      },
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`KIS ${endpoint.trId} responded ${response.status}: ${detail}`);
    }

    const body = (await response.json()) as Record<string, unknown>;

    // KIS answers 200 with `rt_cd` set to a non-zero string on rejection —
    // an unchecked body would look like an empty result rather than a fault.
    if (body['rt_cd'] !== undefined && body['rt_cd'] !== '0') {
      throw new Error(`KIS ${endpoint.trId} rejected the request (${reason(body)})`);
    }

    return { body, trCont: response.headers.get('tr_cont')?.trim() ?? '' };
  }

  return {
    async get(endpoint, params) {
      return (await request(endpoint, params, '')).body;
    },

    async getAll(endpoint, params, maxPages = DEFAULT_MAX_PAGES) {
      if (endpoint.cursor === null) {
        // Paging an endpoint that does not continue would send two parameters
        // it has no name for and read a resume point that never arrives. Say
        // so rather than return one page as though it were all of them.
        throw new Error(`Refusing to page an endpoint that returns one page: ${endpoint.path}`);
      }

      const fkParam = `CTX_AREA_FK${endpoint.cursor}`;
      const nkParam = `CTX_AREA_NK${endpoint.cursor}`;
      const fkKey = fkParam.toLowerCase();
      const nkKey = nkParam.toLowerCase();

      const pages: Record<string, unknown>[] = [];
      let continuation = '';
      let fk = '';
      let nk = '';

      for (let page = 0; page < maxPages; page += 1) {
        const { body, trCont } = await request(
          endpoint,
          { ...params, [fkParam]: fk, [nkParam]: nk },
          continuation,
        );
        pages.push(body);

        if (trCont !== 'F' && trCont !== 'M') break;

        const nextFk = cursor(body, fkKey);
        const nextNk = cursor(body, nkKey);
        // KIS says there is more but hands back the same resume point, so the
        // next request would return this page again. Stop rather than collect
        // the same rows `maxPages` times.
        if (nextFk === fk && nextNk === nk) break;

        fk = nextFk;
        nk = nextNk;
        continuation = 'N';
      }

      return pages;
    },
  };
}
