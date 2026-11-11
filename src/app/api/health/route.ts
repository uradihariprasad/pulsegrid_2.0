import { db } from "@/db";
import { sql } from "drizzle-orm";
import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureWorkerStarted();
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const status = await store.statusPayload();
  return Response.json({ ok: true, db: dbOk, engine: status, ts: Date.now() });
}
