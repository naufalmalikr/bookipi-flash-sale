import type {
  SaleStatus,
  GetStatusOutput,
} from '../models/sale/sale.contract.js';
import type {
  AttemptPurchaseOutput,
  GetPurchaseOutput,
  PurchaseCommittedListener,
} from '../models/purchase/purchase.contract.js';

export interface SaleService {
  computeSaleState(
    s: number,
    e: number,
    n: number,
  ): { status: SaleStatus };
  getStatus(nowMs?: number): Promise<GetStatusOutput>;
  buildStatusPayload(nowMs?: number): Promise<GetStatusOutput>;
}

export interface PurchaseService {
  attemptPurchase(rawUserId: string): Promise<AttemptPurchaseOutput>;
  getPurchaseByUser(rawUserId: string): Promise<GetPurchaseOutput>;
  onCommitted(cb: PurchaseCommittedListener): () => void;
}
