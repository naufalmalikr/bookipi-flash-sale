import type { FastifyInstance } from 'fastify';
import type { Application } from '../../../../../Application.ts';
import { envelope } from '../../../../../models/responses/envelope.ts';
import { purchaseBodySchema } from '../../../../../models/requests/purchase.request.ts';
import type {
  AttemptPurchaseOutput,
  GetPurchaseOutput,
} from '../../../../../models/purchase/purchase.contract.ts';

export function registerPurchaseRoutes(fastify: FastifyInstance, application: Application): void {
  fastify.get('/api/purchase/:userId', (req, reply) => {
    void (async () => {
      const rawUserId = (req.params as { userId: string }).userId;
      let result: GetPurchaseOutput;
      try {
        result = await application.purchaseService.getPurchaseByUser(rawUserId);
      } catch {
        void reply
          .code(500)
          .send(envelope('internal-error', 'Failed to check purchase'));
        return;
      }
      if ('error' in result) {
        void reply
          .code(400)
          .send(envelope('invalid-userId', 'Param must be a valid email userId'));
        return;
      }
      if (result.found === true) {
        void reply.code(200).send({ result: 'purchased', unitId: result.unitId });
        return;
      }
      void reply
        .code(404)
        .send(envelope('not-purchased', 'This user has not purchased'));
    })();
  });

  const rateLimitBuy: number = application.config.rateLimitBuy;
  const buyRouteOptions =
    rateLimitBuy > 0
      ? {
          schema: { body: purchaseBodySchema },
          config: { rateLimit: { max: rateLimitBuy, timeWindow: '1 minute' } },
        }
      : { schema: { body: purchaseBodySchema } };

  fastify.post('/api/purchase', buyRouteOptions, (req, reply) => {
    void (async () => {
      const rawUserId = (req.body as { userId: string }).userId;
      let outcome: AttemptPurchaseOutput;
      try {
        outcome = await application.purchaseService.attemptPurchase(rawUserId);
      } catch {
        void reply
          .code(500)
          .send(envelope('internal-error', 'Purchase failed'));
        return;
      }
      if (outcome.ok) {
        void reply.code(201).send({ result: 'purchased', unitId: outcome.unitId });
        return;
      }
      switch (outcome.error) {
        case 'invalid-userId':
          void reply
            .code(400)
            .send(envelope('invalid-userId', 'Body must be { userId: <email> }'));
          return;
        case 'sale-not-active':
          void reply
            .code(403)
            .send(envelope('sale-not-active', 'Sale is not currently active'));
          return;
        case 'already-purchased':
          void reply
            .code(409)
            .send(envelope('already-purchased', 'This user already purchased'));
          return;
        case 'sold-out':
          void reply
            .code(409)
            .send(envelope('sold-out', 'All units are sold'));
          return;
        default:
          void reply
            .code(500)
            .send(envelope('internal-error', 'Purchase failed'));
          return;
      }
    })();
  });
}
