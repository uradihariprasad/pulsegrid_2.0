/**
 * PULSEGRID 2.0 — Market Structure + Volume Profile engines.
 * Confirmed pivots only (never repaints confirmed historical structure).
 */
import type { Candle } from "./types";
import { detectSwings, type Swing } from "./indicators";

export interface StructureEvent {
  ts: number;
  kind:
    | "HH"
    | "HL"
    | "LH"
    | "LL"
    | "BOS_UP"
    | "BOS_DOWN"
    | "CHOCH_UP"
    | "CHOCH_DOWN"
    | "BREAKOUT"
    | "BREAKDOWN"
    | "FAILED_BREAKOUT"
    | "FAILED_BREAKDOWN"
    | "RETEST";
  price: number;
}

export interface StructureAnalysis {
  swings: Swing[];
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  prevSwingHigh: number | null;
  prevSwingLow: number | null;
  trend: "UP" | "DOWN" | "RANGE";
  events: StructureEvent[];
  equalHighs: number[];
  equalLows: number[];
  rangeHigh: number | null;
  rangeLow: number | null;
  consolidating: boolean;
}

export function analyzeStructure(candles: Candle[], equalTolPct = 0.08): StructureAnalysis {
  const swings = detectSwings(candles, 3);
  const highs = swings.filter((s) => s.kind === "HIGH");
  const lows = swings.filter((s) => s.kind === "LOW");
  const events: StructureEvent[] = [];

  let trend: "UP" | "DOWN" | "RANGE" = "RANGE";
  let lastSwingHigh: number | null = null;
  let lastSwingLow: number | null = null;
  let prevSwingHigh: number | null = null;
  let prevSwingLow: number | null = null;

  const seq: Swing[] = swings.slice(-40);
  for (let i = 1; i < seq.length; i++) {
    const cur = seq[i];
    const prevSame = seq.slice(0, i).filter((s) => s.kind === cur.kind).pop();
    if (!prevSame) continue;
    if (cur.kind === "HIGH") {
      const isHH = cur.price > (prevSwingHigh ?? prevSame.price);
      events.push({ ts: cur.ts, kind: isHH ? "HH" : "LH", price: cur.price });
      prevSwingHigh = prevSame.price;
      lastSwingHigh = cur.price;
    } else {
      const isHL = cur.price > (prevSwingLow ?? prevSame.price);
      events.push({ ts: cur.ts, kind: isHL ? "HL" : "LL", price: cur.price });
      prevSwingLow = prevSame.price;
      lastSwingLow = cur.price;
    }
  }

  // Determine structural trend from confirmed pivots FIRST so BOS/CHoCH can
  // use it for labelling without repainting.
  const recentEvents0 = events.slice(-8);
  const hh0 = recentEvents0.filter((e) => e.kind === "HH").length;
  const hl0 = recentEvents0.filter((e) => e.kind === "HL").length;
  const lh0 = recentEvents0.filter((e) => e.kind === "LH").length;
  const ll0 = recentEvents0.filter((e) => e.kind === "LL").length;
  if (hh0 + hl0 >= lh0 + ll0 + 2) trend = "UP";
  else if (lh0 + ll0 >= hh0 + hl0 + 2) trend = "DOWN";
  else trend = "RANGE";
  const priorTrend: "UP" | "DOWN" | "RANGE" = trend;

  // BOS / CHoCH on closes crossing confirmed swing points
  const sh = highs.slice(-6).map((s) => s.price);
  const sl = lows.slice(-6).map((s) => s.price);
  const lastSH = sh.length ? sh[sh.length - 1] : null;
  const lastSL = sl.length ? sl[sl.length - 1] : null;
  const n = candles.length;
  for (let i = Math.max(0, n - 120); i < n; i++) {
    const c = candles[i];
    if (lastSH != null && c.c > lastSH) {
      const dup = events.find((e) => (e.kind === "BOS_UP" || e.kind === "CHOCH_UP") && Math.abs(e.price - lastSH) < 1e-9);
      if (!dup) events.push({ ts: c.ts, kind: priorTrend === "DOWN" ? "CHOCH_UP" : "BOS_UP", price: lastSH });
    }
    if (lastSL != null && c.c < lastSL) {
      const dup = events.find((e) => (e.kind === "BOS_DOWN" || e.kind === "CHOCH_DOWN") && Math.abs(e.price - lastSL) < 1e-9);
      if (!dup) events.push({ ts: c.ts, kind: priorTrend === "UP" ? "CHOCH_DOWN" : "BOS_DOWN", price: lastSL });
    }
  }

  // equal highs / lows (liquidity pools)
  const tol = ((candles[candles.length - 1]?.c ?? 1) * equalTolPct) / 100;
  const equalHighs: number[] = [];
  const equalLows: number[] = [];
  const rh = highs.slice(-12);
  for (let i = 0; i < rh.length; i++)
    for (let j = i + 1; j < rh.length; j++)
      if (Math.abs(rh[i].price - rh[j].price) <= tol) equalHighs.push((rh[i].price + rh[j].price) / 2);
  const rl = lows.slice(-12);
  for (let i = 0; i < rl.length; i++)
    for (let j = i + 1; j < rl.length; j++)
      if (Math.abs(rl[i].price - rl[j].price) <= tol) equalLows.push((rl[i].price + rl[j].price) / 2);

  // consolidation: last 30 bars inside 0.5 * ATR-ish envelope of range
  const win = candles.slice(-30);
  const rangeHigh = win.length ? Math.max(...win.map((c) => c.h)) : null;
  const rangeLow = win.length ? Math.min(...win.map((c) => c.l)) : null;
  const lastPx = candles[candles.length - 1]?.c ?? 0;
  const consolidating =
    rangeHigh != null && rangeLow != null && lastPx > 0 ? (rangeHigh - rangeLow) / lastPx < 0.004 : false;

  const highsPrices = highs.map((s) => s.price);
  const lowsPrices = lows.map((s) => s.price);
  return {
    swings,
    lastSwingHigh: highsPrices.length ? highsPrices[highsPrices.length - 1] : null,
    lastSwingLow: lowsPrices.length ? lowsPrices[lowsPrices.length - 1] : null,
    prevSwingHigh: highsPrices.length > 1 ? highsPrices[highsPrices.length - 2] : null,
    prevSwingLow: lowsPrices.length > 1 ? lowsPrices[lowsPrices.length - 2] : null,
    trend,
    events: events.slice(-60),
    equalHighs: [...new Set(equalHighs.map((v) => Math.round(v * 100) / 100))],
    equalLows: [...new Set(equalLows.map((v) => Math.round(v * 100) / 100))],
    rangeHigh,
    rangeLow,
    consolidating,
  };
}

// ---------------------------------------------------------------------------
// Volume Profile (approximation from candle volume-at-typical-price bins;
// labelled as approximation — true tick-level volume-at-price is not assumed).
// ---------------------------------------------------------------------------
export type ProfileSource = "SPOT_TRADED" | "FUTURES_DERIVED_SPOT_MAPPED";

export interface ProfileMeta {
  /** where the VOLUME came from (price scale is always the spot scale) */
  source: ProfileSource;
  /** futures contract used when source is FUTURES_DERIVED_SPOT_MAPPED */
  sourceInstrumentKey: string | null;
  sourceExpiry: string | null;
  sourceSymbol: string | null;
  sessionDate: string | null;
  /** mean basis (futures − spot) applied when mapping, for transparency */
  basis: number | null;
  /** candles whose basis could be timestamp-aligned */
  mappedCandles: number;
}

export interface VolumeProfileResult extends Partial<ProfileMeta> {
  poc: number;
  vah: number;
  val: number;
  hvn: number[];
  lvn: number[];
  bins: { price: number; vol: number }[];
  binSize: number;
  totalVolume: number;
  valueAreaPct: number;
  calculatedAt: number;
  /** OHLCV-derived volume-at-price is an approximation, never tick-level */
  approximated: true;
}

/**
 * Volume profile from OHLCV candles.
 *
 * `candles` must already be expressed in the TARGET price scale. For indices
 * the caller passes spot-mapped futures candles (futures volume, spot prices);
 * for equities it passes the instrument's own traded candles.
 */
export function volumeProfile(candles: Candle[], binCount = 40, meta?: Partial<ProfileMeta>): VolumeProfileResult | null {
  if (candles.length < 10) return null;
  const lo = Math.min(...candles.map((c) => c.l));
  const hi = Math.max(...candles.map((c) => c.h));
  if (hi <= lo) return null;
  const step = (hi - lo) / binCount;
  const vols = new Array<number>(binCount).fill(0);
  for (const c of candles) {
    // distribute bar volume uniformly across its traded range
    const b0 = Math.max(0, Math.floor((c.l - lo) / step));
    const b1 = Math.min(binCount - 1, Math.floor((c.h - lo) / step));
    const span = Math.max(1, b1 - b0 + 1);
    for (let b = b0; b <= b1; b++) vols[b] += c.v / span;
  }
  const bins = vols.map((vol, i) => ({ price: lo + (i + 0.5) * step, vol }));
  const total = vols.reduce((s, v) => s + v, 0);
  if (total <= 0) return null;
  const pocIdx = vols.indexOf(Math.max(...vols));
  // value area: expand from POC until 70% of volume covered
  let vahI = pocIdx,
    valI = pocIdx,
    covered = vols[pocIdx];
  while (covered < 0.7 * total && (vahI < binCount - 1 || valI > 0)) {
    const up = vahI < binCount - 1 ? vols[vahI + 1] : -1;
    const dn = valI > 0 ? vols[valI - 1] : -1;
    if (up >= dn) {
      vahI++;
      covered += up;
    } else {
      valI--;
      covered += dn;
    }
  }
  const mean = total / binCount;
  const hvn = bins.filter((b) => b.vol > 1.6 * mean).map((b) => b.price);
  const lvn = bins.filter((b) => b.vol < 0.4 * mean).map((b) => b.price);
  return {
    poc: bins[pocIdx].price,
    vah: lo + (vahI + 1) * step,
    val: lo + valI * step,
    hvn,
    lvn,
    bins,
    binSize: step,
    totalVolume: total,
    valueAreaPct: 70,
    calculatedAt: Date.now(),
    approximated: true,
    source: meta?.source ?? "SPOT_TRADED",
    sourceInstrumentKey: meta?.sourceInstrumentKey ?? null,
    sourceExpiry: meta?.sourceExpiry ?? null,
    sourceSymbol: meta?.sourceSymbol ?? null,
    sessionDate: meta?.sessionDate ?? null,
    basis: meta?.basis ?? null,
    mappedCandles: meta?.mappedCandles ?? candles.length,
  };
}
