/**
 * PurchaseServiceImpl: owns canonicalization + claim orchestration + error mapping.
 *
 * Claim order (STRICT, STRATEGY.md §4.2):
 *   1. canonicalize (throw -> invalid-userId)
 *   2. database.getSaleConfig window gate (non-active -> sale-not-active BEFORE txn)
 *   3. database.hasPriorPurchase fast-path (-> already-purchased)
 *   4. database.claimPurchase (-> sold-out / already-purchased / ok)
 *   5. on success: cache.invalidate() + broadcast to listeners
 *   6. catch-all -> internal-error
 *
 * Canonicalization is backend-authoritative, copied verbatim from
 * backend/src/utils/canonicalize.ts: trim + lowercase always; Gmail-only
 * (gmail.com | googlemail.com -> gmail.com): strip dots, strip +tag.
 *
 * No raw SQL, no process.env, no Fastify imports.
 */

import { z } from 'zod';
import type { Database } from '../../entities/Database.js';
import type { Cache } from '../../entities/Cache.js';
import type { Logger } from '../../entities/Logger.js';
import type {
  AttemptPurchaseOutput,
  GetPurchaseOutput,
  PurchaseCommittedEvent,
  PurchaseService,
} from '../../models/purchase/purchase.contract.js';

/** Zod email schema feeding the purchase path (mirrors purchaseBodySchema). */
export const userIdSchema = z.string().trim().pipe(z.email());

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export function canonicalizeUserId(raw: string): string {
  if (typeof raw !== 'string') {
    throw new Error('invalid-userId');
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('invalid-userId');
  }
  const lowered = trimmed.toLowerCase();
  // Reject any whitespace inside (spaces, tabs, etc.).
  if (/\s/.test(lowered)) {
    throw new Error('invalid-userId');
  }
  const parts = lowered.split('@');
  if (parts.length !== 2) {
    throw new Error('invalid-userId');
  }
  const local = parts[0] as string;
  const domain = parts[1] as string;
  if (local === '' || domain === '') {
    throw new Error('invalid-userId');
  }
  // Minimal non-email guard: domain must contain a dot, local/domain must not
  // start or end with a dot, no consecutive dots.
  if (
    !domain.includes('.') ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    local.includes('..') ||
    domain.includes('..')
  ) {
    throw new Error('invalid-userId');
  }

  if (GMAIL_DOMAINS.has(domain)) {
    const withoutTag = local.split('+')[0] as string;
    const stripped = withoutTag.replace(/\./g, '');
    if (stripped === '') {
      throw new Error('invalid-userId');
    }
    return `${stripped}@gmail.com`;
  }

  return `${local}@${domain}`;
}

export type PurchaseCommittedListener = (ev: PurchaseCommittedEvent) => void;

export class PurchaseServiceImpl implements PurchaseService {
  private database: Database;
  private cache: Cache;
  private logger: Logger;
  private listeners = new Set<PurchaseCommittedListener>();

  constructor(database: Database, cache: Cache, logger: Logger) {
    this.database = database;
    this.cache = cache;
    this.logger = logger;
  }

  computeGate(startsAtMs: number, endsAtMs: number, nowMs: number): boolean {
    if (nowMs < startsAtMs) return false;
    if (nowMs > endsAtMs) return false;
    return true;
  }

  onCommitted(cb: PurchaseCommittedListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private broadcast(ev: PurchaseCommittedEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch {
        // A failing SSE listener must never break the claim response.
      }
    }
  }

  async attemptPurchase(rawUserId: string): Promise<AttemptPurchaseOutput> {
    let canonical: string;
    try {
      canonical = canonicalizeUserId(rawUserId);
    } catch {
      return { ok: false, error: 'invalid-userId' };
    }

    try {
      // Pre-txn window gate (authoritative sale_config read, never cache).
      const cfg:
        | { startsAt: Date; endsAt: Date }
        | undefined = await this.database.getSaleConfig();
      if (cfg === undefined) {
        return { ok: false, error: 'internal-error' };
      }
      const nowMs = Date.now();
      if (
        !this.computeGate(cfg.startsAt.getTime(), cfg.endsAt.getTime(), nowMs)
      ) {
        return { ok: false, error: 'sale-not-active' };
      }

      // Fast-path repeat-buyer check (no txn, no locks).
      const prior: boolean = await this.database.hasPriorPurchase(1, canonical);
      if (prior) {
        return { ok: false, error: 'already-purchased' };
      }

      // Single-txn claim (repository owns SQL + in-txn re-gate).
      const claimed:
        | { ok: true; unitId: number }
        | { ok: false; error: 'sold-out' | 'already-purchased' } =
        await this.database.claimPurchase(1, canonical, rawUserId);
      if (!claimed.ok) {
        // Error mapping: sold-out / already-purchased pass through verbatim.
        return { ok: false, error: claimed.error };
      }

      // Commit side-effects: invalidate cache ALWAYS, then fan out.
      this.cache.invalidate();
      this.broadcast({ unitId: claimed.unitId, canonicalUserId: canonical });
      return { ok: true, unitId: claimed.unitId };
    } catch (err) {
      // Same-user race that slipped past the fast-path surfaces as a
      // unique-violation message from the repository claim path.
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'sale-not-active') {
        return { ok: false, error: 'sale-not-active' };
      }
      if (msg === 'already-purchased') {
        return { ok: false, error: 'already-purchased' };
      }
      this.logger.error('purchase attempt failed', err);
      return { ok: false, error: 'internal-error' };
    }
  }

  async getPurchaseByUser(rawUserId: string): Promise<GetPurchaseOutput> {
    let canonical: string;
    try {
      canonical = canonicalizeUserId(rawUserId);
    } catch {
      return { error: 'invalid-userId' };
    }
    const found: { unitId: number } | undefined =
      await this.database.findPurchaseByCanonical(1, canonical);
    if (found === undefined) return { found: false };
    return { found: true, unitId: found.unitId };
  }
}
