// The AI FDE (spec 49 to 54): an engagement moves an organisation from connected systems to
// a confirmed ontology, governed action types and working applications, through ten stages.
// It proposes; people confirm; its service principals execute and never authorise.
//
// Who may do what (49.8): fde.engage starts, pauses, resumes, closes, confirms stage exits,
// sets limits and accepts handover; fde.stop stops; fde.view reads; fde.supervise (a
// deployment engineer) facilitates sessions, raises and resolves escalations and lowers limits;
// fde.confirm, with the existing permission each proposal kind maps to and every marking on
// the proposal, decides proposals.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import {
  ERROR_SEMANTICS, EVIDENCE_TYPES, FDE_ROLES, PROPOSAL_KINDS,
} from './events.contract.ts';

const CALLERS = ['gateway'] as const;
const pounds = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, 'pounds, up to four decimal places');
const engagementParam = z.strictObject({ engagementId: z.uuid() });

export const ENGAGEMENT_CLASSES = ['standard', 'enterprise', 'sovereign', 'regulated'] as const;
export const ENGAGEMENT_STATUSES = ['active', 'paused', 'stopped', 'handed_over', 'closed'] as const;
export const STAGE_STATUSES = ['pending', 'running', 'awaiting_confirmation', 'passed', 'failed', 'stopped'] as const;
export const PROPOSAL_STATUSES = ['pending', 'accepted', 'accepted_edited', 'rejected', 'deferred', 'superseded', 'withdrawn', 'expired'] as const;
export const REJECTION_REASONS = ['wrong', 'duplicate', 'out_of_scope', 'not_needed', 'unclear', 'other'] as const;

/** The six limits of 52.5. */
export const rateLimits = z.strictObject({
  modelCallsPerMinute: z.int().min(1).max(10_000),
  probesPerMinute: z.int().min(1).max(10_000),
  proposalsPerHour: z.int().min(1).max(100_000),
  concurrentTasks: z.int().min(1).max(100),
  pendingProposalsPerDecider: z.int().min(1).max(10_000),
  attemptsPerTask: z.int().min(1).max(20),
});
export type RateLimits = z.infer<typeof rateLimits>;

export const stageView = z.object({
  id: z.uuid(),
  stageNumber: z.int(),
  name: z.string(),
  attempt: z.int(),
  status: z.enum(STAGE_STATUSES),
  exitCriteria: z.array(z.object({ criterion: z.string(), check: z.string(), met: z.boolean().nullable() })),
  failureDetail: z.record(z.string(), z.json()).nullable(),
  exitConfirmedBy: z.uuid().nullable(),
  enteredAt: z.string().nullable(),
  exitedAt: z.string().nullable(),
});

export const engagementView = z.object({
  id: z.uuid(),
  name: z.string(),
  goals: z.string(),
  engagementClass: z.enum(ENGAGEMENT_CLASSES),
  status: z.enum(ENGAGEMENT_STATUSES),
  currentStage: z.int(),
  engagingMembershipId: z.uuid(),
  /** Who confirms stage exits: the customer's named engagement owner (decision 2026-11-14). */
  ownerMembershipId: z.uuid(),
  supervisingEngineerMembershipId: z.uuid().nullable(),
  scopeId: z.uuid().nullable(),
  tokenBudget: z.string(),
  tokensConsumed: z.string(),
  providerCostBudget: z.string(),
  providerCostConsumed: z.string(),
  rateLimits,
  modelRoute: z.string(),
  startedAt: z.string(),
  agentInstalledAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  stopReason: z.string().nullable(),
  handedOverAt: z.string().nullable(),
  handedOverTo: z.uuid().nullable(),
  closedAt: z.string().nullable(),
});
export type EngagementView = z.infer<typeof engagementView>;

export const principalView = z.object({
  id: z.uuid(), servicePrincipalId: z.uuid(), role: z.enum(FDE_ROLES), toolPermissions: z.array(z.string()), revokedAt: z.string().nullable(),
});

// ----------------------------------------------------------------------------- engagements

export const startEngagement = defineContract({
  service: 'fde-orchestrator', name: 'startEngagement', method: 'POST', path: '/v1/fde/engagements', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    name: z.string().trim().min(1).max(200),
    /** The organisation's own description of what the engagement is for; the model reads it as vocabulary. */
    goals: z.string().trim().min(1).max(4_000),
    engagementClass: z.enum(ENGAGEMENT_CLASSES).default('standard'),
    tokenBudget: z.int().min(0).max(100_000_000),
    providerCostBudget: pounds,
    rateLimits: rateLimits.partial().optional(),
    /** When fde.engage is held at a scope only: the engagement is confined to it (49.8). */
    scopeId: z.uuid().optional(),
  }),
  response: engagementView.extend({ stages: z.array(stageView), principals: z.array(principalView) }),
  status: 201,
});

export const listEngagements = defineContract({
  service: 'fde-orchestrator', name: 'listEngagements', method: 'GET', path: '/v1/fde/engagements', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({ engagements: z.array(engagementView) }),
});

export const getEngagement = defineContract({
  service: 'fde-orchestrator', name: 'getEngagement', method: 'GET', path: '/v1/fde/engagements/:engagementId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  response: engagementView.extend({
    stages: z.array(stageView),
    principals: z.array(principalView),
    /** Proposals by status; a status with none is absent. */
    proposals: z.partialRecord(z.enum(PROPOSAL_STATUSES), z.int()),
    openEscalations: z.int(),
  }),
});

const lifecycle = (name: string, path: string, body?: z.ZodType) => defineContract({
  service: 'fde-orchestrator', name, method: 'POST', path: `/v1/fde/engagements/:engagementId/${path}` as `/${string}`, callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam, ...(body ? { body } : {}), response: engagementView,
});

export const pauseEngagement = lifecycle('pauseEngagement', 'pause');
export const resumeEngagement = lifecycle('resumeEngagement', 'resume');
/** 52.7: effective on every principal's next call; cannot be resumed. */
export const stopEngagement = lifecycle('stopEngagement', 'stop', z.strictObject({ reason: z.string().trim().min(1).max(500) }));
export const closeEngagement = lifecycle('closeEngagement', 'close');

/** fde.engage sets any limit; fde.supervise may only lower one (49.8). */
export const setEngagementLimits = defineContract({
  service: 'fde-orchestrator', name: 'setEngagementLimits', method: 'PATCH', path: '/v1/fde/engagements/:engagementId/limits', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  body: z.strictObject({
    tokenBudget: z.int().min(0).max(100_000_000).optional(),
    providerCostBudget: pounds.optional(),
    rateLimits: rateLimits.partial().optional(),
  }),
  response: engagementView,
});

export const assignEngineer = defineContract({
  service: 'fde-orchestrator', name: 'assignEngineer', method: 'PUT', path: '/v1/fde/engagements/:engagementId/engineer', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  body: z.strictObject({ membershipId: z.uuid() }),
  response: engagementView,
});

/**
 * Names the customer's engagement owner, who alone confirms stage exits (decision
 * 2026-11-14): an active member, never the supervising engineer.
 */
export const nameEngagementOwner = defineContract({
  service: 'fde-orchestrator', name: 'nameEngagementOwner', method: 'PUT', path: '/v1/fde/engagements/:engagementId/owner', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  body: z.strictObject({ membershipId: z.uuid() }),
  response: engagementView,
});

export const removeEngineer = defineContract({
  service: 'fde-orchestrator', name: 'removeEngineer', method: 'DELETE', path: '/v1/fde/engagements/:engagementId/engineer', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  response: engagementView,
});

/**
 * The engagement owner confirms a stage's exit once its criteria are met; stage 8 may be
 * skipped by decision (50.11). Stage 5 writes to sources (its sandboxed write cycle), so
 * its confirmer also holds mutation.policy on every connection in scope (decision 2026-11-14).
 */
export const confirmStageExit = defineContract({
  service: 'fde-orchestrator', name: 'confirmStageExit', method: 'POST', path: '/v1/fde/engagements/:engagementId/stages/:stageNumber/exit',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ engagementId: z.uuid(), stageNumber: z.coerce.number().int().min(0).max(9) }),
  body: z.strictObject({ skip: z.boolean().default(false) }),
  response: engagementView.extend({ stages: z.array(stageView) }),
});

export const taskView = z.object({
  id: z.uuid(), stageNumber: z.int(), role: z.enum(FDE_ROLES), kind: z.string(), connectionId: z.uuid().nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled']), attempts: z.int(), maxAttempts: z.int(),
  tokensConsumed: z.string(), providerInputTokens: z.string(), providerOutputTokens: z.string(), providerCost: z.string(),
  failedAtStage: z.string().nullable(), errorSemantic: z.enum(ERROR_SEMANTICS).nullable(),
  createdAt: z.string(), startedAt: z.string().nullable(), completedAt: z.string().nullable(),
});

export const listTasks = defineContract({
  service: 'fde-orchestrator', name: 'listTasks', method: 'GET', path: '/v1/fde/engagements/:engagementId/tasks', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  response: z.object({ tasks: z.array(taskView) }),
});

/** 50.12: every artefact with its confirming person, what was deferred and rejected, open escalations, excluded systems. */
export const handoverView = z.object({
  engagementId: z.uuid(),
  artefacts: z.array(z.object({ proposalId: z.uuid(), kind: z.enum(PROPOSAL_KINDS), target: z.string().nullable(), decidedBy: z.uuid(), decidedAt: z.string() })),
  deferred: z.array(z.object({ proposalId: z.uuid(), kind: z.enum(PROPOSAL_KINDS) })),
  rejected: z.array(z.object({ proposalId: z.uuid(), kind: z.enum(PROPOSAL_KINDS), reason: z.string().nullable() })),
  openEscalations: z.array(z.object({ escalationId: z.uuid(), cause: z.string(), path: z.string() })),
  excludedSystems: z.array(z.uuid()),
  tokensConsumed: z.string(),
  providerCostConsumed: z.string(),
});

export const getHandover = defineContract({
  service: 'fde-orchestrator', name: 'getHandover', method: 'GET', path: '/v1/fde/engagements/:engagementId/handover', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  response: handoverView,
});

/** Every FDE principal is revoked, but Reliability when kept, under a successor engagement with its own budget. */
export const acceptHandover = defineContract({
  service: 'fde-orchestrator', name: 'acceptHandover', method: 'POST', path: '/v1/fde/engagements/:engagementId/handover', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  body: z.strictObject({
    keepReliability: z.boolean().default(false),
    reliabilityTokenBudget: z.int().min(0).max(100_000_000).optional(),
    reliabilityProviderCostBudget: pounds.optional(),
  }).refine((b) => !b.keepReliability || (b.reliabilityTokenBudget !== undefined && b.reliabilityProviderCostBudget !== undefined),
    'Reliability kept runs under its own budget'),
  response: engagementView.extend({ successorEngagementId: z.uuid().nullable() }),
});

export const metricView = z.object({
  metric: z.string(), dimensions: z.record(z.string(), z.json()), value: z.string(), unit: z.string(),
  numerator: z.string().nullable(), denominator: z.string().nullable(), measuredAt: z.string(),
  /** A ratio's 95% credible interval from its numerator and denominator (a uniform prior): how far a small sample can be trusted. */
  interval: z.tuple([z.number(), z.number()]).nullable(),
});

/** Chapter 54, from the engagement's own records; every ratio with its sample. */
export const getMetrics = defineContract({
  service: 'fde-orchestrator', name: 'getMetrics', method: 'GET', path: '/v1/fde/engagements/:engagementId/metrics', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  response: z.object({ metrics: z.array(metricView), notMeasured: z.array(z.object({ metric: z.string(), why: z.string() })) }),
});

// ----------------------------------------------------------------------------- systems

const described = <K extends string>(kind: K) => z.strictObject({ kind: z.literal(kind), text: z.string().min(1).max(2 * 1024 * 1024) });

/**
 * What the organisation gives for a system (51.4's inputs, in descending fidelity): a
 * specification (OpenAPI, a WSDL, a GraphQL introspection result or SDL, an OData service's
 * $metadata), compiled without a model, or documentation written for the schema, which the
 * model reads. Never email samples: they hold record values (62.5).
 */
export const systemDocumentation = z.discriminatedUnion('kind', [
  described('openapi'),
  z.strictObject({ kind: z.literal('text'), title: z.string().trim().min(1).max(200), text: z.string().min(1).max(20_000) }),
  described('wsdl'), described('graphql'), described('odata'),
  /** A specification or documentation URL (16.3): the cell reads it when the connector is drafted. */
  z.strictObject({ kind: z.literal('url'), url: z.url({ protocol: /^https?$/ }).max(2_000) }),
]);

export const systemView = z.object({
  id: z.uuid(), engagementId: z.uuid(), name: z.string(), provider: z.string(), slug: z.string(),
  documentationKind: z.enum(['openapi', 'text', 'wsdl', 'graphql', 'odata', 'url']), baseUrl: z.string().nullable(), owningScopeId: z.uuid(),
  status: z.enum(['listed', 'drafted', 'withdrawn']),
  /** The sandbox connection the Integration principal drafted, owned by the engaging administrator. */
  connectionId: z.uuid().nullable(),
  /** Drafted, and waiting for the credential its owner gives: the AI FDE never holds a secret (52.1). */
  awaitingCredential: z.boolean(),
  listedBy: z.uuid(), listedAt: z.string(), draftedAt: z.string().nullable(),
});
export type SystemView = z.infer<typeof systemView>;

const systemParams = z.strictObject({ engagementId: z.uuid(), systemId: z.uuid() });

/** A system for the engagement, which puts it in scope; stage 2 drafts its connector from the documentation (51.4). */
export const addEngagementSystem = defineContract({
  service: 'fde-orchestrator', name: 'addEngagementSystem', method: 'POST', path: '/v1/fde/engagements/:engagementId/systems', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  body: z.strictObject({
    name: z.string().trim().min(1).max(200),
    provider: z.string().trim().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    documentation: systemDocumentation,
    /** The system's base URL, when the documentation does not give it or gives another. */
    baseUrl: z.string().max(500).regex(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/).optional(),
    owningScopeId: z.uuid(),
    parameters: z.record(z.string(), z.string().max(1_000)).optional(),
  }),
  response: systemView, status: 201,
  maxBodyBytes: 2 * 1024 * 1024 + 16_384,
});

export const listEngagementSystems = defineContract({
  service: 'fde-orchestrator', name: 'listEngagementSystems', method: 'GET', path: '/v1/fde/engagements/:engagementId/systems', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  response: z.object({ systems: z.array(systemView) }),
});

export const withdrawEngagementSystem = defineContract({
  service: 'fde-orchestrator', name: 'withdrawEngagementSystem', method: 'DELETE', path: '/v1/fde/engagements/:engagementId/systems/:systemId',
  callers: CALLERS, context: 'organisation', idempotency: 'none', params: systemParams,
  response: systemView,
});

// ----------------------------------------------------------------------------- proposals

export const evidenceItem = z.object({ type: z.enum(EVIDENCE_TYPES) }).catchall(z.json());

export const proposalView = z.object({
  id: z.uuid(),
  engagementId: z.uuid(),
  stageNumber: z.int(),
  kind: z.enum(PROPOSAL_KINDS),
  payload: z.record(z.string(), z.json()),
  evidence: z.array(evidenceItem),
  confidence: z.string(),
  confidenceBand: z.enum(['high', 'medium', 'low']),
  verification: z.record(z.string(), z.json()),
  requiredPermission: z.string(),
  markings: z.array(z.uuid()),
  assignedMembershipId: z.uuid().nullable(),
  status: z.enum(PROPOSAL_STATUSES),
  editDiff: z.record(z.string(), z.json()).nullable(),
  rejectionReason: z.string().nullable(),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.string().nullable(),
  confirmationSessionId: z.uuid().nullable(),
  appliedRef: z.uuid().nullable(),
  createdAt: z.string(),
});
export type ProposalView = z.infer<typeof proposalView>;

export const listProposals = defineContract({
  service: 'fde-orchestrator', name: 'listProposals', method: 'GET', path: '/v1/fde/engagements/:engagementId/proposals', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  query: z.strictObject({
    status: z.enum(PROPOSAL_STATUSES).optional(),
    kind: z.enum(PROPOSAL_KINDS).optional(),
    /** Only those routed to the reader. */
    mine: z.enum(['true', 'false']).optional(),
  }),
  response: z.object({ proposals: z.array(proposalView) }),
});

export const getProposal = defineContract({
  service: 'fde-orchestrator', name: 'getProposal', method: 'GET', path: '/v1/fde/proposals/:proposalId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ proposalId: z.uuid() }),
  response: proposalView,
});

/**
 * A decision (52.2): fde.confirm, the kind's mapped permission and every marking on the
 * proposal. Accepting applies it through the target system's own path, as the decider;
 * accepting with edits records their difference.
 */
export const decideProposal = defineContract({
  service: 'fde-orchestrator', name: 'decideProposal', method: 'POST', path: '/v1/fde/proposals/:proposalId/decision', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ proposalId: z.uuid() }),
  body: z.strictObject({
    decision: z.enum(['accept', 'reject', 'defer']),
    /** Fields of the payload changed on acceptance (the kind says which may change). */
    edits: z.record(z.string(), z.json()).optional(),
    reason: z.enum(REJECTION_REASONS).optional(),
    note: z.string().trim().min(1).max(500).optional(),
    sessionId: z.uuid().optional(),
  }).refine((b) => b.decision !== 'reject' || b.reason !== undefined, 'a rejection gives its reason')
    .refine((b) => b.edits === undefined || b.decision === 'accept', 'only an acceptance carries edits'),
  response: proposalView,
});

/** 52.3: high-confidence proposals accepted together by an explicit action naming the count; each recorded alone. */
export const acceptProposalGroup = defineContract({
  service: 'fde-orchestrator', name: 'acceptProposalGroup', method: 'POST', path: '/v1/fde/engagements/:engagementId/group-acceptances',
  callers: CALLERS, context: 'organisation', idempotency: 'none', params: engagementParam,
  body: z.strictObject({ proposalIds: z.array(z.uuid()).min(2).max(200), count: z.int().min(2).max(200), sessionId: z.uuid().optional() })
    .refine((b) => b.count === b.proposalIds.length && new Set(b.proposalIds).size === b.count, 'the count names exactly the proposals'),
  response: z.object({ accepted: z.array(proposalView) }),
});

/** Routes proposals to a decider; a deployment engineer is given technical kinds only (53.2). */
export const assignProposals = defineContract({
  service: 'fde-orchestrator', name: 'assignProposals', method: 'POST', path: '/v1/fde/engagements/:engagementId/assignments',
  callers: CALLERS, context: 'organisation', idempotency: 'none', params: engagementParam,
  body: z.strictObject({ proposalIds: z.array(z.uuid()).min(1).max(500), membershipId: z.uuid() }),
  response: z.object({ assigned: z.int() }),
});

// ----------------------------------------------------------------------------- sessions and escalations

export const sessionView = z.object({
  id: z.uuid(), engagementId: z.uuid(), stageNumber: z.int(), mode: z.enum(['queue', 'workshop']), facilitatorMembershipId: z.uuid().nullable(),
  participantMembershipIds: z.array(z.uuid()),
  agenda: z.array(z.object({ group: z.string(), band: z.enum(['high', 'medium', 'low']), proposalIds: z.array(z.uuid()) })),
  scheduledAt: z.string().nullable(), startedAt: z.string().nullable(), endedAt: z.string().nullable(),
  counts: z.object({ presented: z.int(), accepted: z.int(), edited: z.int(), rejected: z.int(), deferred: z.int(), escalated: z.int() }),
});

export const startSession = defineContract({
  service: 'fde-orchestrator', name: 'startSession', method: 'POST', path: '/v1/fde/engagements/:engagementId/sessions', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  body: z.strictObject({
    mode: z.enum(['queue', 'workshop']),
    participantMembershipIds: z.array(z.uuid()).min(1).max(50),
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
  }),
  response: sessionView,
  status: 201,
});

/** An engagement's confirmation sessions, newest first (D263): an open one is found again to end it. */
export const listSessions = defineContract({
  service: 'fde-orchestrator', name: 'listSessions', method: 'GET', path: '/v1/fde/engagements/:engagementId/sessions', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  response: z.object({ sessions: z.array(sessionView) }),
});

export const endSession = defineContract({
  service: 'fde-orchestrator', name: 'endSession', method: 'POST', path: '/v1/fde/sessions/:sessionId/end', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ sessionId: z.uuid() }),
  response: sessionView,
});

export const ESCALATION_CAUSES = ['unsupported_transport', 'contested_ontology_decision', 'no_eligible_decider', 'regulated_requirement',
  'repeated_stage_failure', 'physical_actuation'] as const;
export const ESCALATION_PATHS = ['support_ticket', 'ontology_owner', 'engaging_administrator', 'compliance_officer', 'deployment_engineer',
  'operations_safety_owner'] as const;

export const escalationView = z.object({
  id: z.uuid(), cause: z.enum(ESCALATION_CAUSES), path: z.enum(ESCALATION_PATHS), status: z.enum(['open', 'resolved']),
  proposalId: z.uuid().nullable(), taskId: z.uuid().nullable(), stageId: z.uuid().nullable(), ticketRef: z.string().nullable(),
  raisedByMembershipId: z.uuid().nullable(), resolvedBy: z.uuid().nullable(), resolutionNote: z.string().nullable(), createdAt: z.string(),
});

export const raiseEscalation = defineContract({
  service: 'fde-orchestrator', name: 'raiseEscalation', method: 'POST', path: '/v1/fde/engagements/:engagementId/escalations', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  body: z.strictObject({
    cause: z.enum(ESCALATION_CAUSES), path: z.enum(ESCALATION_PATHS), proposalId: z.uuid().optional(), taskId: z.uuid().optional(),
    ticketRef: z.string().trim().min(1).max(200).optional(),
  }).refine((b) => b.proposalId !== undefined || b.taskId !== undefined, 'an escalation names a proposal or a task'),
  response: escalationView,
  status: 201,
});

export const resolveEscalation = defineContract({
  service: 'fde-orchestrator', name: 'resolveEscalation', method: 'POST', path: '/v1/fde/escalations/:escalationId/resolution', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ escalationId: z.uuid() }),
  body: z.strictObject({ note: z.string().trim().min(1).max(2_000) }),
  response: escalationView,
});

export const listEscalations = defineContract({
  service: 'fde-orchestrator', name: 'listEscalations', method: 'GET', path: '/v1/fde/engagements/:engagementId/escalations', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: engagementParam,
  response: z.object({ escalations: z.array(escalationView) }),
});
