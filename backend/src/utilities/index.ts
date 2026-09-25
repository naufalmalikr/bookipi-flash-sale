/**
 * Pure shared helpers. No SQL, no I/O, no process.env, so any layer can
 * import this without widening its dependencies.
 */

/**
 * Single source of the sale-window boundary rule: the sale is open at every
 * instant where startsAtMs <= nowMs <= endsAtMs (inclusive on both ends).
 *
 * Inclusive-end is a product choice: a purchase landing exactly at endsAt
 * wins. End-exclusive is the more common convention; if the sale ever needs
 * it, change the `<=` below to `<` — this function is the only edit point.
 *
 * Clock choice: the gate reads the app clock (Date.now() at the call site),
 * not the DB clock. Mixed clocks are safe here because the pre-txn gate and
 * the in-txn re-gate use the SAME app clock against the SAME absolute seed
 * values, so they can never disagree. A DB-clock gate (`now()` in SQL) would
 * remove the last skew assumption at the cost of one more query — not worth
 * it for a single-replica demo, noted for the multi-replica lane.
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
