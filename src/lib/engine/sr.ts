/**
 * PULSEGRID 2.0 — Unified Dynamic Support & Resistance Engine.
 *
 * - Structural and OI candidates are generated INDEPENDENTLY.
 * - OI-only zones are never promoted to price-action-confirmed S/R.
 * - Overlapping zones merge with adaptive tolerance (tick size + volatility).
 * - Every zone carries source provenance, lifecycle status, real touch counts
 *   and a multi-family confluence score (never presented as probability).
 */
import type { Candle } from "./types";
import { atr, clamp } from "./indicators";
import { analyzeZoneInteractions } from "./zone-interaction";
import type { StructureAnalysis, VolumeProfileResult } from "./structure";

export type ZoneSide = "SUPPORT" | "RESISTANCE";
export type ZoneKind = "PRICE_ACTION" | "OI_ONLY" | "VOLUME_PROFILE" | "VWAP" | "FUTURES" | "MULTI_SOURCE";
export type ZoneStatus =
  | "NEWLY_IDENTIFIED"
  | "UNTESTED"
  | "TESTED"
  | "STRENGTHENING"
  | "WEAKENING"
  | "REJECTION_CONFIRMED"
  | "BREAKOUT_RISK"
  | "BREAKDOWN_RISK"
  | "BROKEN"
  | "RETEST"
  | "INVALIDATED";

export interface SRZone {
  id: string;
  side: ZoneSide;
  priceLow: number;
  priceHigh: number;
  mid: number;
  kind: ZoneKind;
  sources: string[];
  oiOnly: boolean;
  status: ZoneStatus;
  touches: number;
  strength: number; // 0..100 confluence score — NOT a probability
  evidence: {
    bullish: string[];
    bearish: string[];
    conflicting: string[];
    missing: string[];
    coverage: number; // 0..1 independent evidence families present
  };
  firstSeen: number;
  lastTested: number | null;
}

interface Candidate {
  price: number;
  side: ZoneSide;
  source: string;
  kind: ZoneKind;
  weight: number;
}

export interface SRInput {
  symbol: string;
  price: number;
  tickSize: number;
  candles: Candle[]; // analysis timeframe candles
  prevDay: { high: number; low: number; close: number } | null;
  openingRange: { high: number; low: number } | null;
  vwap: { vwap: number; up1: number; dn1: number; up2: number; dn2: number } | null;
  profile: VolumeProfileResult | null;
  structure: StructureAnalysis;
  oiZones: { strike: number; ceOi: number; peOi: number; ceSessChg: number | null; peSessChg: number | null }[];
  atrValue: number | null;
  now: number;
}

function sideFor(price: number, level: number): ZoneSide {
  return level < price ? "SUPPORT" : "RESISTANCE";
}

export function buildSRZones(inp: SRInput): SRZone[] {
  const { candles, price, tickSize } = inp;
  const atrV = inp.atrValue ?? atr(candles, 14) ?? price * 0.004;
  const tol = Math.max(tickSize * 4, atrV * 0.35, price * 0.0012);
  const cands: Candidate[] = [];

  // ---- Price action -------------------------------------------------------
  for (const s of inp.structure.swings.slice(-24)) {
    cands.push({
      price: s.price,
      side: sideFor(price, s.price),
      source: s.kind === "HIGH" ? "SWING_HIGH" : "SWING_LOW",
      kind: "PRICE_ACTION",
      weight: 1.0,
    });
  }
  if (inp.prevDay) {
    cands.push({ price: inp.prevDay.high, side: sideFor(price, inp.prevDay.high), source: "PDH", kind: "PRICE_ACTION", weight: 1.4 });
    cands.push({ price: inp.prevDay.low, side: sideFor(price, inp.prevDay.low), source: "PDL", kind: "PRICE_ACTION", weight: 1.4 });
    cands.push({ price: inp.prevDay.close, side: sideFor(price, inp.prevDay.close), source: "PREV_CLOSE", kind: "PRICE_ACTION", weight: 1.0 });
  }
  if (inp.openingRange) {
    cands.push({ price: inp.openingRange.high, side: sideFor(price, inp.openingRange.high), source: "OR_HIGH", kind: "PRICE_ACTION", weight: 1.1 });
    cands.push({ price: inp.openingRange.low, side: sideFor(price, inp.openingRange.low), source: "OR_LOW", kind: "PRICE_ACTION", weight: 1.1 });
  }
  if (inp.structure.rangeHigh && inp.structure.rangeLow && inp.structure.consolidating) {
    cands.push({ price: inp.structure.rangeHigh, side: "RESISTANCE", source: "RANGE_BOUNDARY", kind: "PRICE_ACTION", weight: 1.0 });
    cands.push({ price: inp.structure.rangeLow, side: "SUPPORT", source: "RANGE_BOUNDARY", kind: "PRICE_ACTION", weight: 1.0 });
  }
  for (const p of inp.structure.equalHighs) cands.push({ price: p, side: sideFor(price, p), source: "EQUAL_HIGHS", kind: "PRICE_ACTION", weight: 0.9 });
  for (const p of inp.structure.equalLows) cands.push({ price: p, side: sideFor(price, p), source: "EQUAL_LOWS", kind: "PRICE_ACTION", weight: 0.9 });

  // ---- Volume profile ------------------------------------------------------
  if (inp.profile) {
    cands.push({ price: inp.profile.poc, side: sideFor(price, inp.profile.poc), source: "POC", kind: "VOLUME_PROFILE", weight: 1.2 });
    cands.push({ price: inp.profile.vah, side: sideFor(price, inp.profile.vah), source: "VAH", kind: "VOLUME_PROFILE", weight: 0.9 });
    cands.push({ price: inp.profile.val, side: sideFor(price, inp.profile.val), source: "VAL", kind: "VOLUME_PROFILE", weight: 0.9 });
    for (const p of inp.profile.hvn.slice(0, 4)) cands.push({ price: p, side: sideFor(price, p), source: "HVN", kind: "VOLUME_PROFILE", weight: 0.7 });
    for (const p of inp.profile.lvn.slice(0, 4)) cands.push({ price: p, side: sideFor(price, p), source: "LVN", kind: "VOLUME_PROFILE", weight: 0.5 });
  }

  // ---- VWAP ----------------------------------------------------------------
  if (inp.vwap) {
    cands.push({ price: inp.vwap.vwap, side: sideFor(price, inp.vwap.vwap), source: "VWAP", kind: "VWAP", weight: 1.0 });
    cands.push({ price: inp.vwap.up1, side: sideFor(price, inp.vwap.up1), source: "VWAP_BAND_1", kind: "VWAP", weight: 0.6 });
    cands.push({ price: inp.vwap.dn1, side: sideFor(price, inp.vwap.dn1), source: "VWAP_BAND_1", kind: "VWAP", weight: 0.6 });
  }

  // ---- Price touch measurement (genuine reactions only) --------------------
  // ---- Direction-aware interaction counting (shared engine) --------------
  // Only genuine defences count. A resistance breakout close can never
  // increment the rejection count, and a support breakdown close can never
  // increment the defence count.
  const touchesAt = (level: number, side: ZoneSide): { count: number; last: number | null; acceptances: number; quality: number } => {
    const half = Math.max(tol * 0.5, atrV * 0.1);
    const r = analyzeZoneInteractions(candles.slice(-300), level - half, level + half, side, atrV, tol * 0.5);
    return { count: r.successfulTests, last: r.lastTestTs, acceptances: r.acceptances, quality: r.meanQuality };
  };

  // ---- Merge structural candidates ----------------------------------------
  const structural = cands.sort((a, b) => a.price - b.price);
  const merged: { low: number; high: number; side: ZoneSide; sources: string[]; kinds: Set<ZoneKind>; weight: number; price: number }[] = [];
  for (const c of structural) {
    const z = merged[merged.length - 1];
    if (z && z.side === c.side && c.price - z.high <= tol) {
      z.high = Math.max(z.high, c.price);
      z.low = Math.min(z.low, c.price);
      z.sources.push(c.source);
      z.kinds.add(c.kind);
      z.weight += c.weight;
      z.price = (z.low + z.high) / 2;
    } else {
      merged.push({ low: c.price, high: c.price, side: c.side, sources: [c.source], kinds: new Set([c.kind]), weight: c.weight, price: c.price });
    }
  }

  const zones: SRZone[] = merged.map((m, i) => {
    const t = touchesAt(m.price, m.side);
    const hasPA = m.kinds.has("PRICE_ACTION");
    const hasVol = m.kinds.has("VOLUME_PROFILE");
    const hasVwap = m.kinds.has("VWAP");
    const kind: ZoneKind = m.kinds.size > 2 ? "MULTI_SOURCE" : hasPA ? "PRICE_ACTION" : hasVol ? "VOLUME_PROFILE" : "VWAP";
    const families = [hasPA, hasVol, hasVwap, t.count > 0].filter(Boolean).length;
    // acceptances beyond the zone are NEGATIVE evidence for the level
    const strength = clamp(
      (m.weight / 4) * 40 + families * 12 + Math.min(t.count, 4) * 8 * (0.5 + t.quality * 0.5) - t.acceptances * 10,
      5,
      98,
    );
    const evidence = {
      bullish: [] as string[],
      bearish: [] as string[],
      conflicting: [] as string[],
      missing: [] as string[],
      coverage: clamp(families / 5 + (t.count > 0 ? 0.1 : 0), 0, 1),
    };
    if (t.count > 0) (m.side === "SUPPORT" ? evidence.bullish : evidence.bearish).push(`${t.count} genuine defence(s)`);
    if (t.acceptances > 0) evidence.conflicting.push(`${t.acceptances} acceptance(s) beyond the zone`);
    if (hasVol) evidence[m.side === "SUPPORT" ? "bullish" : "bearish"].push("Volume-profile confluence");
    if (hasVwap) evidence[m.side === "SUPPORT" ? "bullish" : "bearish"].push("VWAP confluence");
    if (!hasPA) evidence.missing.push("price-action confirmation");
    const status: ZoneStatus = t.count === 0 ? "UNTESTED" : t.count >= 2 ? "TESTED" : "TESTED";
    return {
      id: `${inp.symbol}-${m.side}-${i}-${Math.round(m.price)}`,
      side: m.side,
      priceLow: m.low,
      priceHigh: m.high,
      mid: m.price,
      kind,
      sources: [...new Set(m.sources)],
      oiOnly: false,
      status,
      touches: t.count,
      strength: Math.round(strength),
      evidence,
      firstSeen: candles[0]?.ts ?? inp.now,
      lastTested: t.last,
    };
  });

  // ---- OI-only candidates (kept explicitly separate) -----------------------
  const maxOi = Math.max(1, ...inp.oiZones.map((z) => Math.max(z.ceOi, z.peOi)));
  for (const oz of inp.oiZones) {
    if (oz.peOi > 0.55 * maxOi) {
      const overlaps = zones.some((z) => oz.strike >= z.priceLow - tol && oz.strike <= z.priceHigh + tol && z.side === sideFor(price, oz.strike));
      if (!overlaps) {
        zones.push({
          id: `${inp.symbol}-OI-S-${Math.round(oz.strike)}`,
          side: sideFor(price, oz.strike),
          priceLow: oz.strike - tol * 0.4,
          priceHigh: oz.strike + tol * 0.4,
          mid: oz.strike,
          kind: "OI_ONLY",
          sources: ["PE_OI_CONCENTRATION"],
          oiOnly: true,
          status: "UNTESTED",
          touches: 0,
          strength: Math.round(clamp((oz.peOi / maxOi) * 55, 10, 60)),
          evidence: {
            bullish: ["High PE OI concentration — potential positioning (not confirmed S/R)"],
            bearish: [],
            conflicting: [],
            missing: ["price-action confirmation", "volume-profile confluence"],
            coverage: 0.15,
          },
          firstSeen: inp.now,
          lastTested: null,
        });
      }
    }
    if (oz.ceOi > 0.55 * maxOi) {
      const overlaps = zones.some((z) => oz.strike >= z.priceLow - tol && oz.strike <= z.priceHigh + tol && z.side === sideFor(price, oz.strike));
      if (!overlaps) {
        zones.push({
          id: `${inp.symbol}-OI-R-${Math.round(oz.strike)}`,
          side: sideFor(price, oz.strike),
          priceLow: oz.strike - tol * 0.4,
          priceHigh: oz.strike + tol * 0.4,
          mid: oz.strike,
          kind: "OI_ONLY",
          sources: ["CE_OI_CONCENTRATION"],
          oiOnly: true,
          status: "UNTESTED",
          touches: 0,
          strength: Math.round(clamp((oz.ceOi / maxOi) * 55, 10, 60)),
          evidence: {
            bullish: [],
            bearish: ["High CE OI concentration — potential positioning (not confirmed S/R)"],
            conflicting: [],
            missing: ["price-action confirmation", "volume-profile confluence"],
            coverage: 0.15,
          },
          firstSeen: inp.now,
          lastTested: null,
        });
      }
    }
  }

  return zones.filter((z) => Math.abs(z.mid - price) / price < 0.06); // keep relevant neighbourhood
}

// ---------------------------------------------------------------------------
// Primary level selection
// ---------------------------------------------------------------------------
export interface SRSelection {
  immediateSupport: SRZone | null;
  primarySupport: SRZone | null;
  secondarySupport: SRZone | null;
  majorSupport: SRZone | null;
  immediateResistance: SRZone | null;
  primaryResistance: SRZone | null;
  secondaryResistance: SRZone | null;
  majorResistance: SRZone | null;
}

/** Nearest VALID support below price / resistance above price. */
export function selectPrimaryLevels(zones: SRZone[], price: number): SRSelection {
  const valid = zones.filter((z) => z.status !== "INVALIDATED" && z.status !== "BROKEN");
  const supports = valid.filter((z) => z.mid < price).sort((a, b) => b.mid - a.mid);
  const resistances = valid.filter((z) => z.mid > price).sort((a, b) => a.mid - b.mid);
  const structuralS = supports.filter((z) => !z.oiOnly);
  const structuralR = resistances.filter((z) => !z.oiOnly);
  // PRIORITY 7: a Primary level is the next DISTINCT zone beyond the
  // Immediate one. It is NEVER the same zone, and never fabricated.
  return {
    immediateSupport: structuralS[0] ?? null,
    primarySupport: structuralS[1] ?? null,
    secondarySupport: structuralS[2] ?? null,
    majorSupport: structuralS.length > 1 ? structuralS[structuralS.length - 1] : null,
    immediateResistance: structuralR[0] ?? null,
    primaryResistance: structuralR[1] ?? null,
    secondaryResistance: structuralR[2] ?? null,
    majorResistance: structuralR.length > 1 ? structuralR[structuralR.length - 1] : null,
  };
}

// ---------------------------------------------------------------------------
// Strengthening / weakening analysis near a zone — multi-family evidence.
// ---------------------------------------------------------------------------
export type ZoneAssessment =
  | "SUPPORT_STRENGTHENING"
  | "SUPPORT_WEAKENING"
  | "RESISTANCE_STRENGTHENING"
  | "RESISTANCE_WEAKENING"
  | "BREAKOUT_WATCH"
  | "BREAKDOWN_WATCH"
  | "INSUFFICIENT_EVIDENCE";

export function assessZone(args: {
  zone: SRZone;
  price: number;
  atrValue: number | null;
  recentCloses: number[];
  recentVolumes: number[];
  futuresBias: number | null; // -1..1 or null when unavailable
  nearbyCeSess: (number | null)[];
  nearbyPeSess: (number | null)[];
  premiumResp: number | null; // positive = bullish premium response
  vwap: number | null;
}): { assessment: ZoneAssessment; evidence: string[] } {
  const { zone, price } = args;
  const ev: string[] = [];
  const nearPx = Math.abs(price - zone.mid) / price < 0.004;
  if (!nearPx) return { assessment: "INSUFFICIENT_EVIDENCE", evidence: ["Price not near zone"] };

  let bull = 0,
    bear = 0;
  const closes = args.recentCloses;
  if (closes.length >= 3) {
    const last = closes[closes.length - 1];
    const above = closes.slice(-3).filter((c) => c > zone.priceHigh).length;
    const below = closes.slice(-3).filter((c) => c < zone.priceLow).length;
    if (zone.side === "RESISTANCE") {
      if (above >= 2) {
        bull += 2;
        ev.push("Price acceptance above resistance");
      }
      if (last < zone.priceLow && zone.touches >= 2) {
        bear += 2;
        ev.push("Repeated rejection at zone");
      }
    } else {
      if (below >= 2) {
        bear += 2;
        ev.push("Price acceptance below support");
      }
      if (last > zone.priceHigh && zone.touches >= 2) {
        bull += 2;
        ev.push("Repeated successful support tests");
      }
    }
  }
  const vols = args.recentVolumes;
  if (vols.length >= 6) {
    const recent = vols.slice(-3).reduce((s, v) => s + v, 0) / 3;
    const base = vols.slice(-6, -3).reduce((s, v) => s + v, 0) / 3;
    if (recent > base * 1.5) {
      ev.push("Expanding volume near zone");
      bull += zone.side === "RESISTANCE" ? 1 : 0;
      bear += zone.side === "SUPPORT" ? 1 : 0;
    }
  }
  const ceChg = args.nearbyCeSess.filter((v): v is number => v != null).reduce((s, v) => s + v, 0);
  const peChg = args.nearbyPeSess.filter((v): v is number => v != null).reduce((s, v) => s + v, 0);
  const ceKnown = args.nearbyCeSess.some((v) => v != null);
  const peKnown = args.nearbyPeSess.some((v) => v != null);
  if (ceKnown && ceChg < 0) {
    ev.push("Nearby CE OI unwinding");
    if (zone.side === "RESISTANCE") bull += 1;
  }
  if (peKnown && peChg > 0) {
    ev.push("Nearby PE OI addition");
    if (zone.side === "SUPPORT") bull += 1;
  }
  if (ceKnown && ceChg > 0) {
    ev.push("Nearby CE OI addition");
    if (zone.side === "RESISTANCE") bear += 1;
  }
  if (args.futuresBias != null) {
    if (args.futuresBias > 0.2) {
      bull += 1;
      ev.push("Bullish futures confirmation");
    } else if (args.futuresBias < -0.2) {
      bear += 1;
      ev.push("Bearish futures confirmation");
    }
  } else ev.push("Futures data unavailable");
  if (args.premiumResp != null) {
    if (args.premiumResp > 0) bull += 1;
    else if (args.premiumResp < 0) bear += 1;
  }
  if (args.vwap != null) {
    if (price > args.vwap && zone.side === "RESISTANCE") ev.push("VWAP support below");
    if (price < args.vwap && zone.side === "SUPPORT") ev.push("VWAP resistance above");
  }

  const families = Math.max(bull, bear);
  if (families < 2) return { assessment: "INSUFFICIENT_EVIDENCE", evidence: ev };

  if (zone.side === "RESISTANCE") {
    if (bull >= 3) return { assessment: bull >= 4 ? "BREAKOUT_WATCH" : "RESISTANCE_WEAKENING", evidence: ev };
    if (bear >= 3) return { assessment: "RESISTANCE_STRENGTHENING", evidence: ev };
  } else {
    if (bull >= 3) return { assessment: "SUPPORT_STRENGTHENING", evidence: ev };
    if (bear >= 3) return { assessment: bear >= 4 ? "BREAKDOWN_WATCH" : "SUPPORT_WEAKENING", evidence: ev };
  }
  return { assessment: "INSUFFICIENT_EVIDENCE", evidence: ev };
}
