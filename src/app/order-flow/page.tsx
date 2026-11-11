"use client";

/** Module 7 — Order Flow (data-authenticity first: never fabricate CVD/footprint) */
import { useApi, useApp, useBreakpoint, fmt, fmtInt, clsColor, type J } from "@/lib/client";
import { Panel, Badge, Loading, SymbolPicker, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { Sparkline } from "@/components/charts";
import { ShieldCheck, AlertTriangle } from "lucide-react";

export default function OrderFlowPage() {
  const { symbol } = useApp();
  const { data } = useApi<J>(`/api/intel/order-flow?symbol=${symbol}`, 4000);
  const { width, isMobile } = useBreakpoint();
  if (!data) return <Loading label="Building order-flow view" />;
  if (isUnavailable(data))
    return (
      <div className="space-y-2.5">
        <Panel pad><SymbolPicker /></Panel>
        <Panel title="Order Flow"><NoData reason={data.reason} code={data.code} /></Panel>
      </div>
    );

  const imb = data.imbalance;
  const total = (imb?.bid ?? 0) + (imb?.ask ?? 0) || 1;

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-3">
          <SymbolPicker />
          <span className="pg-chip">Spot <b>{fmt(data.spot)}</b></span>
          <span className="ml-auto"><FreshnessDot f={data.freshness} /></span>
        </div>
      </Panel>

      <Panel
        title={<span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-blue" />Data authenticity</span>}
        sub="What is actually knowable from this feed tier"
      >
        <div className="grid gap-2 text-[10.5px] md:grid-cols-2">
          <div className="rounded border border-blue/20 bg-blue/5 p-2"><b className="text-blue">DEPTH</b> — <span className="text-txt-dim">{data.authenticity?.depth}</span></div>
          <div className="rounded border border-amber/20 bg-amber/5 p-2"><b className="text-amber">CVD</b> — <span className="text-txt-dim">{data.authenticity?.cvd}</span></div>
          <div className="rounded border border-red/20 bg-red/5 p-2"><b className="text-red">FOOTPRINT</b> — <span className="text-txt-dim">{data.authenticity?.footprint}</span></div>
          <div className="rounded border border-amber/20 bg-amber/5 p-2"><b className="text-amber">LIQUIDITY MAP</b> — <span className="text-txt-dim">{data.authenticity?.liquidityHeatmap}</span></div>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[9.5px] text-amber/80">
          <AlertTriangle className="h-3 w-3" /> Bid/ask quantities alone cannot establish aggressive buying or selling. Nothing here claims hidden institutional activity.
        </p>
      </Panel>

      <div className="grid gap-2.5 lg:grid-cols-3">
        <Panel title="Depth imbalance — near contract" sub={data.atmDepth ? `ATM ${data.atmDepth.strike}` : undefined}>
          <div className="space-y-2">
            <div>
              <div className="flex justify-between text-[10px] text-txt-dim"><span>BID {fmtInt(imb?.bid)}</span><span>ASK {fmtInt(imb?.ask)}</span></div>
              <div className="mt-1 flex h-3 overflow-hidden rounded-full border border-border">
                <div className="bg-green/70" style={{ width: `${(imb?.bid / total) * 100}%` }} />
                <div className="bg-red/70" style={{ width: `${(imb?.ask / total) * 100}%` }} />
              </div>
              <div className="mt-1 text-center text-[11px] tnum font-bold">ratio {imb?.ratio ?? "—"}</div>
            </div>
            {data.atmDepth && (
              <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                <div className="pg-panel-2 p-1.5"><span className="text-grey">CE depth</span><div className="tnum">{fmtInt(data.atmDepth.ceBidQty)} / {fmtInt(data.atmDepth.ceAskQty)}</div></div>
                <div className="pg-panel-2 p-1.5"><span className="text-grey">PE depth</span><div className="tnum">{fmtInt(data.atmDepth.peBidQty)} / {fmtInt(data.atmDepth.peAskQty)}</div></div>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="CVD — cumulative volume delta" className="lg:col-span-2">
          <NoData
            compact
            code="NOT_PROVIDED"
            reason="A genuine CVD needs executed trade prints with reliable aggressor-side classification. The Upstox REST quote feed does not expose them, so PULSEGRID shows nothing here rather than estimating a number that would look authoritative."
          />
        </Panel>
      </div>

      <div className="grid gap-2.5 lg:grid-cols-3">
        <Panel title="Liquidity map" sub="structure-derived pools">
          <div className="space-y-1.5 text-[11px]">
            <div>
              <div className="text-[9.5px] uppercase text-grey">Buy-side liquidity (above)</div>
              {(data.liquidityMap?.buySide ?? []).length === 0 && <span className="text-grey">none detected</span>}
              {(data.liquidityMap?.buySide ?? []).map((v: number) => (
                <div key={v} className="flex justify-between"><span className="text-txt-dim">equal highs</span><span className="tnum font-semibold text-txt">{fmt(v)}</span></div>
              ))}
            </div>
            <div>
              <div className="text-[9.5px] uppercase text-grey">Sell-side liquidity (below)</div>
              {(data.liquidityMap?.sellSide ?? []).map((v: number) => (
                <div key={v} className="flex justify-between"><span className="text-txt-dim">equal lows</span><span className="tnum font-semibold text-txt">{fmt(v)}</span></div>
              ))}
            </div>
          </div>
        </Panel>
        <Panel title="Stop-run / sweep candidates" className="lg:col-span-2">
          <div className="flex flex-wrap gap-2">
            {(data.liquidityMap?.sweepCandidates ?? []).map((v: number) => (
              <span key={v} className="pg-chip">sweep watch <b className="tnum">{fmt(v)}</b></span>
            ))}
            {(data.liquidityMap?.sweepCandidates ?? []).length === 0 && <span className="text-[11px] text-grey">No swing liquidity candidates right now</span>}
          </div>
          <p className="mt-2 text-[9.5px] leading-snug text-grey">
            Sweeps and reclaims are confirmed by actual price behaviour on structure levels (takes out a level then closes back inside) — shown in Market Structure events.
          </p>
        </Panel>
      </div>

      {/* depth ladder */}
      <Panel title={`Market depth — ${data.depthLevels ?? 0} live level(s) from Upstox`} pad={false}>
        <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>{["Bid size", "Bid", "Ask", "Ask size"].map((h) => <th key={h} className="pg-th text-center">{h}</th>)}</tr>
          </thead>
          <tbody>
            {(data.ladder ?? []).map((l: J) => (
              <tr key={l.level}>
                <td className="pg-td text-right text-green">{fmtInt(l.bidQty)}</td>
                <td className="pg-td text-center tnum font-semibold text-green">{fmt(l.bid)}</td>
                <td className="pg-td text-center tnum font-semibold text-red">{l.ask == null ? "—" : fmt(l.ask)}</td>
                <td className="pg-td text-left text-red">{l.askQty == null ? "—" : fmtInt(l.askQty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Panel>
    </div>
  );
}
