/** Purchase entity (mirrors purchases). */
export interface Purchase {
  id: number;
  saleId: number;
  canonicalUserId: string;
  unitId: number;
  rawUserId: string;
  createdAt: Date;
}
