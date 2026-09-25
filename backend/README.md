# Backend — Architecture

Single Fastify service. Postgres owns truth. Memory owns speed only.

- Claim path always hits Postgres. No cache. No shortcut.
- Status path may hit cache. 5s TTL. Invalidated on every commit.
- One process runs all SSE fan-out. No broker.

## Stack

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node | `26.10.0` |
| HTTP | Fastify | `5.12.5` |
| Validation | Zod | `4.6.5` |
| DB driver | `pg` Pool | `8.23.0` |
| CORS | `@fastify/cors` | `11.3.0` |
| Rate limit | `@fastify/rate-limit` | `11.2.0` |
| DB | Postgres | `18.6-alpine` |
| Language | TypeScript | `7.0.2` |
| Tests | Vitest | `5.0.1` |

## Layered architecture

```mermaid
flowchart TB
    subgraph HTTP["interfaces/http"]
        R1["POST /api/purchase"]
        R2["GET /api/purchase/:userId"]
        R3["GET /api/sale/status"]
        R4["GET /api/sale/events (SSE)"]
        ERR["Error handler + Zod compiler"]
    end

    subgraph SVC["services"]
        PS["PurchaseServiceImpl<br/>canonicalize, gate, orchestrate"]
        SS["SaleServiceImpl<br/>window math, status compose"]
        BUS["onCommitted listeners<br/>purchase -> SSE fan-out"]
    end

    subgraph REPO["repositories"]
        DB[("PostgresDatabase<br/>only raw SQL here")]
        CACHE["Cache interface<br/>InMemoryCache, TTL 5s"]
        LOG["Logger interface<br/>ConsoleLogger"]
    end

    subgraph MODEL["models + entities"]
        CON["contracts, requests, responses"]
        ENT["SaleConfig, StockUnit,<br/>Purchase, ClaimResult"]
    end

    R1 & R2 --> PS
    R3 & R4 --> SS
    PS --> DB
    PS --> CACHE
    PS --> BUS
    SS --> DB
    SS --> CACHE
    PS & SS --> LOG
    SVC -. uses .-> CON
    REPO -. returns .-> ENT

    APP["Application.ts (container)<br/>Config.ts (sole env reader)<br/>index.ts (wiring + boot)"]
    APP -. builds .-> SVC
    APP -. builds .-> REPO
```

Rules:

- `interfaces/http` parses and maps. No business logic.
- `services` orchestrate. No SQL. No `process.env`. No Fastify imports.
- `repositories/database/postgresql` is the only place with raw SQL.
- `Config.ts` is the only `process.env` reader (plus scripts).
- `Application.ts` is the container. Wired in `index.ts`.

## Boot sequence

```mermaid
sequenceDiagram
    participant Main as index.ts main()
    participant Cfg as loadConfig()
    participant DB as PostgresDatabase
    participant HTTP as startHttp()

    Main->>Cfg: parse PORT, DATABASE_URL, SALE_START/END, STOCK_QTY, RATE_LIMIT_BUY, PG_POOL_MAX
    Note over Cfg: SALE_START/END must match ^YYYY-MM-DDTHH:MM:SS(.s)?Z$. Exit 1 otherwise.
    Main->>DB: ensureSchema(001_init.sql)
    Main->>DB: upsertSaleConfig(product, qty, start, end)
    Main->>DB: convergeUnits(1, stockQty)
    Main->>DB: getCounts(1)
    Note over Main: warn if stock_units rows != stockQty
    Main->>HTTP: register sale + purchase routes, listen 0.0.0.0:PORT
```

Restarting the backend re-opens the sale window: `upsertSaleConfig` overwrites
`starts_at`/`ends_at` from env on every boot. Correct for a single-shot demo,
surprising in production — a restart during `ended` would revive the sale.

## Data model

| Table | Columns | Constraint |
|---|---|---|
| `sale_config` | `id, product_name, stock_qty, starts_at, ends_at` | `stock_qty > 0`, `ends_at > starts_at` |
| `stock_units` | `id, sale_id, status, sold_at` | `status IN ('available','sold')` |
| `purchases` | `id, sale_id, canonical_user_id, unit_id, raw_user_id, created_at` | `UNIQUE(sale_id, canonical_user_id)`, `UNIQUE(unit_id)` |

Index: `idx_stock_units_sale_status (sale_id, status)`.

Timeouts: `statement_timeout 5s`, `lock_timeout 2s`, pool `max = PG_POOL_MAX`.

Why row-per-unit:

- 100 rows spread contention. One counter row serializes everything.
- Sold rows can never exceed seeded rows. Oversell is structurally impossible.
- Crash before commit rolls back. Row stays `available`. No reaper needed.

## Claim protocol (`POST /api/purchase`)

```mermaid
sequenceDiagram
    participant H as Handler
    participant P as PurchaseService
    participant D as PostgresDatabase
    participant C as Cache
    participant S as SSE listeners

    H->>P: attemptPurchase(rawUserId)
    P->>P: canonicalizeUserId() (throw -> invalid-userId)
    P->>D: getSaleConfig()
    P->>P: computeGate(start, end, Date.now()) (fail -> sale-not-active)
    P->>D: findPurchaseByCanonical(1, canonical) (found -> already-purchased)
    P->>D: claimPurchase(1, canonical, raw)
    Note over D: BEGIN → in-txn window re-gate → SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1 → UPDATE sold + INSERT purchase → COMMIT
    alt no row
        D-->>P: sold-out (ROLLBACK)
    else unique violation 23505
        D-->>P: already-purchased (ROLLBACK)
    else ok
        D-->>P: unitId (COMMIT)
        P->>C: invalidate()
        P->>S: broadcast({unitId, canonicalUserId})
    end
    P-->>H: {ok, unitId} or {error}
```

Points:

- Two gates: pre-txn (fast fail) + in-txn (authoritative). Clock is always server `Date.now()`.
- Both gate copies delegate to the same pure `computeGate` (`src/utilities`), so the window boundary can only change in one place.
- Fast-path repeat check (`findPurchaseByCanonical`) avoids opening a txn for known buyers.
- Same-user race still safe: `UNIQUE(sale_id, canonical_user_id)` converts a concurrent duplicate to `already-purchased` (23505) while stock remains.
- Exhausted claim returns `sold-out` deterministically. A same-user request that slips past the fast path in the instant before the winner commits can then read `sold-out` instead of `already-purchased` — an accepted mislabel (the UNIQUE constraint still guarantees one purchase per user).
- `SKIP LOCKED` skips rows locked by concurrent txns. 1,000-way contention fails fast to `409`, not queue pile-up.
- Cache invalidation happens on commit only. Claim path never reads cache.
- SSE listener failure never breaks the claim response (try/catch per callback).

Canonicalization (`canonicalizeUserId`, backend-authoritative):

- Always: trim + lowercase. Reject inner whitespace, missing `@`, leading/trailing/consecutive dots, dotless domain.
- Gmail only (`gmail.com`, `googlemail.com` → `gmail.com`): strip `+tag`, strip dots.
- Non-Gmail: only trim + lowercase. `u.s.e.r@outlook.com` ≠ `user@outlook.com`.
- Raw email stored for audit. UNIQUE sits on canonical form.

## Status + SSE read path

```mermaid
flowchart LR
    A["GET /api/sale/status"] --> B{"cache.getStatus() hit<br/>+ totalStock match?"}
    B -->|yes| C["return cached stockRemaining"]
    B -->|no| D["countAvailable(1)<br/>setStatus()"]
    D --> E["return fresh + window state"]

    F["GET /api/sale/events"] --> G["buildStatusPayload()<br/>always fresh COUNT"]
    G --> H["hijack reply, push initial frame"]
    H --> I["onCommitted -> fan-out"]
    H --> J["2s tick -> fan-out"]
    H --> K["15s :heartbeat comment"]
```

Points:

- `GET /api/sale/status` → `SaleService.getStatus()`. Cache hit saves one `COUNT`.
- `GET /api/sale/events` → `SaleService.buildStatusPayload()`. Bypasses cache by design.
- Timers start on first SSE client, stop on last disconnect. No work with zero listeners.
- One `COUNT` per tick serves all clients. 1,000 pollers would cost ~333 rps at 3s intervals.
- Window transitions log once (`upcoming -> active -> ended`).

## Endpoints

Errors share `{ error, message }`. Frontend renders codes verbatim.

| Method & path | Success | Failures |
|---|---|---|
| `GET /health` | `200 { ok: true }` | — |
| `GET /api/sale/status` | `200 { status, stockRemaining, totalStock, startsAt, endsAt, serverTime }` | `500 internal-error` (not configured) |
| `GET /api/sale/events` | `200 text/event-stream`, `event: status` frames | `500 internal-error` (status load fail) |
| `POST /api/purchase` `{ userId }` | `201 { result: purchased, unitId }` | `400 invalid-userId`, `403 sale-not-active`, `409 already-purchased`, `409 sold-out`, `429 rate-limited` |
| `GET /api/purchase/:userId` | `200 { result: purchased, unitId }` | `400 invalid-userId`, `404 not-purchased` |

Notes:

- `POST /api/purchase` needs no idempotency key. Repeat buy → `409 already-purchased`.
- Rate limit applies to buy route only. Off when `RATE_LIMIT_BUY=0` (k6 shares one NAT IP).
- Zod rejects bad bodies at the Fastify validator layer → `400 invalid-userId`.
- Malformed JSON → `400 bad-request`. Unknown route → `404 not-found`.

## Config

| Env | Default | Rule |
|---|---|---|
| `PORT` | `3001` | 1–65535, else warn + fallback |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/flashsale` | compose overrides to `postgres:5432` |
| `SALE_START` / `SALE_END` | now+60s / now+10min | UTC ISO-8601 with trailing `Z`, else exit 1. End must be after start. |
| `STOCK_QTY` | `100` | Positive int, else exit 1 |
| `SALE_PRODUCT` | `Bookipi Flash Widget` | Free text |
| `RATE_LIMIT_BUY` | `10` | Req/min/IP on buy route. `0` disables. |
| `PG_POOL_MAX` | `50` | Positive int, else warn + fallback |
| `TRUST_PROXY` | `0` | `1`/`true` enables `X-Forwarded-For` trust. Keep `0` unless a trusted proxy fronts the backend; otherwise clients can rotate the header to evade the buy rate limit. |

## File map

| Path | Owns |
|---|---|
| `src/index.ts` | Wiring, schema ensure, seed converge, boot |
| `src/Config.ts` | Env parse + validation |
| `src/Application.ts` | Container interface |
| `src/interfaces/http/index.ts` | Fastify build, CORS, rate-limit plugin, error handler |
| `src/interfaces/http/handlers/api/purchase/` | Buy + lookup routes, status-code mapping |
| `src/interfaces/http/handlers/api/sale/` | Status route, SSE hijack, tick/heartbeat timers |
| `src/services/purchase/` | Canonicalize, gate, claim orchestration, broadcast |
| `src/services/sale/` | `computeSaleState`, `getStatus`, `buildStatusPayload` |
| `src/utilities/` | `computeGate` — the single copy of the window boundary rule |
| `src/repositories/database/postgresql/` | All SQL: config, counts, claim txn, converge |
| `src/repositories/cache/` | `Cache` interface + `InMemoryCache` (`TTL_MS 5000`) |
| `src/repositories/logger/` | `Logger` interface + `ConsoleLogger` |
| `src/models/requests/` | `purchaseBodySchema` |
| `src/models/responses/` | `envelope`, sale + purchase shapes |
| `src/models/*/ *.contract.ts` | Service I/O types |
| `src/entities/` | Table mirrors + read models |
| `src/interfaces/scripts/postgresql/` | `001_init.sql`, `migrate.ts`, `seed.ts`, `probe.ts` |

## Run + test

```sh
npm run dev                # host backend (needs PG up)
npm run build && npm start # compiled output
npm run migrate            # apply 001_init.sql
npm run seed               # upsert config + converge units
npm test                   # unit (Vitest)
npm run test:integration   # integration vs real PG
```

## Scaling lane (not built)

- Redis implements `Cache` behind the same `getStatus/setStatus/invalidate` interface.
- Redis pub/sub replaces in-memory `EventEmitter` for SSE across replicas.
- Queue (BullMQ/SQS) smooths bursts. Row-claim SQL stays unchanged inside workers.
- Postgres remains source of truth for claims at any replica count.
