"use client";

/** Module 8 — Chart Intelligence (candles + indicators + S/R overlays + FMPI pane) */
import { useMemo, useState } from "react";
import { useApi, useApp, useBreakpoint, fmt, type J } from "@/lib/client";
import { Panel, Badge, Loading, SymbolPicker, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { CandleChart, overlaysFromLevels, overlaysFromProfile, type SROverlay } from "@/components/charts";
import { SRIntelligencePanel } from "@/components/sr-panel";

const TFS = ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "1h", "1D"];

const RANGES = [
  { d: 1, label: "1D" },
  { d: 3, label: "3D" },
  { d: 5, label: "5D" },
  { d: 7, label: "7D" },
];

export default function ChartsPage() {
  const { symbol, tf, setTf } = useApp();
  const { isMobile, isTablet } = useBreakpoint();
  const [days, setDays] = useState(7);
  const [showVP, setShowVP] = useState(true);
  const { data: cd } = useApi<J>(`/api/candles?symbol=${symbol}&tf=${tf}&days=${days}`, 8000);
  const srTf = tf === "1D" ? "15m" : tf;
  const { data: sr } = useApi<J>(`/api/intel/sr?symbol=${symbol}&tf=${srTf}`, 10000);
  const { data: lv } = useApi<J>(`/api/intel/sr-levels?symbol=${symbol}&tf=${srTf}`, 7000);
  const { data: fs } = useApi<J>(`/api/intel/fmpi-series?symbol=${symbol}&tf=${tf === "1D" ? "15m" : tf}`, 15000);

  const srOk = sr && !isUnavailable(sr) ? sr : null;
  const lvOk = lv && !isUnavailable(lv) ? lv : null;
  // Chart overlays are derived from the SAME unified engine payload the panel
  // renders — the two can never disagree.
  const overlays: SROverlay[] = useMemo(() => {
    const out = overlaysFromLevels(lvOk?.levels);
    if (showVP) out.push(...overlaysFromProfile(lvOk?.volumeProfile));
    // OI-only candidates stay visually distinct and are never promoted
    for (const z of srOk?.zones ?? []) {
      if (z.oiOnly && Math.abs(z.mid - (srOk?.spot ?? 0)) / Math.max(srOk?.spot ?? 1, 1) < 0.02)
        out.push({ price: z.mid, color: "rgba(240,185,11,0.5)", title: `OI ${z.mid}`, style: "dotted", width: 1 });
    }
    return out.slice(0, 10);
  }, [lvOk, srOk, showVP]);

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-2">
          <SymbolPicker />
          <div className="flex max-w-full gap-0.5 overflow-x-auto rounded-md border border-border bg-panel2 p-0.5">
            {TFS.map((t) => (
              <button
                key={t}
                onClick={() => setTf(t)}
                className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${tf === t ? "bg-blue/15 text-blue" : "text-txt-dim hover:text-txt"}`}
              >
                {t}
              </button>
            ))}
          </div>
          {tf !== "1D" && (
            <div className="flex gap-0.5 rounded-md border border-border bg-panel2 p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.d}
                  onClick={() => setDays(r.d)}
                  title={`Last ${r.d} trading session${r.d === 1 ? "" : "s"}`}
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${days === r.d ? "bg-amber/15 text-amber" : "text-txt-dim hover:text-txt"}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          <span className="ml-auto flex items-center gap-2 text-[10px]">
            {cd && !isUnavailable(cd) && cd.historical && (
              <Badge tone="grey">CLOSED · latest session {cd.sessionDate}</Badge>
            )}
            <button
              onClick={() => setShowVP((v) => !v)}
              title="Volume Profile levels on the spot price scale"
              className={`rounded border px-1.5 py-0.5 text-[9.5px] font-semibold transition-colors ${showVP ? "border-blue/40 bg-blue/10 text-blue" : "border-border bg-panel2 text-grey"}`}
            >
              VP
            </button>
            {lvOk?.volumeProfile?.source === "FUTURES_DERIVED_SPOT_MAPPED" && (
              <Badge tone="amber">FUT-DERIVED · SPOT-MAPPED</Badge>
            )}
            <Badge tone="blue">FMPI below chart</Badge>
            <FreshnessDot f={cd ? "LIVE" : "UNAVAILABLE"} />
          </span>
        </div>
      </Panel>

      <div className="flex flex-col gap-2.5 xl:flex-row">
        <Panel
          title={`${symbol} · ${tf}`}
          sub={
            cd && !isUnavailable(cd)
              ? `${cd.sessionsShown ?? 0} trading session(s) · ${cd.candles?.length ?? 0} bars · EMA 9/21/34/200 · BB(20,2) · volume · S/R lines · FMPI pane`
              : "EMA 9/21/34/200 · VWAP · BB(20,2) · volume · S/R price lines · FMPI pane"
          }
          pad={false}
          className="min-w-0 flex-[3] overflow-hidden"
        >
          <div className="p-2">
            {cd && isUnavailable(cd) ? (
              <NoData reason={cd.reason} code={cd.code} />
            ) : (
              <CandleChart data={cd} height={isMobile ? 360 : isTablet ? 440 : 520} overlays={overlays} fmpi={fs && !isUnavailable(fs) ? fs.points : null} />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[9.5px] text-txt-dim">
            <span><i className="mr-1 inline-block h-1.5 w-3 bg-blue align-middle" />EMA9</span>
            <span><i className="mr-1 inline-block h-1.5 w-3 bg-amber align-middle" />EMA21 / VWAP (dashed)</span>
            <span><i className="mr-1 inline-block h-1.5 w-3 bg-[#8b5cf6] align-middle" />EMA34</span>
            <span><i className="mr-1 inline-block h-1.5 w-3 bg-grey align-middle" />EMA200</span>
            <span className="ml-auto">ATR(14) <b className="tnum text-txt">{fmt(cd && !isUnavailable(cd) ? cd.indicators?.atr14 : null)}</b> · VWAP <b className="tnum text-txt">{fmt(cd && !isUnavailable(cd) ? cd.indicators?.vwap : null)}</b></span>
          </div>
        </Panel>

        <div className="flex-1 space-y-2.5">
          <Panel title="All zones" sub={`${srOk?.zones?.length ?? 0} zones · nearest to price`}>
            <div className="space-y-1 text-[11px]">
              {sr && isUnavailable(sr) && <NoData compact reason={sr.reason} code={sr.code} />}
              {(srOk?.zones ?? [])
                .filter((z: J) => !z.oiOnly)
                .sort((a: J, b: J) => Math.abs(a.mid - (srOk?.spot ?? 0)) - Math.abs(b.mid - (srOk?.spot ?? 0)))
                .slice(0, 7)
                .map((z: J) => (
                  <div key={z.id} className="flex items-center justify-between gap-1">
                    <span className={`text-[10px] font-semibold ${z.side === "SUPPORT" ? "text-green" : "text-red"}`}>{z.side === "SUPPORT" ? "S" : "R"}</span>
                    <span className="tnum font-semibold">{fmt(z.mid)}</span>
                    <span className="truncate text-[9px] text-grey">{z.sources.join(",").replaceAll("_", " ").toLowerCase()}</span>
                    <span className="tnum text-[9.5px] text-blue">{z.strength}</span>
                  </div>
                ))}
              {srOk?.note && <p className="pt-1 text-[8.5px] leading-snug text-grey">{srOk.note}</p>}
            </div>
          </Panel>
          <Panel title="OI-derived candidates" sub="kept visually distinct — never promoted without price evidence">
            <div className="space-y-1 text-[11px]">
              {(srOk?.zones ?? []).filter((z: J) => z.oiOnly).slice(0, 5).map((z: J) => (
                <div key={z.id} className="flex items-center justify-between">
                  <span className="text-[10px] text-amber">{z.sources[0]?.replaceAll("_", " ")}</span>
                  <span className="tnum font-semibold">{fmt(z.mid)}</span>
                  <Badge tone="amber">OI ONLY</Badge>
                </div>
              ))}
              {(srOk?.zones ?? []).filter((z: J) => z.oiOnly).length === 0 && <span className="text-[10.5px] text-grey">No OI-only zones near price</span>}
            </div>
          </Panel>
        </div>
      </div>

      {/* Dynamic S/R Intelligence — immediately below the price chart */}
      <SRIntelligencePanel data={lv} tf={srTf} />
    </div>
  );
}
