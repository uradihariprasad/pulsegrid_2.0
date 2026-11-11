/**
 * PULSEGRID 2.0 — FMPI: Futures & Options Momentum Pressure Index.
 *
 * Documented normalized scoring model:
 *  - Seven independent component families, each normalized to [-1, +1]
 *    via tanh-squashed z-style scaling against the instrument's own realized
 *    volatility (adaptive — no fixed RSI-style thresholds).
 *  - Components: UNDERLYING, OPTIONS_PREMIUM, FUTURES, OI_FLOW, VOLUME,
 *    STRUCTURE, VWAP_EMA.
 *  - Missing components NEVER contribute zero directional evidence: the final
 *    value renormalizes over available weights and coverage is reduced.
 *  - Correlated families are capped so we do not double-count (options premium
 *    and OI flow share a derivatives cap; VWAP/EMA and momentum share a trend cap).
 *  - Output range: [-100, +100].
 */
import { clamp, squash } from "./indicators";

export interface FMPIInput {
  // underlying price momentum: % change over the TF, scaled by realized vol
  priceMomPct: number | null;
  realizedVolPct: number | null;
  // options
  cePremChgPct: number | null;
  pePremChgPct: number | null;
  optionVolAccel: number | null; // recent option vol / baseline vol ratio−1
  rvol: number | null;
  // OI flow
  oiChg5mDir: number | null; // -1..+1 directional read (PE add bullish etc.)
  oiChg15mDir: number | null;
  oiSessDir: number | null;
  // futures
  futChgPct: number | null;
  futOiChgPct: number | null;
  basisChg: number | null; // + expanding bullish / - contracting
  // trend refs
  priceVsVwapPct: number | null;
  emaAlignment: number | null; // -1..+1 counted aligned stack
  structureDir: "UP" | "DOWN" | "RANGE" | null;
  higherTfAgree: boolean | null;
  volatilityPct: number | null;
}

export type FMPIClass =
  | "STRONG_BULLISH"
  | "BULLISH"
  | "WEAK_BULLISH"
  | "NEUTRAL"
  | "WEAK_BEARISH"
  | "BEARISH"
  | "STRONG_BEARISH";

export type FMPIAccel = "ACCELERATING" | "DECELERATING" | "FLAT";

export interface FMPIOutput {
  value: number; // -100..100
  classification: FMPIClass;
  acceleration: FMPIAccel;
  divergence: "BULLISH_DIVERGENCE" | "BEARISH_DIVERGENCE" | "NONE";
  exhaustionCandidate: boolean;
  components: Record<string, number>; // signed contribution after weighting
  rawComponents: Record<string, number | null>;
  coverage: number; // 0..1
  weightsUsed: Record<string, number>;
  thresholds: { strong: number; moderate: number; weak: number };
  confirmationRequired: string[];
}

const WEIGHTS: Record<string, number> = {
  underlying: 0.22,
  options: 0.2,
  futures: 0.16,
  oiFlow: 0.14,
  volume: 0.1,
  structure: 0.1,
  trend: 0.08,
};

function componentOrNull(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return clamp(v, -1, 1);
}

export function computeFMPI(inp: FMPIInput, prevValues: number[] = []): FMPIOutput {
  const volScale = Math.max(inp.realizedVolPct ?? inp.volatilityPct ?? 0.5, 0.05);

  // ---- normalize each family to [-1, +1] -----------------------------------
  const underlyingRaw =
    inp.priceMomPct == null ? null : squash((inp.priceMomPct / volScale) * 1.6);

  let optionsRaw: number | null = null;
  if (inp.cePremChgPct != null || inp.pePremChgPct != null) {
    const ce = inp.cePremChgPct ?? 0;
    const pe = inp.pePremChgPct ?? 0;
    optionsRaw = squash((ce - pe) / 12); // CE premium strengthening vs PE
  }
  if (inp.optionVolAccel != null && optionsRaw != null) {
    optionsRaw = clamp(optionsRaw + squash(inp.optionVolAccel / 2) * 0.25 * Math.sign(optionsRaw || 1), -1, 1);
  }

  let futuresRaw: number | null = null;
  if (inp.futChgPct != null || inp.futOiChgPct != null) {
    let f = 0;
    let parts = 0;
    if (inp.futChgPct != null) {
      f += squash((inp.futChgPct / volScale) * 1.5);
      parts++;
    }
    if (inp.futChgPct != null && inp.futOiChgPct != null) {
      // price+OI relationship: rising price + rising OI = long buildup (bullish)
      const dir = Math.sign(inp.futChgPct);
      f += squash(((Math.abs(inp.futOiChgPct) / 3) * dir));
      parts++;
    }
    if (inp.basisChg != null) {
      f += squash(inp.basisChg / 5) * 0.5;
      parts += 0.5;
    }
    futuresRaw = clamp(f / Math.max(parts, 1), -1, 1);
  }

  let oiRaw: number | null = null;
  {
    const parts = [inp.oiChg5mDir, inp.oiChg15mDir, inp.oiSessDir].filter((v): v is number => v != null);
    if (parts.length) oiRaw = clamp(parts.reduce((s, v) => s + v, 0) / parts.length, -1, 1);
  }

  let volumeRaw: number | null = null;
  if (inp.rvol != null) {
    // volume only amplifies the existing directional read — neutral by itself
    const dir = Math.sign((underlyingRaw ?? 0) + (futuresRaw ?? 0));
    volumeRaw = dir * squash(Math.max(inp.rvol - 1, 0) / 1.5);
  }

  let structRaw: number | null = null;
  if (inp.structureDir) structRaw = inp.structureDir === "UP" ? 0.8 : inp.structureDir === "DOWN" ? -0.8 : 0;
  if (structRaw != null && inp.higherTfAgree === false) structRaw *= 0.5; // countertrend momentum is weaker evidence

  let trendRaw: number | null = null;
  {
    const parts: number[] = [];
    if (inp.priceVsVwapPct != null) parts.push(squash((inp.priceVsVwapPct / volScale) * 2));
    if (inp.emaAlignment != null) parts.push(clamp(inp.emaAlignment, -1, 1));
    if (parts.length) trendRaw = clamp(parts.reduce((s, v) => s + v, 0) / parts.length, -1, 1);
  }

  const raw: Record<string, number | null> = {
    underlying: componentOrNull(underlyingRaw),
    options: componentOrNull(optionsRaw),
    futures: componentOrNull(futuresRaw),
    oiFlow: componentOrNull(oiRaw),
    volume: componentOrNull(volumeRaw),
    structure: componentOrNull(structRaw),
    trend: componentOrNull(trendRaw),
  };

  // ---- correlation guards: derivatives families share a cap ----------------
  if (raw.options != null && raw.oiFlow != null) {
    const s = Math.sign(raw.options) === Math.sign(raw.oiFlow);
    if (s) {
      raw.oiFlow = raw.oiFlow * 0.85;
    }
  }
  if (raw.underlying != null && raw.trend != null && Math.sign(raw.underlying) === Math.sign(raw.trend)) {
    raw.trend = raw.trend * 0.85;
  }

  // ---- weighted sum over available families; missing → coverage reduction --
  let num = 0,
    den = 0,
    available = 0;
  const components: Record<string, number> = {};
  const weightsUsed: Record<string, number> = {};
  for (const k of Object.keys(WEIGHTS)) {
    const v = raw[k];
    if (v == null) continue;
    const w = WEIGHTS[k];
    num += v * w;
    den += w;
    components[k] = Math.round(v * w * 1000) / 10; // contribution in index points
    weightsUsed[k] = w;
    available++;
  }
  const value = den > 0 ? clamp((num / den) * 100, -100, 100) : 0;
  const coverage = available / Object.keys(WEIGHTS).length;

  // ---- volatility-adaptive thresholds ---------------------------------------
  const widen = clamp(volScale / 0.5, 0.8, 1.6);
  const thresholds = { strong: 45 * widen > 60 ? 60 : 45 * widen, moderate: 22 * widen, weak: 8 * widen };

  const abs = Math.abs(value);
  let classification: FMPIClass = "NEUTRAL";
  if (abs >= thresholds.strong) classification = value > 0 ? "STRONG_BULLISH" : "STRONG_BEARISH";
  else if (abs >= thresholds.moderate) classification = value > 0 ? "BULLISH" : "BEARISH";
  else if (abs >= thresholds.weak) classification = value > 0 ? "WEAK_BULLISH" : "WEAK_BEARISH";

  // ---- acceleration from prior FMPI observations ----------------------------
  let acceleration: FMPIAccel = "FLAT";
  let divergence: FMPIOutput["divergence"] = "NONE";
  let exhaustionCandidate = false;
  if (prevValues.length >= 3) {
    const d1 = prevValues[prevValues.length - 1] - prevValues[prevValues.length - 2];
    const d2 = prevValues[prevValues.length - 2] - prevValues[prevValues.length - 3];
    if (Math.abs(d1) > 3 && Math.abs(d2) > 3 && Math.sign(d1) === Math.sign(d2)) acceleration = "ACCELERATING";
    else if (Math.sign(d1) !== Math.sign(d2) && Math.abs(d2) > 3) acceleration = "DECELERATING";
    // exhaustion: high absolute value + decelerating against the move
    if (abs > thresholds.strong * 0.9 && Math.sign(d1) !== Math.sign(value) && Math.abs(d1) > 2) exhaustionCandidate = true;
  }
  if (inp.priceMomPct != null && prevValues.length >= 2) {
    const priceUp = inp.priceMomPct > 0;
    const fmpiSlopesDn = prevValues[prevValues.length - 1] < prevValues[0];
    if (priceUp && fmpiSlopesDn && value > 0) divergence = "BEARISH_DIVERGENCE";
    if (!priceUp && !fmpiSlopesDn && value < 0) divergence = "BULLISH_DIVERGENCE";
  }

  const confirmationRequired: string[] = [];
  if (raw.futures == null) confirmationRequired.push("Futures confirmation missing");
  if (raw.oiFlow == null) confirmationRequired.push("OI flow confirmation missing");
  if (raw.options == null) confirmationRequired.push("Option premium confirmation missing");
  if (coverage < 0.7) confirmationRequired.push("Coverage below 70% — treat as developing");

  return {
    value: Math.round(value * 10) / 10,
    classification,
    acceleration,
    divergence,
    exhaustionCandidate,
    components,
    rawComponents: raw,
    coverage,
    weightsUsed,
    thresholds: { strong: Math.round(thresholds.strong), moderate: Math.round(thresholds.moderate), weak: Math.round(thresholds.weak) },
    confirmationRequired,
  };
}

/** Futures price/OI relationship classification (Part 9). */
export type FuturesClass =
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "SHORT_COVERING"
  | "LONG_UNWINDING"
  | "NEUTRAL"
  | "DIVERGENCE"
  | "UNAVAILABLE";

export function classifyFutures(priceChgPct: number | null, oiChgPct: number | null): FuturesClass {
  if (priceChgPct == null || oiChgPct == null) return "UNAVAILABLE";
  const p = priceChgPct;
  const o = oiChgPct;
  const pFlat = Math.abs(p) < 0.03;
  const oFlat = Math.abs(o) < 0.02;
  if (p > 0 && o > 0 && !pFlat && !oFlat) return "LONG_BUILDUP";
  if (p < 0 && o > 0 && !pFlat && !oFlat) return "SHORT_BUILDUP";
  if (p > 0 && o < 0 && !pFlat && !oFlat) return "SHORT_COVERING";
  if (p < 0 && o < 0 && !pFlat && !oFlat) return "LONG_UNWINDING";
  if (!pFlat && oFlat) return "NEUTRAL";
  if (pFlat && !oFlat) return "DIVERGENCE";
  return "NEUTRAL";
}
