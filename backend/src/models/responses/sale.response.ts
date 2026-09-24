export interface SaleStatusResponse {
  status: 'upcoming' | 'active' | 'ended';
  stockRemaining: number;
  totalStock: number;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}
