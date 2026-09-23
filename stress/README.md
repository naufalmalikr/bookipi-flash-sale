# Stress: 1000 VUs vs 100 units (Todo 14)

## What this proves

`purchase-spike.js` ramps to **1000 virtual users** against **100 stock units**.
VUs loop for the run duration, each iteration making one `POST /api/purchase`
with a globally unique email
(`vu<VU>-it<ITER>-<ts>@load.test`, unique per VU *and* per iteration, so
`400 invalid-userId` and `409 already-purchased` are impossible by
construction). Expected outcome:

- exactly **100 × `201 purchased`** (one per unit),
- the rest × `409 sold-out` (post-exhaustion, the only other possible status),
- `SELECT count(*) FROM purchases` == 100,
  `SELECT count(*) FROM stock_units WHERE status='sold'` == 100,
- `SELECT canonical_user_id, count(*) ... HAVING count(*)>1` → 0 rows,
  `SELECT unit_id, count(*) ... HAVING count(*)>1` → 0 rows.

## Rate-limit bypass (why `RATE_LIMIT_BUY=0` exists)

k6 VUs share the runner's source IP (single NAT), so a per-IP limit of
10/min would turn ~990 legitimate buyers into `429 rate-limited` — measuring
the limiter, not the claim path. The bypass is a boot-time switch, not a
logic change:

- `backend/src/env.ts`: `RATE_LIMIT_BUY=0` (or negative) parses to `0` =
  disabled; positive integers set max req/min/IP; non-numeric → default 10.
- `backend/src/routes/purchase.ts`: when `rateLimitBuy <= 0` the route is
  registered **without** a `config.rateLimit` block; the claim transaction,
  window gate, canonicalization, and error envelope are untouched.

Chosen over a `TRUSTED_LOAD_CIDRS` allowlist because it is one env var, needs
no CIDR plumbing through compose, and cannot leak into production
unnoticed (production compose omits the override → default 10 applies).

## Prerequisites

- `docker compose` stack up; Postgres reachable; sale window ACTIVE.
- Fresh 100-unit seed: reseed with `STOCK_QTY=100` (boot upserts
  `sale_config` from env and tops up units).
- Backend rebuilt with the bypass code + booted with `RATE_LIMIT_BUY=0`.

Example boot (run from repo root; window = now-1min → now+10min):

```sh
SALE_START=$(date -u -d '-1 min' +%Y-%m-%dT%H:%M:%SZ) \
SALE_END=$(date -u -d '+10 min' +%Y-%m-%dT%H:%M:%SZ) \
STOCK_QTY=100 RATE_LIMIT_BUY=0 \
docker compose up --build -d backend
```

Verify: `curl -s localhost:3001/api/sale/status` shows `"status":"active"`
and `stockRemaining` 100.

## Run

k6 runs from Docker (host networking reaches `localhost:3001`):

```sh
docker run --rm --network host --user "$(id -u):$(id -g)" \
  -v "$PWD/stress:/scripts" \
  -e K6_TS="$(date +%s%N)" \
  grafana/k6 run --out json=/scripts/results.json /scripts/purchase-spike.js
```

(`--user` matches host UID so the container can write `results.json` into
the bind-mounted `stress/` dir.)

Stages: 0→200 VUs in 20s, →1000 in 30s, hold 1000 for 30s, ramp down 10s.
Runtime ≈ 90s; fits inside the 10-minute window with margin.

## Thresholds — honest note

- `checks: ['rate>0.99']` is the gating threshold (every response must be
  201-with-result or 409-with-error-code).
- k6's `http_req_failed` counts **any** status ≥ 400 as failed, including the
  *expected* `409 sold-out` responses (the bulk of iterations) — so its rate
  (~0.999) is recorded as informational only, NOT gated. Gating on it would
  invert the proof (a perfect exact-100 run fails it). The real assertions
  are `checks` + the post-run SQL counts above.
- `k6 run` exits 0 when `checks` passes.

## Failure demo (why the bypass exists)

With the default limit (`RATE_LIMIT_BUY=10`), 15 rapid `POST /api/purchase`
with invalid bodies from one IP → `10×400 + 5×429`: the limiter fires before
validation, so a single-IP 1000-VU run would be 429-polluted and prove
nothing. Captured in `.omo/evidence/task-14-flash-sale-build-fail.log`.

## Post-run verification SQL

```sql
SELECT count(*) AS purchases FROM purchases;                       -- expect 100
SELECT count(*) AS sold FROM stock_units WHERE status='sold';      -- expect 100
SELECT canonical_user_id, count(*) FROM purchases
 GROUP BY canonical_user_id HAVING count(*)>1;                     -- expect 0 rows
SELECT unit_id, count(*) FROM purchases
 GROUP BY unit_id HAVING count(*)>1;                               -- expect 0 rows
```

## Provenance

Proof run: `stress/results-summary.json` (committed census: 100x201 /
124,884x409 / 0 other + SQL counts) + log
`.omo/evidence/task-14-flash-sale-build.log` (k6 version, boot env, run
output, SQL counts). Raw `stress/results.json` (~470MB) is git-ignored and
reproducible via the Run section above. Final DB state is the consumed proof itself
(100/100 sold); do NOT reseed after the proof — reseeding would erase it.
