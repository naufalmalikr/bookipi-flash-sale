import type { SaleStatusResponse } from '../responses/sale.response.js';

export type SaleStatus = 'upcoming' | 'active' | 'ended';

export interface SaleStatusPayload {
  status: SaleStatus;
  stockRemaining: number;
  totalStock: number;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

export interface GetStatusInput {
  nowMs?: number;
}

export type GetStatusOutput = SaleStatusResponse;
