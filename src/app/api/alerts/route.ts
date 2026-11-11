import type { NextRequest } from "next/server";
import { db } from "@/db";
import { alerts, alertRules } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { ensureWorkerStarted } from "@/lib/worker";

import { rateLimit, requireSameOrigin, validateBody } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureWorkerStarted();
  try {
    const [history, rules] = await Promise.all([
      db.select().from(alerts).orderBy(desc(alerts.ts)).limit(120),
      db.select().from(alertRules).orderBy(alertRules.id),
    ]);
    return Response.json({ history, rules, dbReady: true });
  } catch {
    return Response.json({ history: [], rules: [], dbReady: false });
  }
}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const limited = rateLimit(req, "alerts-write", 30, 60_000);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { name?: string; event?: string; symbol?: string; params?: Record<string, unknown> } | null;
  if (!body?.name || !body.event) return Response.json({ error: "name and event required" }, { status: 400 });
  try {
    const [row] = await db
      .insert(alertRules)
      .values({ name: body.name, event: body.event, symbol: body.symbol?.toUpperCase() || null, params: body.params ?? {} })
      .returning();
    return Response.json({ ok: true, rule: row });
  } catch (e) {
    return Response.json({ error: String((e as Error).message).slice(0, 200) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const limited = rateLimit(req, "alerts-write", 30, 60_000);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { id?: number; enabled?: boolean } | null;
  if (!body?.id || typeof body.enabled !== "boolean") return Response.json({ error: "id and enabled required" }, { status: 400 });
  try {
    await db.update(alertRules).set({ enabled: body.enabled }).where(eq(alertRules.id, body.id));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error).message).slice(0, 200) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const limited = rateLimit(req, "alerts-write", 30, 60_000);
  if (limited) return limited;
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  try {
    await db.delete(alertRules).where(eq(alertRules.id, id));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error).message).slice(0, 200) }, { status: 500 });
  }
}
