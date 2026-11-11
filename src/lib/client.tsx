"use client";

/**
 * PULSEGRID 2.0 — frontend data layer.
 * The UI only renders typed API/SSE responses; it never computes
 * authoritative trading intelligence.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type J = Record<string, any>;

export interface QuoteCell {
  ltp: number;
  chgPct: number;
  volume: number;
  freshness: string;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  vwap: number;
}
export type QuotesMap = Record<string, QuoteCell>;

export function useApi<T = J>(path: string | null, refreshMs = 0): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    setLoading(true);
    const load = async () => {
      try {
        const res = await fetch(path, { cache: "no-store" });
        if (!res.ok) throw new Error(`${res.status}`);
        const j = (await res.json()) as T;
        if (alive) {
          setData(j);
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };
    void load();
    if (refreshMs > 0) timer = setInterval(() => void load(), refreshMs);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [path, refreshMs, nonce]);

  const refresh = () => setNonce((n) => n + 1);
  return { data, error, loading, refresh };
}

/* ---------------------------------------------------------------- SSE --- */
export function usePulseStream() {
  const [quotes, setQuotes] = useState<QuotesMap>({});
  const [meta, setMeta] = useState<{ provider: string; marketPhase: string; ts: number }>({ provider: "…", marketPhase: "…", ts: 0 });
  const [connected, setConnected] = useState(false);
  const [lastAlert, setLastAlert] = useState<J | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      if (closed) return;
      const es = new EventSource("/api/stream");
      esRef.current = es;
      es.addEventListener("hello", () => setConnected(true));
      es.addEventListener("quotes", (ev) => {
        try {
          const p = JSON.parse((ev as MessageEvent).data);
          setQuotes(p.quotes ?? {});
          setMeta({ provider: p.provider, marketPhase: p.marketPhase, ts: p.ts });
        } catch {
          /* ignore malformed frame */
        }
      });
      es.addEventListener("alert", (ev) => {
        try {
          setLastAlert(JSON.parse((ev as MessageEvent).data));
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("ping", () => setConnected(true));
      es.onerror = () => {
        setConnected(false);
        es.close();
        retry = setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      esRef.current?.close();
    };
  }, []);

  return { quotes, meta, connected, lastAlert };
}

/* ------------------------------------------------------------ viewport -- */
/** Reactive breakpoint helper so charts/tables size correctly on phones. */
export function useBreakpoint(): { isMobile: boolean; isTablet: boolean; width: number } {
  const [w, setW] = useState(1440);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    f();
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return { isMobile: w < 640, isTablet: w >= 640 && w < 1024, width: w };
}

/* --------------------------------------------------------------- context - */
export interface AppState {
  /** true once live market data is actually flowing */
  dataLive: boolean;
  reloadTick: number;
  symbol: string;
  setSymbol: (s: string) => void;
  tf: string;
  setTf: (t: string) => void;
  expiry: string | null;
  setExpiry: (e: string | null) => void;
  workspaceSymbol: string | null;
  openWorkspace: (s: string) => void;
  closeWorkspace: () => void;
  quotes: QuotesMap;
  provider: string;
  marketPhase: string;
  streamConnected: boolean;
  lastAlert: J | null;
}

const AppCtx = createContext<AppState | null>(null);

export function PulseProvider({ children }: { children: ReactNode }) {
  const [symbol, setSymbol] = useState("NIFTY");
  const [tf, setTf] = useState("5m");
  const [expiry, setExpiry] = useState<string | null>(null);
  const [workspaceSymbol, setWorkspaceSymbol] = useState<string | null>(null);
  const { quotes, meta, connected, lastAlert } = usePulseStream();
  const [dataLive, setDataLive] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const prevLive = useRef(false);

  // When the feed transitions from empty → data, bump once and hard-reload so
  // every module's initial "no data" state is replaced without a manual F5.
  useEffect(() => {
    const hasData = Object.keys(quotes).length > 0;
    setDataLive(hasData);
    if (hasData && !prevLive.current) {
      prevLive.current = true;
      const t = setTimeout(() => {
        setReloadTick((n) => n + 1);
        window.location.reload();
      }, 900);
      return () => clearTimeout(t);
    }
  }, [quotes]);

  const value = useMemo<AppState>(
    () => ({
      dataLive,
      reloadTick,
      symbol,
      setSymbol,
      tf,
      setTf,
      expiry,
      setExpiry,
      workspaceSymbol,
      openWorkspace: setWorkspaceSymbol,
      closeWorkspace: () => setWorkspaceSymbol(null),
      quotes,
      provider: meta.provider,
      marketPhase: meta.marketPhase,
      streamConnected: connected,
      lastAlert,
    }),
    [dataLive, reloadTick, symbol, tf, expiry, workspaceSymbol, quotes, meta, connected, lastAlert],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

/* ------------------------------------------------------------- formatters */
export const fmt = (n: number | null | undefined, dp = 2): string =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: dp, minimumFractionDigits: dp });

export const fmtPct = (n: number | null | undefined): string =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

export const fmtInt = (n: number | null | undefined): string => {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
};

export const fmtChg = (n: number | null | undefined): string => {
  if (n == null) return "N/A";
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${fmtInt(Math.abs(n))}`;
};

export function istTime(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

export function clsColor(v: number | null | undefined): string {
  if (v == null) return "text-grey";
  return v > 0 ? "text-green" : v < 0 ? "text-red" : "text-txt-dim";
}

export const freshnessColor: Record<string, string> = {
  LIVE: "text-green",
  DELAYED: "text-amber",
  HISTORICAL: "text-grey",
  STALE: "text-amber",
  UNAVAILABLE: "text-red",
};
