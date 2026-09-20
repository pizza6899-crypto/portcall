import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { ENDPOINTS, type KisClient } from './client.js';
import { COLUMNS, HISTORY_FLOOR, type HistoryStore, type Period } from './history.js';

/**
 * Read-only tools over KIS.
 *
 * Quotation tools need no account. The account tools are registered only when
 * an account number is configured, so a credentials-only host exposes prices
 * and nothing about a portfolio.
 *
 * None of them place, amend or cancel an order, and the client they call
 * rejects both non-allowlisted paths and non-inquiry tr_ids.
 */

export interface KisAccount {
  /** The eight-digit account number (`CANO`). */
  cano: string;
  /** The two-digit product code that follows it (`ACNT_PRDT_CD`). */
  productCode: string;
}

/** Exchange codes the quotation APIs accept for `EXCD`. */
const QUOTE_EXCHANGES = {
  NAS: '나스닥',
  NYS: '뉴욕',
  AMS: '아멕스',
  HKS: '홍콩',
  SHS: '상해',
  SZS: '심천',
  TSE: '도쿄',
  HNX: '하노이',
  HSX: '호치민',
} as const;

/**
 * Exchange codes the account APIs accept for `OVRS_EXCG_CD`.
 *
 * A different code set from the quotation one — `NAS` quotes Nasdaq, `NASD`
 * covers the whole US market on a real-money account. Mixing them up produces
 * an empty result rather than an error, so the two are kept apart here.
 */
const ACCOUNT_EXCHANGES = {
  NASD: '미국 전체',
  NYSE: '뉴욕',
  AMEX: '아멕스',
  SEHK: '홍콩',
  SHAA: '상해',
  SZAA: '심천',
  TKSE: '도쿄',
  HASE: '하노이',
  VNSE: '호치민',
} as const;

/** The settlement currency each account exchange trades in. */
const EXCHANGE_CURRENCY: Record<keyof typeof ACCOUNT_EXCHANGES, string> = {
  NASD: 'USD',
  NYSE: 'USD',
  AMEX: 'USD',
  SEHK: 'HKD',
  SHAA: 'CNY',
  SZAA: 'CNY',
  TKSE: 'JPY',
  HASE: 'VND',
  VNSE: 'VND',
};

function labelled(codes: Record<string, string>): string {
  return Object.entries(codes)
    .map(([code, label]) => `${code} (${label})`)
    .join(', ');
}

const quoteExchange = z
  .enum(Object.keys(QUOTE_EXCHANGES) as [string, ...string[]])
  .describe(`Exchange code: ${labelled(QUOTE_EXCHANGES)}`);

const accountExchange = z
  .enum(Object.keys(ACCOUNT_EXCHANGES) as [string, ...string[]])
  .describe(`Account exchange code: ${labelled(ACCOUNT_EXCHANGES)}`);

const symbol = z.string().min(1).describe('Ticker as listed on that exchange, e.g. AAPL, 0700');

const yyyymmdd = z.string().regex(/^\d{8}$/);

/**
 * KIS field names, in the order its documentation lists them.
 *
 * Values stay exactly as KIS sends them — strings. Coercing would quietly
 * mangle the fields that only look numeric (dates like `20260919`, codes with
 * leading zeros), and `decimals` already says how many places the venue
 * quotes to.
 */
const PRICE_FIELDS = {
  rsym: 'realtimeSymbol',
  zdiv: 'decimals',
  base: 'previousClose',
  pvol: 'previousVolume',
  last: 'last',
  sign: 'changeSign',
  diff: 'change',
  rate: 'changePercent',
  tvol: 'volume',
  tamt: 'turnover',
  ordy: 'orderable',
} as const;

const DETAIL_FIELDS = {
  rsym: 'realtimeSymbol',
  curr: 'currency',
  zdiv: 'decimals',
  last: 'last',
  base: 'previousClose',
  open: 'open',
  high: 'high',
  low: 'low',
  tvol: 'volume',
  tamt: 'turnover',
  pvol: 'previousVolume',
  pamt: 'previousTurnover',
  uplp: 'upperLimit',
  dnlp: 'lowerLimit',
  h52p: 'high52w',
  h52d: 'high52wDate',
  l52p: 'low52w',
  l52d: 'low52wDate',
  perx: 'per',
  pbrx: 'pbr',
  epsx: 'eps',
  bpsx: 'bps',
  shar: 'sharesOutstanding',
  mcap: 'capital',
  tomv: 'marketCap',
  vnit: 'tradingUnit',
} as const;

/**
 * `nrec` is how many rows came back, not a price — the published sample labels
 * it 전일종가, but it reads 100 on every call while exactly 100 bars arrive.
 * Mapping it as a close would hand a caller `previousClose: 100` for a stock
 * trading at 336.
 */
const DAILY_HEAD_FIELDS = { rsym: 'realtimeSymbol', zdiv: 'decimals', nrec: 'recordCount' } as const;

const DAILY_ROW_FIELDS = {
  xymd: 'date',
  clos: 'close',
  sign: 'changeSign',
  diff: 'change',
  rate: 'changePercent',
  open: 'open',
  high: 'high',
  low: 'low',
  tvol: 'volume',
  tamt: 'turnover',
  pbid: 'bid',
  vbid: 'bidSize',
  pask: 'ask',
  vask: 'askSize',
} as const;

/**
 * Currency pairs KIS quotes, with the direction each one is quoted in.
 *
 * The direction is not uniform and getting it wrong inverts every conversion:
 * most pairs are "how much of this currency buys one dollar", but EUR, GBP
 * and AUD follow the market convention of quoting dollars per unit. Both the
 * code list and the directions here were read off the live API.
 */
const CURRENCIES = {
  KRW: { label: '원/달러', perUsd: true },
  JPY: { label: '엔/달러', perUsd: true },
  HKD: { label: '홍콩달러/달러', perUsd: true },
  CNY: { label: '위안/달러', perUsd: true },
  VND: { label: '동/달러', perUsd: true },
  CAD: { label: '캐나다달러/달러', perUsd: true },
  CHF: { label: '프랑/달러', perUsd: true },
  SGD: { label: '싱가포르달러/달러', perUsd: true },
  TWD: { label: '대만달러/달러', perUsd: true },
  IDR: { label: '루피아/달러', perUsd: true },
  THB: { label: '바트/달러', perUsd: true },
  EUR: { label: '달러/유로', perUsd: false },
  GBP: { label: '달러/파운드', perUsd: false },
  AUD: { label: '달러/호주달러', perUsd: false },
} as const;

/** Overseas indices this endpoint serves. The leading dot is not a pattern — it is only on the Dow. */
const INDICES = {
  '.DJI': '다우존스 산업평균',
  COMP: '나스닥 종합',
  NDX: '나스닥 100',
  SPX: 'S&P 500',
} as const;

const FX_HEAD_FIELDS = {
  hts_kor_isnm: 'name',
  stck_shrn_iscd: 'code',
  ovrs_nmix_prpr: 'last',
  ovrs_nmix_prdy_clpr: 'previousClose',
  ovrs_nmix_prdy_vrss: 'change',
  prdy_vrss_sign: 'changeSign',
  prdy_ctrt: 'changePercent',
  ovrs_prod_oprc: 'open',
  ovrs_prod_hgpr: 'high',
  ovrs_prod_lwpr: 'low',
  acml_vol: 'volume',
} as const;

const FX_ROW_FIELDS = {
  stck_bsop_date: 'date',
  ovrs_nmix_prpr: 'close',
  ovrs_nmix_oprc: 'open',
  ovrs_nmix_hgpr: 'high',
  ovrs_nmix_lwpr: 'low',
  acml_vol: 'volume',
  mod_yn: 'modified',
} as const;

const BOOK_FIELDS = {
  rsym: 'realtimeSymbol',
  zdiv: 'decimals',
  curr: 'currency',
  base: 'previousClose',
  open: 'open',
  high: 'high',
  low: 'low',
  last: 'last',
  dymd: 'quoteDate',
  dhms: 'quoteTime',
  bvol: 'totalBidSize',
  avol: 'totalAskSize',
  bdvl: 'totalBidSizeChange',
  advl: 'totalAskSizeChange',
  code: 'symbol',
  // Percent change against `previousClose`, not a fifth set of prices. Checked
  // against the live API: with base 337.0000, open 337.9050 comes back as
  // ropen "+0.27" — (337.905 - 337) / 337, to two places. All four agree.
  ropen: 'openPercent',
  rhigh: 'highPercent',
  rlow: 'lowPercent',
  rclose: 'closePercent',
} as const;

/**
 * Pre- and post-session indicative figures, in KIS's `output3`.
 *
 * `iep` and `iev` are the standard indicative equilibrium price and volume.
 * The other five arrive blank whenever the venue is closed, which is the only
 * state they could be observed in here, so they keep KIS's own names rather
 * than being given invented ones.
 */
const BOOK_INDICATIVE_FIELDS = {
  iep: 'indicativePrice',
  iev: 'indicativeVolume',
} as const;

/** One rung of the ten-deep book. A side is omitted when it is not quoted. */
interface BookLevel {
  level: number;
  bid?: string | undefined;
  bidSize?: string | undefined;
  bidChange?: string | undefined;
  ask?: string | undefined;
  askSize?: string | undefined;
  askChange?: string | undefined;
}

function quoted(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // A price of zero is KIS saying "nothing here", not a resting order at zero.
  return trimmed === '' || Number(trimmed) === 0 ? undefined : trimmed;
}

function sized(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The ten-deep ladder KIS returns as flat `pbid1`…`dask10` keys.
 *
 * Outside session hours every rung comes back as a literal `0.0000` rather
 * than being left out, and ten rows of zero read as a real book priced at
 * zero. An unquoted rung is dropped instead, so an empty list means exactly
 * what it says.
 */
function ladder(source: unknown): BookLevel[] {
  if (typeof source !== 'object' || source === null) return [];
  const row = source as Record<string, unknown>;

  const levels: BookLevel[] = [];
  for (let level = 1; level <= 10; level += 1) {
    const bid = quoted(row[`pbid${level}`]);
    const ask = quoted(row[`pask${level}`]);
    if (bid === undefined && ask === undefined) continue;
    levels.push({
      level,
      ...(bid === undefined ? {} : { bid, bidSize: sized(row[`vbid${level}`]), bidChange: sized(row[`dbid${level}`]) }),
      ...(ask === undefined ? {} : { ask, askSize: sized(row[`vask${level}`]), askChange: sized(row[`dask${level}`]) }),
    });
  }
  return levels;
}

const BALANCE_POSITION_FIELDS = {
  pdno: 'symbol',
  prdt_name: 'name',
  ovrs_excg_cd: 'exchange',
  tr_mket_name: 'market',
  natn_kor_name: 'country',
  cblc_qty13: 'quantity',
  ord_psbl_qty1: 'sellableQuantity',
  avg_unpr3: 'averageCost',
  ovrs_now_pric1: 'last',
  frcr_pchs_amt: 'costAmount',
  frcr_evlu_amt2: 'marketValue',
  evlu_pfls_amt2: 'unrealizedPnl',
  evlu_pfls_rt1: 'unrealizedPnlPercent',
  buy_crcy_cd: 'currency',
  bass_exrt: 'fxRate',
  pchs_rmnd_wcrc_amt: 'costAmountKrw',
  thdt_buy_ccld_qty1: 'boughtToday',
  thdt_sll_ccld_qty1: 'soldToday',
  thdt_buy_ccld_frcr_amt: 'boughtTodayAmount',
  thdt_sll_ccld_frcr_amt: 'soldTodayAmount',
  ccld_qty_smtl1: 'filledQuantityTotal',
  loan_dt: 'loanDate',
  loan_expd_dt: 'loanMaturityDate',
  loan_rmnd: 'loanBalance',
  unit_amt: 'unitAmount',
  prdt_type_cd: 'productTypeCode',
  prdt_dvsn: 'productDivision',
  scts_dvsn_name: 'securityType',
  std_pdno: 'standardCode',
  item_lnkg_excg_cd: 'linkedExchange',
} as const;

const BALANCE_CURRENCY_FIELDS = {
  crcy_cd: 'currency',
  crcy_cd_name: 'currencyName',
  frcr_dncl_amt_2: 'cash',
  frcr_drwg_psbl_amt_1: 'withdrawable',
  nxdy_frcr_drwg_psbl_amt: 'withdrawableNextDay',
  frcr_evlu_amt2: 'marketValue',
  frcr_buy_amt_smtl: 'boughtTotal',
  frcr_sll_amt_smtl: 'soldTotal',
  frcr_buy_mgn_amt: 'buyMargin',
  frcr_etc_mgna: 'otherMargin',
  frst_bltn_exrt: 'fxRate',
  acpl_cstd_crcy_yn: 'localCustody',
} as const;

const BALANCE_TOTAL_FIELDS = {
  tot_asst_amt: 'totalAssets',
  dncl_amt: 'cash',
  tot_dncl_amt: 'cashTotal',
  wdrw_psbl_tot_amt: 'withdrawableTotal',
  frcr_use_psbl_amt: 'foreignCashAvailable',
  evlu_amt_smtl: 'marketValueTotal',
  evlu_amt_smtl_amt: 'marketValueTotalAmount',
  pchs_amt_smtl: 'costTotal',
  pchs_amt_smtl_amt: 'costTotalAmount',
  tot_evlu_pfls_amt: 'unrealizedPnl',
  evlu_pfls_amt_smtl: 'unrealizedPnlSum',
  evlu_erng_rt1: 'returnPercent',
  frcr_evlu_tota: 'foreignMarketValueTotal',
  tot_frcr_cblc_smtl: 'foreignBalanceTotal',
  buy_mgn_amt: 'buyMargin',
  etc_mgna: 'otherMargin',
  mgna_tota: 'marginTotal',
  cma_evlu_amt: 'cmaValue',
  tot_loan_amt: 'loanTotal',
  ustl_buy_amt_smtl: 'unsettledBuyTotal',
  ustl_sll_amt_smtl: 'unsettledSellTotal',
} as const;

const HOLDING_FIELDS = {
  ovrs_pdno: 'symbol',
  ovrs_item_name: 'name',
  ovrs_cblc_qty: 'quantity',
  ord_psbl_qty: 'sellableQuantity',
  pchs_avg_pric: 'averageCost',
  now_pric2: 'last',
  frcr_pchs_amt1: 'costAmount',
  ovrs_stck_evlu_amt: 'marketValue',
  frcr_evlu_pfls_amt: 'unrealizedPnl',
  evlu_pfls_rt: 'unrealizedPnlPercent',
  tr_crcy_cd: 'currency',
  ovrs_excg_cd: 'exchange',
  loan_type_cd: 'loanTypeCode',
  loan_dt: 'loanDate',
  expd_dt: 'maturityDate',
  prdt_type_cd: 'productTypeCode',
} as const;

const HOLDING_TOTAL_FIELDS = {
  frcr_pchs_amt1: 'costAmount',
  frcr_buy_amt_smtl1: 'buyAmountTotal',
  frcr_buy_amt_smtl2: 'buyAmountTotal2',
  ovrs_rlzt_pfls_amt: 'realizedPnl',
  ovrs_rlzt_pfls_amt2: 'realizedPnl2',
  ovrs_tot_pfls: 'totalPnl',
  rlzt_erng_rt: 'realizedReturnPercent',
  tot_evlu_pfls_amt: 'unrealizedPnl',
  tot_pftrt: 'totalReturnPercent',
} as const;

const EXECUTION_FIELDS = {
  ord_dt: 'orderDate',
  ord_tmd: 'orderTime',
  odno: 'orderNo',
  orgn_odno: 'originalOrderNo',
  pdno: 'symbol',
  prdt_name: 'name',
  sll_buy_dvsn_cd: 'sideCode',
  sll_buy_dvsn_cd_name: 'side',
  rvse_cncl_dvsn_name: 'amendOrCancel',
  ft_ord_qty: 'orderQuantity',
  ft_ord_unpr3: 'orderPrice',
  ft_ccld_qty: 'filledQuantity',
  ft_ccld_unpr3: 'filledPrice',
  ft_ccld_amt3: 'filledAmount',
  nccs_qty: 'unfilledQuantity',
  prcs_stat_name: 'status',
  rjct_rson_name: 'rejectReason',
  tr_mket_name: 'market',
  tr_crcy_cd: 'currency',
  tr_natn: 'countryCode',
  tr_natn_name: 'country',
  ovrs_excg_cd: 'exchange',
  ord_gno_brno: 'orderBranchNo',
  rjct_rson: 'rejectReasonCode',
  dmst_ord_dt: 'domesticOrderDate',
  thco_ord_tmd: 'firmOrderTime',
  mdia_dvsn_name: 'channel',
  splt_buy_attr_name: 'splitAttribute',
  usa_amk_exts_rqst_yn: 'usAfterMarketExtension',
  loan_type_cd: 'loanTypeCode',
  loan_dt: 'loanDate',
  rvse_cncl_dvsn: 'amendOrCancelCode',
} as const;

const PNL_ROW_FIELDS = {
  trad_day: 'tradeDate',
  ovrs_pdno: 'symbol',
  ovrs_item_name: 'name',
  slcl_qty: 'soldQuantity',
  pchs_avg_pric: 'averageCost',
  frcr_pchs_amt1: 'costAmount',
  avg_sll_unpr: 'averageSellPrice',
  frcr_sll_amt_smtl1: 'proceeds',
  stck_sll_tlex: 'sellCosts',
  ovrs_rlzt_pfls_amt: 'realizedPnl',
  pftrt: 'returnPercent',
  exrt: 'fxRate',
  // Arrives on the row as well as on the period totals, and was the one key
  // left untranslated in a payload where everything else had a plain name.
  frst_bltn_exrt: 'firstQuotedFxRate',
  ovrs_excg_cd: 'exchange',
} as const;

const PNL_TOTAL_FIELDS = {
  stck_sll_amt_smtl: 'proceedsTotal',
  stck_buy_amt_smtl: 'costTotal',
  smtl_fee1: 'feesTotal',
  excc_dfrm_amt: 'settledAmount',
  // Two spellings of the same period total. The published sample names only
  // the first; the live API sends the second, which is how the second was
  // found. Both map to one name deliberately — only one ever arrives, and if
  // that ever changes they carry the same figure.
  ovrs_rlzt_pfls_amt: 'realizedPnl',
  ovrs_rlzt_pfls_tot_amt: 'realizedPnl',
  tot_pftrt: 'totalReturnPercent',
  bass_dt: 'baseDate',
  frst_bltn_exrt: 'firstQuotedFxRate',
  exrt: 'fxRate',
} as const;

/**
 * One dividend as the rights calendar reports it.
 *
 * `alct_frcr_unpr` — 배정외화단가 — is the per-share amount, checked against a
 * year of SGOV distributions (0.34664, 0.34761, 0.31291 …, on a ~100 dollar
 * share) and against TQQQ and SOXL. The fields KIS names 주당배당금,
 * `stkp_dvdn_frcr_amt2`/`3`/`4`, read 0.00000 on every cash dividend seen,
 * and their currencies `crcy_cd2`/`3`/`4` come back empty; they appear to
 * belong to the multi-currency option a `74` (배당옵션) row carries. They are
 * left unmapped rather than given a name that would read as the amount,
 * because taking the documented one on trust is how this gets reported as
 * zero.
 *
 * `bass_dt` is the record date as KIS files it and `acpl_bass_dt` the one the
 * market itself keeps, a day earlier for the US. Both are kept: the local one
 * is what every other source prints, and it is what the calendar below joins on.
 */
const DIVIDEND_FIELDS = {
  pdno: 'symbol',
  std_pdno: 'standardSymbol',
  prdt_name: 'name',
  prdt_type_cd: 'marketCode',
  rght_type_cd: 'rightType',
  bass_dt: 'recordDate',
  acpl_bass_dt: 'localRecordDate',
  crcy_cd: 'currency',
  alct_frcr_unpr: 'perShare',
  cash_alct_rt: 'cashRatio',
  stck_alct_rt: 'stockRatio',
  sbsc_strt_dt: 'subscriptionStart',
  sbsc_end_dt: 'subscriptionEnd',
  dfnt_yn: 'confirmed',
} as const;

/**
 * The same event from ICE, which knows the dates but not the amount.
 *
 * Between them the two calls answer different halves of one question: how
 * much, and when it lands. Neither carries both.
 */
const CALENDAR_FIELDS = {
  ca_title: 'event',
  anno_dt: 'announcedDate',
  record_dt: 'recordDate',
  div_lock_dt: 'exDividendDate',
  pay_dt: 'payDate',
  lock_dt: 'exRightsDate',
  validity_dt: 'validityDate',
  effective_dt: 'effectiveDate',
  local_end_dt: 'localInstructionDeadline',
  delist_dt: 'delistDate',
  redempt_dt: 'redemptionDate',
  early_redempt_dt: 'earlyRedemptionDate',
} as const;

/** Rights types worth asking for by name. `%%` is KIS's own wildcard. */
const RIGHT_TYPES = { dividend: '03', all: '%%' } as const;

/** What ICE calls an ordinary cash dividend, as opposed to a split or a merger. */
const CASH_DIVIDEND = '현금배당';

/**
 * How far before the window the ICE calendar is asked to start.
 *
 * Its range filters on the announcement date, not the record date, and the
 * gap between the two is not small or steady: SGOV announces three weeks to
 * two months ahead, and TQQQ published four quarterly record dates — one of
 * them eleven months out — in a single announcement on 2026-01-20. Asked
 * with no range at all it answers ±3 months of announcements, which joined
 * one of twelve SGOV dividends; a year of lookback joined all twelve.
 *
 * The end needs no such margin: every event measured was announced on or
 * before its record date, so an upcoming dividend is already announced and
 * falls inside a window ending today.
 */
const CALENDAR_LOOKBACK_DAYS = 365;

/**
 * A date ICE knows only to the month, written with `00` for the day —
 * `20260100`, `20251200`. They arrive on rows whose record date is still
 * blank, as a placeholder until the real schedule is published, and they are
 * not dates: parsed, they are either invalid or quietly the wrong month.
 * They are marked rather than dropped, because "a dividend is expected in
 * December" is worth knowing.
 */
function monthOnly(value: unknown): boolean {
  return typeof value === 'string' && value.length === 8 && value.endsWith('00');
}

/** Flag a calendar row whose dates are placeholders rather than a schedule. */
function withPrecision(event: Record<string, unknown>): Record<string, unknown> {
  const rough = ['recordDate', 'exDividendDate', 'payDate'].some((key) => monthOnly(event[key]));
  return rough ? { ...event, approximate: true } : event;
}

/** Countries the ICE calendar is keyed by. */
const RIGHTS_COUNTRIES = { US: 'US', CN: 'CN', HK: 'HK', JP: 'JP', VN: 'VN' } as const;

/** How many symbols one call will walk. Each one costs two KIS requests. */
const MAX_DIVIDEND_SYMBOLS = 20;

/**
 * KIS reports `change` as an unsigned magnitude and puts the direction in a
 * separate one-character code, so the two have to be read together — a bare
 * `change: "0.87"` on a day the stock fell reads as a gain. This decodes it.
 */
const CHANGE_DIRECTION: Record<string, string> = {
  '1': 'upperLimit',
  '2': 'up',
  '3': 'flat',
  '4': 'lowerLimit',
  '5': 'down',
};

function withDirection(data: Record<string, unknown>): Record<string, unknown> {
  const sign = data['changeSign'];
  if (typeof sign !== 'string') return data;
  const direction = CHANGE_DIRECTION[sign.trim()];
  return direction === undefined ? data : { ...data, changeDirection: direction };
}

/** Rename the documented keys and pass anything else through untouched. */
function rename(
  source: unknown,
  fields: Record<string, string>,
  drop: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (typeof source !== 'object' || source === null) return {};
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (drop.has(key)) continue;
    renamed[fields[key] ?? key] = value;
  }
  return renamed;
}

function asRows(
  source: unknown,
  fields: Record<string, string>,
  drop?: ReadonlySet<string>,
): Record<string, unknown>[] {
  return Array.isArray(source) ? source.map((row) => rename(row, fields, drop)) : [];
}

/**
 * The account number KIS echoes back on every holding row. It is already
 * known to whoever configured the plugin, and repeating it in every response
 * only widens where it travels.
 */
const ACCOUNT_ECHO = new Set(['cano', 'acnt_prdt_cd']);

/** Flatten one output array across every continuation page. */
function collect(pages: Record<string, unknown>[], key: string, fields: Record<string, string>) {
  return pages.flatMap((page) => asRows(page[key], fields));
}

/** The last page carries the running totals, so later pages win. */
function lastObject(pages: Record<string, unknown>[], key: string, fields: Record<string, string>) {
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    const value = pages[i]?.[key];
    const source = Array.isArray(value) ? value[0] : value;
    if (typeof source === 'object' && source !== null) return rename(source, fields);
  }
  return {};
}

/**
 * Rows the chart endpoint returns in one call.
 *
 * Measured rather than documented: a request spanning nearly three years of
 * daily bars comes back with exactly 100, and a five-week one with 34.
 */
const CHART_PAGE_ROWS = 100;

/** The span a series of dated bars actually covers, against the span asked for. */
interface Coverage {
  covered?: { from: string; to: string };
  truncated: boolean;
}

/**
 * Work out whether KIS gave back the range that was requested.
 *
 * The chart endpoint caps a call at 100 rows and says nothing about having
 * done so — a request for 2024-01-01 to 2026-09-20 comes back as the hundred
 * most recent sessions, carrying the dates that were asked for. A reader then
 * concludes the series begins in April 2026. There is no continuation cursor
 * on this endpoint, so the honest move is to report what arrived and say how
 * to ask for the rest.
 */
function coverage(bars: readonly Record<string, unknown>[], from: string): Coverage {
  const dates = bars.map((bar) => bar['date']).filter((date): date is string => typeof date === 'string' && date !== '');
  if (dates.length === 0) return { truncated: false };

  const sorted = [...dates].sort();
  const covered = { from: sorted[0]!, to: sorted.at(-1)! };

  // A short series is KIS having nothing more, not KIS holding back. Only a
  // full page that stops short of the requested start was actually capped.
  // Comparing dates alone would flag nearly every call, because the first day
  // of a range is rarely a trading day — a range from a Saturday starts on the
  // Monday whether or not anything was cut.
  return { covered, truncated: bars.length >= CHART_PAGE_ROWS && covered.from > from };
}

/** The sentence appended to a summary when the range came back short. */
function shortfall(from: string, to: string, span: Coverage): string {
  if (!span.truncated || span.covered === undefined) return '';
  return ` — KIS capped this at ${span.covered.from}–${span.covered.to}; ${from}–${to} was asked for. Walk endDate backwards for the rest.`;
}

function result(summary: string, data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

/**
 * KIS dates are Korean business dates, so they are worked out in Seoul rather
 * than wherever this happens to run. The two are not always the same day:
 * this host sits at UTC+7, two hours behind, so between midnight and 02:00 in
 * Korea the local date is still yesterday — which is the middle of the US
 * session, exactly when a default of "today" matters.
 */
const SEOUL_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function stamp(date: Date): string {
  return SEOUL_DATE.format(date).replaceAll('-', '');
}

function today(): string {
  return stamp(new Date());
}

function startOfYear(): string {
  return `${today().slice(0, 4)}0101`;
}

function daysAgo(days: number): string {
  // Korea has no daylight saving, so a fixed day length is exact here.
  return stamp(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

/** The same shift, from a given YYYYMMDD rather than from today. */
function daysBefore(date: string, days: number): string {
  const at = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
  if (Number.isNaN(at)) return date;
  return new Date(at - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll('-', '');
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

function registerQuotationTools(server: McpServer, client: KisClient): void {
  server.registerTool(
    'overseas_quote',
    {
      title: 'Overseas quote',
      description:
        'Current traded price for one overseas-listed stock. Values come back as strings exactly as KIS sends them; `decimals` says how many decimal places the venue quotes to. Quotes are delayed unless the account is subscribed to real-time data.',
      inputSchema: z.object({ exchange: quoteExchange, symbol }),
      annotations: READ_ONLY,
    },
    async ({ exchange, symbol: symb }) => {
      const body = await client.get(ENDPOINTS.price, { AUTH: '', EXCD: exchange, SYMB: symb });
      const data = withDirection(rename(body['output'], PRICE_FIELDS));
      return result(
        `${symb} on ${exchange}: last ${String(data['last'] ?? '?')} (${String(data['changePercent'] ?? '?')}%)`,
        data,
      );
    },
  );

  server.registerTool(
    'overseas_quote_detail',
    {
      title: 'Overseas quote detail',
      description:
        'Fuller snapshot for one overseas-listed stock: open/high/low, 52-week range, PER/PBR/EPS/BPS, market cap, currency and trading unit.',
      inputSchema: z.object({ exchange: quoteExchange, symbol }),
      annotations: READ_ONLY,
    },
    async ({ exchange, symbol: symb }) => {
      const body = await client.get(ENDPOINTS.priceDetail, { AUTH: '', EXCD: exchange, SYMB: symb });
      const data = rename(body['output'], DETAIL_FIELDS);
      return result(
        `${symb} on ${exchange}: last ${String(data['last'] ?? '?')} ${String(data['currency'] ?? '')}, 52w ${String(data['low52w'] ?? '?')}–${String(data['high52w'] ?? '?')}`,
        data,
      );
    },
  );

  server.registerTool(
    'overseas_daily_prices',
    {
      title: 'Overseas daily prices',
      description:
        'Daily, weekly or monthly bars for one overseas-listed stock, newest first, ending at `endDate` (most recent session when omitted). KIS caps a call at 100 bars, so a longer history needs several calls walking `endDate` backwards.',
      inputSchema: z.object({
        exchange: quoteExchange,
        symbol,
        period: z.enum(['day', 'week', 'month']).default('day').describe('Bar size'),
        endDate: yyyymmdd.optional().describe('Last session to include, YYYYMMDD. Defaults to the most recent one.'),
        adjusted: z.boolean().default(true).describe('Adjust prices for splits and the like'),
      }),
      annotations: READ_ONLY,
    },
    async ({ exchange, symbol: symb, period, endDate, adjusted }) => {
      const body = await client.get(ENDPOINTS.dailyPrice, {
        AUTH: '',
        EXCD: exchange,
        SYMB: symb,
        GUBN: { day: '0', week: '1', month: '2' }[period],
        BYMD: endDate ?? '',
        MODP: adjusted ? '1' : '0',
      });
      const data = {
        ...rename(body['output1'], DAILY_HEAD_FIELDS),
        bars: asRows(body['output2'], DAILY_ROW_FIELDS).map(withDirection),
      };
      return result(`${symb} on ${exchange}: ${data.bars.length} ${period} bars`, data);
    },
  );

  server.registerTool(
    'overseas_orderbook',
    {
      title: 'Overseas order book',
      description:
        'The bid and ask ladder for one overseas-listed stock: up to ten levels a side with price, resting size and change, plus the session summary and total size on each side. Levels come back only while the venue is quoting, so an empty `levels` outside trading hours is the real answer rather than a failure.',
      inputSchema: z.object({ exchange: quoteExchange, symbol }),
      annotations: READ_ONLY,
    },
    async ({ exchange, symbol: symb }) => {
      const body = await client.get(ENDPOINTS.askingPrice, { AUTH: '', EXCD: exchange, SYMB: symb });
      const levels = ladder(body['output2']);
      const data: Record<string, unknown> = {
        ...rename(body['output1'], BOOK_FIELDS),
        levels,
        indicative: rename(body['output3'], BOOK_INDICATIVE_FIELDS),
      };

      const best = levels[0];
      const side = (price: string | undefined, size: string | undefined): string =>
        price === undefined ? '—' : size === undefined ? price : `${price} × ${size}`;
      const book =
        best === undefined
          ? 'no resting quotes (venue closed, or none at this depth)'
          : `bid ${side(best.bid, best.bidSize)} / ask ${side(best.ask, best.askSize)}, ${levels.length} level${levels.length === 1 ? '' : 's'}`;

      return result(`${symb} on ${exchange}: ${book}; last ${String(data['last'] ?? '?')}`, data);
    },
  );

  server.registerTool(
    'overseas_index',
    {
      title: 'Overseas index',
      description:
        'Daily, weekly, monthly or yearly history for a major overseas index, defaulting to the last 30 days. KIS caps a call at 100 bars, so a longer range comes back short — `covered` says which dates actually arrived and `truncated` flags it. Only these four indices are served by this endpoint; individual constituents come from `overseas_daily_prices` instead.',
      inputSchema: z.object({
        index: z
          .enum(Object.keys(INDICES) as [string, ...string[]])
          .default('SPX')
          .describe(
            `Index: ${Object.entries(INDICES)
              .map(([code, label]) => `${code} (${label})`)
              .join(', ')}`,
          ),
        period: z.enum(['day', 'week', 'month', 'year']).default('day').describe('Bar size'),
        startDate: yyyymmdd.optional().describe('First date, YYYYMMDD. Defaults to 30 days ago.'),
        endDate: yyyymmdd.optional().describe('Last date, YYYYMMDD. Defaults to today.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ index, period, startDate, endDate }) => {
      const from = startDate ?? daysAgo(30);
      const to = endDate ?? today();
      const body = await client.get(ENDPOINTS.fxRate, {
        FID_COND_MRKT_DIV_CODE: 'N',
        FID_INPUT_ISCD: index,
        FID_INPUT_DATE_1: from,
        FID_INPUT_DATE_2: to,
        FID_PERIOD_DIV_CODE: { day: 'D', week: 'W', month: 'M', year: 'Y' }[period],
      });
      const bars = asRows(body['output2'], FX_ROW_FIELDS).filter((row) => row['date'] !== undefined && row['date'] !== '');
      const head = withDirection(rename(body['output1'], FX_HEAD_FIELDS));
      const label = INDICES[index as keyof typeof INDICES];
      const span = coverage(bars, from);
      const data: Record<string, unknown> = { index, label, from, to, ...span, ...head, bars };
      return result(
        `${label}: ${String(head['last'] ?? '?')}, ${bars.length} ${period} bars${shortfall(from, to, span)}`,
        data,
      );
    },
  );

  server.registerTool(
    'fx_rate',
    {
      title: 'Exchange rate',
      description:
        'Daily, weekly, monthly or yearly exchange rate history for one currency against the US dollar, defaulting to the last 30 days. KIS caps a call at 100 bars, so a longer range comes back short — `covered` says which dates actually arrived and `truncated` flags it. `quotedAs` says which way round the pair is read: most are units of the currency per dollar, but EUR, GBP and AUD are dollars per unit. Rates are KIS\u0027s published quotes, not the rate any particular transaction settled at — for that, the FX rate on a realised trade is in `overseas_realized_pnl`.',
      inputSchema: z.object({
        currency: z
          .enum(Object.keys(CURRENCIES) as [string, ...string[]])
          .default('KRW')
          .describe(
            `Currency: ${Object.entries(CURRENCIES)
              .map(([code, { label }]) => `${code} (${label})`)
              .join(', ')}`,
          ),
        period: z.enum(['day', 'week', 'month', 'year']).default('day').describe('Bar size'),
        startDate: yyyymmdd.optional().describe('First date, YYYYMMDD. Defaults to 30 days ago.'),
        endDate: yyyymmdd.optional().describe('Last date, YYYYMMDD. Defaults to today.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ currency, period, startDate, endDate }) => {
      const from = startDate ?? daysAgo(30);
      const to = endDate ?? today();
      const body = await client.get(ENDPOINTS.fxRate, {
        FID_COND_MRKT_DIV_CODE: 'X',
        FID_INPUT_ISCD: `FX@${currency}`,
        FID_INPUT_DATE_1: from,
        FID_INPUT_DATE_2: to,
        FID_PERIOD_DIV_CODE: { day: 'D', week: 'W', month: 'M', year: 'Y' }[period],
      });

      const pair = CURRENCIES[currency as keyof typeof CURRENCIES];
      // KIS pads the series with blank entries; a row without a date is padding.
      const bars = asRows(body['output2'], FX_ROW_FIELDS).filter((row) => row['date'] !== undefined && row['date'] !== '');
      const head = withDirection(rename(body['output1'], FX_HEAD_FIELDS));
      const quotedAs = pair.perUsd ? `${currency} per USD` : `USD per ${currency}`;
      const span = coverage(bars, from);
      const data: Record<string, unknown> = { currency, quotedAs, from, to, ...span, ...head, bars };
      return result(
        `${currency}: ${String(head['last'] ?? '?')} (${quotedAs}), ${bars.length} ${period} bars${shortfall(from, to, span)}`,
        data,
      );
    },
  );

  server.registerTool(
    'overseas_dividends',
    {
      title: 'Overseas dividends',
      description:
        'Dividends declared on overseas stocks and ETFs: the per-share amount and record date from the rights calendar, joined where possible to the ex-dividend and payment dates ICE publishes. Give `symbols` for named holdings over the window, or omit it to sweep every overseas stock whose record date falls in it. Per symbol, `dividends` are the ones with an amount, `scheduled` are announced but not yet paid, and `unpriced` are dividends ICE reports inside the window that the amount feed has nothing for — the two sources do not always agree. Dates flagged `approximate` are known only to the month. This reports what was declared per share: it does not know what is held, so it multiplies nothing, and the withholding a payment arrives net of is in no KIS read API.',
      inputSchema: z.object({
        symbols: z
          .array(symbol)
          .max(MAX_DIVIDEND_SYMBOLS)
          .optional()
          .describe(`Up to ${MAX_DIVIDEND_SYMBOLS} tickers. Every overseas stock in the window when omitted.`),
        startDate: yyyymmdd.optional().describe('First record date, YYYYMMDD. Defaults to a year back.'),
        endDate: yyyymmdd.optional().describe('Last record date, YYYYMMDD. Defaults to today.'),
        type: z
          .enum(Object.keys(RIGHT_TYPES) as [keyof typeof RIGHT_TYPES])
          .default('dividend')
          .describe('`all` also returns splits, mergers and the rest, where the per-share amount is not populated.'),
        country: z
          .enum(Object.keys(RIGHTS_COUNTRIES) as [keyof typeof RIGHTS_COUNTRIES])
          .default('US')
          .describe('Which market the ex-dividend and payment dates are looked up in. Applies to every symbol asked for.'),
        calendar: z
          .boolean()
          .default(true)
          .describe('Look up the ex-dividend and payment dates. Ignored without `symbols`: ICE is queried one ticker at a time.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ symbols, startDate, endDate, type, country, calendar }) => {
      const from = startDate ?? daysAgo(365);
      const to = endDate ?? today();

      const declared = async (forSymbol: string) => {
        const pages = await client.getAll(ENDPOINTS.rights, {
          RGHT_TYPE_CD: RIGHT_TYPES[type],
          // Record date rather than a subscription window: a dividend has no
          // subscription, so `03` and `04` return nothing for one.
          INQR_DVSN_CD: '02',
          INQR_STRT_DT: from,
          INQR_END_DT: to,
          PDNO: forSymbol,
          PRDT_TYPE_CD: '',
        });
        return collect(pages, 'output', DIVIDEND_FIELDS);
      };

      if (symbols === undefined) {
        const rows = await declared('');
        return result(`${rows.length} declared between ${from} and ${to}`, { from, to, type, dividends: rows });
      }

      const holdings = [];
      for (const forSymbol of symbols) {
        const dividends = await declared(forSymbol);
        // The calendar is asked for a wider range than the amounts, because
        // its range is on the announcement date. See CALENDAR_LOOKBACK_DAYS.
        const all = calendar
          ? asRows(
              (await client.get(ENDPOINTS.rightsCalendar, {
                NCOD: RIGHTS_COUNTRIES[country],
                SYMB: forSymbol,
                ST_YMD: daysBefore(from, CALENDAR_LOOKBACK_DAYS),
                ED_YMD: to,
              }))['output1'],
              CALENDAR_FIELDS,
            )
          : [];
        // ICE files splits, mergers and ticker changes in the same list. A
        // stock split has no business in an answer about dividends.
        const events = (type === 'dividend' ? all.filter((event) => event['event'] === CASH_DIVIDEND) : all).map(
          withPrecision,
        );

        // The two calls agree on the local record date and on nothing else,
        // so that is the join. A miss leaves the dates off rather than
        // guessing at them.
        const matched = new Set<number>();
        const withDates = dividends.map((row) => {
          const index = events.findIndex(
            (event, at) =>
              !matched.has(at) && event['recordDate'] !== '' && event['recordDate'] === row['localRecordDate'],
          );
          if (index === -1) return row;
          matched.add(index);
          const event = events[index]!;
          return { ...row, exDividendDate: event['exDividendDate'], payDate: event['payDate'] };
        });

        // What is left over is three different things, and they are not
        // interchangeable.
        const horizon = to.slice(0, 6);
        const scheduled: Record<string, unknown>[] = [];
        const unpriced: Record<string, unknown>[] = [];

        for (const [at, event] of events.entries()) {
          if (matched.has(at)) continue;
          const on = typeof event['recordDate'] === 'string' ? event['recordDate'] : '';

          if (on === '') {
            // A placeholder, with only a month to go on. Once that month is
            // past the real schedule has been published and this row is the
            // superseded draft of a dividend already listed above — SOXL
            // carries three of them, all pointing at months gone by.
            const when = String(event['payDate'] ?? '') || String(event['exDividendDate'] ?? '');
            if (when !== '' && when.slice(0, 6) >= horizon) scheduled.push(event);
          } else if (on > to) {
            // Announced, not yet paid. The half the amounts cannot answer.
            scheduled.push(event);
          } else if (on >= from) {
            // Inside the window, and the amount feed did not return it. Not
            // an artefact — the two sources disagree, and ICE is the one with
            // more: it reports SOXL dividends in March and June that the
            // rights list has nothing for. Dropping these would quietly
            // understate a year's income, which is the failure this tool
            // exists to avoid, so they are surfaced without an amount rather
            // than left out.
            unpriced.push(event);
          }
          // Older than the window: only there because the calendar was
          // widened to catch the announcement. Not reported.
        }

        holdings.push({ symbol: forSymbol, dividends: withDates, scheduled, unpriced });
      }

      const total = holdings.reduce((sum, held) => sum + held.dividends.length, 0);
      return result(`${total} declared across ${symbols.length} symbols between ${from} and ${to}`, {
        from,
        to,
        type,
        symbols: holdings,
      });
    },
  );
}

/** Bars returned in one call unless the caller asks for more. */
const DEFAULT_HISTORY_BARS = 1200;

/** Hard ceiling. Nineteen years of daily bars is about 4,800. */
const MAX_HISTORY_BARS = 5000;

function registerHistoryTool(server: McpServer, history: HistoryStore): void {
  server.registerTool(
    'overseas_history',
    {
      title: 'Overseas price history',
      description:
        'A long price series for one overseas-listed stock or ETF, as CSV — for backtesting and anything else that needs more than a screenful of bars. KIS serves 100 bars a call with no cursor, so the series is assembled once, cached on disk and afterwards only extended, which makes a repeat request nearly free. `exchange` can be left out and the US venues are tried in turn: SOXL lists on AMS while SOXX, TQQQ and QQQM list on NAS, and the wrong one returns nothing rather than an error. History begins 2007-08-20 whatever the listing date. Bars are oldest first. For a whole span at low cost use `period` week or month; daily is capped per call and says when it clipped.',
      inputSchema: z.object({
        symbol,
        exchange: quoteExchange.optional().describe('Leave out to look the symbol up across the US venues.'),
        period: z.enum(['day', 'week', 'month']).default('day').describe('Bar size'),
        startDate: yyyymmdd.optional().describe(`First date, YYYYMMDD. Defaults to everything, back to ${HISTORY_FLOOR}.`),
        endDate: yyyymmdd.optional().describe('Last date, YYYYMMDD. Defaults to the most recent session.'),
        maxBars: z
          .number()
          .int()
          .min(1)
          .max(MAX_HISTORY_BARS)
          .optional()
          .describe(`Most bars to return, newest kept. Defaults to ${DEFAULT_HISTORY_BARS}.`),
      }),
      annotations: READ_ONLY,
    },
    async ({ symbol: symb, exchange, period, startDate, endDate, maxBars = DEFAULT_HISTORY_BARS }) => {
      const series = await history.get({
        symbol: symb,
        ...(exchange === undefined ? {} : { exchange }),
        period: period as Period,
        ...(startDate === undefined ? {} : { startDate }),
        ...(endDate === undefined ? {} : { endDate }),
      });

      const clipped = series.bars.length > maxBars;
      const rows = clipped ? series.bars.slice(-maxBars) : series.bars;

      const data: Record<string, unknown> = {
        symbol: series.symbol,
        exchange: series.exchange,
        period,
        columns: COLUMNS,
        count: rows.length,
        from: rows[0]?.[0],
        to: rows.at(-1)?.[0],
        truncated: clipped,
        ...(clipped ? { matched: series.bars.length } : {}),
        cachedFrom: series.cachedFrom,
        cachedTo: series.cachedTo,
        reachesFloor: series.complete,
        apiCalls: series.fetched,
      };

      const clip = clipped
        ? ` — clipped from ${series.bars.length} to the newest ${rows.length}; raise maxBars, narrow the range, or use a larger period.`
        : '';
      const source = series.fetched === 0 ? 'from cache' : `${series.fetched} call${series.fetched === 1 ? '' : 's'} to KIS`;

      // The CSV goes in the text block only. `result` renders the structured
      // payload into that same block, so carrying the bars in both would put
      // every byte on the wire twice.
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${series.symbol} on ${series.exchange}: ${rows.length} ${period} bars, ` +
              `${String(rows[0]?.[0] ?? '-')}–${String(rows.at(-1)?.[0] ?? '-')} (${source})${clip}\n\n` +
              `${COLUMNS}\n${rows.map((bar) => bar.join(',')).join('\n')}`,
          },
        ],
        structuredContent: data,
      };
    },
  );
}

function registerAccountTools(server: McpServer, client: KisClient, account: KisAccount): void {
  const identity = { CANO: account.cano, ACNT_PRDT_CD: account.productCode };

  server.registerTool(
    'overseas_holdings',
    {
      title: 'Overseas holdings',
      description:
        'Positions held in the configured overseas account on one exchange, with average cost, market value and unrealised P&L per position, plus account totals. One exchange per call: `NASD` covers the whole US market on a real-money account, so holdings elsewhere need their own call.',
      inputSchema: z.object({
        exchange: accountExchange.default('NASD'),
        currency: z
          .string()
          .optional()
          .describe('Settlement currency override, e.g. USD. Defaults to the currency of the exchange.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ exchange, currency }) => {
      const pages = await client.getAll(ENDPOINTS.holdings, {
        ...identity,
        OVRS_EXCG_CD: exchange,
        TR_CRCY_CD: currency ?? EXCHANGE_CURRENCY[exchange as keyof typeof ACCOUNT_EXCHANGES] ?? 'USD',
      });
      const data = {
        exchange,
        positions: pages.flatMap((page) => asRows(page['output1'], HOLDING_FIELDS, ACCOUNT_ECHO)),
        totals: lastObject(pages, 'output2', HOLDING_TOTAL_FIELDS),
      };
      return result(`${data.positions.length} positions on ${exchange}`, data);
    },
  );

  server.registerTool(
    'overseas_balance',
    {
      title: 'Overseas account balance',
      description:
        'The whole overseas account in one call: every position across every market, a cash and margin breakdown per currency, and account totals including cash, withdrawable cash and total assets. Amounts can be reported converted to won or in the traded currency. Use this for "what do I hold" and "how much cash is there"; `overseas_holdings` covers one exchange at a time and is only worth it for its per-exchange totals.',
      inputSchema: z.object({
        report: z
          .enum(['krw', 'foreign'])
          .default('krw')
          .describe('Report amounts converted to won, or in the traded currency'),
        country: z
          .enum(['all', 'us', 'hk', 'cn', 'jp', 'vn'])
          .default('all')
          .describe('Limit to one country'),
      }),
      annotations: READ_ONLY,
    },
    async ({ report, country }) => {
      const body = await client.get(ENDPOINTS.balance, {
        ...identity,
        // Note the flag is the other way round here than in
        // `overseas_realized_pnl`: this endpoint reads 01 as won, that one
        // reads 02 as won. Confirmed against the live API, not the docs.
        WCRC_FRCR_DVSN_CD: report === 'krw' ? '01' : '02',
        NATN_CD: { all: '000', us: '840', hk: '344', cn: '156', jp: '392', vn: '704' }[country],
        TR_MKET_CD: '00',
        INQR_DVSN_CD: '00',
      });

      const totalsSource = Array.isArray(body['output3']) ? body['output3'][0] : body['output3'];
      const data = {
        reportedIn: report,
        country,
        positions: asRows(body['output1'], BALANCE_POSITION_FIELDS, ACCOUNT_ECHO),
        currencies: asRows(body['output2'], BALANCE_CURRENCY_FIELDS),
        totals: rename(totalsSource, BALANCE_TOTAL_FIELDS),
      };
      return result(
        `${data.positions.length} positions, ${data.currencies.length} currencies, total assets ${String(data.totals['totalAssets'] ?? '?')}`,
        data,
      );
    },
  );

  server.registerTool(
    'overseas_executions',
    {
      title: 'Overseas executions',
      description:
        'Order and execution history for the configured overseas account over a date range, defaulting to this year so far. Dates are local to the market. Continuation pages are followed automatically.',
      inputSchema: z.object({
        startDate: yyyymmdd.optional().describe('First order date, YYYYMMDD. Defaults to 1 January this year.'),
        endDate: yyyymmdd.optional().describe('Last order date, YYYYMMDD. Defaults to today.'),
        symbol: z.string().optional().describe('One ticker. Every holding when omitted.'),
        exchange: accountExchange.optional().describe('One exchange. Every exchange when omitted.'),
        side: z.enum(['all', 'buy', 'sell']).default('all'),
        status: z.enum(['filled', 'unfilled', 'all']).default('filled'),
      }),
      annotations: READ_ONLY,
    },
    async ({ startDate, endDate, symbol: symb, exchange, side, status }) => {
      const from = startDate ?? startOfYear();
      const to = endDate ?? today();
      const pages = await client.getAll(ENDPOINTS.executions, {
        ...identity,
        PDNO: symb ?? '%',
        ORD_STRT_DT: from,
        ORD_END_DT: to,
        SLL_BUY_DVSN: { all: '00', sell: '01', buy: '02' }[side],
        CCLD_NCCS_DVSN: { all: '00', filled: '01', unfilled: '02' }[status],
        OVRS_EXCG_CD: exchange ?? '%',
        SORT_SQN: 'DS',
        ORD_DT: '',
        ORD_GNO_BRNO: '',
        ODNO: '',
      });
      const data = { from, to, executions: collect(pages, 'output', EXECUTION_FIELDS) };
      return result(`${data.executions.length} records between ${from} and ${to}`, data);
    },
  );

  server.registerTool(
    'overseas_realized_pnl',
    {
      title: 'Overseas realised P&L',
      description:
        'Realised profit and loss on closed overseas positions over a date range, defaulting to this year so far: per disposal (sold quantity, average cost, proceeds, costs, FX rate) plus totals. This is the trade-level record that a capital gains filing is built from, not a tax calculation — KIS exposes no tax API, and the filing figures come from its own year-end statement.',
      inputSchema: z.object({
        startDate: yyyymmdd.optional().describe('First trade date, YYYYMMDD. Defaults to 1 January this year.'),
        endDate: yyyymmdd.optional().describe('Last trade date, YYYYMMDD. Defaults to today.'),
        exchange: accountExchange.optional().describe('One exchange. Every exchange when omitted.'),
        symbol: z.string().optional().describe('One ticker. Every holding when omitted.'),
        report: z
          .enum(['krw', 'foreign'])
          .default('krw')
          .describe('Report amounts converted to won, or in the traded currency'),
      }),
      annotations: READ_ONLY,
    },
    async ({ startDate, endDate, exchange, symbol: symb, report }) => {
      const from = startDate ?? startOfYear();
      const to = endDate ?? today();
      const pages = await client.getAll(ENDPOINTS.realizedPnl, {
        ...identity,
        OVRS_EXCG_CD: exchange ?? '',
        NATN_CD: '',
        CRCY_CD: '',
        PDNO: symb ?? '',
        INQR_STRT_DT: from,
        INQR_END_DT: to,
        WCRC_FRCR_DVSN_CD: report === 'krw' ? '02' : '01',
      });
      const data = {
        from,
        to,
        reportedIn: report,
        disposals: collect(pages, 'output1', PNL_ROW_FIELDS),
        totals: lastObject(pages, 'output2', PNL_TOTAL_FIELDS),
      };
      return result(
        `${data.disposals.length} disposals between ${from} and ${to}, realised ${String(data.totals['realizedPnl'] ?? '?')}`,
        data,
      );
    },
  );
}

/** Register every tool the configuration allows. */
export function registerTools(
  server: McpServer,
  client: KisClient,
  account?: KisAccount,
  history?: HistoryStore,
): void {
  registerQuotationTools(server, client);
  if (history !== undefined) registerHistoryTool(server, history);
  if (account !== undefined) registerAccountTools(server, client, account);
}
