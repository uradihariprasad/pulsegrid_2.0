"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  BellRing,
  Crosshair,
  Gauge,
  GitBranch,
  LayoutGrid,
  Layers,
  Menu,
  Radar,
  Scale,
  ScrollText,
  KeyRound,
  Search,
  Settings,
  Star,
  TrendingUp,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { PulseProvider, useApp, useApi, istTime, fmt, fmtPct, clsColor } from "@/lib/client";
import { Workspace } from "@/components/workspace";
import { UpstoxTokenBox } from "@/components/token-box";
import { ScanButton } from "@/components/scan-button";

export const NAV = [
  { href: "/", label: "Market Overview", icon: LayoutGrid },
  { href: "/trade-finder", label: "Trade Finder", icon: Crosshair },
  { href: "/scanner", label: "F&O Scanner", icon: Radar },
  { href: "/option-intelligence", label: "Option Intelligence", icon: Layers },
  { href: "/oi-momentum", label: "OI Momentum", icon: BarChart3 },
  { href: "/futures", label: "Futures Intelligence", icon: ScrollText },
  { href: "/order-flow", label: "Order Flow", icon: ArrowLeftRight },
  { href: "/charts", label: "Chart Intelligence", icon: TrendingUp },
  { href: "/market-structure", label: "Market Structure", icon: GitBranch },
  { href: "/dominance", label: "Buyer/Seller Dominance", icon: Scale },
  { href: "/fmpi", label: "FMPI Momentum", icon: Gauge },
  { href: "/alerts", label: "Alerts", icon: BellRing },
  { href: "/watchlist", label: "Watchlist", icon: Star },
  { href: "/settings", label: "Settings", icon: Settings },
];

function IstClock() {
  const [now, setNow] = useState("");
  useEffect(() => {
    const f = () => setNow(istTime());
    f();
    const iv = setInterval(f, 1000);
    return () => clearInterval(iv);
  }, []);
  return <span className="tnum text-[11px] text-txt-dim">{now} IST</span>;
}

function InstrumentSearch({ onPick }: { onPick?: () => void }) {
  const { openWorkspace, setSymbol } = useApp();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const { data } = useApi<{ results?: { symbol: string; name: string; ltp: number | null; chgPct: number | null }[]; reason?: string }>(`/api/instruments?q=${encodeURIComponent(q)}`, 0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="relative w-full md:max-w-[380px]">
      <div className="flex h-7.5 items-center gap-2 rounded-md border border-border bg-panel2 px-2.5">
        <Search className="h-3.5 w-3.5 text-grey" />
        <input
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          placeholder="Search instruments… (RELIANCE, NIFTY)"
          className="w-full bg-transparent text-[11.5px] text-txt placeholder:text-grey/70 outline-none"
        />
      </div>
      {open && data && (
        <div className="absolute left-0 right-0 top-9 z-50 max-h-72 overflow-auto rounded-lg border border-border bg-panel shadow-2xl">
          {(data.results ?? []).length === 0 && (
            <div className="px-3 py-2 text-[11px] leading-snug text-grey">{data.reason ?? "No instruments match"}</div>
          )}
          {(data.results ?? []).map((r) => (
            <button
              key={r.symbol}
              onClick={() => {
                setSymbol(r.symbol);
                openWorkspace(r.symbol);
                setOpen(false);
                setQ("");
                onPick?.();
              }}
              className="flex w-full items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5 text-left hover:bg-panel2"
            >
              <span>
                <span className="block text-[12px] font-semibold text-txt">{r.symbol}</span>
                <span className="block text-[10px] text-grey">{r.name}</span>
              </span>
              <span className="text-right">
                <span className="block text-[11px] tnum text-txt">{r.ltp == null ? "—" : fmt(r.ltp)}</span>
                <span className={`block text-[10px] tnum ${clsColor(r.chgPct)}`}>{r.chgPct == null ? "" : fmtPct(r.chgPct)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Header({ onMenu }: { onMenu: () => void }) {
  const { provider, marketPhase, streamConnected, lastAlert } = useApp();
  const [mobileSearch, setMobileSearch] = useState(false);
  const open = marketPhase === "OPEN";
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="flex h-12 items-center gap-1.5 px-2 sm:gap-3 sm:px-3">
        <button onClick={onMenu} className="rounded-md p-1 text-txt-dim hover:bg-panel2 lg:hidden" aria-label="Open navigation">
          <Menu className="h-4.5 w-4.5" />
        </button>

        {/* top-left: brand + Upstox token control */}
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="flex h-6.5 w-6.5 items-center justify-center rounded-md bg-blue/15 text-blue">
            <Activity className="h-3.5 w-3.5" />
          </span>
          <span className="hidden leading-none sm:block">
            <span className="block text-[13px] font-bold tracking-tight text-txt">
              PULSE<span className="text-blue">GRID</span> <span className="text-[10px] font-semibold text-blue">2.0</span>
            </span>
            <span className="mt-0.5 hidden text-[8.5px] font-medium uppercase tracking-[0.14em] text-grey md:block">NSE F&amp;O Intelligence</span>
          </span>
        </Link>

        <UpstoxTokenBox />
        <ScanButton />

        <div className="hidden min-w-0 flex-1 justify-center md:flex">
          <InstrumentSearch />
        </div>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
          <button
            onClick={() => setMobileSearch((v) => !v)}
            aria-label="Search instruments"
            className="rounded-md border border-border bg-panel p-1.5 text-txt-dim hover:text-txt md:hidden"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          {lastAlert && (
            <span className="hidden items-center gap-1 rounded border border-amber/25 bg-amber/10 px-1.5 py-0.5 text-[10px] font-medium text-amber xl:flex">
              <BellRing className="h-3 w-3" /> {lastAlert.symbol} {String(lastAlert.event ?? "").replaceAll("_", " ")}
            </span>
          )}
          <span className="flex items-center gap-1.5 rounded-md border border-border bg-panel px-1.5 py-1 text-[10px] font-semibold sm:px-2">
            <span className={`h-1.5 w-1.5 rounded-full ${open ? "bg-green pg-pulse" : "bg-red"}`} />
            <span className={`hidden sm:inline ${open ? "text-green" : "text-red"}`}>{open ? "MARKET OPEN" : "MARKET CLOSED"}</span>
          </span>
          <span className="hidden items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1 text-[10px] font-semibold lg:flex">
            {streamConnected ? <Wifi className="h-3 w-3 text-green" /> : <WifiOff className="h-3 w-3 text-red" />}
            <TransportBadge />
          </span>
          <span className="hidden rounded-md border border-border bg-panel px-2 py-1 sm:block">
            <IstClock />
          </span>
        </div>
      </div>

      {/* mobile search row */}
      {mobileSearch && (
        <div className="border-t border-border px-2 py-1.5 md:hidden">
          <InstrumentSearch onPick={() => setMobileSearch(false)} />
        </div>
      )}
    </header>
  );
}

function TransportBadge() {
  const { data } = useApi<{ transport?: string; feed?: { state?: string; subscriptions?: number } }>("/api/market-status", 15_000);
  const t = data?.transport;
  if (!t) return <span className="text-grey">…</span>;
  const ws = t === "WEBSOCKET";
  return (
    <span className={ws ? "text-green" : "text-amber"} title={ws ? `Upstox Feed V3 · ${data?.feed?.subscriptions ?? 0} subscriptions` : `REST polling (feed ${data?.feed?.state ?? "idle"})`}>
      {ws ? "WS LIVE" : "REST POLL"}
    </span>
  );
}

function ProviderBanner() {
  const { data } = useApi<{
    tokenConfigured?: boolean; tokenVerified?: boolean; live?: boolean; universe?: number;
    masterError?: string | null; authError?: string | null; marketPhase?: string; holiday?: string | null;
  }>("/api/market-status", 10_000);
  if (!data) return null;
  if (data.live && data.universe) return null;
  const msg = !data.tokenConfigured
    ? "No Upstox access token — PULSEGRID shows no market data at all rather than demo values. Add your token at the top-left to stream live NSE/BSE F&O data."
    : data.authError
      ? data.authError
      : !data.tokenVerified
        ? "Your Upstox token has not validated yet. Live data stays switched off until it does — nothing is simulated."
        : data.masterError
          ? `Instrument master failed to load: ${data.masterError}`
          : "Loading the Upstox instrument master and first quote batch…";
  return (
    <div className="mb-2.5 flex items-start gap-2 rounded-lg border border-blue/25 bg-blue/[0.07] px-3 py-2">
      <KeyRound className="mt-[1px] h-3.5 w-3.5 shrink-0 text-blue" />
      <p className="text-[10.5px] leading-snug text-txt-dim">{msg}</p>
    </div>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { quotes } = useApp();
  const nifty = quotes["NIFTY"];
  return (
    <nav className="flex h-full flex-col overflow-y-auto pb-4">
      <div className="px-2 pt-2">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`group relative mb-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[11.5px] font-medium transition-colors ${
                active ? "bg-blue/10 text-blue" : "text-txt-dim hover:bg-panel2 hover:text-txt"
              }`}
            >
              {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full bg-blue" />}
              <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? "text-blue" : "text-grey group-hover:text-txt-dim"}`} />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </div>
      <div className="mt-auto px-3 pt-3">
        <div className="pg-panel-2 p-2.5">
          <div className="text-[9px] font-semibold uppercase tracking-widest text-grey">NIFTY 50</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="tnum text-[14px] font-bold text-txt">{nifty ? fmt(nifty.ltp) : "…"}</span>
            <span className={`tnum text-[10.5px] ${clsColor(nifty?.chgPct)}`}>{nifty ? fmtPct(nifty.chgPct) : ""}</span>
          </div>
        </div>
        <EngineHeartbeat />
      </div>
    </nav>
  );
}

function EngineHeartbeat() {
  const { data } = useApi<{ engine?: { universe?: number; api?: { calls?: number } } }>("/api/health", 5000);
  return (
    <div className="mt-2 flex items-center justify-between px-1 text-[9px] text-grey">
      <span>upstox calls</span>
      <span className="tnum">{data?.engine?.api?.calls?.toLocaleString("en-IN") ?? "…"}</span>
    </div>
  );
}

function WorkspaceDrawer() {
  const { workspaceSymbol, closeWorkspace } = useApp();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (workspaceSymbol) setVisible(true);
    else {
      const t = setTimeout(() => setVisible(false), 220);
      return () => clearTimeout(t);
    }
  }, [workspaceSymbol]);
  if (!workspaceSymbol || !visible) return null;
  return (
    <div className={`fixed inset-0 z-50 transition-opacity ${workspaceSymbol ? "opacity-100" : "opacity-0"}`}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={closeWorkspace} />
      <aside
        className={`absolute right-0 top-0 h-full w-full overflow-y-auto border-l border-border bg-bg shadow-2xl transition-transform duration-200 sm:max-w-[760px] ${
          workspaceSymbol ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="sticky top-0 z-10 flex h-11 items-center justify-between border-b border-border bg-bg/90 px-4 backdrop-blur">
          <span className="text-[12px] font-bold tracking-wide text-txt">
            {workspaceSymbol} <span className="text-[9.5px] font-medium uppercase tracking-widest text-grey">— Intelligence Workspace</span>
          </span>
          <button onClick={closeWorkspace} className="rounded-md p-1 text-txt-dim hover:bg-panel2" aria-label="close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-2 sm:p-3">
          <Workspace symbol={workspaceSymbol} />
        </div>
      </aside>
    </div>
  );
}

function MobileTabs({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname();
  const tabs = [NAV[0], NAV[1], NAV[2], NAV[3]];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={`flex h-13 flex-1 flex-col items-center justify-center gap-0.5 ${active ? "text-blue" : "text-grey"}`}>
            <Icon className="h-4 w-4" />
            <span className="text-[8.5px] font-medium">{t.label.split(" ")[0]}</span>
          </Link>
        );
      })}
      <button onClick={onMenu} className="flex h-13 flex-1 flex-col items-center justify-center gap-0.5 text-grey">
        <Menu className="h-4 w-4" />
        <span className="text-[8.5px] font-medium">All</span>
      </button>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState(false);
  const memoMenu = useMemo(() => menu, [menu]);
  return (
    <PulseProvider>
      <Header onMenu={() => setMenu(true)} />
      <div className="flex pt-12">
        <aside className="fixed bottom-0 left-0 top-12 z-30 hidden w-[204px] border-r border-border bg-bg lg:block">
          <SidebarNav />
        </aside>
        {memoMenu && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={() => setMenu(false)} />
            <aside className="absolute left-0 top-0 h-full w-60 border-r border-border bg-bg pt-2">
              <div className="flex items-center justify-between px-3 pb-2">
                <span className="text-[12px] font-bold text-txt">MODULES</span>
                <button onClick={() => setMenu(false)} className="p-1 text-txt-dim">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <SidebarNav onNavigate={() => setMenu(false)} />
            </aside>
          </div>
        )}
        <main className="min-h-[calc(100vh-48px)] w-full pb-16 lg:ml-[204px] lg:pb-6">
          <div className="p-2 sm:p-2.5 lg:p-3">
            <ProviderBanner />
            {children}
          </div>
        </main>
      </div>
      <MobileTabs onMenu={() => setMenu(true)} />
      <WorkspaceDrawer />
    </PulseProvider>
  );
}
