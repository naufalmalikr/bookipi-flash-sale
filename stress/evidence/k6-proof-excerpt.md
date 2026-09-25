# k6 proof excerpt — 1000 VUs vs 100 stock

Trimmed durable excerpt. Full raw `results.json` (~470MB) is git-ignored and
reproducible via `stress/README.md`. Source log was ephemeral build output;
this file is the committed record alongside `stress/results-summary.json`.

## Toolchain

- k6: `k6 v2.3.0 (commit/e088784614, go1.27.1, linux/amd64)` via `grafana/k6:2.3.0` Docker image
- Script: `stress/purchase-spike.js` (ramping-vus 0→200→1000 hold 30s→0, unique vu-it-ts@load.test per iteration)

## Boot env

- `SALE_START=2026-09-23T10:03:13Z SALE_END=2026-09-23T10:14:13Z STOCK_QTY=100 RATE_LIMIT_BUY=0`
- Pre-run: `stockRemaining 100`, `available 100 / sold 0 / purchases 0`

## Run summary (exit 0)

- `checks`: 249968/249968 pass (`rate>0.99` gate)
- `http_reqs`: 124984 total
- `http_req_failed`: ~0.9991 informational only (expected post-exhaustion 409s)

## HTTP census

- `201`: 100
- `409`: 124884
- `other`: 0

## Post-run SQL

- `SELECT count(*) FROM purchases` → 100
- `SELECT count(*) FROM stock_units WHERE status='sold'` → 100
- `GROUP BY canonical_user_id HAVING count(*)>1` → 0 rows
- `GROUP BY unit_id HAVING count(*)>1` → 0 rows
- distinct buyer emails → 100

## Machine summary

See `stress/results-summary.json` for the full committed census.
