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

export interface Endpoint {
  path: string;
  trId: string;
}

/** Every endpoint this plugin may call. All of them read. */
export const ENDPOINTS = {
  // Quotations — no account involved.
  price: { path: '/uapi/overseas-price/v1/quotations/price', trId: 'HHDFS00000300' },
  priceDetail: { path: '/uapi/overseas-price/v1/quotations/price-detail', trId: 'HHDFS76200200' },
  dailyPrice: { path: '/uapi/overseas-price/v1/quotations/dailyprice', trId: 'HHDFS76240000' },
  askingPrice: { path: '/uapi/overseas-price/v1/quotations/inquire-asking-price', trId: 'HHDFS76200100' },
  fxRate: { path: '/uapi/overseas-price/v1/quotations/inquire-daily-chartprice', trId: 'FHKST03030100' },
  // Account inquiries — real-money tr_ids; the paper domain uses a `V` prefix.
  holdings: { path: '/uapi/overseas-stock/v1/trading/inquire-balance', trId: 'TTTS3012R' },
  balance: { path: '/uapi/overseas-stock/v1/trading/inquire-present-balance', trId: 'CTRP6504R' },
  executions: { path: '/uapi/overseas-stock/v1/trading/inquire-ccnl', trId: 'TTTS3035R' },
  realizedPnl: { path: '/uapi/overseas-stock/v1/trading/inquire-period-profit', trId: 'TTTS3039R' },
} as const satisfies Record<string, Endpoint>;

const ALLOWED_PATHS = new Set<string>(Object.values(ENDPOINTS).map((e) => e.path));

/**
 * Minimum gap between calls. A real-money account is metered per second, so
 * spacing requests is cheaper than discovering the ceiling under load.
 */
const DEFAULT_MIN_INTERVAL_MS = 60;

/** How many continuation pages one paged call will walk before giving up. */
const DEFAULT_MAX_PAGES = 20;

export interface KisClientOptions {
  baseUrl: string;
  appKey: string;
  appSecret: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
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

/** The namespace KIS serves both account inquiries and orders from. */
export const TRADING_NAMESPACE = '/uapi/overseas-stock/v1/trading/';

/** Reject anything that is not an allowlisted inquiry, before it leaves the process. */
function assertReadable(endpoint: Endpoint): void {
  if (!ALLOWED_PATHS.has(endpoint.path)) {
    throw new Error(`Refusing a KIS call outside the read allowlist: ${endpoint.path}`);
  }
  if (endpoint.path.startsWith(TRADING_NAMESPACE) && !endpoint.trId.endsWith('R')) {
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

    const response = await fetchImpl(url, {
      method: 'GET',
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
      const pages: Record<string, unknown>[] = [];
      let continuation = '';
      let fk200 = '';
      let nk200 = '';

      for (let page = 0; page < maxPages; page += 1) {
        const { body, trCont } = await request(
          endpoint,
          { ...params, CTX_AREA_FK200: fk200, CTX_AREA_NK200: nk200 },
          continuation,
        );
        pages.push(body);

        if (trCont !== 'F' && trCont !== 'M') break;

        fk200 = cursor(body, 'ctx_area_fk200');
        nk200 = cursor(body, 'ctx_area_nk200');
        continuation = 'N';
      }

      return pages;
    },
  };
}
