import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";
import type { NextRequest } from "next/server";
import { rateLimit, requireSameOrigin } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events channel (documented adaptation of the WebSocket contract
 * for the single-process Next.js deployment). Channels: quotes | alert | ping.
 */
export async function GET(req: NextRequest) {
  ensureWorkerStarted();
  // read-only market stream: same-origin + connection cap (no credentials here)
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;
  const limited = rateLimit(req, "stream", 20, 60_000);
  if (limited) return limited;
  const enc = new TextEncoder();
  let onTick: ((p: unknown) => void) | null = null;
  let onAlert: ((p: unknown) => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* closed */
        }
      };
      onTick = (p) => send("quotes", p);
      onAlert = (p) => send("alert", p);
      store.events.on("tick", onTick);
      store.events.on("alert", onAlert);
      send("hello", { ts: Date.now(), provider: store.quotesPayload().provider });
      ping = setInterval(() => send("ping", { ts: Date.now() }), 20_000);
    },
    cancel() {
      if (onTick) store.events.off("tick", onTick);
      if (onAlert) store.events.off("alert", onAlert);
      if (ping) clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
