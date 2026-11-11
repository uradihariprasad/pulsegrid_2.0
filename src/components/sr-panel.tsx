"use client";

/**
 * Dynamic S/R Intelligence panel — renders the SAME unified engine output that
 * drives the chart overlays. It performs no S/R calculation of its own, so the
 * price, zone band, strength, classification and lifecycle shown here are
 * byte-identical to the lines on the chart.
 */
import { fmt, fmtPct, type J } from "@/lib/client";
import { Panel, Badge, NoData, isUnavailable } from "@/components/ui";
import { ShieldCheck, TrendingDown, TrendingUp, Minus, AlertTriangle, XCircle } from "lucide-react";

const LIFECYCLE_META: Record<string, { tone: "green" | "red" | "amber" | "grey" | "blue"; icon: React.ReactNode; text: string }> = {
  STRENGTHENING: { tone: "green", icon: <TrendingUp className="h-3 w-3" />, text: "Strengthening" },
  STABLE: { tone: "blue", icon: <Minus className="h-3 w-3" />, text: "Stable" },
  WEAKENING: { tone: "amber", icon: <TrendingDown className="h-3 w-3" />, text: "Weakening" },
  BREAKOUT_RISK: { tone: "amber", icon: <AlertTriangle className="h-3 w-3" />, text: "Breakout risk" },
  BREAKDOWN_RISK: { tone: "amber", icon: <AlertTriangle className="h-3 w-3" />, text: "Breakdown risk" },
  BROKEN: { tone: "grey", icon: <XCircle className="h-3 w-3" />, text: "Broken" },
  INVALIDATED: { tone: "grey", icon: <XCircle className="h-3 w-3" />, text: "Invalidated" },
};

const CLASS_TONE: Record<string, string> = {
  VERY_STRONG: "text-green",
  STRONG: "text-green",
  MODERATE: "text-amber",
  WEAK: "text-red",
  VERY_WEAK: "text-red",
  INSUFFICIENT_DATA: "text-grey",
};

const ROLE_LABEL: Record<string, string> = {
  IMMEDIATE_RESISTANCE: "Immediate Resistance",
  PRIMARY_RESISTANCE: "Primary Resistance",
  IMMEDIATE_SUPPORT: "Immediate Support",
  PRIMARY_SUPPORT: "Primary Support",
};

function StrengthBar({ score, side, lifecycle }: { score: number | null; side: string; lifecycle: string }) {
  const muted = lifecycle === "WEAKENING" || lifecycle === "BREAKOUT_RISK" || lifecycle === "BREAKDOWN_RISK" || lifecycle === "BROKEN";
  const base = side === "RESISTANCE" ? (muted ? "bg-red/40" : "bg-red") : muted ? "bg-green/40" : "bg-green";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel2">
      {score == null ? (
        <div className="h-full w-full bg-grey/20" />
      ) : (
        <div className={`h-full rounded-full ${base} transition-all duration-500`} style={{ width: `${score}%` }} />
      )}
    </div>
  );
}

function EvidenceRow({ c }: { c: J }) {
  if (!c) return null;
  const pct = c.available ? Math.round(c.value * 100) : null;
  return (
    <div className="flex items-start gap-1.5 py-[2px]">
      <span className={`mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${!c.available ? "bg-grey/50" : c.value >= 0.6 ? "bg-green" : c.value <= 0.4 ? "bg-red" : "bg-amber"}`} />
      <span className="w-[104px] shrink-0 text-[9.5px] text-txt-dim">{c.label}</span>
      <span className="w-8 shrink-0 text-right text-[9.5px] tnum font-semibold text-txt">{pct == null ? "N/A" : `${pct}%`}</span>
      <span className="min-w-0 flex-1 truncate text-[9px] text-grey" title={c.detail}>
        {c.detail}
      </span>
    </div>
  );
}

function LevelCard({ level, role }: { level: J | null; role: string }) {
  const isRes = role.includes("RESISTANCE");
  const accent = isRes ? "border-l-red/60" : "border-l-green/60";
  if (!level) {
    return (
      <div className={`pg-panel-2 border-l-2 ${accent} p-2.5`}>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-txt-dim">{ROLE_LABEL[role]}</span>
          <Badge tone="grey">N/A</Badge>
        </div>
        <p className="mt-2 text-[9.5px] leading-snug text-grey">
          No distinct, valid {isRes ? "resistance above" : "support below"} price in the analysed window. Nothing is shown rather than inventing a level.
        </p>
      </div>
    );
  }
  const lc = LIFECYCLE_META[level.lifecycle] ?? LIFECYCLE_META.STABLE;
  const score = level.smoothedScore ?? level.score;
  const muted = level.lifecycle === "WEAKENING" || level.lifecycle === "BROKEN" || level.lifecycle === "INVALIDATED";
  const defender = isRes ? "Seller" : "Buyer";
  return (
    <div className={`pg-panel-2 border-l-2 ${accent} p-2.5 ${muted ? "opacity-90" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-txt-dim">{ROLE_LABEL[role]}</span>
        <Badge tone={lc.tone}>
          <span className="flex items-center gap-1">
            {lc.icon}
            {lc.text}
          </span>
        </Badge>
      </div>

      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className={`tnum text-[16px] font-bold ${isRes ? "text-red" : "text-green"}`}>{fmt(level.price)}</span>
        <span className="text-right">
          <span className={`tnum text-[14px] font-bold ${CLASS_TONE[level.classification] ?? "text-grey"}`}>
            {score == null ? "—" : `${score}%`}
          </span>
          <span className="ml-1 text-[9px] font-semibold text-txt-dim">{level.classification.replaceAll("_", " ")}</span>
        </span>
      </div>
      <div className="mt-1">
        <StrengthBar score={score} side={level.side} lifecycle={level.lifecycle} />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px] text-grey">
        <span>
          zone {fmt(level.zoneLow)}–{fmt(level.zoneHigh)}
        </span>
        <span>{level.distancePct > 0 ? "+" : ""}{level.distancePct}% away</span>
        <span>{level.touches} test(s)</span>
        {level.scoreDelta != null && (
          <span className={level.scoreDelta > 0 ? "text-green" : level.scoreDelta < 0 ? "text-red" : ""}>
            Δ{level.scoreDelta > 0 ? "+" : ""}
            {level.scoreDelta} pts
          </span>
        )}
        {level.oiOnly && <Badge tone="amber">OI ONLY</Badge>}
      </div>

      <div className="mt-2 border-t border-border pt-1.5">
        <EvidenceRow c={level.evidence?.oi} />
        <EvidenceRow c={level.evidence?.priceAction} />
        <EvidenceRow c={level.evidence?.volumeProfile} />
        <EvidenceRow c={level.evidence?.volume} />
        <EvidenceRow c={level.evidence?.testQuality} />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 border-t border-border pt-1.5">
        <span className="flex items-center gap-1 text-[9px] text-txt-dim">
          <ShieldCheck className="h-3 w-3" />
          {defender} defence: {level.lifecycle === "STRENGTHENING" ? "improving" : level.lifecycle === "WEAKENING" ? "declining" : "steady"}
        </span>
        <span
          className={`text-[9px] font-semibold ${
            level.risk.label === "ELEVATED" ? "text-red" : level.risk.label === "MODERATE" ? "text-amber" : "text-txt-dim"
          }`}
        >
          {level.risk.kind} risk score {level.risk.score}/100 · {level.risk.label}
        </span>
        <Badge tone={level.coverageState === "COMPLETE" ? "green" : level.coverageState === "INSUFFICIENT_DATA" ? "red" : "amber"}>
          {level.coverageState.replaceAll("_", " ")} {Math.round((level.coverage ?? 0) * 100)}%
        </Badge>
      </div>

      <p className="mt-1.5 text-[9px] leading-snug text-grey">{level.explanation}</p>
    </div>
  );
}

export function SRIntelligencePanel({ data, tf }: { data: J | null; tf?: string }) {
  if (!data) return <Panel title="Dynamic S/R Intelligence"><NoData code="LOADING" reason="Computing levels…" /></Panel>;
  if (isUnavailable(data))
    return (
      <Panel title="Dynamic S/R Intelligence">
        <NoData reason={data.reason} code={data.code} />
      </Panel>
    );

  const dc = data.dataCoverage ?? {};
  const vp = data.volumeProfile ?? null;
  return (
    <Panel
      title={`Dynamic S/R Intelligence — ${data.symbol}${tf ? ` · ${tf}` : ""}`}
      sub={`spot ${fmt(data.spot)} · ${data.evaluatedZones} zones evaluated · same engine output as the chart overlays`}
      right={
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={dc.level === "COMPLETE" ? "green" : dc.level === "UNAVAILABLE" ? "red" : "amber"}>DATA {dc.level}</Badge>
          {!dc.optionChain && <Badge tone="amber">NO CHAIN</Badge>}
          {!dc.volumeProfile && <Badge tone="amber">NO PROFILE</Badge>}
          {vp && <Badge tone={vp.source === "FUTURES_DERIVED_SPOT_MAPPED" ? "amber" : "green"}>{vp.sourceLabel}</Badge>}
          {!dc.futures && <Badge tone="amber">NO FUTURES</Badge>}
        </span>
      }
    >
      <div className="grid gap-2 lg:grid-cols-2 2xl:grid-cols-4">
        <LevelCard level={data.immediateResistance} role="IMMEDIATE_RESISTANCE" />
        <LevelCard level={data.primaryResistance} role="PRIMARY_RESISTANCE" />
        <LevelCard level={data.immediateSupport} role="IMMEDIATE_SUPPORT" />
        <LevelCard level={data.primarySupport} role="PRIMARY_SUPPORT" />
      </div>
      {vp && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border bg-panel2 px-2 py-1.5 text-[9.5px]">
          <span className="font-semibold text-txt-dim">Volume Profile</span>
          <span className="text-blue">POC {fmt(vp.poc)}</span>
          <span className="text-txt-dim">VAH {fmt(vp.vah)}</span>
          <span className="text-txt-dim">VAL {fmt(vp.val)}</span>
          {vp.hvn?.length > 0 && <span className="text-[#8b5cf6]">HVN {vp.hvn.map((h: number) => fmt(h)).join(" / ")}</span>}
          {vp.lvn?.length > 0 && <span className="text-amber">LVN {vp.lvn.map((l: number) => fmt(l)).join(" / ")}</span>}
          {vp.source === "FUTURES_DERIVED_SPOT_MAPPED" && (
            <span className="text-grey">
              source {vp.sourceExpiry} FUT · basis {vp.basis >= 0 ? "+" : ""}
              {vp.basis} · spot-mapped
            </span>
          )}
          {vp.sessionDate && <span className="text-grey">session {vp.sessionDate}</span>}
        </div>
      )}
      <p className="mt-2 text-[9px] leading-snug text-grey">{data.note}</p>
    </Panel>
  );
}

export { fmtPct };
