/**
 * Services layer contracts: business logic lives ONLY here.
 *
 * SaleService owns window gate + status composition.
 * PurchaseService owns canonicalization + claim orchestration + error mapping.
 *
 * Abstract deps (Database/Cache/Logger) are constructor-injected as `any`
 * in the impls so parallel repository/cache agents can conform without
 * breaking these contracts. Repository types are imported below where they
 * exist; `| any` fallback keeps services decoupled.
 */

import type { Database as RepositoryDatabase } from '../repositories/database/index.js';
import type { Cache as RepositoryCache } from '../repositories/cache/index.js';

// Abstract dependency aliases. `| any` collapses to `any` by design:
// services never depend on concrete repository/cache shapes.
export type Database = RepositoryDatabase | any;
export type Cache = RepositoryCache | any;
export type Logger = any;

export type SaleStatus = 'upcoming' | 'active' | 'ended';

export interface SaleStatusPayload {
  status: string;
  stockRemaining: number;
  totalStock: number;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

export interface SaleService {
  computeSaleState(
    s: number,
    e: number,
    n: number,
  ): { status: 'upcoming' | 'active' | 'ended' };
  getStatus(nowMs?: number): Promise<{
    status: string;
    stockRemaining: number;
    totalStock: number;
    startsAt: string;
    endsAt: string;
    serverTime: string;
  }>;
  buildStatusPayload(nowMs?: number): Promise<{
    status: string;
    stockRemaining: number;
    totalStock: number;
    startsAt: string;
    endsAt: string;
    serverTime: string;
  }>;
}

export interface PurchaseCommittedEvent {
  unitId: number;
  canonicalUserId: string;
}

export interface PurchaseService {
  attemptPurchase(
    rawUserId: string,
  ): Promise<
    | { ok: true; unitId: number }
    | {
        ok: false;
        error:
          | 'invalid-userId'
          | 'sale-not-active'
          | 'already-purchased'
          | 'sold-out'
          | 'internal-error';
      }
  >;
  getPurchaseByUser(
    rawUserId: string,
  ): Promise<
    | { found: true; unitId: number }
    | { found: false }
    | { error: 'invalid-userId' }
  >;
  onCommitted(
    cb: (ev: { unitId: number; canonicalUserId: string }) => void,
  ): () => void;
}
