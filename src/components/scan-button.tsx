"use client";

/**
 * Manual "Scan" control. Automatic collection runs on a 30s cadence in the
 * backend worker; this forces an immediate refresh and reports when the last
 * successful scan happened.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Check, AlertTriangle } from "lucide-react";

export function ScanButton({ symbol, onDone }: { symbol?: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [age, setAge] = useState(0);
  const inflight = useRef(false);

  const scan = useCallback(
    async (manual: boolean) => {
      if (inflight.current) return;
      inflight.current = true;
      if (manual) setBusy(true);
      try {
        const url = `/api/scan${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ""}`;
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" } });
        const j = await r.json();
        if (!r.ok || j.available === false) setErr(j.reason ?? j.error ?? "Scan failed");
        else {
          setErr(null);
          setLastAt(Date.now());
          onDone?.();
        }
      } catch {
        setErr("Network error");
      } finally {
        inflight.current = false;
        setBusy(false);
      }
    },
    [symbol, onDone],
  );

  // automatic 30s refresh
  useEffect(() => {
    if (!auto) return;
    const iv = setInterval(() => void scan(false), 30_000);
    return () => clearInterval(iv);
  }, [auto, scan]);

  useEffect(() => {
    const iv = setInterval(() => setAge(lastAt ? Math.round((Date.now() - lastAt) / 1000) : 0), 1000);
    return () => clearInterval(iv);
  }, [lastAt]);

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => void scan(true)}
        disabled={busy}
        title="Fetch live data now"
        className="flex h-7 items-center gap-1.5 rounded-md border border-blue/30 bg-blue/10 px-2 text-[10.5px] font-semibold text-blue transition-colors hover:bg-blue/20 disabled:opacity-50"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        <span className="hidden sm:inline">{busy ? "Scanning…" : "Scan"}</span>
      </button>
      <button
        onClick={() => setAuto((a) => !a)}
        title={auto ? "Auto-refresh every 30s (on)" : "Auto-refresh off"}
        className={`h-7 rounded-md border px-1.5 text-[9.5px] font-semibold transition-colors ${
          auto ? "border-green/30 bg-green/10 text-green" : "border-border bg-panel2 text-grey"
        }`}
      >
        AUTO 30s
      </button>
      {err ? (
        <span className="hidden items-center gap-1 text-[9.5px] text-amber md:flex">
          <AlertTriangle className="h-3 w-3" />
          {err.slice(0, 40)}
        </span>
      ) : lastAt ? (
        <span className="hidden items-center gap-1 text-[9.5px] text-grey md:flex">
          <Check className="h-3 w-3 text-green" />
          {age}s ago
        </span>
      ) : null}
    </div>
  );
}
