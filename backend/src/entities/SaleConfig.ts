/** SaleConfig entity (mirrors sale_config). */
export interface SaleConfig {
  id: number;
  productName: string;
  stockQty: number;
  startsAt: Date;
  endsAt: Date;
}
