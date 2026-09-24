/** ClaimResult: single-txn claim outcome (repository-owned). */
export type ClaimResult = { ok: true; unitId: number } | { ok: false; error: 'sold-out' | 'already-purchased' };
