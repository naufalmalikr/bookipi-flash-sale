#!/bin/sh
# Todo 2 placeholder entrypoint — Todo 4 replaces with seed + listen.
# Waits for postgres with retry/backoff and NEVER crash-loops: if the
# skeleton (src/index.js) is absent the container holds alive while watching
# DB reachability, so `docker compose stop postgres` shows retry logs.
set -u

echo "[entrypoint] waiting for postgres (DATABASE_URL=${DATABASE_URL:-unset})..."
attempt=0
delay=1
while ! node /app/backend/wait-for-db.mjs; do
  attempt=$((attempt + 1))
  echo "[entrypoint] postgres unreachable (attempt ${attempt}), retrying in ${delay}s (backoff, no crash-loop)"
  sleep "${delay}"
  delay=$((delay * 2))
  if [ "${delay}" -gt 10 ]; then delay=10; fi
done
echo "[entrypoint] postgres reachable"

if [ -f /app/backend/src/index.js ]; then
  echo "[entrypoint] starting backend"
  exec node src/index.js
else
  echo "[entrypoint] src/index.js absent (Todo 4 skeleton pending) - watching DB, holding container alive"
  delay=1
  was_down=false
  while true; do
    if node /app/backend/wait-for-db.mjs 2>/dev/null; then
      if [ "${was_down}" = true ]; then
        echo "[entrypoint] postgres reachable again (recovered, no restart needed)"
      fi
      was_down=false
      delay=1
    else
      echo "[entrypoint] postgres unreachable, retrying in ${delay}s (backoff, no crash-loop)"
      was_down=true
      delay=$((delay * 2))
      if [ "${delay}" -gt 10 ]; then delay=10; fi
    fi
    sleep "${delay}"
  done
fi
