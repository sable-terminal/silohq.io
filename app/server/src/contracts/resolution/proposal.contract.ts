// Resolution proposals and runs (spec 23.2, 24.8): what exact resolution leaves undecided,
// put to a person.
//
// - A run reads a resolvable type's contributing objects through connect-runtime (keys and
//   identifiers only), writes the entity graph, and analyses what did not resolve:
//   deterministic normalisation rules first, then, for what they leave, the model with key
//   shapes and counts only (never a key). Each workable rule becomes an open
//   normalisation_rule proposal. A run answers at once and carries on in the background.
// - A person may propose that objects are one (pair_list) or that a merge they confirmed is
//   undone (split).
// - A proposal is confirmed or rejected by a person holding resolution.confirm and read
//   access to every connection involved, never by its proposer. The preview shows the
//   reviewer the actual pairs, read live under their own permissions; nothing it shows is
//   stored.
//
// A proposal holds a rule expression or references to Silo object ids and redirects, never a
// record value.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';

const CALLERS = ['gateway', 'fde-orchestrator', 'admin-portal'] as const;

export const PROPOSAL_KINDS = ['normalisation_rule', 'pair_list', 'split'] as const;

/** A normalisation rule: CEL over `value` (the key as normalised so far), and how it was found. */
export const ruleProposal = z.object({
  kind: z.literal('normalisation_rule'),
  cel: z.string().min(1).max(2000),
  basis: z.enum(['deterministic', 'model']),
  /** The catalogue steps a deterministic rule composes; empty for a model's. */
  steps: z.array(z.string()),
  /** Counts at analysis: unmatched records per contributing object, and pairs the rule makes. */
  unmatchedBefore: z.int().min(0),
  pairs: z.int().min(0),
  /** The run that found it. */
  runId: z.uuid().nullable(),
});

export const pairListProposal = z.object({
  kind: z.literal('pair_list'),
  /** Each `from` object becomes `to`; references to `from` redirect. */
  pairs: z.array(z.object({ from: z.uuid(), to: z.uuid() })).min(1).max(100),
  /**
   * An inferred pair list (D74; the organisation's resolution inference switch): the properties
   * compared, each pair's match probability and agreement pattern (true, false, or null where a
   * side had no value), and what it assumed. A person confirms or rejects it as any pair list.
   */
  inference: z.object({
    fields: z.array(z.uuid()), probabilities: z.array(z.number()), agreement: z.array(z.array(z.boolean().nullable())), statement: z.string(),
  }).optional(),
  /** Filled at confirmation: the entity graph rows each merge moved, for a later split. */
  merged: z.array(z.object({
    from: z.uuid(), to: z.uuid(), redirectId: z.uuid(), moved: z.array(z.uuid()), superseded: z.array(z.uuid()),
  })).optional(),
});

export const splitProposal = z.object({
  kind: z.literal('split'),
  /** The live redirect a confirmed pair list made. */
  redirectId: z.uuid(),
});

export const proposalBody = z.discriminatedUnion('kind', [ruleProposal, pairListProposal, splitProposal]);
export type ProposalBody = z.infer<typeof proposalBody>;

export const resolutionProposalView = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  kind: z.enum(PROPOSAL_KINDS),
  proposal: proposalBody,
  affectedCount: z.int().min(0),
  proposedByMembershipId: z.uuid().nullable(),
  proposedByServicePrincipalId: z.uuid().nullable(),
  status: z.enum(['open', 'confirmed', 'rejected']),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ResolutionProposalView = z.infer<typeof resolutionProposalView>;

export const listResolutionProposals = defineContract({
  // recognition: investigation's unresolved pairs (38.8).
  service: 'resolution', name: 'listResolutionProposals', method: 'GET', path: '/v1/resolution/proposals', callers: [...CALLERS, 'recognition'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    status: z.enum(['open', 'confirmed', 'rejected']).optional(),
    objectTypeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ proposals: z.array(resolutionProposalView) }),
});

export const getResolutionProposal = defineContract({
  service: 'resolution', name: 'getResolutionProposal', method: 'GET', path: '/v1/resolution/proposals/:proposalId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ proposalId: z.uuid() }),
  response: resolutionProposalView,
});

/** One side of a pair as the reviewer sees it, read live under their permissions. */
const pairSide = z.object({
  connectionId: z.uuid(),
  sourceObject: z.string(),
  identifier: recordValue(z.string()),
  key: recordValue(z.string()),
});

export const previewResolutionProposal = defineContract({
  service: 'resolution', name: 'previewResolutionProposal', method: 'POST', path: '/v1/resolution/proposals/:proposalId/preview',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ proposalId: z.uuid() }),
  body: z.strictObject({ limit: z.int().min(1).max(100).default(20) }),
  response: z.object({
    /** Pairs the rule would make now, at most `limit`; the total counts them all. */
    pairs: z.array(z.object({ key: recordValue(z.string()), sides: z.array(pairSide) })),
    total: z.int().min(0),
  }),
});

export const proposePairs = defineContract({
  service: 'resolution', name: 'proposePairs', method: 'POST', path: '/v1/resolution/pair-proposals', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ objectTypeId: z.uuid(), pairs: z.array(z.object({ from: z.uuid(), to: z.uuid() })).min(1).max(100) }),
  response: resolutionProposalView,
  status: 201,
});

export const proposeSplit = defineContract({
  service: 'resolution', name: 'proposeSplit', method: 'POST', path: '/v1/resolution/split-proposals', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ redirectId: z.uuid() }),
  response: resolutionProposalView,
  status: 201,
});

export const confirmResolutionProposal = defineContract({
  service: 'resolution', name: 'confirmResolutionProposal', method: 'POST', path: '/v1/resolution/proposals/:proposalId/confirm',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ proposalId: z.uuid() }),
  response: resolutionProposalView.extend({
    /** A confirmed rule re-keys the type: the run that applies it. */
    runId: z.uuid().nullable(),
  }),
});

export const rejectResolutionProposal = defineContract({
  service: 'resolution', name: 'rejectResolutionProposal', method: 'POST', path: '/v1/resolution/proposals/:proposalId/reject',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ proposalId: z.uuid() }),
  response: resolutionProposalView,
});

// ----------------------------------------------------------------------------- runs

const sourceCounts = z.object({
  connectionId: z.uuid(),
  sourceObject: z.string(),
  records: z.int().min(0),
  /** Records whose object no other contributing object holds. */
  unmatched: z.int().min(0),
});

export const resolutionRunView = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  status: z.enum(['running', 'completed', 'failed', 'abandoned']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** The entity graph: rows added, rows remapped, objects merged by redirect, rows superseded as gone. */
  entries: z.object({ added: z.int(), remapped: z.int(), merged: z.int(), retired: z.int() }),
  sources: z.array(sourceCounts),
  objects: z.int().min(0),
  unkeyed: z.int().min(0),
  proposals: z.array(z.uuid()),
  /** Whether the model was consulted for what the deterministic rules left. */
  modelConsulted: z.boolean(),
  /** A failed run's code; analysis skipped steps are named here too. */
  notes: z.array(z.string()),
});
export type ResolutionRunView = z.infer<typeof resolutionRunView>;

export const startResolutionRun = defineContract({
  service: 'resolution', name: 'startResolutionRun', method: 'POST', path: '/v1/resolution/runs', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    /** false only writes the entity graph; true (default) also raises proposals for what did not resolve. */
    analyse: z.boolean().default(true),
  }),
  response: resolutionRunView,
  status: 202,
});

export const getResolutionRun = defineContract({
  service: 'resolution', name: 'getResolutionRun', method: 'GET', path: '/v1/resolution/runs/:runId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ runId: z.uuid() }),
  response: resolutionRunView,
});
