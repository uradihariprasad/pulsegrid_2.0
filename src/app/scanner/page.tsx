"use client";

/** Module 3 — F&O Scanner (live category tables, sortable/filterable/paginated) */
import { useMemo, useState } from "react";
import { useApi, useApp, fmt, fmtInt, fmtPct, clsColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, Empty, EvidenceBars, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";

const CATEGORIES = [
  "STRONG_BULLISH", "BULLISH_MOMENTUM", "STRONG_BEARISH", "BEARISH_MOMENTUM",
  "VOLUME_BREAKOUT", "OI_BREAKOUT", "FUTURES_LONG_BUILDUP", "FUTURES_SHORT_BUILDUP",
  "LONG_UNWINDING", "SHORT_COVERING", "PRICE_OI_DIVERGENCE", "HIGH_RVOL", "MOMENTUM_REVERSAL_WATCH",
];

const PAGE_SIZE = 12;

export default function ScannerPage() {
  const { data } = useApi<J>("/api/scanner", 6000);
  const { openWorkspace, quotes } = useApp();
  const [cat, setCat] = useState<string>("STRONG_BULLISH");
  const [sortKey, setSortKey] = useState<string>("score");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    let r = (data && !isUnavailable(data) ? (data.rows ?? []) : []).filter((x: J) => x.category === cat);
    if (query) r = r.filter((x: J) => x.symbol.includes(query.toUpperCase()));
    r = [...r].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return (av > bv ? 1 : av < bv ? -1 : 0) * (sortDir === 1 ? 1 : -1);
    });
    return r;
  }, [data, cat, sortKey, sortDir, query]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data && !isUnavailable(data) ? (data.rows ?? []) : []) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    return m;
  }, [data]);

  if (!data) return <Loading label="Scanning universe" />;
  if (isUnavailable(data)) return <Panel title="F&O Scanner"><NoData reason={data.reason} code={data.code} /></Panel>;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const view = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const sortBtn = (k: string, label: string, right = true) => (
    <th
      onClick={() => {
        if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
        else setSortKey(k);
        setPage(0);
      }}
      className={`pg-th cursor-pointer select-none ${right ? "text-right" : ""}`}
    >
      <span className="inline-flex items-center gap-0.5">
        {label} <ArrowUpDown className={`h-2.5 w-2.5 ${sortKey === k ? "text-blue" : "text-grey/40"}`} />
      </span>
    </th>
  );

  return (
    <div className="space-y-2.5">
      <Panel pad={false}>
        <div className="flex gap-1 overflow-x-auto p-2">
          {CATEGORIES.map((c) => {
            const n = counts.get(c) ?? 0;
            const active = c === cat;
            return (
              <button
                key={c}
                onClick={() => {
                  setCat(c);
                  setPage(0);
                }}
                className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors ${
                  active ? "border-blue/50 bg-blue/10 text-blue" : "border-border bg-panel2 text-txt-dim hover:text-txt"
                }`}
              >
                {c.replaceAll("_", " ")} <span className="tnum text-grey">{n}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel
        title={cat.replaceAll("_", " ")}
        right={
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="filter symbol…"
            className="h-6 w-36 rounded border border-border bg-panel2 px-2 text-[10.5px] outline-none placeholder:text-grey/60 focus:border-blue/50"
          />
        }
        pad={false}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {sortBtn("symbol", "Symbol", false)}
                {sortBtn("ltp", "LTP")}
                {sortBtn("chgPct", "Chg %")}
                {sortBtn("volume", "Volume")}
                {sortBtn("rvol", "RVOL")}
                {sortBtn("oiChgPct", "Fut ΔOI %")}
                <th className="pg-th">Futures</th>
                <th className="pg-th">VWAP</th>
                {sortBtn("emaAlign", "EMA")}
                <th className="pg-th">Structure</th>
                {sortBtn("fmpi", "FMPI")}
                {sortBtn("coverage", "Evid.")}
                <th className="pg-th">Feed</th>
                {sortBtn("score", "Score")}
              </tr>
            </thead>
            <tbody>
              {view.map((r: J) => (
                <tr key={`${r.category}-${r.symbol}`} onClick={() => openWorkspace(r.symbol)} className="pg-row-hover cursor-pointer">
                  <td className="pg-td font-bold text-txt">{r.symbol}</td>
                  <td className="pg-td text-right tnum">{fmt(quotes[r.symbol]?.ltp ?? r.ltp)}</td>
                  <td className={`pg-td text-right tnum ${clsColor(quotes[r.symbol]?.chgPct ?? r.chgPct)}`}>{fmtPct(quotes[r.symbol]?.chgPct ?? r.chgPct)}</td>
                  <td className="pg-td text-right text-txt-dim">{fmtInt(quotes[r.symbol]?.volume ?? r.volume)}</td>
                  <td className="pg-td text-right"><span className={r.rvol != null && r.rvol >= 1.8 ? "text-amber font-semibold" : "text-txt-dim"}>{r.rvol?.toFixed(1) ?? "—"}</span></td>
                  <td className={`pg-td text-right tnum ${clsColor(r.oiChgPct)}`}>{r.oiChgPct == null ? "N/A" : fmtPct(r.oiChgPct)}</td>
                  <td className="pg-td"><ClassChip v={r.futuresDir} /></td>
                  <td className="pg-td"><span className={r.vwapSide === "ABOVE" ? "text-green" : r.vwapSide === "BELOW" ? "text-red" : "text-grey"}>{r.vwapSide}</span></td>
                  <td className="pg-td text-right tnum">{r.emaAlign == null ? "—" : r.emaAlign > 0 ? "▲" : r.emaAlign < 0 ? "▼" : "·"}</td>
                  <td className="pg-td"><ClassChip v={r.structure} /></td>
                  <td className={`pg-td text-right tnum font-semibold ${clsColor(r.fmpi)}`}>{r.fmpi?.toFixed(0) ?? "—"}</td>
                  <td className="pg-td"><EvidenceBars coverage={r.coverage} /></td>
                  <td className="pg-td"><FreshnessDot f={quotes[r.symbol]?.freshness ?? r.freshness} label={false} /></td>
                  <td className="pg-td text-right tnum font-bold text-blue">{r.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.length === 0 && <Empty label={`No instruments in ${cat.replaceAll("_", " ")} right now`} />}
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10px] text-txt-dim">
          <span>{rows.length} rows · click any row for the full workspace</span>
          <div className="flex items-center gap-2">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="rounded border border-border p-0.5 disabled:opacity-30"><ChevronLeft className="h-3 w-3" /></button>
            <span className="tnum">{page + 1}/{pages}</span>
            <button disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} className="rounded border border-border p-0.5 disabled:opacity-30"><ChevronRight className="h-3 w-3" /></button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
