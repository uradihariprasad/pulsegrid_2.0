# PULSEGRID 2.0 — Engineering Deliverables

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ Next.js 16 (App Router) — single deployable                   │
│                                                               │
│  src/components + src/app/…   →  14 modules, design-locked    │
│  dark institutional theme (#0a0c10), dense panels, Lucide     │
│                                                               │
│  /api/*  (typed JSON)      /api/stream (SSE: quotes|alert)    │
│         │                                                   │
│  src/lib/market/store.ts   → canonical live store (singleton) │
│         │ providers: UPSTOX (token present) | SIM (disclosed) │
│         ▼                                                   │
│  src/lib/engine/*  → stateless quantitative engines           │
│   indicators · oi · structure · sr · fmpi · trading           │
│         │                                                   │
│  src/lib/worker.ts → background collection orchestrator       │
│   (instrument master, ticks, candle aggregation, OI/futures/  │
│    premium observation writers, engine refresh, alerts)       │
│         │                                                   │
│  PostgreSQL (Drizzle) → observations, baselines, zones,       │
│   scanner results, trade candidates, alerts, watchlist        │
└───────────────────────────────────────────────────────────────┘
```

## DATA POLICY — real Upstox data only

PULSEGRID contains **no simulated, demo, sample or placeholder market data**.
The former SIM market-twin has been deleted (`src/lib/market/sim.ts` removed,
seeded universe removed). Every figure rendered in all 14 modules originates
from an Upstox API response.

When the provider cannot supply something, the backend returns an availability
envelope and the UI renders an explicit empty state:

```jsonc
{ "available": false, "reason": "…human explanation…", "code": "NO_TOKEN|AUTH|MASTER|CHAIN|NO_CANDLES|NO_FUTURES|NOT_PROVIDED|LOADING" }
```

Deliberate "nothing rather than something" decisions:

| Surface | Behaviour |
|---|---|
| No / unverified token | Every module shows "Upstox token required". Provider label stays `SIM` meaning *not connected* — no data is served. |
| CVD / footprint | `UNAVAILABLE`. The REST quote feed has no aggressor-flagged prints, so no CVD is estimated at all. |
| India VIX | Removed from Overview — replaced with a real data-coverage card. |
| Sector performance | Empty with an explanation: Upstox publishes no sector map. |
| Greeks / IV | Provider-supplied (`option_greeks`), tagged `greeksSource: UPSTOX_PROVIDED`. No Black–Scholes modelling. |
| Pre-session OI reference | Provider `prev_oi`. Absent → combined OI is `null`, never invented. |
| RVOL | Real prior-session 1-minute cumulative volume at the same minute-of-day; `null` until that history is fetched. |
| Candles after hours | Falls back to the **last real trading session** via historical V3 and is labelled `historical: true` + `sessionDate` in the UI. |

### Upstox endpoints in use
`assets/instruments/{NSE,BSE}.json.gz` · `/v2/user/profile` · `/v2/market/holidays` ·
`/v2/market-quote/quotes` · `/v2/option/contract` · `/v2/option/chain` ·
`/v3/historical-candle/intraday/{key}/{unit}/{interval}` ·
`/v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}`

Client-side rate limiter (8 rps / 180 rpm), exponential-backoff retries, 429
handling, and auth-error propagation are in `src/lib/market/upstox.ts`.

### Platform adaptations (documented, deliberate)
- The mandated runtime of this deployment is Next.js + PostgreSQL (Drizzle), so the
  FastAPI/Redis-tier concerns are implemented equivalently in-process:
  background workers run as resilient intervals inside the server runtime
  (crash-isolated per tick), shared live state lives in the singleton store and
  PostgreSQL, and the realtime transport is an authenticated-origin SSE channel
  (`/api/stream`) instead of raw WebSockets (functionally equivalent pub/sub).
- Credential model: the **Upstox access token is the only credential**. It is
  entered once in the header (or via `UPSTOX_ACCESS_TOKEN`), held server-side,
  encrypted at rest, and never returned to the browser — only a masked
  fingerprint is exposed. There is no separate admin token.
- Remaining API protections that need no second credential: same-origin
  enforcement on every state-changing route, per-IP rate limiting, strict body
  validation, and write-only token semantics.

## API contract inventory (/api)

| Route | Purpose |
|---|---|
| `health` | liveness, DB, engine counters |
| `market-status` | provider, phase, IST session |
| `instruments?q=` | instrument search |
| `quotes?symbol=` | universe or single quote |
| `candles?symbol&tf` | candles (1m..1D) + server-computed EMA/BB/VWAP/RSI/ATR |
| `option-chain?symbol&expiry&window` | chain with greeks, OI Δ, spreads, PCR |
| `intel/oi-momentum` | 5m/15m/session/combined OI, ATM±3 |
| `intel/futures` + `futures-all` | futures classification, basis, rolling ΔOI |
| `intel/premium-momentum` | per-contract premium states + best strikes |
| `intel/fmpi` / `intel/fmpi-series` | FMPI value, decomposition, history |
| `intel/sr` | zones, lifecycle, selection, evidence |
| `intel/structure` / `intel/volume-profile` | swings, BOS/CHoCH, POC/VAH/VAL |
| `intel/order-flow` | depth, ESTIMATED CVD, liquidity map + authenticity |
| `intel/targets` | targets, reversal zones, invalidation |
| `intel/workspace` | complete single-instrument bundle (20 sections) |
| `intel/overview` / `intel/dominance` | market overview / dominance lists |
| `scanner` / `trade-finder` | category rows / gated candidates + WAIT list |
| `alerts` (GET/POST/PATCH/DELETE) | rules + transition history |
| `watchlist` (GET/POST/DELETE) | persisted watchlists |
| `settings` (GET/POST) | engine params, provider status |

## OI methodology (exact)
- Rolling windows are time-based: the 5m reference is the observation closest to
  `now − 5min` within 90s tolerance; otherwise N/A. Never fixed N samples.
- Session cumulative = current OI − fixed per-session baseline (persisted in
  `oi_baselines`, never reset on refresh).
- Combined total = valid pre-session reference + session change; reference
  missing → UNAVAILABLE rather than invented.

## Trade Finder gates
Options candidates require: valid underlying, valid contract+premium, liquidity
and spread thresholds, derivatives evidence (premium momentum + OI), aligned
structure, confirming futures, entry trigger, SL, targets, invalidation, RR ≥ 1.5
(from proposed entry). Anything missing → WATCH/WAIT with the reason. The engine
never backfills the list to ten names.

## Testing
- `npx tsx src/lib/engine/tests.ts` — 14 mandatory calculation tests
  (OI 5m/15m/session/combined, contract identity, S/R invariants, PDH/PDL,
  futures gating, trade gates, RR, RVOL, VWAP, FMPI non-fabrication).

## Historical validation stance
A validation harness is included as pure functions (engines are deterministic
over observation sequences). Accuracy/expectancy claims are published only after
out-of-sample runs over recorded sessions; the product never displays win-rate
marketing. Scores are explicitly labelled uncalibrated.

## Setup
```bash
cp .env.example .env     # set DATABASE_URL (and UPSTOX_ACCESS_TOKEN for live)
npx drizzle-kit push     # apply schema
npm run build && npm start
```

## Deployment
Single container: `next build` → `next start` with Postgres attached
(`DATABASE_URL`). Workers auto-start via `instrumentation.ts`; `/api/health`
exposes engine + DB state for monitoring. Graceful degradation: if Postgres is
momentarily down the engine keeps serving from in-memory state and persistence
retries (DB is a tier, not a crash hazard).

## Known limitations
- A valid Upstox access token is mandatory (they expire daily). Without one the
  app is intentionally empty rather than illustrative.
- Candle coverage across the full 228-underlying universe grows progressively:
  the background warmer fetches a couple of symbols per cycle to respect
  provider rate limits, so `coverage.withCandles` starts small and climbs. FMPI
  components that need candles report reduced coverage until then — they are
  never defaulted to zero.
- CVD / footprint are UNAVAILABLE on the REST tier (no aggressor-side prints).
  A Market Data Feed V3 protobuf WebSocket subscription would be required.
- Intraday rolling OI windows (5m/15m) need the app to have been running for
  that long in the session; before then they correctly report N/A.
- Multi-node scale-out would move the worker tier behind a queue; the current
  single-process design is production-correct for one instance.
