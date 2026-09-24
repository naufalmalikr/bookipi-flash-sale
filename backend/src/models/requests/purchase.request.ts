import { z } from 'zod';

export const userIdSchema = z.string().trim().pipe(z.email());

export const purchaseBodySchema = z.object({ userId: userIdSchema });

export type PurchaseRequest = z.infer<typeof purchaseBodySchema>;
