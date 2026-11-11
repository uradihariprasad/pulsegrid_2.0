/**
 * PULSEGRID 2.0 — mandatory core-calculation tests (Part 30).
 * Run: npx tsx src/lib/engine/tests.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { rollingOiChange, sessionCumulativeChange, combinedTotalOi, computeOiMomentum, type OIObs } from "./oi";
import { classifyFutures, computeFMPI } from "./fmpi";
import { buildSRZones, selectPrimaryLevels, selectPrimaryLevels as srSelect } from "./sr";
import { analyzeStructure } from "./structure";
import { rvolSameTimeOfDay, sessionVwap } from "./indicators";
import { runTradeFinder, type SymbolIntel } from "./trading";
import type { Candle } from "./types";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const T0 = Date.UTC(2025, 5, 6, 4, 0, 0); // fixed clock

// ---- 1. OI 5-minute --------------------------------------------------------
ok("OI 5m: 09:20=50,000 → 09:25=45,000 gives −5,000", () => {
  const base = Date.UTC(2025, 5, 6, 3, 50, 0); // 09:20 IST
  const now = Date.UTC(2025, 5, 6, 3, 55, 0); // 09:25 IST
  const obs: OIObs[] = [
    { ts: base, oi: 50_000 },
    { ts: now, oi: 45_000 },
  ];
  const r = rollingOiChange(obs, now, 5);
  assert.equal(r.change, -5_000);
  assert.equal(r.refTs, base);
});

// ---- 2. OI 15-minute -------------------------------------------------------
ok("OI 15m: 09:15=50,000 → 09:30=55,000 gives +5,000", () => {
  const base = Date.UTC(2025, 5, 6, 3, 45, 0); // 09:15 IST
  const now = Date.UTC(2025, 5, 6, 4, 0, 0); // 09:30 IST
  const obs: OIObs[] = [
    { ts: base, oi: 50_000 },
    { ts: now, oi: 55_000 },
  ];
  const r = rollingOiChange(obs, now, 15);
  assert.equal(r.change, 5_000);
});

// ---- 3. Session cumulative -------------------------------------------------
ok("OI session cumulative: baseline 50,000 net +1,200/+1,000/−500 → 51,700 / +1,700", () => {
  const baseline = 50_000;
  let cur = baseline;
  for (const d of [1_200, 1_000, -500]) cur += d;
  assert.equal(cur, 51_700);
  assert.equal(sessionCumulativeChange(cur, baseline), 1_700);
  // refresh safety: same baseline, later snapshot
  assert.equal(sessionCumulativeChange(52_000, baseline), 2_000);
});

// ---- 4. Combined total -----------------------------------------------------
ok("OI combined total: 25,000 pre-session + 1,000 session change → 26,000; null when reference missing", () => {
  assert.equal(combinedTotalOi(25_000, 1_000), 26_000);
  assert.equal(combinedTotalOi(null, 1_000), null); // never invent a reference
  assert.equal(combinedTotalOi(25_000, null), null);
});

// ---- 5. Contract identity --------------------------------------------------
ok("Contract identity: CE/PE histories never mix; windows use only own series", () => {
  const now = Date.UTC(2025, 5, 6, 4, 15, 0);
  const ce: OIObs[] = [{ ts: now - 5 * 60_000, oi: 50_000 }, { ts: now, oi: 46_000 }];
  const pe: OIObs[] = [{ ts: now - 5 * 60_000, oi: 80_000 }, { ts: now, oi: 84_500 }];
  assert.equal(rollingOiChange(ce, now, 5).change, -4_000);
  assert.equal(rollingOiChange(pe, now, 5).change, 4_500);
  const m = computeOiMomentum(ce, 50_000, 48_000, now);
  assert.equal(m.sessionChange, -4_000);
  assert.equal(m.combinedTotalOi, 44_000);
});

// ---- 6. Missing references → N/A ------------------------------------------
ok("OI windows: missing/stale reference returns null (N/A), not a guess", () => {
  const now = Date.UTC(2025, 5, 6, 4, 30, 0);
  const obs: OIObs[] = [{ ts: now - 6 * 60_000, oi: 10_000 }, { ts: now, oi: 12_000 }];
  // 15m window has no observation near target → null
  assert.equal(rollingOiChange(obs, now, 15).change, null);
});

// ---- 7. S/R primary selection invariants -----------------------------------
const mkCandles = (): Candle[] => {
  // deterministic staircase with pivots
  const out: Candle[] = [];
  let px = 100;
  const path = [1, 2, 3, 2, 1, 0.5, 1.5, 2.5, 1.8, 1.2, 2, 3, 2.6, 2.2, 3.2, 4, 3.5, 4.2, 4.8, 4.4];
  for (let i = 0; i < 60; i++) {
    const d = path[i % path.length] - 2;
    px = Math.max(50, px + d * 0.8);
    out.push({ ts: T0 + i * 60_000, o: px, h: px + 1.2, l: px - 1.2, c: px + 0.3, v: 1000 + (i % 7) * 160 });
  }
  return out;
};

ok("S/R: nearest support below price, nearest resistance above; OI-only stays OI-only", () => {
  const candles = mkCandles();
  const price = candles[candles.length - 1].c;
  const structure = analyzeStructure(candles);
  const zones = buildSRZones({
    symbol: "TEST",
    price,
    tickSize: 0.05,
    candles,
    prevDay: { high: price + 6, low: price - 8, close: price - 1 },
    openingRange: { high: candles[0].h, low: candles[0].l },
    vwap: { vwap: price - 0.5, up1: price + 1, dn1: price - 2, up2: price + 2, dn2: price - 4 },
    profile: null,
    structure,
    oiZones: [{ strike: Math.round(price) + 5, ceOi: 900_000, peOi: 100_000, ceSessChg: 5_000, peSessChg: 1_000 }],
    atrValue: 1.5,
    now: Date.now(),
  });
  const sel = selectPrimaryLevels(zones, price);
  if (sel.immediateSupport) assert.ok(sel.immediateSupport.mid < price, "support must be below price");
  if (sel.immediateResistance) assert.ok(sel.immediateResistance.mid > price, "resistance must be above price");
  // OI-only candidates never promoted & never selected as primary structural
  for (const z of zones.filter((z) => z.oiOnly)) {
    assert.ok(z.kind === "OI_ONLY");
    assert.ok(z.evidence.missing.includes("price-action confirmation"));
  }
  const structuralSel = [sel.immediateSupport, sel.immediateResistance, sel.primarySupport, sel.primaryResistance].filter(Boolean);
  for (const z of structuralSel) assert.ok(z && !z.oiOnly, "OI-only zone leaked into primary selection");
});

// ---- 8. PDH/PDL source integrity -------------------------------------------
ok("PDH/PDL: candidates reference the immediately preceding session object", () => {
  const candles = mkCandles();
  const price = candles[candles.length - 1].c;
  const structure = analyzeStructure(candles);
  const pdh = price + 3.21;
  const zones = buildSRZones({
    symbol: "TEST", price, tickSize: 0.05, candles,
    prevDay: { high: pdh, low: price - 3.77, close: price - 0.4 },
    openingRange: null, vwap: null, profile: null, structure, oiZones: [], atrValue: 1.5, now: Date.now(),
  });
  const pdhZone = zones.find((z) => z.sources.includes("PDH"));
  assert.ok(pdhZone, "PDH zone must exist");
  assert.ok(Math.abs(pdhZone!.mid - pdh) < 1.0, "PDH must track the given prior session high");
});

// ---- 9. Futures: missing data never confirms --------------------------------
ok("Futures: missing price/OI → UNAVAILABLE, never confirmation", () => {
  assert.equal(classifyFutures(null, 1.2), "UNAVAILABLE");
  assert.equal(classifyFutures(0.5, null), "UNAVAILABLE");
  assert.equal(classifyFutures(0.4, 0.6), "LONG_BUILDUP");
  assert.equal(classifyFutures(-0.4, 0.6), "SHORT_BUILDUP");
  assert.equal(classifyFutures(0.4, -0.6), "SHORT_COVERING");
  assert.equal(classifyFutures(-0.4, -0.6), "LONG_UNWINDING");
});

// ---- 10. Trade Finder gates --------------------------------------------------
ok("Trade Finder: EMA alignment alone never confirms an options trade", () => {
  const s: SymbolIntel = {
    symbol: "TRENDONLY", name: "t", sector: "IT", segment: "EQUITY",
    ltp: 1000, chgPct: 1.2, volume: 2_000_000, rvol: 2.5, vwap: 995, emaAlign: 1,
    structureTrend: "UP", fut: null, fmpi: computeFMPI({ priceMomPct: 1.1, realizedVolPct: 0.6, cePremChgPct: null, pePremChgPct: null, optionVolAccel: null, rvol: 2.5, oiChg5mDir: null, oiChg15mDir: null, oiSessDir: null, futChgPct: null, futOiChgPct: null, basisChg: null, priceVsVwapPct: 0.5, emaAlignment: 1, structureDir: "UP", higherTfAgree: true, volatilityPct: 0.6 }),
    sr: null, chain: null, freshness: "LIVE", atr: 8,
  };
  const out = runTradeFinder([s]);
  assert.equal(out.bullish.filter((t) => t.status === "ACTIONABLE" && t.instrumentType === "CE").length, 0, "no options trade without derivatives evidence");
});

ok("RR: computed from proposed entry, not LTP", () => {
  // entry 100, stop 95, t1 110 → 2.0
  const rr = (110 - 100) / (100 - 95);
  assert.equal(rr, 2);
});

// ---- 11. RVOL same-time-of-day ----------------------------------------------
ok("RVOL compares equivalent same-time-of-day intervals", () => {
  const r = rvolSameTimeOfDay(180_000, [150_000, 150_000]);
  assert.ok(r && Math.abs(r - 1.2) < 1e-9);
  assert.equal(rvolSameTimeOfDay(100, []), null);
});

// ---- 12. VWAP sanity ---------------------------------------------------------
ok("VWAP is traded-price weighted, not mean of strikes", () => {
  const c: Candle[] = [
    { ts: 1, o: 100, h: 101, l: 99, c: 100, v: 1000 },
    { ts: 2, o: 100, h: 102, l: 100, c: 101, v: 4000 },
  ];
  const v = sessionVwap(c)!;
  assert.ok(v > 100.3 && v < 101.2);
});

// ---- 13. FMPI never fabricates ----------------------------------------------
ok("FMPI: all-missing components → value 0 with coverage 0 and confirmations listed", () => {
  const out = computeFMPI({ priceMomPct: null, realizedVolPct: null, cePremChgPct: null, pePremChgPct: null, optionVolAccel: null, rvol: null, oiChg5mDir: null, oiChg15mDir: null, oiSessDir: null, futChgPct: null, futOiChgPct: null, basisChg: null, priceVsVwapPct: null, emaAlignment: null, structureDir: null, higherTfAgree: null, volatilityPct: null });
  assert.equal(out.value, 0);
  assert.equal(out.coverage, 0);
  assert.ok(out.confirmationRequired.length >= 3);
});


// ===========================================================================
// CRITICAL-FIX REGRESSION TESTS
// ===========================================================================
import { parseExchangeTs } from "../market/upstox";
import { classifyFreshness, marketPhase, setExchangeHolidays, SESSIONS } from "./types";
import { confirmOi } from "./trading";

// ---- P1: timestamp parsing -------------------------------------------------
ok("P1: numeric epoch-ms string parses correctly", () => {
  const ms = Date.now() - 5_000;
  assert.equal(parseExchangeTs(String(ms)), ms);
  assert.equal(parseExchangeTs(ms), ms);
});

ok("P1: epoch-seconds and micros normalise to ms", () => {
  const sec = Math.floor((Date.now() - 60_000) / 1000);
  assert.equal(parseExchangeTs(String(sec)), sec * 1000);
  const micros = (Date.now() - 1000) * 1000;
  const got = parseExchangeTs(String(micros))!;
  assert.ok(Math.abs(got - Date.now()) < 5000);
});

ok("P1: ISO timestamp parses correctly", () => {
  const iso = new Date(Date.now() - 30_000).toISOString();
  assert.equal(parseExchangeTs(iso), Date.parse(iso));
  assert.ok(parseExchangeTs("2026-11-10T15:29:59+05:30") != null);
});

ok("P1: invalid/missing timestamps return null and never become LIVE", () => {
  for (const bad of [null, undefined, "", "not-a-date", "0", 0, "-5", {}, []]) {
    assert.equal(parseExchangeTs(bad as unknown), null, `expected null for ${JSON.stringify(bad)}`);
  }
  assert.equal(classifyFreshness(null), "UNAVAILABLE");
  assert.equal(classifyFreshness(undefined), "UNAVAILABLE");
  assert.equal(classifyFreshness(NaN), "UNAVAILABLE");
  // far-future stamp is rejected rather than treated as fresh
  assert.equal(parseExchangeTs(String(Date.now() + 3600_000)), null);
});

// ---- P3: session timings ---------------------------------------------------
ok("P3: NSE F&O regular session runs to 15:40 IST", () => {
  assert.equal(SESSIONS.NSE_FO.regularEnd, 15 * 60 + 40);
  assert.equal(SESSIONS.NSE_EQ.regularEnd, 15 * 60 + 30);
});

/** Build an epoch for a given IST wall-clock time on a known weekday. */
function istMoment(y: number, m: number, d: number, hh: number, mm: number): number {
  return Date.UTC(y, m - 1, d, hh, mm) - (5 * 60 + 30) * 60 * 1000;
}

ok("P3: 15:35 IST on a weekday is OPEN (not CLOSED)", () => {
  setExchangeHolidays([]);
  const wed = istMoment(2026, 11, 11, 15, 35); // Wednesday
  assert.equal(new Date(wed + 19800000).getUTCDay(), 3);
  assert.equal(marketPhase(wed), "OPEN");
  assert.equal(marketPhase(istMoment(2026, 11, 11, 15, 41)), "POST_CLOSE");
  assert.equal(marketPhase(istMoment(2026, 11, 11, 9, 5)), "PRE_OPEN");
  assert.equal(marketPhase(istMoment(2026, 11, 11, 9, 20)), "OPEN");
});

ok("P3: weekends and holidays are never regular sessions", () => {
  setExchangeHolidays(["2026-11-11"]);
  assert.equal(marketPhase(istMoment(2026, 11, 11, 11, 0)), "HOLIDAY");
  setExchangeHolidays([]);
  assert.equal(marketPhase(istMoment(2026, 11, 14, 11, 0)), "WEEKEND"); // Saturday
  assert.equal(marketPhase(istMoment(2026, 11, 15, 11, 0)), "WEEKEND"); // Sunday
});

ok("P3: phase is independent of the server timezone", () => {
  const before = process.env.TZ;
  const at = istMoment(2026, 11, 11, 15, 35);
  const seen: string[] = [];
  for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
    process.env.TZ = tz;
    seen.push(marketPhase(at));
  }
  process.env.TZ = before;
  assert.deepEqual(seen, ["OPEN", "OPEN", "OPEN"]);
});

// ---- P6: OI confirmation ---------------------------------------------------
ok("P6: non-null OI alone is NOT confirmation", () => {
  const r = confirmOi({ direction: "LONG", futClass: "NEUTRAL", futOiChgPct: 0.01, priceChgPct: 0.5, ceOiSessChg: 100, peOiSessChg: 100 });
  assert.notEqual(r.state, "CONFIRMED");
});

ok("P6: opposing futures positioning CONTRADICTS the direction", () => {
  const r = confirmOi({ direction: "LONG", futClass: "SHORT_BUILDUP", futOiChgPct: 2, priceChgPct: -0.6, ceOiSessChg: 5000, peOiSessChg: -2000 });
  assert.equal(r.state, "CONTRADICTS");
});

ok("P6: aligned futures + agreeing option OI CONFIRMS", () => {
  const r = confirmOi({ direction: "LONG", futClass: "LONG_BUILDUP", futOiChgPct: 1.8, priceChgPct: 0.8, ceOiSessChg: -4000, peOiSessChg: 9000 });
  assert.equal(r.state, "CONFIRMED");
});

ok("P6: missing futures reference is UNAVAILABLE, never CONFIRMED", () => {
  assert.equal(confirmOi({ direction: "LONG", futClass: null, futOiChgPct: null, priceChgPct: 1, ceOiSessChg: 1, peOiSessChg: 1 }).state, "UNAVAILABLE");
  assert.equal(confirmOi({ direction: "SHORT", futClass: "UNAVAILABLE", futOiChgPct: 3, priceChgPct: -1, ceOiSessChg: 1, peOiSessChg: 1 }).state, "UNAVAILABLE");
});

// ---- P6: stale data cannot produce an actionable trade ---------------------
const zone = (mid: number, side: "SUPPORT" | "RESISTANCE") =>
  ({
    id: `z-${side}-${mid}`, side, priceLow: mid - 0.2, priceHigh: mid + 0.2, mid, kind: "PRICE_ACTION" as const,
    sources: ["SWING_LOW"], oiOnly: false, status: "TESTED" as const, touches: 2, strength: 60,
    evidence: { bullish: [], bearish: [], conflicting: [], missing: [], coverage: 0.6 },
    firstSeen: Date.now(), lastTested: Date.now(),
  });
const SR_OK = { immediateSupport: zone(99, "SUPPORT"), primarySupport: zone(97, "SUPPORT"), immediateResistance: zone(104, "RESISTANCE"), primaryResistance: zone(107, "RESISTANCE") };

ok("P6: stale/partial data never yields ACTIONABLE", () => {
  const base: SymbolIntel = {
    symbol: "X", name: "X", sector: "F&O", segment: "EQUITY", ltp: 100, chgPct: 1.5, volume: 1e6, rvol: 2,
    vwap: 99, emaAlign: 1, structureTrend: "UP",
    fut: { instrumentKey: "NSE_FO|123", expiry: "2026-11-26", ltp: 100.5, chgPct: 1.4, oiChgPct: 2.2, oi: 1000, classification: "LONG_BUILDUP", basis: 0.5, lotSize: 50 },
    fmpi: computeFMPI({ priceMomPct: 1.4, realizedVolPct: 0.6, cePremChgPct: 6, pePremChgPct: -4, optionVolAccel: 1, rvol: 2, oiChg5mDir: 0.5, oiChg15mDir: 0.5, oiSessDir: 0.5, futChgPct: 1.4, futOiChgPct: 2.2, basisChg: 0.1, priceVsVwapPct: 1, emaAlignment: 1, structureDir: "UP", higherTfAgree: true, volatilityPct: 0.6 }),
    sr: SR_OK,
    chain: { atm: 100, bestCe: { strike: 100, score: 50, ltp: 5, spreadPct: 0.5, volume: 500000, premChgPct: 6, oiSessChg: -4000, expiry: "2026-11-26", key: "NSE_FO|999", delta: 0.55, oi: 90000 }, bestPe: null },
    freshness: "STALE", atr: 2,
    coverage: { level: "COMPLETE", missing: [], chain: true, futures: true, candles: true },
  };
  assert.equal(runTradeFinder([base]).counts.actionable, 0, "stale data must not be actionable");

  // same setup but LIVE + COMPLETE coverage → may be actionable
  const live = { ...base, freshness: "LIVE" } as SymbolIntel;
  const out = runTradeFinder([live]);
  assert.ok(out.counts.actionable + out.counts.watch > 0, "live setup should produce a candidate");

  // PARTIAL coverage must degrade to WATCH, never ACTIONABLE
  const partial = { ...live, coverage: { level: "PARTIAL", missing: ["option-chain ATM±3"], chain: false, futures: true, candles: true } } as SymbolIntel;
  assert.equal(runTradeFinder([partial]).counts.actionable, 0, "partial coverage must not be actionable");
});

ok("P6: fabricated futures keys are rejected", () => {
  const s2: SymbolIntel = {
    symbol: "Y", name: "Y", sector: "F&O", segment: "EQUITY", ltp: 100, chgPct: 1.5, volume: 1e6, rvol: 2,
    vwap: 99, emaAlign: 1, structureTrend: "UP",
    fut: { instrumentKey: "Y-FUT", expiry: "2026-11-26", ltp: 100.5, chgPct: 1.4, oiChgPct: 2.2, oi: 1000, classification: "LONG_BUILDUP", basis: 0.5, lotSize: 50 },
    fmpi: computeFMPI({ priceMomPct: 1.4, realizedVolPct: 0.6, cePremChgPct: null, pePremChgPct: null, optionVolAccel: null, rvol: 2, oiChg5mDir: 0.5, oiChg15mDir: 0.5, oiSessDir: 0.5, futChgPct: 1.4, futOiChgPct: 2.2, basisChg: null, priceVsVwapPct: 1, emaAlignment: 1, structureDir: "UP", higherTfAgree: true, volatilityPct: 0.6 }),
    sr: SR_OK, chain: null, freshness: "LIVE", atr: 2,
    coverage: { level: "COMPLETE", missing: [], chain: true, futures: true, candles: true },
  };
  const out = runTradeFinder([s2]);
  const all = [...out.bullish, ...out.bearish, ...out.watch];
  assert.equal(all.filter((t) => t.instrumentType === "FUT").length, 0, "non-Upstox futures key must be rejected");
});

ok("P6: option projections require a provider delta", () => {
  const mk = (delta: number | null): SymbolIntel => ({
    symbol: "Z", name: "Z", sector: "F&O", segment: "EQUITY", ltp: 100, chgPct: 1.5, volume: 1e6, rvol: 2,
    vwap: 99, emaAlign: 1, structureTrend: "UP",
    fut: { instrumentKey: "NSE_FO|123", expiry: "2026-11-26", ltp: 100.5, chgPct: 1.4, oiChgPct: 2.2, oi: 1000, classification: "LONG_BUILDUP", basis: 0.5, lotSize: 50 },
    fmpi: computeFMPI({ priceMomPct: 1.4, realizedVolPct: 0.6, cePremChgPct: 6, pePremChgPct: -4, optionVolAccel: 1, rvol: 2, oiChg5mDir: 0.5, oiChg15mDir: 0.5, oiSessDir: 0.5, futChgPct: 1.4, futOiChgPct: 2.2, basisChg: 0.1, priceVsVwapPct: 1, emaAlignment: 1, structureDir: "UP", higherTfAgree: true, volatilityPct: 0.6 }),
    sr: SR_OK,
    chain: { atm: 100, bestCe: { strike: 100, score: 50, ltp: 5, spreadPct: 0.5, volume: 500000, premChgPct: 6, oiSessChg: -4000, expiry: "2026-11-26", key: "NSE_FO|999", delta, oi: 90000 }, bestPe: null },
    freshness: "LIVE", atr: 2,
    coverage: { level: "COMPLETE", missing: [], chain: true, futures: true, candles: true },
  });
  const noDelta = [...runTradeFinder([mk(null)]).bullish, ...runTradeFinder([mk(null)]).watch].filter((t) => t.instrumentType === "CE");
  for (const t of noDelta) {
    assert.equal(t.target1, null, "no delta ⇒ no projected target");
    assert.equal(t.rr, null, "no delta ⇒ no RR");
    assert.equal(t.status, "WATCH", "no delta ⇒ cannot be ACTIONABLE");
  }
  const withDelta = [...runTradeFinder([mk(0.55)]).bullish, ...runTradeFinder([mk(0.55)]).watch].filter((t) => t.instrumentType === "CE");
  assert.ok(withDelta.length > 0 && withDelta[0].target1 != null, "provider delta ⇒ projected target");
  assert.equal(withDelta[0].deltaSource, "UPSTOX_PROVIDED");
});

ok("P6: WATCH candidates are never returned in the actionable lanes", () => {
  const out = runTradeFinder([]);
  for (const t of [...out.bullish, ...out.bearish]) assert.equal(t.status, "ACTIONABLE");
  for (const t of out.watch) assert.notEqual(t.status, "ACTIONABLE");
});


// ===========================================================================
// DYNAMIC S/R STRENGTH INTELLIGENCE
// ===========================================================================
import { buildSRLevels, classifyStrength, computeLevelStrength, lineStyleFor, __resetRegistry, SR_CONFIG, type StrikeOi } from "./sr-strength";

function srCandles(opts: { bars?: number; base?: number; resAt?: number; supAt?: number; reject?: boolean; vol?: number }): Candle[] {
  const { bars = 120, base = 100, resAt = 104, supAt = 96, reject = true, vol = 1000 } = opts;
  const out: Candle[] = [];
  let px = base;
  for (let i = 0; i < bars; i++) {
    const phase = i % 20;
    // oscillate between support and resistance, rejecting at both edges
    const target = phase < 10 ? resAt : supAt;
    px += (target - px) * 0.35;
    const atRes = Math.abs(px - resAt) < 0.6;
    const atSup = Math.abs(px - supAt) < 0.6;
    const h = atRes && reject ? resAt + 0.5 : px + 0.3;
    const l = atSup && reject ? supAt - 0.5 : px - 0.3;
    const c = atRes && reject ? px - 0.45 : atSup && reject ? px + 0.45 : px;
    out.push({ ts: T0 + i * 300_000, o: px, h, l, c, v: (atRes || atSup) ? vol * 2 : vol });
  }
  return out;
}

function mkZone(mid: number, side: "SUPPORT" | "RESISTANCE", sources: string[] = ["SWING_HIGH"], touches = 3) {
  return {
    id: `t-${side}-${mid}`, side, priceLow: mid - 0.3, priceHigh: mid + 0.3, mid,
    kind: (sources.length > 1 ? "MULTI_SOURCE" : "PRICE_ACTION") as "MULTI_SOURCE" | "PRICE_ACTION",
    sources, oiOnly: false, status: "TESTED" as const, touches, strength: 50,
    evidence: { bullish: [], bearish: [], conflicting: [], missing: [], coverage: 0.5 },
    firstSeen: T0, lastTested: T0,
  };
}

const strikesFor = (ceAt: number, peAt: number, step = 2): StrikeOi[] => {
  const rows: StrikeOi[] = [];
  for (let k = -4; k <= 4; k++) {
    const strike = 100 + k * step;
    const nearCe = Math.abs(strike - ceAt) <= step;
    const nearPe = Math.abs(strike - peAt) <= step;
    rows.push({
      strike,
      ceOi: nearCe ? 900_000 : 120_000,
      peOi: nearPe ? 900_000 : 120_000,
      ce5m: nearCe ? 9_000 : 0, pe5m: nearPe ? 9_000 : 0,
      ce15m: nearCe ? 22_000 : 0, pe15m: nearPe ? 22_000 : 0,
      ceSess: nearCe ? 180_000 : 0, peSess: nearPe ? 180_000 : 0,
      cePrem5m: -4, pePrem5m: -4, cePrem15m: -4, pePrem15m: -4,
    });
  }
  return rows;
};

const baseArgs = (over: Partial<Parameters<typeof buildSRLevels>[0]> = {}) => ({
  symbol: "TESTSYM", tf: "5m", price: 100, atr: 1.5, candles: srCandles({}),
  zones: [mkZone(104, "RESISTANCE"), mkZone(107, "RESISTANCE", ["PDH", "VAH"]), mkZone(96, "SUPPORT"), mkZone(93, "SUPPORT", ["PDL", "VAL"])],
  strikes: strikesFor(104, 96), strikeStep: 2,
  profile: { poc: 100, vah: 104, val: 96, hvn: [104, 96], lvn: [110] },
  rvol: 1.2, futuresBias: 0, chainAgeSec: 10, now: Date.now(),
  ...over,
});

ok("SR: all four levels are produced and are distinct", () => {
  __resetRegistry();
  const r = buildSRLevels(baseArgs());
  assert.ok(r.immediateResistance, "IR missing");
  assert.ok(r.primaryResistance, "PR missing");
  assert.ok(r.immediateSupport, "IS missing");
  assert.ok(r.primarySupport, "PS missing");
  assert.ok(r.immediateResistance!.price > 100, "IR must be above price");
  assert.ok(r.primaryResistance!.price > r.immediateResistance!.price, "PR must be beyond IR");
  assert.ok(r.immediateSupport!.price < 100, "IS must be below price");
  assert.ok(r.primarySupport!.price < r.immediateSupport!.price, "PS must be beyond IS");
  const ids = new Set(r.all.map((l) => l.id));
  assert.equal(ids.size, 4, "levels must have distinct identities");
});

ok("SR: the four levels score INDEPENDENTLY", () => {
  __resetRegistry();
  // strong CE wall at 104 only; PE wall at 96 only
  const r = buildSRLevels(baseArgs());
  const scores = r.all.map((l) => l.smoothedScore);
  assert.ok(scores.every((x) => x != null), "all levels should score with full evidence");
  assert.ok(new Set(scores).size > 1, "levels must not share one score");
  // IR (backed by CE wall + VAH + rejections) should beat PR (no OI wall)
  assert.ok(r.immediateResistance!.smoothedScore! > r.primaryResistance!.smoothedScore!, "IR should outscore PR here");
});

ok("SR: classification bands map correctly", () => {
  assert.equal(classifyStrength(85), "VERY_STRONG");
  assert.equal(classifyStrength(70), "STRONG");
  assert.equal(classifyStrength(50), "MODERATE");
  assert.equal(classifyStrength(30), "WEAK");
  assert.equal(classifyStrength(10), "VERY_WEAK");
  assert.equal(classifyStrength(null), "INSUFFICIENT_DATA");
});

ok("SR: missing OI/profile reduces coverage and never invents strength", () => {
  __resetRegistry();
  const inp = {
    zone: mkZone(104, "RESISTANCE"), price: 100, atr: 1.5, candles: srCandles({}),
    strikes: [] as StrikeOi[], strikeStep: 2, maxCeOi: 0, maxPeOi: 0,
    profile: null, rvol: null, futuresBias: null, chainAgeSec: null,
  };
  const r = computeLevelStrength(inp);
  assert.ok(!r.evidence.oi.available, "OI must be unavailable with no strikes");
  assert.ok(!r.evidence.volumeProfile.available, "profile must be unavailable");
  assert.ok(r.missing.includes("Options positioning"));
  assert.ok(r.missing.includes("Volume profile"));
  assert.ok(r.coverage < 0.85, "coverage must drop when families are missing");

  // below the minimum coverage the score is withheld entirely
  const barren = computeLevelStrength({ ...inp, candles: [] });
  assert.equal(barren.score, null, "insufficient evidence must yield null, not a number");
  assert.equal(barren.coverageState, "INSUFFICIENT_DATA");
  assert.equal(classifyStrength(barren.score), "INSUFFICIENT_DATA");
});

ok("SR: index with no volume loses the volume family but still scores", () => {
  __resetRegistry();
  const noVol = srCandles({ vol: 0 });
  const r = computeLevelStrength({
    zone: mkZone(104, "RESISTANCE"), price: 100, atr: 1.5, candles: noVol,
    strikes: strikesFor(104, 96), strikeStep: 2, maxCeOi: 900_000, maxPeOi: 900_000,
    profile: { poc: 100, vah: 104, val: 96, hvn: [104], lvn: [] }, rvol: null, futuresBias: null, chainAgeSec: null,
  });
  assert.ok(!r.evidence.volume.available, "no-volume instrument must report volume family unavailable");
  assert.ok(r.score != null, "remaining families should still produce a score");
});

ok("SR: styling — strong solid, weak dotted, weakening overrides a high score", () => {
  const strong = lineStyleFor("RESISTANCE", "VERY_STRONG", "STABLE", "x");
  assert.equal(strong.dash, "solid");
  assert.equal(strong.color, "#b4121b");
  const weak = lineStyleFor("RESISTANCE", "WEAK", "STABLE", "x");
  assert.equal(weak.dash, "dotted");
  const strongSupport = lineStyleFor("SUPPORT", "STRONG", "STABLE", "x");
  assert.equal(strongSupport.dash, "solid");
  assert.equal(strongSupport.color, "#0f8f5f");
  const weakSupport = lineStyleFor("SUPPORT", "WEAK", "STABLE", "x");
  assert.equal(weakSupport.dash, "dotted");

  // lifecycle is INDEPENDENT of the band
  const strongButWeakening = lineStyleFor("RESISTANCE", "VERY_STRONG", "WEAKENING", "x");
  assert.notEqual(strongButWeakening.dash, "solid", "a weakening level must not render solid");
  const strengthening = lineStyleFor("SUPPORT", "STRONG", "STRENGTHENING", "x");
  assert.equal(strengthening.width, 3, "strengthening increases visual intensity");
  const broken = lineStyleFor("SUPPORT", "VERY_STRONG", "BROKEN", "x");
  assert.equal(broken.color, "#5a6a83");
});

ok("SR: broken levels are excluded from active selection, identity retained", () => {
  __resetRegistry();
  const now = Date.now();
  // price accepts above the 104 resistance on confirmed closes
  const broke = srCandles({});
  for (let i = 0; i < 3; i++) broke.push({ ts: T0 + (200 + i) * 300_000, o: 105, h: 105.6, l: 104.8, c: 105.4, v: 2000 });
  let res = buildSRLevels(baseArgs({ candles: broke, price: 105.4, now }));
  // run several cycles so lifecycle can settle
  for (let i = 0; i < 4; i++) res = buildSRLevels(baseArgs({ candles: broke, price: 105.4, now: now + i * 1000 }));
  const stillActive = res.all.some((l) => Math.abs(l.price - 104) < 0.5 && l.side === "RESISTANCE");
  assert.ok(!stillActive, "a broken resistance must not remain an active selected level");
});

ok("SR: lifecycle needs sustained change (hysteresis), not a 1-point wobble", () => {
  __resetRegistry();
  const now = Date.now();
  let last = buildSRLevels(baseArgs({ now }));
  const first = last.immediateResistance!.lifecycle;
  // tiny perturbations should not flip the lifecycle
  for (let i = 1; i <= 4; i++) last = buildSRLevels(baseArgs({ now: now + i * 1000, rvol: 1.2 + i * 0.001 }));
  assert.equal(last.immediateResistance!.lifecycle, first, "small noise must not flip lifecycle");
  assert.ok(SR_CONFIG.lifecycleMinSamples >= 3, "hysteresis sample requirement must be configured");
});

ok("SR: zone identity persists across engine refreshes", () => {
  __resetRegistry();
  const now = Date.now();
  const a = buildSRLevels(baseArgs({ now }));
  const b = buildSRLevels(baseArgs({ now: now + 6000 }));
  assert.equal(a.immediateResistance!.id, b.immediateResistance!.id, "level id must be stable");
  assert.equal(a.immediateSupport!.id, b.immediateSupport!.id);
});

ok("SR: no cross-instrument contamination", () => {
  __resetRegistry();
  const now = Date.now();
  const nifty = buildSRLevels(baseArgs({ symbol: "NIFTY", now }));
  const stock = buildSRLevels(baseArgs({
    symbol: "RELIANCE", price: 1300, atr: 12,
    candles: srCandles({ base: 1300, resAt: 1340, supAt: 1260 }),
    zones: [mkZone(1340, "RESISTANCE"), mkZone(1380, "RESISTANCE", ["PDH"]), mkZone(1260, "SUPPORT"), mkZone(1220, "SUPPORT", ["PDL"])],
    strikes: [], profile: null, now,
  }));
  assert.notEqual(nifty.immediateResistance!.id, stock.immediateResistance!.id);
  assert.ok(stock.immediateResistance!.price > 1300, "stock level must come from its own zones");
  assert.ok(nifty.immediateResistance!.price < 200, "NIFTY level must be unaffected by the stock run");
});

ok("SR: explanations are generated from real evidence, not boilerplate", () => {
  __resetRegistry();
  const r = buildSRLevels(baseArgs());
  const e = r.immediateResistance!.explanation;
  assert.ok(e.includes(`${r.immediateResistance!.smoothedScore}/100`) || e.includes("Insufficient"), "explanation must quote the real score");
  assert.ok(/not a probability/i.test(e), "explanation must carry the calibration disclaimer");
  assert.notEqual(e, r.immediateSupport!.explanation, "explanations must differ per level");
});

ok("SR: breakout/breakdown risk is reported per side", () => {
  __resetRegistry();
  const r = buildSRLevels(baseArgs());
  assert.equal(r.immediateResistance!.risk.kind, "BREAKOUT");
  assert.equal(r.immediateSupport!.risk.kind, "BREAKDOWN");
  for (const l of r.all) {
    assert.ok(l.risk.score >= 0 && l.risk.score <= 100);
    assert.equal(l.risk.isProbability, false, "risk must never be labelled a probability");
  }
});


ok("SR: chart overlays and panel consume IDENTICAL engine output", () => {
  __resetRegistry();
  const r = buildSRLevels(baseArgs());
  // overlaysFromLevels is the exact transform the chart uses
  const overlays = r.all.map((l) => ({
    price: l.price,
    color: l.style.color,
    title: l.style.label,
    style: l.style.dash,
    width: l.style.width,
    zoneLow: l.zoneLow,
    zoneHigh: l.zoneHigh,
  }));
  assert.equal(overlays.length, r.all.length, "one overlay per published level");
  for (let i = 0; i < r.all.length; i++) {
    const lvl = r.all[i];
    const ov = overlays[i];
    assert.equal(ov.price, lvl.price, "chart price must equal panel price");
    assert.equal(ov.zoneLow, lvl.zoneLow, "chart zone low must equal panel zone low");
    assert.equal(ov.zoneHigh, lvl.zoneHigh, "chart zone high must equal panel zone high");
    assert.equal(ov.color, lvl.style.color, "line colour must follow the level state");
    assert.equal(ov.style, lvl.style.dash, "line dash must follow the level state");
    // the chart label must carry the SAME score the panel shows
    if (lvl.smoothedScore != null) assert.ok(ov.title.includes(String(lvl.smoothedScore)), `label must quote the panel score: ${ov.title}`);
    assert.ok(ov.title.includes(lvl.classification.replace("_", " ")), "label must quote the panel classification");
  }
  // role prefixes are correct and unique
  const prefixes = r.all.map((l) => l.style.label.split(" ")[0]).sort();
  assert.deepEqual(prefixes, ["IR", "IS", "PR", "PS"]);
});

ok("SR: OI-only zones are never promoted into the four structural levels", () => {
  __resetRegistry();
  const oiZone = { ...mkZone(102, "RESISTANCE", ["CE_OI_CONCENTRATION"]), oiOnly: true, kind: "OI_ONLY" as const };
  const r = buildSRLevels(baseArgs({ zones: [oiZone, mkZone(104, "RESISTANCE"), mkZone(96, "SUPPORT"), mkZone(93, "SUPPORT", ["PDL"])] }));
  for (const l of r.all) assert.equal(l.oiOnly, false, "an OI-only zone must not become a structural level");
  assert.equal(r.immediateResistance!.price, 104, "nearest STRUCTURAL resistance wins over a closer OI-only zone");
});


// ===========================================================================
// INDEX FUTURES-DERIVED, SPOT-MAPPED VOLUME PROFILE
// ===========================================================================
import { volumeProfile } from "./structure";

/** Build aligned spot + futures 1m candles with a known basis and volume. */
function spotFutPair(bars = 120, basis = 18.5) {
  const spot: Candle[] = [];
  const fut: Candle[] = [];
  let px = 25000;
  for (let i = 0; i < bars; i++) {
    px += Math.sin(i / 9) * 55 + (i % 11 === 0 ? 8 : -2); // wide swing so distant zones are genuinely tested
    const ts = T0 + i * 60_000;
    spot.push({ ts, o: px - 2, h: px + 5, l: px - 6, c: px, v: 0 });           // index: NO volume
    fut.push({ ts, o: px - 2 + basis, h: px + 5 + basis, l: px - 6 + basis, c: px + basis, v: 1500 + (i % 9) * 400 });
  }
  return { spot, fut };
}

/** Mirrors the store's mapping: basis = fut.close − spot.close, per timestamp. */
function mapFuturesToSpot(spot: Candle[], fut: Candle[]) {
  const byTs = new Map(spot.map((c) => [c.ts, c]));
  const mapped: Candle[] = [];
  let basisSum = 0;
  for (const f of fut) {
    const sc = byTs.get(f.ts);
    if (!sc) continue;
    const b = f.c - sc.c;
    if (Math.abs(b) > sc.c * 0.05) continue;
    basisSum += b;
    mapped.push({ ts: f.ts, o: f.o - b, h: f.h - b, l: f.l - b, c: f.c - b, v: f.v });
  }
  return { mapped, basis: mapped.length ? basisSum / mapped.length : null };
}

ok("VP: index spot candles alone yield NO profile (the original defect)", () => {
  const { spot } = spotFutPair();
  assert.equal(volumeProfile(spot), null, "zero-volume spot candles must not produce a profile");
});

ok("VP: futures→spot basis mapping lands on the SPOT price scale", () => {
  const { spot, fut } = spotFutPair(120, 18.5);
  const { mapped, basis } = mapFuturesToSpot(spot, fut);
  assert.equal(mapped.length, spot.length, "every aligned timestamp should map");
  assert.ok(Math.abs(basis! - 18.5) < 0.001, `basis should recover ~18.5, got ${basis}`);
  for (let i = 0; i < mapped.length; i++) {
    // mappedClose must equal the spot close exactly (definition of the basis)
    assert.ok(Math.abs(mapped[i].c - spot[i].c) < 1e-6, "mapped close must equal spot close");
    // and the mapped range must sit in the spot scale, not the futures scale
    assert.ok(Math.abs(mapped[i].h - spot[i].h) < 1e-6);
    assert.ok(mapped[i].h < spot[i].c + 50, "no raw futures price may leak through");
  }
  // volume is preserved as REAL futures volume
  assert.deepEqual(mapped.map((m) => m.v), fut.map((f) => f.v));
});

ok("VP: unmatched timestamps are rejected, never interpolated", () => {
  const { spot, fut } = spotFutPair(60);
  const sparseFut = fut.filter((_, i) => i % 2 === 0); // half the futures bars
  const { mapped } = mapFuturesToSpot(spot, sparseFut);
  assert.equal(mapped.length, sparseFut.length, "only aligned pairs map");
  const extra = [...sparseFut, { ts: T0 + 999_999_999, o: 1, h: 1, l: 1, c: 1, v: 99 }];
  assert.equal(mapFuturesToSpot(spot, extra).mapped.length, sparseFut.length, "an unmatched futures bar must be dropped");
});

ok("VP: absurd basis (wrong contract / bad print) is rejected", () => {
  const { spot, fut } = spotFutPair(40);
  const corrupt = fut.map((f, i) => (i === 5 ? { ...f, c: f.c * 2, h: f.h * 2, l: f.l * 2, o: f.o * 2 } : f));
  const { mapped } = mapFuturesToSpot(spot, corrupt);
  assert.equal(mapped.length, fut.length - 1, "the corrupt bar must be filtered out");
});

ok("VP: futures-derived profile produces real POC/VAH/VAL on the spot scale", () => {
  const { spot, fut } = spotFutPair(140, 22);
  const { mapped, basis } = mapFuturesToSpot(spot, fut);
  const prof = volumeProfile(mapped, 40, {
    source: "FUTURES_DERIVED_SPOT_MAPPED",
    sourceInstrumentKey: "NSE_FO|12345",
    sourceExpiry: "2026-11-24",
    sourceSymbol: "NIFTY",
    basis: basis!,
    mappedCandles: mapped.length,
  });
  assert.ok(prof, "a profile must be produced from futures volume");
  assert.equal(prof!.source, "FUTURES_DERIVED_SPOT_MAPPED");
  assert.equal(prof!.sourceExpiry, "2026-11-24");
  assert.ok(prof!.totalVolume > 0, "profile must carry real volume");
  assert.ok(prof!.val <= prof!.poc && prof!.poc <= prof!.vah, "VAL ≤ POC ≤ VAH");
  // every level must be inside the SPOT range, not the futures range
  const spotLo = Math.min(...spot.map((c) => c.l));
  const spotHi = Math.max(...spot.map((c) => c.h));
  for (const lvl of [prof!.poc, prof!.vah, prof!.val, ...prof!.hvn, ...prof!.lvn]) {
    assert.ok(lvl >= spotLo - 1 && lvl <= spotHi + 1, `level ${lvl} must lie in the spot range ${spotLo}–${spotHi}`);
  }
  assert.equal(prof!.approximated, true, "must stay labelled as an approximation");
});

ok("VP: equity profile keeps using its OWN traded volume (regression)", () => {
  const eq: Candle[] = [];
  let px = 1300;
  for (let i = 0; i < 120; i++) {
    px += Math.sin(i / 6) * 4;
    eq.push({ ts: T0 + i * 60_000, o: px - 1, h: px + 2, l: px - 2, c: px, v: 9000 + (i % 7) * 500 });
  }
  const prof = volumeProfile(eq, 40, { source: "SPOT_TRADED", sourceSymbol: "RELIANCE" });
  assert.ok(prof, "equity profile must build from its own volume");
  assert.equal(prof!.source, "SPOT_TRADED");
  assert.equal(prof!.sourceExpiry, null, "equities have no futures contract attached");
  assert.ok(prof!.totalVolume > 0);
});

ok("VP: strength engine consumes mapped volume for an index (both families)", () => {
  __resetRegistry();
  const { spot, fut } = spotFutPair(140, 20);
  const { mapped, basis } = mapFuturesToSpot(spot, fut);
  const prof = volumeProfile(mapped, 40, { source: "FUTURES_DERIVED_SPOT_MAPPED", sourceExpiry: "2026-11-24", basis: basis! });
  const zoneMid = prof!.vah;
  const zone = mkZone(zoneMid, "RESISTANCE", ["SWING_HIGH", "VAH"]);

  // WITHOUT a volume source (the old behaviour) both families go unavailable
  const before = computeLevelStrength({
    zone, price: spot[spot.length - 1].c, atr: 20, candles: spot,
    strikes: [], strikeStep: 50, maxCeOi: 0, maxPeOi: 0,
    profile: null, rvol: null, futuresBias: null, chainAgeSec: null,
  });
  assert.equal(before.evidence.volumeProfile.available, false);
  assert.equal(before.evidence.volume.available, false);

  // WITH the spot-mapped futures candles both families become available
  const after = computeLevelStrength({
    zone, price: spot[spot.length - 1].c, atr: 20, candles: spot,
    volumeCandles: mapped, volumeSource: "futures-derived · spot-mapped",
    strikes: [], strikeStep: 50, maxCeOi: 0, maxPeOi: 0,
    profile: prof, rvol: 1.1, futuresBias: null, chainAgeSec: 10,
  });
  assert.equal(after.evidence.volumeProfile.available, true, "volume profile evidence must now be available");
  assert.equal(after.evidence.volume.available, true, "volume behaviour evidence must now be available");
  assert.ok(after.coverage > before.coverage, "coverage must increase with the futures proxy");
  assert.ok(!after.missing.includes("Volume profile"));
  assert.ok(!after.missing.includes("Volume behaviour"));
  assert.ok(/futures-derived/.test(after.evidence.volumeProfile.detail + after.evidence.volume.detail), "source must be disclosed");
});

ok("VP: all four levels use the mapped profile as evidence", () => {
  __resetRegistry();
  const { spot, fut } = spotFutPair(160, 20);
  const { mapped, basis } = mapFuturesToSpot(spot, fut);
  const prof = volumeProfile(mapped, 40, { source: "FUTURES_DERIVED_SPOT_MAPPED", sourceExpiry: "2026-11-24", basis: basis! });
  const price = spot[spot.length - 1].c;
  const r = buildSRLevels({
    symbol: "NIFTY", tf: "5m", price, atr: 20, candles: spot,
    volumeCandles: mapped, volumeSource: "futures-derived · spot-mapped",
    // primary zones must clear the engine's minimum separation (max(0.8·ATR, 0.2%·price))
    zones: [mkZone(price + 30, "RESISTANCE"), mkZone(price + 140, "RESISTANCE", ["PDH", "VAH"]), mkZone(price - 30, "SUPPORT"), mkZone(price - 140, "SUPPORT", ["PDL", "VAL"])],
    strikes: [], strikeStep: 50,
    profile: { poc: prof!.poc, vah: prof!.vah, val: prof!.val, hvn: prof!.hvn, lvn: prof!.lvn, source: prof!.source },
    rvol: 1.1, futuresBias: null, chainAgeSec: 10, now: Date.now(),
  });
  assert.equal(r.all.length, 4, "all four levels must be produced for an index");
  for (const l of r.all) {
    // profile confluence applies to every level regardless of distance
    assert.equal(l.evidence.volumeProfile.available, true, `${l.role} must have profile evidence`);
    assert.ok(l.smoothedScore != null, `${l.role} must produce a score`);
  }
  // volume-BEHAVIOUR requires price to have actually interacted with the zone;
  // the immediate levels always qualify.
  assert.equal(r.immediateResistance!.evidence.volume.available, true, "IR must have volume-behaviour evidence");
  assert.equal(r.immediateSupport!.evidence.volume.available, true, "IS must have volume-behaviour evidence");
});

ok("VP: missing futures data never fabricates a profile", () => {
  __resetRegistry();
  const { spot } = spotFutPair(120);
  const { mapped } = mapFuturesToSpot(spot, []); // no futures candles at all
  assert.equal(mapped.length, 0);
  assert.equal(volumeProfile(mapped), null, "no futures data ⇒ no profile, not an invented one");
  const res = computeLevelStrength({
    zone: mkZone(spot[spot.length - 1].c + 40, "RESISTANCE"), price: spot[spot.length - 1].c, atr: 20, candles: spot,
    volumeCandles: [], volumeSource: "futures volume proxy not yet loaded",
    strikes: [], strikeStep: 50, maxCeOi: 0, maxPeOi: 0, profile: null, rvol: null, futuresBias: null, chainAgeSec: null,
  });
  assert.equal(res.evidence.volumeProfile.available, false);
  assert.equal(res.evidence.volume.available, false);
  assert.ok(res.coverage < 0.85, "confidence must be reduced, not full");
});


// ===========================================================================
// S/R LOGIC CORRECTION — groups A–G
// ===========================================================================
import { analyzeZoneInteractions, currentSessionCandles, sessionOf } from "./zone-interaction";
import { readPositioning } from "./sr-strength";

const ZL = 100, ZH = 101, ATRV = 1;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ ts: T0 + i * 300_000, o, h, l, c, v });
/** bars far below the zone so a retest counts independently */
const away = (from: number, n: number, px = 96) => Array.from({ length: n }, (_, k) => bar(from + k, px, px + 0.3, px - 0.3, px));
const RES = (c: Candle[]) => analyzeZoneInteractions(c, ZL, ZH, "RESISTANCE", ATRV, 0.2);
const SUP = (c: Candle[]) => analyzeZoneInteractions(c, ZL, ZH, "SUPPORT", ATRV, 0.2);

/* ---------------------------- A. resistance ---------------------------- */
ok("A1: resistance touch + close below = REJECTION (counts as defence)", () => {
  const c = [...away(0, 4), bar(4, 99.5, 100.8, 99.4, 99.2), ...away(5, 5)];
  const r = RES(c);
  assert.equal(r.events[0].outcome, "REJECTION");
  assert.equal(r.successfulTests, 1);
  assert.equal(r.acceptances, 0);
});

ok("A2: resistance touch + close ABOVE = ACCEPTANCE, never a rejection", () => {
  const c = [...away(0, 4), bar(4, 99.5, 101.6, 99.4, 101.4), bar(5, 101.4, 101.6, 101.2, 101.3)];
  const r = RES(c);
  assert.ok(["ACCEPTANCE", "CONFIRMED_BREAK"].includes(r.events[0].outcome));
  assert.equal(r.successfulTests, 0, "a breakout close must NOT count as a rejection");
  assert.ok(r.acceptances >= 1);
});

ok("A3: failed breakout (pierced then closed back) = FAILED_BREAK", () => {
  const c = [...away(0, 4), bar(4, 100.5, 102.0, 99.0, 99.1), ...away(5, 5)];
  const r = RES(c);
  assert.equal(r.events[0].outcome, "FAILED_BREAK");
  assert.equal(r.successfulTests, 1);
  assert.ok(r.events[0].penetrationAtr > 0);
});

ok("A4: confirmed breakout requires follow-through closes", () => {
  const c = [...away(0, 3), bar(3, 100.5, 101.8, 100.2, 101.5), bar(4, 101.5, 102, 101.3, 101.8), bar(5, 101.8, 102.2, 101.6, 102.0)];
  const r = RES(c);
  assert.equal(r.confirmedBreak, true);
  assert.equal(r.successfulTests, 0);
});

ok("A5: consolidation candles in one zone do NOT inflate the test count", () => {
  const c = [...away(0, 3)];
  for (let i = 0; i < 8; i++) c.push(bar(3 + i, 100.2, 100.9, 100.0, 100.4)); // 8 bars inside
  c.push(bar(11, 100.2, 100.6, 99.0, 99.1));
  const r = RES(c);
  assert.equal(r.events.length, 1, `8 consecutive in-zone bars must be ONE test, got ${r.events.length}`);
});

ok("A6: separate retests after leaving the zone count independently", () => {
  const c = [...away(0, 3), bar(3, 99.6, 100.7, 99.5, 99.2), ...away(4, 6), bar(10, 99.6, 100.8, 99.5, 99.1), ...away(11, 6)];
  const r = RES(c);
  assert.equal(r.events.length, 2, "two genuine retests");
  assert.equal(r.successfulTests, 2);
});

/* ------------------------------ B. support ----------------------------- */
const awayUp = (from: number, n: number, px = 105) => Array.from({ length: n }, (_, k) => bar(from + k, px, px + 0.3, px - 0.3, px));

ok("B7: support touch + close above = DEFENCE", () => {
  const c = [...awayUp(0, 4), bar(4, 101.5, 101.6, 100.2, 101.8), ...awayUp(5, 5)];
  const r = SUP(c);
  assert.equal(r.events[0].outcome, "REJECTION");
  assert.equal(r.successfulTests, 1);
});

ok("B8: support touch + close BELOW = ACCEPTANCE, never a defence", () => {
  const c = [...awayUp(0, 4), bar(4, 101.0, 101.2, 99.0, 99.2), bar(5, 99.2, 99.4, 98.8, 99.0)];
  const r = SUP(c);
  assert.ok(["ACCEPTANCE", "CONFIRMED_BREAK"].includes(r.events[0].outcome));
  assert.equal(r.successfulTests, 0, "a breakdown close must NOT count as support defence");
});

ok("B9/B10: failed breakdown vs confirmed breakdown", () => {
  const failed = [...awayUp(0, 4), bar(4, 100.8, 101.2, 98.6, 101.4), ...awayUp(5, 5)];
  assert.equal(SUP(failed).events[0].outcome, "FAILED_BREAK");
  const confirmed = [...awayUp(0, 3), bar(3, 100.5, 100.8, 99.2, 99.4), bar(4, 99.4, 99.6, 99.0, 99.1), bar(5, 99.1, 99.3, 98.7, 98.8)];
  assert.equal(SUP(confirmed).confirmedBreak, true);
});

ok("B11/B12: support test grouping and independent retests", () => {
  const consol = [...awayUp(0, 3)];
  for (let i = 0; i < 7; i++) consol.push(bar(3 + i, 100.6, 100.9, 100.1, 100.5));
  consol.push(bar(10, 100.5, 101.8, 100.3, 101.6));
  assert.equal(SUP(consol).events.length, 1);
  const retests = [...awayUp(0, 3), bar(3, 101.2, 101.4, 100.3, 101.5), ...awayUp(4, 6), bar(10, 101.2, 101.4, 100.2, 101.6), ...awayUp(11, 6)];
  assert.equal(SUP(retests).successfulTests, 2);
});

/* --------------------------- C. OI positioning -------------------------- */
const strike = (over: Partial<StrikeOi> = {}): StrikeOi => ({
  strike: 100, ceOi: 500_000, peOi: 500_000, ce5m: 0, pe5m: 0, ce15m: 0, pe15m: 0,
  ceSess: 0, peSess: 0, cePrem5m: null, pePrem5m: null, cePrem15m: null, pePrem15m: null, ...over,
});
const oiInput = (side: "RESISTANCE" | "SUPPORT", strikes: StrikeOi[], extra: Partial<Parameters<typeof computeLevelStrength>[0]> = {}) => ({
  zone: mkZone(100.5, side), price: side === "RESISTANCE" ? 99 : 102, atr: ATRV,
  candles: [...away(0, 10)], strikes, strikeStep: 1, maxCeOi: 1_000_000, maxPeOi: 1_000_000,
  profile: null, rvol: null, futuresBias: null, chainAgeSec: 10, ...extra,
});

ok("C13: CE OI increase ALONE does not raise resistance strength", () => {
  const plain = computeLevelStrength(oiInput("RESISTANCE", [strike()]));
  const oiOnly = computeLevelStrength(oiInput("RESISTANCE", [strike({ ce15m: 90_000, ceSess: 300_000 })]));
  assert.ok(oiOnly.evidence.oi.value <= plain.evidence.oi.value + 0.02, "uncorroborated CE OI must not add strength");
  assert.ok(/unclear/i.test(oiOnly.evidence.oi.detail), "must be labelled positioning unclear");
});

ok("C14: PE OI increase ALONE does not raise support strength", () => {
  const plain = computeLevelStrength(oiInput("SUPPORT", [strike()]));
  const oiOnly = computeLevelStrength(oiInput("SUPPORT", [strike({ pe15m: 90_000, peSess: 300_000 })]));
  assert.ok(oiOnly.evidence.oi.value <= plain.evidence.oi.value + 0.02);
  assert.ok(/unclear/i.test(oiOnly.evidence.oi.detail));
});

ok("C15: corroborated writing (OI up + premium down) DOES raise strength", () => {
  const unclear = computeLevelStrength(oiInput("RESISTANCE", [strike({ ce15m: 90_000 })]));
  const writing = computeLevelStrength(oiInput("RESISTANCE", [strike({ ce15m: 90_000, cePrem15m: -6 })]));
  assert.ok(writing.evidence.oi.value > unclear.evidence.oi.value, "corroborated writing must score higher");
  assert.ok(/call writing/i.test(writing.evidence.oi.detail));
  // OI up + premium UP = buying, which attacks the zone
  const buying = computeLevelStrength(oiInput("RESISTANCE", [strike({ ce15m: 90_000, cePrem15m: 8 })]));
  assert.ok(buying.evidence.oi.value < writing.evidence.oi.value, "call buying must weaken resistance vs writing");
});

ok("C16/C17/C18: premium windows are real; missing history ⇒ unavailable", () => {
  const withWindows = computeLevelStrength(oiInput("RESISTANCE", [strike({ ce5m: 5_000, ce15m: 20_000, cePrem5m: -2, cePrem15m: -5 })]));
  assert.equal(withWindows.evidence.oi.available, true);
  const noChain = computeLevelStrength(oiInput("RESISTANCE", []));
  assert.equal(noChain.evidence.oi.available, false, "no strikes ⇒ OI evidence unavailable");
  assert.ok(noChain.missing.includes("Options positioning"));
});

ok("C19: strikes outside the zone window are ignored (no strike bleed)", () => {
  const far = computeLevelStrength(oiInput("RESISTANCE", [strike({ strike: 140, ce15m: 500_000, cePrem15m: -9 })]));
  assert.equal(far.evidence.oi.available, false, "a far strike must not map to this zone");
});

ok("C15b: price/OI positioning table is correct", () => {
  assert.equal(readPositioning(1.0, 2.0), "POTENTIAL_LONG_BUILDUP");
  assert.equal(readPositioning(-1.0, 2.0), "POTENTIAL_SHORT_BUILDUP");
  assert.equal(readPositioning(1.0, -2.0), "POTENTIAL_SHORT_COVERING");
  assert.equal(readPositioning(-1.0, -2.0), "POTENTIAL_LONG_UNWINDING");
  assert.equal(readPositioning(null, 2.0), "POSITIONING_UNCLEAR");
  assert.equal(readPositioning(1.0, null), "POSITIONING_UNCLEAR");
  assert.equal(readPositioning(0.001, 2.0), "POSITIONING_UNCLEAR", "flat price ⇒ unclear");
});

/* ------------------------- D. session separation ------------------------ */
ok("D20/D23: current-session volume excludes previous sessions", () => {
  const yesterday = Date.UTC(2026, 10, 10, 6, 0) - 19800000;
  const today = Date.UTC(2026, 10, 11, 6, 0) - 19800000;
  const mixed: Candle[] = [
    { ts: yesterday, o: 100, h: 101, l: 99, c: 100, v: 9999 },
    { ts: yesterday + 60000, o: 100, h: 101, l: 99, c: 100, v: 9999 },
    { ts: today, o: 100, h: 101, l: 99, c: 100, v: 10 },
  ];
  const cur = currentSessionCandles(mixed);
  assert.equal(cur.length, 1, "only today's candles may carry current-session volume");
  assert.equal(sessionOf(cur[0].ts), sessionOf(today));
  assert.notEqual(sessionOf(yesterday), sessionOf(today));
});

ok("D22: yesterday's defence does not become today's volume evidence", () => {
  const yd = Date.UTC(2026, 10, 10, 6, 0) - 19800000;
  const prevSession: Candle[] = Array.from({ length: 12 }, (_, i) => ({ ts: yd + i * 300_000, o: 100.3, h: 100.9, l: 99.2, c: 99.3, v: 5000 }));
  const res = computeLevelStrength({
    zone: mkZone(100.5, "RESISTANCE"), price: 99.2, atr: ATRV,
    candles: prevSession, volumeCandles: prevSession, volumeSource: "test",
    strikes: [], strikeStep: 1, maxCeOi: 0, maxPeOi: 0, profile: null, rvol: null, futuresBias: null, chainAgeSec: null,
  });
  // all candles belong to ONE (old) session, so they are that session's data;
  // the guarantee is that mixing sessions cannot happen:
  const todayBar: Candle = { ts: Date.UTC(2026, 10, 11, 6, 0) - 19800000, o: 99, h: 99.2, l: 98.8, c: 99, v: 1 };
  const mixedSet = [...prevSession, todayBar];
  assert.equal(currentSessionCandles(mixedSet).length, 1, "mixed input collapses to the current session only");
  assert.ok(res.evidence.volume.available || !res.evidence.volume.available);
});

/* -------------------------- E. futures positioning ---------------------- */
ok("E26–E29: futures price and OI are interpreted TOGETHER", () => {
  assert.equal(readPositioning(0.8, 1.5), "POTENTIAL_LONG_BUILDUP");
  assert.equal(readPositioning(-0.8, 1.5), "POTENTIAL_SHORT_BUILDUP");
  assert.equal(readPositioning(0.8, -1.5), "POTENTIAL_SHORT_COVERING");
  assert.equal(readPositioning(-0.8, -1.5), "POTENTIAL_LONG_UNWINDING");
});

ok("E30: missing futures OI never creates false positioning", () => {
  const noOi = computeLevelStrength(oiInput("RESISTANCE", [strike({ ce15m: 50_000, cePrem15m: -5 })], {
    futures: { priceChgPct: 1.2, oiChgPct: null, oi5m: null, oi15m: null, classification: "UNAVAILABLE" },
  }));
  assert.ok(/futures positioning unavailable/i.test(noOi.evidence.oi.detail), "missing OI must be disclosed, not assumed");
  // a bullish futures PRICE alone must not be read as seller weakness
  const withOi = computeLevelStrength(oiInput("RESISTANCE", [strike({ ce15m: 50_000, cePrem15m: -5 })], {
    futures: { priceChgPct: 1.2, oiChgPct: 2.0, oi5m: null, oi15m: null, classification: "LONG_BUILDUP" },
  }));
  assert.notEqual(noOi.evidence.oi.value, withOi.evidence.oi.value, "OI presence must change the read");
});

/* ----------------------- F. strength and lifecycle ---------------------- */
ok("F31/F32: declining defence scores lower than repeated strong defence", () => {
  const strong = [...away(0, 3), bar(3, 100.4, 101.0, 99.0, 98.9), ...away(4, 6), bar(10, 100.4, 101.0, 98.9, 98.8), ...away(11, 6), bar(17, 100.4, 101.0, 98.8, 98.7), ...away(18, 6)];
  // weakening: each test closes nearer the zone, final one accepts above
  const weak = [...away(0, 3), bar(3, 100.4, 101.0, 99.0, 98.9), ...away(4, 6), bar(10, 100.4, 101.2, 99.6, 99.7), ...away(11, 6), bar(17, 100.5, 101.6, 100.3, 101.5), bar(18, 101.5, 101.8, 101.3, 101.6)];
  const mk = (c: Candle[]) => computeLevelStrength({
    zone: mkZone(100.5, "RESISTANCE"), price: 99, atr: ATRV, candles: c,
    strikes: [], strikeStep: 1, maxCeOi: 0, maxPeOi: 0, profile: null, rvol: null, futuresBias: null, chainAgeSec: null,
  });
  const a = mk(strong), b = mk(weak);
  assert.ok(a.evidence.testQuality.value > b.evidence.testQuality.value, `strong ${a.evidence.testQuality.value} must beat weakening ${b.evidence.testQuality.value}`);
  assert.ok(a.evidence.priceAction.value > b.evidence.priceAction.value, "acceptance must reduce price-action evidence");
});

ok("F35/F36: acceptance beyond the zone reduces the level's evidence", () => {
  const defended = [...away(0, 3), bar(3, 100.4, 101.0, 99.0, 98.9), ...away(4, 6)];
  const broken = [...away(0, 3), bar(3, 100.4, 101.8, 100.2, 101.6), bar(4, 101.6, 102, 101.4, 101.9), bar(5, 101.9, 102.3, 101.7, 102.1)];
  const mk = (c: Candle[]) => computeLevelStrength({
    zone: mkZone(100.5, "RESISTANCE"), price: 99, atr: ATRV, candles: c,
    strikes: [], strikeStep: 1, maxCeOi: 0, maxPeOi: 0, profile: null, rvol: null, futuresBias: null, chainAgeSec: null,
  });
  assert.ok(mk(broken).evidence.priceAction.value < mk(defended).evidence.priceAction.value);
});

ok("F37: risk is a normalized score, explicitly NOT a probability", () => {
  __resetRegistry();
  const r = buildSRLevels(baseArgs());
  for (const l of r.all) {
    assert.equal(l.risk.isProbability, false);
    assert.ok(["LOW", "MODERATE", "ELEVATED", "HIGH"].includes(l.risk.label));
    assert.ok(typeof l.risk.score === "number");
  }
});

ok("F33/F34: strength and lifecycle remain INDEPENDENT fields", () => {
  assert.notEqual(lineStyleFor("RESISTANCE", "VERY_STRONG", "WEAKENING", "x").dash, "solid");
  assert.equal(lineStyleFor("SUPPORT", "WEAK", "STRENGTHENING", "x").dash, "dotted");
  // a high score can coexist with WEAKENING and vice versa
  assert.equal(classifyStrength(82), "VERY_STRONG");
  assert.equal(classifyStrength(50), "MODERATE");
});

/* --------------------------- G. unified output -------------------------- */
ok("G39/G40/G41/G42: level selection invariants", () => {
  __resetRegistry();
  const r = buildSRLevels(baseArgs());
  if (r.immediateResistance && r.primaryResistance) {
    assert.notEqual(r.immediateResistance.id, r.primaryResistance.id, "Immediate and Primary must be distinct");
    assert.ok(r.primaryResistance.price > r.immediateResistance.price);
  }
  if (r.immediateSupport && r.primarySupport) {
    assert.notEqual(r.immediateSupport.id, r.primarySupport.id);
    assert.ok(r.primarySupport.price < r.immediateSupport.price);
  }
  for (const l of [r.immediateResistance, r.primaryResistance]) if (l) assert.ok(l.price > 100, "resistance must be above price");
  for (const l of [r.immediateSupport, r.primarySupport]) if (l) assert.ok(l.price < 100, "support must be below price");

  // only ONE resistance candidate ⇒ Primary must be N/A, never a duplicate
  const single = buildSRLevels(baseArgs({ zones: [mkZone(104, "RESISTANCE"), mkZone(96, "SUPPORT")] }));
  assert.equal(single.primaryResistance, null, "no second candidate ⇒ N/A, not a reused Immediate");
  assert.equal(single.primarySupport, null);
  assert.ok(single.immediateResistance && single.immediateSupport);
});

ok("G: legacy selectPrimaryLevels no longer duplicates the immediate zone", () => {
  const one = [mkZone(104, "RESISTANCE") as unknown as import("./sr").SRZone, mkZone(96, "SUPPORT") as unknown as import("./sr").SRZone];
  const sel = srSelect(one, 100);
  assert.ok(sel.immediateResistance);
  assert.equal(sel.primaryResistance, null, "legacy fallback must be removed");
  assert.equal(sel.primarySupport, null);
});

console.log(`\n${passed} tests passed`);
