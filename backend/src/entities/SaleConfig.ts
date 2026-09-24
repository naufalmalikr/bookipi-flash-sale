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
