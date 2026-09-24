import type { SaleStatusResponse } from '../responses/sale.response.ts';

export type SaleStatus = 'upcoming' | 'active' | 'ended';

export interface SaleStatusPayload {
  status: SaleStatus;
  stockRemaining: number;
  totalStock: number;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

export type GetStatusOutput = SaleStatusResponse;
