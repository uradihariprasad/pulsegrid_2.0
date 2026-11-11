"use client";

/**
 * PULSEGRID 2.0 — complete individual instrument workspace.
 * Opens from every module. Every section uses the same selected instrument.
 */
import { useMemo } from "react";
import { useApi, useBreakpoint, fmt, fmtPct, fmtInt, fmtChg, clsColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, DirCell, FreshnessDot, Loading, ErrorState, EvidenceBars, Meter, NoData, isUnavailable } from "@/components/ui";
import { CandleChart, OIBars, FMPIGauge, overlaysFromLevels, type SROverlay } from "@/components/charts";
import { SRIntelligencePanel } from "@/components/sr-panel";

export function Workspace({ symbol }: { symbol: string }) {
  const { data: ws, error, loading } = useApi<J>(`/api/intel/workspace?symbol=${symbol}`, 5000);
  const { data: cd } = useApi<J>(`/api/candles?symbol=${symbol}&tf=5m&days=2`, 8000);
  const { data: fs } = useApi<J>(`/api/intel/fmpi-series?symbol=${symbol}&tf=5m`, 15000);
  const { isMobile } = useBreakpoint();

  const srLv = ws && !isUnavailable(ws) && ws.srLevels && !isUnavailable(ws.srLevels) ? ws.srLevels : null;
  const overlays: SROverlay[] = useMemo(() => overlaysFromLevels(srLv?.levels), [srLv]);

  if (loading && !ws) return <Loading label="Loading workspace" />;
  if (error && !ws) return <ErrorState label={error} />;
  if (!ws) return null;
  if (isUnavailable(ws)) return <Panel title={symbol}><NoData reason={ws.reason} code={ws.code} /></Panel>;

  const spot = ws.spot;
  const trade = ws.trade?.candidates?.[0];
  const oi = ws.oiMomentum && !isUnavailable(ws.oiMomentum) ? ws.oiMomentum : null;
  const chainOk = ws.chain && !isUnavailable(ws.chain) ? ws.chain : null;
  const futOk = ws.futures && !isUnavailable(ws.futures) ? ws.futures : null;
  const pmOk = ws.premiumMomentum && !isUnavailable(ws.premiumMomentum) ? ws.premiumMomentum : null;
  const ofOk = ws.orderFlow && !isUnavailable(ws.orderFlow) ? ws.orderFlow : null;
  const tgOk = ws.targets && !isUnavailable(ws.targets) ? ws.targets : null;
  const stOk = ws.structure && !isUnavailable(ws.structure) ? ws.structure : null;
  const vpOk = ws.profile && !isUnavailable(ws.profile) ? ws.profile : null;

  return (
    <div className="space-y-2.5">
      {/* 1 — live price header */}
      <div className="pg-panel-2 flex flex-wrap items-center gap-x-4 gap-y-2 p-2.5 sm:gap-x-5 sm:p-3">
        <div>
          <div className="text-[10px] text-grey">{ws.name} · {ws.sector}</div>
          <div className="flex items-baseline gap-2">
            <span className="tnum text-xl font-bold">{fmt(spot.ltp)}</span>
            <span className={`tnum text-[12px] font-semibold ${clsColor(spot.chgPct)}`}>{fmtPct(spot.chgPct)}</span>
          </div>
        </div>
        {[
          ["OPEN", fmt(spot.open)],
          ["HIGH", fmt(spot.high)],
          ["LOW", fmt(spot.low)],
          ["PREV CLOSE", fmt(spot.prevClose)],
          ["VWAP", fmt(spot.vwap)],
          ["VOLUME", fmtInt(spot.volume)],
        ].map(([l, v]) => (
          <div key={l}>
            <div className="text-[9px] uppercase tracking-wider text-grey">{l}</div>
            <div className="tnum text-[12px] font-semibold text-txt">{v}</div>
          </div>
        ))}
        <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
          <FreshnessDot f={ws.freshness} />
          <Badge tone={ws.provider === "UPSTOX" ? "green" : "amber"}>{ws.provider} PROVIDER</Badge>
        </div>
      </div>

      {/* 1+2 — chart + FMPI below */}
      <Panel
        title={cd && !isUnavailable(cd) && cd.historical ? `Chart — 5m · last trading session ${cd.sessionDate}` : "Live chart — 5m"}
        pad={false}
        className="overflow-hidden"
      >
        <div className="p-2">
          {cd && isUnavailable(cd) ? <NoData compact reason={cd.reason} code={cd.code} /> : <CandleChart data={cd} height={isMobile ? 260 : 330} overlays={overlays} fmpi={fs && !isUnavailable(fs) ? fs.points : null} />}
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10px] text-txt-dim">
          <span>FMPI pane (bottom) — Futures & Options Momentum Pressure Index</span>
          {ws.fmpi && <ClassChip v={ws.fmpi.classification} />}
        </div>
      </Panel>

      {/* 3 — Dynamic S/R Intelligence directly below the chart */}
      <SRIntelligencePanel data={ws.srLevels} tf="5m" />

      <div className="grid gap-2.5 md:grid-cols-2">
        {/* 3b — compact level ladder */}
        <Panel title="Dynamic Support / Resistance" sub="Unified engine — identical to the chart overlays">
          <SRMini ws={ws} />
        </Panel>
        {/* 4+5 — structure & volume profile */}
        <Panel title="Market Structure & Volume Profile">
          <div className="space-y-2 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-txt-dim">Structure trend</span>
              <ClassChip v={stOk?.trend} />
            </div>
            {stOk?.multiTimeframe && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(stOk.multiTimeframe as Record<string, string>).map(([t, v]) => (
                  <span key={t} className="pg-chip">{t}: <ClassChip v={v} /></span>
                ))}
              </div>
            )}
            {stOk?.countertrend && <Badge tone="amber">{stOk.countertrend}</Badge>}
            {vpOk ? (
              <div className="grid grid-cols-3 gap-2 pt-1">
                {[
                  ["POC", vpOk.poc],
                  ["VAH", vpOk.vah],
                  ["VAL", vpOk.val],
                ].map(([l, v]) => (
                  <div key={l as string} className="pg-panel-2 p-2 text-center">
                    <div className="text-[9px] uppercase text-grey">{l}</div>
                    <div className="tnum text-[12px] font-semibold text-txt">{fmt(v as number)}</div>
                  </div>
                ))}
                <p className="col-span-3 text-[9px] text-grey">Volume-at-price approximation from real candles — labelled, not assumed.</p>
              </div>
            ) : (
              <NoData compact reason={ws.profile && isUnavailable(ws.profile) ? ws.profile.reason : "Profile pending."} code={ws.profile && isUnavailable(ws.profile) ? ws.profile.code : "LOADING"} />
            )}
          </div>
        </Panel>
      </div>

      {/* 6–10 — option chain + OI */}
      <Panel
        title={`Option chain — ATM ±3 · ${ws.expiry}`}
        right={<ClassChip v={oi?.interpretation} />}
        pad={false}
      >
        {!oi && <NoData compact reason={ws.oiMomentum && isUnavailable(ws.oiMomentum) ? ws.oiMomentum.reason : "Chain pending."} code={ws.oiMomentum && isUnavailable(ws.oiMomentum) ? ws.oiMomentum.code : "LOADING"} />}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {["CE OI", "CE Δ5m", "CE Δsess", "CE LTP", "STRIKE", "PE LTP", "PE Δsess", "PE Δ5m", "PE OI"].map((h) => (
                  <th key={h} className="pg-th">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {oi?.rows?.map((r: J) => (
                <tr key={r.strike} className={`pg-row-hover ${r.isAtm ? "bg-blue/5" : ""}`}>
                  <td className="pg-td text-blue">{fmtInt(r.ce?.current)}</td>
                  <td className="pg-td"><DirCell v={r.ce?.chg5m} /></td>
                  <td className="pg-td"><DirCell v={r.ce?.sess} /></td>
                  <td className="pg-td tnum">{fmt(r.ce?.ltp ?? chainOk?.rows?.find((x: J) => x.strike === r.strike)?.ce?.ltp)}</td>
                  <td className={`pg-td text-center font-bold ${r.isAtm ? "text-blue" : "text-txt"}`}>{fmt(r.strike, r.strike >= 1000 ? 0 : 1)}</td>
                  <td className="pg-td tnum text-right">{fmt(r.pe?.ltp ?? chainOk?.rows?.find((x: J) => x.strike === r.strike)?.pe?.ltp)}</td>
                  <td className="pg-td text-right"><DirCell v={r.pe?.sess} /></td>
                  <td className="pg-td text-right"><DirCell v={r.pe?.chg5m} /></td>
                  <td className="pg-td text-right text-amber">{fmtInt(r.pe?.current)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[9.5px] text-grey">OI changes are time-windowed rolling references; N/A = insufficient history · Baseline persists per session</div>
      </Panel>

      {oi && (
        <Panel title="OI momentum — 5m / 15m / session / combined">
          <div className="grid gap-3 lg:grid-cols-2">
            <OIBars height={140} rows={oi.rows.map((r: J) => ({ label: String(r.strike), ce: r.ce?.chg5m ?? null, pe: r.pe?.chg5m ?? null, highlight: r.isAtm }))} />
            <OIBars height={140} rows={oi.rows.map((r: J) => ({ label: String(r.strike), ce: r.ce?.chg15m ?? null, pe: r.pe?.chg15m ?? null, highlight: r.isAtm }))} />
            <OIBars height={140} rows={oi.rows.map((r: J) => ({ label: String(r.strike), ce: r.ce?.sess ?? null, pe: r.pe?.sess ?? null, highlight: r.isAtm }))} />
            <OIBars height={140} absolute rows={oi.rows.map((r: J) => ({ label: String(r.strike), ce: r.ce?.combined ?? r.ce?.current ?? null, pe: r.pe?.combined ?? r.pe?.current ?? null, highlight: r.isAtm }))} />
          </div>
        </Panel>
      )}

      <div className="grid gap-2.5 md:grid-cols-2">
        {/* 11 — futures */}
        <Panel title="Futures Intelligence">
          {futOk ? (
            <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
              <Stat l="Fut LTP" v={fmt(futOk.fut?.ltp)} />
              <Stat l="Chg" v={fmtPct(futOk.fut?.chgPct)} cls={clsColor(futOk.fut?.chgPct)} />
              <Stat l="Basis" v={fmt(futOk.basis)} cls={clsColor(futOk.basis)} />
              <Stat l="OI Δ2m" v={fmtChg(futOk.fut?.oiChg2m)} />
              <Stat l="OI Δ5m" v={fmtChg(futOk.fut?.oiChg5m)} />
              <Stat l="OI Δ15m" v={fmtChg(futOk.fut?.oiChg15m)} />
              <Stat l="Session ΔOI" v={fmtChg(futOk.fut?.oiSessChg)} />
              <Stat l="Volume" v={fmtInt(futOk.fut?.volume)} />
              <div>
                <div className="text-[9px] uppercase text-grey">Class</div>
                <ClassChip v={futOk.fut?.classification} />
              </div>
              <p className="col-span-2 text-[10px] text-txt-dim sm:col-span-3">{futOk.confirmation}</p>
            </div>
          ) : (
            <NoData compact reason={ws.futures && isUnavailable(ws.futures) ? ws.futures.reason : "Futures unavailable."} code={ws.futures && isUnavailable(ws.futures) ? ws.futures.code : "NO_DATA"} />
          )}
        </Panel>

        {/* 12 — premium momentum (best strikes) */}
        <Panel title="Option Premium Momentum" sub="ATM±3 composite selection — not raw OI/LTP">
          <div className="space-y-2 text-[11px]">
            {[
              { label: "Strongest bullish CE", s: pmOk?.bestCe, tone: "green" as const },
              { label: "Strongest bearish PE", s: pmOk?.bestPe, tone: "red" as const },
            ].map(({ label, s, tone }) =>
              s ? (
                <div key={label} className="pg-panel-2 p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-txt-dim">{label}</span>
                    <Badge tone={tone}>{s.strike} · {fmt(s.ltp)}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.confirmations?.map((c: string) => <span key={c} className="pg-chip text-green border-green/20">{c}</span>)}
                  </div>
                  <div className="mt-1 text-[9.5px] text-grey">prem Δ {fmtPct(s.premChgPct)} · spread {fmt(s.spreadPct, 1)}% · score {s.score}</div>
                </div>
              ) : null,
            )}
            <p className="text-[9.5px] text-grey">{pmOk?.note}</p>
          </div>
        </Panel>
      </div>

      <div className="grid gap-2.5 md:grid-cols-2">
        {/* 13–14 — order flow & buyer/seller evidence */}
        <Panel title="Order Flow & Buyer/Seller Evidence">
          <div className="space-y-1.5 text-[11px]">
            <div className="flex justify-between"><span className="text-txt-dim">Depth imbalance (bid/ask)</span><span className="tnum font-semibold">{ofOk?.imbalance?.ratio ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-txt-dim">CVD</span><span className="text-[10px] text-amber">UNAVAILABLE at this feed tier</span></div>
            <div className="flex justify-between"><span className="text-txt-dim">Buy-side liquidity</span><span className="tnum">{(ofOk?.liquidityMap?.buySide ?? []).map((v: number) => fmt(v)).join(" · ") || "—"}</span></div>
            <div className="flex justify-between"><span className="text-txt-dim">Sell-side liquidity</span><span className="tnum">{(ofOk?.liquidityMap?.sellSide ?? []).map((v: number) => fmt(v)).join(" · ") || "—"}</span></div>
            <div className="mt-1 rounded border border-amber/20 bg-amber/5 p-1.5 text-[9.5px] text-amber/90">{ofOk?.authenticity?.cvd ?? "Order-flow authenticity details unavailable."}</div>
            {ws.dominance?.buyers?.[0] && <div className="text-[10px] text-green">Buyer-dominant evidence: {ws.dominance.buyers[0].evidence?.join(" · ")}</div>}
            {ws.dominance?.sellers?.[0] && <div className="text-[10px] text-red">Seller-dominant evidence: {ws.dominance.sellers[0].evidence?.join(" · ")}</div>}
          </div>
        </Panel>

        {/* 15–16 — targets & reversals */}
        <Panel title="Targets & Reversal Zones">
          {tgOk ? (
            <div className="grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
              <div className="space-y-1">
                {tgOk.upside.map((t: J) => (
                  <div key={t.label} className="flex justify-between"><span className="text-txt-dim">{t.label}</span><span className="tnum font-semibold text-green">{fmt(t.price)}</span></div>
                ))}
              </div>
              <div className="space-y-1">
                {tgOk.downside.map((t: J) => (
                  <div key={t.label} className="flex justify-between"><span className="text-txt-dim">{t.label}</span><span className="tnum font-semibold text-red">{fmt(t.price)}</span></div>
                ))}
              </div>
              <div className="border-t border-border pt-1.5 sm:col-span-2">
                {(tgOk.reversalZones ?? []).map((z: J, i: number) => (
                  <div key={i} className="flex justify-between py-0.5">
                    <span className="text-txt-dim">{z.kind.replaceAll("_", " ")}</span>
                    <span className="tnum">{fmt(z.price)}</span>
                    <Badge tone={z.state === "CONFIRMED_REVERSAL" ? "green" : z.state === "FAILED_REVERSAL" ? "red" : "amber"}>{z.state.replaceAll("_", " ")}</Badge>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <NoData compact reason={ws.targets && isUnavailable(ws.targets) ? ws.targets.reason : "Targets unavailable."} code={ws.targets && isUnavailable(ws.targets) ? ws.targets.code : "NO_DATA"} />
          )}
        </Panel>
      </div>

      {/* 17–20 — trade decision */}
      <Panel title="Trade Decision" sub="Mandatory gates — WAIT when evidence is incomplete" right={ws.fmpi && <EvidenceBars coverage={ws.fmpi.coverage} />}>
        {trade ? (
          <div className="space-y-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={trade.direction === "LONG" ? "green" : "red"}>{trade.direction} {trade.instrumentType} {trade.strike ?? ""} {trade.expiry ?? ""}</Badge>
              <Badge tone="blue">{trade.entryType.replaceAll("_", " ")}</Badge>
              <span className="tnum text-[12px] font-bold">Score {trade.score}</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 sm:gap-2">
              <Stat l="Entry" v={fmt(trade.entry)} />
              <Stat l="Stop" v={fmt(trade.stopLoss)} cls="text-red" />
              <Stat l="T1" v={fmt(trade.target1)} cls="text-green" />
              <Stat l="T2" v={fmt(trade.target2)} cls="text-green" />
              <Stat l="T Ext" v={fmt(trade.targetExt)} cls="text-green" />
              <Stat l="R:R" v={fmt(trade.rr, 1)} cls="text-blue" />
            </div>
            <div className="flex flex-wrap gap-1">{trade.rationale.map((r: string) => <span key={r} className="pg-chip text-green border-green/20">{r}</span>)}</div>
            <p className="text-[10px] text-amber">Invalidation: {trade.invalidation}</p>
          </div>
        ) : (
          <div className="space-y-1.5 text-[11px]">
            <Badge tone="amber">WAIT / NO TRADE</Badge>
            {(ws.trade?.waits ?? []).map((w: J, i: number) => (
              <p key={i} className="text-txt-dim">{w.reason}</p>
            ))}
            {!ws.trade?.waits?.length && <p className="text-txt-dim">Evidence insufficient or conflicting — no forced recommendation.</p>}
          </div>
        )}
        {ws.fmpi && (
          <div className="mt-2 border-t border-border pt-2">
            <div className="flex items-center justify-between text-[10px] text-txt-dim"><span>FMPI {ws.fmpi.value} · {ws.fmpi.acceleration.replaceAll("_", " ")}</span><span>coverage</span></div>
            <FMPIGauge value={ws.fmpi.value} />
            <div className="mt-1"><Meter value={(ws.fmpi.coverage ?? 0) * 100} /></div>
            {ws.fmpi.confirmationRequired?.length > 0 && (
              <p className="mt-1 text-[9.5px] text-grey">Requires: {ws.fmpi.confirmationRequired.join(" · ")}</p>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}

function SRMini({ ws }: { ws: J }) {
  const srBlock = ws.sr && !isUnavailable(ws.sr) ? ws.sr : null;
  const sel = srBlock?.selection;
  const spot = ws.spot?.ltp;
  if (!sel) return <NoData compact reason={ws.sr && isUnavailable(ws.sr) ? ws.sr.reason : "Building S/R zones…"} code={ws.sr && isUnavailable(ws.sr) ? ws.sr.code : "LOADING"} />;
  const Row = ({ label, z, tone }: { label: string; z: J | null; tone: string }) =>
    z ? (
      <div className="flex items-center justify-between py-1 text-[11px]">
        <span className="text-txt-dim">{label}</span>
        <span className={`tnum font-semibold ${tone}`}>{fmt(z.mid)}</span>
        <span className="flex items-center gap-1.5">
          {z.oiOnly && <Badge tone="amber">OI ONLY</Badge>}
          <Badge tone="grey">{z.sources?.[0]?.replaceAll("_", " ")}</Badge>
        </span>
      </div>
    ) : (
      <div className="flex justify-between py-1 text-[11px] text-grey"><span>{label}</span><span>n/a</span></div>
    );
  return (
    <div>
      <Row label="Immediate resistance" z={sel.immediateResistance} tone="text-red" />
      <Row label="Primary resistance" z={sel.primaryResistance} tone="text-red" />
      <div className="my-1 flex items-center justify-between rounded bg-panel2 px-2 py-1">
        <span className="text-[10px] text-grey">SPOT</span>
        <span className="tnum text-[12px] font-bold text-blue">{fmt(spot)}</span>
      </div>
      <Row label="Immediate support" z={sel.immediateSupport} tone="text-green" />
      <Row label="Primary support" z={sel.primarySupport} tone="text-green" />
      <Row label="Major support" z={sel.majorSupport} tone="text-green" />
    </div>
  );
}

function Stat({ l, v, cls = "text-txt" }: { l: string; v: string; cls?: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-grey">{l}</div>
      <div className={`tnum text-[12px] font-semibold ${cls}`}>{v}</div>
    </div>
  );
}
