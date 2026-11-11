"use client";

/** Module 11 — FMPI Momentum (component decomposition + history + universe) */
import { useState } from "react";
import { useApi, useApp, useBreakpoint, fmt, clsColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, SymbolPicker, Meter, EvidenceBars, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { Sparkline, FMPIGauge } from "@/components/charts";
import { Gauge } from "lucide-react";

const COMPONENT_LABELS: Record<string, string> = {
  underlying: "Underlying momentum",
  options: "Options premium",
  futures: "Futures",
  oiFlow: "OI flow",
  volume: "Volume / RVOL",
  structure: "Market structure",
  trend: "VWAP · EMA",
};

export default function FmpiPage() {
  const { symbol, openWorkspace } = useApp();
  const [tf, setTf] = useState("5m");
  const { data: f } = useApi<J>(`/api/intel/fmpi?symbol=${symbol}&tf=${tf}`, 5000);
  const { data: series } = useApi<J>(`/api/intel/fmpi-series?symbol=${symbol}&tf=${tf}`, 10000);
  const { data: ov } = useApi<J>("/api/intel/overview", 6000);
  const { isMobile, width } = useBreakpoint();

  if (!f) return <Loading label="Computing FMPI" />;
  if (isUnavailable(f))
    return (
      <div className="space-y-2.5">
        <Panel pad><SymbolPicker /></Panel>
        <Panel title="FMPI Momentum"><NoData reason={f.reason} code={f.code} /></Panel>
      </div>
    );
  const seriesOk = series && !isUnavailable(series) ? series : null;
  const ovOk = ov && !isUnavailable(ov) ? ov : null;

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-3">
          <SymbolPicker />
          <div className="flex gap-0.5 rounded-md border border-border bg-panel2 p-0.5">
            {["5m", "10m", "15m"].map((t) => (
              <button key={t} onClick={() => setTf(t)} className={`rounded px-2 py-0.5 text-[10px] font-semibold ${tf === t ? "bg-blue/15 text-blue" : "text-txt-dim"}`}>{t}</button>
            ))}
          </div>
          <span className="text-[10px] text-grey">missing components reduce coverage — they never become zero evidence</span>
          <span className="ml-auto"><FreshnessDot f="LIVE" /></span>
        </div>
      </Panel>

      <div className="grid gap-2.5 lg:grid-cols-3">
        <Panel title={<span className="flex items-center gap-1.5"><Gauge className="h-3 w-3 text-blue" />FMPI {tf}</span>}>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className={`tnum text-3xl font-bold ${clsColor(f.value)}`}>{f.value}</span>
              <ClassChip v={f.classification} />
            </div>
            <FMPIGauge value={f.value} />
            <div className="flex justify-between text-[9px] text-grey"><span>−100</span><span>adaptive bands ±{f.thresholds?.moderate} / ±{f.thresholds?.strong}</span><span>+100</span></div>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={f.acceleration === "ACCELERATING" ? "green" : f.acceleration === "DECELERATING" ? "amber" : "grey"}>{f.acceleration}</Badge>
              {f.exhaustionCandidate && <Badge tone="amber">MOMENTUM EXHAUSTION CANDIDATE</Badge>}
              {f.divergence !== "NONE" && <Badge tone="amber">{f.divergence.replaceAll("_", " ")}</Badge>}
            </div>
            <div>
              <div className="flex justify-between text-[9.5px] text-txt-dim"><span>Evidence coverage</span><EvidenceBars coverage={f.coverage} /></div>
              <Meter value={(f.coverage ?? 0) * 100} />
            </div>
            {f.confirmationRequired?.length > 0 && (
              <div className="rounded border border-amber/20 bg-amber/5 p-1.5 text-[9.5px] text-amber/90">
                {f.confirmationRequired.map((c: string) => <div key={c}>• {c}</div>)}
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Component contribution" sub="signed points per family (correlation-capped)">
          <div className="space-y-1.5">
            {Object.entries(f.components ?? {}).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-[10.5px]">
                <span className="w-20 shrink-0 truncate text-txt-dim sm:w-28">{COMPONENT_LABELS[k] ?? k}</span>
                <div className="relative h-1.5 flex-1 rounded-full bg-panel2">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                  <div className={`absolute inset-y-0 rounded-full ${(v as number) >= 0 ? "bg-green" : "bg-red"}`}
                    style={{ left: (v as number) >= 0 ? "50%" : `${50 - Number(v)}%`, width: `${Math.min(Math.abs(Number(v)), 50)}%` }} />
                </div>
                <span className={`tnum w-10 text-right ${clsColor(Number(v))}`}>{Number(v).toFixed(1)}</span>
              </div>
            ))}
            {Object.entries(f.rawComponents ?? {})
              .filter(([, v]) => v == null)
              .map(([k]) => (
                <div key={k} className="flex items-center gap-2 text-[10.5px]">
                  <span className="w-20 shrink-0 truncate text-grey/60 sm:w-28">{COMPONENT_LABELS[k] ?? k}</span>
                  <span className="text-[9.5px] text-amber">UNAVAILABLE — excluded, coverage reduced</span>
                </div>
              ))}
          </div>
        </Panel>

        <Panel title={`FMPI history — ${symbol} ${tf}`} sub="one instrument, one timeframe: no cross-symbol leakage">
          {seriesOk?.points?.length ? (
            <Sparkline points={seriesOk.points.map((p: J) => p.value)} width={Math.min(width - 72, 340)} height={isMobile ? 90 : 120} color={f.value >= 0 ? "#16c784" : "#ea3943"} />
          ) : (
            <span className="text-[11px] text-grey">{seriesOk?.note ?? "Building history from live observations…"}</span>
          )}
          <div className="mt-1 flex justify-between text-[9px] text-grey"><span>−100</span><span>0</span><span>+100</span></div>
        </Panel>
      </div>

      <Panel title="FMPI universe (5m)" sub="sorted by absolute pressure" pad={false}>
        <div className="grid gap-0 md:grid-cols-2">
          {(ovOk?.strongFmpi ?? []).map((r: J) => (
            <button key={r.symbol} onClick={() => openWorkspace(r.symbol)} className="flex items-center justify-between border-b border-border/60 px-3 py-1.5 text-left hover:bg-panel2">
              <span className="text-[11.5px] font-semibold">{r.symbol}</span>
              <span className="flex items-center gap-2">
                <span className={`tnum text-[11.5px] font-bold ${clsColor(r.fmpi)}`}>{r.fmpi?.toFixed(1)}</span>
                <ClassChip v={r.classification} />
              </span>
            </button>
          ))}
        </div>
      </Panel>
      <p className="text-[9.5px] text-grey">
        FMPI is a proprietary composite (underlying · options premia · futures · OI flow · volume · structure · VWAP/EMA), normalized against the instrument’s own volatility.
        It is not RSI; there are no fixed overbought/oversold thresholds and a score is never a probability.
      </p>
    </div>
  );
}
