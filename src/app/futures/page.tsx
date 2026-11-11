"use client";

/** Module 6 — Futures Intelligence (per-symbol deep panel + universe grid) */
import { useApi, useApp, fmt, fmtPct, fmtInt, fmtChg, clsColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, SymbolPicker, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { ScrollText } from "lucide-react";

export default function FuturesPage() {
  const { symbol, openWorkspace } = useApp();
  const { data: sel } = useApi<J>(`/api/intel/futures?symbol=${symbol}`, 4000);
  const { data: all } = useApi<J>(`/api/intel/futures-all`, 8000);

  if (!sel || !all) return <Loading label="Computing futures intelligence" />;
  if (isUnavailable(sel))
    return (
      <div className="space-y-2.5">
        <Panel pad><SymbolPicker /></Panel>
        <Panel title="Futures Intelligence"><NoData reason={sel.reason} code={sel.code} /></Panel>
      </div>
    );

  const Metric = ({ l, v, cls = "text-txt" }: { l: string; v: string; cls?: string }) => (
    <div className="pg-panel-2 p-2">
      <div className="text-[8.5px] font-semibold uppercase tracking-wider text-grey">{l}</div>
      <div className={`tnum mt-0.5 text-[13px] font-bold ${cls}`}>{v}</div>
    </div>
  );

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <SymbolPicker />
          <span className="order-last w-full text-[10.5px] text-txt-dim sm:order-none sm:w-auto">{sel.confirmation}</span>
          <span className="ml-auto"><FreshnessDot f={sel.freshness} /></span>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:gap-2.5 xl:grid-cols-6">
        <Metric l="Futures LTP" v={fmt(sel.fut.ltp)} />
        <Metric l="Fut Chg %" v={fmtPct(sel.fut.chgPct)} cls={clsColor(sel.fut.chgPct)} />
        <Metric l="Spot LTP" v={fmt(sel.spot.ltp)} />
        <Metric l="Basis" v={fmt(sel.basis)} cls={clsColor(sel.basis)} />
        <Metric l="OI observations" v={String(sel.obsCount ?? 0)} />
        <Metric l="Futures VWAP" v={fmt(sel.fut.vwap)} />
        <Metric l="Futures OI" v={fmtInt(sel.fut.oi)} />
        <Metric l="OI Δ 2m" v={fmtChg(sel.fut.oiChg2m)} cls={clsColor(sel.fut.oiChg2m)} />
        <Metric l="OI Δ 5m" v={fmtChg(sel.fut.oiChg5m)} cls={clsColor(sel.fut.oiChg5m)} />
        <Metric l="OI Δ 15m" v={fmtChg(sel.fut.oiChg15m)} cls={clsColor(sel.fut.oiChg15m)} />
        <Metric l="Session ΔOI" v={fmtChg(sel.fut.oiSessChg)} cls={clsColor(sel.fut.oiSessChg)} />
        <div className="pg-panel-2 p-2">
          <div className="text-[8.5px] font-semibold uppercase tracking-wider text-grey">Classification</div>
          <div className="mt-1"><ClassChip v={sel.fut.classification} /></div>
        </div>
      </div>

      <Panel title={<span className="flex items-center gap-1.5"><ScrollText className="h-3 w-3 text-blue" />Futures universe — price/OI relationship</span>} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {["Symbol", "Fut LTP", "Chg %", "Volume", "OI", "ΔOI 5m", "ΔOI 15m", "Session ΔOI", "Basis", "Classification", "Confirm"].map((h) => (
                  <th key={h} className="pg-th text-right">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(isUnavailable(all) ? [] : all.rows ?? []).map((r: J) => (
                <tr key={r.symbol} onClick={() => openWorkspace(r.symbol)} className="pg-row-hover cursor-pointer">
                  <td className="pg-td font-bold">{r.symbol}</td>
                  <td className="pg-td text-right tnum">{fmt(r.fut.ltp)}</td>
                  <td className={`pg-td text-right tnum ${clsColor(r.fut.chgPct)}`}>{fmtPct(r.fut.chgPct)}</td>
                  <td className="pg-td text-right text-txt-dim">{fmtInt(r.fut.volume)}</td>
                  <td className="pg-td text-right text-txt-dim">{fmtInt(r.fut.oi)}</td>
                  <td className={`pg-td text-right ${clsColor(r.fut.oiChg5m)}`}>{fmtChg(r.fut.oiChg5m)}</td>
                  <td className={`pg-td text-right ${clsColor(r.fut.oiChg15m)}`}>{fmtChg(r.fut.oiChg15m)}</td>
                  <td className={`pg-td text-right font-semibold ${clsColor(r.fut.oiSessChg)}`}>{fmtChg(r.fut.oiSessChg)}</td>
                  <td className={`pg-td text-right ${clsColor(r.basis)}`}>{fmt(r.basis)}</td>
                  <td className="pg-td text-right"><ClassChip v={r.fut.classification} /></td>
                  <td className="pg-td text-right"><FreshnessDot f={r.freshness} label={false} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[9.5px] text-grey">
          Missing futures data is never treated as confirmation · Long Buildup = price↑ OI↑ · Short Buildup = price↓ OI↑ · Short Covering = price↑ OI↓ · Long Unwinding = price↓ OI↓
        </div>
      </Panel>
    </div>
  );
}
