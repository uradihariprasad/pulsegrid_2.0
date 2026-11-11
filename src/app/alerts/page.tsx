"use client";

/** Module 12 — Alerts (rule editor + state-transition history, dedupe-safe) */
import { useState } from "react";
import { useApi, useApp, fmt, istTime, type J } from "@/lib/client";
import { Panel, Badge, Loading, Empty } from "@/components/ui";
import { BellRing, Plus, Trash2 } from "lucide-react";

const EVENTS = [
  "SUPPORT_STRENGTHENING", "SUPPORT_WEAKENING", "RESISTANCE_STRENGTHENING", "RESISTANCE_WEAKENING",
  "BREAKOUT_WATCH", "BREAKDOWN_WATCH", "BREAKOUT_CONFIRMATION", "BREAKDOWN_CONFIRMATION",
  "FMPI_ACCELERATION", "FMPI_DIVERGENCE", "FUTURES_LONG_BUILDUP", "FUTURES_SHORT_BUILDUP",
  "VOLUME_BREAKOUT", "VWAP_RECLAIM", "VWAP_REJECTION",
];

const sevTone: Record<string, "green" | "amber" | "red"> = { INFO: "green", WARN: "amber", CRITICAL: "red" };

export default function AlertsPage() {
  const { data, refresh } = useApi<{ history: J[]; rules: J[]; dbReady: boolean }>("/api/alerts", 6000);
  const { openWorkspace, lastAlert } = useApp();
  const [name, setName] = useState("");
  const [event, setEvent] = useState(EVENTS[0]);
  const [sym, setSym] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    await fetch("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, event, symbol: sym || undefined }),
    });
    setBusy(false);
    setName("");
    refresh();
  };

  const toggle = async (id: number, enabled: boolean) => {
    await fetch("/api/alerts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, enabled }) });
    refresh();
  };

  const remove = async (id: number) => {
    await fetch(`/api/alerts?id=${id}`, { method: "DELETE" });
    refresh();
  };

  if (!data) return <Loading label="Loading alerts" />;

  return (
    <div className="space-y-2.5">
      {lastAlert && (
        <Panel pad className="border-amber/30">
          <div className="flex items-center gap-2 text-[11px]">
            <BellRing className="h-3.5 w-3.5 text-amber" />
            <b>{lastAlert.symbol}</b>
            <span>{String(lastAlert.event).replaceAll("_", " ")}</span>
            <span className="tnum text-txt-dim">@ {fmt(lastAlert.price)}</span>
            <span className="text-grey">live via stream</span>
          </div>
        </Panel>
      )}
      <div className="grid gap-2.5 lg:grid-cols-3">
        <Panel title="New alert rule" sub="fires on state transitions — never every polling cycle">
          <div className="space-y-2">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rule name — e.g. NIFTY breakout risk"
              className="h-8 w-full rounded-md border border-border bg-panel2 px-2.5 text-[11.5px] outline-none placeholder:text-grey/60 focus:border-blue/60" />
            <select value={event} onChange={(e) => setEvent(e.target.value)} className="h-8 w-full rounded-md border border-border bg-panel2 px-2 text-[11.5px] outline-none focus:border-blue/60">
              {EVENTS.map((e) => <option key={e}>{e}</option>)}
            </select>
            <input value={sym} onChange={(e) => setSym(e.target.value.toUpperCase())} placeholder="Symbol (blank = whole universe)"
              className="h-8 w-full rounded-md border border-border bg-panel2 px-2.5 text-[11.5px] outline-none placeholder:text-grey/60 focus:border-blue/60" />
            <button onClick={create} disabled={busy || !name.trim()} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-blue/90 text-[11.5px] font-semibold text-bg hover:bg-blue disabled:opacity-40">
              <Plus className="h-3.5 w-3.5" /> Create rule
            </button>
          </div>
          <div className="mt-3 space-y-1.5">
            {(data.rules ?? []).map((r) => (
              <div key={r.id} className="pg-panel-2 flex items-center justify-between p-2">
                <div>
                  <div className="text-[11px] font-semibold">{r.name}</div>
                  <div className="text-[9px] text-grey">{r.event.replaceAll("_", " ")} {r.symbol ? `· ${r.symbol}` : "· universe"}</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => toggle(r.id, !r.enabled)} className={`h-4.5 w-8 rounded-full p-0.5 transition-colors ${r.enabled ? "bg-green/70" : "bg-grey/40"}`}>
                    <span className={`block h-3.5 w-3.5 rounded-full bg-white transition-transform ${r.enabled ? "translate-x-3.5" : ""}`} />
                  </button>
                  <button onClick={() => remove(r.id)} className="p-1 text-grey hover:text-red"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
            {data.rules?.length === 0 && <p className="text-[10px] text-grey">No custom rules yet. Engine-level transitions (structure, FMPI, futures, VWAP) always emit regardless.</p>}
            {!data.dbReady && <p className="text-[10px] text-amber">Database unreachable — rules persist once PostgreSQL is connected.</p>}
          </div>
        </Panel>

        <Panel title="Alert history" sub="state-transition driven · dedupe-keyed" pad={false} className="lg:col-span-2">
          <div className="max-h-[560px] overflow-x-auto overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-panel">
                <tr>{["Time", "Symbol", "Event", "Price", "Severity", "Evidence"].map((h) => <th key={h} className="pg-th">{h}</th>)}</tr>
              </thead>
              <tbody>
                {(data.history ?? []).map((a) => (
                  <tr key={a.id} onClick={() => openWorkspace(a.symbol)} className="pg-row-hover cursor-pointer">
                    <td className="pg-td text-txt-dim">{istTime(new Date(a.ts).getTime())}</td>
                    <td className="pg-td font-bold">{a.symbol}</td>
                    <td className="pg-td font-semibold">{a.event.replaceAll("_", " ")}</td>
                    <td className="pg-td tnum">{fmt(a.price)}</td>
                    <td className="pg-td"><Badge tone={sevTone[a.severity] ?? "green"}>{a.severity}</Badge></td>
                    <td className="pg-td max-w-[260px] truncate text-[9.5px] text-grey">{JSON.stringify(a.evidence).slice(0, 90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.history?.length === 0 && <Empty label="No alerts fired yet — transitions are emitted as states change" />}
          </div>
        </Panel>
      </div>
    </div>
  );
}
