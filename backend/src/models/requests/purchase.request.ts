import { z } from 'zod';

export const purchaseBodySchema = z.object({ userId: z.string().trim().pipe(z.email()) });

export type PurchaseRequest = z.infer<typeof purchaseBodySchema>;
