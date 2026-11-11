import type { NextRequest } from "next/server";
import { db } from "@/db";
import { watchlist } from "@/db/schema";
import { eq } from "drizzle-orm";
import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";

import { rateLimit, requireSameOrigin, validateBody } from "@/lib/security";

export const dynamic = "force-dynamic";

function enrich(rows: { symbol: string; kind: string }[]) {
  return rows.map((r) => {
    const u = store.underlyings.get(r.symbol);
    const q = u?.quote ?? null;
    const f = store.futuresPayload(r.symbol);
    const sr = store.srPayload(r.symbol, "5m");
    const fmpi = store.fmpiFor(r.symbol, "5m");
    const futOk = "available" in f && f.available;
    const srOk = "available" in sr && sr.available;
    return {
      symbol: r.symbol,
      kind: r.kind,
      ltp: q ? Math.round(q.ltp * 100) / 100 : null,
      chgPct: q && q.close ? Math.round(((q.ltp - q.close) / q.close) * 10000) / 100 : null,
      fmpi: fmpi ? fmpi.value : null,
      fmpiClass: fmpi ? fmpi.classification : null,
      futOiSess: futOk ? f.fut.oiSessChg : null,
      futuresDir: futOk ? f.fut.classification : "UNAVAILABLE",
      support: srOk ? (sr.selection.immediateSupport?.mid ?? null) : null,
      resistance: srOk ? (sr.selection.immediateResistance?.mid ?? null) : null,
      freshness: q ? store.freshnessOf(q.exchangeTs) : "UNAVAILABLE",
    };
  });
}

export async function GET() {
  ensureWorkerStarted();
  const gate = store.gate();
  let rows: { symbol: string; kind: string }[] = [];
  try {
    rows = await db.select().from(watchlist).orderBy(watchlist.id);
  } catch {
    rows = [];
  }
  if (gate) return Response.json({ ...gate, items: [], saved: rows.map((r) => r.symbol) });
  for (const r of rows) store.setFocus(r.symbol);
  return Response.json({ available: true, items: enrich(rows), persisted: true });
}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const limited = rateLimit(req, "watchlist-write", 30, 60_000);
  if (limited) return limited;
  ensureWorkerStarted();
  const body = (await req.json().catch(() => null)) as { symbol?: string } | null;
  const symbol = body?.symbol?.toUpperCase();
  if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });
  const u = store.underlyings.get(symbol);
  if (!u) return Response.json({ error: "Not an Upstox F&O instrument" }, { status: 404 });
  try {
    await db.insert(watchlist).values({ symbol, kind: u.meta.segment }).onConflictDoNothing({ target: [watchlist.symbol] });
    store.setFocus(symbol);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error).message).slice(0, 200) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const limited = rateLimit(req, "watchlist-write", 30, 60_000);
  if (limited) return limited;
  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });
  try {
    await db.delete(watchlist).where(eq(watchlist.symbol, symbol));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error).message).slice(0, 200) }, { status: 500 });
  }
}
