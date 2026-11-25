// The ten stages (spec 50): each has exit criteria the orchestrator evaluates from the
// platform's own state and a person confirms. No stage begins before the one before has
// passed. Stage 8 may be skipped by decision where Scenarios are not used (50.11); stage 9
// ends when the handover is accepted (engagements.service.ts).
//
// The criteria are read as the engagement's own principals see the estate (49.4): what the
// engaging administrator could not see is not counted.

import { authorise } from '../../contracts/policy/decision.contract.ts';
import { listConnections } from '../../contracts/connect-registry/connection.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { FdeEngagement, FdeStage } from '../../models/fde/index.model.ts';
import { fdeEngagementRepo, fdeEngagementSystemRepo, fdePrincipalRepo, fdeProposalRepo, fdeStageRepo, fdeTaskRepo } from '../../repos/fde/index.repo.ts';
import { appPublicationRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { asPrincipal, engagementView, nowOf, recordEvent, STAGES, stageView, type Context, type FdeDeps, type FdeRole } from './deps.service.ts';
import { enterStage, loadEngagement } from './engagements.service.ts';

export interface Criterion { criterion: string; check: string }
export type Evaluated = Criterion & { met: boolean | null };

const CRITERIA: readonly (readonly Criterion[])[] = [
  [{ criterion: 'connection_ready', check: 'a first connection is verified or active' }],
  [{ criterion: 'survey_decided', check: 'every survey proposal is decided or deferred' },
    { criterion: 'scope_confirmed', check: 'at least one system is confirmed in scope' }],
  [{ criterion: 'in_scope_verified', check: 'each system in scope is verified or active, or excluded' }],
  [{ criterion: 'ontology_decided', check: 'every proposed object type and link type is decided or deferred' }],
  [{ criterion: 'resolution_decided', check: 'every resolution proposal is decided or deferred' }],
  [{ criterion: 'action_types_decided', check: 'every proposed action type is decided or deferred' }],
  [{ criterion: 'app_published', check: 'at least one Studio app is published to its users' }],
  [{ criterion: 'crons_and_detectors_decided', check: 'every proposed Cron and detector configuration is decided or deferred' }],
  [{ criterion: 'edges_decided', check: 'every proposed dependency edge is decided or deferred' }],
  [{ criterion: 'handover_accepted', check: 'the engaging administrator accepts the handover' }],
];

export const criteriaFor = (stageNumber: number): readonly Criterion[] => CRITERIA[stageNumber]!;

/** The stage whose work writes to source systems: action types' sandboxed write, verify and undo (50.8). */
export const WRITING_STAGE = 5;

/** The connections in scope: the systems a person accepted at stage 1. */
/**
 * The systems in scope: the connections whose estate entries a person accepted, and the
 * connections drafted for the systems a person listed (51.4: listing one puts it in scope).
 * pending: listed systems whose connector is not drafted yet.
 */
export async function inScope(db: Queryable, engagementId: string): Promise<{ accepted: string[]; excluded: string[]; pending: string[] }> {
  const entries = await fdeProposalRepo.listForEngagement(db, engagementId, { kind: 'estate_entry' });
  const systems = (await fdeEngagementSystemRepo.listForEngagement(db, engagementId)).filter((s) => s.status !== 'withdrawn');
  // A Reliability successor (50.12) watches the systems its predecessor had in scope.
  if (entries.length === 0 && systems.length === 0) {
    const predecessor = (await fdeEngagementRepo.findById(db, engagementId))?.predecessorEngagementId;
    if (predecessor !== null && predecessor !== undefined) return inScope(db, predecessor);
  }
  const of = (statuses: string[]) => entries.filter((p) => statuses.includes(p.status)).map((p) => String((p.payload as { connectionId: string }).connectionId));
  const drafted = systems.filter((s) => s.connectionId !== null).map((s) => s.connectionId!);
  return {
    accepted: [...new Set([...of(['accepted', 'accepted_edited']), ...drafted])], excluded: of(['rejected']),
    pending: systems.filter((s) => s.connectionId === null).map((s) => s.id),
  };
}

export function createStages(deps: FdeDeps) {
  const pool = deps.databases.pool('control');

  async function principalOf(e: FdeEngagement, role: FdeRole): Promise<string | undefined> {
    return (await inTransaction(pool, { organisationId: e.organisationId }, (db) => fdePrincipalRepo.liveForRole(db, e.id, role), { readOnly: true }))
      ?.servicePrincipalId;
  }

  async function connections(e: FdeEngagement) {
    const sp = await principalOf(e, 'survey');
    if (sp === undefined) return [];
    return (await deps.services.call(listConnections, { query: { limit: 500 } }, { request: asPrincipal(e.organisationId, sp), correlationId: e.id })).connections;
  }

  /** Each criterion of a stage, met or not, now. */
  async function evaluate(e: FdeEngagement, stage: FdeStage): Promise<Evaluated[]> {
    const read = <T>(work: (db: Queryable) => Promise<T>) => inTransaction(pool, { organisationId: e.organisationId }, work, { readOnly: true });
    const kinds = STAGES[stage.stageNumber]!.kinds;
    const quiet = await read(async (db) => (await fdeTaskRepo.runnable(db, e.id)).filter((t) => t.stageId === stage.id).length === 0);
    const decided = quiet && await read(async (db) => (await fdeProposalRepo.pendingOfKinds(db, e.id, kinds)) === 0);
    const met: Record<string, boolean | null> = {};
    switch (stage.stageNumber) {
      case 0:
        met['connection_ready'] = (await connections(e)).some((c) => c.status === 'verified' || c.status === 'active');
        break;
      case 1: {
        const scope = await read((db) => inScope(db, e.id));
        met['survey_decided'] = decided;
        met['scope_confirmed'] = scope.accepted.length + scope.pending.length > 0;
        break;
      }
      case 2: {
        const scope = await read((db) => inScope(db, e.id));
        const live = new Map((await connections(e)).map((c) => [c.id, c.status]));
        // Every listed system drafted, and every system in scope verified.
        met['in_scope_verified'] = scope.accepted.length > 0 && scope.pending.length === 0
          && scope.accepted.every((id) => live.get(id) === 'verified' || live.get(id) === 'active');
        break;
      }
      case 3: met['ontology_decided'] = decided; break;
      case 4: met['resolution_decided'] = decided; break;
      case 5: met['action_types_decided'] = decided; break;
      case 6:
        // Studio lists apps to members only; whether any app is published is the platform's own state.
        met['app_published'] = await read((db) => appPublicationRepo.anyLive(db));
        break;
      case 7: met['crons_and_detectors_decided'] = decided; break;
      case 8: met['edges_decided'] = decided; break;
      case 9: met['handover_accepted'] = e.status === 'handed_over'; break;
    }
    return criteriaFor(stage.stageNumber).map((c) => ({ ...c, met: met[c.criterion] ?? null }));
  }

  return {
    evaluate,

    /**
     * The orchestrator's look at a running stage: its criteria recorded; all met, it waits for
     * a person to confirm the exit. Stage 0's first ready connection starts the clock (54.1).
     */
    async review(e: FdeEngagement, stage: FdeStage, correlationId: string): Promise<FdeStage> {
      if (stage.status !== 'running' || stage.stageNumber === 9) return stage;
      const criteria = await evaluate(e, stage);
      const all = criteria.every((c) => c.met === true);
      return inTransaction(pool, { organisationId: e.organisationId }, async (db) => {
        if (stage.stageNumber === 0 && all && e.agentInstalledAt === null) {
          await fdeEngagementRepo.update(db, e.id, { agentInstalledAt: nowOf(deps).toISOString() });
        }
        const updated = (await fdeStageRepo.update(db, stage.id, { exitCriteria: criteria as never, ...(all ? { status: 'awaiting_confirmation' } : {}) }))!;
        if (all) {
          deps.logger.info('an AI FDE stage awaits its exit confirmation', {
            event: 'fde.stage_awaiting', organisationId: e.organisationId, resourceId: stage.id, outcome: String(stage.stageNumber),
          });
        }
        void correlationId;
        return updated;
      });
    },

    /**
     * The engagement owner confirms the exit, or skips stage 8 by decision; the next stage
     * begins (decision 2026-11-14: Silo staff and the supervising engineer confirm nothing).
     * Stage 5 writes to sources, so its confirmer holds mutation.policy on each connection in scope.
     */
    async confirmExit(ctx: Context, engagementId: string, stageNumber: number, skip: boolean) {
      const membershipId = ctx.request.membershipId!;
      const before = await inTransaction(pool, ctx.request, (db) => loadEngagement(db, engagementId), { readOnly: true });
      if (membershipId !== (before.ownerMembershipId ?? before.engagingMembershipId)) {
        throw new AppError('forbidden', 'only the engagement owner confirms a stage exit', { code: 'fde.not_engagement_owner' });
      }
      if (stageNumber === WRITING_STAGE && !skip) {
        const { accepted } = await inTransaction(pool, ctx.request, (db) => inScope(db, engagementId), { readOnly: true });
        for (const connectionId of accepted) {
          const decision = await deps.services.call(authorise, {
            body: { permission: 'mutation.policy', resource: { type: 'connection', id: connectionId } },
          }, { request: ctx.request, correlationId: ctx.correlationId });
          if (decision.decision !== 'allow') {
            throw new AppError('forbidden', 'stage 5 writes to source systems: its confirmer holds mutation.policy on every connection in scope', {
              code: 'fde.confirmer_lacks_action_permission', details: { connectionId },
            });
          }
        }
      }
      return inTransaction(pool, ctx.request, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active') throw new AppError('conflict', `the engagement is ${e.status}`, { code: 'fde.not_active' });
        if (stageNumber !== e.currentStage) throw new AppError('conflict', `the engagement is at stage ${e.currentStage}`, { code: 'fde.not_current_stage' });
        if (stageNumber === 9) throw new AppError('conflict', 'stage 9 ends with the handover', { code: 'fde.handover_ends_stage_9' });
        const stage = await fdeStageRepo.latest(db, e.id, stageNumber);
        if (stage === undefined) throw new AppError('not_found', 'the stage has not begun', { code: 'fde.stage_unknown' });
        if (skip) {
          if (stageNumber !== 8) throw new AppError('validation', 'only stage 8 is skipped, where Scenarios are not used', { code: 'fde.not_skippable' });
          if (await fdeProposalRepo.pendingOfKinds(db, e.id, STAGES[8]!.kinds) > 0) {
            throw new AppError('conflict', 'decide or defer the proposed edges first', { code: 'fde.stage_has_pending' });
          }
        } else if (stage.status !== 'awaiting_confirmation') {
          throw new AppError('conflict', 'the stage\'s exit criteria are not all met', {
            code: 'fde.criteria_unmet', details: { unmet: (stage.exitCriteria as unknown as Evaluated[]).filter((c) => c.met !== true).map((c) => c.criterion).join(',') },
          });
        }
        const at = nowOf(deps).toISOString();
        const criteria = skip ? (stage.exitCriteria as unknown as Evaluated[]).map((c) => ({ ...c, met: null, skipped: true })) : stage.exitCriteria;
        await fdeStageRepo.update(db, stage.id, { status: 'passed', exitConfirmedBy: membershipId, exitedAt: at, exitCriteria: criteria as never });
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_stage_exit_confirmed', engagementId: e.id,
          actor: { membershipId }, resource: { type: 'fde_stage', id: stage.id }, detail: { stage: stageNumber, skipped: skip } });
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_stage_passed', engagementId: e.id,
          actor: { membershipId }, resource: { type: 'fde_stage', id: stage.id }, detail: { stage: stageNumber, attempt: stage.attempt } });
        const next = (await fdeEngagementRepo.update(db, e.id, { currentStage: stageNumber + 1 }))!;
        await enterStage(db, deps, next, stageNumber + 1, 1, ctx.correlationId);
        return { ...engagementView(next), stages: (await fdeStageRepo.listForEngagement(db, e.id)).map(stageView) };
      });
    },

    /** A failed stage, re-entered by a person once its cause is resolved: a new attempt (50.2). */
    async retry(ctx: Context, engagementId: string, stageNumber: number) {
      return inTransaction(pool, ctx.request, async (db) => {
        const e = await loadEngagement(db, engagementId);
        const stage = await fdeStageRepo.latest(db, e.id, stageNumber);
        if (e.status !== 'active' || stageNumber !== e.currentStage || stage?.status !== 'failed') {
          throw new AppError('conflict', 'only the current stage, failed, is tried again', { code: 'fde.not_failed' });
        }
        await enterStage(db, deps, e, stageNumber, stage.attempt + 1, ctx.correlationId);
        return { ...engagementView(e), stages: (await fdeStageRepo.listForEngagement(db, e.id)).map(stageView) };
      });
    },

    /** The stop condition at stage level (51.1): the stage names itself, the mechanism and the error, and stops. */
    async fail(e: FdeEngagement, stage: FdeStage, detail: { mechanism: string; subStage: string; errorSemantic: string; taskId: string }, correlationId: string) {
      await inTransaction(pool, { organisationId: e.organisationId }, async (db) => {
        await fdeStageRepo.update(db, stage.id, {
          status: 'failed', exitedAt: nowOf(deps).toISOString(),
          failureDetail: { mechanism: detail.mechanism, sub_stage: detail.subStage, error_semantic: detail.errorSemantic, task_id: detail.taskId } as never,
        });
        await recordEvent(db, { organisationId: e.organisationId, correlationId, event: 'fde_stage_failed', engagementId: e.id, actor: 'orchestrator',
          resource: { type: 'fde_stage', id: stage.id }, detail: { stage: stage.stageNumber, mechanism: detail.mechanism, error_semantic: detail.errorSemantic } });
      });
    },
  };
}

export type Stages = ReturnType<typeof createStages>;
export { stageView };
