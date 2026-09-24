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

export interface SaleService {
  computeSaleState(
    s: number,
    e: number,
    n: number,
  ): { status: 'upcoming' | 'active' | 'ended' };
  getStatus(nowMs?: number): Promise<SaleStatusResponse>;
  buildStatusPayload(nowMs?: number): Promise<SaleStatusResponse>;
}
