/**
 * PULSEGRID 2.0 — OI Momentum Engine (exact methodology, Part 8).
 *
 * Rules enforced here:
 *  - Time-based rolling windows (never a fixed number of observations).
 *  - 5m change = current OI − OI approximately 5 minutes earlier.
 *  - 15m change = current OI − OI approximately 15 minutes earlier.
 *  - Session cumulative = current OI − fixed session baseline (never reset).
 *  - Combined total = valid pre-session reference + session cumulative change.
 *    If no valid pre-session reference exists → UNAVAILABLE (never invented).
 *  - If a historical reference is missing or stale → N/A.
 */

export interface OIObs {
  ts: number;
  oi: number;
  ltp?: number;
  volume?: number;
}

export interface OIMomentumResult {
  currentOi: number;
  oiChange5m: number | null;
  oiChange15m: number | null;
  sessionChange: number | null;
  combinedTotalOi: number | null;
  baselineTs: number | null;
  refTs5m: number | null;
  refTs15m: number | null;
  historySufficient: boolean;
}

const MATCH_TOLERANCE_MS = 90_000; // nearest observation must be within 90s of target
const MAX_STALE_MS = 10 * 60_000; // never use a reference older than target by >10m beyond window

/**
 * Find the observation closest to `target` at-or-before it.
 * Returns null when no observation exists within tolerance — the caller must
 * then surface N/A instead of guessing.
 */
export function oiAt(obs: OIObs[], target: number, toleranceMs = MATCH_TOLERANCE_MS): OIObs | null {
  if (!obs.length) return null;
  // binary search for last obs <= target
  let lo = 0,
    hi = obs.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid].ts <= target) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best >= 0 && target - obs[best].ts <= toleranceMs) return obs[best];
  // also accept the first observation just after target if within tolerance
  const next = best + 1 < obs.length ? obs[best + 1] : null;
  if (next && next.ts - target <= toleranceMs) return next;
  return null;
}

/** 5-minute / 15-minute rolling change — time-based, tolerance-bounded. */
export function rollingOiChange(obs: OIObs[], now: number, minutes: number): { change: number | null; refTs: number | null } {
  if (obs.length < 2) return { change: null, refTs: null };
  const current = obs[obs.length - 1];
  const target = now - minutes * 60_000;
  const ref = oiAt(obs, target);
  if (!ref) return { change: null, refTs: null };
  if (now - target > minutes * 60_000 + MAX_STALE_MS) return { change: null, refTs: null };
  return { change: current.oi - ref.oi, refTs: ref.ts };
}

/** Session cumulative change against a fixed, valid baseline. */
export function sessionCumulativeChange(currentOi: number | null, baselineOi: number | null): number | null {
  if (currentOi == null || baselineOi == null) return null;
  return currentOi - baselineOi;
}

/**
 * Combined total OI = valid pre-session reference OI + session cumulative change.
 * Returns null when the pre-session reference is unavailable.
 */
export function combinedTotalOi(prevSessionRef: number | null, sessionChange: number | null): number | null {
  if (prevSessionRef == null || sessionChange == null) return null;
  return prevSessionRef + sessionChange;
}

/** Compute the full OI momentum block for one contract. */
export function computeOiMomentum(
  obs: OIObs[],
  baselineOi: number | null,
  prevSessionRef: number | null,
  now = Date.now(),
): OIMomentumResult {
  const currentOi = obs.length ? obs[obs.length - 1].oi : NaN;
  const c5 = rollingOiChange(obs, now, 5);
  const c15 = rollingOiChange(obs, now, 15);
  const sess = sessionCumulativeChange(Number.isFinite(currentOi) ? currentOi : null, baselineOi);
  return {
    currentOi,
    oiChange5m: c5.change,
    oiChange15m: c15.change,
    sessionChange: sess,
    combinedTotalOi: combinedTotalOi(prevSessionRef, sess),
    baselineTs: obs.length ? obs[0].ts : null,
    refTs5m: c5.refTs,
    refTs15m: c15.refTs,
    historySufficient: c5.change != null && c15.change != null && sess != null,
  };
}

export type OIInterpretation =
  | "CE_ADDITION"
  | "CE_UNWINDING"
  | "PE_ADDITION"
  | "PE_UNWINDING"
  | "BALANCED"
  | "BULLISH_SHIFT"
  | "BEARISH_SHIFT"
  | "DIVERGENCE"
  | "MIXED"
  | "INSUFFICIENT_HISTORY";

/**
 * Classification across CE and PE near-ATM activity. OI changes alone never
 * assert participant intent — premium response and price move decide shifts.
 */
export function classifyOiShift(args: {
  ceSess: number | null;
  peSess: number | null;
  cePremChgPct: number | null;
  pePremChgPct: number | null;
  underlyingChgPct: number | null;
}): OIInterpretation {
  const { ceSess, peSess, cePremChgPct, pePremChgPct, underlyingChgPct } = args;
  if (ceSess == null || peSess == null) return "INSUFFICIENT_HISTORY";
  const ceAdd = ceSess > 0;
  const peAdd = peSess > 0;
  const mag = Math.abs(ceSess) + Math.abs(peSess);
  if (mag < 1) return "BALANCED";
  const ratio = Math.min(Math.abs(ceSess), Math.abs(peSess)) / Math.max(Math.abs(ceSess), Math.abs(peSess), 1);
  if (ratio > 0.75 && ceAdd === peAdd) return "BALANCED";

  const priceUp = (underlyingChgPct ?? 0) > 0.05;
  const priceDn = (underlyingChgPct ?? 0) < -0.05;
  // PE additions with firm price = potential support building (not proof).
  if (peAdd && !ceAdd && (priceUp || (pePremChgPct ?? 0) < (cePremChgPct ?? 0))) return "BULLISH_SHIFT";
  if (ceAdd && !peAdd && (priceDn || (cePremChgPct ?? 0) < (pePremChgPct ?? 0))) return "BEARISH_SHIFT";
  if (!ceAdd && !peAdd) {
    if (priceUp) return "BULLISH_SHIFT"; // CE unwinding + price up = short covering tilt
    if (priceDn) return "BEARISH_SHIFT";
    return "MIXED";
  }
  if (ceAdd && peAdd) return priceUp || priceDn ? "DIVERGENCE" : "BALANCED";
  return "MIXED";
}

/** Per-side state used by the OI Momentum UI chips. */
export function sideOiState(sessChange: number | null): "ADDITION" | "UNWINDING" | "FLAT" | "NA" {
  if (sessChange == null) return "NA";
  if (sessChange > 0) return "ADDITION";
  if (sessChange < 0) return "UNWINDING";
  return "FLAT";
}
