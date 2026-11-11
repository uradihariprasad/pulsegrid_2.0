/**
 * PULSEGRID 2.0 — Scanner, Buyer/Seller Dominance, Trade Finder, and
 * Target/Reversal/Invalidation engines.
 *
 * Trade Finder rules (Part 17):
 *  - An options trade can NEVER be confirmed solely from EMA or spot movement.
 *  - Mandatory gates: valid underlying data, valid contract + premium,
 *    acceptable liquidity, derivatives evidence, price/structure confirmation,
 *    entry trigger, stop, targets, invalidation.
 *  - RR is computed from the PROPOSED entry, not current LTP.
 *  - When gates fail the output is WATCH or WAIT — never a forced trade list.
 */
import type { FuturesClass, FMPIOutput } from "./fmpi";
import type { SRZone } from "./sr";
import { clamp } from "./indicators";

export interface SymbolIntel {
  symbol: string;
  name: string;
  sector: string;
  segment: "INDEX" | "EQUITY";
  ltp: number;
  chgPct: number;
  volume: number;
  rvol: number | null;
  vwap: number | null;
  emaAlign: number | null; // -1..+1
  structureTrend: "UP" | "DOWN" | "RANGE" | null;
  fut: {
    /** REAL Upstox instrument key for the futures contract — never constructed */
    instrumentKey: string;
    expiry: string;
    ltp: number;
    chgPct: number;
    oiChgPct: number;
    oi: number;
    classification: FuturesClass;
    basis: number | null;
    lotSize: number;
  } | null;
  fmpi: FMPIOutput | null;
  sr: {
    immediateSupport: SRZone | null;
    primaryResistance: SRZone | null;
    immediateResistance: SRZone | null;
    primarySupport: SRZone | null;
  } | null;
  chain: {
    atm: number;
    bestCe: BestStrike | null;
    bestPe: BestStrike | null;
  } | null;
  freshness: string;
  atr: number | null;
  /** data-coverage state from the store (COMPLETE|PARTIAL|DELAYED|UNAVAILABLE) */
  coverage?: { level: string; missing: string[]; chain: boolean; futures: boolean; candles: boolean };
}

export interface BestStrike {
  strike: number;
  score: number;
  ltp: number;
  spreadPct: number;
  volume: number;
  premChgPct: number;
  oiSessChg: number | null;
  expiry: string;
  /** REAL Upstox instrument key */
  key: string;
  /** provider-supplied delta; null when unavailable (never assumed) */
  delta: number | null;
  oi: number;
  reason?: string;
  confirmations?: string[];
}

/**
 * PRIORITY 6A — directional OI confirmation.
 * Non-null OI is NOT confirmation. We require a price/OI relationship that is
 * consistent with the trade direction, corroborated by option-chain activity.
 * These are positioning interpretations, not predictions.
 */
export type OIConfirmation = "CONFIRMED" | "CONTRADICTS" | "INCONCLUSIVE" | "UNAVAILABLE";

export function confirmOi(args: {
  direction: "LONG" | "SHORT";
  futClass: FuturesClass | null;
  futOiChgPct: number | null;
  priceChgPct: number | null;
  ceOiSessChg: number | null;
  peOiSessChg: number | null;
}): { state: OIConfirmation; detail: string } {
  const { direction, futClass, futOiChgPct, priceChgPct, ceOiSessChg, peOiSessChg } = args;
  if (futClass == null || futClass === "UNAVAILABLE" || futOiChgPct == null || priceChgPct == null)
    return { state: "UNAVAILABLE", detail: "Futures price/OI reference missing" };

  const bullishPositioning = futClass === "LONG_BUILDUP" || futClass === "SHORT_COVERING";
  const bearishPositioning = futClass === "SHORT_BUILDUP" || futClass === "LONG_UNWINDING";
  const aligned = direction === "LONG" ? bullishPositioning : bearishPositioning;
  const opposed = direction === "LONG" ? bearishPositioning : bullishPositioning;

  // option-chain corroboration (independent evidence family)
  let optionAgrees: boolean | null = null;
  if (ceOiSessChg != null && peOiSessChg != null) {
    // PE additions with firm price lean bullish; CE additions lean bearish
    const lean = Math.sign(peOiSessChg) - Math.sign(ceOiSessChg);
    optionAgrees = direction === "LONG" ? lean > 0 : lean < 0;
  }

  if (opposed) return { state: "CONTRADICTS", detail: `Futures ${futClass.replaceAll("_", " ").toLowerCase()} opposes a ${direction.toLowerCase()}` };
  if (!aligned) return { state: "INCONCLUSIVE", detail: `Futures positioning neutral (${futClass})` };
  if (Math.abs(futOiChgPct) < 0.25) return { state: "INCONCLUSIVE", detail: "Futures OI change too small to be decisive" };
  if (optionAgrees === false) return { state: "INCONCLUSIVE", detail: "Futures positioning aligned but option-chain OI disagrees" };
  return {
    state: "CONFIRMED",
    detail: `Futures ${futClass.replaceAll("_", " ").toLowerCase()} (${futOiChgPct.toFixed(2)}% OI)${optionAgrees ? " + option-chain agreement" : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
export const SCANNER_CATEGORIES = [
  "STRONG_BULLISH",
  "BULLISH_MOMENTUM",
  "STRONG_BEARISH",
  "BEARISH_MOMENTUM",
  "VOLUME_BREAKOUT",
  "OI_BREAKOUT",
  "FUTURES_LONG_BUILDUP",
  "FUTURES_SHORT_BUILDUP",
  "LONG_UNWINDING",
  "SHORT_COVERING",
  "PRICE_OI_DIVERGENCE",
  "HIGH_RVOL",
  "MOMENTUM_REVERSAL_WATCH",
] as const;

export type ScannerCategory = (typeof SCANNER_CATEGORIES)[number];

export interface ScannerRow {
  category: ScannerCategory;
  symbol: string;
  ltp: number;
  chgPct: number;
  volume: number;
  rvol: number | null;
  oiChgPct: number | null;
  futuresDir: string;
  vwapSide: "ABOVE" | "BELOW" | "NA";
  emaAlign: number | null;
  structure: string | null;
  fmpi: number | null;
  score: number;
  coverage: number;
  freshness: string;
}

export function scanSymbol(s: SymbolIntel): ScannerRow[] {
  const rows: ScannerRow[] = [];
  const fmpiV = s.fmpi?.value ?? null;
  const coverage = s.fmpi?.coverage ?? 0.4;
  const oiChgPct = s.fut?.oiChgPct ?? null;
  const base = {
    symbol: s.symbol,
    ltp: s.ltp,
    chgPct: s.chgPct,
    volume: s.volume,
    rvol: s.rvol,
    oiChgPct,
    futuresDir: s.fut?.classification ?? "UNAVAILABLE",
    vwapSide: s.vwap == null ? ("NA" as const) : s.ltp >= s.vwap ? ("ABOVE" as const) : ("BELOW" as const),
    emaAlign: s.emaAlign,
    structure: s.structureTrend,
    fmpi: fmpiV,
    coverage,
    freshness: s.freshness,
  };
  const push = (category: ScannerCategory, score: number) =>
    rows.push({ ...base, category, score: Math.round(clamp(score, 1, 99)) });

  const fm = fmpiV ?? 0;
  const strong = (s.fmpi?.thresholds.strong ?? 45);
  if (fm >= strong && (s.fut?.classification === "LONG_BUILDUP" || s.fmpi!.classification !== "NEUTRAL")) push("STRONG_BULLISH", 60 + fm * 0.4);
  if (fm > 8 && fm < strong && s.chgPct > 0) push("BULLISH_MOMENTUM", 45 + fm * 0.5);
  if (fm <= -strong) push("STRONG_BEARISH", 60 - fm * 0.4);
  if (fm < -8 && fm > -strong && s.chgPct < 0) push("BEARISH_MOMENTUM", 45 - fm * 0.5);
  if (s.rvol != null && s.rvol > 1.8 && Math.abs(s.chgPct) > 0.4) push("VOLUME_BREAKOUT", 50 + Math.min(s.rvol, 5) * 8);
  if (oiChgPct != null && Math.abs(oiChgPct) > 2.5) push("OI_BREAKOUT", 55 + Math.min(Math.abs(oiChgPct), 10) * 3);
  if (s.fut?.classification === "LONG_BUILDUP") push("FUTURES_LONG_BUILDUP", 58 + Math.abs(s.fut.oiChgPct) * 4);
  if (s.fut?.classification === "SHORT_BUILDUP") push("FUTURES_SHORT_BUILDUP", 58 + Math.abs(s.fut.oiChgPct) * 4);
  if (s.fut?.classification === "LONG_UNWINDING") push("LONG_UNWINDING", 52 + Math.abs(s.fut.oiChgPct) * 4);
  if (s.fut?.classification === "SHORT_COVERING") push("SHORT_COVERING", 52 + Math.abs(s.fut.oiChgPct) * 4);
  if (s.fut && Math.sign(s.fut.chgPct) !== Math.sign(s.fut.oiChgPct) && Math.abs(s.fut.oiChgPct) > 1) push("PRICE_OI_DIVERGENCE", 50);
  if (s.rvol != null && s.rvol > 2.5) push("HIGH_RVOL", 45 + Math.min(s.rvol, 6) * 7);
  if (s.fmpi && (s.fmpi.divergence !== "NONE" || s.fmpi.exhaustionCandidate)) push("MOMENTUM_REVERSAL_WATCH", 55);
  return rows;
}

// ---------------------------------------------------------------------------
// Buyer / Seller dominance — directional evidence labels, not identity claims
// ---------------------------------------------------------------------------
export interface DominanceRow {
  symbol: string;
  ltp: number;
  chgPct: number;
  volume: number;
  rvol: number | null;
  futuresBuildup: string;
  cePePositioning: string;
  fmpi: number | null;
  momentumScore: number;
  coverage: number;
  classification: "BUYER_DOMINANT" | "SELLER_DOMINANT";
  evidence: string[];
}

export function dominanceRows(intel: SymbolIntel[]): { buyers: DominanceRow[]; sellers: DominanceRow[] } {
  const buyers: DominanceRow[] = [];
  const sellers: DominanceRow[] = [];
  for (const s of intel) {
    if (s.segment !== "EQUITY") continue;
    const ev: string[] = [];
    let score = 0;
    if (s.chgPct > 0.3) {
      score += s.chgPct;
      ev.push(`Price +${s.chgPct.toFixed(2)}%`);
    } else if (s.chgPct < -0.3) {
      score -= Math.abs(s.chgPct);
      ev.push(`Price ${s.chgPct.toFixed(2)}%`);
    }
    if (s.rvol != null && s.rvol > 1.3) {
      score += Math.sign(score || s.chgPct) * Math.min(s.rvol - 1, 2) * 2;
      ev.push(`RVOL ${s.rvol.toFixed(1)}×`);
    }
    if (s.fut) {
      if (s.fut.classification === "LONG_BUILDUP") {
        score += 2.2;
        ev.push("Futures long buildup");
      } else if (s.fut.classification === "SHORT_COVERING") {
        score += 1.4;
        ev.push("Futures short covering");
      } else if (s.fut.classification === "SHORT_BUILDUP") {
        score -= 2.2;
        ev.push("Futures short buildup");
      } else if (s.fut.classification === "LONG_UNWINDING") {
        score -= 1.4;
        ev.push("Futures long unwinding");
      }
    }
    if (s.vwap != null) {
      if (s.ltp > s.vwap) {
        score += 0.8;
        ev.push("Above VWAP");
      } else {
        score -= 0.8;
        ev.push("Below VWAP");
      }
    }
    if (s.structureTrend === "UP") {
      score += 0.9;
      ev.push("Bullish structure");
    } else if (s.structureTrend === "DOWN") {
      score -= 0.9;
      ev.push("Bearish structure");
    }
    if (s.fmpi) score += (s.fmpi.value / 100) * 2.5;
    const cePe =
      s.chain?.bestCe && s.chain?.bestPe
        ? `CE ΔOI ${fmtChg(s.chain.bestCe.oiSessChg)} / PE ΔOI ${fmtChg(s.chain.bestPe.oiSessChg)}`
        : "CE/PE positioning n/a";
    const row: DominanceRow = {
      symbol: s.symbol,
      ltp: s.ltp,
      chgPct: s.chgPct,
      volume: s.volume,
      rvol: s.rvol,
      futuresBuildup: s.fut?.classification ?? "UNAVAILABLE",
      cePePositioning: cePe,
      fmpi: s.fmpi?.value ?? null,
      momentumScore: Math.round(score * 10) / 10,
      coverage: s.fmpi?.coverage ?? 0.4,
      classification: score > 0 ? "BUYER_DOMINANT" : "SELLER_DOMINANT",
      evidence: ev,
    };
    if (score >= 2.4) buyers.push(row);
    else if (score <= -2.4) sellers.push(row);
  }
  buyers.sort((a, b) => b.momentumScore - a.momentumScore);
  sellers.sort((a, b) => a.momentumScore - b.momentumScore);
  return { buyers: buyers.slice(0, 12), sellers: sellers.slice(0, 12) };
}

function fmtChg(v: number | null): string {
  if (v == null) return "n/a";
  return `${v > 0 ? "+" : ""}${Math.round(v / 1000)}k`;
}

// ---------------------------------------------------------------------------
// Trade Finder
// ---------------------------------------------------------------------------
export interface TradeCandidate {
  rank: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  category: "BULLISH_CE" | "BEARISH_PE" | "BULLISH_FUT" | "BEARISH_FUT" | "BREAKOUT" | "BREAKDOWN" | "REVERSAL_WATCH" | "MOMENTUM_CONTINUATION";
  instrumentType: "CE" | "PE" | "FUT";
  contractKey: string;
  expiry: string | null;
  strike: number | null;
  entryType: "IMMEDIATE" | "BREAKOUT_TRIGGER" | "BREAKDOWN_TRIGGER" | "RETEST" | "REVERSAL_CONFIRMATION";
  entry: number;
  stopLoss: number;
  target1: number | null;
  target2: number | null;
  targetExt: number | null;
  rr: number | null;
  score: number;
  coverage: number;
  /** store-level data coverage: COMPLETE|PARTIAL|DELAYED|UNAVAILABLE */
  dataCoverage: string;
  freshness: string;
  status: "ACTIONABLE" | "WATCH" | "WAIT" | "INVALIDATED";
  fmpi: number | null;
  oiConfirmation: OIConfirmation;
  oiConfirmationDetail: string;
  futConfirmed: boolean;
  /** UPSTOX_PROVIDED | UNAVAILABLE | N_A */
  deltaSource: string;
  srConfluence: number | null;
  structure: string | null;
  invalidation: string;
  rationale: string[];
  gatesFailed: string[];
}

export interface TradeFinderOutput {
  /** ACTIONABLE only */
  bullish: TradeCandidate[];
  bearish: TradeCandidate[];
  /** candidates that passed hard gates but are NOT actionable */
  watch: TradeCandidate[];
  wait: { symbol: string; reason: string }[];
  waitSummary: string;
  counts: { actionable: number; watch: number; rejected: number };
}

/** Build SL/targets from zones (for the underlying), then map to premium for options. */
function underlyingStops(s: SymbolIntel, side: "LONG" | "SHORT") {
  const atrv = s.atr ?? s.ltp * 0.006;
  if (side === "LONG") {
    const slZone = s.sr?.immediateSupport ?? s.sr?.primarySupport ?? null;
    const sl = slZone ? slZone.priceLow - atrv * 0.25 : s.ltp - atrv * 1.1;
    const r1 = s.sr?.immediateResistance?.mid ?? s.ltp + atrv * 1.5;
    const r2 = s.sr?.primaryResistance?.mid ?? s.ltp + atrv * 2.4;
    return { sl: Math.min(sl, s.ltp - atrv * 0.3), t1: Math.max(r1, s.ltp + atrv * 0.8), t2: Math.max(r2, s.ltp + atrv * 1.6), te: s.ltp + atrv * 3.5, atr: atrv };
  }
  const slZone = s.sr?.immediateResistance ?? s.sr?.primaryResistance ?? null;
  const sl = slZone ? slZone.priceHigh + atrv * 0.25 : s.ltp + atrv * 1.1;
  const s1 = s.sr?.immediateSupport?.mid ?? s.ltp - atrv * 1.5;
  const s2 = s.sr?.primarySupport?.mid ?? s.ltp - atrv * 2.4;
  return { sl: Math.max(sl, s.ltp + atrv * 0.3), t1: Math.min(s1, s.ltp - atrv * 0.8), t2: Math.min(s2, s.ltp - atrv * 1.6), te: s.ltp - atrv * 3.5, atr: atrv };
}

export function evaluateSymbol(s: SymbolIntel, indexContext: { niftyDir: number }): { trades: TradeCandidate[]; waits: { symbol: string; reason: string }[] } {
  void indexContext;
  const trades: TradeCandidate[] = [];
  const waits: { symbol: string; reason: string }[] = [];
  const fmpi = s.fmpi;
  if (!fmpi) {
    waits.push({ symbol: s.symbol, reason: "FMPI unavailable — insufficient computed evidence" });
    return { trades, waits };
  }
  // PRIORITY 1/6: only LIVE data may back an actionable signal.
  if (s.freshness !== "LIVE" && s.freshness !== "DELAYED") {
    waits.push({ symbol: s.symbol, reason: `Market data ${String(s.freshness).toLowerCase()} — real-time claims invalidated` });
    return { trades, waits };
  }
  const cov = s.coverage?.level ?? "PARTIAL";
  if (cov === "UNAVAILABLE") {
    waits.push({ symbol: s.symbol, reason: "Essential market data unavailable for this underlying" });
    return { trades, waits };
  }

  const fm = fmpi.value;
  const dir: "LONG" | "SHORT" | null = fm >= fmpi.thresholds.moderate ? "LONG" : fm <= -fmpi.thresholds.moderate ? "SHORT" : null;
  if (!dir) {
    if (s.sr?.immediateSupport && s.sr?.immediateResistance) {
      const mid = (s.sr.immediateSupport.mid + s.sr.immediateResistance.mid) / 2;
      if (Math.abs(s.ltp - mid) / s.ltp < 0.0025)
        waits.push({ symbol: s.symbol, reason: "Price in the middle of range — no edge at current location" });
    }
    return { trades, waits };
  }

  // ---- shared evidence -----------------------------------------------------
  const oiConf = confirmOi({
    direction: dir,
    futClass: s.fut?.classification ?? null,
    futOiChgPct: s.fut?.oiChgPct ?? null,
    priceChgPct: s.chgPct,
    ceOiSessChg: s.chain?.bestCe?.oiSessChg ?? null,
    peOiSessChg: s.chain?.bestPe?.oiSessChg ?? null,
  });
  const st = underlyingStops(s, dir);
  const structureAligned = s.structureTrend === (dir === "LONG" ? "UP" : "DOWN");
  // Levels must come from real zones. A pure ATR projection is not a
  // structural target, so such setups can only ever be WATCH.
  const hasStructuralLevels =
    dir === "LONG"
      ? !!(s.sr?.immediateSupport && (s.sr?.immediateResistance || s.sr?.primaryResistance))
      : !!(s.sr?.immediateResistance && (s.sr?.immediateSupport || s.sr?.primarySupport));
  const freshnessActionable = s.freshness === "LIVE";

  /** Decide final status from gate severity. */
  const statusFor = (blocking: string[], soft: string[]): "ACTIONABLE" | "WATCH" | null => {
    if (blocking.length) return null;                       // not a candidate at all
    if (soft.length || !freshnessActionable || cov !== "COMPLETE" || fmpi.coverage < 0.6) return "WATCH";
    return "ACTIONABLE";
  };

  // ---------------------------------------------------------------- OPTIONS
  const opt = dir === "LONG" ? s.chain?.bestCe : s.chain?.bestPe;
  if (opt && s.chain) {
    const blocking: string[] = [];
    const soft: string[] = [];
    const rationale: string[] = [];

    // real contract validation
    if (!opt.key || !opt.key.includes("|")) blocking.push("Option contract key is not a valid Upstox instrument key");
    if (!opt.expiry) blocking.push("Option expiry missing");
    if (!Number.isFinite(opt.strike) || opt.strike <= 0) blocking.push("Option strike missing");
    if (!Number.isFinite(opt.ltp) || opt.ltp <= 0) blocking.push("Option premium unavailable");

    // liquidity
    if (!Number.isFinite(opt.spreadPct)) soft.push("Option spread unknown");
    else if (opt.spreadPct > 1.8) blocking.push(`Spread ${opt.spreadPct.toFixed(1)}% excessive (>1.8%)`);
    if (opt.volume <= 0) blocking.push("No traded volume in the candidate contract");

    // derivatives evidence
    if (opt.premChgPct > 1.5) rationale.push(`Premium momentum +${opt.premChgPct.toFixed(1)}%`);
    else blocking.push("Option premium momentum not confirming");
    if (opt.oiSessChg == null) soft.push("Session OI baseline unavailable for this contract");

    // PRIORITY 6A — real OI confirmation
    if (oiConf.state === "CONFIRMED") rationale.push(oiConf.detail);
    else if (oiConf.state === "CONTRADICTS") blocking.push(oiConf.detail);
    else soft.push(oiConf.detail);

    if (structureAligned) rationale.push("Market structure aligned");
    else blocking.push("Market structure not aligned");

    // PRIORITY 6C — projections need a REAL delta
    const delta = opt.delta != null && Number.isFinite(opt.delta) ? Math.abs(opt.delta) : null;
    if (delta == null) soft.push("Provider delta unavailable — premium targets not projected");

    if (!hasStructuralLevels) soft.push("No structural S/R levels — ATR projection only");
    // premium stop is delta-consistent with the underlying stop (same basis as
    // the targets), not an arbitrary percentage of the premium
    const undRisk = Math.abs(s.ltp - st.sl);
    const premRisk = delta != null ? Math.max(undRisk * delta, opt.ltp * 0.12) : opt.ltp * 0.35;
    const slPrem = Math.max(opt.ltp - premRisk, 0.05);
    const undMove1 = dir === "LONG" ? st.t1 - s.ltp : s.ltp - st.t1;
    const undMove2 = dir === "LONG" ? st.t2 - s.ltp : s.ltp - st.t2;
    const t1Prem = delta != null ? opt.ltp + undMove1 * delta : null;
    const t2Prem = delta != null ? opt.ltp + undMove2 * delta : null;
    const entry = opt.ltp;
    const rr = t1Prem != null ? (t1Prem - entry) / Math.max(entry - slPrem, 0.05) : null;
    if (rr == null) soft.push("Risk/reward not computable without provider delta");
    else if (rr < 1.5) blocking.push(`Risk/reward ${rr.toFixed(1)} < 1.5`);

    const status = statusFor(blocking, soft);
    if (status) {
      const entryType =
        s.sr?.immediateResistance && dir === "LONG" && s.sr.immediateResistance.mid - s.ltp < st.atr * 0.5
          ? "BREAKOUT_TRIGGER"
          : s.sr?.immediateSupport && dir === "SHORT" && s.ltp - s.sr.immediateSupport.mid < st.atr * 0.5
            ? "BREAKDOWN_TRIGGER"
            : "IMMEDIATE";
      trades.push({
        rank: 0,
        symbol: s.symbol,
        direction: dir,
        category: dir === "LONG" ? "BULLISH_CE" : "BEARISH_PE",
        instrumentType: dir === "LONG" ? "CE" : "PE",
        contractKey: opt.key,
        expiry: opt.expiry,
        strike: opt.strike,
        entryType,
        entry: r2(entry),
        stopLoss: r2(slPrem),
        target1: t1Prem == null ? null : r2(t1Prem),
        target2: t2Prem == null ? null : r2(t2Prem),
        targetExt: t2Prem == null ? null : r2(entry + (t2Prem - entry) * 1.5),
        rr: rr == null ? null : Math.round(rr * 100) / 100,
        score: Math.round(clamp(Math.abs(fm) + (s.rvol ?? 1) * 4, 1, 99)),
        coverage: fmpi.coverage,
        dataCoverage: cov,
        freshness: s.freshness,
        status,
        fmpi: fmpi.value,
        oiConfirmation: oiConf.state,
        oiConfirmationDetail: oiConf.detail,
        futConfirmed: oiConf.state === "CONFIRMED",
        deltaSource: delta == null ? "UNAVAILABLE" : "UPSTOX_PROVIDED",
        srConfluence: dir === "LONG" ? (s.sr?.immediateResistance?.strength ?? null) : (s.sr?.immediateSupport?.strength ?? null),
        structure: s.structureTrend,
        invalidation: `Underlying ${dir === "LONG" ? "close below" : "close above"} ${r2(st.sl)} invalidates the ${dir === "LONG" ? "bullish" : "bearish"} view`,
        rationale,
        gatesFailed: soft,
      });
    } else {
      waits.push({ symbol: s.symbol, reason: `${dir === "LONG" ? "CE" : "PE"} setup rejected: ${blocking.slice(0, 2).join("; ")}` });
    }
  }

  // --------------------------------------------------------------- FUTURES
  if (s.fut) {
    const blocking: string[] = [];
    const soft: string[] = [];
    const rationale: string[] = [];
    // PRIORITY 6B — never fabricate a futures contract
    if (!s.fut.instrumentKey || !s.fut.instrumentKey.includes("|")) blocking.push("No valid Upstox futures instrument key");
    if (!Number.isFinite(s.fut.ltp) || s.fut.ltp <= 0) blocking.push("Futures LTP unavailable");
    if (!s.fut.expiry) blocking.push("Futures expiry unavailable");

    if (oiConf.state === "CONFIRMED") rationale.push(oiConf.detail);
    else if (oiConf.state === "CONTRADICTS") blocking.push(oiConf.detail);
    else blocking.push(`Futures positioning not decisive (${oiConf.detail})`);

    if (fmpi.acceleration === "DECELERATING") soft.push("Momentum decelerating");
    if (!structureAligned) soft.push("Structure not aligned");
    if (!hasStructuralLevels) soft.push("No structural S/R levels — ATR projection only");

    // futures trade levels are quoted on the FUTURES contract, not spot
    const basis = s.fut.basis ?? 0;
    const fEntry = s.fut.ltp;
    const fSl = st.sl + basis;
    const fT1 = st.t1 + basis;
    const fT2 = st.t2 + basis;
    const rr = dir === "LONG" ? (fT1 - fEntry) / Math.max(fEntry - fSl, 0.01) : (fEntry - fT1) / Math.max(fSl - fEntry, 0.01);
    if (!Number.isFinite(rr) || rr < 1.4) blocking.push(`Risk/reward ${Number.isFinite(rr) ? rr.toFixed(1) : "n/a"} inadequate`);

    const status = statusFor(blocking, soft);
    if (status) {
      trades.push({
        rank: 0,
        symbol: s.symbol,
        direction: dir,
        category: dir === "LONG" ? "BULLISH_FUT" : "BEARISH_FUT",
        instrumentType: "FUT",
        contractKey: s.fut.instrumentKey,
        expiry: s.fut.expiry,
        strike: null,
        entryType: s.vwap != null && ((dir === "LONG" && s.ltp > s.vwap) || (dir === "SHORT" && s.ltp < s.vwap)) ? "IMMEDIATE" : "RETEST",
        entry: r2(fEntry),
        stopLoss: r2(fSl),
        target1: r2(fT1),
        target2: r2(fT2),
        targetExt: r2(st.te + basis),
        rr: Math.round(rr * 100) / 100,
        score: Math.round(clamp(Math.abs(fm) + Math.abs(s.fut.oiChgPct) * 3, 1, 99)),
        coverage: fmpi.coverage,
        dataCoverage: cov,
        freshness: s.freshness,
        status,
        fmpi: fmpi.value,
        oiConfirmation: oiConf.state,
        oiConfirmationDetail: oiConf.detail,
        futConfirmed: true,
        deltaSource: "N_A",
        srConfluence: null,
        structure: s.structureTrend,
        invalidation: `${dir === "LONG" ? "Close below" : "Close above"} ${r2(fSl)} on the ${s.fut.expiry} future`,
        rationale,
        gatesFailed: soft,
      });
    }
  }

  return { trades, waits };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function runTradeFinder(intel: SymbolIntel[]): TradeFinderOutput {
  const nifty = intel.find((i) => i.symbol === "NIFTY");
  const indexContext = { niftyDir: nifty?.chgPct ?? 0 };
  const bullish: TradeCandidate[] = [];
  const bearish: TradeCandidate[] = [];
  const watch: TradeCandidate[] = [];
  const wait: { symbol: string; reason: string }[] = [];
  for (const s of intel) {
    const { trades, waits } = evaluateSymbol(s, indexContext);
    for (const t of trades) {
      // PRIORITY 6D — a WATCH candidate is NEVER surfaced as actionable.
      if (t.status === "ACTIONABLE") (t.direction === "LONG" ? bullish : bearish).push(t);
      else watch.push(t);
    }
    wait.push(...waits);
  }
  const bySort = (a: TradeCandidate, b: TradeCandidate) => b.score - a.score;
  bullish.sort(bySort);
  bearish.sort(bySort);
  watch.sort(bySort);
  bullish.forEach((t, i) => (t.rank = i + 1));
  bearish.forEach((t, i) => (t.rank = i + 1));
  watch.forEach((t, i) => (t.rank = i + 1));
  const actionable = bullish.length + bearish.length;
  const waitSummary =
    actionable === 0
      ? `WAIT / NO TRADE — no candidate satisfies every mandatory gate${watch.length ? ` (${watch.length} on watch)` : ""}.`
      : `${actionable} actionable · ${watch.length} watch · ${wait.length} rejected this cycle.`;
  return {
    bullish: bullish.slice(0, 10),
    bearish: bearish.slice(0, 10),
    watch: watch.slice(0, 12),
    wait: wait.slice(0, 20),
    waitSummary,
    counts: { actionable, watch: watch.length, rejected: wait.length },
  };
}

// ---------------------------------------------------------------------------
// Targets, reversal zones, invalidation
// ---------------------------------------------------------------------------
export interface Targets {
  upside: { label: string; price: number; source: string }[];
  downside: { label: string; price: number; source: string }[];
  reversalZones: { price: number; kind: string; state: "POTENTIAL_REVERSAL" | "CONFIRMED_REVERSAL" | "FAILED_REVERSAL" }[];
  invalidation: { bullish: string; bearish: string };
}

export function computeTargets(s: SymbolIntel, allZones: SRZone[], structEvents: { kind: string; price: number }[]): Targets {
  const atrv = s.atr ?? s.ltp * 0.006;
  const res = allZones.filter((z) => z.mid > s.ltp && !z.oiOnly).sort((a, b) => a.mid - b.mid);
  const sup = allZones.filter((z) => z.mid < s.ltp && !z.oiOnly).sort((a, b) => b.mid - a.mid);
  const upside = [
    { label: "Immediate upside", price: res[0]?.mid ?? s.ltp + atrv * 1.2, source: res[0]?.sources[0] ?? "ATR_PROJECTION" },
    { label: "Primary upside", price: res[1]?.mid ?? s.ltp + atrv * 2.2, source: res[1]?.sources[0] ?? "ATR_PROJECTION" },
    { label: "Extended upside", price: res[2]?.mid ?? s.ltp + atrv * 3.4, source: res[2]?.sources[0] ?? "ATR_PROJECTION" },
  ];
  const downside = [
    { label: "Immediate downside", price: sup[0]?.mid ?? s.ltp - atrv * 1.2, source: sup[0]?.sources[0] ?? "ATR_PROJECTION" },
    { label: "Primary downside", price: sup[1]?.mid ?? s.ltp - atrv * 2.2, source: sup[1]?.sources[0] ?? "ATR_PROJECTION" },
    { label: "Extended downside", price: sup[2]?.mid ?? s.ltp - atrv * 3.4, source: sup[2]?.sources[0] ?? "ATR_PROJECTION" },
  ];
  const reversalZones: Targets["reversalZones"] = [];
  const choch = structEvents.filter((e) => e.kind.startsWith("CHOCH")).slice(-2);
  for (const e of choch) reversalZones.push({ price: e.price, kind: e.kind, state: "CONFIRMED_REVERSAL" });
  if (res[0]) reversalZones.push({ price: res[0].mid, kind: "UPPER_LIQUIDITY_ZONE", state: "POTENTIAL_REVERSAL" });
  if (sup[0]) reversalZones.push({ price: sup[0].mid, kind: "LOWER_LIQUIDITY_ZONE", state: "POTENTIAL_REVERSAL" });
  return {
    upside,
    downside,
    reversalZones: reversalZones.slice(0, 5),
    invalidation: {
      bullish: sup[0] ? `Bullish view invalid below ${sup[0].mid.toFixed(2)} (nearest support zone)` : "Bullish view invalid on structure breakdown",
      bearish: res[0] ? `Bearish view invalid above ${res[0].mid.toFixed(2)} (nearest resistance zone)` : "Bearish view invalid on structure breakout",
    },
  };
}
