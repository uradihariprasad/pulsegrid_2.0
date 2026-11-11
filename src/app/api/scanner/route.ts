import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureWorkerStarted();
  return Response.json(store.scannerPayload());
}
