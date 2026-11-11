import type { NextRequest } from "next/server";
import { clearUpstoxToken, revalidate, setUpstoxToken, tokenStatus } from "@/lib/market/credentials";
import { providerMode } from "@/lib/market/master";
import { store } from "@/lib/market/store";
import { rateLimit, requireSameOrigin, securityStatus, validateBody } from "@/lib/security";

export const dynamic = "force-dynamic";

/**
 * Upstox token management.
 * Responses contain ONLY masked status — the raw token is never returned.
 */
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, "token-read", 60, 60_000);
  if (limited) return limited;
  const status = await tokenStatus();
  // masked fingerprint only — the raw token is never serialised
  return Response.json({ ...status, providerMode: providerMode(), security: securityStatus() });
}

export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const limited = rateLimit(req, "token-write", 8, 60_000);
  if (limited) return limited;

  const raw = await req.json().catch(() => null);
  const checked = validateBody<{ token?: string; action?: string }>(raw, 4096);
  if (!checked.ok) return checked.res;
  const body = checked.value;

  if (body?.action === "revalidate") {
    const status = await revalidate();
    store.refreshEngines();
    return Response.json({ ...status, providerMode: providerMode() });
  }

  const token = body?.token?.trim();
  if (!token) return Response.json({ error: "token required" }, { status: 400 });
  if (token.length < 20 || /\s/.test(token)) {
    return Response.json({ error: "That does not look like an Upstox access token." }, { status: 400 });
  }

  const status = await setUpstoxToken(token);
  store.refreshEngines();
  return Response.json({ ...status, providerMode: providerMode() });
}

export async function DELETE(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const limited = rateLimit(req, "token-write", 8, 60_000);
  if (limited) return limited;
  const status = await clearUpstoxToken();
  store.refreshEngines();
  return Response.json({ ...status, providerMode: providerMode() });
}
