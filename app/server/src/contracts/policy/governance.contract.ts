// Governance over the API: connection grants (spec 57.3, 56.7 rule 6), markings and
// clearances (58.2, 58.3), direct markings on resources (58.4, 57.7), purposes and purpose
// sessions (58.5), field policies (57.4) and service principals (60.4). The policy service
// decides each one, and the database enforces delegation on connection grants as it does
// on role assignments. Removing a direct marking is a declassification Action (58.9), not
// an endpoint here.

import { z } from 'zod';
import { connectionGrantSchema } from '../../schemas/iam/connectionGrant.schema.ts';
import { fieldPolicySchema } from '../../schemas/iam/fieldPolicy.schema.ts';
import { servicePrincipalSchema } from '../../schemas/iam/servicePrincipal.schema.ts';
import { clearanceSchema } from '../../schemas/gov/clearance.schema.ts';
import { markingSchema } from '../../schemas/gov/marking.schema.ts';
import { purposeDefinitionSchema } from '../../schemas/gov/purposeDefinition.schema.ts';
import { purposeEligibilitySchema } from '../../schemas/gov/purposeEligibility.schema.ts';
import { purposeSessionSchema } from '../../schemas/gov/purposeSession.schema.ts';
import { defineContract } from '../endpoint.contract.ts';

const CALLERS = ['gateway'] as const;
const READERS = ['gateway', 'admin-portal'] as const;
const name = z.string().trim().min(1).max(200);
const instant = z.iso.datetime({ offset: true });

/** Who a grant or an eligibility names: exactly one. */
export const grantee = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('membership'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('scope'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('role'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('service_principal'), id: z.uuid() }),
]);
export type Grantee = z.infer<typeof grantee>;

// ----------------------------------------------------------------------------- connection grants

export const connectionGrantView = connectionGrantSchema.pick({
  id: true, connectionId: true, granteeMembershipId: true, granteeScopeId: true, granteeRoleId: true, granteeServicePrincipalId: true,
  access: true, includeDescendants: true, grantedBy: true, grantedAtScopeId: true, grantedAt: true, expiresAt: true, revokedAt: true,
  silencedAt: true,
});

export const grantConnection = defineContract({
  // warehouse-provisioner and index-builder: a Warehouse's or Object Index's principal is granted its connections by the
  // person creating or nominating (spec 69.4, 69.13).
  service: 'policy', name: 'grantConnection', method: 'POST', path: '/v1/connection-grants', callers: [...CALLERS, 'warehouse-provisioner', 'index-builder'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    grantee,
    access: z.enum(['read', 'write']),
    /** For a scope: false grants that one node without its children (spec 57.3). */
    includeDescendants: z.boolean().default(true),
    expiresAt: instant.optional(),
  }).refine((b) => b.includeDescendants || b.grantee.kind === 'scope', 'only a scope grant may exclude descendants'),
  response: connectionGrantView, status: 201, maxBodyBytes: 1024,
});

export const revokeConnectionGrant = defineContract({
  service: 'policy', name: 'revokeConnectionGrant', method: 'POST', path: '/v1/connection-grants/:grantId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ grantId: z.uuid() }),
  response: connectionGrantView,
});

export const listConnectionGrants = defineContract({
  service: 'policy', name: 'listConnectionGrants', method: 'GET', path: '/v1/connection-grants', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ connectionId: z.uuid(), includeEnded: z.enum(['true', 'false']).default('false') }),
  response: z.object({ grants: z.array(connectionGrantView) }),
});

// ----------------------------------------------------------------------------- markings and clearances

export const markingView = markingSchema.pick({ id: true, name: true, kind: true, rank: true, description: true, retiredAt: true });

export const createMarking = defineContract({
  service: 'policy', name: 'createMarking', method: 'POST', path: '/v1/markings', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    name,
    kind: z.enum(['classification', 'compartment', 'purpose']),
    rank: z.int().min(0).max(1000).optional(),
    description: z.string().max(2000).default(''),
  }).refine((b) => b.rank === undefined || b.kind === 'classification', 'only a classification has a rank'),
  response: markingView, status: 201, maxBodyBytes: 4096,
});

export const listMarkings = defineContract({
  service: 'policy', name: 'listMarkings', method: 'GET', path: '/v1/markings', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ includeRetired: z.enum(['true', 'false']).default('false') }),
  response: z.object({ markings: z.array(markingView) }),
});

export const retireMarking = defineContract({
  service: 'policy', name: 'retireMarking', method: 'POST', path: '/v1/markings/:markingId/retire', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ markingId: z.uuid() }),
  response: markingView,
});

/**
 * Resources a person may mark directly (spec 58.4); object types are kept apart (57.7). A source
 * field is marked by its property mapping (58.3: "the id of the field map entry"); the marking
 * holds for that field of that connection in every version of the type (21.15).
 */
export const MARKABLE = ['object_type', 'connection', 'property', 'link_type', 'action_type', 'silo', 'view', 'app', 'function',
  'interface', 'property_mapping'] as const;
export type Markable = (typeof MARKABLE)[number];

export const applyMarking = defineContract({
  service: 'policy', name: 'applyMarking', method: 'POST', path: '/v1/resource-markings', callers: CALLERS,
  // Applying narrows access at once (spec 58.4); applying a marking already there changes nothing.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ markingId: z.uuid(), resource: z.strictObject({ type: z.enum(MARKABLE), id: z.uuid() }) }),
  response: z.object({ markingId: z.uuid(), resource: z.object({ type: z.enum(MARKABLE), id: z.uuid() }), applied: z.boolean() }),
  status: 201, maxBodyBytes: 512,
});

export const listResourceMarkings = defineContract({
  service: 'policy', name: 'listResourceMarkings', method: 'GET', path: '/v1/resource-markings', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ type: z.enum(MARKABLE), id: z.uuid() }),
  response: z.object({ markingIds: z.array(z.uuid()) }),
});

export const clearanceView = clearanceSchema.pick({
  id: true, membershipId: true, servicePrincipalId: true, markingId: true, grantedBy: true, grantedAt: true, expiresAt: true,
  revokedAt: true,
});

export const grantClearance = defineContract({
  service: 'policy', name: 'grantClearance', method: 'POST', path: '/v1/clearances', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    markingId: z.uuid(),
    holder: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('membership'), id: z.uuid() }),
      z.strictObject({ kind: z.literal('service_principal'), id: z.uuid() }),
    ]),
    expiresAt: instant.optional(),
  }),
  response: clearanceView, status: 201, maxBodyBytes: 512,
});

export const revokeClearance = defineContract({
  service: 'policy', name: 'revokeClearance', method: 'POST', path: '/v1/clearances/:clearanceId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ clearanceId: z.uuid() }),
  response: clearanceView,
});

export const listClearances = defineContract({
  service: 'policy', name: 'listClearances', method: 'GET', path: '/v1/clearances', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ membershipId: z.uuid().optional(), markingId: z.uuid().optional() }),
  response: z.object({ clearances: z.array(clearanceView) }),
});

// ----------------------------------------------------------------------------- purposes

export const purposeDefinitionView = purposeDefinitionSchema.pick({
  id: true, markingId: true, name: true, description: true, lawfulBasis: true, maxSessionMinutes: true, requiresJustification: true,
  requiresApproval: true, use: true, status: true, approvedBy: true, approvedAt: true, reviewDueAt: true, createdBy: true, version: true,
});

export const createPurposeDefinition = defineContract({
  service: 'policy', name: 'createPurposeDefinition', method: 'POST', path: '/v1/purpose-definitions', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    markingId: z.uuid(),
    name,
    description: z.string().trim().min(1).max(4000),
    lawfulBasis: z.string().max(500).optional(),
    maxSessionMinutes: z.int().min(1).max(24 * 60),
    requiresJustification: z.boolean().default(true),
    requiresApproval: z.boolean().default(false),
    /** Anything but analysis needs each declaration approved (decision 2026-11-14). */
    use: z.enum(['analysis', 'export', 'external_sharing', 'write_back', 'ai_or_simulation']).default('analysis'),
  }),
  response: purposeDefinitionView, status: 201, maxBodyBytes: 8192,
});

const purposeDefinitionId = z.strictObject({ purposeDefinitionId: z.uuid() });

export const approvePurposeDefinition = defineContract({
  service: 'policy', name: 'approvePurposeDefinition', method: 'POST', path: '/v1/purpose-definitions/:purposeDefinitionId/approve',
  callers: CALLERS,
  // By a holder of purpose.define who is not its creator (spec 58.5).
  context: 'organisation', idempotency: 'none',
  params: purposeDefinitionId,
  body: z.strictObject({ version: z.int().min(1), reviewDueAt: instant.optional() }),
  response: purposeDefinitionView, maxBodyBytes: 512,
});

export const setPurposeDefinitionStatus = defineContract({
  service: 'policy', name: 'setPurposeDefinitionStatus', method: 'POST', path: '/v1/purpose-definitions/:purposeDefinitionId/status',
  callers: CALLERS,
  // Suspending or retiring ends every open purpose session of it in the same transaction.
  context: 'organisation', idempotency: 'none',
  params: purposeDefinitionId,
  body: z.strictObject({ version: z.int().min(1), status: z.enum(['suspended', 'retired']) }),
  response: purposeDefinitionView, maxBodyBytes: 512,
});

export const listPurposeDefinitions = defineContract({
  service: 'policy', name: 'listPurposeDefinitions', method: 'GET', path: '/v1/purpose-definitions', callers: READERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({ purposeDefinitions: z.array(purposeDefinitionView) }),
});

export const purposeEligibilityView = purposeEligibilitySchema.pick({
  id: true, purposeDefinitionId: true, granteeMembershipId: true, granteeRoleId: true, granteeScopeId: true,
  granteeServicePrincipalId: true, grantedBy: true, grantedAt: true, expiresAt: true, revokedAt: true,
});

export const grantPurposeEligibility = defineContract({
  service: 'policy', name: 'grantPurposeEligibility', method: 'POST', path: '/v1/purpose-eligibility', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ purposeDefinitionId: z.uuid(), grantee, expiresAt: instant.optional() }),
  response: purposeEligibilityView, status: 201, maxBodyBytes: 512,
});

/** Who may declare a purpose (spec 58.5): its live eligibilities, revoked ones left out; an expired one says when. */
export const listPurposeEligibility = defineContract({
  service: 'policy', name: 'listPurposeEligibility', method: 'GET', path: '/v1/purpose-definitions/:purposeDefinitionId/eligibility', callers: READERS,
  context: 'organisation', idempotency: 'none',
  params: purposeDefinitionId,
  response: z.object({ eligibility: z.array(purposeEligibilityView) }),
});

export const revokePurposeEligibility = defineContract({
  service: 'policy', name: 'revokePurposeEligibility', method: 'POST', path: '/v1/purpose-eligibility/:eligibilityId/revoke',
  callers: CALLERS,
  // Ends every open purpose session whose declarer is no longer eligible, in the same transaction.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ eligibilityId: z.uuid() }),
  response: purposeEligibilityView,
});

export const purposeSessionView = purposeSessionSchema.pick({
  id: true, purposeDefinitionId: true, declaredAt: true, expiresAt: true, endedAt: true, endedReason: true,
  requiresApproval: true, approvedBy: true, approvedAt: true,
});

/** purpose.define: approves a declaration its definition requires approved, by someone other than its declarer (D81). */
export const approvePurposeSession = defineContract({
  service: 'policy', name: 'approvePurposeSession', method: 'POST', path: '/v1/purpose-sessions/:purposeSessionId/approve', callers: CALLERS,
  // Approving an approved session is refused.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ purposeSessionId: z.uuid() }),
  response: purposeSessionView,
});

// ----------------------------------------------------------------------------- declassifiers (58.10; D81)

export const declassifierView = z.object({
  id: z.uuid(), markingId: z.uuid(),
  grantee: z.discriminatedUnion('kind', [z.object({ kind: z.literal('membership'), id: z.uuid() }), z.object({ kind: z.literal('scope'), id: z.uuid() })]),
  justification: z.string(), grantedBy: z.uuid(), grantedAt: z.string(), approvedBy: z.uuid().nullable(), approvedAt: z.string().nullable(),
  expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), status: z.enum(['awaiting_approval', 'active', 'expired', 'revoked']),
});

/** clearance.grant: names a membership or a scope's members as a marking's declassifier; a second person approves it. */
export const grantDeclassifier = defineContract({
  service: 'policy', name: 'grantDeclassifier', method: 'POST', path: '/v1/declassifiers', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    markingId: z.uuid(),
    grantee: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('membership'), id: z.uuid() }), z.strictObject({ kind: z.literal('scope'), id: z.uuid() })]),
    justification: z.string().trim().min(1).max(2000),
    expiresAt: instant.optional(),
  }),
  response: declassifierView, status: 201, maxBodyBytes: 4096,
});

const declassifierId = z.strictObject({ declassifierId: z.uuid() });

export const approveDeclassifier = defineContract({
  service: 'policy', name: 'approveDeclassifier', method: 'POST', path: '/v1/declassifiers/:declassifierId/approve', callers: CALLERS,
  // Approving an approved grant is refused.
  context: 'organisation', idempotency: 'none', params: declassifierId, response: declassifierView,
});

export const revokeDeclassifier = defineContract({
  service: 'policy', name: 'revokeDeclassifier', method: 'POST', path: '/v1/declassifiers/:declassifierId/revoke', callers: CALLERS,
  // Revoking a revoked grant changes nothing.
  context: 'organisation', idempotency: 'none', params: declassifierId, response: declassifierView,
});

export const listDeclassifiers = defineContract({
  service: 'policy', name: 'listDeclassifiers', method: 'GET', path: '/v1/declassifiers', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ markingId: z.uuid().optional() }),
  response: z.object({ declassifiers: z.array(declassifierView) }),
});

export const declarePurpose = defineContract({
  service: 'policy', name: 'declarePurpose', method: 'POST', path: '/v1/purpose-sessions', callers: CALLERS,
  // A new declaration is a new session and a new audit event: never renewed in place.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    purposeDefinitionId: z.uuid(),
    /** Recorded with the session, never sent to a model. */
    justification: z.string().trim().max(2000).optional(),
    /** At most the definition's limit and the authentication session's remaining life. Default: the limit. */
    minutes: z.int().min(1).max(24 * 60).optional(),
  }),
  response: purposeSessionView, status: 201, maxBodyBytes: 4096,
});

export const endPurposeSession = defineContract({
  service: 'policy', name: 'endPurposeSession', method: 'POST', path: '/v1/purpose-sessions/:purposeSessionId/end', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ purposeSessionId: z.uuid() }),
  response: purposeSessionView,
});

export const listPurposeSessions = defineContract({
  service: 'policy', name: 'listPurposeSessions', method: 'GET', path: '/v1/purpose-sessions', callers: READERS,
  // The caller's own open purpose sessions.
  context: 'organisation', idempotency: 'none',
  response: z.object({ purposeSessions: z.array(purposeSessionView) }),
});

// ----------------------------------------------------------------------------- field policies

export const fieldPolicyView = fieldPolicySchema.pick({
  id: true, connectionId: true, fieldPath: true, propertyId: true, effect: true, appliesToRoleId: true, appliesToMarkingId: true,
  appliesToScopeId: true, includeDescendants: true, createdBy: true, retiredAt: true, version: true,
});

export const createFieldPolicy = defineContract({
  service: 'policy', name: 'createFieldPolicy', method: 'POST', path: '/v1/field-policies', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    /** A source field of a connection, or a property and every source field mapped to it. */
    target: z.union([
      z.strictObject({ connectionId: z.uuid(), fieldPath: z.string().min(1).max(1000) }),
      z.strictObject({ propertyId: z.uuid() }),
    ]),
    effect: z.enum(['deny', 'mask', 'redact']),
    /** Each one set narrows who it applies to; none set means everyone. */
    appliesTo: z.strictObject({
      roleId: z.uuid().optional(),
      /** Applies to readers who do not satisfy this marking. */
      markingId: z.uuid().optional(),
      scopeId: z.uuid().optional(),
      includeDescendants: z.boolean().default(false),
    }).default({ includeDescendants: false }),
  }),
  response: fieldPolicyView, status: 201, maxBodyBytes: 4096,
});

export const retireFieldPolicy = defineContract({
  service: 'policy', name: 'retireFieldPolicy', method: 'POST', path: '/v1/field-policies/:fieldPolicyId/retire', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ fieldPolicyId: z.uuid() }),
  response: fieldPolicyView,
});

export const listFieldPolicies = defineContract({
  service: 'policy', name: 'listFieldPolicies', method: 'GET', path: '/v1/field-policies', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ connectionId: z.uuid().optional(), propertyId: z.uuid().optional() }),
  response: z.object({ fieldPolicies: z.array(fieldPolicyView) }),
});

// ----------------------------------------------------------------------------- service principals

export const servicePrincipalView = servicePrincipalSchema.pick({
  id: true, kind: true, name: true, scopeId: true, ownerMembershipId: true, expiresAt: true, createdAt: true, revokedAt: true,
}).extend({ roleIds: z.array(z.uuid()) });

export const createServicePrincipal = defineContract({
  service: 'policy', name: 'createServicePrincipal', method: 'POST', path: '/v1/service-principals', callers: [...CALLERS, 'warehouse-provisioner', 'index-builder'],
  // Automations and API clients; agents enrol through connect, fde principals through
  // fde-orchestrator. An API client's secret is returned once and stored as a hash.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    kind: z.enum(['automation', 'api_client']),
    name,
    /** Bounds the principal to a subtree; absent for organisation-wide (super admins only). */
    scopeId: z.uuid().optional(),
    /** The accountable person; default the creator. */
    ownerMembershipId: z.uuid().optional(),
    expiresAt: instant.optional(),
  }).refine((b) => b.kind !== 'api_client' || b.expiresAt !== undefined, 'an API client expires'),
  response: servicePrincipalView.extend({ secret: z.string().optional() }), status: 201, maxBodyBytes: 1024,
});

const servicePrincipalId = z.strictObject({ servicePrincipalId: z.uuid() });

export const grantPrincipalRole = defineContract({
  service: 'policy', name: 'grantPrincipalRole', method: 'POST', path: '/v1/service-principals/:servicePrincipalId/roles',
  callers: CALLERS,
  // A role with an authorising permission is refused (spec 60.6), and the refusal audited.
  context: 'organisation', idempotency: 'none',
  params: servicePrincipalId,
  body: z.strictObject({ roleId: z.uuid() }),
  response: servicePrincipalView, status: 201, maxBodyBytes: 256,
});

export const removePrincipalRole = defineContract({
  service: 'policy', name: 'removePrincipalRole', method: 'POST',
  path: '/v1/service-principals/:servicePrincipalId/roles/:roleId/remove', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ servicePrincipalId: z.uuid(), roleId: z.uuid() }),
  response: servicePrincipalView,
});

export const revokeServicePrincipal = defineContract({
  service: 'policy', name: 'revokeServicePrincipal', method: 'POST', path: '/v1/service-principals/:servicePrincipalId/revoke',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: servicePrincipalId,
  response: servicePrincipalView,
});

export const listServicePrincipals = defineContract({
  service: 'policy', name: 'listServicePrincipals', method: 'GET', path: '/v1/service-principals', callers: READERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({ servicePrincipals: z.array(servicePrincipalView) }),
});
