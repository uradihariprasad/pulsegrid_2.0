"use client";

/** Module 9 — Market Structure + Volume Profile */
import { useApi, useApp, fmt, istTime, clsColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, SymbolPicker, NoData, isUnavailable } from "@/components/ui";
import { useState } from "react";

const EVENT_TONE: Record<string, string> = {
  HH: "text-green", HL: "text-green", BOS_UP: "text-green", CHOCH_UP: "text-green", BREAKOUT: "text-green", RETEST: "text-blue",
  LH: "text-red", LL: "text-red", BOS_DOWN: "text-red", CHOCH_DOWN: "text-red", BREAKDOWN: "text-red",
  FAILED_BREAKOUT: "text-amber", FAILED_BREAKDOWN: "text-amber",
};

export default function MarketStructurePage() {
  const { symbol } = useApp();
  const [tf, setTf] = useState("5m");
  const { data: st } = useApi<J>(`/api/intel/structure?symbol=${symbol}&tf=${tf}`, 8000);
  const { data: vp } = useApi<J>(`/api/intel/volume-profile?symbol=${symbol}`, 10000);

  if (!st) return <Loading label="Analysing structure" />;
  if (isUnavailable(st))
    return (
      <div className="space-y-2.5">
        <Panel pad><SymbolPicker /></Panel>
        <Panel title="Market Structure"><NoData reason={st.reason} code={st.code} /></Panel>
      </div>
    );
  const vpOk = vp && !isUnavailable(vp) ? vp : null;

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-3">
          <SymbolPicker />
          <div className="flex gap-0.5 rounded-md border border-border bg-panel2 p-0.5">
            {["3m", "5m", "15m", "30m"].map((t) => (
              <button key={t} onClick={() => setTf(t)} className={`rounded px-2 py-0.5 text-[10px] font-semibold ${tf === t ? "bg-blue/15 text-blue" : "text-txt-dim"}`}>{t}</button>
            ))}
          </div>
          <span className="pg-chip">Trend <ClassChip v={st.trend} /></span>
          {st.consolidating && <Badge tone="amber">CONSOLIDATION {fmt(st.rangeLow)}–{fmt(st.rangeHigh)}</Badge>}
          {st.countertrend && <Badge tone="amber">{st.countertrend}</Badge>}
        </div>
      </Panel>

      <div className="grid gap-2.5 lg:grid-cols-3">
        <Panel title="Swing points & structure events" sub="Confirmed pivots only — history never repaints" pad={false} className="lg:col-span-2">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>{["Time (IST)", "Event", "Price", "Reading"].map((h) => <th key={h} className="pg-th">{h}</th>)}</tr>
              </thead>
              <tbody>
                {(st.events ?? []).slice().reverse().map((e: J, i: number) => (
                  <tr key={i} className="pg-row-hover">
                    <td className="pg-td text-txt-dim">{istTime(e.ts)}</td>
                    <td className={`pg-td font-bold ${EVENT_TONE[e.kind] ?? "text-txt"}`}>{e.kind.replaceAll("_", " ")}</td>
                    <td className="pg-td tnum">{fmt(e.price)}</td>
                    <td className="pg-td text-[10px] text-txt-dim">
                      {e.kind === "HH" ? "higher high — structure strengthening" :
                       e.kind === "HL" ? "higher low — buyers defending" :
                       e.kind === "LH" ? "lower high — supply above" :
                       e.kind === "LL" ? "lower low — sellers pressing" :
                       e.kind === "BOS_UP" ? "break of structure up — continuation evidence" :
                       e.kind === "BOS_DOWN" ? "break of structure down — continuation evidence" :
                       e.kind === "CHOCH_UP" ? "change of character up — potential reversal" :
                       e.kind === "CHOCH_DOWN" ? "change of character down — potential reversal" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="space-y-2.5">
          <Panel title="Multi-timeframe structure">
            <div className="space-y-1.5">
              {Object.entries(st.multiTimeframe ?? {}).map(([t, v]) => (
                <div key={t} className="flex items-center justify-between text-[11px]">
                  <span className="tnum text-txt-dim">{t}</span>
                  <ClassChip v={v as string} />
                  <span className={`text-[9.5px] ${v === st.trend ? "text-green" : v === "RANGE" ? "text-grey" : "text-amber"}`}>
                    {v === st.trend ? "aligned" : v === "RANGE" ? "ranging" : "conflict"}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[9px] leading-snug text-grey">Short-term momentum against higher-timeframe structure is labelled countertrend.</p>
          </Panel>

          <Panel title="Liquidity pools">
            <div className="space-y-1 text-[11px]">
              <div className="text-[9.5px] uppercase text-grey">Equal highs (buy-side)</div>
              {(st.equalHighs ?? []).map((v: number) => <div key={`h${v}`} className="tnum">{fmt(v)}</div>)}
              {(st.equalHighs ?? []).length === 0 && <div className="text-grey">none</div>}
              <div className="pt-1 text-[9.5px] uppercase text-grey">Equal lows (sell-side)</div>
              {(st.equalLows ?? []).map((v: number) => <div key={`l${v}`} className="tnum">{fmt(v)}</div>)}
              {(st.equalLows ?? []).length === 0 && <div className="text-grey">none</div>}
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="Volume profile — session" sub={vpOk ? "Approximation from real Upstox candle volume distributed across each bar\u2019s range (disclosed)" : undefined} pad={false}>
        {vpOk ? (
          <div className="flex flex-col gap-3 p-3 lg:flex-row">
            <div className="min-w-0 flex-1">
              <div className="space-y-[1.5px]">
                {vpOk.bins.slice().reverse().map((b: J, i: number) => {
                  const w = Math.max(2, (b.vol / Math.max(...vpOk.bins.map((x: J) => x.vol))) * 100);
                  const nearPoc = Math.abs(b.price - vpOk.poc) < (vpOk.vah - vpOk.val) / 40;
                  const inVA = b.price >= vpOk.val && b.price <= vpOk.vah;
                  return (
                    <div key={i} className="flex items-center gap-1.5">
                      <span className={`tnum w-12 shrink-0 text-right text-[9px] sm:w-16 ${nearPoc ? "font-bold text-blue" : "text-grey"}`}>{fmt(b.price)}</span>
                      <div className={`h-2 rounded-sm ${nearPoc ? "bg-blue" : inVA ? "bg-blue/30" : "bg-panel2 border border-border"}`} style={{ width: `${w}%` }} />
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="grid w-full shrink-0 grid-cols-3 content-start gap-2 lg:w-[300px]">
              {[
                ["POC", vpOk.poc, "text-blue"],
                ["VAH", vpOk.vah, "text-red"],
                ["VAL", vpOk.val, "text-green"],
              ].map(([l, v, c]) => (
                <div key={l as string} className="pg-panel-2 p-2 text-center">
                  <div className="text-[9px] uppercase text-grey">{l}</div>
                  <div className={`tnum text-[13px] font-bold ${c}`}>{fmt(v as number)}</div>
                </div>
              ))}
              <div className="col-span-3 space-y-1 text-[10px] text-txt-dim">
                <div>HVN: {vpOk.hvn.slice(0, 4).map((v: number) => fmt(v, 0)).join(" · ") || "—"}</div>
                <div>LVN: {vpOk.lvn.slice(0, 4).map((v: number) => fmt(v, 0)).join(" · ") || "—"}</div>
                <p className="pt-1 text-[9px] text-grey">POC = acceptance area, not guaranteed S/R. VAH/VAL = value boundaries — require price reaction + confluence before acting as levels.</p>
              </div>
            </div>
          </div>
        ) : (
          <NoData reason={vp && isUnavailable(vp) ? vp.reason : "Profile building from live candles…"} code={vp && isUnavailable(vp) ? vp.code : "LOADING"} />
        )}
      </Panel>
    </div>
  );
}
