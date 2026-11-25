// A removed member's connections (spec 55.7): "Connections they own transfer to the owning
// scope's admin or a super admin." Policy calls this in the removal, as it hands over views
// and apps; grants others hold on the connection are untouched.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const transferOwnedConnections = defineContract({
  service: 'connect-registry', name: 'transferOwnedConnections', method: 'POST', path: '/v1/connections/ownership-transfers', callers: ['policy'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ membershipId: z.uuid() }),
  response: z.object({
    transferred: z.array(z.object({ connectionId: z.uuid(), toMembershipId: z.uuid() })),
    /** Connections no admin could take: they stay with the removed member, and the log says so. */
    kept: z.int(),
  }),
});
