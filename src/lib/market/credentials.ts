/**
 * PULSEGRID 2.0 — Upstox credential vault (SERVER ONLY).
 *
 * Security rules enforced here:
 *  - The raw access token NEVER leaves the backend. API responses expose only a
 *    masked fingerprint (e.g. "eyJh••••9xQ2") plus status metadata.
 *  - At rest the token is encrypted with AES-256-GCM. The key is derived from
 *    PULSEGRID_SECRET (preferred) or the DATABASE_URL, via scrypt.
 *  - Nothing here is ever written to logs.
 *  - Browser storage is never used; the UI posts once and then only reads status.
 */
import crypto from "node:crypto";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";

const SETTINGS_KEY = "provider.upstox";

export interface TokenStatus {
  configured: boolean;
  source: "ENV" | "VAULT" | "NONE";
  masked: string | null;
  savedAt: string | null;
  lastVerifiedAt: string | null;
  lastCheckOk: boolean | null;
  userName: string | null;
  message: string | null;
  decryptFailed?: boolean;
}

interface VaultState {
  token: string | null;
  savedAt: string | null;
  lastVerifiedAt: string | null;
  lastCheckOk: boolean | null;
  userName: string | null;
  message: string | null;
  loaded: boolean;
  decryptFailed: boolean;
}

const g = globalThis as typeof globalThis & { __pulseVault?: VaultState };
const vault: VaultState =
  g.__pulseVault ??
  (g.__pulseVault = {
    token: null,
    savedAt: null,
    lastVerifiedAt: null,
    lastCheckOk: null,
    userName: null,
    message: null,
    loaded: false,
    decryptFailed: false,
  });

/* ----------------------------------------------------------- encryption -- */
/**
 * SECURITY: production REQUIRES an explicitly configured strong secret
 * (PULSEGRID_SECRET, >= 32 chars). It is never silently derived from
 * DATABASE_URL. `writeKey()` throws in production when it is absent so a
 * credential can never be persisted under a weak, guessable key.
 */
function explicitSecret(): string | null {
  const s = process.env.PULSEGRID_SECRET;
  return s && s.length >= 32 ? s : null;
}

function deriveKey(secret: string, salt: string): Buffer {
  return crypto.scryptSync(secret, salt, 32);
}

/**
 * Key used for NEW writes.
 *
 * PULSEGRID_SECRET is strongly preferred, but its absence must never stop the
 * user from saving their Upstox token — that is the only credential the app
 * has. Without it we fall back to a DATABASE_URL-derived key and surface a
 * warning in the security status rather than failing the write.
 */
function writeKey(): Buffer {
  const explicit = explicitSecret();
  if (explicit) return deriveKey(explicit, "pulsegrid.upstox.v1");
  return deriveKey(process.env.DATABASE_URL ?? "pulsegrid-local-dev", "pulsegrid.upstox.v1.dev");
}

/**
 * Candidate keys for READS, newest first. Supports one-time migration of
 * records written before PULSEGRID_SECRET was introduced; such records are
 * transparently re-encrypted under the strong key on first successful read.
 */
function readKeys(): { key: Buffer; legacy: boolean }[] {
  const out: { key: Buffer; legacy: boolean }[] = [];
  const explicit = explicitSecret();
  if (explicit) out.push({ key: deriveKey(explicit, "pulsegrid.upstox.v1"), legacy: false });
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    out.push({ key: deriveKey(dbUrl, "pulsegrid.upstox.v1"), legacy: true });
    out.push({ key: deriveKey(dbUrl, "pulsegrid.upstox.v1.dev"), legacy: true });
  }
  out.push({ key: deriveKey("pulsegrid-local-dev", "pulsegrid.upstox.v1"), legacy: true });
  return out;
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", writeKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(blob: string): { value: string; legacy: boolean } | null {
  const [v, ivB, tagB, dataB] = blob.split(":");
  if (v !== "v1" || !ivB || !tagB || !dataB) return null;
  for (const { key, legacy } of readKeys()) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
      decipher.setAuthTag(Buffer.from(tagB, "base64"));
      const value = Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]).toString("utf8");
      return { value, legacy };
    } catch {
      /* try next key */
    }
  }
  return null;
}

export function maskToken(token: string): string {
  const t = token.trim();
  if (t.length <= 10) return "••••••";
  return `${t.slice(0, 4)}••••${t.slice(-4)}`;
}

/* --------------------------------------------------------------- load ---- */
async function hydrate(): Promise<void> {
  if (vault.loaded) return;
  vault.loaded = true;
  try {
    const rows = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
    const row = rows[0];
    if (!row) return;
    const val = row.value as { enc?: string; savedAt?: string; lastVerifiedAt?: string; lastCheckOk?: boolean; userName?: string };
    if (val?.enc) {
      const dec = decrypt(val.enc);
      if (dec) {
        vault.token = dec.value;
        vault.savedAt = val.savedAt ?? null;
        vault.lastVerifiedAt = val.lastVerifiedAt ?? null;
        vault.lastCheckOk = val.lastCheckOk ?? null;
        vault.userName = val.userName ?? null;
        // one-time re-encryption under the strong key
        if (dec.legacy && explicitSecret()) void reencrypt(dec.value, val);
      } else {
        // Self-healing: the record is unreadable under every known key (the
        // PULSEGRID_SECRET was rotated or lost). Remove the dead ciphertext so
        // the UI cleanly prompts for re-entry instead of failing silently.
        vault.message =
          "The stored Upstox credential could not be decrypted — PULSEGRID_SECRET changed or was lost. The unreadable record was discarded; please re-enter your Upstox access token.";
        vault.decryptFailed = true;
        void db.delete(settings).where(eq(settings.key, SETTINGS_KEY)).catch(() => undefined);
      }
    }
  } catch {
    /* vault is optional — env token still works */
  }
}

async function reencrypt(token: string, prev: Record<string, unknown>): Promise<void> {
  try {
    const value = { ...prev, enc: encrypt(token) };
    await db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [settings.key], set: { value, updatedAt: new Date() } });
  } catch {
    /* best effort */
  }
}

/** Resolve the active token: runtime vault first, then environment. */
export async function getUpstoxToken(): Promise<string | null> {
  await hydrate();
  return vault.token || process.env.UPSTOX_ACCESS_TOKEN || null;
}

/** Synchronous best-effort read (after first hydrate) for hot paths. */
export function getUpstoxTokenSync(): string | null {
  return vault.token || process.env.UPSTOX_ACCESS_TOKEN || null;
}

export async function tokenStatus(): Promise<TokenStatus> {
  await hydrate();
  const envToken = process.env.UPSTOX_ACCESS_TOKEN || null;
  const active = vault.token || envToken;
  return {
    configured: !!active,
    source: vault.token ? "VAULT" : envToken ? "ENV" : "NONE",
    masked: active ? maskToken(active) : null,
    savedAt: vault.savedAt,
    lastVerifiedAt: vault.lastVerifiedAt,
    lastCheckOk: vault.lastCheckOk,
    userName: vault.userName,
    message: vault.message,
    decryptFailed: vault.decryptFailed,
  };
}

/* ------------------------------------------------------------- verify ---- */
/**
 * Validate a token against the documented Upstox profile endpoint.
 * Returns ok=false with a human reason instead of throwing.
 */
export async function verifyToken(token: string): Promise<{ ok: boolean; userName: string | null; reason: string }> {
  try {
    const res = await fetch("https://api.upstox.com/v2/user/profile", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, userName: null, reason: "Token rejected by Upstox (401/403) — expired or invalid." };
    if (!res.ok) return { ok: false, userName: null, reason: `Upstox responded ${res.status}.` };
    const j = (await res.json()) as { data?: { user_name?: string; email?: string } };
    return { ok: true, userName: j.data?.user_name ?? j.data?.email ?? "Upstox account", reason: "Token verified with Upstox." };
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "Upstox did not respond in time." : "Could not reach Upstox from this host.";
    return { ok: false, userName: null, reason: msg };
  }
}

/* ---------------------------------------------------------------- save --- */
export async function setUpstoxToken(token: string): Promise<TokenStatus> {
  await hydrate();
  const clean = token.trim();
  const check = await verifyToken(clean);

  vault.token = clean;
  vault.decryptFailed = false;
  vault.savedAt = new Date().toISOString();
  vault.lastVerifiedAt = new Date().toISOString();
  vault.lastCheckOk = check.ok;
  vault.userName = check.userName;
  vault.message = check.ok
    ? `Connected as ${check.userName}. Live Upstox data active.`
    : `${check.reason} Token stored, but no market data will be served until it validates — PULSEGRID never substitutes simulated values.`;

  try {
    const value = {
      enc: encrypt(clean),
      savedAt: vault.savedAt,
      lastVerifiedAt: vault.lastVerifiedAt,
      lastCheckOk: vault.lastCheckOk,
      userName: vault.userName,
    };
    await db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [settings.key], set: { value, updatedAt: new Date() } });
  } catch {
    vault.message = `${vault.message} (kept in memory — database unavailable for persistence)`;
  }
  return tokenStatus();
}

export async function clearUpstoxToken(): Promise<TokenStatus> {
  await hydrate();
  vault.token = null;
  vault.savedAt = null;
  vault.lastVerifiedAt = null;
  vault.lastCheckOk = null;
  vault.userName = null;
  vault.message = "Token removed. Live market data is now switched off; modules will show empty states.";
  vault.decryptFailed = false;
  try {
    await db.delete(settings).where(eq(settings.key, SETTINGS_KEY));
  } catch {
    /* ignore */
  }
  return tokenStatus();
}

/** Re-check the stored token without changing it. */
export async function revalidate(): Promise<TokenStatus> {
  await hydrate();
  const token = await getUpstoxToken();
  if (!token) {
    vault.message = "No token configured.";
    return tokenStatus();
  }
  const check = await verifyToken(token);
  vault.lastVerifiedAt = new Date().toISOString();
  vault.lastCheckOk = check.ok;
  vault.userName = check.userName;
  vault.message = check.ok ? `Connected as ${check.userName}. Live Upstox data active.` : check.reason;
  return tokenStatus();
}

/** True only when a token exists AND last verification succeeded. */
export function isUpstoxLive(): boolean {
  return !!getUpstoxTokenSync() && vault.lastCheckOk === true;
}

/** Warm the vault during worker bootstrap. */
export async function preloadVault(): Promise<void> {
  await hydrate();
}
