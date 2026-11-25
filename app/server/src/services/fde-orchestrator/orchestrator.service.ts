// The orchestrator (spec 49.1, 50, 52.5): each tick, for every active engagement, it checks
// the budgets, plans the current stage's tasks when it begins, runs what may run within the
// limits, and looks at whether the stage's exit criteria are met. Everything it does is in
// the engagement's tables and the audit log; the AI FDE has no other memory.
//
// Limits (52.5): a spent token or provider-cost budget pauses the engagement
// (fde_limit_reached); model calls per minute, proposals per hour and pending proposals per
// decider hold tasks back until there is room; attempts per task bound retries, after which
// the stop condition applies; three failures on one system in one stage escalate (53.4).

import { inTransaction } from '../../infra/postgres.infra.ts';
import type { FdeEngagement, FdeStage, FdeTask } from '../../models/fde/index.model.ts';
import {
  fdeEngagementRepo, fdeEscalationRepo, fdePrincipalRepo, fdeProposalRepo, fdeStageRepo, fdeTaskRepo,
} from '../../repos/fde/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { ROLE_PROPOSAL_KINDS, type ErrorSemantic, type FdeRole } from '../../contracts/fde-orchestrator/events.contract.ts';
import { limitsOf, nowOf, recordEvent, type FdeDeps } from './deps.service.ts';
import { createProposal } from './proposals.service.ts';
import { planStage, TaskFailure, TASKS, type ModelUse } from './roles.service.ts';
import { createStages } from './stages.service.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** Steady state (51.11): Reliability looks again this long after its last look finished. */
export const RELIABILITY_EVERY_MS = 24 * HOUR;

function semanticOf(error: unknown): { semantic: ErrorSemantic; subStage: string } {
  if (error instanceof TaskFailure) return { semantic: error.semantic, subStage: error.subStage };
  if (isAppError(error)) {
    if (error.code?.startsWith('metering.')) return { semantic: 'limit', subStage: 'charge' };
    const byCategory: Partial<Record<string, ErrorSemantic>> = {
      forbidden: 'ceiling', unauthenticated: 'auth', not_found: 'not_found', rate_limited: 'rate_limit', bounds: 'bounds', validation: 'schema',
    };
    return { semantic: byCategory[error.category] ?? 'upstream', subStage: 'call' };
  }
  return { semantic: 'upstream', subStage: 'call' };
}

export function createOrchestrator(deps: FdeDeps) {
  const pool = deps.databases.pool('control');
  const stages = createStages(deps);
  const tx = <T>(e: Pick<FdeEngagement, 'organisationId'>, work: Parameters<typeof inTransaction<T>>[2]) =>
    inTransaction(pool, { organisationId: e.organisationId }, work);

  async function pauseForLimit(e: FdeEngagement, limit: string): Promise<void> {
    await tx(e, async (db) => {
      const current = await fdeEngagementRepo.findById(db, e.id);
      if (current?.status !== 'active') return;
      await fdeEngagementRepo.update(db, e.id, { status: 'paused', pausedAt: nowOf(deps).toISOString() });
      await recordEvent(db, { organisationId: e.organisationId, correlationId: e.id, event: 'fde_limit_reached', engagementId: e.id, actor: 'orchestrator',
        detail: { limit } });
      await recordEvent(db, { organisationId: e.organisationId, correlationId: e.id, event: 'fde_engagement_paused', engagementId: e.id, actor: 'orchestrator',
        detail: { reason: limit } });
    });
    deps.logger.warn('an AI FDE engagement reached a limit and paused', { event: 'fde.limit_reached', organisationId: e.organisationId, resourceId: e.id, reason: limit });
  }

  /** Model use on the task and the engagement (52.6): provider tokens and cost, measured; fde_model_call, counts only. */
  async function recordModelUse(e: FdeEngagement, task: FdeTask, role: FdeRole, use: ModelUse): Promise<boolean> {
    const cost = (use.inputTokens * deps.providerPrice.inputPerMillion + use.outputTokens * deps.providerPrice.outputPerMillion) / 1_000_000;
    const pounds = cost.toFixed(4);
    return tx(e, async (db) => {
      const fresh = (await fdeTaskRepo.findById(db, task.id))!;
      await fdeTaskRepo.update(db, task.id, {
        tokensConsumed: String(BigInt(fresh.tokensConsumed) + 3n),
        providerInputTokens: String(BigInt(fresh.providerInputTokens) + BigInt(use.inputTokens)),
        providerOutputTokens: String(BigInt(fresh.providerOutputTokens) + BigInt(use.outputTokens)),
        providerCost: (Number(fresh.providerCost) + cost).toFixed(4),
      });
      const within = await fdeEngagementRepo.addProviderCost(db, e.id, pounds);
      await recordEvent(db, { organisationId: e.organisationId, correlationId: task.id, event: 'fde_model_call', engagementId: e.id, actor: 'orchestrator',
        resource: { type: 'model_call', id: use.callId },
        detail: { role, route: use.route, input_tokens: use.inputTokens, output_tokens: use.outputTokens, provider_cost: pounds, task_id: task.id } });
      return within !== undefined;
    });
  }

  async function runTask(e: FdeEngagement, stage: FdeStage, task: FdeTask): Promise<void> {
    const principal = await tx(e, (db) => fdePrincipalRepo.findById(db, task.principalId));
    if (principal === undefined || principal.revokedAt !== null) return;
    const started = await tx(e, async (db) => {
      const at = nowOf(deps).toISOString();
      const updated = (await fdeTaskRepo.update(db, task.id, { status: 'running', attempts: task.attempts + 1, startedAt: task.startedAt ?? at }))!;
      await recordEvent(db, { organisationId: e.organisationId, correlationId: task.id, event: 'fde_task_started', engagementId: e.id,
        actor: { servicePrincipalId: principal.servicePrincipalId }, resource: { type: 'fde_task', id: task.id },
        detail: { role: task.role, kind: task.kind, attempt: task.attempts + 1 } });
      return updated;
    });
    try {
      const run = TASKS[task.kind];
      if (run === undefined) throw new TaskFailure('unsupported_transport', 'plan', `${task.kind} is not built`);
      const outcome = await run({ deps, e, task: started, principal: principal.servicePrincipalId, correlationId: task.id });
      if ('wait' in outcome) {
        // Waiting on another service's own work is not an attempt.
        await tx(e, (db) => fdeTaskRepo.update(db, task.id, { status: 'queued', attempts: task.attempts, inputRefs: outcome.inputRefs as never }));
        return;
      }
      const foreign = outcome.proposals.find((p) => !ROLE_PROPOSAL_KINDS[task.role as FdeRole].includes(p.kind));
      if (foreign !== undefined) throw new TaskFailure('ceiling', 'proposal', `the ${task.role} role does not propose ${foreign.kind}`);
      if (outcome.modelUse !== undefined && !await recordModelUse(e, task, task.role, outcome.modelUse)) {
        await pauseForLimit(e, 'provider_cost_budget');
      }
      await tx(e, async (db) => {
        for (const p of outcome.proposals) await createProposal(db, e, started, p, task.id);
        await fdeTaskRepo.update(db, task.id, { status: 'succeeded', completedAt: nowOf(deps).toISOString() });
        await recordEvent(db, { organisationId: e.organisationId, correlationId: task.id, event: 'fde_task_completed', engagementId: e.id,
          actor: { servicePrincipalId: principal.servicePrincipalId }, resource: { type: 'fde_task', id: task.id },
          detail: { role: task.role, kind: task.kind, proposals: outcome.proposals.length } });
      });
    } catch (error) {
      const { semantic, subStage } = semanticOf(error);
      const final = semantic === 'limit' || semantic === 'ceiling' || started.attempts >= started.maxAttempts;
      await tx(e, async (db) => {
        await fdeTaskRepo.update(db, task.id, final
          ? { status: 'failed', failedAtStage: subStage, errorSemantic: semantic, completedAt: nowOf(deps).toISOString() }
          : { status: 'queued' });
        if (!final) return;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: task.id, event: 'fde_task_failed', engagementId: e.id,
          actor: { servicePrincipalId: principal.servicePrincipalId }, resource: { type: 'fde_task', id: task.id },
          detail: { role: task.role, kind: task.kind, failed_at_stage: subStage, error_semantic: semantic } });
        // 53.4: a stage failing three attempts on the same system goes to a person.
        if (task.connectionId !== null && await fdeTaskRepo.failedFor(db, stage.id, task.connectionId) >= 3
          && !await fdeEscalationRepo.openForConnection(db, stage.id, 'repeated_stage_failure', task.connectionId)) {
          const escalation = await fdeEscalationRepo.insert(db, {
            id: uuidv7(), organisationId: e.organisationId, engagementId: e.id, taskId: task.id, stageId: stage.id, cause: 'repeated_stage_failure',
            path: e.supervisingEngineerMembershipId !== null ? 'deployment_engineer' : 'support_ticket',
          });
          await recordEvent(db, { organisationId: e.organisationId, correlationId: task.id, event: 'fde_escalation_raised', engagementId: e.id,
            actor: 'orchestrator', resource: { type: 'fde_escalation', id: escalation.id }, detail: { cause: 'repeated_stage_failure', stage: stage.stageNumber } });
        }
      });
      if (!final) return;
      deps.logger.warn('an AI FDE task stopped', {
        event: 'fde.task_failed', organisationId: e.organisationId, resourceId: task.id, reason: semantic, outcome: subStage,
      });
      if (semantic === 'limit') await pauseForLimit(e, 'token_budget');
      // A stage whose only task failed has nothing else to go on (51.1): it names itself and stops.
      const others = await tx(e, async (db) => (await fdeTaskRepo.listForStage(db, stage.id)).filter((t) => t.id !== task.id && t.status !== 'failed'));
      if (others.length === 0 && task.connectionId === null) {
        await stages.fail(e, stage, { mechanism: task.kind, subStage, errorSemantic: semantic, taskId: task.id }, task.id);
      }
    }
  }

  async function plan(e: FdeEngagement, stage: FdeStage): Promise<void> {
    const principals = await tx(e, async (db) => Object.fromEntries((await fdePrincipalRepo.listForEngagement(db, e.id))
      .filter((p) => p.revokedAt === null).map((p) => [p.role, p]))) as Partial<Record<FdeRole, { id: string; servicePrincipalId: string }>>;
    const planned = await planStage(deps, e, stage.stageNumber,
      Object.fromEntries(Object.entries(principals).map(([role, p]) => [role, p!.servicePrincipalId])) as Partial<Record<FdeRole, string>>);
    const maxAttempts = limitsOf(e.rateLimits).attemptsPerTask;
    await tx(e, async (db) => {
      for (const t of planned) {
        const principal = principals[t.role];
        if (principal === undefined) continue;
        await fdeTaskRepo.insert(db, {
          id: uuidv7(), organisationId: e.organisationId, engagementId: e.id, stageId: stage.id, role: t.role, principalId: principal.id,
          connectionId: t.connectionId ?? null, kind: t.kind, inputRefs: t.inputRefs as never, maxAttempts,
        });
      }
    });
  }

  /** One engagement, as far as it can go this tick. */
  async function step(organisationId: string, engagementId: string): Promise<void> {
    const e = await tx({ organisationId }, (db) => fdeEngagementRepo.findById(db, engagementId));
    if (e === undefined || e.status !== 'active') return;
    if (BigInt(e.tokensConsumed) >= BigInt(e.tokenBudget) && BigInt(e.tokenBudget) > 0n) return pauseForLimit(e, 'token_budget');
    if (Number(e.providerCostConsumed) >= Number(e.providerCostBudget) && Number(e.providerCostBudget) > 0) return pauseForLimit(e, 'provider_cost_budget');
    const stage = await tx(e, (db) => fdeStageRepo.latest(db, e.id, e.currentStage));
    if (stage === undefined || stage.status !== 'running') return;

    // Planning is repeatable: a stage with no tasks yet plans again until it has some, or
    // has nothing to do (its criteria are the platform's own state).
    // Stage 9 is steady state: once its look has finished, Reliability looks again a day later.
    const tasks = await tx(e, (db) => fdeTaskRepo.listForStage(db, stage!.id));
    const latest = tasks.reduce((at, t) => Math.max(at, Date.parse(t.createdAt)), 0);
    if (tasks.length === 0 || (stage.stageNumber === 9 && tasks.every((t) => t.status !== 'queued' && t.status !== 'running')
      && latest <= nowOf(deps).getTime() - RELIABILITY_EVERY_MS)) await plan(e, stage);

    const limits = limitsOf(e.rateLimits);
    const at = nowOf(deps);
    const room = await tx(e, async (db) => ({
      started: await fdeTaskRepo.startedSince(db, e.id, new Date(at.getTime() - MINUTE).toISOString()),
      proposed: await fdeProposalRepo.createdSince(db, e.id, new Date(at.getTime() - HOUR).toISOString()),
      pending: await fdeProposalRepo.pendingFor(db, e.id, null),
    }));
    const runnable = (await tx(e, (db) => fdeTaskRepo.runnable(db, e.id))).filter((t) => t.stageId === stage!.id);
    const mayRun = room.proposed < limits.proposalsPerHour && room.pending < limits.pendingProposalsPerDecider;
    let budget = Math.min(limits.concurrentTasks, Math.max(0, limits.modelCallsPerMinute - room.started));
    for (const task of runnable) {
      if (!mayRun || budget <= 0) break;
      budget -= 1;
      await runTask(e, stage, task);
      const fresh = await tx(e, (db) => fdeEngagementRepo.findById(db, e.id));
      if (fresh?.status !== 'active') return;
    }

    const current = await tx(e, (db) => fdeStageRepo.findById(db, stage!.id));
    if (current?.status === 'running') {
      const fresh = (await tx(e, (db) => fdeEngagementRepo.findById(db, e.id)))!;
      await stages.review(fresh, current, e.id);
    }
  }

  return {
    step,

    /** Every active engagement in the cell, a step each. */
    async tick(limit = 50): Promise<number> {
      const engagements = await inTransaction(pool, {}, (db) => fdeEngagementRepo.toRun(db, limit), { readOnly: true });
      for (const e of engagements) {
        try {
          await step(e.organisationId, e.id);
        } catch (error) {
          deps.logger.failure('an AI FDE engagement step failed; it is tried again next tick', error, {
            event: 'fde.step_failed', organisationId: e.organisationId, resourceId: e.id,
          });
        }
      }
      return engagements.length;
    },
  };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;
