# PULSEGRID 2.0 — Render Deployment Guide

## One-click deploy

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint**, select the repo.
3. Render reads `render.yaml` and provisions:
   - a managed PostgreSQL database (`pulsegrid-db`),
   - a Docker web service (`pulsegrid`),
   - auto-wired `DATABASE_URL`,
   - auto-generated `PULSEGRID_SECRET` (64 chars) for credential encryption.
4. Wait for the build to finish (first build ~5–8 min).
5. Open the service URL.
6. Enter your Upstox access token in the header (top-left) and click **Save & verify**.

That's it.

## Manual deploy (no blueprint)

If you prefer to create resources yourself:

### Database

1. Render Dashboard → **New → PostgreSQL**.
2. Name: `pulsegrid-db`, plan: `starter`.
3. Copy the **Internal Database URL** (service-to-service, no public egress cost) or the External URL.

### Web service

1. Render Dashboard → **New → Web Service**.
2. Connect the GitHub repo (or use a Docker registry if you pre-build the image).
3. Runtime: **Docker** (uses the included `Dockerfile`).
4. Add environment variables:

```
DATABASE_URL=<the Postgres URL>
PULSEGRID_SECRET=<generate a 64-char random string>
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
```

5. Leave the default start command as `sh ./start.sh` (or override with that).

## What runs when

- **Build**: `npm ci` → `npm run build` → standalone Next.js output.
- **Start**: `scripts/start.sh`
  - applies the Drizzle schema (`drizzle-kit push`),
  - starts `.next/standalone/server.js` on `PORT` (Render sets it) bound to `0.0.0.0`.
- **In runtime**: the Upstox worker, option-chain pollers, background engines and Feed V3 WebSocket all run in the same process via `instrumentation.ts`.

## Healthchecks

Render pings `/api/health`:

```json
{
  "ok": true,
  "db": true,
  "engine": { "transport": "WEBSOCKET", "universe": 228, ... }
}
```

If `transport` shows `REST POLL` instead of `WEBSOCKET` during market hours, check the feed status in `/api/market-status`.

## Important production notes

1. **Plan**: use `starter` (or higher) so the service isn't spun down — the background workers must stay alive to accumulate OI history.
2. **Database**: `DATABASE_URL` should point to the *managed* Render Postgres instance. The app enables SSL automatically for `render.com` URLs.
3. **Upstox token**: enter via the UI token control (recommended) or set `UPSTOX_ACCESS_TOKEN`. The UI-entered token is the vault source; an env token is used only as a fallback.
4. **Security**: with no admin token in the app (by design), provider settings are protected by same-origin + rate limiting. If you expose the URL publicly, put it behind Render's password protection or your own SSO boundary.
5. **Cold start**: the first minute after deploy may show empty states while the instrument master (~228 F&O underlyings) downloads and the option chain warms up. This is expected and self-resolves.

## Logs

Key lines to look for:

```
Applying database schema…
[✓] Changes applied
Starting server…
Upstox feed: OPEN (456 subs)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails at `npm ci` | Ensure `package-lock.json` is committed |
| `db: false` in `/api/health` | Verify `DATABASE_URL` is the Render internal URL and SSL auto-enabled is fine |
| `NO_TOKEN` on every module | Enter the Upstox token in the header control |
| `TOKEN UNVERIFIED` | Re-enter a valid token; Upstox tokens expire daily |
| No candles after hours | Expected — charts fall back to the last real trading session |
| Empty scanner/dominance | Coverage is growing; refresh after a minute |

## Local first (optional)

```bash
cp .env.example .env
# edit DATABASE_URL to point to your local Postgres
npm ci
npm run build
npm start
```
