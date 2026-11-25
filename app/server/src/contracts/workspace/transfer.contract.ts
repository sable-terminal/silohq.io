// Views of a removed member (spec 37.7). On removal every view the membership owned moves
// to the admin above them: the admin whose subtree most closely contains a scope the
// membership belonged to; where its scopes have different nearest admins, the admin of its
// primary scope; a super admin where no scope applies. The views arrive flagged, not
// shared: until the receiving admin reviews each one, it is theirs alone and its shares
// are suspended. A view's thread moves with it; the member's other threads are archived.
// Shares made to the removed member are revoked.
//
// Policy calls transferViews when it removes (or suspends) a membership. The receiving
// admin reviews each inherited view: share it onward (its suspended shares resume),
// retain it privately (its shares are revoked), or archive it.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { savedViewView } from './view.contract.ts';

export const TRANSFER_REASONS = ['member_removed', 'member_suspended', 'scope_archived'] as const;

export const transferViews = defineContract({
  service: 'workspace', name: 'transferViews', method: 'POST', path: '/v1/workspace/transfers', callers: ['policy'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ membershipId: z.uuid(), reason: z.enum(TRANSFER_REASONS) }),
  response: z.object({
    /** Null when the membership owned no view, or no admin could be found (the views stay put). */
    receivingMembershipId: z.uuid().nullable(),
    viewsTransferred: z.number().int(),
    sharesSuspended: z.number().int(),
    sharesRevoked: z.number().int(),
    threadsArchived: z.number().int(),
  }),
});

export const inheritedViewView = z.object({
  flagId: z.uuid(),
  view: savedViewView,
  transferredFrom: z.uuid(),
  reason: z.enum(TRANSFER_REASONS),
  createdAt: z.string(),
});

export const listInheritedViews = defineContract({
  service: 'workspace', name: 'listInheritedViews', method: 'GET', path: '/v1/workspace/inherited-views', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ inherited: z.array(inheritedViewView) }),
});

export const reviewInheritedView = defineContract({
  service: 'workspace', name: 'reviewInheritedView', method: 'POST', path: '/v1/workspace/inherited-views/:flagId/review',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ flagId: z.uuid() }),
  body: z.strictObject({ decision: z.enum(['shared', 'retained', 'archived']) }),
  response: z.object({ view: savedViewView, decision: z.enum(['shared', 'retained', 'archived']), sharesResumed: z.number().int(), sharesRevoked: z.number().int() }),
});
