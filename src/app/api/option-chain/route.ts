import type { NextRequest } from "next/server";
import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureWorkerStarted();
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") ?? "NIFTY").toUpperCase();
  const expiry = sp.get("expiry") ?? store.expiriesOf(symbol)[0];
  const window = Math.min(15, Math.max(2, Number(sp.get("window") ?? 8)));
  store.setFocus(symbol);
  if (!expiry) return Response.json({ available: false, reason: `No listed option expiry for ${symbol}.`, code: "NO_EXPIRY" });
  // make sure a chain exists before answering (first visit to a symbol)
  await store.refreshChain(symbol, expiry).catch(() => undefined);
  return Response.json(store.optionChainPayload(symbol, expiry, window));
}
