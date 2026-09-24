export interface AttemptPurchaseInput {
  rawUserId: string;
}

export type AttemptPurchaseErrorCode =
  | 'invalid-userId'
  | 'sale-not-active'
  | 'already-purchased'
  | 'sold-out'
  | 'internal-error';

export type AttemptPurchaseOutput =
  | { ok: true; unitId: number }
  | { ok: false; error: AttemptPurchaseErrorCode };

export type GetPurchaseOutput =
  | { found: true; unitId: number }
  | { found: false }
  | { error: 'invalid-userId' };

export interface PurchaseCommittedEvent {
  unitId: number;
  canonicalUserId: string;
}
