// Branches, proposals and derivation (spec 22, 25.3 to 25.6).
//
// open branch -> commit changes -> submit proposal (change classes and impact computed)
// -> approve (ontology.confirm, never the author; ontology.manage too when breaking) ->
// merge (ontology.merge, after a rebase onto main's head, with the impact re-checked) ->
// a new main version.
//
// Derivation proposes from a connection's declared schema onto its own branch. A person
// holding ontology.confirm accepts, corrects or rejects each decision; what they accept is
// committed with them as its confirmer, and merged like any proposal.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { linkTypeDefinition, objectTypeDefinition, WRITERS } from './element.contract.ts';
import { apiName, READERS, versionView } from './manifest.contract.ts';

export const CHANGE_CLASSES = ['additive', 'compatible', 'breaking'] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];
export const ELEMENT_KINDS = ['object_type', 'link_type', 'shared_property', 'interface', 'function'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];
export const IMPACT_EFFECTS = ['unaffected', 'results_may_differ', 'will_fail'] as const;

export const branchView = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['main', 'working', 'derivation', 'scenario']),
  status: z.enum(['open', 'merged', 'abandoned']),
  baseVersionId: z.uuid().nullable(),
  headVersionId: z.uuid().nullable(),
  ownerMembershipId: z.uuid().nullable(),
  /** The base is no longer main's head: rebase before merge. */
  behindMain: z.boolean(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
});
export type BranchView = z.infer<typeof branchView>;

/** One element the branch changes, with its class (spec 25.5) and what made it so. */
export const changeView = z.object({
  kind: z.enum(ELEMENT_KINDS),
  id: z.uuid(),
  apiName,
  /** retire: the element leaves the vocabulary (a rollback to a version without it, spec 25.8). */
  operation: z.enum(['create', 'change', 'retire']),
  changeClass: z.enum(CHANGE_CLASSES),
  /** Machine codes for the review page: property_added, property_type_changed, route_removed... */
  notes: z.array(z.string()),
});
export type ChangeView = z.infer<typeof changeView>;

/**
 * Dependants of the changed elements and the effect on them (spec 25.6). Counts only: a
 * dependant is named to a reviewer only once its owning service can say the reviewer may
 * see it.
 */
export const impactView = z.object({
  againstVersionId: z.uuid(),
  total: z.int().min(0),
  byEffect: z.record(z.enum(IMPACT_EFFECTS), z.int().min(0)),
  byKind: z.record(z.string(), z.int().min(0)),
  elements: z.array(z.object({ kind: z.enum(ELEMENT_KINDS), id: z.uuid(), effect: z.enum(IMPACT_EFFECTS), dependants: z.int().min(0) })),
});
export type ImpactView = z.infer<typeof impactView>;

export const evidenceView = z.object({
  source: z.enum(['schema', 'declared_fk', 'naming', 'template', 'profile', 'overlap']),
  /** A closed code with schema names (object and field names), never a value. */
  detail: z.string().max(300),
});

const objectTypeProposal = objectTypeDefinition.omit({ expectedHeadVersionId: true });
const linkTypeProposal = linkTypeDefinition.omit({ expectedHeadVersionId: true });

export const decisionView = z.discriminatedUnion('kind', [
  z.object({
    id: z.uuid(), kind: z.literal('object_type'), apiName, confidence: z.number().min(0).max(1), evidence: z.array(evidenceView),
    status: z.enum(['undecided', 'accepted', 'corrected', 'rejected']), definition: objectTypeProposal,
    /** The concept template that named it (spec 22.7), recorded on the type when it is confirmed. */
    templateId: z.uuid().optional(),
  }),
  z.object({
    id: z.uuid(), kind: z.literal('link_type'), apiName, confidence: z.number().min(0).max(1), evidence: z.array(evidenceView),
    status: z.enum(['undecided', 'accepted', 'corrected', 'rejected']), definition: linkTypeProposal,
  }),
]);
export type DecisionView = z.infer<typeof decisionView>;

export const approvalView = z.object({
  membershipId: z.uuid(),
  permission: z.enum(['ontology.confirm', 'ontology.manage', 'ontology.mark']),
  approvedAt: z.string(),
});

export const proposalView = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  origin: z.enum(['person', 'derivation', 'ai_fde', 'rollback']),
  status: z.enum(['draft', 'in_review', 'approved', 'merged', 'rejected', 'withdrawn']),
  highestChangeClass: z.enum(CHANGE_CLASSES),
  authorMembershipId: z.uuid().nullable(),
  authorServicePrincipalId: z.uuid().nullable(),
  changes: z.array(changeView),
  /** Derivation proposals: each proposed decision, as the confirming person sees it. */
  decisions: z.array(decisionView),
  impact: impactView.nullable(),
  impactComputedAt: z.string().nullable(),
  /** Approvals of this proposal; a changed diff opens a new proposal, so none carry over. */
  approvals: z.array(approvalView),
  /** What merge still needs. */
  requires: z.object({ confirm: z.boolean(), manage: z.boolean() }),
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  mergedBy: z.uuid().nullable(),
  mergedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ProposalView = z.infer<typeof proposalView>;

const branchParam = z.strictObject({ branchId: z.uuid() });
const proposalParam = z.strictObject({ proposalId: z.uuid() });

export const openBranch = defineContract({
  service: 'ontology', name: 'openBranch', method: 'POST', path: '/v1/ontology/branches', callers: WRITERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ name: z.string().trim().min(1).max(100).refine((n) => n.toLowerCase() !== 'main', 'main is reserved') }),
  response: branchView, status: 201, maxBodyBytes: 4096,
});

export const listBranches = defineContract({
  service: 'ontology', name: 'listBranches', method: 'GET', path: '/v1/ontology/branches', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ status: z.enum(['open', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(500).default(100) }),
  response: z.object({ branches: z.array(branchView) }),
});

export const getBranch = defineContract({
  service: 'ontology', name: 'getBranch', method: 'GET', path: '/v1/ontology/branches/:branchId', callers: READERS,
  context: 'organisation', idempotency: 'none', params: branchParam, response: branchView,
});

/** What the branch changes against its base, with change classes: the diff a proposal will carry. */
export const getBranchChanges = defineContract({
  service: 'ontology', name: 'getBranchChanges', method: 'GET', path: '/v1/ontology/branches/:branchId/changes', callers: READERS,
  context: 'organisation', idempotency: 'none', params: branchParam,
  response: z.object({ changes: z.array(changeView), highestChangeClass: z.enum(CHANGE_CLASSES).nullable() }),
});

export const abandonBranch = defineContract({
  service: 'ontology', name: 'abandonBranch', method: 'POST', path: '/v1/ontology/branches/:branchId/abandon', callers: WRITERS,
  context: 'organisation', idempotency: 'none', params: branchParam, response: branchView,
});

/**
 * Re-applies the branch's changes onto main's head (spec 25.3). An element changed on both
 * since the base is a conflict: without a resolution for it ('branch' keeps the branch's
 * version, 'main' drops the branch's change) nothing is written and the conflicts are
 * returned.
 */
export const rebaseBranch = defineContract({
  service: 'ontology', name: 'rebaseBranch', method: 'POST', path: '/v1/ontology/branches/:branchId/rebase', callers: WRITERS,
  context: 'organisation', idempotency: 'none', params: branchParam,
  body: z.strictObject({ resolutions: z.record(z.uuid(), z.enum(['branch', 'main'])).default({}) }),
  response: z.object({
    rebased: z.boolean(),
    branch: branchView,
    version: versionView.nullable(),
    conflicts: z.array(z.object({ kind: z.enum(ELEMENT_KINDS), id: z.uuid(), apiName })),
  }),
  maxBodyBytes: 32 * 1024,
});

export const submitProposal = defineContract({
  service: 'ontology', name: 'submitProposal', method: 'POST', path: '/v1/ontology/branches/:branchId/proposals', callers: WRITERS,
  context: 'organisation', idempotency: 'keyed', params: branchParam,
  body: z.strictObject({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(4_000).optional() }),
  response: proposalView, status: 201, maxBodyBytes: 8192,
});

export const listProposals = defineContract({
  service: 'ontology', name: 'listProposals', method: 'GET', path: '/v1/ontology/proposals', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    status: z.enum(['open', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ proposals: z.array(proposalView) }),
});

export const getProposal = defineContract({
  service: 'ontology', name: 'getProposal', method: 'GET', path: '/v1/ontology/proposals/:proposalId', callers: READERS,
  context: 'organisation', idempotency: 'none', params: proposalParam, response: proposalView,
});

export const approveProposal = defineContract({
  service: 'ontology', name: 'approveProposal', method: 'POST', path: '/v1/ontology/proposals/:proposalId/approvals', callers: ['gateway'],
  context: 'organisation', idempotency: 'none', params: proposalParam,
  body: z.strictObject({ permission: z.enum(['ontology.confirm', 'ontology.manage']) }),
  response: proposalView, maxBodyBytes: 1024,
});

export const rejectProposal = defineContract({
  service: 'ontology', name: 'rejectProposal', method: 'POST', path: '/v1/ontology/proposals/:proposalId/reject', callers: ['gateway'],
  context: 'organisation', idempotency: 'none', params: proposalParam, response: proposalView,
});

export const withdrawProposal = defineContract({
  service: 'ontology', name: 'withdrawProposal', method: 'POST', path: '/v1/ontology/proposals/:proposalId/withdraw', callers: WRITERS,
  context: 'organisation', idempotency: 'none', params: proposalParam, response: proposalView,
});

export const mergeProposal = defineContract({
  // fde-orchestrator merges what a person accepted from an AI FDE proposal, as that person (spec 49.6).
  service: 'ontology', name: 'mergeProposal', method: 'POST', path: '/v1/ontology/proposals/:proposalId/merge', callers: ['gateway', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'keyed', params: proposalParam,
  response: z.object({ proposal: proposalView, version: versionView }),
});

/** Derivation from a connection's declared schema (spec 22.2): proposals on a derivation branch. */
export const startDerivation = defineContract({
  // discovery: a promoted finding's structure enters derivation and confirmation (spec 19.4).
  service: 'ontology', name: 'startDerivation', method: 'POST', path: '/v1/ontology/derivations', callers: [...WRITERS, 'discovery'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    connectionId: z.uuid(),
    /** Profile the connection's fields first (spec 22.2, 22.3); default true. */
    profile: z.boolean().optional(),
    /** Count value overlap with the types other systems feed (spec 22.4); default true. */
    overlap: z.boolean().optional(),
  }),
  response: proposalView, status: 201, maxBodyBytes: 1024,
});

/**
 * A confirming person's decisions on a derivation proposal (spec 22.5, 22.6). Accepted and
 * corrected decisions are committed with them as confirmer; decisions left undecided move
 * to a new derivation proposal, so the confident part can merge while the rest waits.
 */
export const confirmDecisions = defineContract({
  service: 'ontology', name: 'confirmDecisions', method: 'POST', path: '/v1/ontology/proposals/:proposalId/decisions', callers: ['gateway', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'keyed', params: proposalParam,
  body: z.strictObject({
    decisions: z.array(z.discriminatedUnion('action', [
      z.strictObject({ decisionId: z.uuid(), action: z.literal('accept') }),
      z.strictObject({ decisionId: z.uuid(), action: z.literal('reject') }),
      z.strictObject({ decisionId: z.uuid(), action: z.literal('correct'), objectType: objectTypeProposal.optional(), linkType: linkTypeProposal.optional() }),
    ])).min(1).max(500),
  }),
  response: z.object({ proposal: proposalView, version: versionView.nullable(), followUpProposalId: z.uuid().nullable() }),
  maxBodyBytes: 1024 * 1024,
});
