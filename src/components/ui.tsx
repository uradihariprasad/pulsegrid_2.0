"use client";

import type { ReactNode } from "react";
import { clsColor, freshnessColor, fmtPct, type J } from "@/lib/client";
import { useApp } from "@/lib/client";

export function Panel({
  title,
  sub,
  right,
  children,
  className = "",
  pad = true,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={`pg-panel ${className}`}>
      {title != null && (
        <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border px-2.5 py-2 sm:px-3">
          <div className="min-w-0">
            <h3 className="truncate text-[11px] font-semibold uppercase tracking-wider text-txt-dim">{title}</h3>
            {sub != null && <p className="mt-0.5 text-[10px] text-grey">{sub}</p>}
          </div>
          {right != null && <div className="flex shrink-0 items-center gap-1.5">{right}</div>}
        </header>
      )}
      <div className={pad ? "p-2.5 sm:p-3" : ""}>{children}</div>
    </section>
  );
}

export function Badge({ tone = "grey", children }: { tone?: "green" | "red" | "amber" | "blue" | "grey"; children: ReactNode }) {
  const map: Record<string, string> = {
    green: "bg-green/10 text-green border-green/25",
    red: "bg-red/10 text-red border-red/25",
    amber: "bg-amber/10 text-amber border-amber/25",
    blue: "bg-blue/10 text-blue border-blue/25",
    grey: "bg-grey/10 text-txt-dim border-grey/25",
  };
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[10px] font-semibold ${map[tone]}`}>{children}</span>;
}

export function DirCell({ v, suffix = "" }: { v: number | null | undefined; suffix?: string }) {
  if (v == null) return <span className="text-grey">N/A</span>;
  return (
    <span className={clsColor(v)}>
      {v > 0 ? "+" : ""}
      {v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
      {suffix}
    </span>
  );
}

export function PctCell({ v }: { v: number | null | undefined }) {
  return <span className={clsColor(v)}>{fmtPct(v)}</span>;
}

export function FreshnessDot({ f, label = true }: { f?: string; label?: boolean }) {
  if (!f) return null;
  const dot = f === "LIVE" ? "bg-green" : f === "DELAYED" ? "bg-amber" : f === "UNAVAILABLE" ? "bg-red" : "bg-grey";
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${freshnessColor[f] ?? "text-grey"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot} ${f === "LIVE" ? "pg-pulse" : ""}`} />
      {label ? f : null}
    </span>
  );
}

export function Loading({ label = "Computing" }: { label?: string }) {
  return (
    <div className="flex h-28 items-center justify-center gap-2 text-[11px] text-txt-dim">
      <span className="h-1.5 w-1.5 animate-ping rounded-full bg-blue" />
      {label}…
    </div>
  );
}

export function Empty({ label = "No records" }: { label?: string }) {
  return <div className="flex h-24 items-center justify-center text-[11px] text-grey">{label}</div>;
}

export function ErrorState({ label }: { label: string }) {
  return (
    <div className="flex h-24 flex-col items-center justify-center gap-1 text-[11px] text-amber">
      <span>Backend resource unavailable</span>
      <span className="text-[10px] text-grey">{label}</span>
    </div>
  );
}

export function Meter({ value, min = 0, max = 100 }: { value: number; min?: number; max?: number }) {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min))) * 100;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-panel2">
      <div className="h-full rounded-full bg-blue/80 transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ScoreBar({ value }: { value: number }) {
  const v = Math.max(-100, Math.min(100, value));
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-panel2">
      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <div
        className={`absolute inset-y-0 rounded-full ${v >= 0 ? "bg-green" : "bg-red"}`}
        style={{ left: v >= 0 ? "50%" : `${50 - Math.abs(v) / 2}%`, width: `${Math.abs(v) / 2}%` }}
      />
    </div>
  );
}

/** Symbol picker used across modules — keeps the whole app on one selection. */
export function SymbolPicker({ compact = false }: { compact?: boolean }) {
  const { symbol, setSymbol, quotes } = useApp();
  const q = quotes[symbol];
  return (
    <div className={`flex items-center gap-2 ${compact ? "" : "min-w-0"}`}>
      <select
        value={symbol}
        onChange={(e) => setSymbol(e.target.value)}
        className="h-7 rounded-md border border-border bg-panel2 px-2 text-[11.5px] font-semibold text-txt outline-none focus:border-blue/60"
      >
        {Object.keys(quotes).length === 0 ? (
          <option value={symbol}>{symbol}</option>
        ) : (
          Object.keys(quotes)
            .sort()
            .map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))
        )}
      </select>
      {q && (
        <div className="flex items-baseline gap-1.5">
          <span className="text-[12.5px] font-semibold tnum">{fmt(q.ltp)}</span>
          <span className={`text-[10.5px] tnum ${clsColor(q.chgPct)}`}>{fmtPct(q.chgPct)}</span>
        </div>
      )}
    </div>
  );
}

function fmt(n: number, dp = 2) {
  return n.toLocaleString("en-IN", { maximumFractionDigits: dp, minimumFractionDigits: dp });
}

export function classTone(cls?: string | null): "green" | "red" | "amber" | "blue" | "grey" {
  if (!cls) return "grey";
  if (cls.includes("BULLISH") || cls.includes("LONG_BUILDUP") || cls.includes("SHORT_COVERING") || cls.includes("STRENGTHENING") || cls === "UP") return "green";
  if (cls.includes("BEARISH") || cls.includes("SHORT_BUILDUP") || cls.includes("LONG_UNWINDING") || cls.includes("WEAKENING") || cls === "DOWN") return "red";
  if (cls.includes("WATCH") || cls.includes("DIVERGENCE") || cls.includes("EXHAUSTION")) return "amber";
  if (cls === "RANGE" || cls === "NEUTRAL") return "grey";
  return "blue";
}

export function ClassChip({ v }: { v?: string | null }) {
  if (!v) return <span className="text-[10px] text-grey">—</span>;
  return <Badge tone={classTone(v)}>{v.replaceAll("_", " ")}</Badge>;
}

export function EvidenceBars({ coverage }: { coverage: number | null | undefined }) {
  const c = Math.round((coverage ?? 0) * 100);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1 w-10 overflow-hidden rounded-full bg-panel2">
        <span className={`block h-full rounded-full ${c >= 70 ? "bg-green" : c >= 45 ? "bg-amber" : "bg-red/70"}`} style={{ width: `${c}%` }} />
      </span>
      <span className="text-[10px] tnum text-txt-dim">{c}%</span>
    </span>
  );
}

export function tableFromRows(rows: J[], cols: { key: string; label: string; render?: (r: J) => ReactNode; align?: "l" | "r" }[]) {
  return { rows, cols };
}

/* ------------------------------------------------------------------ gate */
/**
 * Renders the backend's availability envelope. Nothing is ever invented to
 * fill a panel: if Upstox has not supplied the data we say exactly why.
 */
export function NoData({ reason, code, compact = false }: { reason?: string; code?: string; compact?: boolean }) {
  const needsToken = code === "NO_TOKEN" || code === "AUTH";
  const loading = code === "LOADING";
  return (
    <div className={`flex flex-col items-center justify-center gap-1.5 text-center ${compact ? "py-5" : "py-10"}`}>
      <span
        className={`flex h-7 w-7 items-center justify-center rounded-full border ${
          needsToken ? "border-blue/30 bg-blue/10 text-blue" : loading ? "border-border bg-panel2 text-txt-dim" : "border-amber/30 bg-amber/10 text-amber"
        }`}
      >
        {loading ? <span className="h-1.5 w-1.5 animate-ping rounded-full bg-blue" /> : needsToken ? "⚿" : "!"}
      </span>
      <span className={`text-[11px] font-semibold ${needsToken ? "text-blue" : loading ? "text-txt-dim" : "text-amber"}`}>
        {needsToken ? "Upstox token required" : loading ? "Loading live data" : "Data unavailable"}
      </span>
      <span className="max-w-[460px] px-3 text-[10px] leading-snug text-grey">{reason ?? "No data from the provider."}</span>
      {needsToken && <span className="text-[9.5px] text-grey">Use the token control at the top-left of the header.</span>}
      {code && <span className="font-mono text-[8.5px] text-grey/60">{code}</span>}
    </div>
  );
}

/** True when a payload is the unavailable envelope. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isUnavailable(d: any): d is { available: false; reason: string; code: string } {
  return !!d && d.available === false;
}

/** Shows "—" whenever the provider did not supply a value. */
export function V({ v, dp = 2, suffix = "" }: { v: number | null | undefined; dp?: number; suffix?: string }) {
  if (v == null || !Number.isFinite(v)) return <span className="text-grey">—</span>;
  return (
    <span>
      {v.toLocaleString("en-IN", { maximumFractionDigits: dp, minimumFractionDigits: dp })}
      {suffix}
    </span>
  );
}
