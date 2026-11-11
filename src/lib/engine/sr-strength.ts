/**
 * PULSEGRID 2.0 — Dynamic S/R Strength Intelligence Engine.
 *
 * One shared engine produces the four levels (Immediate/Primary Resistance and
 * Support) with an explainable 0–100 strength score, an INDEPENDENT lifecycle
 * state, breakout/breakdown risk and per-category evidence. Chart overlays and
 * the panel below the chart both render this exact output — no component ever
 * recomputes levels on its own.
 *
 * Scoring is evidence-weighted and renormalised over AVAILABLE categories:
 *   options OI / positioning   30%
 *   price-action rejection     25%
 *   volume-profile confluence  20%
 *   volume + RVOL behaviour    15%
 *   independent test quality   10%
 *
 * A score is a normalised estimate of level strength from available evidence.
 * It is NOT a statistically calibrated probability of reversal.
 */
import type { Candle } from "./types";
import type { SRZone, ZoneSide } from "./sr";
import { clamp } from "./indicators";
import { analyzeZoneInteractions, currentSessionCandles, type ZoneInteractionResult } from "./zone-interaction";

/* ------------------------------------------------------------------ config */
export interface StrengthWeights {
  oi: number;
  priceAction: number;
  volumeProfile: number;
  volume: number;
  testQuality: number;
}

export const DEFAULT_WEIGHTS: StrengthWeights = {
  oi: 0.3,
  priceAction: 0.25,
  volumeProfile: 0.2,
  volume: 0.15,
  testQuality: 0.1,
};

export const SR_CONFIG = {
  /** minimum share of weighted evidence required to publish a score */
  minCoverage: 0.45,
  /** score delta needed to flip into STRENGTHENING / WEAKENING */
  lifecycleDelta: 6,
  /** samples required before a lifecycle transition is allowed (hysteresis) */
  lifecycleMinSamples: 3,
  /** EMA smoothing factor applied to the published score */
  smoothing: 0.35,
  /** closes beyond the zone required to call it BROKEN */
  breakConfirmCloses: 2,
  /** how far beyond the zone (in ATR) price must accept to INVALIDATE it */
  invalidateAtr: 1.2,
  /** proximity (in ATR) at which breakout/breakdown risk is evaluated */
  riskProximityAtr: 0.75,
  bands: { veryStrong: 80, strong: 65, moderate: 45, weak: 25 },
};

export type StrengthClass = "VERY_STRONG" | "STRONG" | "MODERATE" | "WEAK" | "VERY_WEAK" | "INSUFFICIENT_DATA";
export type Lifecycle = "STRENGTHENING" | "STABLE" | "WEAKENING" | "BREAKOUT_RISK" | "BREAKDOWN_RISK" | "BROKEN" | "INVALIDATED";
export type CoverageState = "COMPLETE" | "PARTIAL" | "DELAYED" | "INSUFFICIENT_DATA" | "UNAVAILABLE";

export function classifyStrength(score: number | null): StrengthClass {
  if (score == null) return "INSUFFICIENT_DATA";
  const b = SR_CONFIG.bands;
  if (score >= b.veryStrong) return "VERY_STRONG";
  if (score >= b.strong) return "STRONG";
  if (score >= b.moderate) return "MODERATE";
  if (score >= b.weak) return "WEAK";
  return "VERY_WEAK";
}

/* ------------------------------------------------------------------ inputs */
export interface StrikeOi {
  strike: number;
  ceOi: number;
  peOi: number;
  ce5m: number | null;
  pe5m: number | null;
  ce15m: number | null;
  pe15m: number | null;
  ceSess: number | null;
  peSess: number | null;
  /** REAL 5m/15m premium change from stored observations — never LTP vs prev close */
  cePrem5m: number | null;
  pePrem5m: number | null;
  cePrem15m: number | null;
  pePrem15m: number | null;
}

/** Futures positioning, with price and OI kept INDEPENDENT (Priority 5). */
export interface FuturesPositioning {
  priceChgPct: number | null;
  oiChgPct: number | null;
  oi5m: number | null;
  oi15m: number | null;
  classification: "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING" | "NEUTRAL" | "DIVERGENCE" | "UNAVAILABLE";
}

/** Underlying move over the SAME window used for the OI/premium comparison. */
export interface WindowMove {
  pct5m: number | null;
  pct15m: number | null;
}

/**
 * Positioning interpretation from price + OI together.
 * These are POSITIONING INTERPRETATIONS, not proof of aggressor identity.
 */
export type PositioningRead =
  | "POTENTIAL_LONG_BUILDUP"
  | "POTENTIAL_SHORT_BUILDUP"
  | "POTENTIAL_SHORT_COVERING"
  | "POTENTIAL_LONG_UNWINDING"
  | "POSITIONING_UNCLEAR";

export function readPositioning(priceChgPct: number | null, oiChgPct: number | null, flatPrice = 0.03, flatOi = 0.15): PositioningRead {
  if (priceChgPct == null || oiChgPct == null) return "POSITIONING_UNCLEAR";
  const pFlat = Math.abs(priceChgPct) < flatPrice;
  const oFlat = Math.abs(oiChgPct) < flatOi;
  if (pFlat || oFlat) return "POSITIONING_UNCLEAR";
  if (priceChgPct > 0 && oiChgPct > 0) return "POTENTIAL_LONG_BUILDUP";
  if (priceChgPct < 0 && oiChgPct > 0) return "POTENTIAL_SHORT_BUILDUP";
  if (priceChgPct > 0 && oiChgPct < 0) return "POTENTIAL_SHORT_COVERING";
  return "POTENTIAL_LONG_UNWINDING";
}

export interface StrengthInput {
  zone: SRZone;
  price: number;
  atr: number;
  /** PRICE-ACTION candles — always the instrument's own spot candles */
  candles: Candle[];
  /**
   * CURRENT-SESSION volume candles only (Priority 4). For equities the stock's
   * own session candles; for indices the spot-mapped futures session candles.
   * Historical sessions must NEVER appear here — yesterday's defence is not
   * today's defence.
   */
  volumeCandles?: Candle[];
  /** label describing where the volume came from, for honest reporting */
  volumeSource?: string | null;
  /** strike rows near the zone (ATM±3 window from the live chain) */
  strikes: StrikeOi[];
  strikeStep: number;
  maxCeOi: number;
  maxPeOi: number;
  profile: { poc: number; vah: number; val: number; hvn: number[]; lvn: number[]; source?: string } | null;
  rvol: number | null;
  /** legacy scalar bias — retained for callers that have nothing richer */
  futuresBias: number | null;
  /** structured futures positioning (price and OI independent) */
  futures?: FuturesPositioning | null;
  /** underlying move over the 5m/15m windows used for OI/premium reads */
  underlyingMove?: WindowMove | null;
  chainAgeSec: number | null;
}

export interface CategoryScore {
  /** 0..1 — how strongly this family supports the level HOLDING */
  value: number;
  available: boolean;
  label: string;
  detail: string;
}

export interface LevelEvidence {
  oi: CategoryScore;
  priceAction: CategoryScore;
  volumeProfile: CategoryScore;
  volume: CategoryScore;
  testQuality: CategoryScore;
}

/* --------------------------------------------------------------- helpers */
const norm = (v: number, lo: number, hi: number): number => clamp((v - lo) / (hi - lo), 0, 1);

/** Bars whose range intersects the zone — a genuine interaction. */
function zoneTouches(candles: Candle[], zone: SRZone, tol: number) {
  const out: { i: number; c: Candle; rejected: boolean; accepted: boolean; wick: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const lo = zone.priceLow - tol;
    const hi = zone.priceHigh + tol;
    if (c.h < lo || c.l > hi) continue;
    const range = Math.max(c.h - c.l, 1e-9);
    if (zone.side === "RESISTANCE") {
      const wick = (c.h - Math.max(c.o, c.c)) / range;         // upper wick share
      const rejected = c.c < zone.priceLow;                     // closed back below
      const accepted = c.c > zone.priceHigh;                    // closed above
      out.push({ i, c, rejected, accepted, wick });
    } else {
      const wick = (Math.min(c.o, c.c) - c.l) / range;          // lower wick share
      const rejected = c.c > zone.priceHigh;
      const accepted = c.c < zone.priceLow;
      out.push({ i, c, rejected, accepted, wick });
    }
  }
  return out;
}

/** Collapse touches separated by <5 bars into one "test". */
function groupTests<T extends { i: number }>(touches: T[], gap = 5): T[][] {
  const groups: T[][] = [];
  for (const t of touches) {
    const last = groups[groups.length - 1];
    if (last && t.i - last[last.length - 1].i <= gap) last.push(t);
    else groups.push([t]);
  }
  return groups;
}

/* ------------------------------------------------------------ OI category */
/**
 * PRIORITY 2 — evidence-based positioning.
 *
 * OI is a count of OUTSTANDING CONTRACTS, not proof of aggressor identity.
 * A CE OI increase is only treated as seller-side (call-writing) evidence
 * when the premium and the underlying move over the SAME window corroborate
 * it. Uncorroborated OI returns a neutral 0.5 and is labelled "unclear".
 */
function scoreOi(inp: StrengthInput): CategoryScore {
  const { zone, strikes, strikeStep, maxCeOi, maxPeOi } = inp;
  const isRes = zone.side === "RESISTANCE";
  const near = strikes.filter((s) => Math.abs(s.strike - zone.mid) <= strikeStep * 1.5);
  if (!near.length || (isRes ? maxCeOi : maxPeOi) <= 0)
    return { value: 0, available: false, label: "Options positioning", detail: "No option-chain strikes map to this zone" };

  const notes: string[] = [];
  let sum = 0;
  let parts = 0;
  const und = inp.underlyingMove ?? { pct5m: null, pct15m: null };

  // --- 1. where the defending side's OI is concentrated -------------------
  const oiAtZone = near.reduce((s, x) => s + (isRes ? x.ceOi : x.peOi), 0) / near.length;
  const conc = norm(oiAtZone / Math.max(isRes ? maxCeOi : maxPeOi, 1), 0.15, 0.85);
  sum += conc;
  parts++;
  notes.push(`${isRes ? "CE" : "PE"} OI concentration ${(conc * 100).toFixed(0)}% of chain peak`);

  // --- 2. corroborated positioning read over the 15m window ---------------
  //     OI change + premium change + underlying move must agree before this
  //     is called writing / buying.
  const sessOi = near.map((x) => (isRes ? x.ceSess : x.peSess)).filter((v): v is number => v != null);
  const prem15 = near.map((x) => (isRes ? x.cePrem15m : x.pePrem15m)).filter((v): v is number => v != null);
  const oi15 = near.map((x) => (isRes ? x.ce15m : x.pe15m)).filter((v): v is number => v != null);

  if (oi15.length && prem15.length) {
    const oiNet = oi15.reduce((a, b) => a + b, 0);
    const premAvg = prem15.reduce((a, b) => a + b, 0) / prem15.length;
    const oiUp = oiNet > 0;
    // Writing signature: OI rising WHILE the option's own premium falls.
    // Buying signature: OI rising WHILE premium rises.
    const writing = oiUp && premAvg < -0.5;
    const buying = oiUp && premAvg > 0.5;
    const unwinding = !oiUp && Math.abs(oiNet) > 0;

    if (writing) {
      // CE writing defends resistance; PE writing defends support
      sum += 0.85;
      notes.push(`potential ${isRes ? "call" : "put"} writing (OI up, premium ${premAvg.toFixed(1)}%)`);
    } else if (buying) {
      // option BUYING on the defending side attacks the level
      sum += 0.2;
      notes.push(`potential ${isRes ? "call" : "put"} buying (OI up, premium +${premAvg.toFixed(1)}%) — attacks the zone`);
    } else if (unwinding) {
      sum += 0.35;
      notes.push(`${isRes ? "CE" : "PE"} OI unwinding at the zone`);
    } else {
      sum += 0.5;
      notes.push("positioning unclear");
    }
    parts++;
  } else if (sessOi.length) {
    // OI only, no premium window → explicitly NEUTRAL, never strength
    sum += 0.5;
    parts++;
    notes.push(`${isRes ? "CE" : "PE"} OI buildup recorded but premium window unavailable — positioning unclear`);
  }

  // --- 3. underlying response over the same window ------------------------
  if (und.pct15m != null) {
    // resistance is helped by a flat/falling underlying, support by a rising one
    const v = clamp(0.5 + (isRes ? -und.pct15m : und.pct15m) / 1.2, 0, 1);
    sum += v;
    parts++;
    notes.push(`underlying ${und.pct15m >= 0 ? "+" : ""}${und.pct15m.toFixed(2)}% over 15m`);
  }

  // --- 4. futures positioning as INDEPENDENT context (Priority 5) ---------
  const fut = inp.futures;
  if (fut && fut.classification !== "UNAVAILABLE") {
    const read = readPositioning(fut.priceChgPct, fut.oiChgPct);
    let v = 0.5;
    if (isRes) {
      if (read === "POTENTIAL_SHORT_BUILDUP") v = 0.85;        // sellers pressing → resistance holds
      else if (read === "POTENTIAL_LONG_BUILDUP") v = 0.2;     // buyers pressing → resistance at risk
      else if (read === "POTENTIAL_SHORT_COVERING") v = 0.3;
      else if (read === "POTENTIAL_LONG_UNWINDING") v = 0.65;
    } else {
      if (read === "POTENTIAL_LONG_BUILDUP") v = 0.85;
      else if (read === "POTENTIAL_SHORT_BUILDUP") v = 0.2;
      else if (read === "POTENTIAL_LONG_UNWINDING") v = 0.3;
      else if (read === "POTENTIAL_SHORT_COVERING") v = 0.65;
    }
    sum += v * 0.7;
    parts += 0.7;
    notes.push(read.replaceAll("_", " ").toLowerCase());
  } else {
    notes.push("futures positioning unavailable");
  }

  return { value: clamp(sum / Math.max(parts, 1), 0, 1), available: true, label: "Options positioning", detail: notes.join(" · ") };
}

/* --------------------------------------------------- price-action category */
/** Shared interaction analysis, memoised per (zone, candle-set) evaluation. */
function interactionsFor(inp: StrengthInput, candles: Candle[]): ZoneInteractionResult {
  const tol = Math.max(inp.atr * 0.2, inp.zone.priceHigh - inp.zone.priceLow);
  return analyzeZoneInteractions(candles, inp.zone.priceLow, inp.zone.priceHigh, inp.zone.side, inp.atr, tol);
}

function scorePriceAction(inp: StrengthInput): CategoryScore {
  const r = interactionsFor(inp, inp.candles);
  if (!r.events.length)
    return { value: 0, available: false, label: "Price action", detail: "Zone has not been tested in the loaded window" };

  const notes: string[] = [];
  notes.push(`${r.events.length} independent interaction(s)`);
  notes.push(`${r.successfulTests} defence(s), ${r.acceptances} acceptance(s)`);
  const failedBreaks = r.events.filter((e) => e.outcome === "FAILED_BREAK").length;
  if (failedBreaks) notes.push(`${failedBreaks} failed ${inp.zone.side === "RESISTANCE" ? "breakout" : "breakdown"}(s)`);
  if (r.confirmedBreak) notes.push("confirmed break recorded");

  // Defence rate is computed over DECISIVE events only; acceptance is a
  // direct penalty so a breakout can never read as strength.
  const decisive = r.events.filter((e) => e.outcome !== "NO_REACTION").length || 1;
  const defenceRate = r.successfulTests / decisive;
  const value = clamp(
    defenceRate * 0.5 + r.meanQuality * 0.3 + norm(failedBreaks, 0, 2) * 0.2 - r.acceptances * 0.25 - (r.confirmedBreak ? 0.3 : 0),
    0,
    1,
  );
  return { value, available: true, label: "Price action", detail: notes.join(" · ") };
}

/* -------------------------------------------------- volume-profile category */
function scoreVolumeProfile(inp: StrengthInput): CategoryScore {
  const { zone, profile, atr } = inp;
  if (!profile)
    return {
      value: 0,
      available: false,
      label: "Volume profile",
      detail: inp.volumeSource ? `Profile unavailable — ${inp.volumeSource}` : "Profile unavailable — no traded-volume source could be resolved",
    };
  const isRes = zone.side === "RESISTANCE";
  const edge = isRes ? profile.vah : profile.val;
  const notes: string[] = [];
  let sum = 0;
  let parts = 0;

  const edgeDist = Math.abs(zone.mid - edge) / Math.max(atr, 1e-9);
  const edgeScore = 1 - clamp(edgeDist / 2, 0, 1);
  sum += edgeScore;
  parts++;
  if (edgeScore > 0.5) notes.push(`${isRes ? "VAH" : "VAL"} confluence at ${edge.toFixed(2)}`);
  else notes.push(`${isRes ? "VAH" : "VAL"} ${edgeDist.toFixed(1)} ATR away`);

  const hvnDist = profile.hvn.length ? Math.min(...profile.hvn.map((h) => Math.abs(h - zone.mid))) / Math.max(atr, 1e-9) : null;
  if (hvnDist != null) {
    const v = 1 - clamp(hvnDist / 1.5, 0, 1);
    sum += v;
    parts++;
    if (v > 0.5) notes.push("high-volume node overlap");
  }

  const pocDist = Math.abs(zone.mid - profile.poc) / Math.max(atr, 1e-9);
  const pocScore = 1 - clamp(pocDist / 3, 0, 1);
  sum += pocScore * 0.6;
  parts += 0.6;
  if (pocScore > 0.6) notes.push("near POC acceptance area");

  // a low-volume node means price moves through quickly → weaker level
  const lvnNear = profile.lvn.some((l) => Math.abs(l - zone.mid) < atr * 0.4);
  if (lvnNear) {
    sum -= 0.25;
    notes.push("low-volume node — thin area, easier to traverse");
  }

  if (profile.source === "FUTURES_DERIVED_SPOT_MAPPED") notes.push("futures-derived · spot-mapped");
  return { value: clamp(sum / Math.max(parts, 1), 0, 1), available: true, label: "Volume profile", detail: notes.join(" · ") };
}

/* --------------------------------------------------------- volume category */
function scoreVolume(inp: StrengthInput): CategoryScore {
  const { rvol } = inp;
  // PRIORITY 4: volume evidence is CURRENT-SESSION ONLY. Historical sessions
  // are structural confluence (volume profile), never "today's defence".
  const supplied = inp.volumeCandles?.length ? inp.volumeCandles : inp.candles;
  const candles = currentSessionCandles(supplied);
  const srcLabel = inp.volumeSource ? ` (${inp.volumeSource})` : "";
  if (!candles.length)
    return { value: 0, available: false, label: "Volume behaviour", detail: `No current-session volume candles${srcLabel}` };
  if (!candles.some((c) => c.v > 0))
    return { value: 0, available: false, label: "Volume behaviour", detail: "No traded-volume source available for this instrument" };

  const r = interactionsFor({ ...inp, candles }, candles);
  if (!r.events.length)
    return { value: 0, available: false, label: "Volume behaviour", detail: `Zone not interacted with in the current session${srcLabel}` };

  const baseline = candles.reduce((s, c) => s + c.v, 0) / Math.max(candles.length, 1);
  const notes: string[] = [];
  let sum = 0;
  let parts = 0;

  const defend = r.events.filter((e) => e.successful);
  const attack = r.events.filter((e) => e.outcome === "ACCEPTANCE" || e.outcome === "CONFIRMED_BREAK");

  if (defend.length) {
    const perBar = defend.reduce((s, e) => s + e.volume / Math.max(e.barsInside, 1), 0) / defend.length;
    const v = norm(perBar / Math.max(baseline, 1), 0.6, 2.2);
    sum += v;
    parts++;
    notes.push(`defence volume ${(perBar / Math.max(baseline, 1)).toFixed(2)}× session baseline`);
  }
  if (attack.length) {
    const perBar = attack.reduce((s, e) => s + e.volume / Math.max(e.barsInside, 1), 0) / attack.length;
    const v = norm(perBar / Math.max(baseline, 1), 0.6, 2.2);
    sum += 1 - v; // volume arriving on acceptance bars weakens the level
    parts++;
    notes.push(`opposing volume on ${attack.length} acceptance event(s)`);
  }
  if (rvol != null) {
    // RVOL is session context only; it is deliberately NOT re-counted as
    // "volume expansion" (that is already measured above).
    const v = 1 - clamp((rvol - 1) / 2, 0, 1) * 0.5;
    sum += v * 0.5;
    parts += 0.5;
    notes.push(`session RVOL ${rvol.toFixed(2)}×`);
  }
  if (!parts) return { value: 0, available: false, label: "Volume behaviour", detail: "Insufficient current-session volume samples at the zone" };
  if (inp.volumeSource) notes.push(inp.volumeSource);
  notes.push("current session only");
  return { value: clamp(sum / parts, 0, 1), available: true, label: "Volume behaviour", detail: notes.join(" · ") };
}

/* ---------------------------------------------------- test-quality category */
function scoreTestQuality(inp: StrengthInput): CategoryScore {
  const r = interactionsFor(inp, inp.candles);
  if (!r.events.length) return { value: 0, available: false, label: "Test quality", detail: "No independent tests recorded yet" };

  // PRIORITY 6: quality of the REACTION decides the score, not the number of
  // touches. A sequence of weakening defences lowers it; an acceptance after
  // repeated tests lowers it sharply.
  const successes = r.events.filter((e) => e.successful);
  const spread = norm(
    r.events.length > 1 ? r.events[r.events.length - 1].endIdx - r.events[0].startIdx : 0,
    0,
    Math.max(inp.candles.length * 0.4, 1),
  );
  const depthBonus = norm(successes.reduce((s, e) => s + e.reactionAtr, 0) / Math.max(successes.length, 1), 0, 1.5);

  let value =
    r.meanQuality * 0.45 +
    norm(successes.length, 0, 4) * 0.2 +
    spread * 0.15 +
    depthBonus * 0.2 +
    clamp(r.qualityTrend, -0.4, 0.4) * 0.5; // declining defence subtracts
  if (r.acceptances > 0) value -= 0.2 * r.acceptances;
  if (r.confirmedBreak) value -= 0.35;
  value = clamp(value, 0, 1);

  const trendWord = r.qualityTrend > 0.05 ? "improving" : r.qualityTrend < -0.05 ? "declining" : "steady";
  return {
    value,
    available: true,
    label: "Test quality",
    detail: `${successes.length} successful of ${r.events.length} interaction(s) · reaction quality ${(r.meanQuality * 100).toFixed(0)}% · defence ${trendWord}`,
  };
}

function avg(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

/* ------------------------------------------------------------ main scoring */
export interface RawStrength {
  score: number | null;
  coverage: number;
  coverageState: CoverageState;
  evidence: LevelEvidence;
  positive: string[];
  negative: string[];
  missing: string[];
}

export function computeLevelStrength(inp: StrengthInput, weights: StrengthWeights = DEFAULT_WEIGHTS): RawStrength {
  const evidence: LevelEvidence = {
    oi: scoreOi(inp),
    priceAction: scorePriceAction(inp),
    volumeProfile: scoreVolumeProfile(inp),
    volume: scoreVolume(inp),
    testQuality: scoreTestQuality(inp),
  };
  const pairs: [keyof LevelEvidence, number][] = [
    ["oi", weights.oi],
    ["priceAction", weights.priceAction],
    ["volumeProfile", weights.volumeProfile],
    ["volume", weights.volume],
    ["testQuality", weights.testQuality],
  ];
  let num = 0;
  let den = 0;
  const positive: string[] = [];
  const negative: string[] = [];
  const missing: string[] = [];
  for (const [k, w] of pairs) {
    const c = evidence[k];
    if (!c.available) {
      missing.push(c.label);
      continue;
    }
    num += c.value * w;
    den += w;
    if (c.value >= 0.6) positive.push(`${c.label}: ${c.detail}`);
    else if (c.value <= 0.4) negative.push(`${c.label}: ${c.detail}`);
  }
  const coverage = den; // weights sum to 1, so den is the available share
  let coverageState: CoverageState =
    coverage >= 0.85 ? "COMPLETE" : coverage >= SR_CONFIG.minCoverage ? "PARTIAL" : "INSUFFICIENT_DATA";
  if (coverageState !== "INSUFFICIENT_DATA" && inp.chainAgeSec != null && inp.chainAgeSec > 180) coverageState = "DELAYED";

  const score = coverage >= SR_CONFIG.minCoverage ? Math.round(clamp((num / den) * 100, 0, 100)) : null;
  return { score, coverage, coverageState, evidence, positive, negative, missing };
}

/* ------------------------------------------------- lifecycle & persistence */
interface TrackedLevel {
  id: string;
  symbol: string;
  tf: string;
  side: ZoneSide;
  priceLow: number;
  priceHigh: number;
  mid: number;
  /** original structural midpoint — boundaries expand only around this */
  anchorMid: number;
  boundaryChanges: number;
  firstSeen: number;
  smoothed: number | null;
  history: { ts: number; score: number }[];
  lifecycle: Lifecycle;
  lifecycleSince: number;
  pendingLifecycle: { state: Lifecycle; count: number } | null;
  closesBeyond: number;
  brokenAt: number | null;
  lastSeen: number;
}

const registry = new Map<string, TrackedLevel>();

function registryKey(symbol: string, tf: string, side: ZoneSide, mid: number, tol: number): string {
  return `${symbol}|${tf}|${side}|${Math.round(mid / Math.max(tol, 1e-6))}`;
}

/** Find an existing tracked level whose band overlaps the incoming zone. */
function matchTracked(symbol: string, tf: string, zone: SRZone, tol: number): TrackedLevel | null {
  let best: TrackedLevel | null = null;
  let bestDist = Infinity;
  for (const t of registry.values()) {
    if (t.symbol !== symbol || t.tf !== tf || t.side !== zone.side) continue;
    const d = Math.abs(t.mid - zone.mid);
    if (d <= tol && d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best;
}

export interface LevelResult {
  id: string;
  role: "IMMEDIATE_RESISTANCE" | "PRIMARY_RESISTANCE" | "IMMEDIATE_SUPPORT" | "PRIMARY_SUPPORT";
  side: ZoneSide;
  price: number;
  zoneLow: number;
  zoneHigh: number;
  distancePct: number;
  score: number | null;
  smoothedScore: number | null;
  classification: StrengthClass;
  lifecycle: Lifecycle;
  lifecycleSince: number;
  scoreDelta: number | null;
  risk: {
    kind: "BREAKOUT" | "BREAKDOWN";
    /** normalized 0–100 heuristic risk SCORE — explicitly not a probability */
    score: number;
    label: "LOW" | "MODERATE" | "ELEVATED" | "HIGH";
    isProbability: false;
  };
  coverage: number;
  coverageState: CoverageState;
  evidence: LevelEvidence;
  positive: string[];
  negative: string[];
  missing: string[];
  sources: string[];
  oiOnly: boolean;
  touches: number;
  /** independent successful defences in the analysed window */
  successfulTests: number;
  acceptances: number;
  boundaryChanges: number;
  explanation: string;
  style: LineStyleSpec;
}

export interface LineStyleSpec {
  color: string;
  width: 1 | 2 | 3;
  dash: "solid" | "dashed" | "dotted";
  label: string;
}

/* ----------------------------------------------------- lifecycle evolution */
function evolveLifecycle(
  t: TrackedLevel,
  score: number | null,
  inp: StrengthInput,
  now: number,
): { lifecycle: Lifecycle; delta: number | null; risk: number } {
  const zone = inp.zone;
  const isRes = zone.side === "RESISTANCE";
  const price = inp.price;
  const atr = Math.max(inp.atr, 1e-9);

  // --- hard states first: BROKEN / INVALIDATED (tracked on the ORIGINAL zone)
  const beyond = isRes ? price > zone.priceHigh : price < zone.priceLow;
  const lastCloses = inp.candles.slice(-SR_CONFIG.breakConfirmCloses);
  const confirmedCloses = lastCloses.filter((c) => (isRes ? c.c > zone.priceHigh : c.c < zone.priceLow)).length;
  t.closesBeyond = confirmedCloses;

  const dist = Math.abs(price - zone.mid) / atr;
  if (beyond && confirmedCloses >= SR_CONFIG.breakConfirmCloses) {
    if (dist > SR_CONFIG.invalidateAtr) {
      setLifecycle(t, "INVALIDATED", now);
      return { lifecycle: t.lifecycle, delta: null, risk: 1 };
    }
    setLifecycle(t, "BROKEN", now);
    if (t.brokenAt == null) t.brokenAt = now;
    return { lifecycle: t.lifecycle, delta: null, risk: 1 };
  }

  // --- score trend with hysteresis
  let delta: number | null = null;
  if (score != null) {
    t.history.push({ ts: now, score });
    if (t.history.length > 60) t.history.shift();
    if (t.history.length >= SR_CONFIG.lifecycleMinSamples) {
      const ref = t.history[Math.max(0, t.history.length - 8)];
      delta = score - ref.score;
    }
  }

  // --- breakout / breakdown risk
  const near = Math.abs(price - zone.mid) / atr <= SR_CONFIG.riskProximityAtr;
  const weakening = delta != null && delta <= -SR_CONFIG.lifecycleDelta;
  const lowScore = score != null && score < SR_CONFIG.bands.moderate;
  const pressing = near && (weakening || lowScore) && (beyond || confirmedCloses > 0);
  const riskScore = clamp(
    (near ? 0.35 : 0) + (weakening ? 0.25 : 0) + (lowScore ? 0.2 : 0) + (confirmedCloses > 0 ? 0.3 : 0),
    0,
    1,
  );

  let next: Lifecycle;
  if (pressing) next = isRes ? "BREAKOUT_RISK" : "BREAKDOWN_RISK";
  else if (delta != null && delta >= SR_CONFIG.lifecycleDelta) next = "STRENGTHENING";
  else if (delta != null && delta <= -SR_CONFIG.lifecycleDelta) next = "WEAKENING";
  else next = "STABLE";

  // hysteresis: a transition must persist for N evaluations
  if (next !== t.lifecycle) {
    if (t.pendingLifecycle?.state === next) {
      t.pendingLifecycle.count++;
      if (t.pendingLifecycle.count >= SR_CONFIG.lifecycleMinSamples) setLifecycle(t, next, now);
    } else {
      t.pendingLifecycle = { state: next, count: 1 };
    }
  } else {
    t.pendingLifecycle = null;
  }
  return { lifecycle: t.lifecycle, delta, risk: riskScore };
}

function setLifecycle(t: TrackedLevel, l: Lifecycle, now: number): void {
  if (t.lifecycle !== l) {
    t.lifecycle = l;
    t.lifecycleSince = now;
  }
  t.pendingLifecycle = null;
}

/* ------------------------------------------------------------- line styles */
export function lineStyleFor(side: ZoneSide, cls: StrengthClass, lifecycle: Lifecycle, label: string): LineStyleSpec {
  const broken = lifecycle === "BROKEN" || lifecycle === "INVALIDATED";
  const weakening = lifecycle === "WEAKENING" || lifecycle === "BREAKOUT_RISK" || lifecycle === "BREAKDOWN_RISK";
  const strengthening = lifecycle === "STRENGTHENING";

  const RED = { strong: "#b4121b", moderate: "#ea3943", weak: "#ea394399" };
  const GREEN = { strong: "#0f8f5f", moderate: "#16c784", weak: "#16c78499" };
  const pal = side === "RESISTANCE" ? RED : GREEN;

  let color: string;
  let width: 1 | 2 | 3;
  let dash: "solid" | "dashed" | "dotted";

  if (cls === "VERY_STRONG" || cls === "STRONG") {
    color = pal.strong;
    width = strengthening ? 3 : 2;
    dash = "solid";
  } else if (cls === "MODERATE") {
    color = pal.moderate;
    width = 2;
    dash = "solid";
  } else {
    color = pal.weak;
    width = 1;
    dash = "dotted";
  }

  // lifecycle is INDEPENDENT of the band: a strong-but-weakening level
  // is de-emphasised and dashed even at a high score.
  if (weakening) {
    color = pal.weak;
    width = 1;
    dash = cls === "VERY_WEAK" || cls === "WEAK" ? "dotted" : "dashed";
  }
  if (broken) {
    color = "#5a6a83";
    width = 1;
    dash = "dotted";
  }
  if (cls === "INSUFFICIENT_DATA") {
    color = "#5a6a83";
    width = 1;
    dash = "dotted";
  }
  return { color, width, dash, label };
}

/* ------------------------------------------------------------ explanations */
function buildExplanation(role: LevelResult["role"], side: ZoneSide, raw: RawStrength, lifecycle: Lifecycle, risk: number, delta: number | null): string {
  const what = role.replace("_", " ").toLowerCase();
  if (raw.score == null)
    return `Insufficient evidence to score this ${what}. Missing: ${raw.missing.join(", ") || "market data"}. No strength figure is shown rather than publishing a misleading number.`;

  const defender = side === "RESISTANCE" ? "sellers" : "buyers";
  const parts: string[] = [`${cap(what)} strength: ${raw.score}/100 (${classifyStrength(raw.score).replace("_", " ").toLowerCase()}).`];
  if (raw.positive.length) parts.push(`Supporting: ${raw.positive.slice(0, 3).join("; ")}.`);
  if (raw.negative.length) parts.push(`Against: ${raw.negative.slice(0, 2).join("; ")}.`);
  if (raw.missing.length) parts.push(`Missing evidence: ${raw.missing.join(", ")}.`);

  if (lifecycle === "STRENGTHENING") parts.push(`The zone is strengthening — ${defender} response has improved${delta != null ? ` (+${delta.toFixed(0)} pts)` : ""}.`);
  else if (lifecycle === "WEAKENING") parts.push(`The zone is weakening — ${defender} response has declined${delta != null ? ` (${delta.toFixed(0)} pts)` : ""}.`);
  else if (lifecycle === "BREAKOUT_RISK") parts.push(`Breakout risk is elevated (${Math.round(risk * 100)}%): price is pressing the zone while ${defender} defence fades.`);
  else if (lifecycle === "BREAKDOWN_RISK") parts.push(`Breakdown risk is elevated (${Math.round(risk * 100)}%): price is pressing the zone while ${defender} defence fades.`);
  else if (lifecycle === "BROKEN") parts.push(`The zone has been broken on confirmed closes and is no longer presented as an active level.`);
  else if (lifecycle === "INVALIDATED") parts.push(`Price has accepted well beyond the zone — it is invalidated.`);
  else parts.push(`The zone is stable — no material change in ${defender} response.`);
  parts.push(`Strength is a normalised estimate from available evidence, not a probability of reversal.`);
  return parts.join(" ");
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* --------------------------------------------------- public: build 4 levels */
export interface BuildLevelsArgs {
  symbol: string;
  tf: string;
  price: number;
  atr: number;
  candles: Candle[];
  volumeCandles?: Candle[];
  volumeSource?: string | null;
  zones: SRZone[];
  strikes: StrikeOi[];
  strikeStep: number;
  profile: StrengthInput["profile"];
  rvol: number | null;
  futuresBias: number | null;
  futures?: FuturesPositioning | null;
  underlyingMove?: WindowMove | null;
  chainAgeSec: number | null;
  now: number;
}

export interface SRLevelsResult {
  immediateResistance: LevelResult | null;
  primaryResistance: LevelResult | null;
  immediateSupport: LevelResult | null;
  primarySupport: LevelResult | null;
  all: LevelResult[];
  evaluatedZones: number;
}

/**
 * Selects the four levels by STRUCTURAL SIGNIFICANCE (never array position),
 * scores each independently and attaches lifecycle + styling.
 */
export function buildSRLevels(args: BuildLevelsArgs): SRLevelsResult {
  const { symbol, tf, price, candles, zones, now } = args;
  const atr = Math.max(args.atr, price * 0.0008);
  const maxCeOi = Math.max(1, ...args.strikes.map((s) => s.ceOi));
  const maxPeOi = Math.max(1, ...args.strikes.map((s) => s.peOi));
  const matchTol = Math.max(atr * 0.5, price * 0.0015);

  const score = (zone: SRZone): { res: RawStrength; lc: ReturnType<typeof evolveLifecycle>; tracked: TrackedLevel; interactions: ZoneInteractionResult } => {
    const inp: StrengthInput = {
      zone,
      price,
      atr,
      candles,
      volumeCandles: args.volumeCandles,
      volumeSource: args.volumeSource ?? null,
      strikes: args.strikes,
      strikeStep: args.strikeStep,
      maxCeOi,
      maxPeOi,
      profile: args.profile,
      rvol: args.rvol,
      futuresBias: args.futuresBias,
      futures: args.futures ?? null,
      underlyingMove: args.underlyingMove ?? null,
      chainAgeSec: args.chainAgeSec,
    };
    const res = computeLevelStrength(inp);

    let tracked = matchTracked(symbol, tf, zone, matchTol);
    if (!tracked) {
      const id = registryKey(symbol, tf, zone.side, zone.mid, matchTol);
      tracked = {
        id,
        symbol,
        tf,
        side: zone.side,
        priceLow: zone.priceLow,
        priceHigh: zone.priceHigh,
        mid: zone.mid,
        anchorMid: zone.mid,
        boundaryChanges: 0,
        firstSeen: now,
        smoothed: null,
        history: [],
        lifecycle: "STABLE",
        lifecycleSince: now,
        pendingLifecycle: null,
        closesBeyond: 0,
        brokenAt: null,
        lastSeen: now,
      };
      registry.set(id, tracked);
    }
    // PRIORITY 8 — controlled boundaries. The original structural identity is
    // preserved and the band may only widen up to a hard cap, so repeated
    // interaction can never inflate a zone indefinitely.
    const maxHalfWidth = Math.max(atr * 0.6, price * 0.0025);
    const anchor = tracked.anchorMid;
    const newLow = Math.min(tracked.priceLow, zone.priceLow);
    const newHigh = Math.max(tracked.priceHigh, zone.priceHigh);
    const clampedLow = Math.max(newLow, anchor - maxHalfWidth);
    const clampedHigh = Math.min(newHigh, anchor + maxHalfWidth);
    if (clampedLow !== tracked.priceLow || clampedHigh !== tracked.priceHigh) {
      tracked.boundaryChanges++;
      tracked.priceLow = clampedLow;
      tracked.priceHigh = clampedHigh;
    }
    tracked.lastSeen = now;

    if (res.score != null) {
      tracked.smoothed =
        tracked.smoothed == null ? res.score : tracked.smoothed + SR_CONFIG.smoothing * (res.score - tracked.smoothed);
    }
    const lc = evolveLifecycle(tracked, res.score, inp, now);
    const interactions = interactionsFor(inp, candles);
    return { res, lc, tracked, interactions };
  };

  const scored = zones.map((z) => ({ zone: z, ...score(z) }));

  const toResult = (entry: (typeof scored)[number], role: LevelResult["role"]): LevelResult => {
    const { zone, res, lc, tracked } = entry;
    const smoothed = tracked.smoothed == null ? null : Math.round(tracked.smoothed);
    const cls = classifyStrength(smoothed);
    const label =
      `${role === "IMMEDIATE_RESISTANCE" ? "IR" : role === "PRIMARY_RESISTANCE" ? "PR" : role === "IMMEDIATE_SUPPORT" ? "IS" : "PS"} ` +
      `${zone.mid.toFixed(zone.mid >= 1000 ? 0 : 2)} | ${cls.replace("_", " ")}${smoothed != null ? ` ${smoothed}%` : ""}`;
    return {
      id: tracked.id,
      role,
      side: zone.side,
      price: Math.round(zone.mid * 100) / 100,
      zoneLow: Math.round(tracked.priceLow * 100) / 100,
      zoneHigh: Math.round(tracked.priceHigh * 100) / 100,
      distancePct: Math.round(((zone.mid - price) / price) * 10000) / 100,
      score: res.score,
      smoothedScore: smoothed,
      classification: cls,
      lifecycle: lc.lifecycle,
      lifecycleSince: tracked.lifecycleSince,
      scoreDelta: lc.delta == null ? null : Math.round(lc.delta * 10) / 10,
      risk: {
        kind: zone.side === "RESISTANCE" ? "BREAKOUT" : "BREAKDOWN",
        score: Math.round(lc.risk * 100),
        label: lc.risk >= 0.8 ? "HIGH" : lc.risk >= 0.6 ? "ELEVATED" : lc.risk >= 0.35 ? "MODERATE" : "LOW",
        isProbability: false,
      },
      coverage: Math.round(res.coverage * 100) / 100,
      coverageState: res.coverageState,
      evidence: res.evidence,
      positive: res.positive,
      negative: res.negative,
      missing: res.missing,
      sources: zone.sources,
      oiOnly: zone.oiOnly,
      touches: zone.touches,
      successfulTests: entry.interactions.successfulTests,
      acceptances: entry.interactions.acceptances,
      boundaryChanges: tracked.boundaryChanges,
      explanation: buildExplanation(role, zone.side, res, lc.lifecycle, lc.risk, lc.delta),
      style: lineStyleFor(zone.side, cls, lc.lifecycle, label),
    };
  };

  const active = scored.filter((s) => s.lc.lifecycle !== "BROKEN" && s.lc.lifecycle !== "INVALIDATED");
  const structural = active.filter((s) => !s.zone.oiOnly);

  const resistances = structural.filter((s) => s.zone.mid > price).sort((a, b) => a.zone.mid - b.zone.mid);
  const supports = structural.filter((s) => s.zone.mid < price).sort((a, b) => b.zone.mid - a.zone.mid);

  const ir = resistances[0] ?? null;
  const is = supports[0] ?? null;

  /** Primary = next DISTINCT, structurally significant zone beyond immediate. */
  const pickPrimary = (list: typeof resistances, immediate: (typeof resistances)[number] | null) => {
    if (!immediate) return null;
    const sep = Math.max(atr * 0.8, price * 0.002);
    const candidates = list.filter(
      (c) =>
        c !== immediate &&
        Math.abs(c.zone.mid - immediate.zone.mid) >= sep &&
        !(c.zone.priceLow <= immediate.zone.priceHigh && c.zone.priceHigh >= immediate.zone.priceLow),
    );
    if (!candidates.length) return null;
    // rank by structural significance: confluence sources, touches, strength
    return candidates
      .slice(0, 5)
      .map((c) => ({
        c,
        rank:
          (c.zone.sources.length >= 2 ? 2 : 0) +
          (c.zone.kind === "MULTI_SOURCE" ? 2 : 0) +
          Math.min(c.zone.touches, 3) +
          (c.tracked.smoothed ?? c.res.score ?? 0) / 40,
      }))
      .sort((a, b) => b.rank - a.rank)[0].c;
  };

  const pr = pickPrimary(resistances, ir);
  const ps = pickPrimary(supports, is);

  const out: SRLevelsResult = {
    immediateResistance: ir ? toResult(ir, "IMMEDIATE_RESISTANCE") : null,
    primaryResistance: pr ? toResult(pr, "PRIMARY_RESISTANCE") : null,
    immediateSupport: is ? toResult(is, "IMMEDIATE_SUPPORT") : null,
    primarySupport: ps ? toResult(ps, "PRIMARY_SUPPORT") : null,
    all: [],
    evaluatedZones: scored.length,
  };
  out.all = [out.immediateResistance, out.primaryResistance, out.immediateSupport, out.primarySupport].filter(
    (x): x is LevelResult => x != null,
  );
  return out;
}

/** Drop tracking for levels not seen recently (memory hygiene). */
export function pruneRegistry(maxAgeMs = 6 * 3600_000): number {
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  for (const [k, v] of registry) {
    if (v.lastSeen < cutoff) {
      registry.delete(k);
      n++;
    }
  }
  return n;
}

export function registrySize(): number {
  return registry.size;
}

/** Test seam — clears tracked lifecycle state. */
export function __resetRegistry(): void {
  registry.clear();
}
