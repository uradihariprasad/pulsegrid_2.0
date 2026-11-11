"use client";

/** Module 10 — Buyer/Seller Dominance (directional evidence, not identity claims) */
import { useApi, useApp, fmt, fmtPct, fmtInt, clsColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, Empty, EvidenceBars, NoData, isUnavailable } from "@/components/ui";
import { TrendingUp, TrendingDown } from "lucide-react";

function DomTable({ rows, side }: { rows: J[]; side: "buy" | "sell" }) {
  const { openWorkspace } = useApp();
  if (!rows.length) return <Empty label={`No ${side === "buy" ? "buyer" : "seller"}-dominant evidence right now`} />;
  return (
    <table className="w-full">
      <thead>
        <tr>
          {["Stock", "LTP", "Chg %", "RVOL", "Futures", "CE/PE positioning", "FMPI", "Score", "Evid.", "Evidence"].map((h) => (
            <th key={h} className="pg-th text-right">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.symbol} onClick={() => openWorkspace(r.symbol)} className="pg-row-hover cursor-pointer">
            <td className="pg-td font-bold">{r.symbol}</td>
            <td className="pg-td text-right tnum">{fmt(r.ltp)}</td>
            <td className={`pg-td text-right tnum ${clsColor(r.chgPct)}`}>{fmtPct(r.chgPct)}</td>
            <td className="pg-td text-right"><span className={r.rvol != null && r.rvol > 1.5 ? "text-amber font-semibold" : "text-txt-dim"}>{r.rvol?.toFixed(1) ?? "—"}</span></td>
            <td className="pg-td text-right"><ClassChip v={r.futuresBuildup} /></td>
            <td className="pg-td text-right text-[10px] text-txt-dim">{r.cePePositioning}</td>
            <td className={`pg-td text-right tnum font-semibold ${clsColor(r.fmpi)}`}>{r.fmpi?.toFixed(0) ?? "—"}</td>
            <td className={`pg-td text-right tnum font-bold ${clsColor(r.momentumScore)}`}>{r.momentumScore}</td>
            <td className="pg-td text-right"><EvidenceBars coverage={r.coverage} /></td>
            <td className="pg-td max-w-[240px] truncate text-[9.5px] text-grey">{r.evidence?.join(" · ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function DominancePage() {
  const { data } = useApi<J>("/api/intel/dominance", 6000);
  if (!data) return <Loading label="Measuring directional dominance" />;
  if (isUnavailable(data)) return <Panel title="Buyer/Seller Dominance"><NoData reason={data.reason} code={data.code} /></Panel>;
  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-3 text-[10.5px] text-txt-dim">
          <span className="flex items-center gap-1.5 font-semibold text-txt"><TrendingUp className="h-3.5 w-3.5 text-green" /><TrendingDown className="h-3.5 w-3.5 -ml-2 text-red" />Directional dominance engine</span>
          <span>Composite of price · volume/RVOL · futures price+OI · CE/PE premium response · rolling OI · structure · VWAP · FMPI.</span>
          <Badge tone="amber">Directional evidence labels — participant identity is never inferred from OI alone</Badge>
        </div>
      </Panel>
      <div className="grid gap-2.5 xl:grid-cols-2">
        <Panel title={<span className="flex items-center gap-1.5 text-green"><TrendingUp className="h-3 w-3" />Buyer-dominant stocks</span>} pad={false}>
          <div className="overflow-x-auto"><DomTable rows={data.buyers ?? []} side="buy" /></div>
        </Panel>
        <Panel title={<span className="flex items-center gap-1.5 text-red"><TrendingDown className="h-3 w-3" />Seller-dominant stocks</span>} pad={false}>
          <div className="overflow-x-auto"><DomTable rows={data.sellers ?? []} side="sell" /></div>
        </Panel>
      </div>
    </div>
  );
}
