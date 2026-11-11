/**
 * PULSEGRID 2.0 — background collection workers (real Upstox data only).
 *
 * Independent of the frontend: collection continues while the user navigates.
 *  - instrument master loader (once per process / per day)
 *  - universe quote poller  (spot + near futures for every F&O underlying)
 *  - focus poller           (option chains + intraday candles)
 *  - RVOL worker            (prior-session intraday volume, once per day/symbol)
 *  - engine refresh         (S/R, FMPI, scanner, trade finder, alerts)
 *
 * All loops are crash-isolated: an Upstox error degrades a tier, never the app.
 */
import { store } from "@/lib/market/store";
import { preloadVault, revalidate } from "@/lib/market/credentials";
import { marketPhase } from "@/lib/engine/types";
import { marketFeed } from "@/lib/market/feed";

const g = globalThis as typeof globalThis & { __pulseWorker?: boolean };

function every(ms: number, fn: () => void | Promise<void>): void {
  const run = async () => {
    try {
      await fn();
    } catch {
      /* isolated */
    }
  };
  const t = setInterval(() => void run(), ms);
  t.unref?.();
}

export function ensureWorkerStarted(): void {
  if (g.__pulseWorker) return;
  g.__pulseWorker = true;

  // 1. credentials → master
  void (async () => {
    try {
      await preloadVault();
      await revalidate();
      await store.ensureMaster();
      await store.startFeed();          // real Upstox Feed V3 WebSocket
      await store.pollUniverse();
      await store.pollFocus();
      await store.refreshRvol();
      for (const sym of store.focus) if (store.isIndex(sym)) await store.buildMappedProfile(sym, "5m").catch(() => undefined);
      store.refreshEngines();
    } catch {
      /* status surfaces the reason */
    }
  })();

  // 2. keep trying to load the master until a token appears / succeeds.
  //    When a token is entered AFTER boot, EVERY tier must kick off:
  //    master → feed → universe quotes → focus chains → engines → RVOL.
  every(20_000, async () => {
    if (!store.masterLoadedAt) {
      await store.ensureMaster();
      if (store.masterLoadedAt) {
        await store.startFeed();
        await store.pollUniverse();
        await store.pollFocus();
        await store.refreshRvol();
        store.refreshEngines();
      }
    } else if (store.tokenPresent && !store.feedStarted) {
      await store.startFeed();
    }
  });

  // 3. universe quotes. Default cadence is 30s; when the provider WebSocket is
  //    NOT delivering ticks we fall back to a faster REST poll during market
  //    hours. The transport is reported honestly either way.
  every(5_000, async () => {
    if (!store.masterLoadedAt) return;
    const open = marketPhase() === "OPEN";
    const wsLive = marketFeed.isLive;
    const gapMs = !open ? 120_000 : wsLive ? 30_000 : 10_000;
    if (Date.now() - store.lastUniversePollAt >= gapMs) await store.pollUniverse();
  });

  // 3b. keep the feed connected + subscriptions in sync (no duplicate sockets)
  every(15_000, async () => {
    if (!store.masterLoadedAt) return;
    if (marketFeed.state === "CLOSED" || marketFeed.state === "ERROR" || marketFeed.state === "IDLE") {
      await marketFeed.connect();
    }
    store.syncFeedSubscriptions();
  });

  // 4. focus: option chains + candles
  every(6_000, async () => {
    if (!store.masterLoadedAt) return;
    const open = marketPhase() === "OPEN";
    const gapMs = open ? 8_000 : 120_000;
    if (Date.now() - store.lastFocusPollAt >= gapMs) await store.pollFocus();
  });

  // 5. engines
  every(7_000, () => {
    if (store.masterLoadedAt) store.refreshEngines();
  });

  // 5b. futures-derived volume profile for INDEX instruments (NIFTY/SENSEX…)
  every(20_000, async () => {
    if (!store.masterLoadedAt) return;
    for (const sym of store.focus) {
      if (!store.isIndex(sym)) continue;
      await store.buildMappedProfile(sym, "5m").catch(() => undefined);
      await store.buildMappedProfile(sym, "1m").catch(() => undefined);
    }
  });

  // 6. RVOL (historical intraday; cached per symbol per day)
  every(120_000, async () => {
    if (store.masterLoadedAt) await store.refreshRvol();
  });

  // 7. token re-validation (tokens expire daily)
  every(10 * 60_000, async () => {
    if (store.tokenPresent) await revalidate();
  });
}
