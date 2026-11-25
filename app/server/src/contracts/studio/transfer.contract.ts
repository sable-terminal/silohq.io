// Apps of a removed or suspended member (spec 34.x, 37.7: "on owner removal the app
// transfers under the revision 7 rule, flagged in app_transfer_flags, with shares
// suspended"). Policy calls transferApps beside transferViews; the receiving admin reviews
// each inherited app: share onward (its suspended shares resume), retain it privately (its
// shares are revoked), or archive it.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { TRANSFER_REASONS } from '../workspace/transfer.contract.ts';

export const transferApps = defineContract({
  service: 'studio', name: 'transferApps', method: 'POST', path: '/v1/studio/transfers', callers: ['policy'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ membershipId: z.uuid(), reason: z.enum(TRANSFER_REASONS) }),
  response: z.object({
    /** Null when the membership owned no live app, or no admin could be found (the apps stay put). */
    receivingMembershipId: z.uuid().nullable(),
    appsTransferred: z.int(),
    sharesSuspended: z.int(),
    /** Shares of other people's apps made to the departing member, revoked. */
    sharesRevoked: z.int(),
  }),
});

export const inheritedAppView = z.object({
  flagId: z.uuid(),
  appId: z.uuid(),
  name: z.string(),
  transferredFrom: z.uuid(),
  reason: z.enum(TRANSFER_REASONS),
  createdAt: z.string(),
});

export const listInheritedApps = defineContract({
  service: 'studio', name: 'listInheritedApps', method: 'GET', path: '/v1/studio/inherited-apps', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ inherited: z.array(inheritedAppView) }),
});

export const reviewInheritedApp = defineContract({
  service: 'studio', name: 'reviewInheritedApp', method: 'POST', path: '/v1/studio/inherited-apps/:flagId/review', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ flagId: z.uuid() }),
  body: z.strictObject({ decision: z.enum(['shared', 'retained', 'archived']) }),
  response: z.object({ appId: z.uuid(), decision: z.enum(['shared', 'retained', 'archived']), sharesResumed: z.int(), sharesRevoked: z.int() }),
});
