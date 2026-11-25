// Engagements (spec 49.1, 49.4, 50.12, 52.5, 52.7): their start with one service principal per
// role, pause and resume, the stop button, close, limits, the deployment engineer, and handover.
//
// The gateway checks the permission each route needs. Here are the rules a single
// permission cannot state: a supervisor may only lower a limit; a stopped, handed-over or
// closed engagement stays so; stop revokes every principal and withdraws every pending
// proposal in the same transaction as the status change.

import { engagementTotals } from '../metering/ledger.service.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import { FDE_ROLES, ROLE_TOOL_PERMISSIONS, type FdeRole } from '../../contracts/fde-orchestrator/events.contract.ts';
import type { RateLimits } from '../../contracts/fde-orchestrator/engagement.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { FdeEngagement, FdePrincipal } from '../../models/fde/index.model.ts';
import {
  fdeEngagementRepo, fdeEscalationRepo, fdePrincipalRepo, fdeProposalRepo, fdeProposalTargetRepo, fdeStageRepo, fdeTaskRepo,
} from '../../repos/fde/index.repo.ts';
import { membershipRepo, scopeRepo, servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  DEFAULT_LIMITS, engagementView, limitsOf, limitsToRow, nowOf, PRINCIPAL_LIFETIME_DAYS, recordEvent, stageView, withLimits, type Context, type FdeDeps,
  type LimitsInput,
} from './deps.service.ts';
import { criteriaFor } from './stages.service.ts';

const notFound = (): AppError => new AppError('not_found', 'no such engagement', { code: 'fde.engagement_not_found' });
const conflict = (code: string, message: string): AppError => new AppError('conflict', message, { code: `fde.${code}` });

/** Whether the person holds a permission, decided by policy in their own session. */
export async function holds(deps: Pick<FdeDeps, 'services'>, ctx: Context, permission: string, where: { scopeId?: string | null } = {})
  : Promise<boolean> {
  const body = where.scopeId != null ? { permission, scopeId: where.scopeId } : { permission };
  return (await deps.services.call(authorise, { body }, { request: ctx.request, correlationId: ctx.correlationId })).decision === 'allow';
}

export async function loadEngagement(db: Queryable, engagementId: string): Promise<FdeEngagement> {
  const found = await fdeEngagementRepo.findById(db, engagementId);
  if (found === undefined) throw notFound();
  return found;
}

/** Creates one role's service principal (kind fde) for an engagement and its fde_principals row. */
export async function createPrincipal(db: Queryable, deps: Pick<FdeDeps, 'now'>, e: FdeEngagement, role: FdeRole, by: string,
  correlationId: string): Promise<FdePrincipal> {
  const at = nowOf(deps);
  const sp = await servicePrincipalRepo.insert(db, {
    id: uuidv7(), organisationId: e.organisationId, kind: 'fde', name: `AI FDE ${role} · ${e.name}`.slice(0, 200), scopeId: e.scopeId,
    ownerMembershipId: e.engagingMembershipId, engagementId: e.id, createdBy: by,
    expiresAt: new Date(at.getTime() + PRINCIPAL_LIFETIME_DAYS * 86_400_000).toISOString(),
  });
  const principal = await fdePrincipalRepo.insert(db, {
    id: uuidv7(), organisationId: e.organisationId, engagementId: e.id, servicePrincipalId: sp.id, role,
    toolPermissions: [...ROLE_TOOL_PERMISSIONS[role]], createdBy: by,
  });
  await recordEvent(db, { organisationId: e.organisationId, correlationId, event: 'fde_principal_created', engagementId: e.id,
    actor: { membershipId: by }, resource: { type: 'service_principal', id: sp.id }, detail: { role } });
  return principal;
}

/** Revokes principals, both rows in one go: the principal stops on its next call (52.7). */
async function revokePrincipals(db: Queryable, deps: Pick<FdeDeps, 'now'>, e: FdeEngagement, correlationId: string, keep?: FdeRole): Promise<number> {
  const at = nowOf(deps).toISOString();
  let revoked = 0;
  for (const p of await fdePrincipalRepo.listForEngagement(db, e.id)) {
    if (p.revokedAt !== null || p.role === keep) continue;
    await fdePrincipalRepo.update(db, p.id, { revokedAt: at });
    await servicePrincipalRepo.update(db, p.servicePrincipalId, { revokedAt: at });
    await recordEvent(db, { organisationId: e.organisationId, correlationId, event: 'fde_principal_revoked', engagementId: e.id,
      actor: 'orchestrator', resource: { type: 'service_principal', id: p.servicePrincipalId }, detail: { role: p.role } });
    revoked += 1;
  }
  return revoked;
}

/**
 * engagement_cost_reported (73.5, 73.9): the cost report as it stands when the engagement ends
 * (closed, handed over or stopped), so the margin calculator prices it from the record.
 */
async function reportCost(db: Queryable, e: { id: string; organisationId: string; currentStage: number }, correlationId: string, membershipId: string,
  reason: 'closed' | 'handed_over' | 'stopped'): Promise<void> {
  const report = await engagementTotals(db, e.organisationId, e.id);
  await recordEvent(db, {
    organisationId: e.organisationId, correlationId, event: 'engagement_cost_reported', engagementId: e.id, actor: { membershipId },
    detail: {
      reason, stage: e.currentStage, tokens_charged: report.tokensCharged, simulations_charged: report.simulationsCharged,
      model_cost: report.modelCost.amount, model_cost_measured: report.modelCost.measured, model_calls: report.modelCost.calls, operations: report.lines.length,
    },
  });
}

export function createEngagements(deps: FdeDeps) {
  const pool = deps.databases.pool('control');
  const tx = <T>(ctx: Context, work: (db: Queryable) => Promise<T>) => inTransaction(pool, ctx.request, work);

  async function full(db: Queryable, e: FdeEngagement) {
    return {
      ...engagementView(e),
      stages: (await fdeStageRepo.listForEngagement(db, e.id)).map(stageView),
      principals: (await fdePrincipalRepo.listForEngagement(db, e.id)).map((p) => ({
        id: p.id, servicePrincipalId: p.servicePrincipalId, role: p.role, toolPermissions: p.toolPermissions, revokedAt: p.revokedAt,
      })),
    };
  }

  /** Stop and close share their withdrawal of what is pending. */
  async function withdrawPending(db: Queryable, e: FdeEngagement, correlationId: string): Promise<void> {
    for (const id of await fdeProposalRepo.withdrawPending(db, e.id)) {
      await recordEvent(db, { organisationId: e.organisationId, correlationId, event: 'fde_proposal_withdrawn', engagementId: e.id,
        actor: 'orchestrator', resource: { type: 'fde_proposal', id } });
    }
  }

  return {
    async start(ctx: Context, input: {
      name: string; goals: string; engagementClass: FdeEngagement['engagementClass']; tokenBudget: number; providerCostBudget: string;
      rateLimits?: LimitsInput | undefined; scopeId?: string | undefined;
    }) {
      const membershipId = ctx.request.membershipId!;
      const organisationId = ctx.request.organisationId!;
      return tx(ctx, async (db) => {
        if (input.scopeId !== undefined && await scopeRepo.findById(db, input.scopeId) === undefined) {
          throw new AppError('validation', 'no such scope', { code: 'fde.scope_unknown' });
        }
        const at = nowOf(deps).toISOString();
        const e = await fdeEngagementRepo.insert(db, {
          id: uuidv7(), organisationId, name: input.name, goals: input.goals, engagingMembershipId: membershipId, scopeId: input.scopeId ?? null,
          engagementClass: input.engagementClass, cellId: deps.cellId, status: 'active', currentStage: 0, tokenBudget: String(input.tokenBudget),
          providerCostBudget: input.providerCostBudget, rateLimits: limitsToRow(withLimits(DEFAULT_LIMITS, input.rateLimits)), modelRoute: 'fde',
          startedAt: at,
        });
        await recordEvent(db, { organisationId, correlationId: ctx.correlationId, event: 'fde_engagement_started', engagementId: e.id,
          actor: { membershipId }, detail: { engagement_class: e.engagementClass, token_budget: input.tokenBudget, scoped: input.scopeId !== undefined } });
        for (const role of FDE_ROLES) await createPrincipal(db, deps, e, role, membershipId, ctx.correlationId);
        await enterStage(db, deps, e, 0, 1, ctx.correlationId);
        return full(db, e);
      });
    },

    async list(ctx: Context) {
      return { engagements: (await tx(ctx, (db) => fdeEngagementRepo.listForOrganisation(db, ctx.request.organisationId!))).map(engagementView) };
    },

    async get(ctx: Context, engagementId: string) {
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        return { ...await full(db, e), proposals: await fdeProposalRepo.countByStatus(db, e.id) as never, openEscalations: await fdeEscalationRepo.countOpen(db, e.id) };
      });
    },

    async pause(ctx: Context, engagementId: string) {
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active') throw conflict('not_active', `the engagement is ${e.status}`);
        const paused = (await fdeEngagementRepo.update(db, e.id, { status: 'paused', pausedAt: nowOf(deps).toISOString() }))!;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_engagement_paused', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! }, detail: { reason: 'manual' } });
        return engagementView(paused);
      });
    },

    async resume(ctx: Context, engagementId: string) {
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'paused') throw conflict('not_paused', `the engagement is ${e.status}`);
        if (BigInt(e.tokensConsumed) >= BigInt(e.tokenBudget) || Number(e.providerCostConsumed) >= Number(e.providerCostBudget)) {
          throw conflict('limit_reached', 'a budget is spent: raise it before resuming');
        }
        const resumed = (await fdeEngagementRepo.update(db, e.id, { status: 'active', pausedAt: null }))!;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_engagement_resumed', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! } });
        return engagementView(resumed);
      });
    },

    /** 52.7: tasks cancelled, principals revoked, pending proposals withdrawn, with the status change. Never resumed. */
    async stop(ctx: Context, engagementId: string, reason: string) {
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active' && e.status !== 'paused') throw conflict('final', `the engagement is ${e.status}`);
        const at = nowOf(deps).toISOString();
        const cancelled = await fdeTaskRepo.cancelOpen(db, e.id);
        const revoked = await revokePrincipals(db, deps, e, ctx.correlationId);
        await withdrawPending(db, e, ctx.correlationId);
        const stage = await fdeStageRepo.latest(db, e.id, e.currentStage);
        if (stage !== undefined && ['pending', 'running', 'awaiting_confirmation'].includes(stage.status)) {
          await fdeStageRepo.update(db, stage.id, { status: 'stopped', exitedAt: at });
        }
        const stopped = (await fdeEngagementRepo.update(db, e.id, {
          status: 'stopped', stoppedAt: at, stoppedBy: ctx.request.membershipId!, stopReason: reason, pausedAt: null,
        }))!;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_engagement_stopped', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! }, detail: { tasks_cancelled: cancelled, principals_revoked: revoked, stage: e.currentStage } });
        await reportCost(db, e, ctx.correlationId, ctx.request.membershipId!, 'stopped');
        return engagementView(stopped);
      });
    },

    async close(ctx: Context, engagementId: string) {
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active' && e.status !== 'paused') throw conflict('final', `the engagement is ${e.status}`);
        await fdeTaskRepo.cancelOpen(db, e.id);
        await revokePrincipals(db, deps, e, ctx.correlationId);
        await withdrawPending(db, e, ctx.correlationId);
        const closed = (await fdeEngagementRepo.update(db, e.id, { status: 'closed', closedAt: nowOf(deps).toISOString(), pausedAt: null }))!;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_engagement_closed', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! } });
        await reportCost(db, e, ctx.correlationId, ctx.request.membershipId!, 'closed');
        return engagementView(closed);
      });
    },

    /** fde.engage sets any limit; fde.supervise may lower one, never raise it (49.8). */
    async setLimits(ctx: Context, engagementId: string, input: { tokenBudget?: number | undefined; providerCostBudget?: string | undefined; rateLimits?: LimitsInput | undefined }) {
      const engage = await holds(deps, ctx, 'fde.engage');
      if (!engage && !await holds(deps, ctx, 'fde.supervise')) {
        throw new AppError('forbidden', 'you hold neither fde.engage nor fde.supervise', { code: 'fde.not_permitted' });
      }
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active' && e.status !== 'paused') throw conflict('final', `the engagement is ${e.status}`);
        const current = limitsOf(e.rateLimits);
        const next = withLimits(current, input.rateLimits);
        if (!engage) {
          const raised = (input.tokenBudget !== undefined && input.tokenBudget > Number(e.tokenBudget))
            || (input.providerCostBudget !== undefined && Number(input.providerCostBudget) > Number(e.providerCostBudget))
            || (Object.keys(next) as (keyof RateLimits)[]).some((k) => next[k] > current[k]);
          if (raised) throw new AppError('forbidden', 'a supervisor may only lower a limit', { code: 'fde.supervisor_raises' });
        }
        const updated = (await fdeEngagementRepo.update(db, e.id, {
          ...(input.tokenBudget !== undefined ? { tokenBudget: String(input.tokenBudget) } : {}),
          ...(input.providerCostBudget !== undefined ? { providerCostBudget: input.providerCostBudget } : {}),
          rateLimits: limitsToRow(next),
        }))!;
        return engagementView(updated);
      });
    },

    async assignEngineer(ctx: Context, engagementId: string, membershipId: string) {
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active' && e.status !== 'paused') throw conflict('final', `the engagement is ${e.status}`);
        if ((await membershipRepo.findById(db, membershipId))?.status !== 'active') {
          throw new AppError('validation', 'the engineer is not an active member', { code: 'fde.engineer_unknown' });
        }
        if (membershipId === (e.ownerMembershipId ?? e.engagingMembershipId)) {
          throw new AppError('validation', 'the engagement owner confirms the stages, so does not also supervise as the engineer', { code: 'fde.engineer_is_owner' });
        }
        const updated = (await fdeEngagementRepo.update(db, e.id, { supervisingEngineerMembershipId: membershipId }))!;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_engineer_assigned', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! }, resource: { type: 'membership', id: membershipId } });
        return engagementView(updated);
      });
    },

    /** The customer's engagement owner (decision 2026-11-14): an active member, never the supervising engineer. */
    async nameOwner(ctx: Context, engagementId: string, membershipId: string) {
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active' && e.status !== 'paused') throw conflict('final', `the engagement is ${e.status}`);
        if ((await membershipRepo.findById(db, membershipId))?.status !== 'active') {
          throw new AppError('validation', 'the owner is not an active member', { code: 'fde.owner_unknown' });
        }
        if (membershipId === e.supervisingEngineerMembershipId) {
          throw new AppError('validation', 'the supervising engineer confirms nothing, so is never the owner', { code: 'fde.owner_is_engineer' });
        }
        const updated = (await fdeEngagementRepo.update(db, e.id, { ownerMembershipId: membershipId }))!;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_owner_named', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! }, resource: { type: 'membership', id: membershipId } });
        return engagementView(updated);
      });
    },

    async removeEngineer(ctx: Context, engagementId: string) {
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.supervisingEngineerMembershipId === null) throw conflict('no_engineer', 'no engineer supervises this engagement');
        const updated = (await fdeEngagementRepo.update(db, e.id, { supervisingEngineerMembershipId: null }))!;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_engineer_removed', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! }, resource: { type: 'membership', id: e.supervisingEngineerMembershipId } });
        return engagementView(updated);
      });
    },

    async tasks(ctx: Context, engagementId: string) {
      return tx(ctx, async (db) => {
        await loadEngagement(db, engagementId);
        const stages = new Map((await fdeStageRepo.listForEngagement(db, engagementId)).map((s) => [s.id, s.stageNumber]));
        return {
          tasks: (await fdeTaskRepo.listForEngagement(db, engagementId)).map((t) => ({
            id: t.id, stageNumber: stages.get(t.stageId) ?? 0, role: t.role, kind: t.kind, connectionId: t.connectionId, status: t.status,
            attempts: t.attempts, maxAttempts: t.maxAttempts, tokensConsumed: t.tokensConsumed, providerInputTokens: t.providerInputTokens,
            providerOutputTokens: t.providerOutputTokens, providerCost: t.providerCost, failedAtStage: t.failedAtStage,
            errorSemantic: t.errorSemantic, createdAt: t.createdAt, startedAt: t.startedAt, completedAt: t.completedAt,
          })),
        };
      });
    },

    /** 50.12: what the engagement made and who confirmed it, what waits, and what was left out. */
    async handover(ctx: Context, engagementId: string) {
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        const proposals = await fdeProposalRepo.listForEngagement(db, e.id);
        const decided = proposals.filter((p) => p.status === 'accepted' || p.status === 'accepted_edited');
        const targets = new Map((await fdeProposalTargetRepo.appliedFor(db, decided.map((p) => p.id))).map((t) => [t.proposalId, t]));
        const targetOf = (id: string): string | null => {
          const t = targets.get(id);
          if (t === undefined) return null;
          const ref = Object.entries(t).find(([k, v]) => k.endsWith('Id') && !['id', 'organisationId', 'proposalId'].includes(k) && typeof v === 'string');
          return ref === undefined ? null : `${ref[0].replace(/Id$/, '')}:${String(ref[1])}`;
        };
        return {
          engagementId: e.id,
          artefacts: decided.map((p) => ({ proposalId: p.id, kind: p.kind, target: targetOf(p.id), decidedBy: p.decidedBy!, decidedAt: p.decidedAt! })),
          deferred: proposals.filter((p) => p.status === 'deferred').map((p) => ({ proposalId: p.id, kind: p.kind })),
          rejected: proposals.filter((p) => p.status === 'rejected').map((p) => ({ proposalId: p.id, kind: p.kind, reason: p.rejectionReason })),
          openEscalations: (await fdeEscalationRepo.listForEngagement(db, e.id)).filter((x) => x.status === 'open')
            .map((x) => ({ escalationId: x.id, cause: x.cause, path: x.path })),
          excludedSystems: proposals.filter((p) => p.kind === 'estate_entry' && p.status === 'rejected')
            .map((p) => String((p.payload as { connectionId: string }).connectionId)),
          tokensConsumed: e.tokensConsumed,
          providerCostConsumed: e.providerCostConsumed,
        };
      });
    },

    /** Handover accepted (50.12): every principal revoked, but Reliability, kept under a successor engagement with its own budget. */
    async acceptHandover(ctx: Context, engagementId: string, input: {
      keepReliability: boolean; reliabilityTokenBudget?: number | undefined; reliabilityProviderCostBudget?: string | undefined;
    }) {
      const membershipId = ctx.request.membershipId!;
      return tx(ctx, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active' || e.currentStage !== 9) throw conflict('not_at_handover', 'the engagement has not reached handover (stage 9)');
        const at = nowOf(deps).toISOString();
        await fdeTaskRepo.cancelOpen(db, e.id);
        await revokePrincipals(db, deps, e, ctx.correlationId);
        const stage = await fdeStageRepo.latest(db, e.id, 9);
        if (stage !== undefined && stage.status !== 'passed') {
          await fdeStageRepo.update(db, stage.id, {
            status: 'passed', exitConfirmedBy: membershipId, exitedAt: at,
            exitCriteria: (stage.exitCriteria as { criterion: string }[]).map((c) => ({ ...c, met: true })) as never,
          });
          await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_stage_passed', engagementId: e.id,
            actor: { membershipId }, resource: { type: 'fde_stage', id: stage.id }, detail: { stage: 9 } });
        }
        const handed = (await fdeEngagementRepo.update(db, e.id, { status: 'handed_over', handedOverAt: at, handedOverTo: membershipId }))!;
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_engagement_handed_over', engagementId: e.id,
          actor: { membershipId }, detail: { reliability_kept: input.keepReliability } });
        await reportCost(db, e, ctx.correlationId, membershipId, 'handed_over');
        let successorEngagementId: string | null = null;
        if (input.keepReliability) {
          const successor = await fdeEngagementRepo.insert(db, {
            id: uuidv7(), organisationId: e.organisationId, name: `${e.name} · Reliability`.slice(0, 200), goals: e.goals, engagingMembershipId: membershipId,
            scopeId: e.scopeId, engagementClass: e.engagementClass, cellId: e.cellId, status: 'active', currentStage: 9,
            tokenBudget: String(input.reliabilityTokenBudget!), providerCostBudget: input.reliabilityProviderCostBudget!, rateLimits: e.rateLimits,
            modelRoute: e.modelRoute, startedAt: at, predecessorEngagementId: e.id,
          });
          await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_engagement_started', engagementId: successor.id,
            actor: { membershipId }, detail: { successor_of: e.id, engagement_class: e.engagementClass } });
          await createPrincipal(db, deps, successor, 'reliability', membershipId, ctx.correlationId);
          await enterStage(db, deps, successor, 9, 1, ctx.correlationId);
          successorEngagementId = successor.id;
        }
        return { ...engagementView(handed), successorEngagementId };
      });
    },
  };
}

/** Enters a stage: a new attempt row, running, with its criteria not yet evaluated. */
export async function enterStage(db: Queryable, deps: Pick<FdeDeps, 'now'>, e: FdeEngagement, stageNumber: number, attempt: number, correlationId: string) {
  const stage = await fdeStageRepo.insert(db, {
    id: uuidv7(), organisationId: e.organisationId, engagementId: e.id, stageNumber, attempt, status: 'running',
    exitCriteria: criteriaFor(stageNumber).map((c) => ({ ...c, met: null })) as never, enteredAt: nowOf(deps).toISOString(),
  });
  await recordEvent(db, { organisationId: e.organisationId, correlationId, event: 'fde_stage_entered', engagementId: e.id, actor: 'orchestrator',
    resource: { type: 'fde_stage', id: stage.id }, detail: { stage: stageNumber, attempt } });
  return stage;
}

export type Engagements = ReturnType<typeof createEngagements>;
