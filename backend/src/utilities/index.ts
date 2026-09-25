/**
 * Pure shared helpers. No SQL, no I/O, no process.env, so any layer can
 * import this without widening its dependencies.
 */

/**
 * Single source of the sale-window boundary rule: the sale is open at every
 * instant where startsAtMs <= nowMs <= endsAtMs (inclusive on both ends).
 *
 * All three call sites of this rule delegate here — the pre-transaction
 * gate in PurchaseServiceImpl, the status label in
 * SaleServiceImpl.computeSaleState, and the in-transaction re-gate inside
 * PostgresDatabase.claimPurchase — so the boundary can only ever change in
 * one place. A product decision like "close *at* ends_at" (end-exclusive)
 * is a one-line edit in this function, and the claim path, the status
 * endpoint, and SSE payloads can no longer drift apart on it.
 */
export function computeGate(startsAtMs: number, endsAtMs: number, nowMs: number): boolean {
  return nowMs >= startsAtMs && nowMs <= endsAtMs;
}
