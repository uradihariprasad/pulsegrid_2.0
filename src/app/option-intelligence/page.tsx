"use client";

/** Module 4 — Option Intelligence (live chain + premium momentum + best ATM strikes) */
import { useState } from "react";
import { useApi, useApp, fmt, fmtInt, fmtPct, clsColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, SymbolPicker, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { ZoomIn } from "lucide-react";

export default function OptionIntelligencePage() {
  const { symbol, expiry, setExpiry, openWorkspace } = useApp();
  const [window, setWindow] = useState(7);
  const chainUrl = `/api/option-chain?symbol=${symbol}&window=${window}${expiry ? `&expiry=${expiry}` : ""}`;
  const { data } = useApi<J>(chainUrl, 5000);
  const { data: pm } = useApi<J>(`/api/intel/premium-momentum?symbol=${symbol}${expiry ? `&expiry=${expiry}` : ""}`, 5000);

  if (!data) return <Loading label="Loading option chain" />;
  if (isUnavailable(data))
    return (
      <div className="space-y-2.5">
        <Panel pad><SymbolPicker /></Panel>
        <Panel title="Option Intelligence"><NoData reason={data.reason} code={data.code} /></Panel>
      </div>
    );
  const maxOi = Math.max(1, ...data.rows.flatMap((r: J) => [r.ce?.oi ?? 0, r.pe?.oi ?? 0]));

  const OIBar = ({ v, align }: { v: number; align: "l" | "r" }) => (
    <span className="relative inline-flex h-3.5 w-full items-center">
      <span
        className="absolute h-full rounded-sm bg-blue/15"
        style={{ [align === "l" ? "right" : "left"]: 0, width: `${Math.min(100, (v / maxOi) * 100)}%` } as J}
      />
      <span className="relative px-1">{fmtInt(v)}</span>
    </span>
  );

  const stateTone: Record<string, string> = {
    STRENGTHENING: "text-green", ACCELERATING: "text-green", BREAKOUT_PULSE: "text-green",
    WEAKENING: "text-red", DECELERATING: "text-red", DIVERGENT: "text-amber", FLAT: "text-grey",
  };

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-3">
          <SymbolPicker />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase text-grey">Expiry</span>
            <select
              value={expiry ?? data.expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="h-7 rounded-md border border-border bg-panel2 px-2 text-[11px] font-semibold outline-none focus:border-blue/60"
            >
              {(data.expiries ?? []).map((e: string) => <option key={e}>{e}</option>)}
            </select>
          </div>
          <span className="pg-chip">ATM <b className="text-blue">{data.atm}</b></span>
          <span className="pg-chip">PCR <b className={data.pcr == null ? "text-grey" : data.pcr > 1 ? "text-green" : "text-red"}>{data.pcr ?? "—"}</b></span>
          <span className="pg-chip">Max CE OI <b className="text-red">{data.maxCeOiStrike}</b></span>
          <span className="pg-chip">Max PE OI <b className="text-green">{data.maxPeOiStrike}</b></span>
          <span className="ml-auto flex items-center gap-2">
            <FreshnessDot f={data.freshness} />
            <Badge tone={data.provider === "UPSTOX" ? "green" : "amber"}>{data.provider}</Badge>
          </span>
        </div>
      </Panel>

      <div className="flex flex-col gap-2.5 xl:flex-row">
        <Panel title={`Option chain — ${symbol} ${data.expiry}`} pad={false} className="min-w-0 flex-[3]">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="pg-th text-right" colSpan={6}><span className="text-blue">CALLS (CE)</span></th>
                  <th className="pg-th text-center">STRIKE</th>
                  <th className="pg-th" colSpan={6}><span className="text-amber">PUTS (PE)</span></th>
                </tr>
                <tr>
                  {["OI Δ", "OI", "Vol", "Δ", "IV", "LTP"].map((h) => <th key={`c${h}`} className="pg-th text-right">{h}</th>)}
                  <th className="pg-th text-center">—</th>
                  {["LTP", "IV", "Δ", "Vol", "OI", "OI Δ"].map((h) => <th key={`p${h}`} className="pg-th">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: J) => (
                  <tr key={r.strike} className={`pg-row-hover ${r.isAtm ? "bg-blue/[0.07]" : ""}`}>
                    <td className="pg-td text-right"><span className={clsColor(r.ce?.oiSessChg)}>{r.ce?.oiSessChg == null ? "N/A" : fmtInt(r.ce.oiSessChg)}</span></td>
                    <td className="pg-td text-right">{r.ce ? <OIBar v={r.ce.oi} align="l" /> : "—"}</td>
                    <td className="pg-td text-right text-txt-dim">{fmtInt(r.ce?.volume)}</td>
                    <td className="pg-td text-right text-txt-dim">{r.ce?.delta?.toFixed(2) ?? "—"}</td>
                    <td className="pg-td text-right text-txt-dim">{r.ce?.iv ? `${r.ce.iv.toFixed(1)}` : "—"}</td>
                    <td className="pg-td text-right font-semibold text-txt">{fmt(r.ce?.ltp)}</td>
                    <td className={`pg-td text-center font-bold ${r.isAtm ? "text-blue" : "text-txt"}`}>{fmt(r.strike, r.strike % 1 ? 1 : 0)}</td>
                    <td className="pg-td font-semibold text-txt">{fmt(r.pe?.ltp)}</td>
                    <td className="pg-td text-txt-dim">{r.pe?.iv ? `${r.pe.iv.toFixed(1)}` : "—"}</td>
                    <td className="pg-td text-txt-dim">{r.pe?.delta?.toFixed(2) ?? "—"}</td>
                    <td className="pg-td text-txt-dim">{fmtInt(r.pe?.volume)}</td>
                    <td className="pg-td">{r.pe ? <OIBar v={r.pe.oi} align="r" /> : "—"}</td>
                    <td className="pg-td"><span className={clsColor(r.pe?.oiSessChg)}>{r.pe?.oiSessChg == null ? "N/A" : fmtInt(r.pe.oiSessChg)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
            <span className="text-[9.5px] text-grey">Greeks and IV are supplied by Upstox · OI Δ = session cumulative vs the fixed first-observation baseline · prev_oi from provider</span>
            <button onClick={() => setWindow((w) => Math.min(12, w + 2))} className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-txt-dim hover:border-blue/50 hover:text-blue">
              <ZoomIn className="h-3 w-3" /> expand strikes
            </button>
          </div>
        </Panel>

        <div className="flex-1 space-y-2.5">
          <Panel title="Best ATM ±3 candidates" sub="Composite of momentum, delta, liquidity, confirmation">
            {[
              { t: "Bullish CE candidate", s: pm && !isUnavailable(pm) ? pm.bestCe : null, tone: "green" as const },
              { t: "Bearish PE candidate", s: pm && !isUnavailable(pm) ? pm.bestPe : null, tone: "red" as const },
            ].map(({ t, s, tone }) =>
              s ? (
                <button key={t} onClick={() => openWorkspace(symbol)} className="pg-panel-2 mb-2 block w-full p-2 text-left hover:border-blue/40">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-txt-dim">{t}</span>
                    <Badge tone={tone}>{s.strike} @ {fmt(s.ltp)}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(s.confirmations ?? []).map((c: string) => <span key={c} className="pg-chip text-green border-green/20">{c}</span>)}
                  </div>
                  <div className="mt-1 text-[9.5px] text-grey">
                    prem Δ {fmtPct(s.premChgPct)} · vol {fmtInt(s.volume)} · spread {fmt(s.spreadPct, 1)}% · ΔOI sess {s.oiSessChg == null ? "N/A" : fmtInt(s.oiSessChg)} · score {s.score}
                  </div>
                  <p className="mt-1 text-[9px] leading-snug text-grey">{s.reason}</p>
                </button>
              ) : (
                <div key={t} className="mb-2 text-[11px] text-grey">{t}: N/A</div>
              ),
            )}
          </Panel>
          <Panel title="Premium momentum — ATM ±3" pad={false}>
            <div className="max-h-[340px] overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-panel">
                  <tr>
                    {["Contract", "LTP", "5m %", "15m %", "Sess %", "State"].map((h) => <th key={h} className="pg-th text-right">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {pm && isUnavailable(pm) && <tr><td colSpan={6}><NoData compact reason={pm.reason} code={pm.code} /></td></tr>}
                  {(pm && !isUnavailable(pm) ? pm.contracts ?? [] : []).map((c: J) => (
                    <tr key={c.key} className="pg-row-hover">
                      <td className="pg-td font-semibold"><span className={c.side === "CE" ? "text-blue" : "text-amber"}>{c.side}</span> {c.strike}</td>
                      <td className="pg-td text-right tnum">{fmt(c.ltp)}</td>
                      <td className={`pg-td text-right tnum ${clsColor(c.premChgPct5m)}`}>{c.premChgPct5m == null ? "N/A" : fmtPct(c.premChgPct5m)}</td>
                      <td className={`pg-td text-right tnum ${clsColor(c.premChgPct15m)}`}>{c.premChgPct15m == null ? "N/A" : fmtPct(c.premChgPct15m)}</td>
                      <td className={`pg-td text-right tnum ${clsColor(c.premChgPctSess)}`}>{fmtPct(c.premChgPctSess)}</td>
                      <td className={`pg-td text-right text-[9.5px] font-semibold ${stateTone[c.state] ?? "text-grey"}`}>{c.state.replaceAll("_", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-border px-3 py-1.5 text-[9px] text-grey">{pm && !isUnavailable(pm) ? pm.note : null}</div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
