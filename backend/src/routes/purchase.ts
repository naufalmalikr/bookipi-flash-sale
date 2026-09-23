/**
 * Claim transaction (Todo 7): POST /api/purchase row-claim + race handling.
 *
 * Order (STRICT):
 *   1. Zod body valid (Fastify validator compiler, registered at route).
 *   2. canonicalizeUserId() -> throw maps to 400 invalid-userId.
 *   3. getSaleState() (authoritative DB read, NEVER cache) -> non-active
 *      maps to 403 sale-not-active BEFORE opening any transaction.
 *   4. Fast-path: SELECT purchases WHERE (sale_id, canonical) -> found maps
 *      to 409 already-purchased (no txn, no locks).
 *   5. BEGIN -> SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1 -> none maps to
 *      409 sold-out (ROLLBACK) -> UPDATE sold + INSERT purchases -> COMMIT
 *      -> invalidateStockCache() -> 201 { result: 'purchased', unitId }.
 *   6. Catch SQLSTATE 23505 -> ROLLBACK -> 409 already-purchased
 *      (same-user race that slipped past the fast-path); other errors ->
 *      ROLLBACK -> 500 internal-error.
 *
 * Forbidden here: cache reads on the claim path, FOR UPDATE without
 * SKIP LOCKED, single-counter qty-=1, retry on unique-violation, client-time
 * checks.
 *
 * SSE hook (Todo 9): this module keeps a tiny subscriber list.
 * Call onPurchaseCommitted(cb) from the SSE broadcaster; every committed
 * claim fans out { unitId, canonicalUserId }. The list is in-memory and
 * single-instance, matching the EventEmitter plan. invalidateStockCache()
 * is ALWAYS called on commit regardless of listeners.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { getSaleState } from '../services/sale.js';
import { canonicalizeUserId } from '../utils/canonicalize.js';
import { invalidateStockCache } from '../cache/stockCache.js';

/** Zod body: mirrors the skeleton stub (invalid -> 400 invalid-userId). */
export const purchaseBodySchema = z.object({ userId: z.email() });

export interface PurchaseCommittedEvent {
  unitId: number;
  canonicalUserId: string;
}

type PurchaseCommittedListener = (ev: PurchaseCommittedEvent) => void;

const listeners = new Set<PurchaseCommittedListener>();

/** SSE broadcaster (Todo 9) subscribes here; no-op until then. */
export function onPurchaseCommitted(cb: PurchaseCommittedListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function broadcast(ev: PurchaseCommittedEvent): void {
  for (const cb of listeners) {
    try {
      cb(ev);
    } catch {
      // A failing SSE listener must never break the claim response.
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

export async function registerPurchaseRoute(
  app: FastifyInstance,
  rateLimitBuy: number,
): Promise<void> {
  app.get('/api/purchase/:userId', (req, reply) => {
    void (async () => {
      const raw = (req.params as { userId: string }).userId;

      let canonical: string;
      try {
        canonical = canonicalizeUserId(raw);
      } catch {
        void reply
          .code(400)
          .send({ error: 'invalid-userId', message: 'Param must be a valid email userId' });
        return;
      }

      try {
        const found = await pool.query<{ unit_id: number }>(
          `SELECT unit_id FROM purchases
            WHERE sale_id = 1 AND canonical_user_id = $1 LIMIT 1`,
          [canonical],
        );
        const row = found.rows[0];
        if (row === undefined) {
          void reply
            .code(404)
            .send({ error: 'not-purchased', message: 'This user has not purchased' });
          return;
        }
        void reply.code(200).send({ result: 'purchased', unitId: row.unit_id });
      } catch {
        void reply
          .code(500)
          .send({ error: 'internal-error', message: 'Failed to check purchase' });
      }
    })();
  });

  // rateLimitBuy <= 0 DISABLES per-route rate limiting (Todo 14 k6 load
  // switch; single route-options object keeps the claim handler untouched).
  const buyRouteOptions =
    rateLimitBuy > 0
      ? {
          schema: { body: purchaseBodySchema },
          config: { rateLimit: { max: rateLimitBuy, timeWindow: '1 minute' } },
        }
      : { schema: { body: purchaseBodySchema } };

  app.post(
    '/api/purchase',
    buyRouteOptions,
    (req, reply) => {
      void (async () => {
        const rawUserId = (req.body as { userId: string }).userId;

        let canonical: string;
        try {
          canonical = canonicalizeUserId(rawUserId);
        } catch {
          void reply
            .code(400)
            .send({ error: 'invalid-userId', message: 'Body must be { userId: <email> }' });
          return;
        }

        let saleStatus: string;
        try {
          saleStatus = (await getSaleState()).status;
        } catch {
          void reply
            .code(500)
            .send({ error: 'internal-error', message: 'Failed to load sale state' });
          return;
        }
        if (saleStatus !== 'active') {
          void reply
            .code(403)
            .send({ error: 'sale-not-active', message: 'Sale is not currently active' });
          return;
        }

        try {
          const prior = await pool.query(
            `SELECT id FROM purchases
              WHERE sale_id = 1 AND canonical_user_id = $1 LIMIT 1`,
            [canonical],
          );
          if ((prior.rowCount ?? 0) > 0) {
            void reply
              .code(409)
              .send({ error: 'already-purchased', message: 'This user already purchased' });
            return;
          }
        } catch {
          void reply
            .code(500)
            .send({ error: 'internal-error', message: 'Failed to check prior purchase' });
          return;
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const claimed = await client.query<{ id: number }>(
            `SELECT id FROM stock_units
              WHERE sale_id = 1 AND status = 'available'
              ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
          );
          const unitRow = claimed.rows[0];
          if (unitRow === undefined) {
            await client.query('ROLLBACK');
            void reply
              .code(409)
              .send({ error: 'sold-out', message: 'All units are sold' });
            return;
          }
          const unitId: number = unitRow.id;
          await client.query(
            `UPDATE stock_units SET status = 'sold', sold_at = now() WHERE id = $1`,
            [unitId],
          );
          await client.query(
            `INSERT INTO purchases (sale_id, canonical_user_id, unit_id, raw_user_id)
             VALUES (1, $1, $2, $3)`,
            [canonical, unitId, rawUserId],
          );
          await client.query('COMMIT');
          invalidateStockCache();
          broadcast({ unitId, canonicalUserId: canonical });
          void reply.code(201).send({ result: 'purchased', unitId });
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // ROLLBACK itself failing leaves nothing actionable; fall through.
          }
          if (isUniqueViolation(err)) {
            void reply
              .code(409)
              .send({ error: 'already-purchased', message: 'This user already purchased' });
            return;
          }
          req.log.error({ err }, 'purchase transaction failed');
          void reply
            .code(500)
            .send({ error: 'internal-error', message: 'Purchase failed' });
        } finally {
          client.release();
        }
      })();
    },
  );
}
