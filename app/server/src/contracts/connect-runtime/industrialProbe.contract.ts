// An industrial endpoint's verification (spec 20.3, 20.7): connect-registry asks, for the person
// verifying it; connect-runtime gives the probe to an agent of the connection's pool, which
// connects as a read would (the endpoint's security, the server's pinned certificate, the
// application certificate and its key sealed for the work, the login) and reports the server's
// namespaces and certificate. The server's refusal is the outcome, never an error: the endpoint's
// status follows from it in connect-registry.

import { z } from 'zod';
import { PROBE_OUTCOMES } from '../connect-registry/industrial.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

export { PROBE_OUTCOMES };

export const probeIndustrialEndpoint = defineContract({
  service: 'connect-runtime', name: 'probeIndustrialEndpoint', method: 'POST', path: '/v1/industrial-endpoints/:endpointId/probes',
  callers: ['connect-registry'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ endpointId: z.uuid() }),
  body: z.strictObject({ connectionId: z.uuid() }),
  response: z.object({
    outcome: z.enum(PROBE_OUTCOMES),
    /** The server's namespace array, where it was reached. */
    namespaceUris: z.array(z.string()).max(1_000),
    /** The certificate the server presented (a signed policy), for the owner to compare with the server's own. */
    serverSha1: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    serverSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  maxBodyBytes: 256,
});
