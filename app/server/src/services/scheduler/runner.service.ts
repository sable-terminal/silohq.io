// One run of a Cron (spec 40.4 to 40.8), without anyone present.
//
// 1. Gate, with the Cron's row locked: a Cron that is not active does not run; an owner who
//    is no longer active pauses it (it never runs under a removed identity); a suspended
//    organisation pauses it and a cancelled one stops it (spec 75); a halted connection the
//    question reads pauses it and says so, because a condition run against a system that is
//    down produces a false negative. A run still in progress makes this one skip, never queue.
// 2. The question: the saved view's compiled plan, run by the executor as the Cron's service
//    principal, whose access is the intersection of the Cron's grant and its owner's now.
//    Runs are not metered (spec 40.7): the executor never charges.
// 3. The condition, over the answer and the state kept from the last run (conditions.service).
// 4. When it holds, the actions in order, each outcome recorded with counts, never values:
//    notify raises a Home item for the owner and the named members; report has render place
//    an export in Files as the principal; escalate raises it to a member or a scope until
//    acknowledged. A failed action does not stop the next.
// 5. The run's outcome, the state for the next run (a keyed hash and counts; the one figure
//    sealed under the organisation's data key), the connections the answer read, and the
//    failure policy: the owner is told of a failure, and the Cron pauses after the stated
//    number in a row.

import { proposeCronMutation } from '../../contracts/actions/mutation.contract.ts';
import { getCompiledPlan } from '../../contracts/compile/compile.contract.ts';
import { getManifest, getVersionManifest, type ObjectTypeView } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { hashForEntityGraph } from '../../contracts/credential/entityHash.contract.ts';
import { openRecordValues, sealRecordValues } from '../../contracts/credential/recordValue.contract.ts';
import { readResultPage, runObjectSet, runPlan, type QueryResult, type RunOutcome } from '../../contracts/executor/result.contract.ts';
import { raiseNotification } from '../../contracts/notify/notification.contract.ts';
import { renderExport } from '../../contracts/render/render.contract.ts';
import type { Figure, FailurePolicy } from '../../contracts/scheduler/cron.contract.ts';
import { inTransaction, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { Automation, AutomationAction } from '../../models/automation/index.model.ts';
import {
  automationActionRepo, automationConditionRepo, automationConnectionRepo, automationRepo, automationRunActionRepo, automationRunRepo,
  automationRunStateRepo,
} from '../../repos/automation/index.repo.ts';
import { connectionRepo } from '../../repos/connect/index.repo.ts';
import { membershipRepo, organisationRepo } from '../../repos/iam/index.repo.ts';
import { tenantMigrationRepo } from '../../repos/platform/tenantMigration.repo.ts';
import { savedViewRepo } from '../../repos/workspace/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { evaluate, figureKey, findingNodes, needsHash, type FigureState, type FindingFact, type Outcome, type PreviousState } from './conditions.service.ts';
import { listFindings } from '../../contracts/recognition/finding.contract.ts';
import { cronViewOf } from './crons.service.ts';
import { cronActor, recordEvent, schedulerActor, type SchedulerDeps } from './deps.service.ts';

export type Trigger = 'schedule' | 'change' | 'manual';
type SkipReason = 'overlap' | 'connection_halted' | 'owner_unavailable' | 'billing_suspended' | 'tenant_migration';
type PauseReason = 'connection_halted' | 'owner_removed' | 'billing_suspended' | 'repeated_failure';

export interface RunStarted {
  runId: string | null;
  skipped: string | null;
  /** Settles when the run is recorded: the sweep waits for it, a manual run does not. */
  done: Promise<void>;
}

const STATE_BINDING = (automationId: string) => ({ table: 'automation.automation_run_state', automation_id: automationId });

/** Runs the Cron once. Never throws for what the run meets: every outcome is recorded on the run. */
export async function runCron(deps: SchedulerDeps, organisationId: string, cronId: string, trigger: Trigger): Promise<RunStarted> {
  const correlationId = uuidv7();
  const control = deps.databases.pool('control');
  const gate = await inTransaction(control, { organisationId }, (db) => openRun(deps, db, organisationId, cronId, trigger, correlationId));
  if (gate.kind === 'skipped') {
    const done = gate.tell === undefined ? Promise.resolve() : tellOwner(deps, gate.automation, gate.runId, { paused: gate.tell }, correlationId);
    return { runId: gate.runId, skipped: gate.reason, done };
  }
  if (gate.kind === 'not_runnable') return { runId: null, skipped: gate.reason, done: Promise.resolve() };
  const done = execute(deps, gate.automation, gate.runId, gate.manifestId, correlationId).catch((error: unknown) => {
    deps.logger.failure('a Cron run failed outside its own handling', error, { event: 'scheduler.run_crashed', organisationId, resourceId: cronId });
  }).then(() => followUp(deps, organisationId, cronId)).catch((error: unknown) => {
    deps.logger.failure('a watching Cron\'s follow-up could not be set', error, { event: 'scheduler.follow_up_failed', organisationId, resourceId: cronId });
  });
  return { runId: gate.runId, skipped: null, done };
}

/** Changes that arrived during a watching Cron's run (40.2): one follow-up, a window after it ends. */
async function followUp(deps: SchedulerDeps, organisationId: string, cronId: string): Promise<void> {
  await inTransaction(deps.databases.pool('control'), { organisationId }, async (db) => {
    const row = await automationRepo.findForUpdate(db, cronId);
    if (!row || row.watch === null || row.status !== 'active' || row.deletedAt !== null) return;
    const state = await automationRunStateRepo.findByKey(db, { organisationId, automationId: cronId });
    if (state?.followUpPending !== true) return;
    await automationRunStateRepo.update(db, { organisationId, automationId: cronId }, { followUpPending: false });
    const due = deps.now() + (row.watch as { windowSeconds: number }).windowSeconds * 1000;
    if (row.nextRunAt === null || Date.parse(row.nextRunAt) > due) await automationRepo.update(db, cronId, { nextRunAt: new Date(due).toISOString() });
  });
}

type Gate =
  | { kind: 'run'; automation: Automation; runId: string; manifestId: string }
  | { kind: 'skipped'; automation: Automation; runId: string; reason: SkipReason; tell?: PauseReason }
  | { kind: 'not_runnable'; reason: string };

async function openRun(deps: SchedulerDeps, db: Queryable, organisationId: string, cronId: string, trigger: Trigger,
  correlationId: string): Promise<Gate> {
  const automation = await automationRepo.findForUpdate(db, cronId);
  if (!automation || automation.deletedAt !== null) return { kind: 'not_runnable', reason: 'not_found' };
  if (automation.status !== 'active') return { kind: 'not_runnable', reason: automation.status };
  const at = new Date(deps.now()).toISOString();
  const actor = cronActor(automation.servicePrincipalId);
  const resource = { type: 'automation', id: cronId };

  const skip = async (reason: SkipReason, pause?: { reason: PauseReason; event?: 'automation_paused_on_halt' | 'automation_paused_on_owner_removal'; stop?: boolean }) => {
    const runId = uuidv7();
    await automationRunRepo.insert(db, {
      id: runId, organisationId, automationId: cronId, triggerKind: trigger, status: 'skipped', startedAt: at, completedAt: at, skippedReason: reason,
    });
    await recordEvent(db, organisationId, correlationId, { event: 'automation_run_skipped', actor, resource, detail: { reason, run_id: runId } });
    if (pause !== undefined) {
      await automationRepo.update(db, cronId, pause.stop === true
        ? { status: 'stopped', nextRunAt: null, leaseExpiresAt: null, version: automation.version + 1 }
        : { status: 'paused', pausedReason: pause.reason, pausedAt: at, leaseExpiresAt: null, version: automation.version + 1 });
      await recordEvent(db, organisationId, correlationId, {
        event: pause.event ?? 'automation_paused', actor: schedulerActor, resource, subjectMembershipId: automation.ownerMembershipId,
        detail: { reason: pause.stop === true ? 'billing_cancelled' : pause.reason },
      });
    }
    return { kind: 'skipped' as const, automation, runId, reason, ...(pause !== undefined && pause.reason !== 'owner_removed' ? { tell: pause.reason } : {}) };
  };

  if ((await membershipRepo.findById(db, automation.ownerMembershipId))?.status !== 'active') {
    return skip('owner_unavailable', { reason: 'owner_removed', event: 'automation_paused_on_owner_removal' });
  }
  const billing = (await organisationRepo.findById(db, organisationId))?.billingStatus;
  if (billing === 'suspended') return skip('billing_suspended', { reason: 'billing_suspended' });
  if (billing === 'cancelled') return skip('billing_suspended', { reason: 'billing_suspended', stop: true });
  // Spec 6.4: Crons pause while the organisation moves cell; each firing is skipped, not queued.
  if (await tenantMigrationRepo.writesPaused(db, organisationId)) return skip('tenant_migration');
  for (const connectionId of await automationConnectionRepo.listFor(db, cronId)) {
    const status = (await connectionRepo.findById(db, connectionId))?.status;
    if (status === 'halted' || status === 'revoked') return skip('connection_halted', { reason: 'connection_halted', event: 'automation_paused_on_halt' });
  }
  if ((await automationRunRepo.history(db, cronId, 1))[0]?.status === 'running') return skip('overlap');
  const view = automation.savedViewId === null ? undefined : await savedViewRepo.findById(db, automation.savedViewId);

  const runId = uuidv7();
  await automationRunRepo.insert(db, { id: runId, organisationId, automationId: cronId, triggerKind: trigger, status: 'running', startedAt: at });
  await automationRepo.update(db, cronId, { lastRunAt: at, leaseExpiresAt: null });
  await recordEvent(db, organisationId, correlationId, { event: 'automation_run_started', actor, resource, detail: { run_id: runId, trigger } });
  if (view === undefined || view.manifestId === null || view.archivedAt !== null) {
    // The question is gone: a failure the owner is told of, not a silent skip.
    return { kind: 'run', automation, runId, manifestId: '' };
  }
  return { kind: 'run', automation, runId, manifestId: view.manifestId };
}

// ----------------------------------------------------------------------------- the run

interface Answered { result: QueryResult; rows: unknown[] }

async function execute(deps: SchedulerDeps, automation: Automation, runId: string, manifestId: string, correlationId: string): Promise<void> {
  try {
    await executeRun(deps, automation, runId, manifestId, correlationId);
  } catch (error) {
    // Whatever went wrong after the run started, the run says so: never left running.
    const failures = await inTransaction(deps.databases.pool('control'), { organisationId: automation.organisationId }, async (db) =>
      (await automationRunStateRepo.findByKey(db, { organisationId: automation.organisationId, automationId: automation.id }))?.consecutiveFailures ?? 0,
    { readOnly: true }).catch(() => 0);
    await finishFailed(deps, automation, runId, [], failures, codeOf(error), correlationId);
  }
}

async function executeRun(deps: SchedulerDeps, automation: Automation, runId: string, manifestId: string, correlationId: string): Promise<void> {
  const organisationId = automation.organisationId;
  const request: RequestContext = { organisationId, servicePrincipalId: automation.servicePrincipalId };
  const options = { request, correlationId };
  const control = deps.databases.pool('control');
  const { conditions, actions, state } = await inTransaction(control, request, async (db) => ({
    conditions: (await cronViewOf(db, automation)).condition,
    actions: await automationActionRepo.listFor(db, automation.id),
    state: await automationRunStateRepo.findByKey(db, { organisationId, automationId: automation.id }),
  }), { readOnly: true });

  // A finding-only Cron (spec 40.3) has no question: its condition reads the findings alone.
  const findingOnly = automation.savedViewId === null && automation.objectSetId === null;
  let answered: Answered | undefined;
  let planId = manifestId;
  /** The type the subject returns, for a mutate action. */
  let root: () => Promise<ObjectTypeView | undefined> = async () => undefined;
  if (!findingOnly) try {
    let out: RunOutcome;
    if (automation.objectSetId !== null) {
      // An object set (watched, or on a schedule): re-evaluated now, under the Cron's own access.
      const set = await deps.services.call(getObjectSet, { params: { objectSetId: automation.objectSetId } }, options);
      const manifest = await deps.services.call(getManifest, { query: {} }, options);
      const type = manifest.objectTypes.find((t) => t.id === set.baseTypeId);
      root = async () => type;
      const watched = (automation.watch as { properties?: string[] } | null)?.properties ?? [];
      const select = [...new Set([...(type?.primaryKeyPropertyIdentityId ? [type.primaryKeyPropertyIdentityId] : []), ...watched])];
      out = await deps.services.call(runObjectSet, { body: { objectSetId: automation.objectSetId, select, trigger: 'cron_run', useCache: false } }, options);
    } else {
      if (manifestId === '') throw failure('scheduler.view_unavailable');
      const stored = await deps.services.call(getCompiledPlan, { params: { planId: manifestId } }, options);
      planId = stored.planId;
      root = async () => (await deps.services.call(getVersionManifest, { params: { versionId: stored.ontologyVersionId } }, options))
        .objectTypes.find((t) => t.id === stored.plan.nodes[0]?.objectTypeId);
      out = await deps.services.call(runPlan, { body: { plan: stored.plan, planId: stored.planId, trigger: 'cron_run', useCache: false, references: true } }, options);
    }
    if (out.outcome === 'refusal') throw failure(`refused.${out.refusal.code}`.slice(0, 120));
    answered = { result: out.result, rows: needsHash(conditions) ? await allRows(deps, out.result, options) : [] };
  } catch (error) {
    await finishFailed(deps, automation, runId, actions, state?.consecutiveFailures ?? 0, codeOf(error), correlationId);
    return;
  }

  // The condition, over the state kept from the last run.
  const previous = await previousState(deps, automation, state, options);
  const resultHash = needsHash(conditions) && answered !== undefined ? await keyedHash(deps, answered, options) : undefined;
  // Finding conditions (40.3): the findings, read as the Cron with no Lens, so one silenced in the owner's Lens still counts.
  const findingsCheckedAt = new Date(deps.now()).toISOString();
  const findings = new Map<string, FindingFact[] | undefined>();
  for (const node of findingNodes(conditions)) {
    const target = node.target as { detectorId: string; objectTypeId: string };
    try {
      const out = await deps.services.call(listFindings, {
        query: { objectTypeId: target.objectTypeId, detectorId: target.detectorId, includeSuperseded: 'true', limit: 500 },
      }, options);
      findings.set(node.id, out.findings.map((f) => ({ objectIds: f.objectIds, score: f.score, raisedAt: f.raisedAt, supersededAt: f.supersededAt })));
    } catch {
      findings.set(node.id, undefined);
    }
  }
  const evaluation = evaluate(conditions, {
    total: answered?.result.total ?? 0, resultHash, figure: (f) => (answered === undefined ? undefined : figureOf(answered.result, f)),
    findings: (node) => findings.get(node.id),
  }, previous, deps.now());
  // What a finding-only Cron's notification counts: the findings raised since the last check.
  const since = previous.findingsSince === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous.findingsSince);
  const freshFindings = [...findings.values()].flatMap((f) => f ?? []).filter((f) => Date.parse(f.raisedAt) > since).length;

  const taken: { kind: string; outcome: string }[] = [];
  if (evaluation.outcome === 'met') {
    // A failed action stops later mutate actions, never later notifications (40.4).
    let failed = false;
    for (const action of actions) {
      if (failed && action.kind === 'mutate') {
        await inTransaction(control, { organisationId }, (db) => automationRunActionRepo.insert(db, {
          id: uuidv7(), organisationId, runId, actionId: action.id, actionKind: 'mutate', sequence: action.sequence, outcome: 'skipped',
          error: 'scheduler.earlier_action_failed',
        }));
        taken.push({ kind: 'mutate', outcome: 'skipped' });
        continue;
      }
      const outcome = await act(deps, automation, runId, action, answered?.result, planId, correlationId, root, freshFindings);
      if (outcome.outcome === 'failed') failed = true;
      taken.push(outcome);
    }
  } else if (evaluation.outcome === 'indeterminate') {
    // An undecided figure is told to the owner (spec 40.3), through the Cron's notify action.
    await tellOwner(deps, automation, runId, { indeterminate: 1 }, correlationId);
  }

  const sealedValue = Object.keys(evaluation.next.figures).length === 0 ? null
    : await sealFigures(deps, automation.id, evaluation.next.figures, options);
  const readConnections = [...new Set((answered?.result.lineage ?? []).flatMap((l) => l.sources.map((s) => s.connectionId)))];
  await inTransaction(control, { organisationId }, async (db) => {
    const at = new Date(deps.now()).toISOString();
    await automationRunRepo.update(db, runId, { status: 'completed', completedAt: at, conditionOutcome: evaluation.outcome });
    await automationRunStateRepo.update(db, { organisationId, automationId: automation.id }, {
      previousResultHash: evaluation.next.resultHash === undefined ? null : Buffer.from(evaluation.next.resultHash, 'hex'),
      previousRowCount: String(evaluation.next.rowCount), previousValue: sealedValue, consecutiveFailures: 0,
      ...(findings.size === 0 ? {} : { findingsCheckedAt }),
    });
    if (readConnections.length > 0) await automationConnectionRepo.replaceFor(db, organisationId, automation.id, readConnections);
    const resource = { type: 'automation', id: automation.id };
    const actor = cronActor(automation.servicePrincipalId);
    const conditionEvent = evaluation.outcome === 'met' ? 'automation_condition_met'
      : evaluation.outcome === 'not_met' ? 'automation_condition_not_met' : 'automation_run_condition_indeterminate';
    await recordEvent(db, organisationId, correlationId, {
      event: conditionEvent, actor, resource, detail: { run_id: runId, rows: answered?.result.total ?? 0, ...(findingOnly ? { findings: freshFindings } : {}) },
    });
    for (const t of taken) {
      await recordEvent(db, organisationId, correlationId, { event: 'automation_action_taken', actor, resource, detail: { run_id: runId, kind: t.kind, outcome: t.outcome } });
    }
    await recordEvent(db, organisationId, correlationId, {
      event: 'automation_run_completed', actor, resource, detail: { run_id: runId, outcome: evaluation.outcome, actions: taken.length },
    });
  });
}

const failure = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });

function codeOf(error: unknown): string {
  if (isAppError(error)) return error.code;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'scheduler.run_failed';
}

async function finishFailed(deps: SchedulerDeps, automation: Automation, runId: string, actions: readonly AutomationAction[],
  failuresBefore: number, code: string, correlationId: string): Promise<void> {
  const organisationId = automation.organisationId;
  const failures = failuresBefore + 1;
  const policy = automation.failurePolicy as FailurePolicy;
  const pause = policy.mode === 'pause_after' && failures >= policy.failures;
  await inTransaction(deps.databases.pool('control'), { organisationId }, async (db) => {
    const at = new Date(deps.now()).toISOString();
    // A redacted code, never a message: an error from a source may carry a value.
    await automationRunRepo.update(db, runId, { status: 'failed', completedAt: at, error: code.slice(0, 200) });
    await automationRunStateRepo.update(db, { organisationId, automationId: automation.id }, { consecutiveFailures: failures });
    const resource = { type: 'automation', id: automation.id };
    await recordEvent(db, organisationId, correlationId, {
      event: 'automation_run_failed', actor: cronActor(automation.servicePrincipalId), resource, detail: { run_id: runId, code: code.slice(0, 120), failures },
    });
    if (pause) {
      const row = (await automationRepo.findForUpdate(db, automation.id))!;
      if (row.status === 'active') {
        await automationRepo.update(db, automation.id, { status: 'paused', pausedReason: 'repeated_failure', pausedAt: at, version: row.version + 1 });
        await recordEvent(db, organisationId, correlationId, {
          event: 'automation_paused', actor: schedulerActor, resource, subjectMembershipId: automation.ownerMembershipId,
          detail: { reason: 'repeated_failure', failures },
        });
      }
    }
  });
  void actions;
  await tellOwner(deps, automation, runId, pause ? { failed: 1, paused: 'repeated_failure' } : { failed: 1 }, correlationId);
}

// ----------------------------------------------------------------------------- the answer

/** Every page of the answer, for its hash: bounded by the executor's result bound. */
async function allRows(deps: SchedulerDeps, result: QueryResult, options: { request: RequestContext; correlationId: string }): Promise<unknown[]> {
  const rows: unknown[] = result.kind === 'groups' ? [...result.page.groups] : [...result.page.objects];
  for (let index = 1; rows.length < result.total && result.page.count > 0; index += 1) {
    const page = await deps.services.call(readResultPage, { params: { queryId: result.queryId, page: index } }, options);
    const items = result.kind === 'groups' ? page.groups : page.objects;
    if (items.length === 0) break;
    rows.push(...items);
  }
  return rows;
}

/** A keyed hash of the whole answer (spec 40.3): the digest is keyed by the organisation's key, so it reveals nothing alone. */
async function keyedHash(deps: SchedulerDeps, answered: Answered, options: { request: RequestContext; correlationId: string }): Promise<string> {
  const digest = sha256(canonicalJsonBytes({
    kind: answered.result.kind, columns: answered.result.columns.map((c) => c.apiName), total: answered.result.total, rows: answered.rows,
  } as never)).toString('hex');
  const out = await deps.services.call(hashForEntityGraph, { body: { purpose: 'cron_result', values: [digest] } }, options);
  return out.hashes[0]!;
}

/** One figure, or undefined when the answer leaves it undecided (spec 40.3). */
function figureOf(result: QueryResult, f: Figure): number | undefined {
  if ('measure' in f) {
    if (result.kind !== 'groups' || result.page.groups.length !== 1) return undefined;
    const group = result.page.groups[0]!;
    const value = group.measures[f.measure];
    if (value === undefined || value === null || (group.excluded[f.measure] ?? 0) > 0) return undefined;
    return value;
  }
  if (result.kind !== 'objects' || result.total !== 1 || result.page.objects.length !== 1) return undefined;
  const object = result.page.objects[0]!;
  if ([...object.disputed, ...object.masked, ...object.redacted].includes(f.property)) return undefined;
  const value = object.values[f.property];
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

async function previousState(deps: SchedulerDeps, automation: Automation,
  state: { previousResultHash: Buffer | null; previousRowCount: string | null; previousValue: Buffer | null; findingsCheckedAt: string | null } | undefined,
  options: { request: RequestContext; correlationId: string }): Promise<PreviousState> {
  let figures: Record<string, FigureState> = {};
  if (state?.previousValue) {
    const opened = await deps.services.call(openRecordValues, {
      body: { items: [{ binding: STATE_BINDING(automation.id), sealed: state.previousValue.toString('base64') }] },
    }, options);
    figures = JSON.parse(Buffer.from(opened.items[0]!, 'base64').toString('utf8')) as Record<string, FigureState>;
  }
  return {
    resultHash: state?.previousResultHash ? state.previousResultHash.toString('hex') : null,
    rowCount: state?.previousRowCount === null || state?.previousRowCount === undefined ? null : Number(state.previousRowCount),
    figures,
    // Before the first check, findings count from the Cron's creation.
    findingsSince: state?.findingsCheckedAt ?? automation.createdAt,
  };
}

/** The figures kept between runs are record values: sealed under the organisation's data key (design D11). */
async function sealFigures(deps: SchedulerDeps, automationId: string, figures: Record<string, FigureState>,
  options: { request: RequestContext; correlationId: string }): Promise<Buffer> {
  const value = Buffer.from(JSON.stringify(figures), 'utf8').toString('base64');
  const sealed = await deps.services.call(sealRecordValues, { body: { items: [{ binding: STATE_BINDING(automationId), value }] } }, options);
  return Buffer.from(sealed.items[0]!, 'base64');
}

// ----------------------------------------------------------------------------- actions

async function act(deps: SchedulerDeps, automation: Automation, runId: string, action: AutomationAction, result: QueryResult | undefined, planId: string,
  correlationId: string, root: () => Promise<ObjectTypeView | undefined> = async () => undefined, findingCount = 0): Promise<{ kind: string; outcome: string }> {
  /** Counts only (40.4): the answer's rows, or for a finding-only Cron the findings it was told of. */
  const counted: Record<string, number> = result === undefined ? { findings: findingCount } : { rows: result.total };
  const organisationId = automation.organisationId;
  const request: RequestContext = { organisationId, servicePrincipalId: automation.servicePrincipalId };
  const control = deps.databases.pool('control');
  const record = (row: {
    outcome: 'delivered' | 'succeeded' | 'failed' | 'proposed' | 'executed' | 'skipped'; resultCounts?: Record<string, number>; fileId?: string | null;
    mutationId?: string | null; error?: string | null;
  }) =>
    inTransaction(control, { organisationId }, (db) => automationRunActionRepo.insert(db, {
      id: uuidv7(), organisationId, runId, actionId: action.id, actionKind: action.kind, sequence: action.sequence, outcome: row.outcome,
      resultCounts: row.resultCounts ?? null, fileId: row.fileId ?? null, mutationId: row.mutationId ?? null, error: row.error ?? null,
      escalatedMembershipId: action.escalateMembershipId, escalatedScopeId: action.escalateScopeId,
    }));

  if (action.kind === 'notify') {
    const recipients = [automation.ownerMembershipId, ...((action.configuration as { recipients?: string[] }).recipients ?? [])];
    const unique = [...new Set(recipients)];
    const row = await record({ outcome: 'delivered', resultCounts: { ...counted, recipients: unique.length } });
    const failed = await raiseAll(deps, request, correlationId, unique, 'cron_notify', row.id);
    return { kind: 'notify', outcome: failed === 0 ? 'delivered' : 'partly_delivered' };
  }
  if (action.kind === 'escalate') {
    const row = await record({ outcome: 'delivered', resultCounts: counted });
    // A scope's escalation stays on Governance for its members; a member's also reaches their Home, to acknowledge by its window.
    const hours = (action.configuration as { acknowledgeWithinHours?: number }).acknowledgeWithinHours ?? 72;
    if (action.escalateMembershipId !== null) {
      await raiseAll(deps, request, correlationId, [action.escalateMembershipId], 'cron_escalate', row.id,
        new Date(deps.now() + hours * 3_600_000).toISOString());
    }
    return { kind: 'escalate', outcome: 'delivered' };
  }
  // A report or a mutation acts on a question's answer; a finding-only Cron has none (refused at creation).
  if ((action.kind === 'report' || action.kind === 'mutate') && result === undefined) {
    await record({ outcome: 'failed', error: 'scheduler.finding_only_actions' });
    return { kind: action.kind, outcome: 'failed' };
  }
  if (action.kind === 'report') {
    const configuration = action.configuration as { format?: 'csv' | 'xlsx' | 'pdf'; folderId?: string | null };
    try {
      const out = await deps.services.call(renderExport, {
        body: {
          planId, format: configuration.format ?? 'csv', name: `${automation.name} ${new Date(deps.now()).toISOString().slice(0, 16).replace('T', ' ')}`,
          source: { kind: 'cron_report', automationRunId: runId }, ...(configuration.folderId ? { folderId: configuration.folderId } : {}),
        },
      }, { request, correlationId, idempotencyKey: `${runId}.${action.sequence}`, timeoutMs: 120_000 });
      if (out.outcome === 'refused') {
        await record({ outcome: 'failed', error: out.code.slice(0, 200) });
        return { kind: 'report', outcome: 'failed' };
      }
      await record({ outcome: 'succeeded', fileId: out.file.id, resultCounts: { rows: out.rows } });
      return { kind: 'report', outcome: 'succeeded' };
    } catch (error) {
      await record({ outcome: 'failed', error: codeOf(error).slice(0, 200) });
      return { kind: 'report', outcome: 'failed' };
    }
  }
  if (action.kind === 'mutate') return mutate(deps, automation, runId, action, result!, root, correlationId, record);
  return { kind: action.kind, outcome: 'skipped' };
}

/**
 * A mutate action (40.5): the Action type over the objects the question returned, named by
 * their key, proposed by the Cron's principal under its authorisation. In execute mode the
 * actions service runs it at once where it is within every bound; otherwise it waits in the
 * approvals queue. The run records the mutation, never its values.
 */
async function mutate(deps: SchedulerDeps, automation: Automation, runId: string, action: AutomationAction, result: QueryResult,
  root: () => Promise<ObjectTypeView | undefined>,
  correlationId: string, record: (row: { outcome: 'proposed' | 'executed' | 'failed' | 'succeeded'; resultCounts?: Record<string, number>; mutationId?: string | null; error?: string | null }) => Promise<unknown>)
  : Promise<{ kind: string; outcome: string }> {
  const organisationId = automation.organisationId;
  const options = { request: { organisationId, servicePrincipalId: automation.servicePrincipalId }, correlationId };
  const failed = async (error: string) => {
    await record({ outcome: 'failed', error: error.slice(0, 200), resultCounts: { rows: result.total } });
    return { kind: 'mutate', outcome: 'failed' };
  };
  try {
    if (result.kind !== 'objects') return await failed('scheduler.mutate_needs_objects');
    // Every object of the answer, or none: a Cron never acts on part of what its question found.
    if (result.total > result.page.objects.length) return await failed('scheduler.mutate_partial_result');
    if (result.page.objects.length === 0) {
      await record({ outcome: 'succeeded', resultCounts: { rows: 0 } });
      return { kind: 'mutate', outcome: 'succeeded' };
    }
    const type = await root();
    if (type === undefined) return await failed('scheduler.mutate_type_unknown');
    // Each object's records, as the answer named them (single-source: its one; resolvable: one per
    // system holding it). actions writes those in the systems the Action type may write through.
    const references = result.page.objects.flatMap((o) => (o.records ?? []).map((r) => ({ connectionId: r.connectionId, reference: r.reference })));
    if (result.page.objects.some((o) => (o.records ?? []).length === 0)) return await failed('scheduler.mutate_records_unknown');
    const seen = new Set<string>();
    const objects = references.filter((r) => { const k = `${r.connectionId} ${r.reference}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const out = await deps.services.call(proposeCronMutation, { body: { automationId: automation.id, actionId: action.id, objects } }, options);
    if (out.status === 'refused') return await failed('scheduler.mutate_refused');
    const executed = out.cronMode === 'execute_within_bounds';
    await record({ outcome: executed ? 'executed' : 'proposed', mutationId: out.mutationId, resultCounts: { rows: result.page.objects.length, records: objects.length } });
    await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => recordEvent(db, organisationId, correlationId, {
      event: executed ? 'automation_executed_mutation' : 'automation_proposed_mutation', actor: cronActor(automation.servicePrincipalId),
      resource: { type: 'automation', id: automation.id }, detail: { run_id: runId, mutation_id: out.mutationId, rows: objects.length },
    }));
    return { kind: 'mutate', outcome: executed ? 'executed' : 'proposed' };
  } catch (error) {
    return failed(codeOf(error));
  }
}

/** Raises one item per recipient; idempotent in notify, so retried. Returns how many could not be raised. */
async function raiseAll(deps: SchedulerDeps, request: RequestContext, correlationId: string, recipients: readonly string[],
  kind: 'cron_notify' | 'cron_escalate', automationRunActionId: string, acknowledgeDueAt?: string): Promise<number> {
  let failed = 0;
  for (const recipientMembershipId of recipients) {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
      try {
        await deps.services.call(raiseNotification, {
          body: { recipientMembershipId, kind, source: { automationRunActionId }, ...(acknowledgeDueAt === undefined ? {} : { acknowledgeDueAt }) },
        }, { request, correlationId });
        done = true;
      } catch (error) {
        if (attempt === 2) {
          failed += 1;
          deps.logger.failure('a Cron notification could not be raised', error, { event: 'scheduler.notify_failed', organisationId: request.organisationId!, resourceId: automationRunActionId });
        }
      }
    }
  }
  return failed;
}

/**
 * Tells the owner what the run met (a failure, a pause, an undecided figure) through the
 * Cron's first notify action: counts only. A Cron with no notify action shows it in its
 * run history and on Governance alone.
 */
async function tellOwner(deps: SchedulerDeps, automation: Automation, runId: string, counts: Record<string, number | string>,
  correlationId: string): Promise<void> {
  const organisationId = automation.organisationId;
  const control = deps.databases.pool('control');
  const notify = (await inTransaction(control, { organisationId }, (db) => automationActionRepo.listFor(db, automation.id), { readOnly: true }))
    .find((a) => a.kind === 'notify');
  if (notify === undefined) return;
  const resultCounts = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, typeof v === 'number' ? v : 1]));
  const row = await inTransaction(control, { organisationId }, (db) => automationRunActionRepo.insert(db, {
    id: uuidv7(), organisationId, runId, actionId: notify.id, actionKind: 'notify', sequence: notify.sequence, outcome: 'delivered',
    resultCounts: { ...resultCounts, owner_only: 1 }, fileId: null, error: null, escalatedMembershipId: null, escalatedScopeId: null,
  })).catch(() => undefined);
  if (row === undefined) return;
  await raiseAll(deps, { organisationId, servicePrincipalId: automation.servicePrincipalId }, correlationId, [automation.ownerMembershipId], 'cron_notify', row.id);
}

export type { Outcome };
export { automationConditionRepo };
