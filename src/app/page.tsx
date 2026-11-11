"use client";

/** Module 1 — Market Overview */
import { useApi, useApp, fmt, fmtPct, fmtInt, clsColor, freshnessColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { Sparkline } from "@/components/charts";
import { TrendingUp, TrendingDown, Activity, Zap } from "lucide-react";

export default function MarketOverviewPage() {
  const { data } = useApi<J>("/api/intel/overview", 4000);
  const { quotes, openWorkspace } = useApp();

  if (!data) return <Loading label="Connecting to Upstox" />;
  if (isUnavailable(data)) return <Panel title="Market Overview"><NoData reason={data.reason} code={data.code} /></Panel>;
  const mini = (sym: string) => quotes[sym];

  const IndexCard = ({ idx }: { idx: J }) => {
    const live = mini(idx.symbol);
    const ltp = live?.ltp ?? idx.ltp;
    const chg = live?.chgPct ?? idx.chgPct;
    return (
      <button onClick={() => openWorkspace(idx.symbol)} className="pg-panel p-3 text-left transition-colors hover:border-blue/40">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-grey">{idx.symbol}</span>
          {live && <FreshnessDot f={live.freshness} label={false} />}
        </div>
        <div className="mt-1 tnum text-lg font-bold text-txt">{fmt(ltp)}</div>
        <div className={`tnum text-[11px] font-semibold ${clsColor(chg)}`}>{fmtPct(chg)}</div>
      </button>
    );
  };

  const RowTable = ({ rows, extra }: { rows: J[]; extra?: (r: J) => React.ReactNode }) => (
    <div className="overflow-x-auto">
    <table className="w-full">
      <thead>
        <tr>
          <th className="pg-th">Symbol</th>
          <th className="pg-th text-right">LTP</th>
          <th className="pg-th text-right">Chg%</th>
          {extra && <th className="pg-th text-right">Metric</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.symbol} onClick={() => openWorkspace(r.symbol)} className="pg-row-hover cursor-pointer">
            <td className="pg-td font-semibold text-txt">{r.symbol}</td>
            <td className="pg-td text-right text-txt-dim">{fmt(mini(r.symbol)?.ltp ?? r.ltp)}</td>
            <td className={`pg-td text-right ${clsColor(mini(r.symbol)?.chgPct ?? r.chgPct)}`}>{fmtPct(mini(r.symbol)?.chgPct ?? r.chgPct)}</td>
            {extra && <td className="pg-td text-right">{extra(r)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );

  return (
    <div className="space-y-2.5">
      {/* index strip */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {(data.indices ?? []).map((i: J) => <IndexCard key={i.symbol} idx={i} />)}
        <div className="pg-panel p-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-grey">Data Coverage</span>
            <Badge tone="blue">{data.coverage?.total ?? 0} F&amp;O</Badge>
          </div>
          <div className="mt-1 tnum text-lg font-bold text-txt">{data.coverage?.withFutures ?? 0}</div>
          <div className="text-[10px] text-txt-dim">with live futures · {data.coverage?.withCandles ?? 0} with candles</div>
        </div>
        <div className="pg-panel p-3">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-grey">Market Sentiment</span>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[13px] font-bold text-txt">{data.sentiment?.state ?? "—"}</span>
          </div>
          <div className="mt-0.5 text-[9.5px] text-grey">
            evidence: {data.sentiment?.families?.join(" · ")}
          </div>
          <div className="text-[9.5px] text-amber/80">{data.sentiment?.missing}</div>
        </div>
      </div>

      {/* breadth + futures positioning */}
      <div className="grid gap-2.5 lg:grid-cols-3">
        <Panel title="Market Breadth">
          <div className="flex h-8 overflow-hidden rounded-md border border-border">
            <div className="bg-green/80" style={{ width: `${(data.breadth.advances / Math.max(1, data.breadth.advances + data.breadth.declines + data.breadth.unchanged)) * 100}%` }} />
            <div className="bg-grey/40" style={{ width: `${(data.breadth.unchanged / Math.max(1, data.breadth.advances + data.breadth.declines + data.breadth.unchanged)) * 100}%` }} />
            <div className="bg-red/80" style={{ width: `${(data.breadth.declines / Math.max(1, data.breadth.advances + data.breadth.declines + data.breadth.unchanged)) * 100}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-[11px]">
            <span className="text-green tnum font-semibold">▲ {data.breadth.advances} advancing</span>
            <span className="text-txt-dim tnum">{data.breadth.unchanged} flat</span>
            <span className="text-red tnum font-semibold">{data.breadth.declines} declining ▼</span>
          </div>
        </Panel>
        <Panel title="Futures Positioning">
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="pg-panel-2 p-2"><div className="text-[9px] uppercase text-grey">Long buildup</div><div className="tnum text-[15px] font-bold text-green">{data.futuresPositioning?.long ?? 0}</div></div>
            <div className="pg-panel-2 p-2"><div className="text-[9px] uppercase text-grey">Short buildup</div><div className="tnum text-[15px] font-bold text-red">{data.futuresPositioning?.short ?? 0}</div></div>
            <div className="pg-panel-2 p-2"><div className="text-[9px] uppercase text-grey">Short covering</div><div className="tnum text-[15px] font-bold text-green/80">{data.futuresPositioning?.sc ?? 0}</div></div>
            <div className="pg-panel-2 p-2"><div className="text-[9px] uppercase text-grey">Long unwinding</div><div className="tnum text-[15px] font-bold text-red/80">{data.futuresPositioning?.lu ?? 0}</div></div>
          </div>
        </Panel>
        <Panel title="Sector Performance" sub="requires an index-constituent map Upstox does not expose">
          <div className="max-h-[132px] space-y-1 overflow-y-auto pr-1">
            {(data.sectors ?? []).length === 0 && (
              <NoData compact reason="Upstox does not publish sector classification for F&O stocks, so no sector aggregation is shown rather than inventing one." code="NOT_PROVIDED" />
            )}
            {(data.sectors ?? []).map((s: J) => (
              <div key={s.sector} className="flex items-center gap-2 text-[10.5px]">
                <span className="w-16 shrink-0 truncate text-txt-dim sm:w-20">{s.sector}</span>
                <div className="relative h-1.5 flex-1 rounded-full bg-panel2">
                  <div className={`absolute inset-y-0 rounded-full ${s.chgPct >= 0 ? "bg-green" : "bg-red"}`}
                    style={{ left: s.chgPct >= 0 ? "50%" : `${50 - Math.min(Math.abs(s.chgPct) * 20, 50)}%`, width: `${Math.min(Math.abs(s.chgPct) * 20, 50)}%` }} />
                  <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                </div>
                <span className={`tnum w-11 shrink-0 text-right sm:w-12 ${clsColor(s.chgPct)}`}>{fmtPct(s.chgPct)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-2.5 lg:grid-cols-2">
        <Panel title={<span className="flex items-center gap-1.5"><TrendingUp className="h-3 w-3 text-green" />Top Gainers — F&O</span>} pad={false}>
          <RowTable rows={data.gainers ?? []} extra={(r) => <span className="text-txt-dim">{fmtInt(r.volume)}</span>} />
        </Panel>
        <Panel title={<span className="flex items-center gap-1.5"><TrendingDown className="h-3 w-3 text-red" />Top Losers — F&O</span>} pad={false}>
          <RowTable rows={data.losers ?? []} extra={(r) => <span className="text-txt-dim">{fmtInt(r.volume)}</span>} />
        </Panel>
        <Panel title={<span className="flex items-center gap-1.5"><Activity className="h-3 w-3 text-blue" />Most Active F&O</span>} pad={false}>
          <RowTable rows={data.mostActive ?? []} extra={(r) => <span className="text-blue">{fmtInt(r.volume)}</span>} />
        </Panel>
        <Panel title={<span className="flex items-center gap-1.5"><Zap className="h-3 w-3 text-amber" />High RVOL (same-time-of-day)</span>} pad={false}>
          <RowTable rows={data.highRvol ?? []} extra={(r) => <span className="text-amber">{r.rvol?.toFixed(1)}×</span>} />
        </Panel>
      </div>

      <Panel title="Strongest FMPI" sub="Futures & Options Momentum Pressure Index — 5m" pad={false}>
        <div className="grid gap-0 sm:grid-cols-2">
          {(data.strongFmpi ?? []).map((r: J) => (
            <button key={r.symbol} onClick={() => openWorkspace(r.symbol)} className="flex items-center justify-between border-b border-border/60 px-3 py-1.5 text-left hover:bg-panel2">
              <span className="text-[11.5px] font-semibold">{r.symbol}</span>
              <Sparkline points={[r.fmpi - 12, r.fmpi - 5, r.fmpi + 2, r.fmpi]} width={64} height={18} color={r.fmpi >= 0 ? "#16c784" : "#ea3943"} />
              <span className="flex items-center gap-2">
                <span className={`tnum text-[11.5px] font-bold ${clsColor(r.fmpi)}`}>{r.fmpi?.toFixed(1)}</span>
                <ClassChip v={r.classification} />
              </span>
            </button>
          ))}
        </div>
      </Panel>
      <div className={`text-right text-[9.5px] ${freshnessColor[data.freshness] ?? "text-grey"}`}>feed: {data.freshness} · {new Date(data.ts).toLocaleTimeString()}</div>
    </div>
  );
}
