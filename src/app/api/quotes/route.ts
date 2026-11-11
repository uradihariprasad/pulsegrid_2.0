import type { NextRequest } from "next/server";
import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureWorkerStarted();
  const gate = store.gate();
  if (gate) return Response.json({ ...gate, quotes: {} });
  const payload = store.quotesPayload();
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (symbol) return Response.json({ available: true, ts: payload.ts, provider: payload.provider, quote: payload.quotes[symbol] ?? null });
  return Response.json({ available: true, ...payload });
}
