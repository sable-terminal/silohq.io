// Outbound webhooks to private targets (spec 20.4): notify asks connect-runtime to have the
// connection's Silo Agent send a delivery, or read its target's status endpoint, inside the
// customer's network. The request is the one statement of a write: a POST carries the
// execution grant actions signed for this delivery attempt over the statements' hash
// (spec 10.4), checked here and again by the agent; a status read needs none. The address
// must be the target's (or its status endpoint's) as registered. The answer is the status
// code and a status endpoint's state: never a body. A physical target's POST names its action
// and the connection's physical writes a minute (47.4, 47.5), and the agent sends it only if its
// own signed allow-list lists the action as a command, outside its interval and within the rate.

import { z } from 'zod';
import { signedExecutionGrant } from '../actions/grant.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

export const agentWebhookRequest = z.strictObject({
  method: z.enum(['POST', 'GET']),
  url: z.url({ protocol: /^https$/ }).max(2_048),
  headers: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), z.string().max(2_048)),
  body: z.string().max(1_048_576),
  /** A physical target's (47.4): its action's name, which the agent finds in its signed allow-list, and the connection's writes a minute (0: none set). */
  physical: z.strictObject({ action: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), maxPerMinute: z.int().min(0).max(100_000) }).optional(),
});
export type AgentWebhookRequest = z.infer<typeof agentWebhookRequest>;

export const sendWebhookThroughAgent = defineContract({
  service: 'connect-runtime', name: 'sendWebhookThroughAgent', method: 'POST', path: '/v1/outbound-webhooks/:endpointId/agent-sends',
  // Not keyed: a POST runs once on its grant; notify retries with a new grant.
  callers: ['notify'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ endpointId: z.uuid() }),
  body: z.strictObject({ request: agentWebhookRequest, grant: signedExecutionGrant.optional() }),
  response: z.object({ status: z.int().min(100).max(599), state: z.enum(['applied', 'pending', 'failed']).nullable() }),
  maxBodyBytes: 2 * 1024 * 1024,
});
