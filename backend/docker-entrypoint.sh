#!/bin/sh
# Entrypoint: wait for postgres (retry/backoff, no crash-loop),
# then exec the BUILT output. dist/index.js is primary (Dockerfile runs
# `npm run build --workspace=backend`); src/index.js kept only as a
# dev-mode fallback note — compose always ships the built bundle.
set -u

echo "[entrypoint] waiting for postgres (DATABASE_URL=${DATABASE_URL:-unset})..."
attempt=0
delay=1
probe_ok() {
  if [ -f /app/backend/dist/interfaces/scripts/postgresql/probe.js ]; then
    node /app/backend/dist/interfaces/scripts/postgresql/probe.js
  else
    node --experimental-strip-types /app/backend/src/interfaces/scripts/postgresql/probe.ts
  fi
}
while ! probe_ok; do
  attempt=$((attempt + 1))
  echo "[entrypoint] postgres unreachable (attempt ${attempt}), retrying in ${delay}s (backoff, no crash-loop)"
  sleep "${delay}"
  delay=$((delay * 2))
  if [ "${delay}" -gt 10 ]; then delay=10; fi
done
echo "[entrypoint] postgres reachable"

if [ -f /app/backend/dist/index.js ]; then
  echo "[entrypoint] starting backend (dist/index.js)"
  cd /app/backend && exec node dist/index.js
fi

# Fallback (dev only): type-strip the TS sources directly on Node 26.
if [ -f /app/backend/src/index.ts ]; then
  echo "[entrypoint] dist/index.js missing - falling back to src/index.ts (type-stripping dev mode)"
  cd /app/backend && exec node --experimental-strip-types src/index.ts
fi

echo "[entrypoint] no backend bundle found (need dist/index.js or src/index.ts)"
exit 1
