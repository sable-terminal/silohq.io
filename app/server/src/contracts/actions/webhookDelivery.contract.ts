// A mutation's outbound webhook deliveries (spec 20.4, 42.6): whether each was delivered, and,
// where its target declares a status endpoint, whether it took effect. Without one, delivery
// is all that is known, and the view says so (records: delivery).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const webhookDeliveryView = z.object({
  id: z.uuid(),
  endpointId: z.uuid(),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.int(),
  /** The target's last HTTP status, and a code for why it failed: never the remote's text. */
  lastStatus: z.int().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  /** effect: the target declares a status endpoint; delivery: only delivery is known. */
  records: z.enum(['delivery', 'effect']),
  effect: z.enum(['pending', 'applied', 'failed', 'unconfirmed']).nullable(),
  effectCheckedAt: z.string().nullable(),
});
export type WebhookDeliveryView = z.infer<typeof webhookDeliveryView>;

export const listWebhookDeliveries = defineContract({
  service: 'actions', name: 'listWebhookDeliveries', method: 'GET', path: '/v1/mutations/:mutationId/webhook-deliveries', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ mutationId: z.uuid() }),
  response: z.object({ deliveries: z.array(webhookDeliveryView) }),
});
