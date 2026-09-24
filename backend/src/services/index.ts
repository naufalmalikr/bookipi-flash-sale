import type { SaleStatusResponse } from '../models/responses/sale.response.js';
import type {
  AttemptPurchaseOutput,
  GetPurchaseOutput,
  PurchaseCommittedEvent,
} from '../models/purchase/purchase.contract.js';

export type { Database } from '../repositories/database/index.js';
export type { Cache } from '../repositories/cache/index.js';
export type { Logger } from '../repositories/logger/index.js';

export interface SaleService {
  computeSaleState(
    s: number,
    e: number,
    n: number,
  ): { status: 'upcoming' | 'active' | 'ended' };
  getStatus(nowMs?: number): Promise<SaleStatusResponse>;
  buildStatusPayload(nowMs?: number): Promise<SaleStatusResponse>;
}

export interface PurchaseService {
  attemptPurchase(rawUserId: string): Promise<AttemptPurchaseOutput>;
  getPurchaseByUser(rawUserId: string): Promise<GetPurchaseOutput>;
  onCommitted(cb: (ev: PurchaseCommittedEvent) => void): () => void;
}

export type {
  SaleStatus,
  SaleStatusPayload,
  GetStatusInput,
  GetStatusOutput,
} from '../models/sale/sale.contract.js';
export type {
  PurchaseCommittedEvent,
  AttemptPurchaseInput,
  AttemptPurchaseErrorCode,
  AttemptPurchaseOutput,
  GetPurchaseOutput,
} from '../models/purchase/purchase.contract.js';
