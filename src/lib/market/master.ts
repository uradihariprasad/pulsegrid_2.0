/**
 * PULSEGRID 2.0 — Instrument master + Upstox provider adapter.
 *
 * The instrument universe is NEVER hardcoded. It is downloaded in full from the
 * official Upstox instrument master (see upstox.ts). This module only holds
 * credential-aware provider helpers; there is no seeded or demo universe.
 *
 * Upstox adapter — official endpoints (docs.upstox.com):
 *   Instruments : https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz
 *   Quotes      : GET https://api.upstox.com/v2/market-quote/quotes?instrument_key=...
 *   Full quotes : GET https://api.upstox.com/v2/market-quote/quotes?...&mode=full
 *   Option chain: GET https://api.upstox.com/v2/option/chain?instrument_key=...&expiry_date=...
 *   Option contract: GET https://api.upstox.com/v2/option/contract?instrument_key=...
 *   Historical  : GET https://api.upstox.com/v2/historical-candle/{key}/{unit}/{to}/{from}
 *   Intraday    : GET https://api.upstox.com/v2/historical-candle/intraday/{key}/{unit}
 *   Feed V3     : wss://wsfeeder.upstox.com/market-data-feed/v3 (protobuf)
 */
import { getUpstoxToken, getUpstoxTokenSync, isUpstoxLive } from "./credentials";

// ---------------------------------------------------------------------------
// Upstox REST adapter (used when UPSTOX_ACCESS_TOKEN is configured).
// ---------------------------------------------------------------------------
const UPSTOX_BASE = "https://api.upstox.com";

async function upstoxHeaders(): Promise<Record<string, string> | null> {
  // Token is resolved from the server-side vault (UI-entered) or environment.
  const token = await getUpstoxToken();
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

export async function upstoxFetchInstrumentMaster(): Promise<unknown[] | null> {
  const headers = await upstoxHeaders();
  if (!headers) return null;
  try {
    const res = await fetch("https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz", {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown[];
  } catch {
    return null;
  }
}

export async function upstoxFullQuote(instrumentKeys: string[]): Promise<Record<string, unknown> | null> {
  const headers = await upstoxHeaders();
  if (!headers || !instrumentKeys.length) return null;
  try {
    const url = `${UPSTOX_BASE}/v2/market-quote/quotes?mode=full&instrument_key=${encodeURIComponent(instrumentKeys.join(","))}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: Record<string, unknown> };
    return j.data ?? null;
  } catch {
    return null;
  }
}

export async function upstoxOptionChain(instrumentKey: string, expiry: string): Promise<unknown[] | null> {
  const headers = await upstoxHeaders();
  if (!headers) return null;
  try {
    const url = `${UPSTOX_BASE}/v2/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${expiry}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: unknown[] };
    return j.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Active provider. A token that exists but has not validated does NOT flip the
 * label to UPSTOX — the app serves no market data at all until the broker
 * connection is verified. There is no simulated provider.
 */
export function providerMode(): "UPSTOX" | "SIM" {
  return isUpstoxLive() ? "UPSTOX" : "SIM";
}

/** A token is present (env or vault) even if not yet verified. */
export function hasUpstoxCredential(): boolean {
  return !!getUpstoxTokenSync();
}
