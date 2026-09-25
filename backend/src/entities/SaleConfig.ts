/** SaleConfig entity (mirrors sale_config). */
export interface SaleConfig {
  id: number;
  productName: string;
  stockQty: number;
  startsAt: Date;
  endsAt: Date;
}

/** SaleConfigRow: sale_config read model without id (repository return shape). */
export type SaleConfigRow = Omit<SaleConfig, 'id'>;

/**
 * SALE_ID: single-sale take-home, no multi-sale routing. The one shared
 * source for the sale identity — services, boot, seed, and the repository
 * row literals all resolve here so the id cannot drift between call sites.
 */
export const SALE_ID = 1;
