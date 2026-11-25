// What every part of the AI FDE shares (spec 49 to 54): dependencies, the ten stages, the
// limits' defaults, confidence bands, views and the engagement log.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { EngagementView, ProposalView, RateLimits } from '../../contracts/fde-orchestrator/engagement.contract.ts';
import type { FdeEvent, FdeRole, ProposalKind } from '../../contracts/fde-orchestrator/events.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import type { Databases, Queryable, RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { FdeEngagement, FdeProposal, FdeStage } from '../../models/fde/index.model.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

export interface FdeDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  cellId: string;
  /** Pounds per million provider tokens, input and output, for provider cost (52.6); 0 when not configured. */
  providerPrice: { inputPerMillion: number; outputPerMillion: number };
  now?: () => Date;
}

export const nowOf = (deps: Pick<FdeDeps, 'now'>): Date => deps.now?.() ?? new Date();

/** An FDE principal's request context: the organisation and the principal, nothing else (49.4). */
export const asPrincipal = (organisationId: string, servicePrincipalId: string): RequestContext => ({ organisationId, servicePrincipalId });

export interface StageDefinition {
  number: number;
  name: string;
  /** The proposal kinds this stage produces and waits on. */
  kinds: readonly ProposalKind[];
}

/** 50.1. */
export const STAGES: readonly StageDefinition[] = [
  { number: 0, name: 'Install the agent and connect first systems', kinds: [] },
  { number: 1, name: 'Survey and estate map', kinds: ['estate_entry', 'discovery_finding'] },
  { number: 2, name: 'Connectors and conformance', kinds: ['connector_manifest', 'connector_mapping'] },
  { number: 3, name: 'Ontology draft and confirmation sessions', kinds: ['object_type', 'link_type', 'interface', 'field_alias', 'time_field'] },
  { number: 4, name: 'Resolution and field authority', kinds: ['resolution_pair', 'field_authority'] },
  { number: 5, name: 'Action types with sandbox write, verify and undo', kinds: ['action_type', 'write_enablement'] },
  { number: 6, name: 'First apps, object views and dashboards', kinds: ['studio_app', 'object_view_layout', 'dashboard'] },
  { number: 7, name: 'Crons in notify mode and detectors configured', kinds: ['cron_notify', 'detector_configuration'] },
  { number: 8, name: 'Dependency graph for scenarios', kinds: ['dependency_edge'] },
  { number: 9, name: 'Handover and steady state', kinds: ['heal_review', 'reliability_finding'] },
];

export const stageOfKind = (kind: ProposalKind): number => STAGES.find((s) => s.kinds.includes(kind))!.number;

/** Cell defaults for the limits of 52.5. */
export const DEFAULT_LIMITS: RateLimits = {
  modelCallsPerMinute: 30, probesPerMinute: 30, proposalsPerHour: 500, concurrentTasks: 4, pendingProposalsPerDecider: 200, attemptsPerTask: 3,
};

/** Limits as a request gives them: any, each possibly absent. */
export type LimitsInput = { [K in keyof RateLimits]?: number | undefined };

/** The limits with the given ones over them, absent ones left as they were. */
export const withLimits = (base: RateLimits, given: LimitsInput | undefined): RateLimits => ({
  ...base, ...Object.fromEntries(Object.entries(given ?? {}).filter(([, v]) => v !== undefined)),
});

export const limitsToRow = (l: RateLimits): Record<string, number> => ({
  model_calls_per_minute: l.modelCallsPerMinute, probes_per_minute: l.probesPerMinute, proposals_per_hour: l.proposalsPerHour,
  concurrent_tasks: l.concurrentTasks, pending_proposals_per_decider: l.pendingProposalsPerDecider, attempts_per_task: l.attemptsPerTask,
});

export const limitsOf = (row: unknown): RateLimits => {
  const r = row as Record<string, number>;
  return {
    modelCallsPerMinute: r['model_calls_per_minute']!, probesPerMinute: r['probes_per_minute']!, proposalsPerHour: r['proposals_per_hour']!,
    concurrentTasks: r['concurrent_tasks']!, pendingProposalsPerDecider: r['pending_proposals_per_decider']!, attemptsPerTask: r['attempts_per_task']!,
  };
};

/** 52.3: the fixed bands, which hold for a kind until measured acceptance sets its own (bands.service.ts). */
export function bandOf(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

/** How long a service principal of an engagement lives at most; it is revoked sooner at stop, handover or close. */
export const PRINCIPAL_LIFETIME_DAYS = 365;

export function engagementView(e: FdeEngagement): EngagementView {
  return {
    id: e.id, name: e.name, goals: e.goals, engagementClass: e.engagementClass, status: e.status, currentStage: e.currentStage,
    engagingMembershipId: e.engagingMembershipId, ownerMembershipId: e.ownerMembershipId ?? e.engagingMembershipId,
    supervisingEngineerMembershipId: e.supervisingEngineerMembershipId, scopeId: e.scopeId,
    tokenBudget: e.tokenBudget, tokensConsumed: e.tokensConsumed, providerCostBudget: e.providerCostBudget, providerCostConsumed: e.providerCostConsumed,
    rateLimits: limitsOf(e.rateLimits), modelRoute: e.modelRoute, startedAt: e.startedAt, agentInstalledAt: e.agentInstalledAt,
    stoppedAt: e.stoppedAt, stopReason: e.stopReason, handedOverAt: e.handedOverAt, handedOverTo: e.handedOverTo, closedAt: e.closedAt,
  };
}

export function stageView(s: FdeStage) {
  return {
    id: s.id, stageNumber: s.stageNumber, name: STAGES[s.stageNumber]!.name, attempt: s.attempt, status: s.status,
    exitCriteria: s.exitCriteria as { criterion: string; check: string; met: boolean | null }[],
    failureDetail: s.failureDetail as Record<string, never> | null, exitConfirmedBy: s.exitConfirmedBy, enteredAt: s.enteredAt, exitedAt: s.exitedAt,
  };
}

export function proposalView(p: FdeProposal, extra: { markings: string[]; appliedRef: string | null }): ProposalView {
  return {
    id: p.id, engagementId: p.engagementId, stageNumber: stageOfKind(p.kind), kind: p.kind, payload: p.payload as Record<string, never>,
    evidence: p.evidence as ProposalView['evidence'], confidence: p.confidence, confidenceBand: p.confidenceBand,
    verification: p.verification as Record<string, never>, requiredPermission: p.requiredPermission, markings: extra.markings,
    assignedMembershipId: p.assignedMembershipId, status: p.status, editDiff: p.editDiff as Record<string, never> | null,
    rejectionReason: p.rejectionReason, decidedBy: p.decidedBy, decidedAt: p.decidedAt, confirmationSessionId: p.confirmationSessionId,
    appliedRef: extra.appliedRef, createdAt: p.createdAt,
  };
}

/** The engagement log (52.8): references and counts, never values. */
export async function recordEvent(db: Queryable, e: {
  organisationId: string; correlationId: string; event: FdeEvent; engagementId: string;
  /** The person who acted; an FDE principal; or the orchestrator itself. */
  actor: { membershipId: string } | { servicePrincipalId: string } | 'orchestrator';
  resource?: { type: string; id: string };
  detail?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const actor: AuditActor = e.actor === 'orchestrator' ? { kind: 'service', service: 'fde-orchestrator' }
    : 'membershipId' in e.actor ? { kind: 'membership', membershipId: e.actor.membershipId }
      : { kind: 'service_principal', servicePrincipalId: e.actor.servicePrincipalId };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor, subjectMembershipId: null, scopeId: null, resource: e.resource ?? { type: 'fde_engagement', id: e.engagementId },
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: { engagement_id: e.engagementId, ...e.detail },
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: e.organisationId, topic: auditEventMessage.topic, orderingKey: e.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: e.correlationId,
  });
}

export type { FdeRole, ProposalKind };
