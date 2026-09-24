import type { SaleStatusResponse } from '../responses/sale.response.js';

export type SaleStatus = 'upcoming' | 'active' | 'ended';

export interface GetStatusInput {
  nowMs?: number;
}

export type GetStatusOutput = SaleStatusResponse;
