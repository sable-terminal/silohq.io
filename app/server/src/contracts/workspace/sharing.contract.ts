// Sharing saved views (spec 37.4) and the policies that limit it.
//
// - Only the current owner shares. A share names an active membership of the organisation,
//   a scope, or the whole organisation, with an access level and an optional expiry.
//   Re-sharing with the same grantee updates the share rather than adding one.
// - The organisation policy (iam.organisations.view_sharing_policy, set with
//   org.sharing.manage) is the ceiling: open, scope_only, explicit_only or disabled, and
//   organisation-wide shares only where org_wide_sharing_permitted. A scope admin (holding
//   scope.sharing.narrow at the scope) may make it stricter for that subtree, never looser.
// - The owner's effective policy is the strictest of the organisation's and of every
//   scope policy set on a scope containing one of the owner's scopes. It is applied when a
//   share is written and again whenever access is resolved: a share a later, stricter
//   policy forbids stops granting access and is listed to its owner as forbidden.
// - Sharing is within the organisation only; there is nothing to render outside it.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { VIEW_ACCESS } from './view.contract.ts';

export const SHARING_POLICIES = ['open', 'scope_only', 'explicit_only', 'disabled'] as const;
export type SharingPolicy = (typeof SHARING_POLICIES)[number];

export const shareGrantee = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('membership'), membershipId: z.uuid() }),
  z.strictObject({ kind: z.literal('scope'), scopeId: z.uuid() }),
  z.strictObject({ kind: z.literal('organisation') }),
]);
export type ShareGrantee = z.infer<typeof shareGrantee>;

export const viewShareView = z.object({
  id: z.uuid(),
  viewId: z.uuid(),
  grantee: shareGrantee,
  access: z.enum(VIEW_ACCESS),
  sharedBy: z.uuid(),
  sharedAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  /** live, or why it grants nothing now. */
  state: z.enum(['live', 'revoked', 'expired', 'suspended', 'forbidden_by_policy']),
});
export type ViewShareView = z.infer<typeof viewShareView>;

const CALLERS = ['gateway'] as const;
const viewParams = z.strictObject({ viewId: z.uuid() });

export const shareView = defineContract({
  service: 'workspace', name: 'shareView', method: 'PUT', path: '/v1/workspace/views/:viewId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: viewParams,
  body: z.strictObject({
    grantee: shareGrantee,
    access: z.enum(VIEW_ACCESS),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  }),
  response: viewShareView,
});

export const revokeShare = defineContract({
  service: 'workspace', name: 'revokeShare', method: 'POST', path: '/v1/workspace/views/:viewId/shares/:shareId/revoke',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ viewId: z.uuid(), shareId: z.uuid() }),
  response: viewShareView,
});

export const listShares = defineContract({
  service: 'workspace', name: 'listShares', method: 'GET', path: '/v1/workspace/views/:viewId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: viewParams,
  response: z.object({ shares: z.array(viewShareView) }),
});

export const sharingPolicyView = z.object({
  organisation: z.object({ viewSharingPolicy: z.enum(SHARING_POLICIES), orgWideSharingPermitted: z.boolean() }),
  scopes: z.array(z.object({ scopeId: z.uuid(), viewSharingPolicy: z.enum(SHARING_POLICIES), setBy: z.uuid(), setAt: z.string() })),
  /** The caller's own effective policy, as owner of the views they share. */
  effective: z.object({ viewSharingPolicy: z.enum(SHARING_POLICIES), orgWideSharingPermitted: z.boolean() }),
});

export const getSharingPolicy = defineContract({
  service: 'workspace', name: 'getSharingPolicy', method: 'GET', path: '/v1/workspace/sharing-policy', callers: CALLERS,
  context: 'organisation', idempotency: 'none', response: sharingPolicyView,
});

export const setOrganisationSharingPolicy = defineContract({
  service: 'workspace', name: 'setOrganisationSharingPolicy', method: 'PUT', path: '/v1/workspace/sharing-policy', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ viewSharingPolicy: z.enum(SHARING_POLICIES), orgWideSharingPermitted: z.boolean() }),
  response: sharingPolicyView,
});

export const setScopeSharingPolicy = defineContract({
  service: 'workspace', name: 'setScopeSharingPolicy', method: 'PUT', path: '/v1/workspace/scopes/:scopeId/sharing-policy',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scopeId: z.uuid() }),
  body: z.strictObject({ viewSharingPolicy: z.enum(SHARING_POLICIES) }),
  response: sharingPolicyView,
});
