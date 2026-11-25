// Work for an agent whose tunnel another connect-runtime replica holds (spec 10.3): the replica
// that chose the pool's least-loaded healthy agent relays the work to the replica holding it,
// at that replica's own address (agentRegistry.service). The holding replica gives it to that
// agent, if it still holds it healthy, and answers with its result frames in order. Never
// queued (spec 10.6): an agent no longer held there is refused at once (agent.not_here), and
// the relaying replica tries the next agent where that cannot repeat a write.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { resultFrame, WORK_KINDS } from './agentTunnel.contract.ts';

export const relayAgentWork = defineContract({
  service: 'connect-runtime', name: 'relayAgentWork', method: 'POST', path: '/v1/agents/:agentId/relayed-work',
  // Not keyed: work is never repeated by a retry; the relaying replica decides what may be tried elsewhere.
  callers: ['connect-runtime'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ agentId: z.uuid() }),
  body: z.strictObject({
    poolId: z.uuid(),
    kind: z.enum(WORK_KINDS),
    payload: z.record(z.string(), z.unknown()),
    timeoutMs: z.int().min(100).max(10 * 60_000),
    /** The connection whose login the work needs: sealed by the holding replica for its agent (spec 10.7). */
    seal: z.strictObject({ connectionId: z.uuid(), reason: z.enum(['connect', 'query', 'mutation', 'read_back', 'probe', 'change_stream']) }).optional(),
    /** The OPC UA endpoint whose application key the work needs: sealed by the holding replica for its agent (spec 20.3). */
    sealKey: z.strictObject({ connectionId: z.uuid(), endpointId: z.uuid(), reason: z.enum(['query', 'probe', 'change_stream']) }).optional(),
  }),
  response: z.object({ frames: z.array(resultFrame).max(100_000) }),
  maxBodyBytes: 4 * 1024 * 1024,
});
