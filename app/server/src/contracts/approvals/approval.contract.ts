// Approval (spec 44): every write is approved by named people under a policy resolved per
// connection, snapshotted when the chain is created and immune to later weakening.
//
// Resolution (44.3): per connection, the most specific applicable policies (connection and
// its owning scope, then connection, then the organisation default), stacked by row
// threshold and risk class and taking the strictest; floors applied after (an override is
// recorded); the Action type's policy added; the physical floor (two approvers, one holding
// actuation.approve) for physical Actions; then the union across connections. With no
// policy at all the defaults are the bulk guardrails (43.9): one approver holding
// mutation.approve under 100 rows, two at 100 or more.
//
// A chain holds one slot per required approver; one person fills at most one slot (the
// database's unique key), a slot reserved for a stricter condition is filled by someone who
// meets it, and the chain is approved when every slot is. One rejection rejects the chain
// and the mutation. Self-approval only where a condition permits it, recorded as such, never
// for physical Actions. A service principal never approves. Chains expire (the shortest
// expiry in the union, 24 hours by default); an expired chain discards the mutation.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const QUALIFICATIONS = ['any_permitted', 'role', 'scope_admin', 'named_role', 'marking_holder'] as const;
export type Qualification = (typeof QUALIFICATIONS)[number];

export const chainCondition = z.object({
  id: z.string(),
  count: z.int().min(1),
  qualification: z.enum(QUALIFICATIONS),
  qualifyingRoleId: z.uuid().nullable(),
  requiresAdmin: z.boolean(),
  selfApprovalPermitted: z.boolean(),
  /** The connections this condition comes from. */
  connectionIds: z.array(z.uuid()),
  /** marking_holder: the markings the approver must be cleared for (those the mutation touches that the condition names). */
  markingIds: z.array(z.uuid()).optional(),
  /** The policies resolved into it, or "default" / "physical_floor" / "floor:<id>". */
  sources: z.array(z.string()),
});
export type ChainCondition = z.infer<typeof chainCondition>;

export const chainView = z.object({
  id: z.uuid(),
  subjectKind: z.enum(['mutation', 'purge', 'discovery_scan', 'declassification', 'receipt_purge']),
  /**
   * What is approved, to open it and read the hash a decision quotes (D264): the change, the
   * Silo purge (with its Silo, which reading it needs), the discovery authorisation, the
   * declassification or the receipt purge.
   */
  subject: z.object({
    kind: z.enum(['mutation', 'purge', 'discovery_scan', 'declassification', 'receipt_purge']),
    id: z.uuid(),
    siloId: z.uuid().nullable(),
  }),
  mutationId: z.uuid().nullable(),
  requesterMembershipId: z.uuid(),
  riskClass: z.enum(['data', 'bulk', 'external', 'physical']).nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  approvalsRequired: z.int(),
  approvalsReceived: z.int(),
  sequential: z.boolean(),
  floorOverrodePolicy: z.boolean(),
  expiresAt: z.string(),
  createdAt: z.string(),
  conditions: z.array(chainCondition),
  steps: z.array(z.object({
    id: z.uuid(),
    sequence: z.int().nullable(),
    qualifyingRule: z.string(),
    offered: z.boolean(),
    approverMembershipId: z.uuid().nullable(),
    decision: z.enum(['approved', 'rejected']).nullable(),
    selfApproval: z.boolean(),
    decidedAt: z.string().nullable(),
  })),
});
export type ChainView = z.infer<typeof chainView>;

const chainId = z.strictObject({ chainId: z.uuid() });

export const requestApproval = defineContract({
  service: 'approvals', name: 'requestApproval', method: 'POST', path: '/v1/chains', callers: ['actions', 'revert'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ mutationId: z.uuid() }),
  response: chainView,
  status: 201,
});

export const getChain = defineContract({
  service: 'approvals', name: 'getChain', method: 'GET', path: '/v1/chains/:chainId', callers: ['gateway', 'actions', 'revert'],
  context: 'organisation', idempotency: 'none',
  params: chainId,
  response: chainView,
});

/** Pending chains of the organisation that the member could act on: the approvals inbox. */
export const listApprovalInbox = defineContract({
  service: 'approvals', name: 'listApprovalInbox', method: 'GET', path: '/v1/chains',
  // workspace: Home's "approvals waiting" (spec 33.7).
  callers: ['gateway', 'workspace'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Only chains with an open step the member may decide now: what waits for them. */
    forMe: z.enum(['true', 'false']).default('false'),
  }),
  response: z.object({ chains: z.array(chainView) }),
});

export const decideApproval = defineContract({
  service: 'approvals', name: 'decideApproval', method: 'POST', path: '/v1/chains/:chainId/decisions', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: chainId,
  body: z.strictObject({
    decision: z.enum(['approved', 'rejected']),
    /** The diff hash the approver saw: a chain approves exactly the diff that was previewed (43.8). */
    diffHash: z.string().regex(/^[0-9a-f]{64}$/),
    comment: z.string().trim().min(1).max(2_000).optional(),
  }),
  response: chainView,
});

// ----------------------------------------------------------------------------- policies and floors

export const policyFields = z.strictObject({
  /** Null: the organisation default. */
  connectionId: z.uuid().nullable(),
  scopeId: z.uuid().nullable().default(null),
  approvalsRequired: z.int().min(0).max(10),
  approverQualification: z.enum(QUALIFICATIONS).default('any_permitted'),
  qualifyingRoleId: z.uuid().nullable().default(null),
  requiresAdmin: z.boolean().default(false),
  sameScopeRequired: z.boolean().default(false),
  selfApprovalPermitted: z.boolean().default(false),
  sequential: z.boolean().default(false),
  rowThreshold: z.int().min(1).nullable().default(null),
  riskClassCondition: z.array(z.enum(['data', 'bulk', 'external', 'physical'])).min(1).nullable().default(null),
  /** The policy applies only when the mutation touches one of these markings (44.3 rule 3). */
  markingCondition: z.array(z.uuid()).min(1).max(50).nullable().default(null),
  expiryHours: z.int().min(1).max(720).default(24),
});

export const policyView = policyFields.extend({
  id: z.uuid(),
  createdBy: z.uuid(),
  createdAt: z.string(),
  supersededAt: z.string().nullable(),
  supersededById: z.uuid().nullable(),
});
export type PolicyView = z.infer<typeof policyView>;

/** mutation.policy, for the connection's policy authority (44.4); the database refuses a locked or delegated connection's other admins and a policy weaker than a floor. */
export const createApprovalPolicy = defineContract({
  service: 'approvals', name: 'createApprovalPolicy', method: 'POST', path: '/v1/approval-policies', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: policyFields,
  response: policyView,
  status: 201,
});

/** Policies are never edited in place (44.4): a change supersedes the row with a new one. */
export const supersedeApprovalPolicy = defineContract({
  service: 'approvals', name: 'supersedeApprovalPolicy', method: 'POST', path: '/v1/approval-policies/:policyId/supersede', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ policyId: z.uuid() }),
  body: policyFields,
  response: policyView,
  status: 201,
});

export const listApprovalPolicies = defineContract({
  service: 'approvals', name: 'listApprovalPolicies', method: 'GET', path: '/v1/approval-policies', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ connectionId: z.uuid().optional(), includeSuperseded: z.enum(['true', 'false']).default('false') }),
  response: z.object({ policies: z.array(policyView) }),
});

/** Floors are set by a super admin (44.4); no policy can be weaker. */
export const setPolicyFloor = defineContract({
  service: 'approvals', name: 'setPolicyFloor', method: 'POST', path: '/v1/policy-floors', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid().nullable(),
    minimumApprovals: z.int().min(1).max(10),
    minimumQualification: z.enum(QUALIFICATIONS).default('any_permitted'),
    riskClass: z.enum(['data', 'bulk', 'external', 'physical']).nullable().default(null),
    /** The floor applies only to a mutation touching one of these markings, and nothing configures it away (44.4). Empty: always. */
    unwaivableMarkings: z.array(z.uuid()).max(50).default([]),
  }),
  response: z.object({
    id: z.uuid(), connectionId: z.uuid().nullable(), minimumApprovals: z.int(), minimumQualification: z.enum(QUALIFICATIONS),
    riskClass: z.string().nullable(), unwaivableMarkings: z.array(z.uuid()), setBy: z.uuid(), setAt: z.string(),
  }),
  status: 201,
});
