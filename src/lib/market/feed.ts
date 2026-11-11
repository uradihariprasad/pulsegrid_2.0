/**
 * PULSEGRID 2.0 — Upstox Market Data Feed V3 (real provider WebSocket).
 *
 * Flow (per docs.upstox.com/v3/get-market-data-feed):
 *   1. GET /v3/feed/market-data-feed/authorize  → authorized wss redirect URI
 *   2. Connect with `ws` (followRedirects) using the Bearer token
 *   3. Send BINARY subscription frames: {guid, method:"sub", data:{mode, instrumentKeys}}
 *   4. Decode incoming binary frames with the official MarketDataFeed.proto
 *
 * Honesty rule: `mode` reports WS only while a decoded provider tick has been
 * seen recently. Otherwise the store keeps serving REST snapshots and the UI
 * is told the transport is REST — WebSocket is never falsely claimed.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import protobuf from "protobufjs";
import WebSocket from "ws";
import { authorizeMarketFeed, parseExchangeTs } from "./upstox";
import { getUpstoxToken } from "./credentials";

export interface FeedTick {
  instrumentKey: string;
  ltp: number | null;
  cp: number | null;          // previous close from the feed
  ltt: number | null;         // exchange last-trade time (ms)
  ltq: number | null;
  oi: number | null;
  vtt: number | null;         // volume traded today
  atp: number | null;
  iv: number | null;
  greeks: { delta: number | null; theta: number | null; gamma: number | null; vega: number | null } | null;
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  ohlc: { open: number; high: number; low: number; close: number } | null;
  receiveTs: number;
}

export type FeedMode = "ltpc" | "option_greeks" | "full";

// V3 subscription limits (docs): ltpc 5000 / greeks 3000 / full 2000;
// combined 2000 (ltpc+greeks) or 1500 with full.
const MAX_KEYS: Record<FeedMode, number> = { ltpc: 2000, option_greeks: 1500, full: 1200 };

type Listener = (ticks: FeedTick[], meta: { currentTs: number | null; type: string }) => void;

export class MarketFeedV3 {
  private ws: WebSocket | null = null;
  private root: protobuf.Root | null = null;
  private decoder: protobuf.Type | null = null;
  private connecting = false;
  private closedByUs = false;
  private attempts = 0;
  private subs = new Map<string, FeedMode>();
  private pendingSub = new Set<string>();
  private listeners: Listener[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;

  lastTickAt = 0;
  lastError: string | null = null;
  connectedAt = 0;
  segmentStatus: Record<string, string> = {};
  framesDecoded = 0;
  state: "IDLE" | "CONNECTING" | "OPEN" | "CLOSED" | "ERROR" = "IDLE";

  /** WS is only "live" when a decoded tick arrived in the last 60s. */
  get isLive(): boolean {
    return this.state === "OPEN" && this.lastTickAt > 0 && Date.now() - this.lastTickAt < 60_000;
  }

  get subscriptionCount(): number {
    return this.subs.size;
  }

  onTicks(fn: Listener): void {
    this.listeners.push(fn);
  }

  private async loadProto(): Promise<protobuf.Type> {
    if (this.decoder) return this.decoder;
    const file = path.join(process.cwd(), "src", "lib", "market", "MarketDataFeed.proto");
    this.root = await protobuf.load(file);
    this.decoder = this.root.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");
    return this.decoder;
  }

  /** Idempotent: never creates a duplicate connection. */
  async connect(): Promise<boolean> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return true;
    if (this.connecting) return false;
    this.connecting = true;
    this.closedByUs = false;
    this.state = "CONNECTING";
    try {
      const token = await getUpstoxToken();
      if (!token) throw new Error("no token");
      await this.loadProto();
      const uri = (await authorizeMarketFeed()) ?? "wss://api.upstox.com/v3/feed/market-data-feed";
      const ws = new WebSocket(uri, {
        headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
        followRedirects: true,
        handshakeTimeout: 15_000,
      });
      this.ws = ws;

      ws.on("open", () => {
        this.state = "OPEN";
        this.attempts = 0;
        this.connectedAt = Date.now();
        this.lastError = null;
        // controlled resubscription of everything we had before the drop
        const byMode = new Map<FeedMode, string[]>();
        for (const [k, m] of this.subs) {
          const list = byMode.get(m) ?? [];
          list.push(k);
          byMode.set(m, list);
        }
        for (const [mode, keys] of byMode) this.sendSub(keys, mode);
        this.pendingSub.clear();
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          this.handleFrame(buf);
        } catch (e) {
          this.lastError = `decode: ${(e as Error).message}`;
        }
      });

      ws.on("error", (e: Error) => {
        this.lastError = e.message;
        this.state = "ERROR";
      });

      ws.on("close", () => {
        this.state = "CLOSED";
        this.ws = null;
        if (!this.closedByUs) this.scheduleReconnect();
      });

      this.connecting = false;
      return true;
    } catch (e) {
      this.connecting = false;
      this.lastError = (e as Error).message;
      this.state = "ERROR";
      this.scheduleReconnect();
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUs) return;
    this.attempts++;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private handleFrame(buf: Buffer): void {
    if (!this.decoder) return;
    const msg = this.decoder.decode(buf);
    const obj = this.decoder.toObject(msg, { longs: String, enums: String, defaults: false }) as {
      type?: string;
      currentTs?: string | number;
      feeds?: Record<string, FeedUnion>;
      marketInfo?: { segmentStatus?: Record<string, string> };
    };
    this.framesDecoded++;
    if (obj.marketInfo?.segmentStatus) this.segmentStatus = obj.marketInfo.segmentStatus;
    if (!obj.feeds) return;
    const now = Date.now();
    const ticks: FeedTick[] = [];
    for (const [instrumentKey, feed] of Object.entries(obj.feeds)) {
      const t = normalizeFeed(instrumentKey, feed, now);
      if (t) ticks.push(t);
    }
    if (ticks.length) {
      this.lastTickAt = now;
      const ts = obj.currentTs == null ? null : parseExchangeTs(obj.currentTs);
      for (const fn of this.listeners) {
        try {
          fn(ticks, { currentTs: ts, type: obj.type ?? "live_feed" });
        } catch {
          /* listener isolation */
        }
      }
    }
  }

  private sendSub(keys: string[], mode: FeedMode): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !keys.length) return;
    const cap = MAX_KEYS[mode];
    for (let i = 0; i < keys.length && i < cap; i += 500) {
      const slice = keys.slice(i, Math.min(i + 500, cap));
      const payload = { guid: randomUUID(), method: "sub", data: { mode, instrumentKeys: slice } };
      // request frames must be BINARY
      this.ws.send(Buffer.from(JSON.stringify(payload)));
    }
  }

  /** Subscribe, skipping duplicates and respecting the V3 key caps. */
  subscribe(keys: string[], mode: FeedMode = "ltpc"): void {
    const fresh: string[] = [];
    for (const k of keys) {
      if (this.subs.get(k) === mode) continue;
      if (this.subs.size >= MAX_KEYS[mode] && !this.subs.has(k)) break;
      this.subs.set(k, mode);
      fresh.push(k);
    }
    if (!fresh.length) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSub(fresh, mode);
    else for (const k of fresh) this.pendingSub.add(k);
  }

  unsubscribe(keys: string[]): void {
    const drop = keys.filter((k) => this.subs.has(k));
    if (!drop.length) return;
    for (const k of drop) this.subs.delete(k);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(Buffer.from(JSON.stringify({ guid: randomUUID(), method: "unsub", data: { instrumentKeys: drop } })));
    }
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
    this.state = "CLOSED";
  }

  status() {
    return {
      state: this.state,
      live: this.isLive,
      subscriptions: this.subs.size,
      framesDecoded: this.framesDecoded,
      lastTickAt: this.lastTickAt || null,
      connectedAt: this.connectedAt || null,
      reconnectAttempts: this.attempts,
      lastError: this.lastError,
      segmentStatus: this.segmentStatus,
    };
  }
}

interface LtpcMsg { ltp?: number; ltt?: string | number; ltq?: string | number; cp?: number }
interface QuoteMsg { bidQ?: string | number; bidP?: number; askQ?: string | number; askP?: number }
interface GreeksMsg { delta?: number; theta?: number; gamma?: number; vega?: number }
interface OhlcMsg { interval?: string; open?: number; high?: number; low?: number; close?: number; vol?: string | number }
interface FeedUnion {
  ltpc?: LtpcMsg;
  fullFeed?: {
    marketFF?: { ltpc?: LtpcMsg; marketLevel?: { bidAskQuote?: QuoteMsg[] }; optionGreeks?: GreeksMsg; marketOHLC?: { ohlc?: OhlcMsg[] }; atp?: number; vtt?: string | number; oi?: number; iv?: number };
    indexFF?: { ltpc?: LtpcMsg; marketOHLC?: { ohlc?: OhlcMsg[] } };
  };
  firstLevelWithGreeks?: { ltpc?: LtpcMsg; firstDepth?: QuoteMsg; optionGreeks?: GreeksMsg; vtt?: string | number; oi?: number; iv?: number };
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
};

function pickDayOhlc(list?: OhlcMsg[]): { open: number; high: number; low: number; close: number } | null {
  if (!list?.length) return null;
  const day = list.find((o) => o.interval === "1d" || o.interval === "day") ?? list[list.length - 1];
  if (!day || day.open == null) return null;
  return { open: day.open ?? 0, high: day.high ?? 0, low: day.low ?? 0, close: day.close ?? 0 };
}

function normalizeFeed(instrumentKey: string, feed: FeedUnion, now: number): FeedTick | null {
  const base = (ltpc?: LtpcMsg): Partial<FeedTick> => ({
    ltp: num(ltpc?.ltp),
    cp: num(ltpc?.cp),
    ltt: ltpc?.ltt == null ? null : parseExchangeTs(ltpc.ltt),
    ltq: num(ltpc?.ltq),
  });
  const empty: FeedTick = {
    instrumentKey, ltp: null, cp: null, ltt: null, ltq: null, oi: null, vtt: null, atp: null, iv: null,
    greeks: null, bid: null, ask: null, bidQty: null, askQty: null, ohlc: null, receiveTs: now,
  };

  if (feed.ltpc) return { ...empty, ...base(feed.ltpc) };

  const mff = feed.fullFeed?.marketFF;
  if (mff) {
    const q = mff.marketLevel?.bidAskQuote?.[0];
    return {
      ...empty,
      ...base(mff.ltpc),
      oi: num(mff.oi),
      vtt: num(mff.vtt),
      atp: num(mff.atp),
      iv: num(mff.iv),
      greeks: mff.optionGreeks
        ? { delta: num(mff.optionGreeks.delta), theta: num(mff.optionGreeks.theta), gamma: num(mff.optionGreeks.gamma), vega: num(mff.optionGreeks.vega) }
        : null,
      bid: num(q?.bidP),
      ask: num(q?.askP),
      bidQty: num(q?.bidQ),
      askQty: num(q?.askQ),
      ohlc: pickDayOhlc(mff.marketOHLC?.ohlc),
    };
  }

  const iff = feed.fullFeed?.indexFF;
  if (iff) return { ...empty, ...base(iff.ltpc), ohlc: pickDayOhlc(iff.marketOHLC?.ohlc) };

  const flg = feed.firstLevelWithGreeks;
  if (flg) {
    return {
      ...empty,
      ...base(flg.ltpc),
      oi: num(flg.oi),
      vtt: num(flg.vtt),
      iv: num(flg.iv),
      greeks: flg.optionGreeks
        ? { delta: num(flg.optionGreeks.delta), theta: num(flg.optionGreeks.theta), gamma: num(flg.optionGreeks.gamma), vega: num(flg.optionGreeks.vega) }
        : null,
      bid: num(flg.firstDepth?.bidP),
      ask: num(flg.firstDepth?.askP),
      bidQty: num(flg.firstDepth?.bidQ),
      askQty: num(flg.firstDepth?.askQ),
    };
  }
  return null;
}

const g = globalThis as typeof globalThis & { __pulseFeed?: MarketFeedV3 };
export const marketFeed = g.__pulseFeed ?? new MarketFeedV3();
if (!g.__pulseFeed) g.__pulseFeed = marketFeed;
