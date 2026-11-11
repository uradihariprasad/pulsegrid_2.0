import type { NextRequest } from "next/server";
import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  ensureWorkerStarted();
  const gate = store.gate();
  if (gate) return Response.json({ ...gate, results: [] });
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return Response.json({ available: true, results: store.search(q), universe: store.universeSize });
}
