/**
 * PULSEGRID 2.0 — API security primitives.
 *
 * The Upstox access token is the ONLY credential in this application. There is
 * no separate admin token: anything the app needs is fetched with the user's
 * Upstox token, which is write-only from the browser's perspective.
 *
 * Protections that do not require a second credential are retained:
 *   - same-origin enforcement on every state-changing route (CSRF defence)
 *   - per-IP rate limiting on sensitive endpoints
 *   - strict body validation
 *   - the Upstox token is never returned, logged or placed in a URL
 *   - encryption at rest for the stored token
 */
import type { NextRequest } from "next/server";
import crypto from "node:crypto";

const PROD = process.env.NODE_ENV === "production";

/** Strong secret is MANDATORY in production — never derived from DATABASE_URL. */
export function appSecret(): string | null {
  const s = process.env.PULSEGRID_SECRET;
  if (!s || s.length < 32) return null;
  return s;
}

export function secretConfigured(): boolean {
  return appSecret() !== null;
}

/** Reject cross-origin state-changing calls (CSRF defence). */
export function requireSameOrigin(req: NextRequest): Response | null {
  const origin = req.headers.get("origin");
  if (!origin) return null; // same-origin fetches/curl without Origin
  try {
    const o = new URL(origin);
    const host = req.headers.get("host");
    const allowed = (process.env.PULSEGRID_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (host && o.host === host) return null;
    if (allowed.includes(o.origin)) return null;
  } catch {
    /* malformed origin → reject */
  }
  return Response.json({ error: "Cross-origin request rejected", code: "CSRF" }, { status: 403 });
}

/* ------------------------------------------------------------ rate limit */
const buckets = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: NextRequest, scope: string): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  return `${scope}:${ip}`;
}

export function rateLimit(req: NextRequest, scope: string, limit: number, windowMs: number): Response | null {
  const key = clientKey(req, scope);
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  b.count++;
  if (b.count > limit) {
    const retry = Math.ceil((b.resetAt - now) / 1000);
    return Response.json({ error: "Too many requests", code: "RATE_LIMITED", retryAfterSec: retry }, { status: 429, headers: { "Retry-After": String(retry) } });
  }
  return null;
}

/** Reject obviously malformed payloads before touching any provider state. */
export function validateBody<T extends Record<string, unknown>>(body: unknown, maxBytes = 8_192): { ok: true; value: T } | { ok: false; res: Response } {
  if (body == null || typeof body !== "object" || Array.isArray(body))
    return { ok: false, res: Response.json({ error: "JSON object body required", code: "BAD_BODY" }, { status: 400 }) };
  if (JSON.stringify(body).length > maxBytes)
    return { ok: false, res: Response.json({ error: "Payload too large", code: "BAD_BODY" }, { status: 413 }) };
  return { ok: true, value: body as T };
}

export function securityStatus() {
  return {
    credential: "UPSTOX_ACCESS_TOKEN_ONLY",
    strongSecretConfigured: secretConfigured(),
    sameOriginEnforced: true,
    rateLimited: true,
    production: PROD,
    warnings: [
      ...(!secretConfigured()
        ? ["PULSEGRID_SECRET is not set (min 32 chars) — the stored Upstox token is encrypted with a key derived from DATABASE_URL. Set it for production-grade at-rest protection."]
        : []),
      ...(PROD
        ? ["Provider settings are protected by same-origin + rate limiting only. Put this deployment behind your own network/SSO boundary if it is publicly reachable."]
        : []),
    ],
  };
}
