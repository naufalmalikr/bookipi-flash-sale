import type { ErrorEnvelope } from './envelope.ts';

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
