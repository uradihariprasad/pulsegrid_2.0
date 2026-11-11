/**
 * PULSEGRID 2.0 — direction-aware zone interaction classifier.
 *
 * SINGLE source of truth for "did price actually respect this level?".
 * Both the S/R candidate builder (sr.ts) and the strength engine
 * (sr-strength.ts) consume this, so a breakout can never be counted as a
 * rejection in one place and a breakout in another.
 *
 * Core correctness rules:
 *  - A RESISTANCE rejection requires a close back BELOW the zone. A close
 *    above the zone is ACCEPTANCE (negative evidence), never a "reaction".
 *  - A SUPPORT defense requires a close back ABOVE the zone. A close below
 *    the zone is ACCEPTANCE (negative evidence).
 *  - Consecutive candles inside the same zone form ONE test event; a new test
 *    is only counted after price meaningfully leaves and returns.
 */
import type { Candle } from "./types";

export type ZoneSideLite = "SUPPORT" | "RESISTANCE";

export type InteractionOutcome =
  | "REJECTION"        // defended: closed back on the protected side
  | "FAILED_BREAK"     // pierced beyond, then closed back — strongest defence
  | "ACCEPTANCE"       // closed beyond the zone (level is losing control)
  | "CONFIRMED_BREAK"  // acceptance with follow-through closes
  | "BREAK_ATTEMPT"    // pierced but closed inside the zone — undecided
  | "NO_REACTION";     // touched, closed inside, no meaningful response

export interface ZoneTestEvent {
  startIdx: number;
  endIdx: number;
  startTs: number;
  endTs: number;
  outcome: InteractionOutcome;
  /** how far price pierced beyond the zone, in ATR units */
  penetrationAtr: number;
  /** how far price travelled away from the zone afterwards, in ATR units */
  reactionAtr: number;
  /** share of the bar's range that was rejection wick (0..1) */
  wickRatio: number;
  barsInside: number;
  volume: number;
  /** 0..1 reaction quality — acceptance scores 0 */
  quality: number;
  /** true when this event defended the level */
  successful: boolean;
}

export interface ZoneInteractionResult {
  events: ZoneTestEvent[];
  /** independent successful defences (REJECTION + FAILED_BREAK) */
  successfulTests: number;
  /** independent acceptances beyond the zone */
  acceptances: number;
  confirmedBreak: boolean;
  lastTestTs: number | null;
  /** mean quality of successful defences, 0 when none */
  meanQuality: number;
  /** >0 improving defence, <0 declining defence across successive tests */
  qualityTrend: number;
}

export interface InteractionOptions {
  /** bars of separation required before a retest counts independently */
  gapBars?: number;
  /** price must travel this far (ATR units) away before a retest counts */
  leaveAtr?: number;
  /** closes beyond the zone required to call a break confirmed */
  confirmCloses?: number;
  /** look-ahead window used to confirm a break */
  lookAhead?: number;
}

const DEFAULTS: Required<InteractionOptions> = { gapBars: 3, leaveAtr: 0.35, confirmCloses: 2, lookAhead: 4 };

/**
 * Classify every independent interaction between price and a zone.
 *
 * `zoneLow`/`zoneHigh` are the zone boundaries; `tol` widens the touch test
 * only (it never changes where "beyond the zone" begins).
 */
export function analyzeZoneInteractions(
  candles: Candle[],
  zoneLow: number,
  zoneHigh: number,
  side: ZoneSideLite,
  atr: number,
  tol: number,
  opts: InteractionOptions = {},
): ZoneInteractionResult {
  const o = { ...DEFAULTS, ...opts };
  const a = Math.max(atr, 1e-9);
  const isRes = side === "RESISTANCE";

  // ---- 1. find bars that interact with the zone --------------------------
  const touching: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.h < zoneLow - tol || c.l > zoneHigh + tol) continue;
    touching.push(i);
  }
  if (!touching.length)
    return { events: [], successfulTests: 0, acceptances: 0, confirmedBreak: false, lastTestTs: null, meanQuality: 0, qualityTrend: 0 };

  // ---- 2. group consecutive bars into ONE test event ---------------------
  //    A new group only starts once price has both separated in time AND
  //    travelled meaningfully away from the zone — this prevents a long
  //    consolidation inside the zone from inflating the test count.
  const groups: number[][] = [];
  for (const i of touching) {
    const last = groups[groups.length - 1];
    if (!last) {
      groups.push([i]);
      continue;
    }
    const prev = last[last.length - 1];
    if (i - prev <= o.gapBars) {
      last.push(i);
      continue;
    }
    // did price actually leave the zone between the two touches?
    let maxAway = 0;
    for (let k = prev + 1; k < i; k++) {
      const c = candles[k];
      const away = isRes ? zoneLow - c.h : c.l - zoneHigh;
      maxAway = Math.max(maxAway, away);
    }
    if (maxAway / a >= o.leaveAtr) groups.push([i]);
    else last.push(i); // never really left — same interaction
  }

  // ---- 3. classify each group -------------------------------------------
  const events: ZoneTestEvent[] = [];
  for (const g of groups) {
    const startIdx = g[0];
    const endIdx = g[g.length - 1];
    const bars = g.map((i) => candles[i]);
    const lastBar = candles[endIdx];

    // deepest penetration beyond the protected boundary
    let penetration = 0;
    for (const c of bars) penetration = Math.max(penetration, isRes ? c.h - zoneHigh : zoneLow - c.l);
    const penetrationAtr = Math.max(0, penetration) / a;

    const pierced = penetration > 0;
    const closedBack = isRes ? lastBar.c < zoneLow : lastBar.c > zoneHigh;
    const closedBeyond = isRes ? lastBar.c > zoneHigh : lastBar.c < zoneLow;

    // follow-through look-ahead decides ACCEPTANCE vs CONFIRMED_BREAK
    let beyondCloses = 0;
    for (let k = endIdx + 1; k <= Math.min(endIdx + o.lookAhead, candles.length - 1); k++) {
      const c = candles[k];
      if (isRes ? c.c > zoneHigh : c.c < zoneLow) beyondCloses++;
    }

    let outcome: InteractionOutcome;
    if (closedBeyond) outcome = beyondCloses >= o.confirmCloses ? "CONFIRMED_BREAK" : "ACCEPTANCE";
    else if (closedBack) outcome = pierced ? "FAILED_BREAK" : "REJECTION";
    else outcome = pierced ? "BREAK_ATTEMPT" : "NO_REACTION";

    // how far price travelled away after the interaction (defence follow-through)
    let reaction = 0;
    for (let k = endIdx + 1; k <= Math.min(endIdx + o.lookAhead, candles.length - 1); k++) {
      const c = candles[k];
      reaction = Math.max(reaction, isRes ? zoneLow - c.l : c.h - zoneHigh);
    }
    const reactionAtr = Math.max(0, reaction) / a;

    // rejection wick share on the most extreme bar of the group
    let wickRatio = 0;
    for (const c of bars) {
      const range = Math.max(c.h - c.l, 1e-9);
      const w = isRes ? (c.h - Math.max(c.o, c.c)) / range : (Math.min(c.o, c.c) - c.l) / range;
      wickRatio = Math.max(wickRatio, Math.min(Math.max(w, 0), 1));
    }

    const volume = bars.reduce((s, c) => s + c.v, 0);
    const barsInside = bars.length;

    // ---- reaction quality -----------------------------------------------
    // Acceptance is NEGATIVE evidence and scores zero; it must never add
    // "test count" strength to the level.
    let quality: number;
    switch (outcome) {
      case "FAILED_BREAK":
        quality = 0.7 + 0.3 * Math.min(reactionAtr / 1.5, 1);
        break;
      case "REJECTION":
        quality = 0.45 + 0.3 * Math.min(reactionAtr / 1.5, 1) + 0.25 * wickRatio;
        break;
      case "BREAK_ATTEMPT":
        quality = 0.25;
        break;
      case "NO_REACTION":
        quality = 0.12;
        break;
      default:
        quality = 0; // ACCEPTANCE / CONFIRMED_BREAK
    }
    // lingering inside the zone weakens the quality of the defence
    if (barsInside > 4) quality *= Math.max(0.5, 1 - (barsInside - 4) * 0.08);
    quality = Math.min(Math.max(quality, 0), 1);

    events.push({
      startIdx,
      endIdx,
      startTs: candles[startIdx].ts,
      endTs: lastBar.ts,
      outcome,
      penetrationAtr,
      reactionAtr,
      wickRatio,
      barsInside,
      volume,
      quality,
      successful: outcome === "REJECTION" || outcome === "FAILED_BREAK",
    });
  }

  const successes = events.filter((e) => e.successful);
  const acceptances = events.filter((e) => e.outcome === "ACCEPTANCE" || e.outcome === "CONFIRMED_BREAK").length;
  const meanQuality = successes.length ? successes.reduce((s, e) => s + e.quality, 0) / successes.length : 0;

  // declining vs improving defence across successive INDEPENDENT tests
  let qualityTrend = 0;
  const scored = events.filter((e) => e.outcome !== "NO_REACTION");
  if (scored.length >= 2) {
    const half = Math.ceil(scored.length / 2);
    const first = scored.slice(0, half);
    const last = scored.slice(half);
    const avg = (xs: ZoneTestEvent[]) => xs.reduce((s, e) => s + e.quality, 0) / Math.max(xs.length, 1);
    qualityTrend = avg(last) - avg(first);
  }

  return {
    events,
    successfulTests: successes.length,
    acceptances,
    confirmedBreak: events.some((e) => e.outcome === "CONFIRMED_BREAK"),
    lastTestTs: events.length ? events[events.length - 1].endTs : null,
    meanQuality,
    qualityTrend,
  };
}

/** IST calendar day for a timestamp (session identity). */
export function sessionOf(ts: number): string {
  return new Date(ts + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 10);
}

/** Restrict candles to the most recent session present in the series. */
export function currentSessionCandles(candles: Candle[]): Candle[] {
  if (!candles.length) return [];
  const last = sessionOf(candles[candles.length - 1].ts);
  return candles.filter((c) => sessionOf(c.ts) === last);
}
