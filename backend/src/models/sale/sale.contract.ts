import type { SaleStatusResponse } from '../responses/sale.response.ts';

export type SaleStatus = 'upcoming' | 'active' | 'ended';

export type SaleStatusPayload = SaleStatusResponse;

export type GetStatusOutput = SaleStatusResponse;
