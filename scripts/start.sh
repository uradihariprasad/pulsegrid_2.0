#!/bin/bash
# PULSEGRID 2.0 — Render/Node production startup.
set -e

export NODE_ENV=production
export PORT="${PORT:-3000}"
export HOSTNAME="0.0.0.0"

echo "==============================================="
echo "  PULSEGRID 2.0 — starting"
echo "  PORT=$PORT  HOSTNAME=$HOSTNAME"
echo "  DATABASE_URL set: $([ -n "$DATABASE_URL" ] && echo yes || echo NO)"
echo "  PULSEGRID_SECRET set: $([ -n "$PULSEGRID_SECRET" ] && echo yes || echo no)"
echo "==============================================="

# Apply schema (idempotent — no migration files needed with drizzle-kit push)
echo "Applying database schema…"
npx drizzle-kit push --config drizzle.config.json || {
  echo "Schema push failed; retrying with --force"
  npx drizzle-kit push --force --config drizzle.config.json || echo "Proceeding without schema push"
}

# Next.js standalone server (self-contained)
echo "Starting server…"
node .next/standalone/server.js
