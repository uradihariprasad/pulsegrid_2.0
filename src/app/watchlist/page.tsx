"use client";

/** Module 13 — Watchlist (persisted across sessions) */
import { useState } from "react";
import { useApi, useApp, fmt, fmtPct, fmtChg, clsColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, Empty, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { Plus, Star, X } from "lucide-react";

export default function WatchlistPage() {
  const { data, refresh, loading } = useApi<J>("/api/watchlist", 5000);
  const { openWorkspace } = useApp();
  const [q, setQ] = useState("");
  const { data: search } = useApi<J>(q ? `/api/instruments?q=${encodeURIComponent(q)}` : null, 0);
  const [open, setOpen] = useState(false);

  const add = async (symbol: string) => {
    await fetch("/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol }) });
    setQ("");
    setOpen(false);
    refresh();
  };
  const remove = async (symbol: string) => {
    await fetch(`/api/watchlist?symbol=${symbol}`, { method: "DELETE" });
    refresh();
  };

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="relative flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[12px] font-semibold"><Star className="h-3.5 w-3.5 text-amber" />Watchlist</span>
          <div className="relative">
            <div className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-panel2 px-2">
              <Plus className="h-3 w-3 text-grey" />
              <input value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
                placeholder="add symbol…" className="w-40 bg-transparent text-[11px] outline-none placeholder:text-grey/60" />
            </div>
            {open && search?.results && (
              <div className="absolute left-0 top-8 z-40 w-64 rounded-lg border border-border bg-panel shadow-2xl">
                {(search.results ?? []).slice(0, 8).map((r: J) => (
                  <button key={r.symbol} onClick={() => add(r.symbol)} className="flex w-full items-center justify-between border-b border-border/50 px-2.5 py-1.5 text-left hover:bg-panel2">
                    <span className="text-[11px] font-semibold">{r.symbol}</span>
                    <span className="text-[9px] text-grey">{r.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="text-[9.5px] text-grey">persisted in PostgreSQL across sessions · live values from Upstox</span>
        </div>
      </Panel>

      <Panel pad={false}>
        {data && isUnavailable(data) ? (
          <NoData reason={data.reason} code={data.code} />
        ) : !data && loading ? (
          <Loading label="Loading watchlist" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>{["Symbol", "Kind", "LTP", "Chg %", "FMPI", "Fut ΔOI sess", "Futures", "Support", "Resistance", "Feed", ""].map((h) => <th key={h} className="pg-th text-right">{h}</th>)}</tr>
              </thead>
              <tbody>
                {(data?.items ?? []).map((it: J) => (
                  <tr key={it.symbol} className="pg-row-hover">
                    <td className="pg-td cursor-pointer font-bold text-txt" onClick={() => openWorkspace(it.symbol)}>{it.symbol}</td>
                    <td className="pg-td text-right"><Badge tone={it.kind === "INDEX" ? "blue" : "grey"}>{it.kind}</Badge></td>
                    <td className="pg-td text-right tnum">{fmt(it.ltp)}</td>
                    <td className={`pg-td text-right tnum ${clsColor(it.chgPct)}`}>{fmtPct(it.chgPct)}</td>
                    <td className="pg-td text-right"><ClassChip v={it.fmpiClass} /></td>
                    <td className={`pg-td text-right tnum ${clsColor(it.futOiSess)}`}>{fmtChg(it.futOiSess)}</td>
                    <td className="pg-td text-right"><ClassChip v={it.futuresDir} /></td>
                    <td className="pg-td text-right tnum text-green">{fmt(it.support, it.support > 1000 ? 0 : 1)}</td>
                    <td className="pg-td text-right tnum text-red">{fmt(it.resistance, it.resistance > 1000 ? 0 : 1)}</td>
                    <td className="pg-td text-right"><FreshnessDot f={it.freshness} label={false} /></td>
                    <td className="pg-td text-right">
                      <button onClick={() => remove(it.symbol)} className="rounded p-1 text-grey hover:text-red"><X className="h-3 w-3" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data?.items?.length === 0 && <Empty label="Watchlist empty — add instruments above" />}
          </div>
        )}
      </Panel>
    </div>
  );
}
