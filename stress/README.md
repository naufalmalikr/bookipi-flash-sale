# Stress: 1000 VUs vs 100 units (+ duplicate-buyer scenario)

## What this proves

`purchase-spike.js` runs two k6 scenarios against one backend, split by the
automatic `scenario` tag so the censuses never mix:

1. **`spike`** — ramps to **1000 virtual users** against **100 stock units**.
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

2. **`duplicate`** — 10 VUs from t=0 (while the spike ramp is still near zero,
   so stock is plentiful) hammer one fixed email each
   (`dup<VU>-<ts>@load.test`) for 30s. The first attempt wins a unit; every
   later attempt must be rejected via the repeat-buyer fast path or the
   `UNIQUE(sale_id, canonical_user_id)` → `23505` mapping. Thresholds:
   exactly one `201` per email (`dup_201 == 10`), all retries
   `already-purchased`, `dup_soldout == 0`, `dup_other == 0`. This loads the
   one-item-per-user rule at request rates the 2-way integration race cannot
   reach — at ~2,200 rps it answered **10 × `201` + 65,832 × `409
   already-purchased` + 0 other** in 30s with `purchases == 10`, 0 duplicate
   canonical users or units (validated on a fresh 100-unit seed;
   raw output git-ignored, rerun with `K6_DUP_ONLY=true`).

## Thresholds

- `checks{scenario:spike}` and `checks{scenario:duplicate}`: `rate>0.99`
  (every response must parse to a result code or an error envelope).
- Duplicate counters: `dup_201 == 10` (one win per email), `dup_already >= 10`,
  `dup_soldout == 0`, `dup_other == 0`.
- k6's `http_req_failed` counts **any** status ≥ 400 as failed, including the
  *expected* `409` responses (the bulk of iterations) — so its rate (~0.999 in
  the recorded run) is informational only, NOT gated. Gating on it would
  invert the proof. The real assertions are `checks`, the duplicate counters,
  and the post-run SQL counts.
- `k6 run` exits 0 only when the thresholds above pass.

## Rate-limit bypass (why `RATE_LIMIT_BUY=0` exists)

k6 VUs share the runner's source IP (single NAT), so a per-IP limit of
10/min would turn ~990 legitimate buyers into `429 rate-limited` — measuring
the limiter, not the claim path. The bypass is a boot-time switch, not a
logic change:

- `backend/src/Config.ts`: `RATE_LIMIT_BUY=0` disables the limiter; positive
  integers set max req/min/IP; negative or non-numeric warns + falls back to 10.
- `backend/src/interfaces/http/handlers/api/purchase/index.ts`: when `rateLimitBuy <= 0` the route is
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
  grafana/k6:2.3.0 run --out json=/scripts/results.json /scripts/purchase-spike.js
```

(`--user` matches host UID so the container can write `results.json` into
the bind-mounted `stress/` dir.)

Stages: 0→200 VUs in 20s, →1000 in 30s, hold 1000 for 30s, ramp down 10s.
Runtime ≈ 90s; fits inside the 10-minute window with margin. The duplicate
scenario rides along automatically; set `-e K6_DUP_ONLY=true` to run it
standalone against a scratch backend.

## Post-run summary

`stress/summarize.mjs` turns the raw k6 dump into the committed census.
HTTP facts are recomputed from the dump; SQL facts are never derivable from
k6 output, so they must be supplied explicitly — the script exits 1 without
them and never reuses the previous summary's `sql` block:

```sh
# 1. Run the post-run verification SQL above, collect the counts, then:
node stress/summarize.mjs \
  --sql '{"purchases":100,"sold":100,"dup_canonical":0,"dup_unit":0,"distinct_emails":100}'
# reads stress/results.json (git-ignored), rewrites results-summary.json
```

It recomputes the HTTP status census, the `http_req_duration` percentiles per
status (the latency profile), peak VUs, iterations, and checks totals, and
embeds the explicitly supplied SQL block.

## Failure demo (why the bypass exists)

With the default limit (`RATE_LIMIT_BUY=10`), 15 rapid `POST /api/purchase`
with invalid bodies from one IP → `10×400 + 5×429`: the limiter fires before
validation, so a single-IP 1000-VU run would be 429-polluted and prove
nothing. Reproducible locally by booting with the default limit and firing
15 rapid invalid buys from one IP; the committed proof artifacts are
`stress/results-summary.json` + `stress/evidence/k6-proof-excerpt.md`.

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
124,884x409 / 0 other + SQL counts + per-status latency percentiles, all
recomputed from the raw dump by `stress/summarize.mjs`) + log
`stress/evidence/k6-proof-excerpt.md` (k6 version, boot env, run
output, SQL counts). Raw `stress/results.json` (~470MB) is git-ignored and
reproducible via the Run section above. Final DB state is the consumed proof itself
(100/100 sold); do NOT reseed after the proof — reseeding would erase it.

Scenario config of the proof run: **spike only**.
The `duplicate` scenario did not exist yet. So the committed census
(100×201 = 100 distinct buyers, every non-201 a post-exhaustion `sold-out`)
is a pure spike census with no duplicate-scenario traffic mixed in. The
duplicate-scenario numbers quoted above (10×201 + 65,832×409
already-purchased) come from a separate later validation on a fresh seed
(`K6_DUP_ONLY=true`), not from the proof run.
