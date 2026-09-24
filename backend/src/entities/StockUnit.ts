/** StockUnit entity (mirrors stock_units). */
export interface StockUnit {
  id: number;
  saleId: number;
  status: 'available' | 'sold';
  soldAt: Date | null;
}
