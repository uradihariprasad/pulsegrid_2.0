/**
 * PULSEGRID 2.0 — Upstox REST client (the ONLY market-data source).
 *
 * Documented endpoints used (docs.upstox.com):
 *   Instrument master : https://assets.upstox.com/market-quote/instruments/exchange/{NSE|BSE}.json.gz
 *   User profile      : GET /v2/user/profile
 *   Market holidays   : GET /v2/market/holidays
 *   Full market quote : GET /v2/market-quote/quotes?instrument_key=…        (≤500 keys)
 *   Option contracts  : GET /v2/option/contract?instrument_key=…
 *   Option chain      : GET /v2/option/chain?instrument_key=…&expiry_date=…
 *   Intraday candles  : GET /v3/historical-candle/intraday/{key}/{unit}/{interval}
 *   Historical candles: GET /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}
 *
 * There is NO synthetic fallback in this module. Every function returns either
 * real provider data or an explicit failure that the UI surfaces as UNAVAILABLE.
 */
import zlib from "node:zlib";
import { getUpstoxToken } from "./credentials";

const API = "https://api.upstox.com";
const ASSETS = "https://assets.upstox.com/market-quote/instruments/exchange";

/**
 * PRIORITY 1 — reliable exchange-timestamp parsing.
 *
 * Upstox returns `last_trade_time` either as an epoch-millisecond STRING
 * ("1740729552723") or as an ISO-8601 string ("2026-11-10T15:29:59+05:30").
 * Date.parse() silently fails on the numeric form, which previously produced
 * NaN and caused a fallback to server time — making stale data look LIVE.
 *
 * Returns null when the value is missing or cannot be trusted. Callers MUST
 * treat null as UNAVAILABLE and must never substitute the receive time.
 */
export function parseExchangeTs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return validTs(value);
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  // pure digits → epoch seconds / millis / micros
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (raw.length <= 10) return validTs(n * 1000);        // seconds
    if (raw.length <= 13) return validTs(n);               // milliseconds
    if (raw.length <= 16) return validTs(Math.floor(n / 1000));     // micros
    return validTs(Math.floor(n / 1_000_000));             // nanos
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? validTs(parsed) : null;
}

/** Reject timestamps outside a plausible window (clock/feed corruption). */
function validTs(ms: number): number | null {
  if (!Number.isFinite(ms)) return null;
  const now = Date.now();
  if (ms < Date.UTC(2015, 0, 1)) return null;   // absurdly old
  if (ms > now + 10 * 60_000) return null;      // more than 10m in the future
  return ms;
}

export class UpstoxError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = "UPSTOX_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------ rate limit */
/** Conservative client-side limiter (Upstox allows ~25 rps / 250 rpm). */
class RateLimiter {
  private times: number[] = [];
  constructor(private perSec = 8, private perMin = 180) {}
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.times = this.times.filter((t) => now - t < 60_000);
      const lastSec = this.times.filter((t) => now - t < 1_000).length;
      if (lastSec < this.perSec && this.times.length < this.perMin) {
        this.times.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, lastSec >= this.perSec ? 130 : 1_000));
    }
  }
}
const limiter = new RateLimiter();

export const apiStats = {
  calls: 0,
  errors: 0,
  lastError: null as string | null,
  lastErrorAt: 0,
  lastSuccessAt: 0,
  rateLimited: 0,
};

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getUpstoxToken();
  if (!token) throw new UpstoxError("No Upstox access token configured", 0, "NO_TOKEN");
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

async function call<T>(path: string, timeoutMs = 12_000, retries = 2): Promise<T> {
  const headers = await authHeaders();
  let lastErr: UpstoxError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter.acquire();
    try {
      apiStats.calls++;
      const res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      if (res.status === 429) {
        apiStats.rateLimited++;
        await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
        lastErr = new UpstoxError("Upstox rate limit hit", 429, "RATE_LIMIT");
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new UpstoxError("Upstox token invalid or expired", res.status, "AUTH");
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new UpstoxError(`Upstox ${res.status}: ${body.slice(0, 160)}`, res.status, "HTTP");
      }
      const json = (await res.json()) as T;
      apiStats.lastSuccessAt = Date.now();
      return json;
    } catch (e) {
      const err =
        e instanceof UpstoxError
          ? e
          : new UpstoxError((e as Error).name === "TimeoutError" ? "Upstox request timed out" : `Network error: ${(e as Error).message}`, 0, "NETWORK");
      if (err.code === "AUTH") {
        apiStats.errors++;
        apiStats.lastError = err.message;
        apiStats.lastErrorAt = Date.now();
        throw err;
      }
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  apiStats.errors++;
  apiStats.lastError = lastErr?.message ?? "unknown";
  apiStats.lastErrorAt = Date.now();
  throw lastErr ?? new UpstoxError("Upstox request failed");
}

/* ------------------------------------------------------ instrument master */
export interface RawInstrument {
  segment: string;
  name?: string;
  exchange?: string;
  expiry?: number;
  instrument_key: string;
  trading_symbol?: string;
  tradingsymbol?: string;
  tick_size?: number;
  lot_size?: number;
  instrument_type?: string;
  underlying_key?: string;
  underlying_symbol?: string;
  strike_price?: number;
  asset_symbol?: string;
  short_name?: string;
}

export interface OptionContractRef {
  instrumentKey: string;
  strike: number;
  type: "CE" | "PE";
  expiry: string;
}

export interface UnderlyingMeta {
  symbol: string;            // canonical display symbol (e.g. NIFTY, RELIANCE)
  name: string;
  spotKey: string;           // instrument_key of spot/index
  segment: "INDEX" | "EQUITY";
  exchange: "NSE" | "BSE";
  lotSize: number;
  tickSize: number;
  strikeInterval: number | null;
  expiries: string[];        // ascending ISO dates with option contracts
  futures: { instrumentKey: string; expiry: string; lotSize: number }[];
  optionCount: number;
}

function toIsoDate(ms: number): string {
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
}

async function fetchGz(url: string): Promise<RawInstrument[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000), cache: "no-store" });
  if (!res.ok) throw new UpstoxError(`Instrument master ${res.status} for ${url}`, res.status, "MASTER");
  const buf = Buffer.from(await res.arrayBuffer());
  // the endpoint serves gzip; some CDNs transparently decompress
  let text: string;
  if (buf[0] === 0x1f && buf[1] === 0x8b) text = zlib.gunzipSync(buf).toString("utf8");
  else text = buf.toString("utf8");
  return JSON.parse(text) as RawInstrument[];
}

/**
 * Build the complete F&O universe from the official instrument master.
 * Nothing is hardcoded: underlyings, expiries, strikes, lot sizes, tick sizes
 * and strike intervals are all derived from the provider file.
 */
export async function loadInstrumentMaster(): Promise<{
  underlyings: Map<string, UnderlyingMeta>;
  optionsByUnderlyingExpiry: Map<string, OptionContractRef[]>;
  loadedAt: number;
  rawCount: number;
}> {
  const sources = [`${ASSETS}/NSE.json.gz`, `${ASSETS}/BSE.json.gz`];
  const all: RawInstrument[] = [];
  for (const src of sources) {
    try {
      all.push(...(await fetchGz(src)));
    } catch {
      // one exchange failing must not kill the other
    }
  }
  if (!all.length) throw new UpstoxError("Could not download the Upstox instrument master", 0, "MASTER");

  const spotByKey = new Map<string, RawInstrument>();
  const derivatives: RawInstrument[] = [];
  for (const i of all) {
    const seg = i.segment ?? "";
    if (seg.endsWith("_EQ") || seg.endsWith("_INDEX")) spotByKey.set(i.instrument_key, i);
    else if (seg.endsWith("_FO")) derivatives.push(i);
  }

  const underlyings = new Map<string, UnderlyingMeta>();
  const optionsByUnderlyingExpiry = new Map<string, OptionContractRef[]>();
  const strikeSets = new Map<string, Set<number>>();
  const expirySets = new Map<string, Set<string>>();

  for (const d of derivatives) {
    const type = (d.instrument_type ?? "").toUpperCase();
    const isOpt = type === "CE" || type === "PE";
    const isFut = type === "FUT" || type === "FUTIDX" || type === "FUTSTK";
    if (!isOpt && !isFut) continue;
    const underKey = d.underlying_key;
    const symbol = (d.underlying_symbol || d.asset_symbol || d.name || "").toUpperCase().trim();
    if (!symbol || !underKey) continue;
    if (!d.expiry) continue;
    const expiry = toIsoDate(d.expiry);
    // skip already-expired contracts
    if (expiry < new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)) continue;

    let meta = underlyings.get(symbol);
    if (!meta) {
      const spot = spotByKey.get(underKey);
      const exchange: "NSE" | "BSE" = underKey.startsWith("BSE") ? "BSE" : "NSE";
      meta = {
        symbol,
        name: spot?.name || spot?.trading_symbol || symbol,
        spotKey: underKey,
        segment: underKey.includes("_INDEX") ? "INDEX" : "EQUITY",
        exchange,
        lotSize: d.lot_size ?? 0,
        tickSize: d.tick_size ? d.tick_size / 100 : 0.05,
        strikeInterval: null,
        expiries: [],
        futures: [],
        optionCount: 0,
      };
      underlyings.set(symbol, meta);
      strikeSets.set(symbol, new Set());
      expirySets.set(symbol, new Set());
    }
    if (d.lot_size) meta.lotSize = d.lot_size;

    if (isFut) {
      meta.futures.push({ instrumentKey: d.instrument_key, expiry, lotSize: d.lot_size ?? meta.lotSize });
    } else {
      meta.optionCount++;
      expirySets.get(symbol)!.add(expiry);
      const strike = d.strike_price ?? 0;
      if (strike > 0) strikeSets.get(symbol)!.add(strike);
      const mk = `${symbol}|${expiry}`;
      let list = optionsByUnderlyingExpiry.get(mk);
      if (!list) {
        list = [];
        optionsByUnderlyingExpiry.set(mk, list);
      }
      list.push({ instrumentKey: d.instrument_key, strike, type: type as "CE" | "PE", expiry });
    }
  }

  for (const [symbol, meta] of underlyings) {
    meta.expiries = [...(expirySets.get(symbol) ?? [])].sort();
    meta.futures.sort((a, b) => a.expiry.localeCompare(b.expiry));
    // strike interval = smallest positive gap between adjacent listed strikes
    const strikes = [...(strikeSets.get(symbol) ?? [])].sort((a, b) => a - b);
    let interval: number | null = null;
    for (let i = 1; i < strikes.length; i++) {
      const gap = Math.round((strikes[i] - strikes[i - 1]) * 100) / 100;
      if (gap > 0 && (interval == null || gap < interval)) interval = gap;
    }
    meta.strikeInterval = interval;
    // an F&O underlying must have at least options or futures
    if (meta.optionCount === 0 && meta.futures.length === 0) underlyings.delete(symbol);
  }

  return { underlyings, optionsByUnderlyingExpiry, loadedAt: Date.now(), rawCount: all.length };
}

/* ---------------------------------------------------------------- quotes */
export interface UpstoxQuote {
  instrumentKey: string;
  symbolKey: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;     // ohlc.close as returned by Upstox (session close once closed)
  prevClose: number; // derived from net_change — the true reference for % change
  volume: number;
  oi: number;
  avgPrice: number;
  netChange: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  depth: { bid: { price: number; qty: number }[]; ask: { price: number; qty: number }[] };
  /** Exchange event time. null when the provider did not supply a usable one. */
  exchangeTs: number | null;
  /** Server receive time — used for staleness of the *poll*, never for LIVE. */
  receiveTs: number;
}

interface RawQuote {
  instrument_token?: string;
  last_price?: number;
  volume?: number;
  average_price?: number;
  oi?: number;
  net_change?: number;
  last_trade_time?: string;
  timestamp?: string;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  depth?: { buy?: { price: number; quantity: number }[]; sell?: { price: number; quantity: number }[] };
}

/** Full market quote for up to 500 instrument keys (batched internally). */
export async function fetchQuotes(instrumentKeys: string[]): Promise<Map<string, UpstoxQuote>> {
  const out = new Map<string, UpstoxQuote>();
  const BATCH = 100; // keeps the URL well within limits
  for (let i = 0; i < instrumentKeys.length; i += BATCH) {
    const chunk = instrumentKeys.slice(i, i + BATCH);
    const url = `/v2/market-quote/quotes?instrument_key=${encodeURIComponent(chunk.join(","))}`;
    const json = await call<{ data?: Record<string, RawQuote> }>(url);
    const now = Date.now();
    for (const [symbolKey, q] of Object.entries(json.data ?? {})) {
      const key = q.instrument_token ?? symbolKey;
      const buy = q.depth?.buy ?? [];
      const sell = q.depth?.sell ?? [];
      // exchange timestamp is NEVER replaced by the receive time
      const exchangeTs = parseExchangeTs(q.last_trade_time) ?? parseExchangeTs(q.timestamp);
      const ltpVal = q.last_price ?? NaN;
      const netChg = q.net_change;
      // Upstox `ohlc.close` is the running/last session close, so the honest
      // previous-close reference is LTP − net_change when the provider gives it.
      const prevClose =
        netChg != null && Number.isFinite(netChg) && Number.isFinite(ltpVal) && netChg !== 0
          ? ltpVal - netChg
          : (q.ohlc?.close ?? NaN);
      out.set(key, {
        instrumentKey: key,
        symbolKey,
        ltp: q.last_price ?? NaN,
        open: q.ohlc?.open ?? NaN,
        high: q.ohlc?.high ?? NaN,
        low: q.ohlc?.low ?? NaN,
        close: q.ohlc?.close ?? NaN,
        prevClose,
        volume: q.volume ?? 0,
        oi: q.oi ?? 0,
        avgPrice: q.average_price ?? NaN,
        netChange: q.net_change ?? NaN,
        bid: buy[0]?.price ?? NaN,
        ask: sell[0]?.price ?? NaN,
        bidQty: buy[0]?.quantity ?? 0,
        askQty: sell[0]?.quantity ?? 0,
        depth: {
          bid: buy.map((b) => ({ price: b.price, qty: b.quantity })),
          ask: sell.map((s) => ({ price: s.price, qty: s.quantity })),
        },
        exchangeTs,          // null => UNAVAILABLE downstream
        receiveTs: now,
      });
    }
  }
  return out;
}

/* ----------------------------------------------------------- option chain */
export interface ChainRow {
  strike: number;
  expiry: string;
  underlyingSpot: number;
  pcr: number | null;
  ce: ChainLeg | null;
  pe: ChainLeg | null;
}
export interface ChainLeg {
  instrumentKey: string;
  ltp: number;
  volume: number;
  oi: number;
  prevOi: number | null;
  closePrice: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

interface RawLeg {
  instrument_key?: string;
  market_data?: {
    ltp?: number;
    volume?: number;
    oi?: number;
    close_price?: number;
    bid_price?: number;
    bid_qty?: number;
    ask_price?: number;
    ask_qty?: number;
    prev_oi?: number;
  };
  option_greeks?: { iv?: number; delta?: number; gamma?: number; theta?: number; vega?: number };
}

function leg(raw: RawLeg | undefined): ChainLeg | null {
  if (!raw?.instrument_key) return null;
  const m = raw.market_data ?? {};
  const g = raw.option_greeks ?? {};
  return {
    instrumentKey: raw.instrument_key,
    ltp: m.ltp ?? NaN,
    volume: m.volume ?? 0,
    oi: m.oi ?? 0,
    prevOi: m.prev_oi == null ? null : m.prev_oi,
    closePrice: m.close_price ?? NaN,
    bid: m.bid_price ?? NaN,
    ask: m.ask_price ?? NaN,
    bidQty: m.bid_qty ?? 0,
    askQty: m.ask_qty ?? 0,
    iv: g.iv == null ? null : g.iv,
    delta: g.delta == null ? null : g.delta,
    gamma: g.gamma == null ? null : g.gamma,
    theta: g.theta == null ? null : g.theta,
    vega: g.vega == null ? null : g.vega,
  };
}

/** Live option chain for an underlying + expiry. Greeks are provider-supplied. */
export async function fetchOptionChain(spotKey: string, expiry: string): Promise<{ rows: ChainRow[]; spot: number; fetchedAt: number }> {
  const url = `/v2/option/chain?instrument_key=${encodeURIComponent(spotKey)}&expiry_date=${expiry}`;
  const json = await call<{
    data?: { expiry: string; pcr?: number; strike_price: number; underlying_spot_price: number; call_options?: RawLeg; put_options?: RawLeg }[];
  }>(url);
  const rows: ChainRow[] = (json.data ?? []).map((d) => ({
    strike: d.strike_price,
    expiry: d.expiry,
    underlyingSpot: d.underlying_spot_price,
    pcr: d.pcr ?? null,
    ce: leg(d.call_options),
    pe: leg(d.put_options),
  }));
  rows.sort((a, b) => a.strike - b.strike);
  return { rows, spot: rows[0]?.underlyingSpot ?? NaN, fetchedAt: Date.now() };
}

/** Expiry list for an underlying, straight from the provider. */
export async function fetchOptionExpiries(spotKey: string): Promise<string[]> {
  const json = await call<{ data?: { expiry?: string }[] }>(`/v2/option/contract?instrument_key=${encodeURIComponent(spotKey)}`);
  const set = new Set<string>();
  for (const d of json.data ?? []) if (d.expiry) set.add(d.expiry);
  return [...set].sort();
}

/* --------------------------------------------------------------- candles */
export interface RawCandle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  oi: number;
}

function parseCandles(arr: unknown[][]): RawCandle[] {
  const out: RawCandle[] = [];
  for (const c of arr) {
    const ts = typeof c[0] === "string" ? Date.parse(c[0] as string) : Number(c[0]);
    if (!Number.isFinite(ts)) continue;
    out.push({
      ts,
      o: Number(c[1]),
      h: Number(c[2]),
      l: Number(c[3]),
      c: Number(c[4]),
      v: Number(c[5] ?? 0),
      oi: Number(c[6] ?? 0),
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Today's intraday candles (V3). unit: minutes|hours|days */
export async function fetchIntradayCandles(instrumentKey: string, unit: "minutes" | "hours" | "days", interval: number): Promise<RawCandle[]> {
  const url = `/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${interval}`;
  const json = await call<{ data?: { candles?: unknown[][] } }>(url);
  return parseCandles(json.data?.candles ?? []);
}

/** Historical candles (V3) between two ISO dates inclusive. */
export async function fetchHistoricalCandles(
  instrumentKey: string,
  unit: "minutes" | "hours" | "days" | "weeks",
  interval: number,
  fromDate: string,
  toDate: string,
): Promise<RawCandle[]> {
  const url = `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${toDate}/${fromDate}`;
  const json = await call<{ data?: { candles?: unknown[][] } }>(url);
  return parseCandles(json.data?.candles ?? []);
}

/* -------------------------------------------------------- market status */
export interface HolidayInfo {
  date: string;
  description: string;
  closedExchanges: string[];
}

export async function fetchHolidays(): Promise<HolidayInfo[]> {
  try {
    const json = await call<{ data?: { date: string; description: string; closed_exchanges?: string[] }[] }>("/v2/market/holidays");
    return (json.data ?? []).map((h) => ({ date: h.date, description: h.description, closedExchanges: h.closed_exchanges ?? [] }));
  } catch {
    return [];
  }
}

/** Market Data Feed V3 authorize → returns the wss redirect URI. */
export async function authorizeMarketFeed(): Promise<string | null> {
  try {
    const json = await call<{ data?: { authorized_redirect_uri?: string; authorizedRedirectUri?: string } }>(
      "/v3/feed/market-data-feed/authorize",
      10_000,
      1,
    );
    return json.data?.authorized_redirect_uri ?? json.data?.authorizedRedirectUri ?? null;
  } catch {
    return null;
  }
}

export async function fetchProfile(): Promise<{ userName: string } | null> {
  try {
    const json = await call<{ data?: { user_name?: string; email?: string } }>("/v2/user/profile", 8_000, 0);
    return { userName: json.data?.user_name ?? json.data?.email ?? "Upstox account" };
  } catch {
    return null;
  }
}
