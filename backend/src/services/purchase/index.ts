/**
 * PurchaseServiceImpl: owns canonicalization + claim orchestration + error mapping.
 *
 * Claim order (STRICT, STRATEGY.md §4.2):
 *   1. canonicalize (throw -> invalid-userId)
 *   2. database.getSaleConfig window gate (non-active -> sale-not-active BEFORE txn)
 *   3. database.findPurchaseByCanonical fast-path (-> already-purchased)
 *   4. database.claimPurchase (-> sold-out / already-purchased / ok)
 *   5. on success: cache.invalidate() + broadcast to listeners
 *   6. catch-all -> internal-error
 *
 * The window boundary rule lives in utilities/computeGate so it cannot
 * drift from SaleServiceImpl.computeSaleState or the in-transaction
 * re-gate in PostgresDatabase.claimPurchase.
 *
 * Canonicalization is backend-authoritative and lives in this file
 * (canonicalizeUserId below): trim + lowercase always; Gmail-only
 * (gmail.com | googlemail.com -> gmail.com): strip dots, strip +tag.
 *
 * No raw SQL, no process.env, no Fastify imports.
 */

import type { Database } from '../../repositories/database/index.ts';
import type { Cache } from '../../repositories/cache/index.ts';
import type { Logger } from '../../repositories/logger/index.ts';
import type { PurchaseService } from '../index.ts';
import { computeGate } from '../../utilities/index.ts';
import type {
  AttemptPurchaseOutput,
  GetPurchaseOutput,
  PurchaseCommittedEvent,
  PurchaseCommittedListener,
} from '../../models/purchase/purchase.contract.ts';
import { SALE_ID } from '../../entities/index.ts';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Maximum raw input length: RFC 5321 caps the email path at 254 octets.
 * Longer inputs are rejected as invalid-userId rather than stored.
 */
const MAX_USERID_LENGTH = 254;

export function canonicalizeUserId(raw: string): string {
  if (typeof raw !== 'string') {
    throw new Error('invalid-userId');
  }
  if (raw.length > MAX_USERID_LENGTH) {
    throw new Error('invalid-userId');
  }
  // NFKC folds fullwidth/compatibility chars (e.g. fullwidth dots, U+FF0E)
  // to their ASCII forms before validation, so spoofed separators cannot
  // slip past the dot/whitespace checks below. Zero-width chars (U+200B
  // etc.) have no NFKC fold and are rejected by the local/domain guards.
  const normalized = raw.normalize('NFKC');
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error('invalid-userId');
  }
  const trimmed = normalized.trim();
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
      if (!computeGate(cfg.startsAt.getTime(), cfg.endsAt.getTime(), nowMs)) {
        return { ok: false, error: 'sale-not-active' };
      }

      // Fast-path repeat-buyer check (no txn, no locks).
      const prior: { unitId: number } | undefined =
        await this.database.findPurchaseByCanonical(SALE_ID, canonical);
      if (prior !== undefined) {
        return { ok: false, error: 'already-purchased' };
      }

      // Single-txn claim (repository owns SQL + in-txn re-gate).
      const claimed:
        | { ok: true; unitId: number }
        | { ok: false; error: 'sold-out' | 'already-purchased' } =
        await this.database.claimPurchase(SALE_ID, canonical, rawUserId);
      if (!claimed.ok) {
        // Error mapping: sold-out / already-purchased pass through verbatim.
        return { ok: false, error: claimed.error };
      }

      // Commit side-effects: invalidate cache ALWAYS, then fan out.
      this.cache.invalidate();
      this.broadcast({ unitId: claimed.unitId, canonicalUserId: canonical });
      return { ok: true, unitId: claimed.unitId };
    } catch (err) {
      // In-txn window re-gate surfaces as a thrown message from the
      // repository claim path (returned outcomes never throw).
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'sale-not-active') {
        return { ok: false, error: 'sale-not-active' };
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
    try {
      const found: { unitId: number } | undefined =
        await this.database.findPurchaseByCanonical(SALE_ID, canonical);
      if (found === undefined) return { found: false };
      return { found: true, unitId: found.unitId };
    } catch (err) {
      this.logger.error('purchase lookup failed', err);
      throw err;
    }
  }
}
