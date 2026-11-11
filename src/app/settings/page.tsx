"use client";

/** Module 14 — Settings & provider configuration (architecture disclosure) */
import { useState } from "react";
import { useApi, istTime, type J } from "@/lib/client";
import { Panel, Badge, Loading, Empty } from "@/components/ui";
import { Database, Server, ShieldCheck, Wifi } from "lucide-react";
import { UpstoxTokenBox } from "@/components/token-box";
import { useEffect } from "react";

export default function SettingsPage() {
  const { data, refresh } = useApi<J>("/api/settings", 8000);
  const [form, setForm] = useState<J | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data && !form) setForm(data.settings);
  }, [data, form]);

  if (!data || !form) return <Loading label="Loading settings" />;

  const save = async () => {
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
    refresh();
  };

  const Num = ({ k, label }: { k: string; label: string }) => (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-grey">{label}</span>
      <input
        type="number"
        value={form[k] ?? ""}
        onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
        className="mt-0.5 h-7 w-full rounded-md border border-border bg-panel2 px-2 text-[11.5px] tnum outline-none focus:border-blue/60"
      />
    </label>
  );

  return (
    <div className="space-y-2.5">
      <div className="grid gap-2.5 lg:grid-cols-2">
        <Panel title={<span className="flex items-center gap-1.5"><Server className="h-3 w-3 text-blue" />Provider configuration</span>}>
          <div className="space-y-2 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-txt-dim">Active provider</span>
              <Badge tone={data.provider.mode === "UPSTOX" ? "green" : "amber"}>{data.provider.mode}</Badge>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="text-txt-dim">Upstox access token</span>
              <span className="flex items-center gap-1.5 text-[10.5px]">
                <Wifi className={`h-3 w-3 ${data.provider.upstoxVerified ? "text-green" : data.provider.upstoxConfigured ? "text-amber" : "text-grey"}`} />
                {data.provider.upstoxConfigured ? (
                  <span className="font-mono">{data.provider.upstoxMasked} <span className="font-sans text-grey">({data.provider.upstoxSource})</span></span>
                ) : (
                  "not configured"
                )}
              </span>
            </div>
            {data.provider.upstoxAccount && (
              <div className="flex items-center justify-between">
                <span className="text-txt-dim">Account</span>
                <span className="text-[10.5px]">{data.provider.upstoxAccount}</span>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-txt-dim">Manage credential</span>
              <UpstoxTokenBox />
            </div>
            <p className="rounded border border-amber/20 bg-amber/5 p-2 text-[10px] leading-snug text-amber/90">{data.provider.disclosure}</p>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-grey">Integrated Upstox surfaces</div>
              <div className="flex flex-wrap gap-1">
                {(data.provider.endpoints ?? []).map((e: string) => <span key={e} className="pg-chip">{e}</span>)}
              </div>
            </div>
            <p className="flex items-center gap-1.5 text-[9.5px] text-grey">
              <ShieldCheck className="h-3 w-3 text-green" /> Tokens are read from server environment variables only — never browser storage, URLs, responses or client logs.
            </p>
          </div>
        </Panel>

        <Panel title={<span className="flex items-center gap-1.5"><Database className="h-3 w-3 text-blue" />Engine & data quality</span>}>
          <div className="grid grid-cols-2 gap-2">
            <Num k="oiSamplingSec" label="OI sampling (sec)" />
            <Num k="oiMatchToleranceSec" label="Rolling match tolerance (sec)" />
            <Num k="atmWindow" label="ATM window (± strikes)" />
            <Num k="volumeBreakoutRvol" label="Volume-breakout RVOL" />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[10px] text-grey">DB: {data.db ? <span className="text-green">connected</span> : <span className="text-red">unreachable</span>} · instruments {data.engine?.instruments} · engine ticks {data.engine?.ticks?.toLocaleString("en-IN")}</span>
            <button onClick={save} className="h-7 rounded-md bg-blue/90 px-3 text-[11px] font-semibold text-bg hover:bg-blue">
              {saved ? "Saved ✓" : "Save"}
            </button>
          </div>
          <div className="mt-2 space-y-1 text-[9.5px] leading-snug text-grey">
            <p>Freshness: <b className="text-green">LIVE</b> &lt;15s · <b className="text-amber">DELAYED</b> &lt;120s · <b className="text-amber">STALE</b> aged · <b className="text-grey">HISTORICAL</b> prior sessions · <b className="text-red">UNAVAILABLE</b>.</p>
            <p>Stale data invalidates dependent real-time claims. Delayed/historical data is never silently substituted for live.</p>
            <p>Last engine tick: {data.engine?.lastTickAt ? istTime(data.engine.lastTickAt) : "—"}</p>
          </div>
        </Panel>
      </div>

      <Panel title="Architecture disclosure & known limitations">
        <div className="grid gap-2 text-[10.5px] leading-relaxed text-txt-dim md:grid-cols-2">
          <ul className="list-disc space-y-1 pl-4">
            <li>Computation: TypeScript intelligence engine inside the Next.js runtime (single shared engine consumed by all 14 modules via typed APIs + SSE channel).</li>
            <li>Persistence: PostgreSQL (Drizzle) — observations, baselines, candles, scanner results, trade candidates, alerts, watchlists, settings.</li>
            <li>Real-time transport: Server-Sent Events channel (<code>/api/stream</code>) — quotes + alerts, with reconnect.</li>
            <li>Without Upstox credentials the engine runs on a disclosed SIM market twin (internally consistent spot/futures/options/OI). Every payload carries provider provenance and freshness.</li>
          </ul>
          <ul className="list-disc space-y-1 pl-4">
            <li>Greeks/IV are transparently modelled (Black–Scholes on a smile surface) unless provider-supplied; the chain table labels them.</li>
            <li>CVD shown as ESTIMATED (tick-rule). Footprint and true per-price executed volume: UNAVAILABLE at this feed tier — never fabricated.</li>
            <li>OI-only zones never become confirmed S/R without price-action evidence; strength scores are confluence scores, not probabilities.</li>
            <li>Historical validation harness lives in <code>src/lib/engine/tests.ts</code> (npm run via tsx); production accuracy claims are made only after out-of-sample runs.</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
