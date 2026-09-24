import type { ErrorEnvelope } from './envelope.js';

export type PurchaseSuccess = { result: 'purchased'; unitId: number };

export type PurchaseLookupOk = { result: 'purchased'; unitId: number };

export type PurchaseNotPurchased = { result: 'not-purchased' };

export type NotPurchased = PurchaseNotPurchased;

export type PurchaseLookup = PurchaseLookupOk | PurchaseNotPurchased;

export type PurchaseErrorCode =
  | 'invalid-userId'
  | 'sale-not-active'
  | 'already-purchased'
  | 'sold-out'
  | 'rate-limited'
  | 'bad-request'
  | 'not-found'
  | 'not-purchased'
  | 'internal-error';

export type PurchaseError = ErrorEnvelope & { error: PurchaseErrorCode };
