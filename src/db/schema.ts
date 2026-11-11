import {
  pgTable,
  bigserial,
  serial,
  text,
  doublePrecision,
  integer,
  bigint,
  boolean,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * PULSEGRID 2.0 — canonical data model.
 * Every observation row preserves: instrument identity, exchange timestamp,
 * receive timestamp, provider and freshness so downstream engines can enforce
 * data-quality rules (no silent substitution of stale/historical data).
 */

// ---------------------------------------------------------------------------
// Instrument master
// ---------------------------------------------------------------------------
export const instruments = pgTable(
  "instruments",
  {
    id: serial("id").primaryKey(),
    instrumentKey: text("instrument_key").notNull().unique(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    exchange: text("exchange").notNull().default("NSE"),
    segment: text("segment").notNull(), // INDEX | EQUITY | FUT | OPT
    underlying: text("underlying"),
    expiry: date("expiry"),
    strike: doublePrecision("strike"),
    optionType: text("option_type"), // CE | PE
    lotSize: integer("lot_size").notNull().default(1),
    tickSize: doublePrecision("tick_size").notNull().default(0.05),
    strikeInterval: doublePrecision("strike_interval"),
    sector: text("sector"),
    isFo: boolean("is_fo").notNull().default(false),
    source: text("source").notNull().default("UPSTOX"), // UPSTOX | SIM_SEED
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("instruments_symbol_idx").on(t.symbol), index("instruments_underlying_idx").on(t.underlying)],
);

// ---------------------------------------------------------------------------
// Quotes (latest snapshot per instrument + time series of snapshots)
// ---------------------------------------------------------------------------
export const quotes = pgTable(
  "quotes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    instrumentKey: text("instrument_key").notNull(),
    // nullable: the provider does not always supply a usable exchange stamp.
    // It is NEVER back-filled with server time.
    exchangeTs: timestamp("exchange_ts", { withTimezone: true }),
    receiveTs: timestamp("receive_ts", { withTimezone: true }).notNull(),
    provider: text("provider").notNull(),
    freshness: text("freshness").notNull(), // LIVE|DELAYED|HISTORICAL|STALE|UNAVAILABLE
    ltp: doublePrecision("ltp"),
    open: doublePrecision("open"),
    high: doublePrecision("high"),
    low: doublePrecision("low"),
    prevClose: doublePrecision("prev_close"),
    volume: bigint("volume", { mode: "number" }),
    oi: bigint("oi", { mode: "number" }),
    bid: doublePrecision("bid"),
    ask: doublePrecision("ask"),
    bidQty: bigint("bid_qty", { mode: "number" }),
    askQty: bigint("ask_qty", { mode: "number" }),
  },
  (t) => [index("quotes_key_ts_idx").on(t.instrumentKey, t.exchangeTs)],
);

// ---------------------------------------------------------------------------
// Candle history (aggregated per timeframe)
// ---------------------------------------------------------------------------
export const candles = pgTable(
  "candles",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    instrumentKey: text("instrument_key").notNull(),
    tf: text("tf").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    uniqueIndex("candles_key_tf_ts_uq").on(t.instrumentKey, t.tf, t.ts),
    index("candles_key_tf_idx").on(t.instrumentKey, t.tf),
  ],
);

// ---------------------------------------------------------------------------
// OI observations — one row per contract per sample. Never aggregated across
// different expiries, strikes, option types or underlyings.
// ---------------------------------------------------------------------------
export const oiObservations = pgTable(
  "oi_observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    instrumentKey: text("instrument_key").notNull(),
    underlying: text("underlying").notNull(),
    expiry: date("expiry").notNull(),
    strike: doublePrecision("strike").notNull(),
    optionType: text("option_type").notNull(), // CE | PE
    /** exchange/provider event time for THIS contract, when supplied */
    exchangeTs: timestamp("exchange_ts", { withTimezone: true }),
    /** server time at which this option-chain snapshot was collected */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    receiveTs: timestamp("receive_ts", { withTimezone: true }).notNull(),
    provider: text("provider").notNull(),
    oi: bigint("oi", { mode: "number" }).notNull(),
    ltp: doublePrecision("ltp"),
    volume: bigint("volume", { mode: "number" }),
  },
  (t) => [
    index("oi_key_obs_idx").on(t.instrumentKey, t.observedAt),
    index("oi_underlying_idx").on(t.underlying, t.expiry, t.strike, t.optionType),
    // idempotent snapshots — repeated polls cannot duplicate history
    uniqueIndex("oi_obs_uq").on(t.instrumentKey, t.observedAt),
  ],
);

// Fixed, valid per-session OI baseline — never reset on refresh.
export const oiBaselines = pgTable(
  "oi_baselines",
  {
    id: serial("id").primaryKey(),
    instrumentKey: text("instrument_key").notNull(),
    sessionDate: date("session_date").notNull(),
    baselineOi: bigint("baseline_oi", { mode: "number" }).notNull(),
    prevSessionOi: bigint("prev_session_oi", { mode: "number" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** IST minute-of-day at capture — proves whether this is a true open baseline */
    capturedMinute: integer("captured_minute").notNull().default(0),
    /** OPEN_CAPTURE = taken at/near 09:15 · LATE_START = app started mid-session */
    quality: text("quality").notNull().default("LATE_START"),
  },
  (t) => [uniqueIndex("oi_baseline_uq").on(t.instrumentKey, t.sessionDate)],
);

// ---------------------------------------------------------------------------
// Futures observations + contract metadata
// ---------------------------------------------------------------------------
export const futuresObservations = pgTable(
  "futures_observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    instrumentKey: text("instrument_key").notNull(),
    underlying: text("underlying").notNull(),
    expiry: date("expiry").notNull(),
    exchangeTs: timestamp("exchange_ts", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    ltp: doublePrecision("ltp").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull().default(0),
    oi: bigint("oi", { mode: "number" }).notNull().default(0),
    basis: doublePrecision("basis"),
  },
  (t) => [
    index("fut_key_obs_idx").on(t.instrumentKey, t.observedAt),
    uniqueIndex("fut_obs_uq").on(t.instrumentKey, t.observedAt),
  ],
);

// ---------------------------------------------------------------------------
// Premium observations (per option contract)
// ---------------------------------------------------------------------------
export const premiumObservations = pgTable(
  "premium_observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    instrumentKey: text("instrument_key").notNull(),
    exchangeTs: timestamp("exchange_ts", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    ltp: doublePrecision("ltp").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull().default(0),
    oi: bigint("oi", { mode: "number" }).notNull().default(0),
    iv: doublePrecision("iv"),
    delta: doublePrecision("delta"),
    underlyingLtp: doublePrecision("underlying_ltp"),
  },
  (t) => [
    index("prem_key_obs_idx").on(t.instrumentKey, t.observedAt),
    uniqueIndex("prem_obs_uq").on(t.instrumentKey, t.observedAt),
  ],
);

// ---------------------------------------------------------------------------
// S/R zones with lifecycle and evidence provenance
// ---------------------------------------------------------------------------
export const srZones = pgTable(
  "sr_zones",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    symbol: text("symbol").notNull(),
    tf: text("tf").notNull(),
    side: text("side").notNull(), // SUPPORT | RESISTANCE
    priceLow: doublePrecision("price_low").notNull(),
    priceHigh: doublePrecision("price_high").notNull(),
    kind: text("kind").notNull(), // PRICE_ACTION | OI_ONLY | VOLUME_PROFILE | VWAP | MULTI_SOURCE
    sources: jsonb("sources").$type<string[]>().notNull(),
    status: text("status").notNull(), // lifecycle state
    touches: integer("touches").notNull().default(0),
    strength: doublePrecision("strength").notNull().default(0),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull(),
    lastTested: timestamp("last_tested", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sr_symbol_tf_idx").on(t.symbol, t.tf)],
);

// ---------------------------------------------------------------------------
// FMPI observations
// ---------------------------------------------------------------------------
export const fmpiObservations = pgTable(
  "fmpi_observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    symbol: text("symbol").notNull(),
    tf: text("tf").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    value: doublePrecision("value").notNull(),
    classification: text("classification").notNull(),
    acceleration: text("acceleration").notNull(),
    coverage: doublePrecision("coverage").notNull(),
    components: jsonb("components").$type<Record<string, number>>().notNull(),
  },
  (t) => [index("fmpi_symbol_tf_ts_idx").on(t.symbol, t.tf, t.ts)],
);

// ---------------------------------------------------------------------------
// Scanner results / Trade candidates / Alerts / Watchlist / Settings
// ---------------------------------------------------------------------------
export const scannerResults = pgTable(
  "scanner_results",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    category: text("category").notNull(),
    symbol: text("symbol").notNull(),
    score: doublePrecision("score").notNull(),
    coverage: doublePrecision("coverage").notNull(),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("scanner_ts_idx").on(t.ts)],
);

export const tradeCandidates = pgTable(
  "trade_candidates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    symbol: text("symbol").notNull(),
    direction: text("direction").notNull(), // LONG | SHORT
    category: text("category").notNull(), // BULLISH_CE | BEARISH_PE | BULLISH_FUT | ...
    contractKey: text("contract_key"),
    expiry: date("expiry"),
    strike: doublePrecision("strike"),
    entryType: text("entry_type").notNull(),
    entry: doublePrecision("entry").notNull(),
    stopLoss: doublePrecision("stop_loss").notNull(),
    target1: doublePrecision("target1"),
    target2: doublePrecision("target2"),
    targetExt: doublePrecision("target_ext"),
    rr: doublePrecision("rr"),
    oiConfirmation: text("oi_confirmation"),
    deltaSource: text("delta_source"),
    dataCoverage: text("data_coverage"),
    score: doublePrecision("score").notNull(),
    coverage: doublePrecision("coverage").notNull(),
    freshness: text("freshness").notNull(),
    status: text("status").notNull(), // ACTIONABLE | WATCH | WAIT
    rationale: jsonb("rationale").$type<string[]>().notNull(),
    invalidation: text("invalidation").notNull(),
  },
  (t) => [index("trades_ts_idx").on(t.ts)],
);

export const alertRules = pgTable("alert_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  event: text("event").notNull(),
  symbol: text("symbol"),
  enabled: boolean("enabled").notNull().default(true),
  params: jsonb("params").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const alerts = pgTable(
  "alerts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    ruleId: integer("rule_id"),
    symbol: text("symbol").notNull(),
    event: text("event").notNull(),
    price: doublePrecision("price"),
    severity: text("severity").notNull(), // INFO | WARN | CRITICAL
    status: text("status").notNull().default("OPEN"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
  },
  (t) => [index("alerts_ts_idx").on(t.ts)],
);

export const watchlist = pgTable("watchlist", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),
  kind: text("kind").notNull().default("EQUITY"),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const marketSnapshots = pgTable(
  "market_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index("snap_kind_ts_idx").on(t.kind, t.ts)],
);
