/**
 * PULSEGRID 2.0 — live store. REAL UPSTOX DATA ONLY.
 *
 * There is no simulated/demo/fallback market data anywhere in this file.
 * Every number served to the UI originates from an Upstox API response and
 * carries provider provenance + a freshness classification derived from the
 * exchange timestamp. When data is not available the payload says so
 * (`available: false` + reason) and the UI renders an explicit empty state.
 */
import { EventEmitter } from "events";
import { db } from "@/db";
import {
  instruments as instrumentsTable,
  quotes as quotesTable,
  candles as candlesTable,
  oiObservations as oiTable,
  oiBaselines as baselinesTable,
  futuresObservations as futTable,
  premiumObservations as premTable,
  fmpiObservations as fmpiTable,
  scannerResults as scannerTable,
  tradeCandidates as tradesTable,
  alerts as alertsTable,
  marketSnapshots as snapsTable,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  apiStats,
  fetchHistoricalCandles,
  fetchIntradayCandles,
  fetchOptionChain,
  fetchQuotes,
  fetchHolidays,
  loadInstrumentMaster,
  UpstoxError,
  type ChainLeg,
  type UnderlyingMeta,
  type UpstoxQuote,
} from "./upstox";
import { getUpstoxTokenSync, isUpstoxLive, tokenStatus } from "./credentials";
import { marketFeed, type FeedTick } from "./feed";
import type { Candle, Freshness, Timeframe } from "@/lib/engine/types";
import { IST_OFFSET_MS, classifyFreshness, marketPhase, nowIstParts, sessionBounds, setExchangeHolidays, tfMinutes } from "@/lib/engine/types";
import { aggregateCandles, atr, bollinger, clamp, emaLast, pctChange, sessionVwap, vwapBands } from "@/lib/engine/indicators";
import { classifyOiShift, computeOiMomentum, rollingOiChange, type OIObs } from "@/lib/engine/oi";
import { analyzeStructure, volumeProfile, type ProfileMeta, type StructureAnalysis, type VolumeProfileResult } from "@/lib/engine/structure";
import { assessZone, buildSRZones, selectPrimaryLevels, type SRSelection, type SRZone } from "@/lib/engine/sr";
import { classifyFutures, computeFMPI, type FMPIOutput } from "@/lib/engine/fmpi";
import { buildSRLevels, pruneRegistry, registrySize, type FuturesPositioning, type SRLevelsResult, type StrikeOi } from "@/lib/engine/sr-strength";
import type { BestStrike } from "@/lib/engine/trading";
import {
  computeTargets,
  dominanceRows,
  evaluateSymbol,
  runTradeFinder,
  scanSymbol,
  type ScannerRow,
  type SymbolIntel,
  type TradeFinderOutput,
} from "@/lib/engine/trading";

const ATM_WINDOW = 3;
const CHAIN_TTL_MS = 8_000;
const CANDLE_TTL_MS = 30_000;
const DAILY_TTL_MS = 60 * 60_000;
const MAX_OBS = 900;
/** rolling number of real trading sessions kept for intraday charts */
const SESSION_WINDOW = 7;
/** option-chain calls per focus cycle (rate-limit aware) */
const CHAIN_BUDGET_OPEN = 8;
const CHAIN_BUDGET_IDLE = 3;
/** a chain older than this is DELAYED coverage */
const CHAIN_STALE_SEC = 180;

export type CoverageLevel = "COMPLETE" | "PARTIAL" | "DELAYED" | "UNAVAILABLE";
export interface CoverageState {
  level: CoverageLevel;
  quote: boolean;
  candles: boolean;
  chain: boolean;
  futures: boolean;
  rvol: boolean;
  chainAgeSec: number | null;
  missing: string[];
  updatedAt: number;
}

export interface Unavailable {
  available: false;
  reason: string;
  code: string;
}

function unavailable(reason: string, code = "NO_DATA"): Unavailable {
  return { available: false, reason, code };
}

/* ------------------------------------------------------------- live types */
interface UnderlyingLive {
  meta: UnderlyingMeta;
  quote: UpstoxQuote | null;
  lastQuoteAt: number;
}

interface OptionLive {
  instrumentKey: string;
  strike: number;
  type: "CE" | "PE";
  expiry: string;
  leg: ChainLeg;
  /** OI history keyed by this contract's own observation time */
  obs: OIObs[];
  premObs: { ts: number; ltp: number; volume: number }[];
  sessionBaselineOi: number | null;
  baselineQuality: BaselineQuality;
  prevSessionOi: number | null;      // provider prev_oi — real pre-session ref
}

interface ChainState {
  symbol: string;
  expiry: string;
  spot: number;
  pcr: number | null;
  strikes: Map<number, { ce?: OptionLive; pe?: OptionLive }>;
  fetchedAt: number;
  error: string | null;
}

/** Futures-derived, spot-mapped volume profile for an index. */
export interface MappedProfile {
  /** CURRENT-SESSION profile only (null when the session has too few bars) */
  profile: VolumeProfileResult | null;
  /** independently computed multi-session profile (structural context) */
  historicalProfile?: VolumeProfileResult | null;
  /** current-session mapped candles, for current-session volume evidence */
  sessionCandles?: Candle[];
  /** futures candles shifted onto the SPOT price scale (real futures volume) */
  mapped: Candle[];
  source: { instrumentKey: string; expiry: string; basis: number; mappedCandles: number; sessionDate: string } | null;
  at: number;
  reason: string | null;
}

interface FuturesLive {
  instrumentKey: string;
  symbol: string;
  expiry: string;
  quote: UpstoxQuote | null;
  /** REAL fetched futures OHLCV candles (never synthesised) */
  candles: Candle[];
  obs: { ts: number; exchangeTs: number | null; ltp: number; oi: number; volume: number }[];
  sessionBaselineOi: number | null;
  baselineQuality: BaselineQuality;
  prevCloseOi: number | null;
}

/** Whether a session baseline is trustworthy as the 09:15 reference. */
export type BaselineQuality = "OPEN_CAPTURE" | "LATE_START" | "RESTORED" | "UNAVAILABLE";

interface CandleCache {
  candles: Candle[];
  at: number;
  error: string | null;
}

class LiveStore {
  events = new EventEmitter();
  startedAt = Date.now();

  /* master */
  underlyings = new Map<string, UnderlyingLive>();
  optionsIndex = new Map<string, { instrumentKey: string; strike: number; type: "CE" | "PE" }[]>();
  masterLoadedAt = 0;
  masterError: string | null = null;
  masterLoading = false;
  holidays: { date: string; description: string }[] = [];

  /* live */
  chains = new Map<string, ChainState>();
  futures = new Map<string, FuturesLive>();
  private candleCache = new Map<string, CandleCache>();
  private dailyCache = new Map<string, CandleCache>();
  private priorSessionVolCache = new Map<string, { vols: { minuteOfDay: number; cum: number }[][]; day: string }>();
  private srCache = new Map<string, { tf: string; zones: SRZone[]; selection: SRSelection; structure: StructureAnalysis; profile: VolumeProfileResult | null; at: number }>();
  private fmpiCache = new Map<string, { out: FMPIOutput; at: number }>();
  private fmpiHistory = new Map<string, number[]>();

  /* scheduler */
  focus = new Set<string>(["NIFTY", "SENSEX"]);
  lastUniversePollAt = 0;
  lastFocusPollAt = 0;
  lastEngineAt = 0;
  pollErrors: string[] = [];
  authError: string | null = null;
  private warmCursor = 0;
  private alertState = new Map<string, string>();
  private lastScanner: ScannerRow[] = [];
  private lastTrades: TradeFinderOutput | null = null;
  dbReady = false;

  constructor() {
    this.events.setMaxListeners(60);
  }

  /* -------------------------------------------------- Feed V3 (WebSocket) */
  feedStarted = false;
  feedTickCount = 0;

  /** Transport actually delivering prices right now — never falsely "WS". */
  get transport(): "WEBSOCKET" | "REST" {
    return marketFeed.isLive ? "WEBSOCKET" : "REST";
  }

  async startFeed(): Promise<void> {
    if (this.feedStarted || this.gate()) return;
    this.feedStarted = true;
    marketFeed.onTicks((ticks) => this.applyFeedTicks(ticks));
    const ok = await marketFeed.connect();
    if (!ok) this.noteError(new Error(marketFeed.lastError ?? "feed connect failed"), "feed");
    this.syncFeedSubscriptions();
  }

  /** Subscribe spot + futures for the whole universe (within V3 key caps). */
  syncFeedSubscriptions(): void {
    if (!this.masterLoadedAt || marketFeed.state === "IDLE") return;
    const spot: string[] = [];
    for (const u of this.underlyings.values()) if (u.meta.spotKey) spot.push(u.meta.spotKey);
    for (const f of this.futures.values()) spot.push(f.instrumentKey);
    marketFeed.subscribe(spot, "ltpc");
    // focused underlyings get full depth/greeks
    const full: string[] = [];
    for (const sym of this.focus) {
      const u = this.underlyings.get(sym);
      if (u?.meta.spotKey) full.push(u.meta.spotKey);
      const f = this.futures.get(sym);
      if (f) full.push(f.instrumentKey);
    }
    if (full.length) marketFeed.subscribe(full, "full");
  }

  /** Merge provider WS ticks into the shared store (same state the REST poll fills). */
  private applyFeedTicks(ticks: FeedTick[]): void {
    const keyToSymbol = this.keyIndex();
    for (const t of ticks) {
      const target = keyToSymbol.get(t.instrumentKey);
      if (!target) continue;
      this.feedTickCount++;
      if (target.kind === "SPOT") {
        const u = this.underlyings.get(target.symbol);
        if (!u) continue;
        u.quote = mergeTick(u.quote, t);
        u.lastQuoteAt = Date.now();
      } else {
        const f = this.futures.get(target.symbol);
        if (!f) continue;
        f.quote = mergeTick(f.quote, t);
        if (t.oi != null && t.oi > 0) {
          const last = f.obs[f.obs.length - 1];
          if (!last || t.receiveTs - last.ts >= 20_000 || last.oi !== t.oi) {
            f.obs.push({ ts: t.receiveTs, exchangeTs: t.ltt, ltp: t.ltp ?? f.quote.ltp, oi: t.oi, volume: t.vtt ?? f.quote.volume });
            if (f.obs.length > MAX_OBS) f.obs.splice(0, 300);
          }
          if (f.sessionBaselineOi == null) {
            const restored = this.restoredBaselines.get(f.instrumentKey);
            if (restored) {
              f.sessionBaselineOi = restored.baseline;
              f.baselineQuality = "RESTORED";
            } else {
              const b = this.captureBaseline(t.oi);
              f.sessionBaselineOi = b.value;
              f.baselineQuality = b.quality;
            }
          }
        }
      }
    }
    this.events.emit("tick", this.quotesPayload());
  }

  private keyIdx: Map<string, { symbol: string; kind: "SPOT" | "FUT" }> | null = null;
  private keyIndex(): Map<string, { symbol: string; kind: "SPOT" | "FUT" }> {
    if (this.keyIdx && this.keyIdx.size) return this.keyIdx;
    const m = new Map<string, { symbol: string; kind: "SPOT" | "FUT" }>();
    for (const [symbol, u] of this.underlyings) if (u.meta.spotKey) m.set(u.meta.spotKey, { symbol, kind: "SPOT" });
    for (const [symbol, f] of this.futures) m.set(f.instrumentKey, { symbol, kind: "FUT" });
    this.keyIdx = m;
    return m;
  }

  /* ------------------------------------------------------------ status -- */
  get tokenPresent(): boolean {
    return !!getUpstoxTokenSync();
  }
  get live(): boolean {
    return isUpstoxLive();
  }
  get universeSize(): number {
    return this.underlyings.size;
  }

  /** Single source of truth for "can we serve real data right now?" */
  gate(): Unavailable | null {
    if (!this.tokenPresent)
      return unavailable(
        "No Upstox access token. Add your token using the control at the top-left of the header to stream live NSE/BSE F&O data.",
        "NO_TOKEN",
      );
    if (this.authError) return unavailable(this.authError, "AUTH");
    if (!this.masterLoadedAt) {
      if (this.masterError) return unavailable(`Instrument master unavailable: ${this.masterError}`, "MASTER");
      return unavailable("Loading the Upstox instrument master…", "LOADING");
    }
    return null;
  }

  async statusPayload() {
    const t = await tokenStatus();
    const phase = marketPhase();
    const today = nowIstParts().date;
    const holiday = this.holidays.find((h) => h.date === today);
    return {
      provider: "UPSTOX" as const,
      tokenConfigured: t.configured,
      tokenVerified: t.lastCheckOk === true,
      tokenMasked: t.masked,
      account: t.userName,
      live: this.live,
      marketPhase: holiday ? "HOLIDAY" : phase,
      holiday: holiday ? holiday.description : null,
      sessionDate: today,
      universe: this.underlyings.size,
      masterLoadedAt: this.masterLoadedAt || null,
      masterError: this.masterError,
      authError: this.authError,
      lastUniversePollAt: this.lastUniversePollAt || null,
      lastFocusPollAt: this.lastFocusPollAt || null,
      api: { ...apiStats },
      transport: this.transport,
      feed: marketFeed.status(),
      feedTicks: this.feedTickCount,
      coverage: (() => {
        const c: Record<string, number> = { COMPLETE: 0, PARTIAL: 0, DELAYED: 0, UNAVAILABLE: 0 };
        for (const v of this.coverage.values()) c[v.level] = (c[v.level] ?? 0) + 1;
        return c;
      })(),
      dbReady: this.dbReady,
      recentErrors: this.pollErrors.slice(-5),
    };
  }

  private noteError(e: unknown, where: string): void {
    const err = e instanceof UpstoxError ? e : new UpstoxError((e as Error).message);
    if (err.code === "AUTH") this.authError = `${err.message}. Re-enter a valid Upstox access token.`;
    const line = `${new Date().toISOString().slice(11, 19)} ${where}: ${err.message}`;
    this.pollErrors.push(line);
    if (this.pollErrors.length > 40) this.pollErrors.splice(0, 20);
  }

  /* ------------------------------------------------------------- master -- */
  async ensureMaster(): Promise<void> {
    if (this.masterLoadedAt || this.masterLoading || !this.tokenPresent) return;
    this.masterLoading = true;
    try {
      const m = await loadInstrumentMaster();
      this.underlyings.clear();
      for (const [symbol, meta] of m.underlyings) this.underlyings.set(symbol, { meta, quote: null, lastQuoteAt: 0 });
      for (const [k, v] of m.optionsByUnderlyingExpiry) this.optionsIndex.set(k, v);
      this.masterLoadedAt = m.loadedAt;
      this.masterError = null;
      this.authError = null;
      for (const [symbol, meta] of m.underlyings) {
        const f = meta.futures[0];
        if (f) {
          this.futures.set(symbol, {
            instrumentKey: f.instrumentKey,
            symbol,
            expiry: f.expiry,
            quote: null,
            candles: [],
            obs: [],
            sessionBaselineOi: null,
            baselineQuality: "UNAVAILABLE",
            prevCloseOi: null,
          });
        }
      }
      void this.persistInstrumentMaster();
      void fetchHolidays()
        .then((h) => {
          this.holidays = h.map((x) => ({ date: x.date, description: x.description }));
          // single source of truth for session logic
          setExchangeHolidays(this.holidays.map((x) => x.date));
        })
        .catch(() => undefined);
      await this.restoreBaselines();
      await this.restoreObservations();
    } catch (e) {
      this.masterError = (e as Error).message;
      this.noteError(e, "instrument-master");
    } finally {
      this.masterLoading = false;
    }
  }

  private async persistInstrumentMaster(): Promise<void> {
    try {
      const rows: (typeof instrumentsTable.$inferInsert)[] = [];
      for (const [symbol, u] of this.underlyings) {
        rows.push({
          instrumentKey: u.meta.spotKey,
          symbol,
          name: u.meta.name,
          exchange: u.meta.exchange,
          segment: u.meta.segment,
          lotSize: u.meta.lotSize || 1,
          tickSize: u.meta.tickSize || 0.05,
          strikeInterval: u.meta.strikeInterval,
          isFo: true,
          source: "UPSTOX",
          updatedAt: new Date(),
        });
        for (const f of u.meta.futures) {
          rows.push({
            instrumentKey: f.instrumentKey,
            symbol,
            name: `${symbol} FUT ${f.expiry}`,
            exchange: u.meta.exchange,
            segment: "FUT",
            underlying: symbol,
            expiry: f.expiry,
            lotSize: f.lotSize || 1,
            tickSize: u.meta.tickSize || 0.05,
            isFo: true,
            source: "UPSTOX",
            updatedAt: new Date(),
          });
        }
      }
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await db
          .insert(instrumentsTable)
          .values(rows.slice(i, i + CHUNK))
          .onConflictDoNothing({ target: [instrumentsTable.instrumentKey] });
      }
      this.dbReady = true;
    } catch {
      this.dbReady = false;
    }
  }

  /** Reload persisted session baselines so a restart never loses them. */
  private async restoreBaselines(): Promise<void> {
    try {
      const session = nowIstParts().date;
      const rows = await db.select().from(baselinesTable).where(eq(baselinesTable.sessionDate, session));
      this.restoredBaselines = new Map(
        rows.map((r) => [r.instrumentKey, { baseline: Number(r.baselineOi), prev: r.prevSessionOi == null ? null : Number(r.prevSessionOi) }]),
      );
      this.restoredBaselineQuality = new Map(rows.map((r) => [r.instrumentKey, (r.quality as BaselineQuality) ?? "RESTORED"]));
      this.dbReady = true;
    } catch {
      this.restoredBaselines = new Map();
    }
  }
  private restoredBaselines = new Map<string, { baseline: number; prev: number | null }>();
  private restoredObs = new Map<string, OIObs[]>();
  private restoredBaselineQuality = new Map<string, BaselineQuality>();

  /**
   * PRIORITY 5C — a baseline captured well after the open is NOT the morning
   * reference. It is recorded as LATE_START so session-cumulative OI can be
   * reported as incomplete instead of silently wrong.
   */
  private captureBaseline(oi: number): { value: number; quality: BaselineQuality } {
    const { minutes } = nowIstParts();
    const open = sessionBounds().regularStart;
    const phase = marketPhase();
    const nearOpen = phase === "OPEN" && minutes <= open + 3;
    const preOpen = phase === "PRE_OPEN" || phase === "CLOSED" || phase === "WEEKEND" || phase === "HOLIDAY";
    return { value: oi, quality: nearOpen || preOpen ? "OPEN_CAPTURE" : "LATE_START" };
  }

  /**
   * PRIORITY 5C — restore today's persisted OI observations so 5m/15m rolling
   * windows survive a process restart instead of silently returning N/A.
   */
  private async restoreObservations(): Promise<void> {
    try {
      const session = nowIstParts().date;
      const since = new Date(Date.now() - 60 * 60_000);
      const rows = await db
        .select({
          instrumentKey: oiTable.instrumentKey,
          observedAt: oiTable.observedAt,
          oi: oiTable.oi,
          ltp: oiTable.ltp,
          volume: oiTable.volume,
        })
        .from(oiTable)
        .where(sql`${oiTable.observedAt} >= ${since}`)
        .orderBy(oiTable.observedAt);
      const map = new Map<string, OIObs[]>();
      for (const r of rows) {
        const list = map.get(r.instrumentKey) ?? [];
        list.push({ ts: new Date(r.observedAt).getTime(), oi: Number(r.oi), ltp: r.ltp ?? undefined, volume: r.volume ?? undefined });
        map.set(r.instrumentKey, list);
      }
      this.restoredObs = map;

      const frows = await db
        .select({ instrumentKey: futTable.instrumentKey, observedAt: futTable.observedAt, oi: futTable.oi, ltp: futTable.ltp, volume: futTable.volume })
        .from(futTable)
        .where(sql`${futTable.observedAt} >= ${since}`)
        .orderBy(futTable.observedAt);
      for (const r of frows) {
        const f = [...this.futures.values()].find((x) => x.instrumentKey === r.instrumentKey);
        if (!f) continue;
        f.obs.push({ ts: new Date(r.observedAt).getTime(), exchangeTs: null, ltp: r.ltp, oi: Number(r.oi), volume: Number(r.volume) });
      }
      for (const f of this.futures.values()) f.obs.sort((a, b) => a.ts - b.ts);
      void session;
    } catch {
      this.restoredObs = new Map();
    }
  }

  /* -------------------------------------------------------------- polls -- */
  /**
   * Mark a symbol as user-focused (refreshed every cycle). Eviction only
   * removes a symbol from the PRIORITY lane — the round-robin in pollFocus
   * still reaches every eligible instrument, so nothing is excluded.
   */
  setFocus(symbol: string): void {
    if (!symbol || !this.underlyings.has(symbol)) return;
    this.focus.delete(symbol);
    this.focus.add(symbol); // refresh recency
    const pinned = ["NIFTY", "SENSEX"];
    const extra = [...this.focus].filter((s) => !pinned.includes(s));
    while (extra.length > 4) {
      const drop = extra.shift()!;
      this.focus.delete(drop);
    }
  }

  /** Spot + near-month futures quotes for the entire F&O universe. */
  async pollUniverse(): Promise<void> {
    const gate = this.gate();
    if (gate) return;
    const keys: string[] = [];
    const spotOwner = new Map<string, string>();
    const futOwner = new Map<string, string>();
    for (const [symbol, u] of this.underlyings) {
      if (u.meta.spotKey) {
        keys.push(u.meta.spotKey);
        spotOwner.set(u.meta.spotKey, symbol);
      }
      const f = this.futures.get(symbol);
      if (f) {
        keys.push(f.instrumentKey);
        futOwner.set(f.instrumentKey, symbol);
      }
    }
    if (!keys.length) return;
    try {
      const quotes = await fetchQuotes(keys);
      const now = Date.now();
      for (const [key, q] of quotes) {
        const sSym = spotOwner.get(key);
        if (sSym) {
          const u = this.underlyings.get(sSym)!;
          u.quote = q;
          u.lastQuoteAt = now;
          continue;
        }
        const fSym = futOwner.get(key);
        if (fSym) {
          const f = this.futures.get(fSym)!;
          f.quote = q;
          if (q.oi > 0) {
            // PRIORITY 5A: the observation timestamp is this snapshot's own
            // collection time; the exchange stamp is retained separately.
            f.obs.push({ ts: q.receiveTs, exchangeTs: q.exchangeTs, ltp: q.ltp, oi: q.oi, volume: q.volume });
            if (f.obs.length > MAX_OBS) f.obs.splice(0, 300);
            if (f.sessionBaselineOi == null) {
              const restored = this.restoredBaselines.get(f.instrumentKey);
              if (restored) {
                f.sessionBaselineOi = restored.baseline;
                f.baselineQuality = "RESTORED";
              } else {
                const b = this.captureBaseline(q.oi);
                f.sessionBaselineOi = b.value;
                f.baselineQuality = b.quality;
              }
            }
          }
        }
      }
      this.lastUniversePollAt = now;
      this.authError = null;
      void this.persistQuotes();
      this.events.emit("tick", this.quotesPayload());
    } catch (e) {
      this.noteError(e, "universe-quotes");
    }
  }

  /**
   * PRIORITY 4 — coverage management for the WHOLE eligible F&O universe.
   *
   * User-focused symbols are refreshed every cycle; the remainder of the
   * universe is advanced by a rate-limit-aware round-robin cursor so that no
   * eligible instrument is permanently excluded. Per-underlying coverage state
   * is tracked and exposed to the analysis engines.
   */
  async pollFocus(): Promise<void> {
    const gate = this.gate();
    if (gate) return;
    const budget = marketPhase() === "OPEN" ? CHAIN_BUDGET_OPEN : CHAIN_BUDGET_IDLE;
    const targets: string[] = [];
    for (const symbol of this.focus) if (this.underlyings.has(symbol)) targets.push(symbol);

    // round-robin the rest of the universe (most-stale first within the slice)
    const all = [...this.underlyings.keys()];
    let guard = 0;
    while (targets.length < budget && guard < all.length) {
      const sym = all[this.warmCursor % all.length];
      this.warmCursor++;
      guard++;
      if (!targets.includes(sym)) targets.push(sym);
    }

    for (const symbol of targets) {
      const u = this.underlyings.get(symbol);
      if (!u) continue;
      const expiry = u.meta.expiries[0];
      if (expiry) await this.refreshChain(symbol, expiry).catch(() => undefined);
      await this.getCandles(symbol, "1m").catch(() => undefined);
      this.updateCoverage(symbol);
    }
    for (const symbol of all) this.updateCoverage(symbol);
    this.lastFocusPollAt = Date.now();
  }

  /** Per-underlying data-coverage state consumed by scanner / Trade Finder. */
  coverage = new Map<string, CoverageState>();

  updateCoverage(symbol: string): CoverageState {
    const u = this.underlyings.get(symbol);
    const now = Date.now();
    if (!u) {
      const st: CoverageState = { level: "UNAVAILABLE", quote: false, candles: false, chain: false, futures: false, rvol: false, chainAgeSec: null, missing: ["instrument"], updatedAt: now };
      this.coverage.set(symbol, st);
      return st;
    }
    const expiry = u.meta.expiries[0];
    const chain = expiry ? this.chains.get(`${symbol}|${expiry}`) : undefined;
    const atm = chain ? this.atmOf(symbol, chain) : null;
    const step = this.strikeStep(symbol, chain);
    // ATM ±3 must actually be present on both sides for a COMPLETE chain
    let atmBand = false;
    if (chain && atm != null) {
      atmBand = true;
      for (let k = -ATM_WINDOW; k <= ATM_WINDOW; k++) {
        const slot = chain.strikes.get(atm + k * step);
        if (!slot?.ce || !slot?.pe) {
          atmBand = false;
          break;
        }
      }
    }
    const f = this.futures.get(symbol);
    const quoteOk = !!u.quote;
    const candlesOk = (this.candleCache.get(`${symbol}|1m`)?.candles.length ?? 0) >= 25;
    const futOk = !!f?.quote;
    const rvolOk = this.rvolCache.has(symbol);
    const chainAgeSec = chain?.fetchedAt ? Math.round((now - chain.fetchedAt) / 1000) : null;
    const missing: string[] = [];
    if (!quoteOk) missing.push("quote");
    if (!candlesOk) missing.push("candles");
    if (!atmBand) missing.push("option-chain ATM±3");
    if (!futOk) missing.push("futures");
    if (!rvolOk) missing.push("rvol");

    let level: CoverageLevel;
    if (!quoteOk) level = "UNAVAILABLE";
    else if (quoteOk && candlesOk && atmBand && futOk) level = chainAgeSec != null && chainAgeSec > CHAIN_STALE_SEC ? "DELAYED" : "COMPLETE";
    else level = "PARTIAL";

    const st: CoverageState = { level, quote: quoteOk, candles: candlesOk, chain: atmBand, futures: futOk, rvol: rvolOk, chainAgeSec, missing, updatedAt: now };
    this.coverage.set(symbol, st);
    return st;
  }

  coveragePayload() {
    const gate = this.gate();
    if (gate) return gate;
    const counts: Record<string, number> = { COMPLETE: 0, PARTIAL: 0, DELAYED: 0, UNAVAILABLE: 0 };
    const rows = [];
    for (const [symbol, c] of this.coverage) {
      counts[c.level] = (counts[c.level] ?? 0) + 1;
      rows.push({ symbol, ...c });
    }
    return { available: true as const, total: this.underlyings.size, counts, rows: rows.sort((a, b) => a.symbol.localeCompare(b.symbol)) };
  }

  /* --------------------------------------------------------- option chain */
  async refreshChain(symbol: string, expiry: string): Promise<ChainState | null> {
    const u = this.underlyings.get(symbol);
    if (!u) return null;
    const mk = `${symbol}|${expiry}`;
    const existing = this.chains.get(mk);
    if (existing && Date.now() - existing.fetchedAt < CHAIN_TTL_MS) return existing;
    try {
      const res = await fetchOptionChain(u.meta.spotKey, expiry);
      const state: ChainState =
        existing ?? { symbol, expiry, spot: NaN, pcr: null, strikes: new Map(), fetchedAt: 0, error: null };
      state.spot = res.spot;
      state.fetchedAt = res.fetchedAt;
      state.error = null;
      // PRIORITY 5A: option-chain snapshots are stamped with their OWN
      // collection time, never with the underlying's last-trade timestamp.
      const ts = res.fetchedAt;
      for (const row of res.rows) {
        let slot = state.strikes.get(row.strike);
        if (!slot) {
          slot = {};
          state.strikes.set(row.strike, slot);
        }
        for (const side of ["ce", "pe"] as const) {
          const legData = side === "ce" ? row.ce : row.pe;
          if (!legData) continue;
          let live = slot[side];
          if (!live) {
            const restored = this.restoredBaselines.get(legData.instrumentKey);
            live = {
              instrumentKey: legData.instrumentKey,
              strike: row.strike,
              type: side === "ce" ? "CE" : "PE",
              expiry: row.expiry,
              leg: legData,
              obs: this.restoredObs.get(legData.instrumentKey) ?? [],
              premObs: [],
              sessionBaselineOi: restored?.baseline ?? null,
              baselineQuality: restored ? "RESTORED" : "UNAVAILABLE",
              prevSessionOi: legData.prevOi ?? restored?.prev ?? null,
            };
            slot[side] = live;
          }
          live.leg = legData;
          if (legData.prevOi != null) live.prevSessionOi = legData.prevOi;
          if (legData.oi > 0) {
            const last = live.obs[live.obs.length - 1];
            if (!last || ts - last.ts >= 20_000 || last.oi !== legData.oi) {
              live.obs.push({ ts, oi: legData.oi, ltp: legData.ltp, volume: legData.volume });
              if (live.obs.length > MAX_OBS) live.obs.splice(0, 300);
            }
            if (live.sessionBaselineOi == null) {
              const b = this.captureBaseline(legData.oi);
              live.sessionBaselineOi = b.value;
              live.baselineQuality = b.quality;
            }
          }
          if (Number.isFinite(legData.ltp)) {
            const lastP = live.premObs[live.premObs.length - 1];
            if (!lastP || ts - lastP.ts >= 20_000) {
              live.premObs.push({ ts, ltp: legData.ltp, volume: legData.volume });
              if (live.premObs.length > MAX_OBS) live.premObs.splice(0, 300);
            }
          }
        }
      }
      this.chains.set(mk, state);
      void this.persistChainObservations(symbol, state);
      return state;
    } catch (e) {
      this.noteError(e, `option-chain ${symbol}`);
      if (existing) {
        existing.error = (e as Error).message;
        return existing;
      }
      this.chains.set(mk, { symbol, expiry, spot: NaN, pcr: null, strikes: new Map(), fetchedAt: 0, error: (e as Error).message });
      return null;
    }
  }

  /* -------------------------------------------------------------- candles */
  /**
   * Rolling multi-session intraday series.
   *
   *  - prior sessions come from /v3/historical-candle (cached for the day)
   *  - the current session comes from /v3/historical-candle/intraday (30s TTL)
   *  - the two are merged and de-duplicated by exchange timestamp
   *  - the window is trimmed to the last SESSION_WINDOW real trading sessions
   *
   * Nothing is interpolated: non-trading days simply do not appear.
   */
  async getCandles(symbol: string, tf: Timeframe): Promise<Candle[]> {
    const u = this.underlyings.get(symbol);
    if (!u) return [];
    if (tf === "1D") return this.getDailyCandles(symbol);
    const key = `${symbol}|1m`;
    const today = nowIstParts().date;
    const hit = this.candleCache.get(key);
    if (hit && Date.now() - hit.at < CANDLE_TTL_MS) {
      return tf === "1m" ? hit.candles : aggregateCandles(hit.candles, tfMinutes(tf));
    }

    try {
      // --- prior sessions (cheap: one call per symbol per day) --------------
      let hist = this.histCache.get(symbol);
      if (!hist || hist.day !== today) {
        const to = today;
        const from = new Date(Date.now() + IST_OFFSET_MS - (SESSION_WINDOW + 7) * 86400_000).toISOString().slice(0, 10);
        const raw = await fetchHistoricalCandles(u.meta.spotKey, "minutes", 1, from, to);
        hist = { candles: raw.map((c) => ({ ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })), day: today, at: Date.now() };
        this.histCache.set(symbol, hist);
      }

      // --- current session (frequently refreshed) ---------------------------
      let intradayToday: Candle[] = [];
      try {
        const raw = await fetchIntradayCandles(u.meta.spotKey, "minutes", 1);
        intradayToday = raw.map((c) => ({ ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
      } catch {
        intradayToday = [];
      }

      // --- merge + dedupe by exchange timestamp -----------------------------
      const byTs = new Map<number, Candle>();
      for (const c of hist.candles) byTs.set(c.ts, c);
      for (const c of intradayToday) byTs.set(c.ts, c);
      let candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);

      // --- trim to the last N real trading sessions -------------------------
      const sessions: string[] = [];
      for (const c of candles) {
        const d = istDate(c.ts);
        if (sessions[sessions.length - 1] !== d) sessions.push(d);
      }
      const keep = new Set(sessions.slice(-SESSION_WINDOW));
      candles = candles.filter((c) => keep.has(istDate(c.ts)));

      const lastSession = sessions[sessions.length - 1] ?? null;
      this.candleCache.set(key, { candles, at: Date.now(), error: null });
      this.candleMeta.set(symbol, {
        historical: lastSession !== today,
        sessionDate: lastSession,
        sessions: [...keep],
      });
      void this.persistCandles(u.meta.spotKey, candles.slice(-5));
      return tf === "1m" ? candles : aggregateCandles(candles, tfMinutes(tf));
    } catch (e) {
      this.noteError(e, `candles ${symbol}`);
      this.candleCache.set(key, { candles: hit?.candles ?? [], at: Date.now() - CANDLE_TTL_MS + 5_000, error: (e as Error).message });
      return hit?.candles ?? [];
    }
  }
  private histCache = new Map<string, { candles: Candle[]; day: string; at: number }>();

  /* ===================================================================
   * INDEX VOLUME SOURCE — futures candles mapped onto the spot price scale.
   *
   * A spot index has no traded volume, so its volume profile is derived from
   * the ACTIVE futures contract. Futures prices are shifted onto the spot
   * scale with a timestamp-aligned basis so every plotted level is a genuine
   * spot-scale price, while the volume remains real futures volume.
   * =================================================================== */
  private futCandleCache = new Map<string, { candles: Candle[]; at: number; day: string }>();
  private mappedCache = new Map<string, MappedProfile>();

  /** Real OHLCV candles for the ACTIVE futures contract (never synthesised). */
  async getFuturesCandles(symbol: string): Promise<{ candles: Candle[]; instrumentKey: string; expiry: string } | null> {
    const f = this.futures.get(symbol);
    if (!f) return null;
    const today = nowIstParts().date;
    // cache is keyed by the CONTRACT key, so a rollover invalidates naturally
    const hit = this.futCandleCache.get(f.instrumentKey);
    if (hit && hit.day === today && Date.now() - hit.at < CANDLE_TTL_MS) {
      return { candles: hit.candles, instrumentKey: f.instrumentKey, expiry: f.expiry };
    }
    try {
      const to = today;
      const from = new Date(Date.now() + IST_OFFSET_MS - (SESSION_WINDOW + 7) * 86400_000).toISOString().slice(0, 10);
      const [hist, intra] = await Promise.all([
        fetchHistoricalCandles(f.instrumentKey, "minutes", 1, from, to).catch(() => []),
        fetchIntradayCandles(f.instrumentKey, "minutes", 1).catch(() => []),
      ]);
      const byTs = new Map<number, Candle>();
      for (const c of hist) byTs.set(c.ts, { ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
      for (const c of intra) byTs.set(c.ts, { ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
      const candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);
      this.futCandleCache.set(f.instrumentKey, { candles, at: Date.now(), day: today });
      // keep the live FuturesState.candles populated with REAL fetched data
      f.candles = candles.slice(-420);
      return { candles, instrumentKey: f.instrumentKey, expiry: f.expiry };
    } catch (e) {
      this.noteError(e, `futures-candles ${symbol}`);
      return hit ? { candles: hit.candles, instrumentKey: f.instrumentKey, expiry: f.expiry } : null;
    }
  }

  /**
   * Map futures candles onto the spot price scale using a per-candle basis.
   *
   *   basis        = futures.close − spot.close   (same exchange timestamp)
   *   mappedOHLC   = futuresOHLC − basis
   *   mappedVolume = REAL futures volume
   *
   * Only timestamps present in BOTH series are used; nothing is interpolated.
   */
  async buildMappedProfile(symbol: string, tf: Timeframe): Promise<MappedProfile> {
    const key = `${symbol}|${tf}`;
    const cached = this.mappedCache.get(key);
    if (cached && Date.now() - cached.at < 15_000) return cached;

    const empty = (reason: string): MappedProfile => {
      const out: MappedProfile = { profile: null, historicalProfile: null, sessionCandles: [], mapped: [], source: null, at: Date.now(), reason };
      this.mappedCache.set(key, out);
      return out;
    };

    const u = this.underlyings.get(symbol);
    if (!u) return empty("unknown instrument");
    const fut = await this.getFuturesCandles(symbol);
    if (!fut || fut.candles.length < 10) return empty("No futures candles available from Upstox for the active contract");

    const spot1m = this.candleCache.get(`${symbol}|1m`)?.candles ?? [];
    if (spot1m.length < 10) return empty("Spot candles not loaded yet");
    const spotByTs = new Map(spot1m.map((c) => [c.ts, c]));

    // --- timestamp-aligned basis mapping -----------------------------------
    const mapped1m: Candle[] = [];
    let basisSum = 0;
    for (const fc of fut.candles) {
      const sc = spotByTs.get(fc.ts);
      if (!sc) continue;                                  // reject unmatched
      if (!Number.isFinite(fc.c) || !Number.isFinite(sc.c)) continue;
      const basis = fc.c - sc.c;
      if (!Number.isFinite(basis)) continue;
      // sanity: reject absurd basis (bad print / wrong contract)
      if (Math.abs(basis) > sc.c * 0.05) continue;
      basisSum += basis;
      mapped1m.push({ ts: fc.ts, o: fc.o - basis, h: fc.h - basis, l: fc.l - basis, c: fc.c - basis, v: fc.v });
    }
    if (mapped1m.length < 10) return empty("Too few timestamp-aligned spot/futures candles to map a basis");

    // --- SESSION profile: never mix sessions --------------------------------
    const lastDay = istDate(mapped1m[mapped1m.length - 1].ts);
    const session = mapped1m.filter((c) => istDate(c.ts) === lastDay);
    const basisAvg = basisSum / mapped1m.length;
    const meta: Partial<ProfileMeta> = {
      source: "FUTURES_DERIVED_SPOT_MAPPED",
      sourceInstrumentKey: fut.instrumentKey,
      sourceExpiry: fut.expiry,
      sourceSymbol: symbol,
      sessionDate: lastDay,
      basis: Math.round(basisAvg * 100) / 100,
      mappedCandles: session.length,
    };
    // PRIORITY 3 — the CURRENT-SESSION profile uses current-session candles
    // ONLY. If there are too few, we report insufficient history instead of
    // silently mixing in previous sessions.
    const profile = session.length >= 10 ? volumeProfile(session, 40, meta) : null;
    const historical = volumeProfile(mapped1m, 40, { ...meta, sessionDate: null, mappedCandles: mapped1m.length });
    const out: MappedProfile = {
      profile,
      historicalProfile: historical,
      sessionCandles: session,
      mapped: tf === "1m" ? mapped1m : aggregateCandles(mapped1m, tfMinutes(tf)),
      source: { instrumentKey: fut.instrumentKey, expiry: fut.expiry, basis: Math.round(basisAvg * 100) / 100, mappedCandles: session.length, sessionDate: lastDay },
      at: Date.now(),
      reason: profile
        ? null
        : `Insufficient current-session futures candles (${session.length}) to build a session profile — no mixed-session substitution was made`,
    };
    this.mappedCache.set(key, out);
    return out;
  }

  /** Sync accessor used by the engines (warmed by the worker / API route). */
  mappedProfileSync(symbol: string, tf: Timeframe): MappedProfile | null {
    return this.mappedCache.get(`${symbol}|${tf}`) ?? null;
  }

  isIndex(symbol: string): boolean {
    return this.underlyings.get(symbol)?.meta.segment === "INDEX";
  }

  /** Candles belonging ONLY to the most recent trading session in the window. */
  sessionCandles(symbol: string): Candle[] {
    const all = this.candleCache.get(`${symbol}|1m`)?.candles ?? [];
    if (!all.length) return [];
    const last = istDate(all[all.length - 1].ts);
    return all.filter((c) => istDate(c.ts) === last);
  }

  candleMeta = new Map<string, { historical: boolean; sessionDate: string | null; sessions: string[] }>();

  async getDailyCandles(symbol: string): Promise<Candle[]> {
    const u = this.underlyings.get(symbol);
    if (!u) return [];
    const hit = this.dailyCache.get(symbol);
    if (hit && Date.now() - hit.at < DAILY_TTL_MS) return hit.candles;
    try {
      const to = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
      const from = new Date(Date.now() + IST_OFFSET_MS - 160 * 86400_000).toISOString().slice(0, 10);
      const raw = await fetchHistoricalCandles(u.meta.spotKey, "days", 1, from, to);
      const candles: Candle[] = raw.map((c) => ({ ts: c.ts, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }));
      this.dailyCache.set(symbol, { candles, at: Date.now(), error: null });
      return candles;
    } catch (e) {
      this.noteError(e, `daily ${symbol}`);
      return hit?.candles ?? [];
    }
  }

  /** Cached sync accessor used by the engines (no fetch inside render paths). */
  candlesSync(symbol: string, tf: Timeframe): Candle[] {
    if (tf === "1D") return this.dailyCache.get(symbol)?.candles ?? [];
    const base = this.candleCache.get(`${symbol}|1m`)?.candles ?? [];
    if (!base.length) return [];
    return tf === "1m" ? base : aggregateCandles(base, tfMinutes(tf));
  }

  /**
   * Genuine same-time-of-day RVOL: cumulative volume today vs the mean of
   * cumulative volume at the same minute-of-day across prior real sessions.
   * Returns null when the historical intraday series is not loaded.
   */
  async rvol(symbol: string): Promise<number | null> {
    const u = this.underlyings.get(symbol);
    if (!u) return null;
    const today = nowIstParts().date;
    let cache = this.priorSessionVolCache.get(symbol);
    if (!cache || cache.day !== today) {
      try {
        const to = new Date(Date.now() + IST_OFFSET_MS - 86400_000).toISOString().slice(0, 10);
        const from = new Date(Date.now() + IST_OFFSET_MS - 12 * 86400_000).toISOString().slice(0, 10);
        const raw = await fetchHistoricalCandles(u.meta.spotKey, "minutes", 1, from, to);
        const bySession = new Map<string, { minuteOfDay: number; cum: number }[]>();
        const running = new Map<string, number>();
        for (const c of raw) {
          const ist = new Date(c.ts + IST_OFFSET_MS);
          const day = ist.toISOString().slice(0, 10);
          const mod = ist.getUTCHours() * 60 + ist.getUTCMinutes();
          const cum = (running.get(day) ?? 0) + c.v;
          running.set(day, cum);
          if (!bySession.has(day)) bySession.set(day, []);
          bySession.get(day)!.push({ minuteOfDay: mod, cum });
        }
        cache = { vols: [...bySession.values()].slice(-5), day: today };
        this.priorSessionVolCache.set(symbol, cache);
      } catch {
        return null;
      }
    }
    if (!cache.vols.length) return null;
    const nowMod = nowIstParts().minutes;
    const refs: number[] = [];
    for (const session of cache.vols) {
      let best: number | null = null;
      for (const p of session) {
        if (p.minuteOfDay <= nowMod) best = p.cum;
        else break;
      }
      if (best != null && best > 0) refs.push(best);
    }
    if (!refs.length) return null;
    const todayVol = u.quote?.volume ?? 0;
    if (!todayVol) return null;
    const avg = refs.reduce((s, v) => s + v, 0) / refs.length;
    return avg > 0 ? todayVol / avg : null;
  }

  /* ----------------------------------------------------------- freshness */
  /** Delegates to the single session-aware classifier (no duplicated rules). */
  freshnessOf(exchangeTs: number | null | undefined): Freshness {
    return classifyFreshness(exchangeTs ?? null);
  }

  /* --------------------------------------------------------- persistence */
  private async persistQuotes(): Promise<void> {
    try {
      const rows: (typeof quotesTable.$inferInsert)[] = [];
      const futRows: (typeof futTable.$inferInsert)[] = [];
      for (const [symbol, u] of this.underlyings) {
        if (!u.quote) continue;
        rows.push({
          instrumentKey: u.meta.spotKey,
          exchangeTs: u.quote.exchangeTs == null ? null : new Date(u.quote.exchangeTs),
          receiveTs: new Date(u.quote.receiveTs),
          provider: "UPSTOX",
          freshness: this.freshnessOf(u.quote.exchangeTs),
          ltp: u.quote.ltp,
          open: u.quote.open,
          high: u.quote.high,
          low: u.quote.low,
          prevClose: u.quote.prevClose,
          volume: Math.round(u.quote.volume),
          oi: Math.round(u.quote.oi),
          bid: u.quote.bid,
          ask: u.quote.ask,
          bidQty: Math.round(u.quote.bidQty),
          askQty: Math.round(u.quote.askQty),
        });
        const f = this.futures.get(symbol);
        if (f?.quote) {
          futRows.push({
            instrumentKey: f.instrumentKey,
            underlying: symbol,
            expiry: f.expiry,
            exchangeTs: f.quote.exchangeTs == null ? null : new Date(f.quote.exchangeTs),
            observedAt: new Date(f.quote.receiveTs),
            ltp: f.quote.ltp,
            volume: Math.round(f.quote.volume),
            oi: Math.round(f.quote.oi),
            basis: Number.isFinite(u.quote.ltp) ? f.quote.ltp - u.quote.ltp : null,
          });
        }
      }
      const CH = 400;
      for (let i = 0; i < rows.length; i += CH) await db.insert(quotesTable).values(rows.slice(i, i + CH));
      for (let i = 0; i < futRows.length; i += CH)
        await db.insert(futTable).values(futRows.slice(i, i + CH)).onConflictDoNothing({ target: [futTable.instrumentKey, futTable.observedAt] });
      this.dbReady = true;
    } catch {
      this.dbReady = false;
    }
  }

  private async persistCandles(instrumentKey: string, candles: Candle[]): Promise<void> {
    if (!candles.length) return;
    try {
      await db
        .insert(candlesTable)
        .values(candles.map((c) => ({ instrumentKey, tf: "1m", ts: new Date(c.ts), open: c.o, high: c.h, low: c.l, close: c.c, volume: Math.round(c.v) })))
        .onConflictDoNothing({ target: [candlesTable.instrumentKey, candlesTable.tf, candlesTable.ts] });
    } catch {
      /* optional tier */
    }
  }

  private async persistChainObservations(symbol: string, state: ChainState): Promise<void> {
    try {
      const session = nowIstParts().date;
      const atm = this.atmOf(symbol, state);
      if (atm == null) return;
      const step = this.strikeStep(symbol, state);
      const oiRows: (typeof oiTable.$inferInsert)[] = [];
      const premRows: (typeof premTable.$inferInsert)[] = [];
      const baseRows: (typeof baselinesTable.$inferInsert)[] = [];
      const spot = this.underlyings.get(symbol)?.quote?.ltp ?? state.spot;
      for (let k = -ATM_WINDOW; k <= ATM_WINDOW; k++) {
        const slot = state.strikes.get(atm + k * step);
        if (!slot) continue;
        for (const live of [slot.ce, slot.pe]) {
          if (!live) continue;
          const last = live.obs[live.obs.length - 1];
          if (!last) continue;
          oiRows.push({
            instrumentKey: live.instrumentKey,
            underlying: symbol,
            expiry: live.expiry,
            strike: live.strike,
            optionType: live.type,
            exchangeTs: null, // option chain REST does not carry a per-leg exchange stamp
            observedAt: new Date(last.ts),
            receiveTs: new Date(),
            provider: "UPSTOX",
            oi: Math.round(last.oi),
            ltp: live.leg.ltp,
            volume: Math.round(live.leg.volume),
          });
          premRows.push({
            instrumentKey: live.instrumentKey,
            exchangeTs: null,
            observedAt: new Date(last.ts),
            ltp: live.leg.ltp,
            volume: Math.round(live.leg.volume),
            oi: Math.round(last.oi),
            iv: live.leg.iv,
            delta: live.leg.delta,
            underlyingLtp: Number.isFinite(spot) ? spot : null,
          });
          if (live.sessionBaselineOi != null && !this.restoredBaselines.has(live.instrumentKey)) {
            this.restoredBaselines.set(live.instrumentKey, { baseline: live.sessionBaselineOi, prev: live.prevSessionOi });
            baseRows.push({
              instrumentKey: live.instrumentKey,
              sessionDate: session,
              baselineOi: Math.round(live.sessionBaselineOi),
              prevSessionOi: live.prevSessionOi == null ? null : Math.round(live.prevSessionOi),
              capturedAt: new Date(last.ts),
              capturedMinute: nowIstParts().minutes,
              quality: live.baselineQuality,
            });
          }
        }
      }
      if (oiRows.length)
        await db.insert(oiTable).values(oiRows).onConflictDoNothing({ target: [oiTable.instrumentKey, oiTable.observedAt] });
      if (premRows.length)
        await db.insert(premTable).values(premRows).onConflictDoNothing({ target: [premTable.instrumentKey, premTable.observedAt] });
      if (baseRows.length)
        await db.insert(baselinesTable).values(baseRows).onConflictDoNothing({ target: [baselinesTable.instrumentKey, baselinesTable.sessionDate] });
      this.dbReady = true;
    } catch {
      this.dbReady = false;
    }
  }

  /* ------------------------------------------------------------- helpers */
  strikeStep(symbol: string, state?: ChainState): number {
    const meta = this.underlyings.get(symbol)?.meta;
    if (meta?.strikeInterval) return meta.strikeInterval;
    const strikes = [...(state?.strikes.keys() ?? [])].sort((a, b) => a - b);
    for (let i = 1; i < strikes.length; i++) {
      const g = strikes[i] - strikes[i - 1];
      if (g > 0) return g;
    }
    return 50;
  }

  atmOf(symbol: string, state?: ChainState): number | null {
    const spot = this.underlyings.get(symbol)?.quote?.ltp ?? state?.spot;
    if (!Number.isFinite(spot as number)) return null;
    const strikes = [...(state?.strikes.keys() ?? [])];
    if (!strikes.length) return null;
    let best = strikes[0];
    for (const s of strikes) if (Math.abs(s - (spot as number)) < Math.abs(best - (spot as number))) best = s;
    return best;
  }

  expiriesOf(symbol: string): string[] {
    return this.underlyings.get(symbol)?.meta.expiries ?? [];
  }

  /* ------------------------------------------------------------ payloads */
  quotesPayload() {
    const out: Record<string, { ltp: number; chgPct: number; volume: number; freshness: Freshness; high: number; low: number; open: number; prevClose: number; vwap: number | null }> = {};
    for (const [symbol, u] of this.underlyings) {
      if (!u.quote) continue;
      const q = u.quote;
      out[symbol] = {
        ltp: round2(q.ltp),
        chgPct: Number.isFinite(q.prevClose) && q.prevClose ? round2(pctChange(q.ltp, q.prevClose)) : 0,
        volume: q.volume,
        freshness: this.freshnessOf(q.exchangeTs),
        high: round2(q.high),
        low: round2(q.low),
        open: round2(q.open),
        prevClose: round2(q.prevClose),
        vwap: Number.isFinite(q.avgPrice) ? round2(q.avgPrice) : null,
      };
    }
    return { ts: Date.now(), provider: "UPSTOX", transport: this.transport, marketPhase: marketPhase(), quotes: out, universe: this.underlyings.size };
  }

  search(q: string) {
    const needle = q.trim().toUpperCase();
    const rows: { symbol: string; name: string; segment: string; ltp: number | null; chgPct: number | null; expiries: string[] }[] = [];
    for (const [symbol, u] of this.underlyings) {
      if (needle && !symbol.includes(needle) && !u.meta.name.toUpperCase().includes(needle)) continue;
      rows.push({
        symbol,
        name: u.meta.name,
        segment: u.meta.segment,
        ltp: u.quote ? round2(u.quote.ltp) : null,
        chgPct: u.quote && u.quote.prevClose ? round2(pctChange(u.quote.ltp, u.quote.prevClose)) : null,
        expiries: u.meta.expiries.slice(0, 4),
      });
      if (rows.length >= 25) break;
    }
    rows.sort((a, b) => (a.segment === b.segment ? a.symbol.localeCompare(b.symbol) : a.segment === "INDEX" ? -1 : 1));
    return rows;
  }

  optionChainPayload(symbol: string, expiry: string, window = 8) {
    const gate = this.gate();
    if (gate) return gate;
    const u = this.underlyings.get(symbol);
    if (!u) return unavailable(`${symbol} is not in the Upstox F&O instrument master.`, "UNKNOWN_SYMBOL");
    const state = this.chains.get(`${symbol}|${expiry}`);
    if (!state || state.strikes.size === 0)
      return unavailable(state?.error ? `Upstox option chain error: ${state.error}` : "Option chain not yet fetched for this contract.", "CHAIN");
    const atm = this.atmOf(symbol, state);
    const step = this.strikeStep(symbol, state);
    const rows = [...state.strikes.entries()]
      .filter(([strike]) => atm == null || Math.abs(strike - atm) <= window * step)
      .sort((a, b) => a[0] - b[0])
      .map(([strike, slot]) => ({
        strike,
        isAtm: strike === atm,
        ce: legPayload(slot.ce),
        pe: legPayload(slot.pe),
      }));
    let totCe = 0;
    let totPe = 0;
    let maxCe = { strike: 0, oi: -1 };
    let maxPe = { strike: 0, oi: -1 };
    for (const [strike, slot] of state.strikes) {
      const c = slot.ce?.leg.oi ?? 0;
      const p = slot.pe?.leg.oi ?? 0;
      totCe += c;
      totPe += p;
      if (c > maxCe.oi) maxCe = { strike, oi: c };
      if (p > maxPe.oi) maxPe = { strike, oi: p };
    }
    return {
      available: true as const,
      symbol,
      expiry,
      expiries: u.meta.expiries,
      spot: round2(u.quote?.ltp ?? state.spot),
      atm,
      rows,
      pcr: totCe > 0 ? round2(totPe / totCe) : null,
      maxCeOiStrike: maxCe.strike,
      maxPeOiStrike: maxPe.strike,
      totCeOi: totCe,
      totPeOi: totPe,
      freshness: this.freshnessOf(u.quote?.exchangeTs),
      provider: "UPSTOX",
      fetchedAt: state.fetchedAt,
      greeksSource: "UPSTOX_PROVIDED",
    };
  }

  oiMomentumPayload(symbol: string, expiry: string, window = ATM_WINDOW) {
    const gate = this.gate();
    if (gate) return gate;
    const u = this.underlyings.get(symbol);
    const state = this.chains.get(`${symbol}|${expiry}`);
    if (!u) return unavailable(`${symbol} is not in the instrument master.`, "UNKNOWN_SYMBOL");
    if (!state || state.strikes.size === 0)
      return unavailable(state?.error ? `Upstox option chain error: ${state.error}` : "Option chain not yet fetched for this contract.", "CHAIN");
    const atm = this.atmOf(symbol, state);
    if (atm == null) return unavailable("Spot price unavailable — cannot resolve ATM.", "NO_SPOT");
    const step = this.strikeStep(symbol, state);
    const now = Date.now();
    const rows = [];
    for (let k = -window; k <= window; k++) {
      const strike = atm + k * step;
      const slot = state.strikes.get(strike);
      const side = (live?: OptionLive) => {
        if (!live) return null;
        // A LATE_START baseline is not the 09:15 reference — session cumulative
        // and combined OI are reported as unavailable rather than wrong.
        const baselineUsable = live.baselineQuality === "OPEN_CAPTURE" || live.baselineQuality === "RESTORED";
        const m = computeOiMomentum(live.obs, baselineUsable ? live.sessionBaselineOi : null, live.prevSessionOi, now);
        return {
          current: live.leg.oi,
          chg5m: m.oiChange5m,
          chg15m: m.oiChange15m,
          sess: m.sessionChange,
          combined: m.combinedTotalOi,
          ltp: round2(live.leg.ltp),
          obsCount: live.obs.length,
          baselineQuality: live.baselineQuality,
        };
      };
      rows.push({
        strike,
        isAtm: strike === atm,
        ce: side(slot?.ce),
        pe: side(slot?.pe),
        freshness: this.freshnessOf(u.quote?.exchangeTs),
      });
    }
    const atmRow = rows[window];
    const spotChg = u.quote && u.quote.prevClose ? pctChange(u.quote.ltp, u.quote.prevClose) : null;
    return {
      available: true as const,
      symbol,
      expiry,
      expiries: u.meta.expiries,
      spot: round2(u.quote?.ltp ?? state.spot),
      atm,
      rows,
      interpretation: classifyOiShift({
        ceSess: atmRow?.ce?.sess ?? null,
        peSess: atmRow?.pe?.sess ?? null,
        cePremChgPct: null,
        pePremChgPct: null,
        underlyingChgPct: spotChg,
      }),
      sampling: {
        mode: "time-based rolling windows over provider OI observations",
        toleranceSec: 90,
        note: "History accumulates from live Upstox option-chain polls. Rolling windows return N/A until enough real observations exist. Pre-session reference = provider prev_oi.",
      },
      historyMinutes: historySpanMinutes(state),
      baselineQuality: baselineQualityOf(state),
      baselineNote:
        baselineQualityOf(state) === "LATE_START"
          ? "Session baseline was captured after the open (app started mid-session): session-cumulative and combined OI are reported as N/A rather than measured from a false reference."
          : null,
      provider: "UPSTOX",
    };
  }

  premiumMomentumPayload(symbol: string, expiry: string) {
    const gate = this.gate();
    if (gate) return gate;
    const state = this.chains.get(`${symbol}|${expiry}`);
    const u = this.underlyings.get(symbol);
    if (!state || !u || state.strikes.size === 0) return unavailable("Option chain not yet fetched for this contract.", "CHAIN");
    const atm = this.atmOf(symbol, state);
    if (atm == null) return unavailable("Spot price unavailable.", "NO_SPOT");
    const step = this.strikeStep(symbol, state);
    const now = Date.now();
    const contracts = [];
    for (let k = -ATM_WINDOW; k <= ATM_WINDOW; k++) {
      const slot = state.strikes.get(atm + k * step);
      for (const live of [slot?.ce, slot?.pe]) {
        if (!live) continue;
        const p5 = premChange(live, now, 5);
        const p15 = premChange(live, now, 15);
        const sess = Number.isFinite(live.leg.closePrice) && live.leg.closePrice ? pctChange(live.leg.ltp, live.leg.closePrice) : null;
        let state2 = "FLAT";
        if (p5 != null) {
          if (p5 > 2.5) state2 = "STRENGTHENING";
          else if (p5 < -2.5) state2 = "WEAKENING";
          if (p15 != null) {
            if (p5 > 2 && p5 > p15 * 1.4) state2 = "ACCELERATING";
            else if (p5 > 0 && p15 > 0 && p5 < p15 * 0.5) state2 = "DECELERATING";
          }
        } else state2 = "INSUFFICIENT_HISTORY";
        contracts.push({
          key: live.instrumentKey,
          strike: live.strike,
          side: live.type,
          ltp: round2(live.leg.ltp),
          premChgPct5m: p5 == null ? null : round2(p5),
          premChgPct15m: p15 == null ? null : round2(p15),
          premChgPctSess: sess == null ? null : round2(sess),
          volume: live.leg.volume,
          oiSessChg: live.sessionBaselineOi == null ? null : live.leg.oi - live.sessionBaselineOi,
          iv: live.leg.iv,
          delta: live.leg.delta,
          state: state2,
        });
      }
    }
    return {
      available: true as const,
      symbol,
      expiry,
      spot: round2(u.quote?.ltp ?? state.spot),
      atm,
      contracts,
      bestCe: this.bestStrike(symbol, state, "CE"),
      bestPe: this.bestStrike(symbol, state, "PE"),
      note: "Premium strength alone is not proof of option buying — assessed with the underlying move, provider OI, volume, spread and greeks.",
    };
  }

  private bestStrike(symbol: string, state: ChainState, side: "CE" | "PE") {
    const u = this.underlyings.get(symbol);
    const atm = this.atmOf(symbol, state);
    if (atm == null || !u?.quote) return null;
    const step = this.strikeStep(symbol, state);
    const now = Date.now();
    const undMove = u.quote.prevClose ? pctChange(u.quote.ltp, u.quote.prevClose) : 0;
    let best: BestStrike | null = null;
    for (let k = -ATM_WINDOW; k <= ATM_WINDOW; k++) {
      const slot = state.strikes.get(atm + k * step);
      const live = side === "CE" ? slot?.ce : slot?.pe;
      if (!live || !Number.isFinite(live.leg.ltp) || live.leg.ltp <= 0) continue;
      const prem = premChange(live, now, 5) ?? (live.leg.closePrice ? pctChange(live.leg.ltp, live.leg.closePrice) : 0);
      const spreadPct = Number.isFinite(live.leg.bid) && Number.isFinite(live.leg.ask) ? ((live.leg.ask - live.leg.bid) / live.leg.ltp) * 100 : NaN;
      const conf: string[] = [];
      let score = clamp(prem, -8, 8) * 6;
      if (prem > 1.5) conf.push("premium momentum positive");
      if (live.leg.volume > 0) score += clamp(live.leg.volume / 200_000, 0, 3) * 8;
      if (live.leg.delta != null) score += Math.abs(live.leg.delta) * 18;
      if (Number.isFinite(spreadPct)) {
        score -= spreadPct * 4;
        if (spreadPct < 1.2) conf.push("spread acceptable");
      }
      const oiSess = live.sessionBaselineOi == null ? null : live.leg.oi - live.sessionBaselineOi;
      if (oiSess != null) score += clamp(-(oiSess / 50_000), -2, 2) * 4;
      const undConf = side === "CE" ? undMove > 0 : undMove < 0;
      if (undConf) {
        score += 6;
        conf.push("underlying confirming");
      }
      if (!best || score > best.score)
        best = {
          strike: live.strike,
          score: round1(score),
          ltp: round2(live.leg.ltp),
          spreadPct: Number.isFinite(spreadPct) ? round2(spreadPct) : NaN,
          volume: live.leg.volume,
          premChgPct: round2(prem),
          oiSessChg: oiSess,
          expiry: live.expiry,
          key: live.instrumentKey,       // REAL Upstox instrument key
          delta: live.leg.delta,          // provider delta, null when absent
          oi: live.leg.oi,
          reason: `${side === "CE" ? "Bullish" : "Bearish"} candidate: best composite of provider premium momentum, delta, liquidity and underlying confirmation across ATM±${ATM_WINDOW} (never chosen on raw OI or LTP change alone).`,
          confirmations: conf,
        };
    }
    return best;
  }

  futuresPayload(symbol: string) {
    const gate = this.gate();
    if (gate) return gate;
    const u = this.underlyings.get(symbol);
    const f = this.futures.get(symbol);
    if (!u) return unavailable(`${symbol} is not in the instrument master.`, "UNKNOWN_SYMBOL");
    if (!f) return unavailable(`No listed futures contract for ${symbol} in the Upstox master.`, "NO_FUTURES");
    if (!f.quote) return unavailable("Futures quote not yet received from Upstox.", "NO_QUOTE");
    const now = Date.now();
    const chgPct = f.quote.prevClose ? pctChange(f.quote.ltp, f.quote.prevClose) : null;
    const baselineUsable = f.baselineQuality === "OPEN_CAPTURE" || f.baselineQuality === "RESTORED";
    const oiChgPct = baselineUsable && f.sessionBaselineOi ? pctChange(f.quote.oi, f.sessionBaselineOi) : null;
    const spot = u.quote?.ltp;
    const basis = Number.isFinite(spot as number) ? f.quote.ltp - (spot as number) : null;
    return {
      available: true as const,
      symbol,
      expiry: f.expiry,
      fut: {
        ltp: round2(f.quote.ltp),
        chgPct: chgPct == null ? null : round2(chgPct),
        volume: f.quote.volume,
        oi: f.quote.oi,
        oiChg2m: rollingOiChange(f.obs, now, 2).change,
        oiChg5m: rollingOiChange(f.obs, now, 5).change,
        oiChg15m: rollingOiChange(f.obs, now, 15).change,
        oiSessChg:
          f.sessionBaselineOi == null || f.baselineQuality === "LATE_START" || f.baselineQuality === "UNAVAILABLE"
            ? null
            : f.quote.oi - f.sessionBaselineOi,
        baselineQuality: f.baselineQuality,
        vwap: Number.isFinite(f.quote.avgPrice) ? round2(f.quote.avgPrice) : null,
        classification: classifyFutures(chgPct, oiChgPct),
      },
      spot: {
        ltp: spot == null ? null : round2(spot),
        chgPct: u.quote?.prevClose ? round2(pctChange(u.quote.ltp, u.quote.prevClose)) : null,
      },
      basis: basis == null ? null : round2(basis),
      basisChg: null,
      confirmation:
        chgPct == null || oiChgPct == null
          ? "Futures price/OI reference incomplete — never treated as confirmation."
          : u.quote?.prevClose && Math.sign(chgPct) === Math.sign(pctChange(u.quote.ltp, u.quote.prevClose))
            ? "Spot and futures aligned."
            : "Spot/futures divergence.",
      freshness: this.freshnessOf(f.quote.exchangeTs),
      obsCount: f.obs.length,
    };
  }

  futuresAllPayload() {
    const gate = this.gate();
    if (gate) return gate;
    const rows = [];
    for (const symbol of this.futures.keys()) {
      const p = this.futuresPayload(symbol);
      if ("available" in p && p.available) rows.push(p);
    }
    rows.sort((a, b) => Math.abs(b.fut.chgPct ?? 0) - Math.abs(a.fut.chgPct ?? 0));
    return { available: true as const, rows };
  }

  /* --------------------------------------------------------- SR / struct */
  srBundle(symbol: string, tf: Timeframe = "5m") {
    const u = this.underlyings.get(symbol);
    if (!u?.quote) return null;
    const cacheKey = `${symbol}|${tf}`;
    const hit = this.srCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 6_000) return hit;
    const candles = this.candlesSync(symbol, tf);
    if (candles.length < 20) return null;
    const structure = analyzeStructure(candles);
    // VWAP / opening range / volume profile are SESSION metrics — they must
    // never span the multi-day chart window.
    const intraday = this.sessionCandles(symbol);

    // INSTRUMENT-AWARE VOLUME SOURCE.
    //  - EQUITY: the stock's own traded-volume candles.
    //  - INDEX : futures candles mapped onto the spot price scale. Spot price
    //            action is NEVER replaced — only the volume source changes.
    let profile: VolumeProfileResult | null;
    if (this.isIndex(symbol)) {
      const mp = this.mappedProfileSync(symbol, tf) ?? this.mappedProfileSync(symbol, "1m");
      profile = mp?.profile ?? null;
      if (!profile) void this.buildMappedProfile(symbol, tf).catch(() => undefined);
    } else {
      profile = volumeProfile(intraday.length >= 10 ? intraday : candles, 40, {
        source: "SPOT_TRADED",
        sourceSymbol: symbol,
        sessionDate: intraday.length ? istDate(intraday[intraday.length - 1].ts) : null,
      });
    }
    const vwap = intraday.length ? vwapBands(intraday) : null;
    const daily = this.dailyCache.get(symbol)?.candles ?? [];
    const prevDay = daily.length >= 2 ? { high: daily[daily.length - 2].h, low: daily[daily.length - 2].l, close: daily[daily.length - 2].c } : null;
    const or = intraday.slice(0, 15);
    const openingRange = or.length >= 5 ? { high: Math.max(...or.map((c) => c.h)), low: Math.min(...or.map((c) => c.l)) } : null;
    const zones = buildSRZones({
      symbol,
      price: u.quote.ltp,
      tickSize: u.meta.tickSize || 0.05,
      candles,
      prevDay,
      openingRange,
      vwap,
      profile,
      structure,
      oiZones: this.oiZoneSummary(symbol),
      atrValue: atr(candles, 14),
      now: Date.now(),
    });
    const out = { tf, zones, selection: selectPrimaryLevels(zones, u.quote.ltp), structure, profile, at: Date.now() };
    this.srCache.set(cacheKey, out);
    return out;
  }

  private oiZoneSummary(symbol: string) {
    const expiry = this.expiriesOf(symbol)[0];
    const state = expiry ? this.chains.get(`${symbol}|${expiry}`) : null;
    if (!state) return [];
    return [...state.strikes.entries()]
      .map(([strike, slot]) => ({
        strike,
        ceOi: slot.ce?.leg.oi ?? 0,
        peOi: slot.pe?.leg.oi ?? 0,
        ceSessChg: slot.ce?.sessionBaselineOi == null ? null : slot.ce.leg.oi - slot.ce.sessionBaselineOi,
        peSessChg: slot.pe?.sessionBaselineOi == null ? null : slot.pe.leg.oi - slot.pe.sessionBaselineOi,
      }))
      .sort((a, b) => a.strike - b.strike);
  }

  private levelCache = new Map<string, { out: SRLevelsResult; at: number }>();

  /**
   * UNIFIED S/R LEVELS — the single output consumed by chart overlays, the
   * intelligence panel, the workspace and the engines. Nothing recomputes
   * levels elsewhere, so chart and panel can never disagree.
   */
  srLevels(symbol: string, tf: Timeframe = "5m"): SRLevelsResult | null {
    const u = this.underlyings.get(symbol);
    if (!u?.quote) return null;
    const key = `${symbol}|${tf}`;
    const hit = this.levelCache.get(key);
    if (hit && Date.now() - hit.at < 5_000) return hit.out;
    const bundle = this.srBundle(symbol, tf);
    if (!bundle) return null;
    const candles = this.candlesSync(symbol, tf);
    if (candles.length < 20) return null;

    // option-chain strikes mapped to this underlying's own expiry
    const expiry = this.expiriesOf(symbol)[0];
    const chain = expiry ? this.chains.get(`${symbol}|${expiry}`) : undefined;
    const now = Date.now();
    const strikes: StrikeOi[] = [];
    if (chain) {
      for (const [strike, slot] of chain.strikes) {
        const ce = slot.ce;
        const pe = slot.pe;
        const usable = (l?: typeof ce) => l && (l.baselineQuality === "OPEN_CAPTURE" || l.baselineQuality === "RESTORED");
        strikes.push({
          strike,
          ceOi: ce?.leg.oi ?? 0,
          peOi: pe?.leg.oi ?? 0,
          ce5m: ce ? rollingOiChange(ce.obs, now, 5).change : null,
          pe5m: pe ? rollingOiChange(pe.obs, now, 5).change : null,
          ce15m: ce ? rollingOiChange(ce.obs, now, 15).change : null,
          pe15m: pe ? rollingOiChange(pe.obs, now, 15).change : null,
          ceSess: usable(ce) && ce!.sessionBaselineOi != null ? ce!.leg.oi - ce!.sessionBaselineOi! : null,
          peSess: usable(pe) && pe!.sessionBaselineOi != null ? pe!.leg.oi - pe!.sessionBaselineOi! : null,
          // REAL observation-window premium changes (never LTP vs prev close)
          cePrem5m: ce ? premChange(ce, now, 5) : null,
          pePrem5m: pe ? premChange(pe, now, 5) : null,
          cePrem15m: ce ? premChange(ce, now, 15) : null,
          pePrem15m: pe ? premChange(pe, now, 15) : null,
        });
      }
    }

    // resolve the volume evidence source for this instrument
    const volSrc = this.volumeSourceFor(symbol, tf);

    // PRIORITY 5 — futures price bias and OI positioning are INDEPENDENT.
    const f = this.futures.get(symbol);
    const futChg = f?.quote?.prevClose ? pctChange(f.quote.ltp, f.quote.prevClose) : null;
    const baselineUsable = f ? f.baselineQuality === "OPEN_CAPTURE" || f.baselineQuality === "RESTORED" : false;
    const futOiPct = f?.quote && baselineUsable && f.sessionBaselineOi ? pctChange(f.quote.oi, f.sessionBaselineOi) : null;
    const futures: FuturesPositioning = f?.quote
      ? {
          priceChgPct: futChg,
          oiChgPct: futOiPct,
          oi5m: rollingOiChange(f.obs, now, 5).change,
          oi15m: rollingOiChange(f.obs, now, 15).change,
          // missing OI can never manufacture a buildup classification
          classification: futChg == null || futOiPct == null ? "UNAVAILABLE" : classifyFutures(futChg, futOiPct),
        }
      : { priceChgPct: null, oiChgPct: null, oi5m: null, oi15m: null, classification: "UNAVAILABLE" };

    // underlying move over the SAME windows used for OI/premium reads
    const c1m = this.candlesSync(symbol, "1m");
    const moveOver = (mins: number): number | null => {
      if (c1m.length < mins + 1) return null;
      const ref = c1m[c1m.length - 1 - mins];
      return ref ? pctChange(u.quote!.ltp, ref.c) : null;
    };
    const underlyingMove = { pct5m: moveOver(5), pct15m: moveOver(15) };

    const out = buildSRLevels({
      symbol,
      tf,
      price: u.quote.ltp,
      atr: atr(candles, 14) ?? u.quote.ltp * 0.004,
      candles,
      zones: bundle.zones,
      volumeCandles: volSrc.candles,
      volumeSource: volSrc.label,
      strikes,
      strikeStep: this.strikeStep(symbol, chain),
      profile: bundle.profile ? { poc: bundle.profile.poc, vah: bundle.profile.vah, val: bundle.profile.val, hvn: bundle.profile.hvn, lvn: bundle.profile.lvn } : null,
      rvol: this.rvolCache.get(symbol) ?? null,
      futuresBias: futChg == null ? null : clamp(futChg * 40, -1, 1),
      futures,
      underlyingMove,
      chainAgeSec: chain?.fetchedAt ? Math.round((Date.now() - chain.fetchedAt) / 1000) : null,
      now,
    });
    this.levelCache.set(key, { out, at: Date.now() });
    if (this.levelCache.size > 400) {
      pruneRegistry();
      this.levelCache.clear();
    }
    return out;
  }

  /**
   * Which candles carry the VOLUME evidence for this instrument, and a short
   * honest label describing the source.
   */
  volumeSourceFor(symbol: string, tf: Timeframe): { candles: Candle[]; label: string | null } {
    if (!this.isIndex(symbol)) {
      const own = this.sessionCandles(symbol);
      return { candles: own.length ? own : this.candlesSync(symbol, tf), label: null };
    }
    const mp = this.mappedProfileSync(symbol, tf) ?? this.mappedProfileSync(symbol, "1m");
    // PRIORITY 4 — only CURRENT-SESSION mapped candles may carry volume
    // evidence; historical sessions are structural confluence only.
    if (mp?.sessionCandles?.length && mp.source) {
      return {
        candles: mp.sessionCandles,
        label: `futures-derived · spot-mapped (${mp.source.expiry}, basis ${mp.source.basis >= 0 ? "+" : ""}${mp.source.basis})`,
      };
    }
    void this.buildMappedProfile(symbol, tf).catch(() => undefined);
    return { candles: [], label: mp?.reason ?? "futures volume proxy not yet loaded" };
  }

  /**
   * PRIORITY 7 — the ONE selection every module must use.
   * Converts the unified engine's LevelResults into the zone shape the
   * trading/alert engines expect, so Watchlist, Scanner, Trade Finder,
   * Alerts, Chart and the S/R panel can never disagree.
   */
  unifiedSelection(symbol: string, tf: Timeframe = "5m"): SRSelection | null {
    const lv = this.srLevels(symbol, tf);
    if (!lv) return null;
    const toZone = (l: typeof lv.immediateResistance): SRZone | null => {
      if (!l) return null;
      return {
        id: l.id,
        side: l.side,
        priceLow: l.zoneLow,
        priceHigh: l.zoneHigh,
        mid: l.price,
        kind: l.oiOnly ? "OI_ONLY" : "PRICE_ACTION",
        sources: l.sources,
        oiOnly: l.oiOnly,
        status: l.lifecycle === "BROKEN" ? "BROKEN" : l.lifecycle === "INVALIDATED" ? "INVALIDATED" : "TESTED",
        touches: l.successfulTests,
        strength: l.smoothedScore ?? 0,
        evidence: { bullish: l.positive, bearish: l.negative, conflicting: [], missing: l.missing, coverage: l.coverage },
        firstSeen: l.lifecycleSince,
        lastTested: null,
      };
    };
    return {
      immediateSupport: toZone(lv.immediateSupport),
      primarySupport: toZone(lv.primarySupport),
      secondarySupport: null,
      majorSupport: null,
      immediateResistance: toZone(lv.immediateResistance),
      primaryResistance: toZone(lv.primaryResistance),
      secondaryResistance: null,
      majorResistance: null,
    };
  }

  /** Four-level payload for the chart overlays + intelligence panel. */
  srLevelsPayload(symbol: string, tf: Timeframe = "5m") {
    const gate = this.gate();
    if (gate) return gate;
    const u = this.underlyings.get(symbol);
    if (!u) return unavailable(`${symbol} is not in the Upstox F&O instrument master.`, "UNKNOWN_SYMBOL");
    if (!u.quote) return unavailable("Waiting for the first Upstox quote for this instrument.", "NO_QUOTE");
    const levels = this.srLevels(symbol, tf);
    if (!levels) return unavailable(`Not enough ${tf} candles from Upstox yet to derive S/R levels.`, "NO_CANDLES");
    const cov = this.coverage.get(symbol) ?? this.updateCoverage(symbol);
    const expiry = this.expiriesOf(symbol)[0];
    const chain = expiry ? this.chains.get(`${symbol}|${expiry}`) : undefined;
    return {
      available: true as const,
      symbol,
      tf,
      spot: round2(u.quote.ltp),
      expiry: expiry ?? null,
      immediateResistance: levels.immediateResistance,
      primaryResistance: levels.primaryResistance,
      immediateSupport: levels.immediateSupport,
      primarySupport: levels.primarySupport,
      levels: levels.all,
      evaluatedZones: levels.evaluatedZones,
      volumeProfile: (() => {
        const pr = this.srBundle(symbol, tf)?.profile;
        if (!pr) return null;
        return {
          source: pr.source,
          sourceLabel: pr.source === "FUTURES_DERIVED_SPOT_MAPPED" ? "FUTURES-DERIVED · SPOT-MAPPED" : "SPOT TRADED VOLUME",
          sourceExpiry: pr.sourceExpiry,
          sourceInstrumentKey: pr.sourceInstrumentKey,
          basis: pr.basis,
          sessionDate: pr.sessionDate,
          totalVolume: pr.totalVolume,
          poc: round2(pr.poc),
          vah: round2(pr.vah),
          val: round2(pr.val),
          hvn: pr.hvn.slice(0, 4).map(round2),
          lvn: pr.lvn.slice(0, 4).map(round2),
        };
      })(),
      dataCoverage: {
        level: cov.level,
        missing: cov.missing,
        optionChain: !!chain && chain.strikes.size > 0,
        volumeProfile: !!this.srBundle(symbol, tf)?.profile,
        rvol: this.rvolCache.has(symbol),
        futures: !!this.futures.get(symbol)?.quote,
      },
      freshness: this.freshnessOf(u.quote.exchangeTs),
      trackedLevels: registrySize(),
      updatedAt: Date.now(),
      note: "Strength is a normalised 0–100 estimate from available evidence — not a calibrated probability of reversal. Classification and lifecycle are independent values.",
    };
  }

  srPayload(symbol: string, tf: Timeframe = "5m") {
    const gate = this.gate();
    if (gate) return gate;
    const u = this.underlyings.get(symbol);
    if (!u?.quote) return unavailable("No live quote for this instrument yet.", "NO_QUOTE");
    const b = this.srBundle(symbol, tf);
    if (!b) return unavailable(`Not enough ${tf} candles from Upstox yet to derive S/R zones.`, "NO_CANDLES");
    return {
      available: true as const,
      symbol,
      tf,
      spot: round2(u.quote.ltp),
      zones: [...b.zones].sort((a, b2) => a.mid - b2.mid).map((z) => ({ ...z, mid: round2(z.mid), priceLow: round2(z.priceLow), priceHigh: round2(z.priceHigh) })),
      // PRIORITY 7: publish the UNIFIED selection so every consumer matches
      selection: this.unifiedSelection(symbol, tf) ?? b.selection,
      updatedAt: new Date(b.at).toISOString(),
      note: "Derived from real Upstox candles, provider OI and volume. Strength is a confluence score — not a probability. OI-only zones are never promoted without price-action evidence.",
    };
  }

  structurePayload(symbol: string, tf: Timeframe = "5m") {
    const gate = this.gate();
    if (gate) return gate;
    const b = this.srBundle(symbol, tf);
    const u = this.underlyings.get(symbol);
    if (!b || !u?.quote) return unavailable(`Not enough ${tf} candles from Upstox yet.`, "NO_CANDLES");
    const multi: Record<string, string> = {};
    for (const t of ["3m", "5m", "15m", "30m"] as Timeframe[]) {
      const bb = this.srBundle(symbol, t);
      if (bb) multi[t] = bb.structure.trend;
    }
    return {
      available: true as const,
      symbol,
      tf,
      spot: round2(u.quote.ltp),
      trend: b.structure.trend,
      swings: b.structure.swings.slice(-14).map((s) => ({ ts: s.ts, price: round2(s.price), kind: s.kind })),
      events: b.structure.events.slice(-16).map((e) => ({ ...e, price: round2(e.price) })),
      equalHighs: b.structure.equalHighs,
      equalLows: b.structure.equalLows,
      consolidating: b.structure.consolidating,
      rangeHigh: b.structure.rangeHigh == null ? null : round2(b.structure.rangeHigh),
      rangeLow: b.structure.rangeLow == null ? null : round2(b.structure.rangeLow),
      lastSwingHigh: b.structure.lastSwingHigh,
      lastSwingLow: b.structure.lastSwingLow,
      multiTimeframe: multi,
      countertrend: multi["15m"] && multi["15m"] !== b.structure.trend && b.structure.trend !== "RANGE" ? `${tf} momentum is countertrend to 15m structure` : null,
    };
  }

  volumeProfilePayload(symbol: string) {
    const gate = this.gate();
    if (gate) return gate;
    const b = this.srBundle(symbol, "5m");
    if (!b?.profile) {
      const mp = this.isIndex(symbol) ? this.mappedProfileSync(symbol, "5m") ?? this.mappedProfileSync(symbol, "1m") : null;
      return unavailable(
        this.isIndex(symbol)
          ? `Futures-derived profile unavailable: ${mp?.reason ?? "active futures candles not loaded yet"}.`
          : "Not enough intraday candles from Upstox to build a profile.",
        "NO_CANDLES",
      );
    }
    const futuresDerived = b.profile.source === "FUTURES_DERIVED_SPOT_MAPPED";
    return {
      available: true as const,
      symbol,
      ...b.profile,
      sourceLabel: futuresDerived ? "FUTURES-DERIVED · SPOT-MAPPED" : "SPOT TRADED VOLUME",
      priceScale: "SPOT",
      note: futuresDerived
        ? `Volume comes from the active futures contract (${b.profile.sourceExpiry}); prices are shifted onto the spot index scale with a timestamp-aligned basis of ${b.profile.basis}. OHLCV-derived volume-at-price is an approximation, not tick-level data.`
        : "Built from the instrument's own Upstox candle volume distributed across each bar's traded range — an approximation of true volume-at-price, labelled as such.",
    };
  }

  orderFlowPayload(symbol: string) {
    const gate = this.gate();
    if (gate) return gate;
    const u = this.underlyings.get(symbol);
    if (!u?.quote) return unavailable("No live quote for this instrument yet.", "NO_QUOTE");
    const f = this.futures.get(symbol);
    const depthSource = f?.quote?.depth.bid.length ? f.quote : u.quote;
    const bids = depthSource.depth.bid;
    const asks = depthSource.depth.ask;
    const bidTot = bids.reduce((s, b) => s + b.qty, 0);
    const askTot = asks.reduce((s, a) => s + a.qty, 0);
    const b = this.srBundle(symbol, "5m");
    const expiry = this.expiriesOf(symbol)[0];
    const state = expiry ? this.chains.get(`${symbol}|${expiry}`) : null;
    const atm = state ? this.atmOf(symbol, state) : null;
    const atmSlot = atm != null ? state!.strikes.get(atm) : undefined;
    return {
      available: true as const,
      symbol,
      spot: round2(u.quote.ltp),
      depthLevels: bids.length,
      authenticity: {
        depth: bids.length
          ? `Live Upstox market depth (${bids.length} level${bids.length === 1 ? "" : "s"}) — resting book state, NOT executed order flow.`
          : "Depth not provided for this instrument by Upstox at this subscription tier — UNAVAILABLE.",
        cvd: "UNAVAILABLE — the REST quote feed does not expose per-trade prints with aggressor-side flags, so a genuine CVD cannot be computed. Nothing is estimated here.",
        footprint: "UNAVAILABLE — per-price executed volume is not supplied at this tier.",
        liquidityHeatmap: "Structure-derived only (equal highs/lows from real candles) — not a true resting-liquidity heatmap.",
      },
      ladder: bids.map((bd, i) => ({ level: i + 1, bid: bd.price, bidQty: bd.qty, ask: asks[i]?.price ?? null, askQty: asks[i]?.qty ?? null })),
      imbalance: bidTot + askTot > 0 ? { bid: bidTot, ask: askTot, ratio: round2(bidTot / Math.max(askTot, 1)) } : null,
      cvd: null,
      liquidityMap: {
        buySide: b?.structure.equalHighs.slice(0, 4) ?? [],
        sellSide: b?.structure.equalLows.slice(0, 4) ?? [],
        sweepCandidates: [b?.structure.lastSwingHigh, b?.structure.lastSwingLow].filter((x): x is number => x != null).map(round2),
      },
      atmDepth: atmSlot
        ? {
            strike: atm,
            ceBidQty: atmSlot.ce?.leg.bidQty ?? null,
            ceAskQty: atmSlot.ce?.leg.askQty ?? null,
            peBidQty: atmSlot.pe?.leg.bidQty ?? null,
            peAskQty: atmSlot.pe?.leg.askQty ?? null,
          }
        : null,
      freshness: this.freshnessOf(depthSource.exchangeTs),
    };
  }

  /* ---------------------------------------------------------------- FMPI */
  fmpiFor(symbol: string, tf: Timeframe = "5m"): FMPIOutput | null {
    const u = this.underlyings.get(symbol);
    if (!u?.quote) return null;
    const key = `${symbol}|${tf}`;
    const hit = this.fmpiCache.get(key);
    if (hit && Date.now() - hit.at < 6_000) return hit.out;

    const candles = this.candlesSync(symbol, tf === "1D" ? "15m" : tf);
    let priceMomPct: number | null = null;
    let realizedVolPct: number | null = null;
    let emaAlignment: number | null = null;
    if (candles.length >= 25) {
      const closes = candles.map((c) => c.c);
      const n = Math.min(10, closes.length - 1);
      priceMomPct = pctChange(closes[closes.length - 1], closes[closes.length - 1 - n]);
      const rets: number[] = [];
      for (let i = Math.max(1, closes.length - 30); i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
      realizedVolPct = rets.length > 5 ? Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length) * Math.sqrt(375) * 100 : null;
      const e9 = emaLast(closes, 9);
      const e15 = emaLast(closes, 15);
      const e21 = emaLast(closes, 21);
      const e34 = emaLast(closes, 34);
      if (e9 != null && e15 != null && e21 != null && e34 != null) {
        const bull = (e9 > e15 ? 1 : 0) + (e15 > e21 ? 1 : 0) + (e21 > e34 ? 1 : 0);
        const bear = (e9 < e15 ? 1 : 0) + (e15 < e21 ? 1 : 0) + (e21 < e34 ? 1 : 0);
        emaAlignment = (bull - bear) / 3;
      }
    }

    const f = this.futures.get(symbol);
    const futChgPct = f?.quote?.prevClose ? pctChange(f.quote.ltp, f.quote.prevClose) : null;
    const futOiChgPct = f?.quote && f.sessionBaselineOi ? pctChange(f.quote.oi, f.sessionBaselineOi) : null;

    const expiry = this.expiriesOf(symbol)[0];
    const state = expiry ? this.chains.get(`${symbol}|${expiry}`) : null;
    const atm = state ? this.atmOf(symbol, state) : null;
    const slot = atm != null ? state!.strikes.get(atm) : undefined;
    const now = Date.now();
    const cePrem = slot?.ce ? premChange(slot.ce, now, tfMinutes(tf === "1D" ? "15m" : tf)) : null;
    const pePrem = slot?.pe ? premChange(slot.pe, now, tfMinutes(tf === "1D" ? "15m" : tf)) : null;

    const oiDir = (ce: number | null, pe: number | null): number | null => {
      if (ce == null || pe == null) return null;
      const scale = Math.max(20_000, Math.abs(ce) + Math.abs(pe));
      return clamp((clamp(pe / scale, -1, 1) - clamp(ce / scale, -1, 1)) / 2, -1, 1);
    };
    const w5 = slot ? oiDir(slot.ce ? rollingOiChange(slot.ce.obs, now, 5).change : null, slot.pe ? rollingOiChange(slot.pe.obs, now, 5).change : null) : null;
    const w15 = slot ? oiDir(slot.ce ? rollingOiChange(slot.ce.obs, now, 15).change : null, slot.pe ? rollingOiChange(slot.pe.obs, now, 15).change : null) : null;
    const sessDir = slot
      ? oiDir(
          slot.ce?.sessionBaselineOi == null ? null : slot.ce.leg.oi - slot.ce.sessionBaselineOi,
          slot.pe?.sessionBaselineOi == null ? null : slot.pe.leg.oi - slot.pe.sessionBaselineOi,
        )
      : null;

    const b = candles.length >= 20 ? this.srBundle(symbol, tf === "1D" ? "15m" : tf) : null;
    const higher = this.srBundle(symbol, "15m");
    const vwapVal = Number.isFinite(u.quote.avgPrice) ? u.quote.avgPrice : null;

    const out = computeFMPI(
      {
        priceMomPct,
        realizedVolPct,
        cePremChgPct: cePrem,
        pePremChgPct: pePrem,
        optionVolAccel: null,
        rvol: this.rvolCache.get(symbol) ?? null,
        oiChg5mDir: w5,
        oiChg15mDir: w15,
        oiSessDir: sessDir,
        futChgPct,
        futOiChgPct,
        basisChg: null,
        priceVsVwapPct: vwapVal ? pctChange(u.quote.ltp, vwapVal) : null,
        emaAlignment,
        structureDir: b?.structure.trend ?? null,
        higherTfAgree: higher && b ? higher.structure.trend === b.structure.trend : null,
        volatilityPct: realizedVolPct,
      },
      this.fmpiHistory.get(key) ?? [],
    );
    const hist = this.fmpiHistory.get(key) ?? [];
    if (!hist.length || Math.abs(hist[hist.length - 1] - out.value) > 0.01) {
      hist.push(out.value);
      if (hist.length > 80) hist.shift();
      this.fmpiHistory.set(key, hist);
    }
    this.fmpiCache.set(key, { out, at: Date.now() });
    return out;
  }
  rvolCache = new Map<string, number>();

  fmpiSeries(symbol: string, tf: Timeframe = "5m") {
    const gate = this.gate();
    if (gate) return gate;
    const current = this.fmpiFor(symbol, tf);
    if (!current) return unavailable("No live quote for this instrument yet.", "NO_QUOTE");
    const hist = this.fmpiHistory.get(`${symbol}|${tf}`) ?? [];
    const candles = this.candlesSync(symbol, tf === "1D" ? "15m" : tf);
    const points = hist.map((v, i) => ({ ts: candles.length ? candles[Math.max(0, candles.length - hist.length + i)]?.ts ?? Date.now() : Date.now(), value: v }));
    return {
      available: true as const,
      symbol,
      tf,
      points,
      current,
      note: points.length < 5 ? "FMPI history builds from live observations — the series fills in as the session progresses." : null,
    };
  }

  /* --------------------------------------------------------------- intel */
  intelFor(symbol: string): SymbolIntel | null {
    const u = this.underlyings.get(symbol);
    if (!u?.quote) return null;
    const q = u.quote;
    const candles = this.candlesSync(symbol, "5m");
    const closes = candles.map((c) => c.c);
    const e9 = emaLast(closes, 9);
    const e21 = emaLast(closes, 21);
    const e34 = emaLast(closes, 34);
    const emaAlign = e9 != null && e21 != null && e34 != null ? (e9 > e21 && e21 > e34 ? 1 : e9 < e21 && e21 < e34 ? -1 : 0) : null;
    const f = this.futures.get(symbol);
    const futChg = f?.quote?.prevClose ? pctChange(f.quote.ltp, f.quote.prevClose) : null;
    const futOiChg = f?.quote && f.sessionBaselineOi ? pctChange(f.quote.oi, f.sessionBaselineOi) : null;
    const b = this.srBundle(symbol, "5m");
    const expiry = this.expiriesOf(symbol)[0];
    const state = expiry ? this.chains.get(`${symbol}|${expiry}`) : null;
    return {
      symbol,
      name: u.meta.name,
      sector: u.meta.segment === "INDEX" ? "INDEX" : "FNO",
      segment: u.meta.segment,
      ltp: q.ltp,
      chgPct: q.prevClose ? pctChange(q.ltp, q.prevClose) : 0,
      volume: q.volume,
      rvol: this.rvolCache.get(symbol) ?? null,
      vwap: Number.isFinite(q.avgPrice) ? q.avgPrice : null,
      emaAlign,
      structureTrend: b?.structure.trend ?? null,
      fut:
        f?.quote && futChg != null
          ? {
              instrumentKey: f.instrumentKey, // REAL key from the Upstox master
              expiry: f.expiry,
              ltp: f.quote.ltp,               // REAL futures LTP (never spot)
              chgPct: futChg,
              oiChgPct: futOiChg ?? 0,
              oi: f.quote.oi,
              classification: futOiChg == null ? "UNAVAILABLE" : classifyFutures(futChg, futOiChg),
              basis: f.quote.ltp - q.ltp,
              lotSize: u.meta.lotSize,
            }
          : null,
      fmpi: this.fmpiFor(symbol, "5m"),
      // unified engine output — identical to chart + panel
      sr: (() => {
        const sel = this.unifiedSelection(symbol, "5m") ?? b?.selection ?? null;
        return sel
          ? {
              immediateSupport: sel.immediateSupport,
              primarySupport: sel.primarySupport,
              immediateResistance: sel.immediateResistance,
              primaryResistance: sel.primaryResistance,
            }
          : null;
      })(),
      chain: state
        ? { atm: this.atmOf(symbol, state) ?? 0, bestCe: this.bestStrike(symbol, state, "CE"), bestPe: this.bestStrike(symbol, state, "PE") }
        : null,
      freshness: this.freshnessOf(q.exchangeTs),
      atr: atr(candles, 14),
      coverage: this.coverage.get(symbol) ?? this.updateCoverage(symbol),
    };
  }

  allIntel(): SymbolIntel[] {
    const out: SymbolIntel[] = [];
    for (const symbol of this.underlyings.keys()) {
      const i = this.intelFor(symbol);
      if (i) out.push(i);
    }
    return out;
  }

  refreshEngines(): void {
    if (this.gate()) return;
    try {
      const intel = this.allIntel();
      if (!intel.length) return;
      this.lastScanner = intel.flatMap((s) => scanSymbol(s));
      this.lastTrades = runTradeFinder(intel);
      this.lastEngineAt = Date.now();
      this.evaluateAlerts(intel);
      void this.persistEngineOutputs();
    } catch (e) {
      this.noteError(e, "engine");
    }
  }

  private async persistEngineOutputs(): Promise<void> {
    if (!this.dbReady) return;
    try {
      const now = new Date();
      if (this.lastScanner.length)
        await db.insert(scannerTable).values(
          this.lastScanner.slice(0, 60).map((r) => ({ ts: now, category: r.category, symbol: r.symbol, score: r.score, coverage: r.coverage, metrics: r as unknown as Record<string, unknown> })),
        );
      const trades = [...(this.lastTrades?.bullish ?? []), ...(this.lastTrades?.bearish ?? [])];
      if (trades.length)
        await db.insert(tradesTable).values(
          trades.slice(0, 20).map((t) => ({
            ts: now, symbol: t.symbol, direction: t.direction, category: t.category, contractKey: t.contractKey,
            expiry: t.expiry, strike: t.strike, entryType: t.entryType, entry: t.entry, stopLoss: t.stopLoss,
            target1: t.target1, target2: t.target2, targetExt: t.targetExt, rr: t.rr, score: t.score,
            coverage: t.coverage, freshness: t.freshness, status: t.status, rationale: t.rationale, invalidation: t.invalidation,
            oiConfirmation: t.oiConfirmation, deltaSource: t.deltaSource, dataCoverage: t.dataCoverage,
          })),
        );
      for (const sym of this.focus) {
        const f = this.fmpiFor(sym, "5m");
        if (f) await db.insert(fmpiTable).values({ symbol: sym, tf: "5m", ts: now, value: f.value, classification: f.classification, acceleration: f.acceleration, coverage: f.coverage, components: f.components });
      }
      const ov = this.overviewPayload();
      if ("available" in ov && ov.available) await db.insert(snapsTable).values({ ts: now, kind: "OVERVIEW", payload: ov as unknown as Record<string, unknown> });
    } catch {
      this.dbReady = false;
    }
  }

  private evaluateAlerts(intel: SymbolIntel[]): void {
    const session = nowIstParts().date;
    const fire: { symbol: string; event: string; price: number; severity: string; evidence: Record<string, unknown> }[] = [];
    for (const s of intel) {
      const mark = (ev: string, state: string): boolean => {
        const k = `${s.symbol}|${ev}|${session}`;
        if (this.alertState.get(k) === state) return false;
        const had = this.alertState.has(k);
        this.alertState.set(k, state);
        return had; // only fire on an actual transition, not first observation
      };
      if (s.fmpi && s.fmpi.acceleration === "ACCELERATING" && Math.abs(s.fmpi.value) > s.fmpi.thresholds.moderate && mark("FMPI_ACCELERATION", s.fmpi.classification))
        fire.push({ symbol: s.symbol, event: "FMPI_ACCELERATION", price: s.ltp, severity: "WARN", evidence: { fmpi: s.fmpi.value, coverage: s.fmpi.coverage } });
      if (s.fut && mark("FUT_CLASS", s.fut.classification) && (s.fut.classification === "LONG_BUILDUP" || s.fut.classification === "SHORT_BUILDUP"))
        fire.push({ symbol: s.symbol, event: `FUTURES_${s.fut.classification}`, price: s.ltp, severity: "INFO", evidence: { oiChgPct: s.fut.oiChgPct, chgPct: s.fut.chgPct } });
      if (s.sr?.immediateResistance && s.ltp > s.sr.immediateResistance.priceHigh && mark("BREAKOUT", s.sr.immediateResistance.id))
        fire.push({ symbol: s.symbol, event: "BREAKOUT_CONFIRMATION", price: s.ltp, severity: "CRITICAL", evidence: { zone: s.sr.immediateResistance.mid, sources: s.sr.immediateResistance.sources } });
      if (s.sr?.immediateSupport && s.ltp < s.sr.immediateSupport.priceLow && mark("BREAKDOWN", s.sr.immediateSupport.id))
        fire.push({ symbol: s.symbol, event: "BREAKDOWN_CONFIRMATION", price: s.ltp, severity: "CRITICAL", evidence: { zone: s.sr.immediateSupport.mid, sources: s.sr.immediateSupport.sources } });
      if (s.vwap != null && mark("VWAP_SIDE", s.ltp >= s.vwap ? "ABOVE" : "BELOW"))
        fire.push({ symbol: s.symbol, event: s.ltp >= s.vwap ? "VWAP_RECLAIM" : "VWAP_REJECTION", price: s.ltp, severity: "INFO", evidence: { vwap: s.vwap } });
    }
    for (const sym of this.focus) {
      const s = intel.find((x) => x.symbol === sym);
      const b = this.srBundle(sym, "5m");
      if (!s || !b) continue;
      const step = this.strikeStep(sym);
      const sel = this.unifiedSelection(sym, "5m") ?? b.selection;
      for (const z of [sel.immediateSupport, sel.immediateResistance].filter((x): x is SRZone => !!x)) {
        const near = this.oiZoneSummary(sym).filter((o) => Math.abs(o.strike - z.mid) <= step * 1.5);
        const a = assessZone({
          zone: z,
          price: s.ltp,
          atrValue: s.atr,
          recentCloses: this.candlesSync(sym, "1m").slice(-6).map((c) => c.c),
          recentVolumes: this.candlesSync(sym, "1m").slice(-8).map((c) => c.v),
          futuresBias: s.fut ? clamp(s.fut.chgPct * 40, -1, 1) : null,
          nearbyCeSess: near.map((n) => n.ceSessChg),
          nearbyPeSess: near.map((n) => n.peSessChg),
          premiumResp: s.chain?.bestCe ? clamp(s.chain.bestCe.premChgPct / 10, -1, 1) : null,
          vwap: s.vwap,
        });
        if (a.assessment !== "INSUFFICIENT_EVIDENCE") {
          const k = `${sym}|ZONE|${z.id}`;
          if (this.alertState.has(k) && this.alertState.get(k) !== a.assessment)
            fire.push({ symbol: sym, event: a.assessment, price: s.ltp, severity: a.assessment.includes("WATCH") ? "CRITICAL" : "WARN", evidence: { zone: z.mid, evidence: a.evidence } });
          this.alertState.set(k, a.assessment);
        }
      }
    }
    for (const a of fire) void this.insertAlert(a);
  }

  private async insertAlert(a: { symbol: string; event: string; price: number; severity: string; evidence: Record<string, unknown> }): Promise<void> {
    this.events.emit("alert", { ...a, ts: Date.now() });
    if (!this.dbReady) return;
    try {
      await db
        .insert(alertsTable)
        .values({
          ts: new Date(), symbol: a.symbol, event: a.event, price: a.price, severity: a.severity, status: "OPEN",
          evidence: a.evidence, dedupeKey: `${a.symbol}|${a.event}|${nowIstParts().date}|${Math.floor(Date.now() / 60000)}`,
        })
        .onConflictDoNothing({ target: [alertsTable.dedupeKey] });
    } catch {
      /* optional */
    }
  }

  scannerPayload() {
    const gate = this.gate();
    if (gate) return gate;
    if (Date.now() - this.lastEngineAt > 8_000) this.refreshEngines();
    if (!this.lastScanner.length) return unavailable("No instrument currently matches a scanner category from live data.", "EMPTY");
    return { available: true as const, ts: Date.now(), rows: this.lastScanner };
  }

  tradeFinderPayload() {
    const gate = this.gate();
    if (gate) return gate;
    if (Date.now() - this.lastEngineAt > 8_000) this.refreshEngines();
    const t = this.lastTrades ?? { bullish: [], bearish: [], wait: [], waitSummary: "Engine warming up on live data." };
    return { available: true as const, ts: Date.now(), ...t };
  }

  dominancePayload() {
    const gate = this.gate();
    if (gate) return gate;
    return { available: true as const, ...dominanceRows(this.allIntel()) };
  }

  targetsPayload(symbol: string) {
    const gate = this.gate();
    if (gate) return gate;
    const intel = this.intelFor(symbol);
    const b = this.srBundle(symbol, "5m");
    if (!intel || !b) return unavailable("Not enough live candles yet to project targets.", "NO_CANDLES");
    return { available: true as const, symbol, ...computeTargets(intel, b.zones, b.structure.events) };
  }

  overviewPayload() {
    const gate = this.gate();
    if (gate) return gate;
    const intel = this.allIntel();
    if (!intel.length) return unavailable("Waiting for the first Upstox quote batch.", "LOADING");
    const q = this.quotesPayload().quotes;
    const eq = intel.filter((s) => s.segment === "EQUITY");
    const sorted = [...eq].sort((a, b) => b.chgPct - a.chgPct);
    const advances = intel.filter((s) => s.chgPct > 0.05).length;
    const declines = intel.filter((s) => s.chgPct < -0.05).length;
    const futPos = { long: 0, short: 0, sc: 0, lu: 0 };
    for (const s of intel) {
      if (s.fut?.classification === "LONG_BUILDUP") futPos.long++;
      else if (s.fut?.classification === "SHORT_BUILDUP") futPos.short++;
      else if (s.fut?.classification === "SHORT_COVERING") futPos.sc++;
      else if (s.fut?.classification === "LONG_UNWINDING") futPos.lu++;
    }
    const row = (s: SymbolIntel) => ({ symbol: s.symbol, ltp: round2(s.ltp), chgPct: round2(s.chgPct), volume: s.volume, rvol: s.rvol, fut: s.fut?.classification ?? null, fmpi: s.fmpi?.value ?? null });
    const withFmpi = intel.filter((s) => s.fmpi && s.fmpi.coverage > 0);
    let sent = 0;
    const fam: string[] = [];
    const nifty = q["NIFTY"];
    if (nifty) {
      sent += clamp(nifty.chgPct, -2, 2) / 2;
      fam.push("index trend");
    }
    sent += clamp((advances - declines) / Math.max(intel.length, 1), -1, 1);
    fam.push("breadth");
    if (withFmpi.length) {
      sent += clamp(withFmpi.reduce((s, x) => s + (x.fmpi?.value ?? 0), 0) / withFmpi.length / 60, -1, 1);
      fam.push("FMPI breadth");
    }
    if (futPos.long + futPos.short > 0) {
      sent += clamp((futPos.long - futPos.short) / (futPos.long + futPos.short), -1, 1);
      fam.push("futures positioning");
    }
    const state = sent > 1.2 ? "Strong Bullish" : sent > 0.45 ? "Bullish" : sent < -1.2 ? "Strong Bearish" : sent < -0.45 ? "Bearish" : "Sideways";
    const missingFut = intel.filter((s) => !s.fut).length;
    const missingCandles = intel.filter((s) => !s.structureTrend).length;
    return {
      available: true as const,
      indices: (() => {
        const idx = intel.filter((s) => s.segment === "INDEX");
        const priority = ["NIFTY", "SENSEX", "BANKNIFTY", "FINNIFTY"];
        const rank = (sym: string) => {
          const i = priority.indexOf(sym);
          return i === -1 ? priority.length + 1 : i;
        };
        return idx
          .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol))
          .slice(0, 4)
          .map((s) => ({ symbol: s.symbol, ...(q[s.symbol] ?? {}) }));
      })(),
      vix: null,
      breadth: { advances, declines, unchanged: intel.length - advances - declines },
      gainers: sorted.slice(0, 8).map(row),
      losers: sorted.slice(-8).reverse().map(row),
      mostActive: [...eq].sort((a, b) => b.volume - a.volume).slice(0, 8).map(row),
      highRvol: eq.filter((s) => (s.rvol ?? 0) > 1.2).sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0)).slice(0, 8).map(row),
      strongFmpi: withFmpi.sort((a, b) => Math.abs(b.fmpi!.value) - Math.abs(a.fmpi!.value)).slice(0, 8).map((s) => ({ ...row(s), fmpi: s.fmpi!.value, classification: s.fmpi!.classification })),
      futuresPositioning: futPos,
      sectors: [],
      sentiment: {
        state,
        score: round2(sent),
        families: fam,
        missing: `${missingFut} instrument(s) without futures data · ${missingCandles} without candle history yet`,
      },
      coverage: { withCandles: intel.length - missingCandles, withFutures: intel.length - missingFut, total: intel.length },
      freshness: Object.values(q).some((x) => x.freshness === "LIVE") ? "LIVE" : marketPhase() === "OPEN" ? "DELAYED" : "HISTORICAL",
      ts: Date.now(),
    };
  }

  workspacePayload(symbol: string, expiry?: string) {
    const gate = this.gate();
    if (gate) return gate;
    const u = this.underlyings.get(symbol);
    if (!u) return unavailable(`${symbol} is not in the Upstox F&O instrument master.`, "UNKNOWN_SYMBOL");
    this.setFocus(symbol);
    if (!u.quote) return unavailable("Waiting for the first Upstox quote for this instrument.", "NO_QUOTE");
    const exp = expiry ?? u.meta.expiries[0];
    const intel = this.intelFor(symbol);
    const trade = intel ? evaluateSymbol(intel, { niftyDir: 0 }) : { trades: [], waits: [] };
    const q = u.quote;
    return {
      available: true as const,
      symbol,
      name: u.meta.name,
      sector: u.meta.segment === "INDEX" ? "INDEX" : "F&O",
      segment: u.meta.segment,
      spot: {
        ltp: round2(q.ltp),
        chgPct: q.prevClose ? round2(pctChange(q.ltp, q.prevClose)) : null,
        open: round2(q.open),
        high: round2(q.high),
        low: round2(q.low),
        prevClose: round2(q.prevClose),
        vwap: Number.isFinite(q.avgPrice) ? round2(q.avgPrice) : null,
        volume: q.volume,
      },
      expiry: exp ?? null,
      expiries: u.meta.expiries,
      lotSize: u.meta.lotSize,
      fmpi: this.fmpiFor(symbol, "5m"),
      sr: this.srPayload(symbol, "5m"),
      srLevels: this.srLevelsPayload(symbol, "5m"),
      structure: this.structurePayload(symbol, "5m"),
      profile: this.volumeProfilePayload(symbol),
      chain: exp ? this.optionChainPayload(symbol, exp, 3) : unavailable("No listed option expiry.", "NO_EXPIRY"),
      oiMomentum: exp ? this.oiMomentumPayload(symbol, exp) : unavailable("No listed option expiry.", "NO_EXPIRY"),
      futures: this.futuresPayload(symbol),
      premiumMomentum: exp ? this.premiumMomentumPayload(symbol, exp) : unavailable("No listed option expiry.", "NO_EXPIRY"),
      orderFlow: this.orderFlowPayload(symbol),
      targets: this.targetsPayload(symbol),
      trade: { candidates: trade.trades, waits: trade.waits },
      dominance: intel ? dominanceRows([intel]) : { buyers: [], sellers: [] },
      freshness: this.freshnessOf(q.exchangeTs),
      provider: "UPSTOX",
    };
  }

  async candlePayload(symbol: string, tf: Timeframe, days?: number) {
    const gate = this.gate();
    if (gate) return gate;
    const u = this.underlyings.get(symbol);
    if (!u) return unavailable(`${symbol} is not in the instrument master.`, "UNKNOWN_SYMBOL");
    this.setFocus(symbol);
    let candles = await this.getCandles(symbol, tf);
    if (days && days > 0 && tf !== "1D") {
      const sessions: string[] = [];
      for (const c of candles) {
        const d = istDate(c.ts);
        if (sessions[sessions.length - 1] !== d) sessions.push(d);
      }
      const keep = new Set(sessions.slice(-days));
      candles = candles.filter((c) => keep.has(istDate(c.ts)));
    }
    if (!candles.length) {
      const err = this.candleCache.get(`${symbol}|1m`)?.error;
      return unavailable(err ? `Upstox candle error: ${err}` : "Upstox returned no candles for this instrument/timeframe.", "NO_CANDLES");
    }
    const closes = candles.map((c) => c.c);
    const intraday = tf === "1D" ? [] : this.sessionCandles(symbol);
    const line = (arr: (number | null)[]) => arr.map((v, i) => (v == null ? null : { ts: candles[i].ts, v: round2(v) })).filter(Boolean);
    const bb = bollinger(closes, 20, 2);
    const band = (a: number[]) => a.map((v, i) => (Number.isNaN(v) ? null : { ts: candles[i].ts, v: round2(v) })).filter(Boolean);
    const { ema, rsi } = await import("@/lib/engine/indicators");
    return {
      available: true as const,
      symbol,
      tf,
      provider: "UPSTOX",
      sourceTf: tf === "1D" ? "days/1" : "minutes/1 (aggregated)",
      historical: this.candleMeta.get(symbol)?.historical ?? false,
      sessionDate: this.candleMeta.get(symbol)?.sessionDate ?? null,
      sessions: [...new Set(candles.map((c) => istDate(c.ts)))],
      sessionWindow: SESSION_WINDOW,
      sessionsShown: new Set(candles.map((c) => istDate(c.ts))).size,
      candles: candles.map((c) => ({ ts: c.ts, o: round2(c.o), h: round2(c.h), l: round2(c.l), c: round2(c.c), v: Math.round(c.v) })),
      indicators: {
        ema9: line(ema(closes, 9)),
        ema15: line(ema(closes, 15)),
        ema21: line(ema(closes, 21)),
        ema34: line(ema(closes, 34)),
        ema50: line(ema(closes, 50)),
        ema100: line(ema(closes, 100)),
        ema200: line(ema(closes, 200)),
        bbMid: band(bb.mid),
        bbUp: band(bb.up),
        bbDn: band(bb.dn),
        rsi14: line(rsi(closes, 14)),
        atr14: atr(candles, 14),
        vwap: intraday.length ? sessionVwap(intraday) : null,
        vwapNow: intraday.length ? vwapBands(intraday) : null,
      },
      meta: { open: round2(u.quote?.open ?? NaN), high: round2(u.quote?.high ?? NaN), low: round2(u.quote?.low ?? NaN), prevClose: round2(u.quote?.prevClose ?? NaN), ltp: round2(u.quote?.ltp ?? NaN), tickSize: u.meta.tickSize },
    };
  }

  /** Refresh RVOL for the focus set (one historical call per symbol per day). */
  async refreshRvol(): Promise<void> {
    if (this.gate()) return;
    for (const sym of this.focus) {
      const v = await this.rvol(sym).catch(() => null);
      if (v != null) this.rvolCache.set(sym, v);
    }
  }
}

/* ------------------------------------------------------------- helpers -- */
/** Merge a provider WS tick into the existing REST snapshot (WS wins on price). */
function mergeTick(prev: UpstoxQuote | null, t: FeedTick): UpstoxQuote {
  const base: UpstoxQuote =
    prev ?? {
      instrumentKey: t.instrumentKey, symbolKey: t.instrumentKey, ltp: NaN, open: NaN, high: NaN, low: NaN,
      close: NaN, prevClose: NaN, volume: 0, oi: 0, avgPrice: NaN, netChange: NaN, bid: NaN, ask: NaN,
      bidQty: 0, askQty: 0, depth: { bid: [], ask: [] }, exchangeTs: null, receiveTs: Date.now(),
    };
  const ltp = t.ltp ?? base.ltp;
  const prevClose = t.cp ?? base.prevClose;
  return {
    ...base,
    ltp,
    prevClose,
    close: t.cp ?? base.close,
    open: t.ohlc?.open ?? base.open,
    high: t.ohlc?.high ?? base.high,
    low: t.ohlc?.low ?? base.low,
    volume: t.vtt ?? base.volume,
    oi: t.oi ?? base.oi,
    avgPrice: t.atp ?? base.avgPrice,
    bid: t.bid ?? base.bid,
    ask: t.ask ?? base.ask,
    bidQty: t.bidQty ?? base.bidQty,
    askQty: t.askQty ?? base.askQty,
    // exchange stamp comes from the feed's last-trade time; never server time
    exchangeTs: t.ltt ?? base.exchangeTs,
    receiveTs: t.receiveTs,
  };
}

function istDate(ts: number): string {
  return new Date(ts + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : NaN;
}

function premChange(live: OptionLive, now: number, minutes: number): number | null {
  if (live.premObs.length < 2) return null;
  const target = now - minutes * 60_000;
  let ref: { ts: number; ltp: number } | null = null;
  for (const p of live.premObs) {
    if (p.ts <= target) ref = p;
    else break;
  }
  if (!ref) {
    const first = live.premObs[0];
    if (now - first.ts < minutes * 60_000 * 0.6) return null;
    ref = first;
  }
  if (!ref.ltp) return null;
  return pctChange(live.leg.ltp, ref.ltp);
}

function baselineQualityOf(state: ChainState): BaselineQuality {
  let best: BaselineQuality = "UNAVAILABLE";
  const rank: Record<BaselineQuality, number> = { OPEN_CAPTURE: 3, RESTORED: 2, LATE_START: 1, UNAVAILABLE: 0 };
  for (const slot of state.strikes.values())
    for (const live of [slot.ce, slot.pe]) if (live && rank[live.baselineQuality] > rank[best]) best = live.baselineQuality;
  return best;
}

function historySpanMinutes(state: ChainState): number {
  let oldest = Infinity;
  for (const slot of state.strikes.values()) {
    for (const live of [slot.ce, slot.pe]) {
      const f = live?.obs[0];
      if (f) oldest = Math.min(oldest, f.ts);
    }
  }
  return Number.isFinite(oldest) ? Math.round((Date.now() - oldest) / 60_000) : 0;
}

function legPayload(live?: OptionLive) {
  if (!live) return null;
  const l = live.leg;
  const spread = Number.isFinite(l.bid) && Number.isFinite(l.ask) && l.ltp ? ((l.ask - l.bid) / l.ltp) * 100 : null;
  return {
    key: live.instrumentKey,
    ltp: round2(l.ltp),
    chgPct: Number.isFinite(l.closePrice) && l.closePrice ? round2(pctChange(l.ltp, l.closePrice)) : null,
    volume: l.volume,
    oi: l.oi,
    prevOi: l.prevOi,
    oiSessChg: live.sessionBaselineOi == null ? null : l.oi - live.sessionBaselineOi,
    oiVsPrevSession: l.prevOi == null ? null : l.oi - l.prevOi,
    bid: round2(l.bid),
    ask: round2(l.ask),
    bidQty: l.bidQty,
    askQty: l.askQty,
    spreadPct: spread == null ? null : round2(spread),
    iv: l.iv,
    delta: l.delta,
    gamma: l.gamma,
    theta: l.theta,
    vega: l.vega,
    greeksSource: "UPSTOX_PROVIDED",
  };
}

const g = globalThis as typeof globalThis & { __pulseStore?: LiveStore };
export const store = g.__pulseStore ?? new LiveStore();
if (!g.__pulseStore) g.__pulseStore = store;
export type { LiveStore };
