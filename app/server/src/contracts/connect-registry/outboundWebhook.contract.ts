// Outbound webhook targets (spec 20.4, 42.6): a URL an Action's webhook side effect posts to,
// registered on a connection by a holder of webhook.outbound.manage. Each target has its own
// signing secret (HMAC-SHA256 over timestamp and body), held by the credential service and
// shown once at registration. The connection owner declares a target physical when it drives
// equipment (20.5); an Action type with a webhook side effect is then physical, otherwise at
// least external (42.6, 42.7). A target on a connection reached through the Silo Agent is
// posted from the agent, inside the customer's network (20.4). A target may declare a status
// endpoint; then a delivery's effect is read from it, not only its delivery. A target may name
// its webhook action (20.3); a physical one must, since its writable point and its actuation
// allow-list entry address it by that name (47.4), and registering one declares the
// connection's webhooks physical (47.7).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const outboundWebhookView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  targetUrl: z.string(),
  /** The declared status endpoint a delivery's effect is read from; null: the receipt records delivery, not effect (20.4). */
  statusUrl: z.string().nullable(),
  /** cell: posted from the cell to a public address; agent: from the connection's Silo Agent, to a private one (20.4). */
  sentFrom: z.enum(['cell', 'agent']),
  riskClass: z.enum(['external', 'physical']),
  /** The webhook action's name: what a writable point and an allow-list entry address (20.3, 47.4). */
  actionName: z.string().nullable(),
  status: z.enum(['active', 'paused', 'revoked']),
  lastDeliveryAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type OutboundWebhookView = z.infer<typeof outboundWebhookView>;

const connectionId = z.strictObject({ connectionId: z.uuid() });

export const registerOutboundWebhook = defineContract({
  service: 'connect-registry', name: 'registerOutboundWebhook', method: 'POST', path: '/v1/connections/:connectionId/outbound-webhooks',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({
    targetUrl: z.url({ protocol: /^https$/ }).max(2_048),
    /**
     * Optional: an HTTPS address Silo asks, after delivery, whether the request took effect. It
     * is sent GET with the delivery id (query delivery), signed as a delivery is over the
     * timestamp and the delivery id, and answers JSON {"state": "applied" | "pending" | "failed"}.
     */
    statusUrl: z.url({ protocol: /^https$/ }).max(2_048).optional(),
    /** Declared by the connection owner: physical when the target drives equipment (spec 20.5). */
    riskClass: z.enum(['external', 'physical']).default('external'),
    /** The webhook action's name, unique among the connection's live targets; a physical target names one (47.4). */
    actionName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'lower case letters, digits and underscores, starting with a letter').optional(),
  }).refine((b) => b.riskClass !== 'physical' || b.actionName !== undefined, {
    message: 'a physical target names its action: its writable point and allow-list entry address it (47.4)', path: ['actionName'],
  }),
  response: z.object({ endpoint: outboundWebhookView, /** Shown once, to verify deliveries; never again. */ secret: z.string() }),
  status: 201,
  maxBodyBytes: 4_096,
});

export const listOutboundWebhooks = defineContract({
  service: 'connect-registry', name: 'listOutboundWebhooks', method: 'GET', path: '/v1/connections/:connectionId/outbound-webhooks',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  response: z.object({ endpoints: z.array(outboundWebhookView) }),
});

export const revokeOutboundWebhook = defineContract({
  service: 'connect-registry', name: 'revokeOutboundWebhook', method: 'POST', path: '/v1/outbound-webhooks/:endpointId/revoke',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ endpointId: z.uuid() }),
  response: outboundWebhookView,
});
