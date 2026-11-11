import type { NextRequest } from "next/server";
import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";
import type { Timeframe } from "@/lib/engine/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureWorkerStarted();
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") ?? "NIFTY").toUpperCase();
  const tf = (sp.get("tf") ?? "5m") as Timeframe;
  const daysRaw = Number(sp.get("days") ?? 0);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(7, Math.floor(daysRaw)) : undefined;
  const payload = await store.candlePayload(symbol, tf, days);
  return Response.json(payload, { status: "available" in payload && payload.available ? 200 : 200 });
}
