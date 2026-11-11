"use client";

/** Module 5 — OI Momentum (5m / 15m / session cumulative / combined total) */
import { useApi, useApp, fmt, fmtChg, fmtInt, clsColor, freshnessColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, SymbolPicker, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { OIBars } from "@/components/charts";

export default function OiMomentumPage() {
  const { symbol, expiry, setExpiry, openWorkspace } = useApp();
  const { data } = useApi<J>(`/api/intel/oi-momentum?symbol=${symbol}${expiry ? `&expiry=${expiry}` : ""}`, 5000);

  if (!data) return <Loading label="Computing OI momentum" />;
  if (isUnavailable(data))
    return (
      <div className="space-y-2.5">
        <Panel pad><SymbolPicker /></Panel>
        <Panel title="OI Momentum"><NoData reason={data.reason} code={data.code} /></Panel>
      </div>
    );
  const rows: J[] = data.rows ?? [];
  const barRows = (pick: (s: J | null) => number | null) =>
    rows.map((r) => ({ label: String(r.strike), ce: pick(r.ce), pe: pick(r.pe), highlight: r.isAtm }));

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-3">
          <SymbolPicker />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase text-grey">Expiry</span>
            <select value={expiry ?? data.expiry} onChange={(e) => setExpiry(e.target.value)} className="h-7 rounded-md border border-border bg-panel2 px-2 text-[11px] font-semibold outline-none focus:border-blue/60">
              {(data.expiries ?? []).map((e: string) => <option key={e}>{e}</option>)}
            </select>
          </div>
          <span className="pg-chip">Spot <b>{fmt(data.spot)}</b></span>
          <span className="pg-chip">ATM <b className="text-blue">{data.atm}</b></span>
          <span className="pg-chip">Interpretation <ClassChip v={data.interpretation} /></span>
          <span className="ml-auto"><FreshnessDot f={isMarketFresh(rows)} /></span>
        </div>
        <p className="mt-1.5 text-[9.5px] leading-snug text-grey">
          Live Upstox option-chain observations · {data.historyMinutes ?? 0} min of history captured this session. Time-based rolling windows (90s match
          tolerance); missing or stale references return <b>N/A</b> — never substituted. Session baseline is the first valid observation (persisted);
          combined total uses the provider&apos;s <code>prev_oi</code> as the pre-session reference. OI additions do NOT prove writing.
        </p>
      </Panel>

      <div className="grid gap-2.5 md:grid-cols-2">
        <Panel title="5-minute change in OI" sub="Current OI − OI ~5 minutes earlier">
          <OIBars rows={barRows((s) => s?.chg5m ?? null)} />
        </Panel>
        <Panel title="15-minute change in OI" sub="Current OI − OI ~15 minutes earlier">
          <OIBars rows={barRows((s) => s?.chg15m ?? null)} />
        </Panel>
        <Panel title="Session cumulative change in OI" sub="Current OI − fixed session baseline (resets never on refresh)">
          <OIBars rows={barRows((s) => s?.sess ?? null)} />
        </Panel>
        <Panel title="Current / combined total OI" sub="Pre-session reference + session change (absolute)">
          <OIBars absolute rows={barRows((s) => s?.combined ?? s?.current ?? null)} />
        </Panel>
      </div>

      <Panel title={`OI detail — ${symbol} ${data.expiry} · ATM ±3`} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="pg-th">Strike</th>
                {["CE OI", "CE 5m", "CE 15m", "CE Session"].map((h) => <th key={h} className="pg-th text-right">{h}</th>)}
                {["PE OI", "PE 5m", "PE 15m", "PE Session"].map((h) => <th key={h} className="pg-th text-right">{h}</th>)}
                <th className="pg-th text-right">Freshness</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.strike} onClick={() => openWorkspace(symbol)} className={`pg-row-hover cursor-pointer ${r.isAtm ? "bg-blue/[0.06]" : ""}`}>
                  <td className={`pg-td font-bold ${r.isAtm ? "text-blue" : ""}`}>{fmt(r.strike, r.strike % 1 ? 1 : 0)}</td>
                  <td className="pg-td text-right text-blue">{fmtInt(r.ce?.current)}</td>
                  <td className={`pg-td text-right ${clsColor(r.ce?.chg5m)}`}>{fmtChg(r.ce?.chg5m)}</td>
                  <td className={`pg-td text-right ${clsColor(r.ce?.chg15m)}`}>{fmtChg(r.ce?.chg15m)}</td>
                  <td className={`pg-td text-right font-semibold ${clsColor(r.ce?.sess)}`}>{fmtChg(r.ce?.sess)}</td>
                  <td className="pg-td text-right text-amber">{fmtInt(r.pe?.current)}</td>
                  <td className={`pg-td text-right ${clsColor(r.pe?.chg5m)}`}>{fmtChg(r.pe?.chg5m)}</td>
                  <td className={`pg-td text-right ${clsColor(r.pe?.chg15m)}`}>{fmtChg(r.pe?.chg15m)}</td>
                  <td className={`pg-td text-right font-semibold ${clsColor(r.pe?.sess)}`}>{fmtChg(r.pe?.sess)}</td>
                  <td className={`pg-td text-right text-[10px] ${freshnessColor[r.freshness] ?? "text-grey"}`}>{r.freshness}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[9.5px] text-grey">
          sampling: {data.sampling?.mode} · tolerance {data.sampling?.toleranceSec}s · provider {data.provider}
        </div>
      </Panel>
    </div>
  );
}

function isMarketFresh(rows: J[]): string {
  return rows[0]?.freshness ?? "UNAVAILABLE";
}
