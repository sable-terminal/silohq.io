// A discovery scan given to a Silo Agent (spec 10.5, 19.2): discovery asks; the connect-runtime
// replica holding the agent's tunnel gives the agent the signed scan as discovery.scan work and
// passes what comes back to discovery (contracts/discovery/scan.contract.ts). A replica not
// holding it passes the request to the one that does, once (relayed). Never queued: an agent
// not connected now is refused at once.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { signedDiscoveryScan } from '../discovery/scan.contract.ts';

export const startDiscoveryScan = defineContract({
  service: 'connect-runtime', name: 'startDiscoveryScan', method: 'POST', path: '/v1/agents/:agentId/discovery-scans',
  // Not keyed: a signed scan runs once; asking again with the same one is refused by the agent.
  callers: ['discovery', 'connect-runtime'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ agentId: z.uuid() }),
  body: z.strictObject({
    runId: z.uuid(),
    scan: signedDiscoveryScan,
    /** When the agent stops whatever it has not finished. */
    deadline: z.iso.datetime({ offset: true }),
    /** Passed on by the replica that took the request: it is not passed on again. */
    relayed: z.boolean().default(false),
  }),
  response: z.object({ started: z.literal(true) }),
  maxBodyBytes: 32 * 1024,
});
