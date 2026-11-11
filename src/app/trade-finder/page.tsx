"use client";

/** Module 2 — Unified Trade Finder (evidence-gated decision engine) */
import { useApi, fmt, fmtPct, clsColor, type J } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, EvidenceBars, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { useApp } from "@/lib/client";
import { ShieldAlert, Crosshair } from "lucide-react";

function TradeCard({ t, onOpen }: { t: J; onOpen: () => void }) {
  const long = t.direction === "LONG";
  return (
    <button onClick={onOpen} className="pg-panel-2 w-full border-l-2 p-2.5 text-left transition-colors hover:border-t hover:border-r hover:border-b hover:border-border" style={{ borderLeftColor: long ? "#16c784" : "#ea3943" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <span className="text-[9px] font-bold text-grey">#{t.rank}</span>
          <span className="text-[12px] font-bold text-txt">{t.symbol}</span>
          <Badge tone={long ? "green" : "red"}>{t.instrumentType}{t.strike ? ` ${t.strike}` : ""}</Badge>
          <Badge tone="grey">{t.entryType.replaceAll("_", " ")}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <EvidenceBars coverage={t.coverage} />
          <span className="flex items-center gap-1"><Badge tone={t.status === "ACTIONABLE" ? "green" : "amber"}>{t.status}</Badge><span className="tnum text-[12px] font-bold text-blue">{t.score}</span></span>
        </div>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-1 text-center sm:grid-cols-5">
        {[
          ["Entry", fmt(t.entry), "text-txt"],
          ["Stop", fmt(t.stopLoss), "text-red"],
          ["T1", t.target1 == null ? "N/A" : fmt(t.target1), "text-green"],
          ["T2", t.target2 == null ? "N/A" : fmt(t.target2), "text-green"],
          ["R:R", t.rr == null ? "N/A" : fmt(t.rr, 1), "text-blue"],
        ].map(([l, v, c]) => (
          <div key={l} className="rounded bg-panel px-1 py-1">
            <div className="text-[8.5px] uppercase text-grey">{l}</div>
            <div className={`tnum text-[11px] font-semibold ${c}`}>{v}</div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[9.5px]">
        <span className={`pg-chip ${t.fmpiConfirmed ?? true ? "" : ""}`}>FMPI <b className={clsColor(t.fmpi)}>{t.fmpi?.toFixed(0)}</b></span>
        <span
          title={t.oiConfirmationDetail}
          className={`pg-chip ${
            t.oiConfirmation === "CONFIRMED" ? "text-green border-green/25" : t.oiConfirmation === "CONTRADICTS" ? "text-red border-red/25" : "text-grey"
          }`}
        >
          OI {t.oiConfirmation === "CONFIRMED" ? "✓" : t.oiConfirmation === "CONTRADICTS" ? "✕" : "?"}
        </span>
        <span className={`pg-chip ${t.dataCoverage === "COMPLETE" ? "text-green border-green/25" : "text-amber border-amber/25"}`}>{t.dataCoverage}</span>
        {t.deltaSource === "UNAVAILABLE" && <span className="pg-chip text-amber border-amber/25">NO DELTA</span>}
        {t.structure && <span className="pg-chip">STRUCT {t.structure}</span>}
        <FreshnessDot f={t.freshness} />
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {(t.rationale ?? []).slice(0, 3).map((r: string) => (
          <span key={r} className="rounded bg-panel px-1.5 py-0.5 text-[9px] text-txt-dim">{r}</span>
        ))}
      </div>
      <div className="mt-1 truncate text-[9px] text-amber/80">✕ {t.invalidation}</div>
    </button>
  );
}

export default function TradeFinderPage() {
  const { data } = useApi<J>("/api/trade-finder", 6000);
  const { openWorkspace } = useApp();
  if (!data) return <Loading label="Scanning all eligible F&O instruments" />;
  if (isUnavailable(data)) return <Panel title="Trade Finder"><NoData reason={data.reason} code={data.code} /></Panel>;

  const Column = ({ title, list, icon }: { title: string; list: J[]; icon: React.ReactNode }) => (
    <Panel
      title={<span className="flex items-center gap-1.5">{icon}{title}</span>}
      right={<Badge tone="grey">{list.length} candidate{list.length === 1 ? "" : "s"}</Badge>}
      className="flex-1"
    >
      <div className="space-y-2">
        {list.length === 0 && (
          <div className="flex h-32 flex-col items-center justify-center gap-1 text-center">
            <ShieldAlert className="h-5 w-5 text-amber/60" />
            <span className="text-[11px] font-semibold text-amber">WAIT / NO TRADE</span>
            <span className="max-w-[240px] text-[9.5px] text-grey">No {title.toLowerCase()} satisfies the mandatory evidence gates. The engine refuses to force candidates.</span>
          </div>
        )}
        {list.map((t) => (
          <TradeCard key={t.contractKey + t.category} t={t} onOpen={() => openWorkspace(t.symbol)} />
        ))}
      </div>
    </Panel>
  );

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[10.5px]">
          <span className="flex items-center gap-1.5 text-txt"><Crosshair className="h-3.5 w-3.5 text-blue" /><b>Unified Trade Finder</b></span>
          <span className="text-txt-dim">{data.waitSummary}</span>
          <span className="text-grey">
            ACTIONABLE requires: LIVE data · COMPLETE coverage · real contract key · provider delta · directional OI confirmation · aligned structure · RR ≥ 1.5
          </span>
          {data.counts && (
            <span className="ml-auto flex gap-1.5">
              <Badge tone="green">{data.counts.actionable} actionable</Badge>
              <Badge tone="amber">{data.counts.watch} watch</Badge>
              <Badge tone="grey">{data.counts.rejected} rejected</Badge>
            </span>
          )}
        </div>
      </Panel>
      <div className="flex flex-col gap-2.5 xl:flex-row">
        <Column title="Bullish candidates" list={data.bullish ?? []} icon={<span className="h-2 w-2 rounded-full bg-green" />} />
        <Column title="Bearish candidates" list={data.bearish ?? []} icon={<span className="h-2 w-2 rounded-full bg-red" />} />
      </div>
      {(data.watch ?? []).length > 0 && (
        <Panel
          title="Watch — passed hard gates, NOT actionable"
          sub="shown separately so a watch candidate is never read as a trade"
          right={<Badge tone="amber">{data.watch.length}</Badge>}
        >
          <div className="grid gap-2 lg:grid-cols-2">
            {data.watch.map((t: J) => (
              <TradeCard key={`${t.contractKey}-${t.category}`} t={t} onOpen={() => openWorkspace(t.symbol)} />
            ))}
          </div>
        </Panel>
      )}
      {(data.wait ?? []).length > 0 && (
        <Panel title="Watch / incomplete evidence" sub="Symbols evaluated this cycle that did not pass all gates">
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {data.wait.map((w: J, i: number) => (
              <button key={i} onClick={() => openWorkspace(w.symbol)} className="pg-panel-2 p-2 text-left hover:border-amber/40">
                <div className="flex items-center justify-between"><span className="text-[11px] font-bold">{w.symbol}</span><Badge tone="amber">WATCH</Badge></div>
                <p className="mt-0.5 text-[9.5px] leading-snug text-grey">{w.reason}</p>
              </button>
            ))}
          </div>
        </Panel>
      )}
      <div className="flex justify-between text-[9.5px] text-grey">
        <span>Ranking = evidence quality (not a probability — scores are uncalibrated)</span>
        <span>{fmtPct(undefined) === "—" ? "" : ""}updated {new Date(data.ts).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
