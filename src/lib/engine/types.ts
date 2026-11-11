/**
 * PULSEGRID 2.0 — shared engine types.
 */

export type Freshness = "LIVE" | "DELAYED" | "HISTORICAL" | "STALE" | "UNAVAILABLE";
export type Provider = "UPSTOX";

export interface Quality {
  provider: Provider;
  freshness: Freshness;
  exchangeTs: number; // epoch ms
  receiveTs: number; // epoch ms
}

export interface Candle {
  ts: number; // epoch ms (exchange ts, bucketed)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Quote {
  key: string;
  symbol: string;
  name: string;
  segment: "INDEX" | "EQUITY" | "FUT" | "OPT";
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  oi: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  vwap: number;
  chgPct: number;
  quality: Quality;
  sector?: string;
  lotSize: number;
  tickSize: number;
}

export interface OptionContractState {
  key: string;
  underlying: string;
  expiry: string; // ISO date
  strike: number;
  optionType: "CE" | "PE";
  instrumentKey: string;
  ltp: number;
  prevLtp: number;
  open: number;
  volume: number;
  oi: number;
  prevOi: number | null;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  iv: number; // modeled unless provider supplies
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  /** time-ordered observations (today's session), capped */
  obs: { ts: number; oi: number; ltp: number; volume: number }[];
  dayOpenOi: number | null; // session baseline (persisted)
  prevSessionOi: number | null; // valid pre-session reference, if any
}

export interface FuturesState {
  key: string;
  underlying: string;
  expiry: string;
  instrumentKey: string;
  ltp: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  oi: number;
  prevOi: number | null;
  vwap: number;
  obs: { ts: number; ltp: number; oi: number; volume: number }[];
  dayOpenOi: number | null;
  candles: Candle[];
}

export interface UnderlyingState {
  symbol: string;
  name: string;
  segment: "INDEX" | "EQUITY";
  sector: string;
  lotSize: number;
  tickSize: number;
  strikeInterval: number;
  ltp: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  avgDayVolume: number;
  vwap: number;
  candles1m: Candle[];
  dailyCandles: Candle[];
  /** same-time-of-day volumes of prior sessions for RVOL */
  priorSessionVolumes: number[];
  ticks: { ts: number; ltp: number; v: number }[];
  quality: Quality;
}

export const TIMEFRAMES = ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "1h", "1D"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export function tfMinutes(tf: Timeframe): number {
  switch (tf) {
    case "1m": return 1;
    case "2m": return 2;
    case "3m": return 3;
    case "5m": return 5;
    case "10m": return 10;
    case "15m": return 15;
    case "30m": return 30;
    case "1h": return 60;
    default: return 1440;
  }
}

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * PRIORITY 3 — exchange-aware session configuration (single source of truth).
 *
 * NSE equity-derivatives regular session was extended to 15:40 IST effective
 * 2026-08-03. Timings are expressed in IST minutes-of-day and evaluated via a
 * fixed UTC+5:30 shift, so they are independent of the server's local timezone.
 */
export interface SessionConfig {
  preOpenStart: number;
  preOpenEnd: number;
  regularStart: number;
  regularEnd: number;
  postCloseEnd: number;
}

const HM = (h: number, m: number) => h * 60 + m;

export const SESSIONS: Record<"NSE_FO" | "NSE_EQ" | "BSE_FO" | "BSE_EQ", SessionConfig> = {
  // NSE F&O: extended close 15:40 IST (effective 2026-08-03)
  NSE_FO: { preOpenStart: HM(9, 0), preOpenEnd: HM(9, 15), regularStart: HM(9, 15), regularEnd: HM(15, 40), postCloseEnd: HM(16, 0) },
  NSE_EQ: { preOpenStart: HM(9, 0), preOpenEnd: HM(9, 15), regularStart: HM(9, 15), regularEnd: HM(15, 30), postCloseEnd: HM(16, 0) },
  BSE_FO: { preOpenStart: HM(9, 0), preOpenEnd: HM(9, 15), regularStart: HM(9, 15), regularEnd: HM(15, 40), postCloseEnd: HM(16, 0) },
  BSE_EQ: { preOpenStart: HM(9, 0), preOpenEnd: HM(9, 15), regularStart: HM(9, 15), regularEnd: HM(15, 30), postCloseEnd: HM(16, 0) },
};

/** Derivatives session drives the app's primary market phase. */
export const PRIMARY_SEGMENT: keyof typeof SESSIONS = "NSE_FO";

export function nowIstParts(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  return {
    date: ist.toISOString().slice(0, 10),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    weekday: ist.getUTCDay(), // 0=Sun … 6=Sat, computed in IST
    istMs: now,
  };
}

export type MarketPhase = "PRE_OPEN" | "OPEN" | "POST_CLOSE" | "CLOSED" | "WEEKEND" | "HOLIDAY";

/**
 * Holiday calendar is injected by the data layer (Upstox /v2/market/holidays)
 * so session logic is never duplicated or hardcoded per file.
 */
const holidaySet = new Set<string>();
export function setExchangeHolidays(dates: string[]): void {
  holidaySet.clear();
  for (const d of dates) holidaySet.add(d);
}
export function isExchangeHoliday(date: string): boolean {
  return holidaySet.has(date);
}

export function marketPhase(now = Date.now(), segment: keyof typeof SESSIONS = PRIMARY_SEGMENT): MarketPhase {
  const { minutes, weekday, date } = nowIstParts(now);
  if (weekday === 0 || weekday === 6) return "WEEKEND";
  if (holidaySet.has(date)) return "HOLIDAY";
  const cfg = SESSIONS[segment];
  if (minutes < cfg.preOpenStart) return "CLOSED";
  if (minutes < cfg.preOpenEnd) return "PRE_OPEN";
  if (minutes <= cfg.regularEnd) return "OPEN";
  if (minutes <= cfg.postCloseEnd) return "POST_CLOSE";
  return "CLOSED";
}

export function isMarketOpen(now = Date.now(), segment: keyof typeof SESSIONS = PRIMARY_SEGMENT): boolean {
  return marketPhase(now, segment) === "OPEN";
}

export function sessionBounds(segment: keyof typeof SESSIONS = PRIMARY_SEGMENT): SessionConfig {
  return SESSIONS[segment];
}

/**
 * Session-aware freshness. An absent/invalid exchange timestamp is ALWAYS
 * UNAVAILABLE — it can never be promoted to LIVE.
 */
export function classifyFreshness(exchangeTs: number | null | undefined, now = Date.now()): Freshness {
  if (exchangeTs == null || !Number.isFinite(exchangeTs) || exchangeTs <= 0) return "UNAVAILABLE";
  const age = now - exchangeTs;
  if (age < 0 && age < -10 * 60_000) return "UNAVAILABLE"; // implausible future stamp
  if (marketPhase(now) !== "OPEN") return age < 20 * 3600_000 ? "HISTORICAL" : "STALE";
  if (age < 15_000) return "LIVE";
  if (age < 90_000) return "DELAYED";
  if (age < 20 * 60_000) return "STALE";
  return "HISTORICAL";
}

/** Only LIVE data may back a fresh actionable trade signal. */
export function isActionableFreshness(f: Freshness): boolean {
  return f === "LIVE";
}

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: dp, minimumFractionDigits: dp });
}

export function roundToTick(price: number, tick: number): number {
  return Math.round(price / tick) * tick;
}
