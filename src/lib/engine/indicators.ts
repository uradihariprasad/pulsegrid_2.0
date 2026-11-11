import type { Candle } from "./types";

/** ------------------------------------------------------------------ EMA */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function emaLast(values: number[], period: number): number | null {
  const e = ema(values, period);
  return e[e.length - 1];
}

/** ------------------------------------------------------------------ RSI */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period,
    avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

/** ------------------------------------------------------------------ ATR */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    sum += Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  }
  return sum / period;
}

/** ----------------------------------------------------- session VWAP */
export function sessionVwap(candles: Candle[]): number | null {
  let pv = 0,
    vv = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v;
    vv += c.v;
  }
  return vv > 0 ? pv / vv : null;
}

/** VWAP + standard-deviation bands from intraday candles. */
export function vwapBands(candles: Candle[]): { vwap: number; up1: number; dn1: number; up2: number; dn2: number } | null {
  let pv = 0,
    vv = 0;
  const rows: { tp: number; v: number }[] = [];
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    rows.push({ tp, v: c.v });
    pv += tp * c.v;
    vv += c.v;
  }
  if (vv <= 0) return null;
  const vwap = pv / vv;
  let varSum = 0;
  for (const r of rows) varSum += r.v * (r.tp - vwap) ** 2;
  const sd = Math.sqrt(varSum / vv);
  return { vwap, up1: vwap + sd, dn1: vwap - sd, up2: vwap + 2 * sd, dn2: vwap - 2 * sd };
}

/** --------------------------------------------------- Bollinger Bands */
export function bollinger(closes: number[], period = 20, mult = 2): { mid: number[]; up: number[]; dn: number[] } {
  const mid: number[] = new Array(closes.length).fill(NaN);
  const up: number[] = new Array(closes.length).fill(NaN);
  const dn: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += closes[j];
    const mean = s / period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(v / period);
    mid[i] = mean;
    up[i] = mean + mult * sd;
    dn[i] = mean - mult * sd;
  }
  return { mid, up, dn };
}

/** --------------------------------------------------- Swing detection */
export interface Swing {
  idx: number;
  ts: number;
  price: number;
  kind: "HIGH" | "LOW";
}

export function detectSwings(candles: Candle[], lr = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = lr; i < candles.length - lr; i++) {
    const h = candles[i].h;
    const l = candles[i].l;
    let isH = true,
      isL = true;
    for (let j = i - lr; j <= i + lr; j++) {
      if (j === i) continue;
      if (candles[j].h > h) isH = false;
      if (candles[j].l < l) isL = false;
    }
    if (isH) out.push({ idx: i, ts: candles[i].ts, price: h, kind: "HIGH" });
    if (isL) out.push({ idx: i, ts: candles[i].ts, price: l, kind: "LOW" });
  }
  return out;
}

const IST_OFFSET = (5 * 60 + 30) * 60 * 1000;

/**
 * Aggregate 1-minute candles into a larger timeframe.
 *
 * Buckets are aligned to the IST calendar day, so bars line up with the
 * 09:15 session start and a bucket can never straddle the overnight gap in a
 * multi-session series.
 */
export function aggregateCandles(c1m: Candle[], minutes: number): Candle[] {
  if (minutes <= 1) return c1m.slice();
  const bucketMs = minutes * 60_000;
  const map = new Map<number, Candle>();
  for (const c of c1m) {
    const b = Math.floor((c.ts + IST_OFFSET) / bucketMs) * bucketMs - IST_OFFSET;
    const ex = map.get(b);
    if (!ex) map.set(b, { ts: b, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
    else {
      ex.h = Math.max(ex.h, c.h);
      ex.l = Math.min(ex.l, c.l);
      ex.c = c.c;
      ex.v += c.v;
    }
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

export function pctChange(a: number, b: number): number {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

/**
 * Real same-time-of-day RVOL: today's elapsed-session volume compared with
 * the mean of equivalent elapsed intervals from previous valid sessions.
 */
export function rvolSameTimeOfDay(todayElapsedVol: number, priorSameTimeVols: number[]): number | null {
  if (!priorSameTimeVols.length) return null;
  const avg = priorSameTimeVols.reduce((s, v) => s + v, 0) / priorSessionVolumesGuard(priorSameTimeVols);
  if (avg <= 0) return null;
  return todayElapsedVol / avg;
}

function priorSessionVolumesGuard(vols: number[]): number {
  return Math.max(vols.length, 1);
}

/** Clamp helper */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Logistic squash to (-1, 1) for normalized components. */
export function squash(x: number): number {
  return Math.tanh(x);
}

/** Black–Scholes-style normal CDF approximation (Abramowitz–Stegun). */
export function normCdf(x: number): number {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

/** Black–Scholes greeks + price, used for transparent modelled values. */
export function bsOption(
  spot: number,
  strike: number,
  tYears: number,
  iv: number,
  opt: "CE" | "PE",
  r = 0.065,
): { price: number; delta: number; gamma: number; theta: number; vega: number } {
  const t = Math.max(tYears, 1 / 365 / 24);
  const sig = Math.max(iv, 0.05);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * sig * sig) * t) / (sig * Math.sqrt(t));
  const d2 = d1 - sig * Math.sqrt(t);
  const pdf = Math.exp(-(d1 * d1) / 2) / Math.sqrt(2 * Math.PI);
  const price =
    opt === "CE"
      ? spot * normCdf(d1) - strike * Math.exp(-r * t) * normCdf(d2)
      : strike * Math.exp(-r * t) * normCdf(-d2) - spot * normCdf(-d1);
  const delta = opt === "CE" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf / (spot * sig * Math.sqrt(t));
  const theta =
    (-(spot * pdf * sig) / (2 * Math.sqrt(t)) -
      (opt === "CE" ? r * strike * Math.exp(-r * t) * normCdf(d2) : -r * strike * Math.exp(-r * t) * normCdf(-d2))) /
    365;
  const vega = (spot * pdf * Math.sqrt(t)) / 100;
  return { price: Math.max(price, 0.05), delta, gamma, theta, vega };
}
