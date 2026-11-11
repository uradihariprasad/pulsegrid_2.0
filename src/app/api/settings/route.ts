import type { NextRequest } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { hasUpstoxCredential } from "@/lib/market/master";
import { tokenStatus } from "@/lib/market/credentials";
import { ensureWorkerStarted } from "@/lib/worker";
import { store } from "@/lib/market/store";

import { rateLimit, requireSameOrigin, validateBody } from "@/lib/security";

export const dynamic = "force-dynamic";

const DEFAULTS: Record<string, unknown> = {
  oiSamplingSec: 30,
  oiMatchToleranceSec: 90,
  atmWindow: 3,
  chartDefaultTf: "5m",
  alertSounds: false,
  volumeBreakoutRvol: 2.2,
  evidenceNote: "Data → Evidence → Confirmation → Decision",
};

export async function GET() {
  ensureWorkerStarted();
  const token = await tokenStatus();
  const status = await store.statusPayload();
  let userSettings: Record<string, unknown> = {};
  try {
    const rows = await db.select().from(settings);
    for (const r of rows) userSettings[r.key] = r.value;
  } catch {
    userSettings = {};
  }
  return Response.json({
    settings: { ...DEFAULTS, ...(userSettings.engine as Record<string, unknown> | undefined) },
    engineParams: DEFAULTS,
    provider: {
      mode: status.live ? "UPSTOX" : hasUpstoxCredential() ? "UPSTOX_PENDING" : "NONE",
      upstoxConfigured: hasUpstoxCredential(),
      upstoxVerified: token.lastCheckOk === true,
      upstoxMasked: token.masked,
      upstoxSource: token.source,
      upstoxAccount: token.userName,
      upstoxLastChecked: token.lastVerifiedAt,
      disclosure:
        status.live
          ? `Live Upstox market data${token.userName ? ` — ${token.userName}` : ""}.`
          : hasUpstoxCredential()
            ? `A token is stored (${token.masked}) but has not validated with Upstox. ${token.message ?? ""} No market data can be served until it verifies — PULSEGRID never substitutes simulated values.`
            : "No Upstox credential. Use the token box at the top-left of the header (or set UPSTOX_ACCESS_TOKEN). Every number in this app comes from the Upstox API; without a token the modules show explicit empty states.",
      endpoints: ["Market Data Feed V3 (WS)", "Historical/Intraday Candles", "Full Market Quotes", "Option Contracts", "Option Chain", "Instrument Master"],
      credentialModel: "The Upstox access token is the only credential. No separate admin token is required.",
    },
    db: status.dbReady,
    engine: status,
  });
}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const limited = rateLimit(req, "settings-write", 30, 60_000);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "body required" }, { status: 400 });
  try {
    await db
      .insert(settings)
      .values({ key: "engine", value: body, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [settings.key], set: { value: body, updatedAt: new Date() } });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error).message).slice(0, 200) }, { status: 500 });
  }
}
