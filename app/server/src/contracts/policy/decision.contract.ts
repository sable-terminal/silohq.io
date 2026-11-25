// The policy service's decisions (spec 7.7, 57.1): the cell's single authorisation
// decision point. The gateway asks for every request and product services ask for
// resource decisions. Deny wins; the service fails closed.
//
// The caller sends the request context it was given: organisation, and a membership with
// its session, or a service principal (spec 60.4). The decision reads the session's MFA
// state and the purpose sessions itself, so no caller can vouch for either.
//
// - authorise: may this actor use a permission, at a scope or on a resource? Steps 1, 2
//   and 6 of spec 57.6 for the permission, then the mandatory gate (step 4) on the
//   resource's own markings.
// - resolveAccess: what may this actor reach, for a plan about to be built (steps 3 to 5):
//   the connections its grants reach, which markable elements it may see, and the effect
//   of field policies on each field and property. The compile stage drops what is not
//   visible before any plan exists (spec 57.8); a refusal never says which marking failed.

import { z } from 'zod';
import { SERVICES } from '../../config/service.config.ts';
import { defineContract } from '../endpoint.contract.ts';

export const DENIAL_REASONS = [
  'not_granted', 'membership_inactive', 'mfa_required', 'session_unknown', 'unknown_permission',
  // The resource carries a marking the actor does not satisfy (spec 57.5).
  'marking_unsatisfied',
  // A service principal revoked, expired, or whose accountable owner is no longer active (spec 60.4).
  'principal_inactive',
  // A service principal never holds an authorising permission (spec 60.6).
  'principal_never_authorises',
] as const;

/** Every service decides through policy (spec 57.1); none decides for itself. */
const DECIDERS = SERVICES.filter((s) => s !== 'policy');

/** The purpose sessions a request runs under (spec 58.5): only these satisfy purpose markings. */
const purposeSessionIds = z.array(z.uuid()).max(16);

export const authorise = defineContract({
  service: 'policy', name: 'authorise', method: 'POST', path: '/v1/decisions',
  callers: DECIDERS,
  // A decision changes nothing.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    permission: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    /** The scope acted on, for a permission held on part of the tree. */
    scopeId: z.uuid().optional(),
    /** A resource acted on, for a permission granted on that resource; its markings must be satisfied too. */
    resource: z.strictObject({
      type: z.enum(['connection', 'silo', 'view', 'object_type', 'app']),
      id: z.uuid(),
    }).optional(),
    /** Allow only through a grant held organisation-wide, not on a scope or a resource. */
    organisationWide: z.literal(true).optional(),
    purposeSessionIds: purposeSessionIds.optional(),
  }).refine((b) => b.organisationWide === undefined || (b.scopeId === undefined && b.resource === undefined),
    'an organisation-wide decision names no scope or resource'),
  response: z.object({
    decision: z.enum(['allow', 'deny']),
    reason: z.enum(['allowed', ...DENIAL_REASONS]),
  }),
  maxBodyBytes: 4096,
});

/**
 * Which of these permissions the acting member holds where they work: organisation-wide or on
 * a scope they belong to (as authorise decides with no scope or resource named). For a
 * surface that states what a person may use before they try, such as the workspace rail
 * (spec 33.3); every action is still decided by authorise when it is taken. Not audited: it
 * changes nothing and refuses nothing.
 */
export const listHeldPermissions = defineContract({
  service: 'policy', name: 'listHeldPermissions', method: 'POST', path: '/v1/held-permissions',
  // admin-portal: whether a member's ticket list shows the organisation's tickets or only theirs (U4).
  callers: ['workspace', 'admin-portal'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    permissions: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)).min(1).max(64),
  }),
  response: z.object({ held: z.array(z.string()) }),
  maxBodyBytes: 4096,
});

/**
 * Every permission in the catalogue with its description, and whether the acting member holds
 * it anywhere: across the organisation, on a scope they belong to, or on any other live scope
 * (one they administer, say), by the rule authorise uses. For the web client,
 * which disables what a person cannot use and names what it needs before they try (spec
 * 33.3); every action is still decided by authorise when it is taken. Not audited: it changes
 * nothing and refuses nothing.
 */
export const listMyPermissions = defineContract({
  service: 'policy', name: 'listMyPermissions', method: 'GET', path: '/v1/my-permissions',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    permissions: z.array(z.object({ id: z.string(), description: z.string(), held: z.boolean() })),
  }),
});

/**
 * The live scopes where the caller holds a scoped permission (W7): where a person may create a
 * connection, say, offered before they try. The same rule as authorise; every action is still
 * decided when it is taken. Not audited: it changes nothing and refuses nothing.
 */
export const listPermittedScopes = defineContract({
  service: 'policy', name: 'listPermittedScopes', method: 'POST', path: '/v1/permitted-scopes',
  // Ask reads the web context policies of the scopes its reader manages.
  callers: ['gateway', 'ask'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ permission: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/) }),
  response: z.object({ scopes: z.array(z.object({ id: z.uuid(), name: z.string(), parentScopeId: z.uuid().nullable(), depth: z.int() })) }),
  maxBodyBytes: 1024,
});

export const FIELD_EFFECTS = ['allow', 'mask', 'redact', 'deny'] as const;
export type FieldEffect = (typeof FIELD_EFFECTS)[number];

const ids = z.array(z.uuid()).max(500);

export const resolveAccess = defineContract({
  service: 'policy', name: 'resolveAccess', method: 'POST', path: '/v1/access',
  callers: DECIDERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connections: ids.default([]),
    objectTypes: ids.default([]),
    properties: ids.default([]),
    linkTypes: ids.default([]),
    actionTypes: ids.default([]),
    /** Functions and interfaces (spec 21.15): visible only where every marking on them is held. */
    functions: ids.default([]),
    interfaces: ids.default([]),
    /** Source fields by connection and path, for field policies on fields (spec 57.4). */
    fields: z.array(z.strictObject({ connectionId: z.uuid(), path: z.string().min(1).max(1000) })).max(2000).default([]),
    /** Markings to test directly, for artefacts that carry them (lineage, spec 58.6, 59.4). */
    markings: ids.default([]),
    purposeSessionIds: purposeSessionIds.optional(),
    /**
     * Recognition only (decision 2026-11-14): the decision for this member, who is not present,
     * for a Lens's coverage at share. No session; clearances count, purpose sessions cannot.
     */
    asMembershipId: z.uuid().optional(),
  }),
  response: z.object({
    /** Whether the actor may act at all: a denial here means every list below is empty. */
    decision: z.enum(['allow', 'deny']),
    reason: z.enum(['allowed', ...DENIAL_REASONS]),
    /** none when no live grant reaches it or a marking on it is unsatisfied (steps 3 and 4). */
    /**
     * unsatisfiedMarkingIds: the markings on the connection or object type the actor does not
     * satisfy (spec 21.15), so the planner can say how many a dropped type lacks
     * (type_dropped_from_plan, 57.11). For the services' own use: never shown to the actor.
     */
    connections: z.array(z.object({ id: z.uuid(), access: z.enum(['none', 'read', 'write']), unsatisfiedMarkingIds: z.array(z.uuid()).default([]) })),
    objectTypes: z.array(z.object({ id: z.uuid(), visible: z.boolean(), unsatisfiedMarkingIds: z.array(z.uuid()).default([]) })),
    linkTypes: z.array(z.object({ id: z.uuid(), visible: z.boolean() })),
    actionTypes: z.array(z.object({ id: z.uuid(), visible: z.boolean() })),
    functions: z.array(z.object({ id: z.uuid(), visible: z.boolean() })),
    interfaces: z.array(z.object({ id: z.uuid(), visible: z.boolean() })),
    /** A property that is not visible is denied; otherwise the strictest field policy on it. */
    properties: z.array(z.object({ id: z.uuid(), visible: z.boolean(), effect: z.enum(FIELD_EFFECTS) })),
    fields: z.array(z.object({ connectionId: z.uuid(), path: z.string(), effect: z.enum(FIELD_EFFECTS) })),
    /** Whether the actor satisfies each marking asked about: clearance, or a purpose session of this request. */
    markings: z.array(z.object({ id: z.uuid(), satisfied: z.boolean() })),
  }),
  maxBodyBytes: 262_144,
});

/**
 * The object view's markings banner (spec 34.2): every marking on an object type and on the
 * properties shown of it, their own and their source fields' (58.4). The reader sees the
 * object only holding them all, so naming them discloses nothing.
 */
export const readMarkingBanner = defineContract({
  service: 'policy', name: 'readMarkingBanner', method: 'POST', path: '/v1/marking-banners',
  callers: ['executor'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ objectTypeId: z.uuid(), propertyIds: ids }),
  response: z.object({
    markings: z.array(z.object({ id: z.uuid(), name: z.string(), kind: z.enum(['classification', 'compartment', 'purpose']) })),
  }),
  maxBodyBytes: 32 * 1024,
});

export const declassificationDecision = defineContract({
  service: 'policy', name: 'declassificationDecision', method: 'POST', path: '/v1/declassification-decisions',
  // The declassification Action and its approval (spec 58.9).
  callers: ['actions', 'approvals', 'gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    markingId: z.uuid(),
    /** request: may this membership request it; approve: may it approve one requested by another. */
    step: z.enum(['request', 'approve']),
    requestedBy: z.uuid().optional(),
  }).refine((b) => b.step === 'request' || b.requestedBy !== undefined, 'an approval names who requested it'),
  response: z.object({
    decision: z.enum(['allow', 'deny']),
    reason: z.enum(['allowed', 'not_granted', 'marking_unsatisfied', 'self_approval', 'principal_never_authorises',
      'membership_inactive', 'session_unknown', 'mfa_required']),
  }),
  maxBodyBytes: 1024,
});
