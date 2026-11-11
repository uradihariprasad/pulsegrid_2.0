"use client";

/**
 * Upstox token control — top-left of the header.
 * The token is POSTed once to the backend vault and never read back:
 * the UI only ever receives a masked fingerprint + verification status.
 */
import { useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, ShieldCheck, ShieldAlert, X, RefreshCw, Trash2, Eye, EyeOff } from "lucide-react";

interface Status {
  configured: boolean;
  source: "ENV" | "VAULT" | "NONE";
  masked: string | null;
  savedAt: string | null;
  lastVerifiedAt: string | null;
  lastCheckOk: boolean | null;
  userName: string | null;
  message: string | null;
  providerMode: "UPSTOX" | "SIM";  // SIM == not connected; no data is served
}

export function UpstoxTokenBox() {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"save" | "check" | "clear" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const r = await fetch("/api/provider/token", { cache: "no-store" });
      setStatus(await r.json());
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const save = async () => {
    if (!token.trim()) return;
    setBusy("save");
    setErr(null);
    try {
      const r = await fetch("/api/provider/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j.error ?? "Could not save token");
      else {
        setStatus(j);
        setToken("");
        setOpen(false);
        // Kick an immediate scan so the first data lands within seconds, then
        // re-render the whole app once the store has had a moment to warm.
        void fetch("/api/scan", { method: "POST" }).catch(() => undefined);
        setTimeout(() => window.location.reload(), 1600);
      }
    } catch {
      setErr("Network error while saving");
    }
    setBusy(null);
  };

  const recheck = async () => {
    setBusy("check");
    try {
      const r = await fetch("/api/provider/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revalidate" }),
      });
      setStatus(await r.json());
    } catch {
      /* ignore */
    }
    setBusy(null);
  };

  const clear = async () => {
    setBusy("clear");
    try {
      const r = await fetch("/api/provider/token", { method: "DELETE" });
      setStatus(await r.json());
    } catch {
      /* ignore */
    }
    setBusy(null);
  };

  const live = status?.providerMode === "UPSTOX";
  const pending = !!status?.configured && !live;
  const tone = live ? "text-green border-green/30 bg-green/10" : pending ? "text-amber border-amber/30 bg-amber/10" : "text-grey border-border bg-panel2";
  const label = live ? "UPSTOX LIVE" : pending ? "TOKEN UNVERIFIED" : "ADD UPSTOX TOKEN";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Upstox access token"
        className={`flex h-7 items-center gap-1.5 rounded-md border px-1.5 text-[10px] font-semibold transition-colors hover:brightness-125 sm:px-2 ${tone}`}
      >
        {live ? <ShieldCheck className="h-3.5 w-3.5 shrink-0" /> : pending ? <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> : <KeyRound className="h-3.5 w-3.5 shrink-0" />}
        <span className="hidden whitespace-nowrap sm:inline">{label}</span>
        {status?.masked && <span className="hidden font-mono text-[9px] opacity-70 lg:inline">{status.masked}</span>}
      </button>

      {open && (
        <div className="fixed inset-x-2 top-14 z-[60] rounded-lg border border-border bg-panel p-3 shadow-2xl sm:absolute sm:inset-x-auto sm:left-0 sm:top-9 sm:w-[340px]">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11.5px] font-bold text-txt">
              <KeyRound className="h-3.5 w-3.5 text-blue" /> Upstox Access Token
            </span>
            <button onClick={() => setOpen(false)} className="rounded p-0.5 text-grey hover:text-txt">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mb-2 rounded border border-border bg-panel2 p-2 text-[10px]">
            <div className="flex items-center justify-between">
              <span className="text-grey">Status</span>
              <span className={live ? "font-semibold text-green" : status?.configured ? "font-semibold text-amber" : "text-grey"}>
                {live ? "Connected — live data" : status?.configured ? "Stored, not verified" : "Not configured"}
              </span>
            </div>
            {status?.masked && (
              <div className="mt-0.5 flex items-center justify-between">
                <span className="text-grey">Token</span>
                <span className="font-mono text-txt-dim">{status.masked} <span className="text-grey">({status.source})</span></span>
              </div>
            )}
            {status?.userName && (
              <div className="mt-0.5 flex items-center justify-between">
                <span className="text-grey">Account</span>
                <span className="text-txt-dim">{status.userName}</span>
              </div>
            )}
            {status?.lastVerifiedAt && (
              <div className="mt-0.5 flex items-center justify-between">
                <span className="text-grey">Checked</span>
                <span className="text-txt-dim">{new Date(status.lastVerifiedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })} IST</span>
              </div>
            )}
          </div>

          <div className="relative">
            <input
              type={show ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="Paste access token…"
              autoComplete="off"
              spellCheck={false}
              className="h-8 w-full rounded-md border border-border bg-panel2 pl-2.5 pr-8 font-mono text-[11px] text-txt outline-none placeholder:font-sans placeholder:text-grey/60 focus:border-blue/60"
            />
            <button onClick={() => setShow((s) => !s)} className="absolute right-1.5 top-1.5 p-1 text-grey hover:text-txt-dim" tabIndex={-1}>
              {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>

          <div className="mt-2 flex gap-1.5">
            <button
              onClick={save}
              disabled={!token.trim() || busy === "save"}
              className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md bg-blue/90 text-[11px] font-semibold text-bg hover:bg-blue disabled:opacity-40"
            >
              {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              Save & verify
            </button>
            {status?.configured && (
              <>
                <button onClick={recheck} disabled={busy === "check"} title="Re-check" className="flex h-7 w-8 items-center justify-center rounded-md border border-border text-txt-dim hover:border-blue/50 hover:text-blue disabled:opacity-40">
                  {busy === "check" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                </button>
                {status.source === "VAULT" && (
                  <button onClick={clear} disabled={busy === "clear"} title="Remove token" className="flex h-7 w-8 items-center justify-center rounded-md border border-border text-txt-dim hover:border-red/50 hover:text-red disabled:opacity-40">
                    {busy === "clear" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                )}
              </>
            )}
          </div>

          {err && <p className="mt-1.5 text-[10px] text-red">{err}</p>}
          {status?.message && !err && (
            <p className={`mt-1.5 text-[10px] leading-snug ${status.lastCheckOk ? "text-green" : "text-amber"}`}>{status.message}</p>
          )}

          <p className="mt-2 border-t border-border pt-1.5 text-[9px] leading-snug text-grey">
            Sent once to the backend, encrypted (AES-256-GCM) at rest and never returned to the browser, stored in browser storage, placed in URLs or logged.
            Every figure in PULSEGRID comes from the Upstox API — until a token verifies, each module shows an explicit empty state instead of any demo data.
          </p>
        </div>
      )}
    </div>
  );
}
