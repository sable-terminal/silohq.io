import { withTransaction } from '../infra/db.infra';
import { capabilitiesOf } from '../engine/read/capabilities.read';
import { runWithTenant } from '../utils/tenantContext.util';
import { denial, invalid, isAppError, notFound, refusal } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { log as writeAudit } from './audit.service';
import { askComplete, writeBatch } from './connector.service';
import {
  assertMayChange,
  assertOverConnections,
  viewOf,
  visibleMutation,
  type MutationView,
} from './mutation.service';
import * as connectorRepo from '../repos/connector.repo';
import * as mutationRepo from '../repos/mutation.repo';
import * as mutationApprovalRepo from '../repos/mutationApproval.repo';
import * as executionRepo from '../repos/mutationExecution.repo';
import * as mutationPolicyRepo from '../repos/mutationPolicy.repo';
import * as scopeRepo from '../repos/scope.repo';
import { resolvePolicy, unionOf } from '../engine/mutation/policy.mutation';
import {
  canarySample,
  executionStatus,
  identityOf,
  notWritten,
  outcomeOf,
  readiness,
  verify,
  writeFor,
  type Verification,
} from '../engine/mutation/execute.mutation';
import { receiptOf, type Receipt } from '../engine/mutation/receipt.mutation';
import { digestOf, type RecordChange, type Target } from '../engine/mutation/preview.mutation';
import type { Filter, Query } from '../engine/execution/query.execution';
import type { Row } from '../engine/detectors/shared.detector';
import type { Manifest } from '../schemas/manifest.schema';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

const log = childLogger('mutation-execution');

/**
 * Mutations §8, §10–§12 — running an approved change, checking what landed, and
 * the receipt.
 *
 * ── After the request, not inside it ───────────────────────────────────────
 *
 * A change can be fifty thousand records. It is claimed in the transaction that
 * approved it, queued, and run after the response has gone, like an imported
 * file; a claim an instance abandoned is picked up by the scheduled runner and
 * resumed record by record.
 *
 * ── Per connection, and it says so ─────────────────────────────────────────
 *
 * §10: "Not atomic across connections, and the product says so." Each system is
 * its own execution. A system that cannot be reached at all stops the change
 * there; systems after it are recorded as skipped, not attempted, because
 * carrying on only widens a disagreement the change has already caused.
 * "Partial failure does not auto-revert" — the receipt reports the split, and
 * reverting what succeeded is a change of its own.
 *
 * ── Written for the proposer ───────────────────────────────────────────────
 *
 * Reads and writes run under the grants of the person who proposed the change,
 * checked again as each batch is written. An approval authorises a change; it
 * does not lend the approver's access to it, and a proposer who has lost their
 * write grant since does not get the write by having asked earlier.
 */

/** Records written under one opened credential and read back together. */
const BATCH = 200;

/* ── The queue ────────────────────────────────────────────────────────────── */

const queue: Array<{ organisationId: string; mutationId: string }> = [];
let running: Promise<void> | null = null;

/** Run a claimed change after the request that claimed it has returned. */
export function enqueue(organisationId: string, mutationId: string): void {
  queue.push({ organisationId, mutationId });
  if (!running) {
    running = drain().finally(() => {
      running = null;
    });
  }
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const next = queue.shift()!;
    try {
      await run(next.organisationId, next.mutationId);
    } catch (error: unknown) {
      log.warn({ mutationId: next.mutationId, err: error }, 'Mutation run stopped');
    }
  }
}

/** Wait until nothing is running. For shutdown, and for tests. */
export async function settled(): Promise<void> {
  while (running) await running;
}

/* ── Starting ─────────────────────────────────────────────────────────────── */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

/**
 * §14 — run an approved change where the organisation separates running it
 * from approving it.
 *
 * "SO AN ORGANISATION CAN REQUIRE A DIFFERENT PERSON TO RUN AN APPROVED CHANGE":
 * not the proposer, and not anybody who approved it. Where execution is not
 * separated there is nothing to call — the last approval ran it.
 */
export async function execute(actor: Actor, mutationId: string): Promise<MutationView> {
  const view = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const { mutation, authority } = await visibleMutation(db, actor, mutationId, { lock: true });
      const chain = await mutationApprovalRepo.chainOf(db, mutation.id);

      if (mutation.status !== 'approved' || !chain) {
        throw invalid({ message: 'Only an approved change can be run.', code: 'invalid.mutation_state' });
      }
      if (!chain.policy.separateExecution) {
        throw invalid({
          message: 'That change ran when it was approved; there is nothing separate to run.',
          code: 'invalid.execution_not_separated',
        });
      }

      /* Said first: to the proposer or an approver, this is the answer whatever else they hold. */
      const involved = new Set([mutation.proposedBy, ...chain.decisions.map((one) => one.approver)]);
      if (involved.has(actor.membershipId)) {
        throw denial({
          message: 'This change has to be run by somebody who neither proposed nor approved it.',
          code: 'denial.execution_not_separate',
        });
      }

      await assertMayChange(db, actor, { revert: Boolean(mutation.manifest.reverts) });
      await assertOverConnections(db, authority, mutation, 'mutation.execute');

      if (mutation.expiresAt.getTime() <= Date.now()) {
        throw refusal({
          message: 'That approval ran out before the change was run. Propose it again.',
          code: 'refusal.approval_expired',
        });
      }

      await executionRepo.claim(db, { id: mutation.id, from: ['approved'], executedBy: actor.membershipId });
      return viewOf(db, (await mutationRepo.find(db, mutation.id))!);
    }),
  );

  enqueue(actor.organisationId, mutationId);
  return view;
}

/**
 * Who may decide on a canary: whoever may run the change. Where running is
 * separated, a holder of `mutation.execute`; otherwise an approver.
 */
async function assertMayDecideCanary(db: PoolClient, actor: Actor, mutationId: string) {
  const { mutation, authority } = await visibleMutation(db, actor, mutationId, { lock: true });
  const chain = await mutationApprovalRepo.chainOf(db, mutation.id);

  if (mutation.status !== 'canary_paused' || !chain) {
    throw invalid({ message: 'That change is not waiting on its sample.', code: 'invalid.mutation_state' });
  }

  await assertOverConnections(
    db,
    authority,
    mutation,
    chain.policy.separateExecution ? 'mutation.execute' : 'mutation.approve',
  );

  return mutation;
}

/**
 * §8 — the sample was written and checked; carry on with the rest.
 */
export async function confirmCanary(actor: Actor, mutationId: string): Promise<MutationView> {
  const view = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const mutation = await assertMayDecideCanary(db, actor, mutationId);
      await assertMayChange(db, actor, { revert: Boolean(mutation.manifest.reverts) });

      await executionRepo.confirmCanary(db, { id: mutation.id, by: actor.membershipId });
      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'canary_confirmed',
        detail: { mutationId: mutation.id },
      });

      return viewOf(db, (await mutationRepo.find(db, mutation.id))!);
    }),
  );

  enqueue(actor.organisationId, mutationId);
  return view;
}

/**
 * §8 — stop after the sample. What it wrote stays written, and the receipt says
 * so; undoing it is a revert.
 *
 * NOT BEHIND THE BILLING CHECK. Stopping a change is never what suspension takes
 * away.
 */
export async function haltCanary(actor: Actor, mutationId: string): Promise<MutationView> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const mutation = await assertMayDecideCanary(db, actor, mutationId);

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'canary_halted',
        detail: { mutationId: mutation.id, reason: 'stopped' },
      });
      await finish(db, actor.organisationId, mutation.id);

      return viewOf(db, (await mutationRepo.find(db, mutation.id))!);
    }),
  );
}

/** §12 — the receipt, for whoever may see the change. */
export async function receipt(
  actor: Actor,
  mutationId: string,
): Promise<{ id: string; digest: string; createdAt: Date; retainUntil: Date; document: Receipt }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const { mutation } = await visibleMutation(db, actor, mutationId);
      const found = await executionRepo.receiptFor(db, mutation.id);
      if (!found) {
        throw notFound({ message: 'That change has no receipt yet.', code: 'missing.receipt' });
      }
      return found;
    }),
  );
}

/* ── Running ──────────────────────────────────────────────────────────────── */

const codeOf = (error: unknown): string => (isAppError(error) ? error.code : 'internal.unexpected');

/**
 * Read records back by identifier, keyed by identity.
 *
 * THROUGH THE READ PATH, under the proposer's grants, bounded like any answer.
 * One request per batch where the source takes an `in` list on a single-field
 * identifier; one per record otherwise, because a composite key cannot be asked
 * as a list.
 */
export async function readRecords(input: {
  actor: Actor;
  connectionId: string;
  manifest: Manifest;
  object: string;
  targets: readonly Target[];
  columns: readonly string[];
}): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  if (input.targets.length === 0) return found;

  const identifier = Object.keys(input.targets[0]!.identifier);
  const fields = [...new Set([...identifier, ...input.columns])];
  const capabilities = capabilitiesOf(input.manifest, input.object);
  const byList = identifier.length === 1 && capabilities.filters.includes('in');

  const ask = async (filters: Filter[], limit: number) => {
    const query: Query = { object: input.object, filters, sort: [], fields, limit };
    const answered = await askComplete({ actor: input.actor, connectionIds: [input.connectionId], query });
    for (const row of answered.flatMap((one) => one.result?.rows ?? [])) {
      const key = identityOf(row, identifier);
      if (!found.has(key)) found.set(key, row);
    }
  };

  if (byList) {
    const size = capabilities.maxFilterValues || BATCH;
    for (let start = 0; start < input.targets.length; start += size) {
      const batch = input.targets.slice(start, start + size);
      await ask([{ field: identifier[0]!, op: 'in', value: batch.map((one) => one.identifier[identifier[0]!]) }], batch.length * 2);
    }
  } else {
    for (const target of input.targets) {
      await ask(
        identifier.map((field) => ({ field, op: 'eq' as const, value: target.identifier[field] })),
        2,
      );
    }
  }

  return found;
}

/**
 * Run a claimed change: the canary, the remainder, or all of it.
 *
 * ── Resumable ──────────────────────────────────────────────────────────────
 *
 * A record with an outcome recorded is never attempted again. A record written
 * by an attempt that died before recording it is met by the check before the
 * write, which finds it already holding the new value and verifies it instead.
 */
/*
 * ONE RUN OF A CHANGE PER PROCESS. The queue and the scheduled pickup can both
 * reach the same change in one instance; the claim keeps other instances out,
 * and this keeps the two callers in this one from writing side by side.
 */
const active = new Set<string>();

export async function run(
  organisationId: string,
  mutationId: string,
): Promise<'executed' | 'partially_executed' | 'failed' | 'canary_paused' | 'skipped'> {
  if (active.has(mutationId)) return 'skipped';
  active.add(mutationId);
  try {
    return await runClaimed(organisationId, mutationId);
  } finally {
    active.delete(mutationId);
  }
}

async function runClaimed(
  organisationId: string,
  mutationId: string,
): Promise<'executed' | 'partially_executed' | 'failed' | 'canary_paused' | 'skipped'> {
  const system = { organisationId, membershipId: null };

  const loaded = await runWithTenant(system, () =>
    withTransaction(async (db) => {
      const mutation = await mutationRepo.find(db, mutationId);
      if (!mutation || mutation.status !== 'executing') return null;

      const preview = (await mutationRepo.fullPreview(db, mutationId))!;
      const targets = await mutationRepo.targets(db, mutationId);
      const connections = await connectorRepo.load(
        db,
        preview.connections.map((connection) => connection.connectionId),
      );

      return { mutation, preview, targets, connections };
    }),
  );

  if (!loaded) return 'skipped';

  const { mutation, preview, targets } = loaded;
  const operation = mutation.operation;
  const proposer: Actor = { organisationId, membershipId: mutation.proposedBy };
  const audit = { organisationId, membershipId: mutation.executedBy, userId: null };

  const phase: executionRepo.Phase =
    preview.bulk !== 'canary' ? 'full' : mutation.canaryConfirmedAt ? 'remainder' : 'canary';

  const inPhase = phase === 'canary' ? canarySample(preview.changes) : preview.changes;
  const targetOf = new Map(targets.map((target) => [`${target.connectionId}\u0000${target.ref}`, target]));

  let stopped = false;

  for (const connection of preview.connections) {
    const changes = inPhase.filter((change) => change.connectionId === connection.connectionId);
    if (changes.length === 0) continue;

    const manifest = loaded.connections.find((one) => one.connectionId === connection.connectionId)?.manifest;

    const { executionId, pending } = await runWithTenant(system, () =>
      withTransaction(async (db) => {
        const id = await executionRepo.openExecution(db, {
          id: generateId(),
          mutationId,
          organisationId,
          connectionId: connection.connectionId,
          phase,
        });
        const done = await executionRepo.settledRefs(db, { mutationId, connectionId: connection.connectionId });
        return { executionId: id, pending: changes.filter((change) => !done.has(change.ref)) };
      }),
    );

    if (stopped || !manifest) {
      await runWithTenant(system, () =>
        withTransaction((db) =>
          executionRepo.closeExecution(db, {
            id: executionId,
            status: 'skipped',
            records: changes.length,
            applied: 0,
            failed: 0,
            error: manifest ? null : 'missing.connection',
          }),
        ),
      );
      stopped = true;
      continue;
    }

    let error: string | null = null;

    try {
      for (let start = 0; start < pending.length; start += BATCH) {
        const batch = pending.slice(start, start + BATCH);
        const outcomes = await runBatch({
          proposer,
          operation,
          connectionId: connection.connectionId,
          object: connection.object,
          manifest,
          batch,
          targetOf,
        });

        await runWithTenant(system, () =>
          withTransaction(async (db) => {
            await executionRepo.insertVerifications(db, {
              executionId,
              organisationId,
              connectionId: connection.connectionId,
              rows: outcomes,
            });
            await executionRepo.heartbeat(db, mutationId);
          }),
        );
      }
    } catch (caught: unknown) {
      /* The system could not be reached, read or written at all. */
      error = codeOf(caught);
      stopped = true;
      log.warn({ mutationId, connectionId: connection.connectionId, code: error }, 'Mutation stopped at a connection');
    }

    await runWithTenant(system, () =>
      withTransaction(async (db) => {
        const records = await executionRepo.outcomesOf(db, executionId);
        const applied = records.filter((one) => one.applied);
        const failed = records.filter((one) => !one.applied);
        const unattempted = error ? changes.length - records.length : 0;

        const counts = { records: changes.length, applied: applied.length, failed: failed.length + unattempted };

        await executionRepo.closeExecution(db, {
          id: executionId,
          status: executionStatus(counts),
          ...counts,
          error,
        });

        const fields = [...new Set(changes.flatMap((change) => change.fields.map((field) => field.field)))].sort();
        const connectionId = connection.connectionId;

        /*
         * §15 — "mutation_executed carries the entity set and the fields, not the
         * values." The records that took the write, by identifier.
         */
        await writeAudit(db, {
          ...audit,
          event: 'mutation_executed',
          detail: {
            mutationId,
            connectionId,
            phase,
            refs: applied.map((one) => one.ref),
            fields,
            records: counts.records,
            applied: counts.applied,
            failed: counts.failed,
          },
        });

        const verified = records.filter((one) => one.verified).length;
        if (verified > 0) {
          await writeAudit(db, { ...audit, event: 'mutation_verified', detail: { mutationId, connectionId, records: verified } });
        }

        const diverged = records.filter((one) => one.diverged).map((one) => one.ref);
        if (diverged.length > 0) {
          await writeAudit(db, {
            ...audit,
            event: 'mutation_diverged',
            detail: { mutationId, connectionId, records: diverged.length, refs: diverged, fields },
          });
        }

        if (counts.failed > 0) {
          await writeAudit(db, {
            ...audit,
            event: 'mutation_failed',
            detail: {
              mutationId,
              connectionId,
              records: counts.failed,
              refs: failed.map((one) => one.ref),
              failureCode: error,
            },
          });
        }
      }),
    );
  }

  return runWithTenant(system, () =>
    withTransaction(async (db) => {
      if (phase === 'canary' && !stopped) {
        const executions = (await executionRepo.executions(db, mutationId)).filter((one) => one.phase === 'canary');
        await executionRepo.settleRun(db, { id: mutationId, status: 'canary_paused' });
        await writeAudit(db, {
          ...audit,
          event: 'canary_executed',
          detail: {
            mutationId,
            records: executions.reduce((sum, one) => sum + one.records, 0),
            applied: executions.reduce((sum, one) => sum + one.applied, 0),
            failed: executions.reduce((sum, one) => sum + one.failed, 0),
          },
        });
        return 'canary_paused' as const;
      }

      return finish(db, organisationId, mutationId);
    }),
  );
}

/**
 * One batch: check each record, write the ones that may be written, read them
 * back, and say what became of every record in it.
 */
async function runBatch(input: {
  proposer: Actor;
  operation: mutationRepo.Mutation['operation'];
  connectionId: string;
  object: string;
  manifest: Manifest;
  batch: readonly RecordChange[];
  targetOf: ReadonlyMap<string, Target>;
}): Promise<Verification[]> {
  const targetFor = (change: RecordChange) => input.targetOf.get(`${change.connectionId}\u0000${change.ref}`)!;
  const identifier = Object.keys(targetFor(input.batch[0]!).identifier);
  const columns = [...new Set(input.batch.flatMap((change) => change.fields.map((field) => field.column)))];
  const keyOf = (change: RecordChange) => identityOf(targetFor(change).identifier, identifier);

  const read = (changes: readonly RecordChange[]) =>
    readRecords({
      actor: input.proposer,
      connectionId: input.connectionId,
      manifest: input.manifest,
      object: input.object,
      targets: changes.map(targetFor),
      columns,
    });

  const before = await read(input.batch);
  const outcomes: Verification[] = [];
  const toWrite: RecordChange[] = [];

  for (const change of input.batch) {
    const current = before.get(keyOf(change)) ?? null;
    const state = readiness(input.operation, change, current);

    if (state === 'write') toWrite.push(change);
    else if (state === 'applied') outcomes.push(...verify({ operation: input.operation, change, observed: current }));
    else outcomes.push(...notWritten(change, input.operation, state));
  }

  if (toWrite.length === 0) return outcomes;

  const errors = new Map<string, string>();

  await writeBatch({
    actor: input.proposer,
    connectionId: input.connectionId,
    use: async (write) => {
      for (const change of toWrite) {
        try {
          await write(writeFor({ operation: input.operation, object: input.object, change, target: targetFor(change) }));
        } catch (caught: unknown) {
          /* One record refused is that record's outcome, not the batch's. */
          errors.set(change.ref, codeOf(caught));
        }
      }
    },
  });

  const after = await read(toWrite.filter((change) => !errors.has(change.ref)));

  for (const change of toWrite) {
    outcomes.push(
      ...verify({
        operation: input.operation,
        change,
        observed: after.get(keyOf(change)) ?? null,
        writeError: errors.get(change.ref) ?? null,
      }),
    );
  }

  return outcomes;
}

/**
 * Settle the change's outcome and make its receipt, in one transaction.
 *
 * THE RECEIPT AND THE FINAL STATUS COMMIT TOGETHER. A change marked executed
 * with no receipt is exactly the unreviewable write this path replaces.
 */
async function finish(
  db: PoolClient,
  organisationId: string,
  mutationId: string,
): Promise<'executed' | 'partially_executed' | 'failed'> {
  const mutation = (await mutationRepo.find(db, mutationId))!;
  const preview = (await mutationRepo.fullPreview(db, mutationId))!;
  const chain = await mutationApprovalRepo.chainOf(db, mutationId);
  const executions = await executionRepo.executions(db, mutationId);

  /*
   * A CANARY STOPPED WHERE IT WAS IS PARTIAL, however cleanly its sample went:
   * the change approved was all of it, and most of it was never written.
   */
  const stoppedAtCanary = preview.bulk === 'canary' && !mutation.canaryConfirmedAt;
  const computed = outcomeOf(executions);
  const outcome = stoppedAtCanary && computed === 'executed' ? 'partially_executed' : computed;

  const document = receiptOf({
    mutation,
    preview,
    previewDigest: mutation.previewDigest,
    targets: await mutationRepo.targets(db, mutationId),
    priorStates: await mutationRepo.priorStates(db, mutationId),
    chain,
    executions,
    verifications: await executionRepo.verifications(db, mutationId),
    outcome,
  });

  const createdAt = new Date();

  await executionRepo.insertReceipt(db, {
    id: generateId(),
    mutationId,
    organisationId,
    document,
    digest: digestOf(document),
    /* The organisation's window at the moment the receipt is written; 078 bounds it at 730 days. */
    retainUntil: new Date(
      createdAt.getTime() + (await executionRepo.receiptDays(db, organisationId)) * 24 * 60 * 60 * 1000,
    ),
  });

  await executionRepo.settleRun(db, { id: mutationId, status: outcome });

  /* §15 — a revert is a mutation, and says which change it undid when it finishes. */
  if (mutation.manifest.reverts) {
    await writeAudit(db, {
      organisationId,
      membershipId: mutation.executedBy,
      userId: null,
      event: 'revert_executed',
      detail: { mutationId, revertsMutationId: mutation.manifest.reverts.mutationId, outcome },
    });
  }

  log.info({ mutationId, outcome }, 'Mutation finished');
  return outcome;
}

/**
 * The scheduled runner's half: a canary nobody decided on is stopped where it
 * is, with its receipt, rather than left paused forever.
 */
export async function expireCanary(organisationId: string, mutationId: string): Promise<void> {
  await runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      const mutation = await mutationRepo.lock(db, mutationId);
      if (!mutation || mutation.status !== 'canary_paused') return;

      await writeAudit(db, {
        organisationId,
        membershipId: null,
        userId: null,
        event: 'canary_halted',
        detail: { mutationId, reason: 'expired' },
      });
      await finish(db, organisationId, mutationId);
    }),
  );
}

/**
 * Automations §5 — the only write in the product with nobody present.
 *
 * ── WHY THIS IS NOT `execute` ─────────────────────────────────────────────
 *
 * `execute` requires `status = 'approved'` and an approval chain, and refuses
 * anybody who proposed or approved the change. An automation proposes its own
 * mutation and has no second person, so every call it made threw, was caught,
 * and was recorded as `refused`. The capability §5 describes — the route, the
 * permission, the bounds table and the audit event — could not be performed.
 *
 * ── AN AUTHORISATION STANDS IN FOR ONE APPROVER, AND ONLY ONE ─────────────
 *
 * Mutations §9 — "A connection with no policy requires one approver holding
 * mutation.approve on it" — and `unionOf` takes `Math.max(1, …)`, so EVERY
 * change needs at least one. Automations §5 says an authorised automation
 * writes with nobody present. The two reconcile in exactly one way: the
 * authorising person IS that approver, named in advance, bounded, and recorded
 * on every run.
 *
 * It cannot stand in for a second. Where the resolved policy asks for more than
 * one — a policy somebody configured, a floor a super admin set, or the bulk
 * tier's extra approver — this refuses and the automation falls back to
 * proposing. An authorisation that could satisfy a two-approver policy would be
 * a way to configure that policy away from inside an automation, which is the
 * thing floors exist to prevent.
 *
 * ── AND IT STILL PASSES EVERY OTHER GATE ──────────────────────────────────
 *
 * Automations §1 — "Nothing an automation does is exempt from the governance
 * that applies when a person does it." The write grant, the halted check, the
 * connector's own capability, the field policies and the read-back verification
 * are all in the queued run, unchanged.
 */
export async function executeAuthorised(
  actor: Actor,
  mutationId: string,
  authorisation: { id: string; authorisedBy: string },
): Promise<{ started: boolean; because?: string }> {
  const outcome = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const { mutation, authority } = await visibleMutation(db, actor, mutationId, { lock: true });

      if (mutation.status !== 'previewed') {
        return { started: false, because: 'that change is no longer a fresh preview' };
      }

      const connectionIds = mutation.preview.connections.map((connection) => connection.connectionId);
      const policies = await mutationPolicyRepo.livePolicies(db);
      const floors = await mutationPolicyRepo.floors(db);
      const proposerPaths = await scopeRepo.pathsForMembership(db, mutation.proposedBy);

      const policy = unionOf(
        connectionIds.map((connectionId) =>
          resolvePolicy({
            connectionId,
            policies,
            proposerPaths,
            floor: floors.find((floor) => floor.connectionId === connectionId) ?? null,
          }),
        ),
        mutation.preview.bulk,
      );

      if (policy.approvalsRequired > 1) {
        return {
          started: false,
          because:
            `the systems it writes to ask for ${policy.approvalsRequired} approvers, and an ` +
            `authorisation speaks for one`,
        };
      }

      /* The same two gates a person's execution passes. */
      await assertMayChange(db, actor, { revert: Boolean(mutation.manifest.reverts) });
      await assertOverConnections(db, authority, mutation, 'mutation.execute');

      if (mutation.expiresAt.getTime() <= Date.now()) {
        return { started: false, because: 'the preview lapsed before it could run' };
      }

      /*
       * CLAIMED FROM `previewed`, which is what makes this a different path
       * rather than a flag on the other one. The claim is conditional on the
       * status in the same statement, so two runners racing produce one write.
       */
      const claimed = await executionRepo.claim(db, {
        id: mutation.id,
        from: ['previewed'],
        /* §5 — "The receipt names who authorised the automation, not the
           automation itself, because a change with no human name attached is
           the thing an auditor rejects." */
        executedBy: authorisation.authorisedBy,
      });

      return claimed ? { started: true } : { started: false, because: 'something else claimed it first' };
    }),
  );

  if (outcome.started) enqueue(actor.organisationId, mutationId);
  return outcome;
}
