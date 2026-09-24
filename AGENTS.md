# AGENTS.md — bookipi-flash-sale

- Single-product flash sale: 1000 buyers fight for 100 units, Postgres serializes claims, oversell is structurally impossible.
- Correctness lives in Postgres transactions, never in app memory.
- Docs: `README.md` (reviewer path), `STRATEGY.md` (DECIDED 2026-09-23), `PROJECT.md` (brief), `backend/README.md` (arch), `stress/README.md` (proof method).

## Stack (pinned, never `latest`)

- Node `26.10.0` (`.nvmrc`, `engines`, `node:26.10.0-alpine`) / TS `7.0.2` / Postgres `18.6-alpine`.
- Backend: Fastify `5.12.5`, `@fastify/rate-limit` `11.2.0`, `@fastify/cors` `11.3.0`, Zod `4.6.5`, `pg` `8.23.0`, Vitest `5.0.1`.
- Frontend: Vite `8.3.0`, React/ReactDOM `19.3.0`, `@vitejs/plugin-react` `6.1.1`.
- Stress: k6 `v2.3.0` via Docker `grafana/k6` only, no local install.
- Lockfile pins resolved tree; if doc numbers drift, doc is stale not build.

## Layout

- `backend/src/`: `index.ts` (wiring+boot), `Config.ts` (sole env reader), `Application.ts` (container), `interfaces/http/` (routes), `services/purchase|sale/` (orchestration), `repositories/database/postgresql/` (only raw SQL), `repositories/cache/` (`Cache` iface + `InMemoryCache`), `repositories/logger/`, `models/requests|responses|*/ *.contract.ts`, `entities/`, `interfaces/scripts/postgresql/` (`001_init.sql`, `migrate.ts`, `seed.ts`, `probe.ts`).
- `frontend/src/`: `api.ts`, `App.tsx`, `main.tsx`, `App.css`.
- `stress/`: `purchase-spike.js`, `README.md`, `results-summary.json` (proof, committed); `results.json` (~470MB, git-ignored, reproducible).
- Root: `docker-compose.yml`, `.env.example`, `package.json` (workspaces `backend,frontend`), `PROJECT.md`, `STRATEGY.md`, `README.md`.
- Ignore `dist/`, `node_modules/`, `.env` (not `.env.example`), `.omo/`, `.tmp/`, `stress/results.json`.

## Run

- Supported path is compose; PG stays in Docker either way (host `5432` mapped).
- `cp .env.example .env && docker compose up --build -d` — brings `postgres` + `backend:3001` + `frontend:5173`.
- `docker compose logs -f backend` / `docker compose stop` (never `down -v`, wipes proof volume).
- Host dev: `npm --prefix backend run dev` (needs PG up + `DATABASE_URL` at localhost), `npm --prefix frontend run dev`, `npm --prefix frontend run build` (prod check).
- Health: `curl -s localhost:3001/health` → `{"ok":true}`; `curl -s localhost:3001/api/sale/status`; `curl -s -o /dev/null -w "%{http_code}\n" localhost:5173/` → `200`.
- Smoke: `POST localhost:3001/api/purchase -H 'Content-Type: application/json' -d '{"userId":"you@example.com"}'` → fresh DB `201 {result:purchased,unitId}`, consumed DB `409 sold-out`.
- SSE: `curl -N localhost:3001/api/sale/events` — `event: status` on purchase + window change + ~2s tick, plus `:heartbeat` comments.

## Env (`Config.ts` only reader + scripts)

- `SALE_START` / `SALE_END`: UTC ISO-8601 with trailing `Z` (`2026-09-23T07:40:00Z`), regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`, else boot exit 1; `END > START` else exit 1; defaults now+60s / now+10min.
- `STOCK_QTY=100`: positive int else exit 1. `SALE_PRODUCT`: free text, default `Bookipi Flash Widget`.
- `DATABASE_URL`: default `postgres://postgres:postgres@localhost:5432/flashsale`, compose overrides to `postgres:5432`.
- `PORT=3001`: 1–65535 else warn+fallback. `PG_POOL_MAX=50`: positive int else warn+fallback 50.
- `RATE_LIMIT_BUY=10`: req/min/IP on buy route only; `0` disables (k6 shares one NAT IP); non-int warns+fallback 10.
- `VITE_API_URL=http://localhost:3001`: absolute in compose browsers, empty in host dev hits Vite proxy.
- DB timeouts: `statement_timeout 5s`, `lock_timeout 2s`, pool `max=PG_POOL_MAX`.
- Gen window: `SALE_START=$(date -u -d '+60 seconds' +%Y-%m-%dT%H:%M:%SZ)` / `SALE_END=$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)`.

## Architecture rules

- `interfaces/http` parses/maps only, no business logic.
- `services` orchestrate only, no SQL / no `process.env` / no Fastify imports.
- Only `repositories/database/postgresql` contains raw SQL.
- `Config.ts` is only `process.env` reader.
- `Application.ts` is container, wired in `index.ts`.
- Boot: `loadConfig()` → `ensureSchema(001_init.sql)` → `upsertSaleConfig()` → `convergeUnits(1,qty)` → `getCounts(1)` (warn if rows != qty) → `startHttp()` on `0.0.0.0:PORT`.
- CORS open for demo; Zod validator → `400 invalid-userId`; malformed JSON → `400 bad-request`; unknown route → `404 not-found`.

## DB + claim protocol

- `sale_config(id,product_name,stock_qty>0,starts_at,ends_at, CHECK ends_at>starts_at)`.
- `stock_units(id,sale_id,status IN ('available','sold'),sold_at)` — 100 twin rows seeded `available`; index `idx_stock_units_sale_status(sale_id,status)`.
- `purchases(id,sale_id,canonical_user_id,unit_id UNIQUE,raw_user_id,created_at)` — `UNIQUE(sale_id,canonical_user_id)`, `UNIQUE(unit_id)`.
- Claim order (strict): canonicalize (throw → `invalid-userId`) → pre-txn window gate via `getSaleConfig()` → fast-path `hasPriorPurchase()` → single-txn `claimPurchase()`.
- Txn: `BEGIN` → in-txn window re-gate → `SELECT id FROM stock_units WHERE sale_id=$1 AND status='available' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1` → no row = rollback `sold-out` → else `UPDATE sold` + `INSERT purchase` same txn → `COMMIT 201`.
- `SKIP LOCKED` fails fast to `409` under 1000-way contention, no lock pile-up.
- Same-user race → `23505` maps to `already-purchased`; in-txn window fail → `sale-not-active`.
- On commit only: `cache.invalidate()` + broadcast `{unitId,canonicalUserId}`; listener throw never breaks claim.
- Crash before commit rolls back, row stays `available`; no reaper needed.

## Canonicalization (backend-authoritative)

- Always: `trim().toLowerCase()`; reject inner whitespace, missing `@`, leading/trailing/consecutive dots, dotless domain.
- Gmail only (`gmail.com`,`googlemail.com`→`gmail.com`): strip `+tag`, strip dots; `foobar@gmail.com`=`foo.bar@gmail.com`=`foobar+baz@gmail.com` → second try `409 already-purchased`.
- Non-Gmail: trim+lower only; `u.s.e.r@outlook.com` ≠ `user@outlook.com`.
- Raw kept for audit; UNIQUE sits on canonical form.

## Status + SSE

- `SaleService.getStatus()`: authoritative `getSaleConfig()` + `Date.now()` window math (`upcoming/active/ended`, inclusive), cache `getStatus()` if `totalStock` matches else `countAvailable(1)` + `setStatus()`; TTL 5s + invalidate on commit.
- `buildStatusPayload()` (SSE): always fresh `COUNT`, bypasses cache by design.
- Claim path never reads cache.
- SSE: hijacked `text/event-stream`, initial frame + fan-out on commit + ~2s tick + `:heartbeat`; timers start first client, stop last disconnect; one `COUNT` per tick serves all clients.
- Window transitions log once.

## API (envelope `{error,message}`, frontend renders codes verbatim)

- `GET /health` → `200 {ok:true}`.
- `GET /api/sale/status` → `200 {status,stockRemaining,totalStock,startsAt,endsAt,serverTime}`; never 4xx; `500 internal-error` if unconfigured.
- `GET /api/sale/events` → SSE `event: status` same shape; `500` on status load fail.
- `POST /api/purchase {userId}` (Zod email) → `201 {result:purchased,unitId}`; fails `400 invalid-userId`, `403 sale-not-active`, `409 already-purchased`, `409 sold-out`, `429 rate-limited`.
- `GET /api/purchase/:userId` → `200 {result:purchased,unitId}`; fails `400 invalid-userId`, `404 not-purchased`.
- Window uses backend server time; client skew cannot sneak in.
- No `Idempotency-Key`: repeat buy → `409 already-purchased` is idempotency.
- Identity is unauthenticated email (accepted take-home, denial-of-purchase primitive in prod); real sale needs OTP/magic-link/Turnstile.

## Frontend (`frontend/src/api.ts`, `App.tsx`)

- `base = VITE_API_URL ?? ''`; compose uses absolute URL, host dev uses relative `/api` → Vite proxy `localhost:3001`.
- Data: `getStatus()`, `postPurchase(userId)`, `getPurchase(userId)`, `eventsUrl()`; `parseJson` empty→`{}`, bad JSON→`{error:bad-response}`.
- Feed: `EventSource(eventsUrl())` primary, `status` listener resets backoff (1s double to 10s max); `onerror` closes + 5s poll fallback + reconnect; states `connecting|live-sse|polling`.
- Buy: UX `trim()` only, never strip Gmail dots/tags; empty → `invalid-userId` alert; `POST 201` is source of truth, confirm + status refresh are best-effort background only.
- Display: serverTime-derived countdown (`clockOffset = Date.now()-serverTime`, 1s local tick), `toneFor()` per code, server `{error,message}` rendered verbatim.

## Tests + stress

- `npm --prefix backend run test` — unit 4 files/38 tests (canonical vectors, window bounds, error map, Zod schemas).
- `npm --prefix backend run test:integration` — vs real PG 18.6 in Docker: lifecycle `upcoming→active→ended`, Gmail-variant `409`, sold-out, SSE delivery, 5-stock/50-parallel exact-5 probe (exactly five `201`, rest `409`, no dup users/units).
- `npm run migrate` / `npm run seed` — apply `001_init.sql` / upsert config + converge units.
- Stress `stress/purchase-spike.js`: `ramping-vus` 0→200 (20s) →1000 (30s) →hold 1000 (30s) →down (10s), ~90s in 10-min ACTIVE window, `STOCK_QTY=100`, `RATE_LIMIT_BUY=0`.
- Each iter `POST {userId: vu<VU>-it<ITER>-<ts>@load.test}` (unique by construction, so `400`/`already-purchased` impossible); gate is `checks rate>0.99`, `http_req_failed ~0.9991` is informational (k6 flags expected `409`s).
- Run: boot backend with `SALE_START=$(date -u -d '-1 min' ...)` `SALE_END=$(date -u -d '+10 min' ...)` `STOCK_QTY=100 RATE_LIMIT_BUY=0 docker compose up --build -d backend`, then `docker run --rm --network host --user "$(id -u):$(id -g)" -v "$PWD/stress:/scripts" -e K6_TS="$(date +%s%N)" grafana/k6 run --out json=/scripts/results.json /scripts/purchase-spike.js`.
- Proof (`results-summary.json` + `.omo/evidence/task-14-flash-sale-build.log`): 124984 reqs = `100×201` + `124884×409` + 0 other; DB `purchases==100`, `sold==100`; 0 dup canonical/users, 0 dup units, 100 distinct emails; `checks` 249968/249968, exit 0.
- Verify: `SELECT count(*) FROM purchases` (=100); `SELECT count(*) FROM stock_units WHERE status='sold'` (=100); `GROUP BY canonical_user_id/unit_id HAVING count(*)>1` (=0 rows).
- Do NOT reseed after proof; live volume is ephemeral, summary JSON + log are durable record.

## Do / Don't

- Do: keep claim authoritative in Postgres; keep cache read-only for status.
- Do: use server `Date.now()` for gates; display only server-provided times.
- Do: enforce canonicalization in backend; frontend sends raw email as-is.
- Do: invalidate cache + broadcast only after commit.
- Don't: add Redis/queue/WS/bidirectionals — future lane docs-only (Redis `Cache` same iface, Redis pub-sub for SSE, BullMQ/SQS with row-claim unchanged).
- Don't: gate k6 on `http_req_failed`; don't run k6 with default rate limit (single NAT → `429` pollution).
- Don't: poll status at 3s for 1000 users (~333 rps); use SSE.
