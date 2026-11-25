// Execution, verification, receipt and history (spec 45, 46.1, 46.2).
//
// Who executes (45.1): where execution is not separated, approval executes: the approvals
// service calls this as the final approver. Where it is, a holder of mutation.execute who is
// not the proposer does. The database refuses an execution without a satisfied, unexpired
// chain for the stored diff, and a separated executor who is the proposer.
//
// Then, answered at once, in this process:
// 1. every update and delete target is re-read; one changed since its prior state was read
//    is stale, and the mutation is refused at execute rather than write over the change
//    (44.7); proposing again reads afresh;
// 2. per connection, in plan order, through connect-runtime: SQL as one transaction, REST
//    operation by operation; not atomic across connections, and the receipt says exactly
//    what happened on each (45.2);
// 3. every applied record is read back and compared per field: verified, diverged (the
//    observed value stored beside the intended), or failed ("not observed"); a delete is
//    verified by absence; a create captures its identifier (45.6);
// 4. one transaction: the verifications, the executions' outcomes, the mutation's terminal
//    status, the receipt (canonical JSON, hashed, sealed; the hash in the audit ledger), a
//    commit on every object touched (its parent the object's head, serialised by the head's
//    row lock), and the events.
// A revert's conflict decisions are applied here: keep_current drops a field, exclude_record
// drops a record (46.3).
//
// The canary (43.9, 45.4): at 10,000 rows or more a sample (100 by default, across every
// connection) is written and verified first, and the mutation waits in canary. The executor,
// or the final approver where execution is not separated, confirms the remainder after
// seeing every diverged or failed sample record; the receipt then covers both. A canary not
// confirmed before the chain expires finishes as expired with a receipt for its sample alone,
// which is not reverted automatically: a governed revert is offered, as for partial failure.
//
// An execution whose process died is recovered, not run again (45.3: nothing is retried
// blindly): each target is read back, and what landed is recorded as applied (verified or
// diverged), what did not as not applied, and a create whose identifier was never returned
// as failed. A canary's sample then waits for confirmation as usual; anything else finishes
// with its receipt, and what was not written can be proposed again.
//
// Side effects (42.6) fire after verification of every connection, once, only where a write
// landed: a notification to the people the Action type names, with the receipt as its
// content. A failure never changes the write's outcome; the receipt and the audit log say
// what fired.
//
// A webhook side effect is queued here for notify to deliver, signed, with retries (20.4): the
// receipt records it queued, a delivery and not an effect. Not built yet: updating the state
// plane from read-back values.

import { seededUniform } from '../../utils/bayes.util.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { followsRecreation, isNewIdentifier, type NotRepointed } from './repoint.service.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import { ledgerCopyRepo, webhookDeliveryRepo } from '../../repos/action/index.repo.ts';
import { webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import type { Preview } from '../../contracts/actions/mutation.contract.ts';
import type { ServiceName } from '../../config/service.config.ts';
import { EVENT_OBJECTS_MAX } from '../../contracts/actions/actionEvent.contract.ts';
import { prepareWrites, readRecords, writeRecords, type WriteResult } from '../../contracts/connect-runtime/write.contract.ts';
import type { SignedExecutionGrant } from '../../contracts/actions/grant.contract.ts';
import { raiseNotification } from '../../contracts/notify/notification.contract.ts';
import { writeCaptureLedger } from '../../contracts/siloes/captureLedger.contract.ts';
import { writeActionLedger } from '../../contracts/warehouse/warehouse.contract.ts';
import { siloRepo } from '../../repos/siloes/index.repo.ts';
import { retry } from '../../utils/retry.util.ts';
import { uuidv5 } from '../../utils/siloObjectId.util.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { tenantMigrationRepo } from '../../repos/platform/tenantMigration.repo.ts';
import { writeLineage } from '../lineage/writer.service.ts';
import type { MutationTarget } from '../../models/action/mutationTarget.model.ts';
import {
  actionCommitRepo, actionTypeRepo, idRemappingRepo, actionTypeVersionRepo, approvalChainRepo, approvalStepRepo, mutationExecutionRepo, mutationRepo, mutationVerificationRepo,
  objectHeadRepo, receiptRepo, revertConflictRepo, revertRepo,
} from '../../repos/action/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { callOptions, CANARY, demand, memberOf, openValues, sealValues, type Context, type WriteBackDeps } from './deps.service.ts';
import { recordActionEvent, recordActionExecuted, recordMutationStage } from './events.service.ts';
import {
  bindings, loadMutation, mutationView, objectIdentity, openManifestValues, openPreview, openPriorStates,
} from './store.service.ts';
import { permittedOperationsOf } from './genericEdit.service.ts';
import { COMMAND_ACKNOWLEDGEMENT, logPhysicalWrites, queuePhysicalWebhook, recordPhysicalExecuted } from './physical.service.ts';

/** The default receipt retention (spec 46: an open decision, stated at enable time): two years. */
export const RECEIPT_RETENTION_DAYS = 730;

const same = (a: unknown, b: unknown): boolean => canonicalJsonBytes({ v: a ?? null }).equals(canonicalJsonBytes({ v: b ?? null }));

type TargetOutcome = 'verified' | 'diverged' | 'failed' | 'not_applied';

interface VerificationRow {
  id: string;
  executionId: string;
  target: MutationTarget;
  entityReference: string;
  field: string | null;
  intended: unknown;
  observed: unknown;
  outcome: 'verified' | 'diverged' | 'failed';
  reason: string | null;
}

interface PhaseResult {
  verifications: VerificationRow[];
  outcomes: Map<string, TargetOutcome>;
  assigned: Map<string, string>;
  executionUpdates: { id: string; status: 'succeeded' | 'partially_succeeded' | 'failed'; attempted: number; applied: number; error: string | null }[];
  skipped: number;
  decidedAway: Set<string>;
  connections: number;
}

export function createExecution(deps: WriteBackDeps) {
  const control = deps.databases.pool('control');
  const running = new Set<Promise<void>>();
  /** Mutations this process is executing now: never recovered from under it. */
  const active = new Set<string>();
  const track = (mutationId: string, work: Promise<void>, ctx: Context, organisationId: string): void => {
    active.add(mutationId);
    const job = work.catch(async (error: unknown) => {
      deps.logger.failure('an execution failed unexpectedly', error, { event: 'action.execution_failed', resourceType: 'mutation', resourceId: mutationId });
      await failUnexpectedly(ctx, mutationId, organisationId);
    }).finally(() => {
      running.delete(job);
      active.delete(mutationId);
    });
    running.add(job);
  };

  async function finishStale(ctx: Context, mutationId: string, organisationId: string, stale: number): Promise<void> {
    await inTransaction(control, ctx.request, async (db) => {
      const now = new Date().toISOString();
      for (const e of await mutationExecutionRepo.listByMutation(db, mutationId)) {
        if (e.completedAt === null) await mutationExecutionRepo.update(db, e.id, { status: 'failed', error: 'stale_target', completedAt: now });
      }
      await mutationRepo.update(db, mutationId, {
        status: 'refused', refusedStage: 'execute', refusalReason: `${stale} record(s) changed since the preview; propose again to read them afresh`, completedAt: now,
      });
      const event = { organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions' as const, resource: { type: 'mutation' as const, id: mutationId } };
      await recordActionEvent(db, { ...event, event: 'execution_stale_target', detail: { stale } });
      await recordActionEvent(db, { ...event, event: 'mutation_refused', detail: { stage: 'execute', reason: 'stale_target' } });
      await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId, stage: 'refused', rowCount: 0 });
    });
  }

  async function failUnexpectedly(ctx: Context, mutationId: string, organisationId: string): Promise<void> {
    await inTransaction(control, ctx.request, async (db) => {
      const mutation = await mutationRepo.findById(db, mutationId);
      if (mutation?.status !== 'executing') return;
      const now = new Date().toISOString();
      for (const e of await mutationExecutionRepo.listByMutation(db, mutationId)) {
        if (e.completedAt === null) await mutationExecutionRepo.update(db, e.id, { status: 'failed', error: 'upstream', completedAt: now });
      }
      await mutationRepo.update(db, mutationId, { status: 'failed', completedAt: now });
      await recordActionEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'mutation_failed', request: ctx.request, service: 'actions',
        resource: { type: 'mutation', id: mutationId }, detail: { reason: 'execution_interrupted' },
      });
      await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId, stage: 'failed', rowCount: mutation.rowCount });
    }).catch((error: unknown) => deps.logger.failure('a failed execution could not be recorded', error, { event: 'action.execution_unrecorded', resourceType: 'mutation', resourceId: mutationId }));
  }

  /** Everything an execution phase and its finish read about the mutation. */
  async function load(ctx: Context, mutationId: string) {
    const { mutation, targets: all, priorStates } = await inTransaction(control, ctx.request, (db) => loadMutation(db, mutationId), { readOnly: true });
    const organisationId = mutation.organisationId;
    const targets = all.filter((t) => !t.excluded);
    const prior = await openPriorStates(deps, ctx, priorStates);
    const values = await openManifestValues(deps, ctx, mutation);
    const newValues = (values['newValues'] ?? {}) as Record<string, Record<string, unknown>>;
    const preview = await openPreview(deps, ctx, mutation);
    const version = (await inTransaction(control, ctx.request, (db) => actionTypeVersionRepo.findById(db, mutation.actionTypeVersionId), { readOnly: true }))!;
    // A generic edit's operations are its own definition's, kept in its manifest (42.9).
    const operations = permittedOperationsOf(mutation, version);
    const sourceObjectOf = (connectionId: string): string => operations[connectionId]!.sourceObject;

    // A revert's decisions on its conflicts.
    const revert = mutation.origin === 'revert'
      ? await inTransaction(control, ctx.request, async (db) => {
        const row = await revertRepo.findByNewMutationId(db, { organisationId, newMutationId: mutationId });
        return row === undefined ? undefined : { row, conflicts: await revertConflictRepo.listByRevert(db, row.id) };
      }, { readOnly: true })
      : undefined;
    // A record is skipped when any of its conflicts excludes it, or a record-level conflict keeps it as it is.
    const decisionOf = (t: MutationTarget, field: string | null) => {
      const mine = revert?.conflicts.filter((c) => c.entityReference === t.entityReference) ?? [];
      if (field === null) {
        if (mine.some((c) => c.decision === 'exclude_record')) return 'exclude_record';
        return mine.some((c) => c.field === null && c.decision === 'keep_current') ? 'exclude_record' : null;
      }
      return mine.find((c) => c.field === field)?.decision ?? null;
    };
    return { mutationId, mutation, all, targets, priorStates, prior, values, newValues, preview, version, sourceObjectOf, revert, decisionOf, organisationId };
  }

  type Loaded = Awaited<ReturnType<typeof load>>;

  /**
   * Steps 1 to 3 for the targets in scope (all, a canary's sample, or what a canary left):
   * the stale re-read, the writes per connection under this phase's executions, the read-back.
   */
  async function writePhase(ctx: Context, c: Loaded, phase: 'canary' | 'full', scope: ReadonlySet<string> | null): Promise<PhaseResult | { stale: number }> {
    const { mutationId, prior, newValues, sourceObjectOf, decisionOf } = c;
    const scoped = c.targets.filter((t) => scope === null || scope.has(t.id));
    // 1. The stale re-read.
    const byConnection = new Map<string, MutationTarget[]>();
    for (const t of scoped) byConnection.set(t.connectionId!, [...(byConnection.get(t.connectionId!) ?? []), t]);
    let stale = 0;
    for (const [connectionId, list] of byConnection) {
      // An upsert that would create checks its record is still absent.
      const reread = list.filter((t) => t.operation !== 'create' && (prior.has(t.id) || t.operation === 'upsert'));
      if (reread.length === 0) continue;
      const fields = [...new Set(reread.flatMap((t) => Object.keys(prior.get(t.id) ?? newValues[t.id] ?? {})))];
      const read = await deps.services.call(readRecords, {
        body: { connectionId, object: sourceObjectOf(connectionId), identifiers: reread.map((t) => t.entityReference!), fields, reason: 'mutation' },
      }, callOptions(ctx));
      reread.forEach((t, i) => {
        const current = read.records[i]!.values;
        const before = prior.get(t.id);
        if (before === undefined) {
          if (current !== null) stale += 1;
          return;
        }
        if (current === null || Object.entries(before).some(([f, v]) => !same(current[f], v))) stale += 1;
      });
    }
    if (stale > 0) return { stale };

    // 2 and 3. Write and verify, per connection, in two passes: a revert re-points links to a record it recreates only
    // once the source has given that record its identifier (46.6), so those writes wait for the first pass.
    const executions = await inTransaction(control, ctx.request, (db) => mutationExecutionRepo.listByMutation(db, mutationId), { readOnly: true });
    const verifications: VerificationRow[] = [];
    const outcomes = new Map<string, TargetOutcome>();
    const assigned = new Map<string, string>();
    const executionUpdates: { id: string; status: 'succeeded' | 'partially_succeeded' | 'failed'; attempted: number; applied: number; error: string | null }[] = [];
    let skipped = 0;
    const decidedAway = new Set<string>();
    const passes: [string, MutationTarget[]][][] = [
      [...byConnection].map(([id, list]): [string, MutationTarget[]] => [id, list.filter((t) => !followsRecreation(newValues[t.id]))]),
      [...byConnection].map(([id, list]): [string, MutationTarget[]] => [id, list.filter((t) => followsRecreation(newValues[t.id]))]),
    ];
    for (const [pass, lists] of passes.entries()) for (const [connectionId, list] of lists) {
      if (pass === 1 && list.length === 0) continue;
      const execution = executions.find((e) => e.connectionId === connectionId && e.phase === phase && e.completedAt === null)!;
      const ops: { target: MutationTarget; values: Record<string, unknown> }[] = [];
      for (const t of list) {
        if (decisionOf(t, null) === 'exclude_record') {
          skipped += 1;
          decidedAway.add(t.id);
          outcomes.set(t.id, 'not_applied');
          continue;
        }
        // A custom action runs whole or not at all: a field kept as it is keeps the record out of it.
        if (t.operation === 'custom' && t.fields.some((f) => decisionOf(t, f) === 'keep_current')) {
          skipped += 1;
          decidedAway.add(t.id);
          outcomes.set(t.id, 'not_applied');
          continue;
        }
        // A full update sends every field: one kept as it is goes as its current value, never left out (which would clear it).
        const written = t.operation === 'custom' ? newValues[t.id] ?? {}
          : t.operation === 'update_full'
            ? Object.fromEntries(Object.entries(newValues[t.id] ?? {}).map(([f, v]) => [f, decisionOf(t, f) === 'keep_current' ? prior.get(t.id)?.[f] ?? null : v]))
            : Object.fromEntries(Object.entries(newValues[t.id] ?? {}).filter(([f]) => decisionOf(t, f) !== 'keep_current'));
        const keptWhole = t.operation === 'update_full' && t.fields.some((f) => decisionOf(t, f) === 'keep_current')
          && Object.entries(written).every(([f, v]) => same(v, prior.get(t.id)?.[f] ?? null));
        if ((t.operation === 'update_partial' && Object.keys(written).length === 0) || keptWhole) {
          skipped += 1;
          decidedAway.add(t.id);
          outcomes.set(t.id, 'not_applied');
          continue;
        }
        if (pass === 1) {
          // The identifier the source gave the recreated record, in place of its placeholder.
          const followed = Object.fromEntries(Object.entries(written).map(([f, v]) => [f, isNewIdentifier(v) ? assigned.get(v.$newIdentifierOf) ?? null : v]));
          if (Object.values(followed).some((v) => v === null)) {
            outcomes.set(t.id, 'not_applied');
            verifications.push({
              id: uuidv7(), executionId: execution.id, target: t, entityReference: t.entityReference!, field: null, intended: null, observed: null,
              outcome: 'failed', reason: 'link_not_repointed',
            });
            continue;
          }
          if (Object.entries(followed).every(([f, v]) => same(v, prior.get(t.id)?.[f]))) {
            // The source kept the record's identifier: the link still holds, and nothing is written.
            skipped += 1;
            decidedAway.add(t.id);
            outcomes.set(t.id, 'not_applied');
            continue;
          }
          ops.push({ target: t, values: followed });
          continue;
        }
        ops.push({ target: t, values: written });
      }
      if (ops.length === 0) {
        executionUpdates.push({ id: execution.id, status: 'succeeded', attempted: 0, applied: 0, error: null });
        continue;
      }
      let results: WriteResult[];
      try {
        // One moment for the plan: what is prepared for the grant is what is sent (an MQTT command's payload is computed at it).
        const plan = {
          connectionId, object: sourceObjectOf(connectionId), ...(c.mutation.dryRun ? { dryRun: true as const } : {}), at: new Date().toISOString(),
          operations: ops.map(({ target, values: v }) => ({
            key: target.idempotencyKey, operation: target.operation,
            ...(target.operation === 'create' ? {} : { identifier: target.entityReference! }), values: v as never,
            prior: (target.operation === 'create' ? null : prior.get(target.id) ?? null) as never,
            ...(target.customAction === null ? {} : { customAction: target.customAction }),
          })),
        };
        // A write through the Silo Agent runs only on a grant signed for exactly its statements (spec 5.6, 10.4).
        const prepared = await deps.services.call(prepareWrites, { body: plan }, callOptions(ctx));
        let grant: SignedExecutionGrant | undefined;
        if (prepared.grantRequired) {
          if (deps.grants?.available !== true) {
            throw new AppError('configuration', 'this cell has no execution grant key: writes through the Silo Agent cannot be signed', { code: 'write.grant_unavailable' });
          }
          grant = deps.grants.sign({
            organisationId: c.organisationId, actionId: mutationId, actionKind: 'mutation', connectionId, object: plan.object,
            statements: prepared.statements!, payloadSha256: prepared.payloadSha256!,
          });
        }
        const out = await deps.services.call(writeRecords, { body: { ...plan, ...(grant === undefined ? {} : { grant }) } }, callOptions(ctx));
        results = out.results;
      } catch (error) {
        // The connection refused the plan as a whole (halted, writes withdrawn, a bound).
        const code = error instanceof AppError ? error.code : 'write.failed';
        results = ops.map(({ target }) => ({ key: target.idempotencyKey, outcome: 'failed' as const, identifier: target.entityReference, error: { meaning: 'upstream' as const, code } }));
      }
      // Physical writes (47.4, 47.8): every node named, logged; the agent's refusals and the control system's rejections raised.
      await logPhysicalWrites(deps, ctx, { organisationId: c.organisationId, connectionId, mutationId, dryRun: c.mutation.dryRun }, results);
      const byKey = new Map(results.map((r) => [r.key, r]));
      const applied = ops.filter(({ target }) => byKey.get(target.idempotencyKey)?.outcome === 'applied');
      for (const { target } of ops) {
        const result = byKey.get(target.idempotencyKey)!;
        if (result.outcome !== 'applied') {
          outcomes.set(target.id, 'not_applied');
          verifications.push({
            id: uuidv7(), executionId: execution.id, target, entityReference: target.entityReference ?? result.identifier ?? 'unknown', field: null,
            intended: null, observed: null, outcome: 'failed', reason: result.outcome === 'not_attempted' ? 'not_attempted' : result.error?.meaning ?? 'failed',
          });
        } else if (target.operation === 'create' && result.identifier !== null) {
          assigned.set(target.id, result.identifier);
        }
      }
      // A physical command (47.6) is verified by acknowledgement, never read back: a good status is verified; no answer is not.
      const commanded = (target: MutationTarget) => target.operation === 'custom' && byKey.get(target.idempotencyKey)?.physical !== undefined;
      for (const { target, values: v } of applied.filter(({ target }) => commanded(target))) {
        const statuses = byKey.get(target.idempotencyKey)!.physical!.nodes.map((n) => n.status);
        const acknowledged = statuses.length > 0 && statuses.every((s) => s === 'good');
        verifications.push({
          id: uuidv7(), executionId: execution.id, target, entityReference: target.entityReference!, field: null,
          intended: { command: target.customAction, inputs: v }, observed: { acknowledged, status: statuses[0] ?? null },
          outcome: acknowledged ? 'verified' : 'failed', reason: acknowledged ? 'acknowledged' : 'not_acknowledged',
        });
        outcomes.set(target.id, acknowledged ? 'verified' : 'failed');
      }
      // Read back what applied.
      const readable = applied.filter(({ target }) => !commanded(target) && (target.operation !== 'create' || assigned.has(target.id)));
      if (readable.length > 0) {
        const fields = [...new Set(readable.flatMap(({ target, values: v }) => target.operation === 'delete' ? Object.keys(prior.get(target.id) ?? {})
          : target.operation === 'custom' ? target.fields : Object.keys(v)))];
        // A dry run is verified from what the simulator read back (47.5): production is not read, nor written.
        const read = c.mutation.dryRun ? {
          records: readable.map(({ target }) => {
            const nodes = byKey.get(target.idempotencyKey)?.physical?.nodes ?? [];
            return { values: nodes.length === 0 ? null : Object.fromEntries(nodes.flatMap((n) => (n.field === undefined ? [] : [[n.field, n.observed ?? null]]))) };
          }),
        } : await deps.services.call(readRecords, {
          body: {
            connectionId, object: sourceObjectOf(connectionId), fields: fields.length > 0 ? fields : [Object.keys(newValues[readable[0]!.target.id] ?? {})[0] ?? 'id'],
            identifiers: readable.map(({ target }) => assigned.get(target.id) ?? target.entityReference!), reason: 'read_back',
          },
        }, callOptions(ctx));
        readable.forEach(({ target, values: v }, i) => {
          const record = read.records[i]!.values;
          const reference = assigned.get(target.id) ?? target.entityReference!;
          if (target.operation === 'delete') {
            verifications.push({
              id: uuidv7(), executionId: execution.id, target, entityReference: reference, field: null, intended: null, observed: null,
              outcome: record === null ? 'verified' : 'failed', reason: record === null ? null : 'still_present',
            });
            outcomes.set(target.id, record === null ? 'verified' : 'failed');
            return;
          }
          if (target.operation === 'custom') {
            const checked = customVerifications(target, record, prior.get(target.id) ?? {}, expectedOf(c, target.id));
            for (const row of checked.rows) verifications.push({ id: uuidv7(), executionId: execution.id, target, entityReference: reference, ...row });
            outcomes.set(target.id, checked.worst);
            return;
          }
          let worst: TargetOutcome = 'verified';
          for (const [field, intended] of Object.entries(v)) {
            const observed = record === null ? null : record[field] ?? null;
            const outcome = record === null ? 'failed' : same(observed, intended) ? 'verified' : 'diverged';
            if (outcome === 'failed') worst = 'failed';
            else if (outcome === 'diverged' && worst === 'verified') worst = 'diverged';
            verifications.push({
              id: uuidv7(), executionId: execution.id, target, entityReference: reference, field, intended, observed: record === null ? null : observed,
              outcome, reason: outcome === 'failed' ? 'not_observed' : outcome === 'diverged' ? 'transformed' : null,
            });
          }
          outcomes.set(target.id, worst);
        });
      }
      for (const { target } of applied) {
        if (target.operation === 'create' && !assigned.has(target.id)) {
          outcomes.set(target.id, 'failed');
          verifications.push({
            id: uuidv7(), executionId: execution.id, target, entityReference: target.entityReference!, field: null, intended: null, observed: null,
            outcome: 'failed', reason: 'identifier_not_returned',
          });
        }
      }
      const firstError = results.find((r) => r.error !== null)?.error;
      executionUpdates.push({
        id: execution.id, status: applied.length === ops.length ? 'succeeded' : applied.length === 0 ? 'failed' : 'partially_succeeded',
        attempted: results.filter((r) => r.outcome !== 'not_attempted').length, applied: applied.length,
        error: firstError === undefined || firstError === null ? null : firstError.meaning,
      });
    }
    // One update per execution, over both passes.
    const merged = new Map<string, (typeof executionUpdates)[number]>();
    for (const u of executionUpdates) {
      const was = merged.get(u.id);
      if (was === undefined) {
        merged.set(u.id, { ...u });
        continue;
      }
      const both = [was.status, u.status];
      was.attempted += u.attempted;
      was.applied += u.applied;
      was.error ??= u.error;
      was.status = both.every((s) => s === 'succeeded') ? 'succeeded' : both.every((s) => s === 'failed') ? 'failed' : 'partially_succeeded';
    }
    return { verifications, outcomes, assigned, executionUpdates: [...merged.values()], skipped, decidedAway, connections: byConnection.size };
  }

  /**
   * Step 4, once every phase has run: the terminal status, receipt, commits and events, over
   * this phase's results and any earlier phase's (a canary's sample, already stored). An
   * expired canary finishes with its sample alone, as expired.
   */
  async function finish(ctx: Context, c: Loaded, fresh: PhaseResult, earlier: PhaseResult | null = null, expired = false): Promise<void> {
    const { mutationId, mutation, all, targets: everyTarget, priorStates, prior, values, preview, version, sourceObjectOf, revert, organisationId } = c;
    const verifications = [...(earlier?.verifications ?? []), ...fresh.verifications];
    const freshVerifications = fresh.verifications;
    const outcomes = new Map([...(earlier?.outcomes ?? []), ...fresh.outcomes]);
    const assigned = new Map([...(earlier?.assigned ?? []), ...fresh.assigned]);
    const executionUpdates = fresh.executionUpdates;
    const skipped = (earlier?.skipped ?? 0) + fresh.skipped;
    const decidedAway = new Set([...(earlier?.decidedAway ?? []), ...fresh.decidedAway]);
    // An expired canary reports the sample it wrote; the rest was never attempted.
    const targets = expired ? everyTarget.filter((t) => outcomes.has(t.id)) : everyTarget;
    const executions = await inTransaction(control, ctx.request, (db) => mutationExecutionRepo.listByMutation(db, mutationId), { readOnly: true });
    const connectionCount = Math.max(fresh.connections, earlier?.connections ?? 0);
    // Records a revert's decisions left as they are wrote nothing and failed nothing.
    const counted = targets.filter((t) => !decidedAway.has(t.id));
    const states = counted.map((t) => outcomes.get(t.id) ?? 'not_applied');
    const appliedCount = states.filter((s) => s !== 'not_applied').length;
    const status = expired ? 'expired' as const : states.length === 0 ? 'completed'
      : appliedCount === 0 ? 'failed'
        : states.every((s) => s === 'verified') ? 'completed'
          : states.every((s) => s === 'verified' || s === 'diverged') ? 'completed_with_divergence'
            : 'partially_failed';

    const sealedVerifications = await sealValues(deps, ctx, freshVerifications.flatMap((v) => v.field === null ? [] : [
      { binding: bindings.verification(v.id, 'intended'), value: v.intended },
      { binding: bindings.verification(v.id, 'observed'), value: v.observed },
    ]));

    const { chain, steps, commitsBefore } = await inTransaction(control, ctx.request, async (db) => {
      const chain = await approvalChainRepo.latestForMutation(db, mutationId);
      return {
        chain, steps: chain === undefined ? [] : await approvalStepRepo.listByChain(db, chain.id),
        commitsBefore: revert === undefined ? [] : await actionCommitRepo.listByMutation(db, (await receiptRepo.findById(db, revert.row.revertedReceiptId))!.mutationId),
      };
    }, { readOnly: true });
    const approvers = steps.filter((s) => s.decision === 'approved').map((s) => s.approverMembershipId!);
    const selfApproved = steps.some((s) => s.selfApproval);
    const executor = executions[0]?.executedByMembershipId ?? null;
    const committed = counted.filter((t) => outcomes.get(t.id) !== 'not_applied' && outcomes.get(t.id) !== undefined);
    const commits = committed.map((t) => {
      // A record a revert recreates keeps its identity and commit log, whatever identifier the source gave it (46.6).
      const objectId = t.operation === 'create' && assigned.has(t.id) && revert === undefined
        ? objectIdentity(organisationId, mutation.objectTypeId, t.connectionId!, sourceObjectOf(t.connectionId!), assigned.get(t.id)!) : t.objectId;
      const rows = preview?.rows.filter((r) => r.objectId === t.objectId) ?? [];
      return {
        id: uuidv7(), target: t, objectId, outcome: outcomes.get(t.id) as 'verified' | 'diverged' | 'failed',
        revertsCommitId: commitsBefore.find((c) => c.objectId === objectId)?.id ?? null,
        objectDiffHash: sha256(canonicalJsonBytes(rows)),
      };
    });
    const receiptId = uuidv7();
    // Side effects fire once, after verification of every connection, and only where a write
    // landed (42.6); a failure changes nothing about the write. An expired canary fires none.
    const sideEffects = expired ? [] : await fireSideEffects(ctx, c, receiptId, appliedCount > 0, { approvers, executor });
    const document = {
      schema: 'silo.receipt.v1', mutationId, origin: mutation.origin, intentSealed: mutation.intent !== null,
      actionType: { versionId: version.id, actionTypeId: version.actionTypeId, version: version.version },
      riskClass: mutation.riskClass, resolutionPolicy: mutation.resolutionPolicy, manifest: mutation.manifest, parameters: values['parameters'] ?? {},
      objects: all.map((t) => ({
        targetId: t.id, objectId: t.objectId, connectionId: t.connectionId, reference: t.entityReference, operation: t.operation, excluded: t.excluded,
        ...(t.customAction === null ? {} : { customAction: t.customAction }),
      })),
      priorStates: Object.fromEntries([...prior.entries()]),
      diff: preview, diffHash: mutation.diffHash?.toString('hex') ?? null,
      approval: chain === undefined ? null : {
        chainId: chain.id, snapshot: chain.policySnapshot, floorOverrodePolicy: chain.floorOverrodePolicy,
        steps: steps.map((s) => ({ approver: s.approverMembershipId, decision: s.decision, decidedAt: s.decidedAt, selfApproval: s.selfApproval, rule: s.qualifyingRule })),
      },
      executor, proposer: mutation.proposerMembershipId,
      // A Cron's mutation (43.11): the person who authorised the Cron, named on every run, and how it ran.
      ...(mutation.origin === 'cron' ? {
        authorisedBy: mutation.authorisingMembershipId, cronMode: mutation.cronMode, executorPrincipal: executions[0]?.executedByPrincipalId ?? null,
      } : {}),
      executions: executions.map((e) => {
        const u = executionUpdates.find((x) => x.id === e.id);
        return {
          id: e.id, connectionId: e.connectionId, phase: e.phase, status: u?.status ?? e.status, attempted: u?.attempted ?? e.recordsAttempted,
          applied: u?.applied ?? e.recordsApplied, error: u?.error ?? e.error,
        };
      }),
      verifications: verifications.map((v) => ({ targetId: v.target.id, reference: v.entityReference, field: v.field, intended: v.intended, observed: v.observed, outcome: v.outcome, reason: v.reason })),
      lineage: targets.map((t) => ({ targetId: t.id, connectionId: t.connectionId, fields: t.fields, connectorVersion: priorStates.find((p) => p.targetId === t.id)?.connectorVersion ?? null })),
      identifierRemappings: [...assigned.entries()].map(([targetId, identifier]) => ({ targetId, identifier })),
      // Dependents a revert could not re-point to a recreated record (46.6 step 4).
      linksNotRepointed: [
        ...((values['notRepointed'] ?? []) as NotRepointed[]),
        ...targets.filter((t) => followsRecreation(c.newValues[t.id]) && outcomes.get(t.id) === 'not_applied' && !decidedAway.has(t.id))
          .map((t) => ({ recreatedTargetId: (Object.values(c.newValues[t.id]!).find(isNewIdentifier))!.$newIdentifierOf, connectionId: t.connectionId,
            reference: t.entityReference, via: t.fields[0] ?? '', reason: 'recreation_failed' })),
      ],
      sideEffects,
      // A physical command's verification is its acknowledgement, which does not confirm the physical outcome (47.6).
      ...(mutation.riskClass === 'physical' && all.some((t) => t.operation === 'custom') ? { acknowledgement: COMMAND_ACKNOWLEDGEMENT } : {}),
      commits: commits.map((c) => ({ id: c.id, objectId: c.objectId, revertsCommitId: c.revertsCommitId })),
      revert: revert === undefined ? null : {
        revertId: revert.row.id, revertsReceiptId: revert.row.revertedReceiptId,
        decisions: revert.conflicts.map((c) => ({ conflictId: c.id, reference: c.entityReference, field: c.field, kind: c.kind, decision: c.decision })),
      },
      status,
    };
    const documentHash = sha256(canonicalJsonBytes(document));
    const [sealedDocument] = await sealValues(deps, ctx, [{ binding: bindings.receipt(receiptId), value: document }]);
    const verified = states.filter((s) => s === 'verified').length;
    const diverged = states.filter((s) => s === 'diverged').length;
    const failed = states.filter((s) => s === 'failed').length;

    await inTransaction(control, ctx.request, async (db) => {
      const now = new Date().toISOString();
      let i = 0;
      for (const v of freshVerifications) {
        await mutationVerificationRepo.insert(db, {
          id: v.id, organisationId, executionId: v.executionId, targetId: v.target.id, entityReference: v.entityReference, field: v.field,
          intended: v.field === null ? null : sealedVerifications[i++]!, observed: v.field === null ? null : sealedVerifications[i++]!,
          outcome: v.outcome, reason: v.reason, verifiedAt: now,
        });
      }
      for (const u of executionUpdates) {
        await mutationExecutionRepo.update(db, u.id, { status: u.status, recordsAttempted: u.attempted, recordsApplied: u.applied, error: u.error, completedAt: now });
      }
      await mutationRepo.update(db, mutationId, { status, completedAt: now });
      await receiptRepo.insert(db, {
        id: receiptId, organisationId, mutationId, document: sealedDocument!, documentHash, dryRun: mutation.dryRun,
        referenceSummary: {
          actionTypeVersionId: version.id, riskClass: mutation.riskClass, origin: mutation.origin, executorMembershipId: executor,
          approverMembershipIds: approvers, selfApproved, counts: { targets: targets.length, verified, diverged, failed, skipped },
          commits: commits.map((c) => c.id), status,
          // A promotion's receipt names its branch and staged Action (39.8).
          ...(mutation.origin === 'scenario_promotion' ? { promotion: ((mutation.manifest as { promotion?: unknown }).promotion ?? null) as never } : {}),
        },
        revertsReceiptId: revert?.row.revertedReceiptId ?? null,
        retentionUntil: new Date(Date.now() + RECEIPT_RETENTION_DAYS * 86_400_000).toISOString(),
      });
      // Lineage (spec 59.2, 59.3), in the same transaction: the action uses its Action type
      // version (and a revert reverts the receipt it undoes); the receipt is receipted by it.
      const actor = { organisationId, createdBy: { membershipId: executor ?? mutation.proposerMembershipId ?? mutation.authorisingMembershipId ?? undefined } };
      const action = { kind: 'action' as const, refId: mutationId, version: '1' };
      await writeLineage(db, actor, {
        artefact: action,
        inputs: [
          { node: { kind: 'action_type_version', refId: version.actionTypeId, version: version.id }, relation: 'uses' },
          ...(revert?.row.revertedReceiptId ? [{ node: { kind: 'receipt' as const, refId: revert.row.revertedReceiptId, version: '1' }, relation: 'reverts' as const }] : []),
        ],
      });
      await writeLineage(db, actor, { artefact: { kind: 'receipt', refId: receiptId, version: '1' }, inputs: [{ node: action, relation: 'receipted_by' }] });
      for (const c of commits) {
        const head = await objectHeadRepo.lockByObjectId(db, c.objectId);
        await actionCommitRepo.insert(db, {
          id: c.id, organisationId, objectId: c.objectId, objectTypeId: mutation.objectTypeId, mutationId, receiptId, parentCommitId: head?.headCommitId ?? null,
          revertsCommitId: c.revertsCommitId, authorMembershipId: mutation.authorisingMembershipId ?? mutation.proposerMembershipId!,
          approverMembershipIds: approvers,
          ...(executor === null && executions[0]?.executedByPrincipalId != null ? { executorPrincipalId: executions[0].executedByPrincipalId } : { executorMembershipId: executor }),
          selfApproved, fieldsChanged: c.target.fields,
          objectDiffHash: c.objectDiffHash, outcome: c.outcome,
        });
        if (head === undefined) {
          await objectHeadRepo.insert(db, { id: uuidv7(), organisationId, objectId: c.objectId, objectTypeId: mutation.objectTypeId, headCommitId: c.id });
        } else {
          await objectHeadRepo.update(db, head.id, { headCommitId: c.id, commitCount: String(Number(head.commitCount) + 1) });
        }
      }
      const event = { organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions' as const, resource: { type: 'mutation' as const, id: mutationId } };
      const fields = [...new Set(targets.flatMap((t) => t.fields))].sort().join(',').slice(0, 200);
      await recordActionEvent(db, { ...event, event: 'mutation_executed', detail: { row_count: targets.length, connections: connectionCount, fields, applied: appliedCount } });
      if (expired) {
        await recordActionEvent(db, { ...event, event: 'canary_expired', detail: { sample: targets.length, verified, diverged, failed } });
      } else {
        const outcomeEvent = status === 'completed' ? 'mutation_verified' : status === 'completed_with_divergence' ? 'mutation_diverged'
          : status === 'failed' ? 'mutation_failed' : 'mutation_partially_failed';
        await recordActionEvent(db, { ...event, event: outcomeEvent, detail: { verified, diverged, failed } });
        // Every node of a physical Action read back as written (47.8); a dry run verifies only its simulator.
        if (mutation.riskClass === 'physical' && mutation.dryRun !== true && outcomeEvent === 'mutation_verified') {
          await recordActionEvent(db, { ...event, event: 'physical_action_verified', detail: { receipt_id: receiptId, verified } });
        }
      }
      await recordActionEvent(db, { ...event, event: 'receipt_created', resource: { type: 'receipt', id: receiptId }, detail: { mutation_id: mutationId, document_hash: documentHash.toString('hex') } });
      // Read first by a reviewer (47.8): both approvers, the nodes' allow-list entries and the receipt.
      if (mutation.riskClass === 'physical') await recordPhysicalExecuted(db, ctx, { organisationId, mutationId, receiptId, approvers, dryRun: mutation.dryRun });
      if (commits.length > 0) await recordActionEvent(db, { ...event, event: 'commit_recorded', detail: { commits: commits.length } });
      for (const effect of sideEffects.filter((e) => e.outcome !== 'not_fired')) {
        await recordActionEvent(db, {
          ...event, event: effect.outcome === 'fired' ? 'side_effect_fired' : 'side_effect_failed',
          detail: { kind: effect.kind, recipients: effect.recipients, receipt_id: receiptId, ...(effect.reason === null ? {} : { reason: effect.reason }) },
        });
      }
      if (revert !== undefined) {
        await recordActionEvent(db, { ...event, service: 'actions', event: 'revert_executed', resource: { type: 'revert', id: revert.row.id }, detail: { mutation_id: mutationId, skipped } });
        if (mutation.riskClass === 'physical') {
          await recordActionEvent(db, {
            ...event, event: 'physical_action_reverted', resource: { type: 'revert', id: revert.row.id },
            detail: { mutation_id: mutationId, receipt_id: receiptId, dry_run: mutation.dryRun === true, skipped },
          });
        }
        if (skipped > 0) await recordActionEvent(db, { ...event, event: 'revert_partial', resource: { type: 'revert', id: revert.row.id }, detail: { skipped } });
        const recreatedFrom = (values['recreatedFrom'] ?? {}) as Record<string, { reference: string; connectionId: string }>;
        const named = (values['notRepointed'] ?? []) as NotRepointed[];
        const onRevert = { type: 'revert' as const, id: revert.row.id };
        for (const [targetId, identifier] of assigned) {
          const t = targets.find((x) => x.id === targetId)!;
          if (t.operation !== 'create') continue;
          const original = recreatedFrom[targetId]?.reference;
          const changed = original !== undefined && identifier !== original;
          await recordActionEvent(db, { ...event, event: 'record_recreated', resource: onRevert, detail: { connection_id: t.connectionId!, changed_reference: changed } });
          if (!changed) continue;
          // A new identifier (46.6 steps 1 and 3): recorded, with the links that followed it and those that could not.
          const followers = targets.filter((f) => Object.values(c.newValues[f.id] ?? {}).some((v) => isNewIdentifier(v) && v.$newIdentifierOf === targetId));
          const repointed = followers.filter((f) => outcomes.get(f.id) === 'verified' || outcomes.get(f.id) === 'diverged');
          const notFollowed = followers.length - repointed.length + named.filter((n) => n.recreatedTargetId === targetId).length;
          await idRemappingRepo.insert(db, {
            id: uuidv7(), organisationId, revertId: revert.row.id, connectionId: t.connectionId!, objectId: t.objectId, oldReference: original!,
            newReference: identifier, linksRepointed: repointed.length, linksNotRepointed: notFollowed,
          });
          await recordActionEvent(db, { ...event, event: 'id_remapped', resource: onRevert, detail: {
            connection_id: t.connectionId!, links_repointed: repointed.length, links_not_repointed: notFollowed,
          } });
          for (const f of repointed) {
            await recordActionEvent(db, { ...event, event: 'link_repointed', resource: onRevert, detail: { connection_id: f.connectionId!, field: f.fields[0] ?? null } });
          }
        }
        for (const n of named) {
          await recordActionEvent(db, { ...event, event: 'link_not_repointed', resource: onRevert, detail: { connection_id: n.connectionId, via: n.via, reason: n.reason } });
        }
      }
      await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId, stage: status, rowCount: targets.length });
      await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId, stage: 'receipt_created', receiptId, rowCount: targets.length });
      // The outbound Action event (48.3): identifiers, outcomes and people, never values.
      await recordActionExecuted(db, { organisationId, correlationId: ctx.correlationId, payload: {
        type: 'action.executed', mutationId, receiptId, origin: mutation.origin === 'revert' ? 'revert' : 'action',
        revertsReceiptId: revert?.row.revertedReceiptId ?? null,
        actionType: { id: version.actionTypeId, versionId: version.id, version: version.version }, objectTypeId: mutation.objectTypeId,
        riskClass: mutation.riskClass, outcome: status, fields: [...new Set(targets.flatMap((t) => t.fields))].sort().slice(0, 500),
        connections: executions.map((e) => {
          const u = executionUpdates.find((x) => x.id === e.id);
          const s = u?.status ?? e.status;
          return {
            connectionId: e.connectionId, outcome: s === 'succeeded' || s === 'partially_succeeded' ? s : 'failed' as const,
            attempted: u?.attempted ?? e.recordsAttempted, applied: u?.applied ?? e.recordsApplied,
          };
        }),
        objects: counted.slice(0, EVENT_OBJECTS_MAX).map((t) => ({
          objectId: commits.find((c) => c.target.id === t.id)?.objectId ?? t.objectId, connectionId: t.connectionId!,
          outcome: outcomes.get(t.id) ?? 'not_applied',
        })),
        objectCount: counted.length, proposer: mutation.authorisingMembershipId ?? mutation.proposerMembershipId, approvers, executor,
        proposedAt: mutation.previewedAt ?? mutation.createdAt, completedAt: now,
      } });
    });

    // The Action ledger's copy (48.2), now the receipt exists: where a Silo holds one.
    await ledgerCopy(ctx, c, {
      receiptId, targets: counted, outcomes, objectIdOf: (t) => commits.find((x) => x.target.id === t.id)?.objectId ?? t.objectId,
      commitIdOf: (t) => commits.find((x) => x.target.id === t.id)?.id ?? null, approvers, selfApproved, executedAt: new Date().toISOString(),
      markingIds: ((chain?.policySnapshot as { markings?: string[] } | undefined)?.markings) ?? [],
    });
  }

  /**
   * One ledger row per object (48.2), sent to the Silo holding the ledger after the receipt
   * commits: the Warehouse, or where the cell has none, a Capture Silo (D205). Values are kept
   * only where the ledger holds them, and they are sent only then.
   * Retried briefly; a copy that still fails is kept, its rows sealed to it as the receipt's
   * values are, and sent again by retryLedgerCopies until written (the rows' ids are the
   * receipt's and the target's, so a copy sent twice adds nothing). The receipt remains the record.
   */
  async function ledgerCopy(ctx: Context, c: Loaded, input: {
    receiptId: string; targets: readonly MutationTarget[]; outcomes: ReadonlyMap<string, TargetOutcome>; objectIdOf: (t: MutationTarget) => string;
    commitIdOf: (t: MutationTarget) => string | null; approvers: string[]; selfApproved: boolean; executedAt: string; markingIds: string[];
  }): Promise<void> {
    const { mutation, version, revert, prior, newValues, organisationId } = c;
    const loaded = await inTransaction(control, ctx.request, async (db) => {
      // The Silo holding the ledger: the Warehouse, or where the cell has none, a Capture Silo (D205).
      const silo = await siloRepo.findLedgerHolder(db);
      if (silo === undefined || (silo.kind !== 'warehouse' && silo.kind !== 'capture')) return undefined;
      return {
        store: silo.kind, mode: silo.actionLedgerIncludeValues === true ? 'values' : 'references', type: (await actionTypeRepo.findById(db, version.actionTypeId))!,
        revertsMutationId: revert === undefined ? null : (await receiptRepo.findById(db, revert.row.revertedReceiptId))?.mutationId ?? null,
      };
    }, { readOnly: true });
    if (loaded === undefined || input.targets.length === 0) return;
    const values = loaded.mode === 'values';
    const rows = input.targets.map((t) => {
      const outcome = input.outcomes.get(t.id);
      return {
        ledgerId: uuidv5(input.receiptId, t.id), mutationId: mutation.id, receiptId: input.receiptId, commitId: input.commitIdOf(t),
        actionType: `${loaded.type.apiName} v${version.version}`, genericEdit: loaded.type.isSystem, riskClass: mutation.riskClass,
        objectType: mutation.objectTypeId, objectId: input.objectIdOf(t), connectionId: t.connectionId,
        operation: t.operation, fields: t.fields,
        priorValues: values ? (prior.get(t.id) ?? null) as never : null, newValues: values ? (newValues[t.id] ?? null) as never : null,
        proposer: mutation.authorisingMembershipId ?? mutation.proposerMembershipId, approvers: input.approvers, selfApproved: input.selfApproved,
        origin: mutation.origin === 'revert' ? 'revert' as const : 'action' as const,
        outcome: outcome === 'verified' || outcome === 'diverged' ? outcome : 'failed' as const,
        revertsMutationId: loaded.revertsMutationId, proposedAt: mutation.previewedAt, executedAt: input.executedAt, markingIds: input.markingIds,
      };
    });
    try {
      const body = { receiptId: input.receiptId, rows };
      await retry(() => sendLedger(ctx, loaded.store, body), { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 });
    } catch (error) {
      deps.logger.failure('the Action ledger copy was not written yet; it is kept and sent again', error, {
        event: 'actions.ledger_copy_failed', organisationId, resourceType: 'receipt', resourceId: input.receiptId,
      });
      const [sealed] = await sealValues(deps, ctx, [{ binding: bindings.ledgerCopy(input.receiptId), value: rows }]);
      await inTransaction(control, ctx.request, (db) => ledgerCopyRepo.insert(db, {
        id: input.receiptId, organisationId, store: loaded.store, rowsSealed: sealed!, rowCount: rows.length, attempts: 1,
        nextAttemptAt: new Date(Date.now() + LEDGER_RETRY_FIRST_MS).toISOString(), lastFailure: failureCode(error),
      }));
    }
  }

  type LedgerRows = Parameters<typeof deps.services.call<typeof writeActionLedger>>[1]['body']['rows'];
  function sendLedger(ctx: Context, store: 'warehouse' | 'capture', body: { receiptId: string; rows: LedgerRows }) {
    return store === 'capture' ? deps.services.call(writeCaptureLedger, { body }, callOptions(ctx)) : deps.services.call(writeActionLedger, { body }, callOptions(ctx));
  }

  /** What a revert's compensating action is expected to leave in each field it changes (the original's prior state). */
  function expectedOf(c: Loaded, targetId: string): Record<string, unknown> {
    return ((c.values['expected'] ?? {}) as Record<string, Record<string, unknown>>)[targetId] ?? {};
  }

  /**
   * A custom action's read-back (42.5): its effect is the fields it declares it changes. A
   * field with an expected value (a compensating action's) is verified against it; any other
   * is verified when it reads changed from its prior state, and diverged when it reads as
   * before, with the observed value recorded and nothing intended.
   */
  function customVerifications(t: MutationTarget, record: Record<string, unknown> | null, before: Record<string, unknown>, expected: Record<string, unknown>) {
    const rows: { field: string | null; intended: unknown; observed: unknown; outcome: VerificationRow['outcome']; reason: string | null }[] = [];
    if (record === null) {
      rows.push({ field: null, intended: null, observed: null, outcome: 'failed', reason: 'not_observed' });
      return { rows, worst: 'failed' as TargetOutcome };
    }
    let worst: TargetOutcome = 'verified';
    for (const f of t.fields) {
      const observed = record[f] ?? null;
      const outcome = f in expected ? (same(observed, expected[f]) ? 'verified' : 'diverged') : same(observed, before[f]) ? 'diverged' : 'verified';
      if (outcome === 'diverged') worst = 'diverged';
      rows.push({
        field: f, intended: f in expected ? expected[f] : null, observed, outcome,
        reason: outcome === 'verified' ? null : f in expected ? 'transformed' : 'custom_unchanged',
      });
    }
    return { rows, worst };
  }

  /**
   * The canary's sample: drawn at random (seeded by the mutation, so it can be reproduced) and
   * taken in turn from each connection, so every connection is in it. Random, so what the sample
   * shows says something about the rest (decision 2026-11-11).
   */
  function sampleOf(targets: readonly MutationTarget[], size: number, seed: string): Set<string> {
    const random = seededUniform(seed);
    const queues = new Map<string, MutationTarget[]>();
    for (const t of targets) queues.set(t.connectionId!, [...(queues.get(t.connectionId!) ?? []), t]);
    for (const q of queues.values()) {
      for (let i = q.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [q[i], q[j]] = [q[j]!, q[i]!];
      }
    }
    const picked = new Set<string>();
    while (picked.size < size && [...queues.values()].some((q) => q.length > 0)) {
      for (const q of queues.values()) {
        const next = q.shift();
        if (next !== undefined && picked.size < size) picked.add(next.id);
      }
    }
    return picked;
  }

  /** The canary phase's results as stored: its verifications opened, each target's outcome, the identifiers it created. */
  async function canaryResult(ctx: Context, c: Loaded): Promise<PhaseResult & { canaryExecutionIds: Set<string> }> {
    const { rows, executions } = await inTransaction(control, ctx.request, async (db) => ({
      rows: await mutationVerificationRepo.listByMutation(db, c.mutationId), executions: await mutationExecutionRepo.listByMutation(db, c.mutationId),
    }), { readOnly: true });
    const canaryExecutionIds = new Set(executions.filter((e) => e.phase === 'canary').map((e) => e.id));
    const mine = rows.filter((r) => canaryExecutionIds.has(r.executionId));
    const sealed = mine.flatMap((r) => r.field === null || r.intended === null || r.observed === null ? [] : [
      { binding: bindings.verification(r.id, 'intended'), sealed: r.intended }, { binding: bindings.verification(r.id, 'observed'), sealed: r.observed },
    ]);
    const opened = await openValues(deps, ctx, sealed);
    let i = 0;
    const verifications: VerificationRow[] = [];
    const outcomes = new Map<string, TargetOutcome>();
    const assigned = new Map<string, string>();
    const rank: Record<TargetOutcome, number> = { verified: 0, diverged: 1, failed: 2, not_applied: 3 };
    const applying = new Set(['not_observed', 'still_present', 'identifier_not_returned']);
    for (const r of mine) {
      const target = c.all.find((t) => t.id === r.targetId)!;
      const withValues = r.field !== null && r.intended !== null && r.observed !== null;
      verifications.push({
        id: r.id, executionId: r.executionId, target, entityReference: r.entityReference, field: r.field,
        intended: withValues ? opened[i++] : null, observed: withValues ? opened[i++] : null,
        outcome: r.outcome as VerificationRow['outcome'], reason: r.reason,
      });
      // A failed write is not applied; a failed read-back of an applied write is failed.
      const outcome: TargetOutcome = r.outcome === 'failed' && !applying.has(r.reason ?? '') ? 'not_applied' : r.outcome as TargetOutcome;
      const was = outcomes.get(target.id);
      if (was === undefined || rank[outcome] > rank[was]) outcomes.set(target.id, outcome);
      if (target.operation === 'create' && r.entityReference !== target.entityReference && outcome !== 'not_applied') assigned.set(target.id, r.entityReference);
    }
    return { verifications, outcomes, assigned, executionUpdates: [], skipped: 0, decidedAway: new Set(), connections: new Set(executions.filter((e) => e.phase === 'canary').map((e) => e.connectionId)).size, canaryExecutionIds };
  }

  /** Writes and verifies the sample, keeps what it found, and waits for confirmation. */
  async function runCanary(ctx: Context, mutationId: string, sample: ReadonlySet<string>): Promise<void> {
    const c = await load(ctx, mutationId);
    const result = await writePhase(ctx, c, 'canary', sample);
    if ('stale' in result) return finishStale(ctx, mutationId, c.organisationId, result.stale);
    await keepCanary(ctx, c, result, sample.size);
  }

  /** Stores a canary's results; the mutation waits in canary for confirmation. */
  async function keepCanary(ctx: Context, c: Loaded, result: PhaseResult, sampleSize: number): Promise<void> {
    const { mutationId } = c;
    const sample = { size: sampleSize };
    const sealedVerifications = await sealValues(deps, ctx, result.verifications.flatMap((v) => v.field === null ? [] : [
      { binding: bindings.verification(v.id, 'intended'), value: v.intended },
      { binding: bindings.verification(v.id, 'observed'), value: v.observed },
    ]));
    const states = [...result.outcomes.values()];
    await inTransaction(control, ctx.request, async (db) => {
      const now = new Date().toISOString();
      let i = 0;
      for (const v of result.verifications) {
        await mutationVerificationRepo.insert(db, {
          id: v.id, organisationId: c.organisationId, executionId: v.executionId, targetId: v.target.id, entityReference: v.entityReference, field: v.field,
          intended: v.field === null ? null : sealedVerifications[i++]!, observed: v.field === null ? null : sealedVerifications[i++]!,
          outcome: v.outcome, reason: v.reason, verifiedAt: now,
        });
      }
      for (const u of result.executionUpdates) {
        await mutationExecutionRepo.update(db, u.id, { status: u.status, recordsAttempted: u.attempted, recordsApplied: u.applied, error: u.error, completedAt: now });
      }
      await recordActionEvent(db, {
        organisationId: c.organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions', event: 'canary_executed',
        resource: { type: 'mutation', id: mutationId }, detail: {
          sample: sample.size, verified: states.filter((x) => x === 'verified').length, diverged: states.filter((x) => x === 'diverged').length,
          failed: states.filter((x) => x === 'failed' || x === 'not_applied').length,
        },
      });
    });
  }

  /** The remainder, after confirmation: the rest of the targets, then one finish over both phases. */
  async function runRemainder(ctx: Context, mutationId: string): Promise<void> {
    const c = await load(ctx, mutationId);
    const earlier = await canaryResult(ctx, c);
    const rest = new Set(c.targets.filter((t) => !earlier.outcomes.has(t.id)).map((t) => t.id));
    const result = await writePhase(ctx, c, 'full', rest);
    // Changed since the preview: the sample stands, the rest is not written; the receipt says so.
    if ('stale' in result) return finish(ctx, c, { ...earlier, verifications: [], outcomes: new Map(), assigned: new Map() }, earlier, true);
    await finish(ctx, c, result, earlier);
  }

  /**
   * What an interrupted phase left (45.3): each of its targets read back, never written again.
   * An update whose fields all read as intended is verified (some differing: diverged); one
   * whose fields all read as before was not applied; a delete is applied when the record is
   * gone; a create whose identifier was never returned cannot be found, and fails.
   */
  async function reconcile(ctx: Context, c: Loaded, phase: 'canary' | 'full', done: ReadonlySet<string>): Promise<PhaseResult> {
    const { mutationId, prior, newValues, sourceObjectOf } = c;
    const executions = await inTransaction(control, ctx.request, (db) => mutationExecutionRepo.listByMutation(db, mutationId), { readOnly: true });
    const open = executions.filter((e) => e.phase === phase && e.completedAt === null);
    const verifications: VerificationRow[] = [];
    const outcomes = new Map<string, TargetOutcome>();
    const executionUpdates: PhaseResult['executionUpdates'] = [];
    for (const execution of open) {
      const list = c.targets.filter((t) => t.connectionId === execution.connectionId && !done.has(t.id));
      const reread = list.filter((t) => t.operation !== 'create');
      const read = reread.length === 0 ? { records: [] as { values: Record<string, unknown> | null }[] } : await deps.services.call(readRecords, {
        body: {
          connectionId: execution.connectionId, object: sourceObjectOf(execution.connectionId), identifiers: reread.map((t) => t.entityReference!),
          fields: [...new Set(reread.flatMap((t) => t.operation === 'delete' ? Object.keys(prior.get(t.id) ?? {})
            : t.operation === 'custom' ? t.fields : Object.keys(newValues[t.id] ?? {})))],
          reason: 'read_back',
        },
      }, callOptions(ctx));
      let applied = 0;
      for (const t of list) {
        const row = (outcome: VerificationRow['outcome'], reason: string, field: string | null = null, intended: unknown = null, observed: unknown = null) =>
          verifications.push({ id: uuidv7(), executionId: execution.id, target: t, entityReference: t.entityReference!, field, intended, observed, outcome, reason });
        if (t.operation === 'create') {
          outcomes.set(t.id, 'not_applied');
          row('failed', 'interrupted_create_unknown');
          continue;
        }
        const record = read.records[reread.indexOf(t)]!.values;
        if (t.operation === 'delete') {
          outcomes.set(t.id, record === null ? 'verified' : 'not_applied');
          row(record === null ? 'verified' : 'failed', record === null ? 'recovered' : 'interrupted_not_applied');
          if (record === null) applied += 1;
          continue;
        }
        if (t.operation === 'custom') {
          // Every declared change still reads as before: the action did not run.
          const before = prior.get(t.id) ?? {};
          if (record !== null && t.fields.every((f) => same(record[f], before[f]))) {
            outcomes.set(t.id, 'not_applied');
            row('failed', 'interrupted_not_applied');
            continue;
          }
          const checked = customVerifications(t, record, before, expectedOf(c, t.id));
          for (const r of checked.rows) row(r.outcome, r.reason === null ? 'recovered' : r.reason, r.field, r.intended, r.observed);
          outcomes.set(t.id, checked.worst);
          applied += 1;
          continue;
        }
        if (t.operation === 'upsert' && !prior.has(t.id) && record === null) {
          // An upsert that would create, and the record is still absent: it did not run.
          outcomes.set(t.id, 'not_applied');
          row('failed', 'interrupted_not_applied');
          continue;
        }
        const intended = newValues[t.id] ?? {};
        const before = prior.get(t.id) ?? {};
        const fields = Object.keys(intended);
        if (record !== null && fields.every((f) => same(record[f], before[f])) && !fields.every((f) => same(record[f], intended[f]))) {
          outcomes.set(t.id, 'not_applied');
          row('failed', 'interrupted_not_applied');
          continue;
        }
        let worst: TargetOutcome = 'verified';
        for (const f of fields) {
          const observed = record === null ? null : record[f] ?? null;
          const outcome = record === null ? 'failed' : same(observed, intended[f]) ? 'verified' : 'diverged';
          if (outcome === 'failed') worst = 'failed';
          else if (outcome === 'diverged' && worst === 'verified') worst = 'diverged';
          row(outcome, record === null ? 'not_observed' : outcome === 'diverged' ? 'recovered_diverged' : 'recovered', f, intended[f], observed);
        }
        outcomes.set(t.id, worst);
        applied += 1;
      }
      executionUpdates.push({
        id: execution.id, status: applied === list.length ? 'succeeded' : applied === 0 ? 'failed' : 'partially_succeeded',
        attempted: list.length, applied, error: 'interrupted',
      });
    }
    return { verifications, outcomes, assigned: new Map(), executionUpdates, skipped: 0, decidedAway: new Set(), connections: open.length };
  }

  /**
   * An Action's side effects (42.6): a notification to the people it names, in the product,
   * with the receipt as its only content (references, never values). A webhook is queued for
   * notify's signed delivery to its target, its payload references only (20.4). A dry run sends
   * no webhook (47.5: nothing reaches production). A physical webhook (47.1) is queued only
   * while its allow-list entry is live, its interval passed and its connection within its rate,
   * and logged as a physical write; a revert never sends the original's again, but the inverse
   * targets its plan names (47.6), with the references alone.
   */
  async function fireSideEffects(ctx: Context, c: Loaded, receiptId: string, landed: boolean, people: { approvers: string[]; executor: string | null })
    : Promise<{ kind: 'notification' | 'webhook'; outcome: 'fired' | 'failed' | 'not_fired' | 'queued'; recipients: number; reason: string | null }[]> {
    const out: Awaited<ReturnType<typeof fireSideEffects>> = [];
    const reverting = c.mutation.origin === 'revert';
    const planned = c.preview?.physical?.nodes.filter((n) => n.endpointId !== undefined) ?? [];
    const effects = [...(c.version.sideEffects as {
      kind: 'notification' | 'webhook'; endpointId?: string; recipients?: ('proposer' | 'approvers' | 'executor')[]; channels?: ('home' | 'email')[];
      payload?: { jsonata: string }; physical?: boolean;
    }[]).filter((e) => !(reverting && e.kind === 'webhook' && e.physical === true)),
    // A revert's inverse webhooks (47.6): the references alone, as the targets have no side effect of their own.
    ...(reverting ? planned.map((n) => ({ kind: 'webhook' as const, endpointId: n.endpointId!, physical: true, payload: undefined })) : [])];
    // Targets declaring a status endpoint: their receipt records effect, read after delivery, not delivery alone (20.4).
    const webhookIds = effects.flatMap((e) => (e.kind === 'webhook' && e.endpointId ? [e.endpointId] : []));
    const statusEndpoints = new Set(webhookIds.length === 0 ? [] : (await inTransaction(deps.databases.pool('control'), ctx.request,
      (db) => Promise.all(webhookIds.map((id) => webhookEndpointRepo.findById(db, id))), { readOnly: true }))
      .flatMap((e) => (e !== undefined && e.statusUrl !== null ? [e.id] : [])));
    for (const effect of effects) {
      if (!landed) {
        out.push({ kind: effect.kind, outcome: 'not_fired', recipients: 0, reason: 'nothing_applied' });
        continue;
      }
      if (effect.kind === 'webhook' && c.mutation.dryRun) {
        out.push({ kind: 'webhook', outcome: 'not_fired', recipients: 0, reason: 'dry_run' });
        continue;
      }
      if (effect.kind === 'webhook') {
        // A physical target: sent under the entry its plan checked, checked again now (47.4, 47.5).
        const node = effect.physical === true ? planned.find((n) => n.endpointId === effect.endpointId) : undefined;
        if (effect.physical === true && node === undefined) {
          out.push({ kind: 'webhook', outcome: 'failed', recipients: 0, reason: 'physical_not_planned' });
          continue;
        }
        // The references, or the JSONata-shaped body the type declares over the executed Action, which may carry its
        // parameters (20.4): sealed to the delivery row. The execution identifier is the idempotency key the target sees.
        const references = {
          mutationId: c.mutationId, receiptId, actionTypeId: c.version.actionTypeId, actionTypeVersionId: c.version.id, objectTypeId: c.mutation.objectTypeId,
          origin: c.mutation.origin, objectIds: [...new Set(c.targets.filter((t) => !t.excluded).map((t) => t.objectId))],
        };
        let payload: unknown = references;
        if (effect.payload !== undefined) {
          try {
            payload = await compileExpression('webhook.payload', 'jsonata', effect.payload.jsonata).evaluate({ input: {
              ...references, objects: c.targets.filter((t) => !t.excluded).map((t) => ({ objectId: t.objectId, connectionId: t.connectionId, reference: t.entityReference })),
              parameters: c.values['parameters'] ?? {},
            } }, new Date());
          } catch (error) {
            deps.logger.failure('a webhook payload could not be shaped', error, { event: 'action.side_effect_failed', resourceType: 'mutation', resourceId: c.mutationId });
            out.push({ kind: 'webhook', outcome: 'failed', recipients: 0, reason: 'payload_invalid' });
            continue;
          }
          if (payload === undefined) payload = null;
        }
        try {
          const deliveryId = uuidv7();
          const [sealed] = await sealValues(deps, ctx, [{ binding: { table: 'action.webhook_deliveries', id: deliveryId, column: 'payload' }, value: payload }]);
          const refusal = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
            let entryId: string | null = null;
            if (node !== undefined) {
              const gate = await queuePhysicalWebhook(db, { organisationId: c.mutation.organisationId, mutationId: c.mutationId, connectionId: node.connectionId, action: node.nodeAddress });
              if ('refused' in gate) return gate.refused;
              entryId = gate.entry.id;
            }
            await webhookDeliveryRepo.insertOnce(db, {
              id: deliveryId, organisationId: c.mutation.organisationId, endpointId: effect.endpointId!, mutationId: c.mutationId, receiptId,
              executionKey: `${c.mutationId}:${effect.endpointId}`, payload: sealed!, allowlistEntryId: entryId,
            });
            return null;
          });
          if (refusal !== null) {
            out.push({ kind: 'webhook', outcome: 'failed', recipients: 0, reason: `actuation_${refusal}` });
            continue;
          }
          out.push({ kind: 'webhook', outcome: 'queued', recipients: 0, reason: statusEndpoints.has(effect.endpointId!) ? 'effect_read_from_status_endpoint' : 'delivery_recorded_not_effect' });
        } catch (error) {
          deps.logger.failure('a webhook side effect could not be queued', error, { event: 'action.side_effect_failed', resourceType: 'mutation', resourceId: c.mutationId });
          out.push({ kind: 'webhook', outcome: 'failed', recipients: 0, reason: 'not_queued' });
        }
        continue;
      }
      const who = new Set<string>();
      for (const r of effect.recipients ?? ['proposer']) {
        const proposer = c.mutation.proposerMembershipId ?? c.mutation.authorisingMembershipId;
        if (r === 'proposer' && proposer !== null) who.add(proposer);
        if (r === 'approvers') for (const a of people.approvers) who.add(a);
        if (r === 'executor' && people.executor !== null) who.add(people.executor);
      }
      let failed = 0;
      for (const recipientMembershipId of who) {
        try {
          await deps.services.call(raiseNotification, { body: {
            recipientMembershipId, kind: 'action_completed', source: { receiptId },
            channels: [...new Set((effect.channels ?? ['home']).map((ch) => (ch === 'home' ? 'in_app' as const : 'email' as const)))],
          } }, callOptions(ctx));
        } catch (error) {
          failed += 1;
          deps.logger.failure('a notification side effect failed', error, { event: 'action.side_effect_failed', resourceType: 'mutation', resourceId: c.mutationId });
        }
      }
      out.push({ kind: 'notification', outcome: failed === 0 ? 'fired' : 'failed', recipients: who.size - failed, reason: failed === 0 ? null : 'notify_unavailable' });
    }
    return out;
  }

  /** An execution in one pass: every target, then the finish. */
  async function run(ctx: Context, mutationId: string): Promise<void> {
    const c = await load(ctx, mutationId);
    const result = await writePhase(ctx, c, 'full', null);
    if ('stale' in result) return finishStale(ctx, mutationId, c.organisationId, result.stale);
    await finish(ctx, c, result);
  }

  return {
    async execute(ctx: Context, caller: ServiceName, mutationId: string) {
      // A member, or a Cron's principal running its own mutation within the bounds it was authorised for (43.11).
      const principalId = ctx.request.membershipId === undefined ? ctx.request.servicePrincipalId : undefined;
      const { organisationId, membershipId } = principalId !== undefined && ctx.request.organisationId !== undefined
        ? { organisationId: ctx.request.organisationId, membershipId: undefined } : memberOf(ctx, 'executing a mutation');
      const { mutation, targets, priorStates } = await inTransaction(control, ctx.request, (db) => loadMutation(db, mutationId), { readOnly: true });
      if (principalId !== undefined && (mutation.cronMode !== 'execute_within_bounds' || mutation.proposerPrincipalId !== principalId)) {
        throw new AppError('forbidden', 'a principal runs only its own Cron\'s mutation, within its bounds', { code: 'mutation.not_permitted' });
      }
      if (mutation.status === 'executing' || mutation.completedAt !== null) return mutationView(deps, ctx, mutationId);
      if (mutation.status !== 'approved') {
        throw new AppError('conflict', `the mutation is ${mutation.status}: only an approved mutation executes`, { code: 'mutation.not_approved' });
      }
      if (mutation.executionSeparated) {
        if (caller !== 'gateway') throw new AppError('conflict', 'execution is separated: a holder of mutation.execute runs it', { code: 'mutation.execution_separated' });
        if (membershipId === mutation.proposerMembershipId) throw new AppError('forbidden', 'separated execution: the executor may not be the proposer', { code: 'mutation.executor_is_proposer' });
        await demand(deps, ctx, 'mutation.execute', undefined, 'mutation.not_permitted');
      } else if (caller !== 'approvals') {
        throw new AppError('conflict', 'here approval executes: the final approval runs the mutation', { code: 'mutation.execution_follows_approval' });
      }
      const live = targets.filter((t) => !t.excluded);
      const canary = deps.canary ?? CANARY;
      // 10,000 rows or more: the sample first (45.4).
      // The organisation's sample size where it set one (45.4; D66), drawn at random, seeded by the mutation.
      const sampleRows = live.length < canary.rows ? canary.sample
        : (await inTransaction(control, ctx.request, (db) => organisationRepo.findById(db, mutation.organisationId), { readOnly: true }))?.canarySampleRows ?? canary.sample;
      const sample = live.length >= canary.rows ? sampleOf(live, Math.min(sampleRows, live.length), mutationId) : null;
      const connections = [...new Set(live.filter((t) => sample === null || sample.has(t.id)).map((t) => t.connectionId!))];
      await inTransaction(control, ctx.request, async (db) => {
        // Spec 6.4: Actions pause while the organisation moves cell; the approved mutation waits.
        if (await tenantMigrationRepo.writesPaused(db, organisationId)) {
          throw new AppError('conflict', 'the organisation is moving cell: Actions are paused until the move completes', {
            code: 'mutation.tenant_migration', retryable: true,
          });
        }
        const now = new Date().toISOString();
        for (const connectionId of connections) {
          await mutationExecutionRepo.insert(db, {
            id: uuidv7(), organisationId, mutationId, connectionId, phase: sample === null ? 'full' : 'canary', status: 'executing',
            ...(membershipId === undefined ? { executedByPrincipalId: principalId! } : { executedByMembershipId: membershipId }),
            connectorVersion: priorStates.find((p) => p.connectionId === connectionId)?.connectorVersion ?? 'unknown', attemptedAt: now,
          });
        }
        const status = sample === null ? 'executing' as const : 'canary' as const;
        await mutationRepo.update(db, mutationId, { status });
        await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId, stage: status, rowCount: mutation.rowCount });
      });
      const background: Context = { request: { ...ctx.request }, correlationId: ctx.correlationId };
      track(mutationId, sample === null ? run(background, mutationId) : runCanary(background, mutationId, sample), background, organisationId);
      return mutationView(deps, ctx, mutationId);
    },

    /** The remainder of a canaried mutation (45.4), once every diverged or failed sample record was seen. */
    async confirmCanary(ctx: Context, mutationId: string, seen: { diverged: number; failed: number }) {
      const { organisationId, membershipId } = memberOf(ctx, 'confirming a canary');
      const c = await load(ctx, mutationId);
      const { mutation } = c;
      if (mutation.status !== 'canary') throw new AppError('conflict', `the mutation is ${mutation.status}: only a canary waits for confirmation`, { code: 'mutation.not_canary' });
      const { executions, steps } = await inTransaction(control, ctx.request, async (db) => {
        const chain = await approvalChainRepo.latestForMutation(db, mutationId);
        return { executions: await mutationExecutionRepo.listByMutation(db, mutationId), steps: chain === undefined ? [] : await approvalStepRepo.listByChain(db, chain.id) };
      }, { readOnly: true });
      if (executions.some((e) => e.phase === 'canary' && e.completedAt === null)) {
        throw new AppError('conflict', 'the canary is still running', { code: 'mutation.canary_running', retryable: true, retryAfterSeconds: 1 });
      }
      if (mutation.executionSeparated) {
        if (membershipId === mutation.proposerMembershipId) throw new AppError('forbidden', 'separated execution: the executor may not be the proposer', { code: 'mutation.executor_is_proposer' });
        await demand(deps, ctx, 'mutation.execute', undefined, 'mutation.not_permitted');
      } else {
        const final = steps.filter((x) => x.decision === 'approved').sort((a, b) => (a.decidedAt ?? '').localeCompare(b.decidedAt ?? '')).at(-1);
        if (final?.approverMembershipId !== membershipId) {
          throw new AppError('forbidden', 'the final approver confirms the remainder of a canary', { code: 'mutation.not_final_approver' });
        }
      }
      // They confirm having seen every diverged and failed sample record.
      const earlier = await canaryResult(ctx, c);
      const states = [...earlier.outcomes.values()];
      const counts = { diverged: states.filter((x) => x === 'diverged').length, failed: states.filter((x) => x === 'failed' || x === 'not_applied').length };
      if (seen.diverged !== counts.diverged || seen.failed !== counts.failed) {
        throw new AppError('conflict', 'confirm after seeing every diverged and failed sample record', { code: 'mutation.canary_unseen', details: counts });
      }
      const rest = c.targets.filter((t) => !earlier.outcomes.has(t.id));
      await inTransaction(control, ctx.request, async (db) => {
        const now = new Date().toISOString();
        for (const connectionId of new Set(rest.map((t) => t.connectionId!))) {
          await mutationExecutionRepo.insert(db, {
            id: uuidv7(), organisationId, mutationId, connectionId, phase: 'full', status: 'executing', executedByMembershipId: membershipId,
            connectorVersion: c.priorStates.find((p) => p.connectionId === connectionId)?.connectorVersion ?? 'unknown', attemptedAt: now,
          });
        }
        await mutationRepo.update(db, mutationId, { status: 'executing', canaryConfirmedBy: membershipId, canaryConfirmedAt: now });
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions', event: 'canary_confirmed',
          resource: { type: 'mutation', id: mutationId }, detail: { sample: earlier.outcomes.size, remainder: rest.length, ...counts },
        });
        await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId, stage: 'executing', rowCount: mutation.rowCount });
      });
      const background: Context = { request: { ...ctx.request }, correlationId: ctx.correlationId };
      track(mutationId, runRemainder(background, mutationId), background, organisationId);
      return mutationView(deps, ctx, mutationId);
    },

    /**
     * Canaries whose chain expired unconfirmed (45.4): each finishes as expired, with a receipt
     * for the sample it wrote, so a governed revert can be offered. Across organisations.
     */
    async expireCanaries(correlationId: string, now: Date = new Date()): Promise<number> {
      const due = await inTransaction(control, {}, (db) => mutationRepo.canariesExpired(db, now.toISOString(), 100), { readOnly: true });
      for (const { organisationId, id } of due) {
        const ctx: Context = { request: { organisationId }, correlationId };
        const c = await load(ctx, id);
        const earlier = await canaryResult(ctx, c);
        await finish(ctx, c, { ...earlier, verifications: [], outcomes: new Map(), assigned: new Map() }, earlier, true);
      }
      return due.length;
    },

    /**
     * Executions a process started and never finished, older than `staleMs` (45.3): recovered
     * by reading the sources, never by writing again. A canary's sample then waits for
     * confirmation; anything else finishes with its receipt. Across organisations.
     */
    async recoverInterrupted(correlationId: string, now: Date = new Date(), staleMs = 15 * 60_000): Promise<number> {
      const due = await inTransaction(control, {}, (db) => mutationRepo.interrupted(db, new Date(now.getTime() - staleMs).toISOString(), 50), { readOnly: true });
      let recovered = 0;
      for (const { organisationId, mutationId, phase } of due) {
        if (active.has(mutationId)) continue;
        const ctx: Context = { request: { organisationId }, correlationId };
        const c = await load(ctx, mutationId);
        if (phase === 'canary') {
          const result = await reconcile(ctx, c, 'canary', new Set());
          await keepCanary(ctx, c, result, result.outcomes.size);
        } else {
          const earlier = c.mutation.canaryConfirmedAt === null ? null : await canaryResult(ctx, c);
          const result = await reconcile(ctx, c, 'full', new Set(earlier?.outcomes.keys() ?? []));
          await finish(ctx, c, result, earlier);
        }
        recovered += 1;
      }
      return recovered;
    },

    /**
     * Ledger copies owed (48.2), sent again when due: written, the copy goes; failing, it waits
     * longer each time (a minute doubling to six hours); once no Silo holds the ledger, or it
     * moved to another store, the copy is dropped, as the ledger switched off writes nothing more.
     */
    async retryLedgerCopies(correlationId: string, now: Date = new Date()): Promise<number> {
      const due = await inTransaction(control, {}, (db) => ledgerCopyRepo.due(db, now.toISOString(), 100), { readOnly: true });
      let written = 0;
      for (const { organisationId, id } of due) {
        const ctx: Context = { request: { organisationId }, correlationId };
        try {
          await inTransaction(control, ctx.request, async (db) => {
            const copy = await ledgerCopyRepo.claim(db, id);
            if (copy === undefined || Date.parse(copy.nextAttemptAt) > now.getTime()) return;
            const holder = await siloRepo.findLedgerHolder(db);
            if (holder === undefined || holder.kind !== copy.store) {
              await ledgerCopyRepo.remove(db, id);
              return;
            }
            const [rows] = await openValues(deps, ctx, [{ binding: bindings.ledgerCopy(id), sealed: copy.rowsSealed }]);
            try {
              await sendLedger(ctx, copy.store, { receiptId: id, rows: rows as LedgerRows });
              await ledgerCopyRepo.remove(db, id);
              written += 1;
            } catch (error) {
              const wait = Math.min(LEDGER_RETRY_FIRST_MS * 2 ** copy.attempts, LEDGER_RETRY_MAX_MS);
              await ledgerCopyRepo.update(db, id, {
                attempts: copy.attempts + 1, nextAttemptAt: new Date(now.getTime() + wait).toISOString(), lastFailure: failureCode(error),
              });
              deps.logger.warn('an Action ledger copy failed again; it waits and is sent again', {
                event: 'actions.ledger_copy_retry_failed', organisationId, resourceType: 'receipt', resourceId: id, attempt: copy.attempts + 1,
              });
            }
          });
        } catch (error) {
          if (!isAppError(error)) throw error;
          deps.logger.failure('an Action ledger copy could not be retried; the next pass tries again', error, { event: 'actions.ledger_copy_retry_failed', organisationId });
        }
      }
      return written;
    },

    async close(): Promise<void> {
      await Promise.allSettled([...running]);
    },
  };
}

/** How long a failed ledger copy first waits, and at most (48.2). */
const LEDGER_RETRY_FIRST_MS = 60_000;
const LEDGER_RETRY_MAX_MS = 6 * 60 * 60_000;
const failureCode = (error: unknown): string => (isAppError(error) ? error.code : 'unhandled').slice(0, 120);

export type Execution = ReturnType<typeof createExecution>;
export type { Preview };
