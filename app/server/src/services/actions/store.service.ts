// The mutation's records (spec 43.13, 45.7, 46.8): a mutation is written once, previewed,
// with its targets and prior states in the same transaction, its record values sealed under
// the organisation's data key first (intent, values, diff, prior states). Shared by actions
// and revert, whose revert is a mutation too (46.5).
//
// Object identity: a mutation target names its ontology object by the Silo object id every
// service derives for a single-source record (utils/siloObjectId.util.ts, spec 24.7): the
// organisation, the type, the connection, the source object and the record's identifier,
// so the same record has the same identity here, in the executor and in the state plane,
// and its commit log stays whole. A resolvable type's objects are the entity graph's; write-
// back addresses them through the record it writes, which is the same id when the type has
// one contributing object.

import { upperBound } from '../../utils/bayes.util.ts';
import type { ValueBinding } from '../../contracts/credential/recordValue.contract.ts';
import type { MutationView, Preview, Promotion } from '../../contracts/actions/mutation.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Mutation } from '../../models/action/mutation.model.ts';
import type { MutationTarget } from '../../models/action/mutationTarget.model.ts';
import type { PriorState } from '../../models/action/priorState.model.ts';
import {
  approvalChainRepo, blastRadiusResultRepo, mutationExecutionRepo, mutationRepo, mutationTargetRepo, mutationVerificationRepo, priorStateRepo,
  receiptRepo, revertRepo,
} from '../../repos/action/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { singleSourceObjectId } from '../../utils/siloObjectId.util.ts';
import { openValues, permitted, sealValues, type Context, type WriteBackDeps } from './deps.service.ts';
import { recordActionEvent, recordMutationStage } from './events.service.ts';
import type { BlastRow } from './blastRadius.service.ts';

export type Operation = 'create' | 'update_full' | 'update_partial' | 'delete' | 'upsert' | 'custom';
export type RiskClass = 'data' | 'bulk' | 'external' | 'physical';

/** A record's Silo object id (see the header). */
export function objectIdentity(organisationId: string, objectTypeId: string, connectionId: string, sourceObject: string, reference: string): string {
  return singleSourceObjectId(organisationId, objectTypeId, connectionId, sourceObject, reference);
}

export const bindings = {
  mutation: (id: string, column: 'intent' | 'manifest_values' | 'diff'): ValueBinding => ({ table: 'action.mutations', id, column }),
  priorState: (id: string): ValueBinding => ({ table: 'action.prior_states', id }),
  verification: (id: string, column: 'intended' | 'observed'): ValueBinding => ({ table: 'action.mutation_verifications', id, column }),
  receipt: (id: string): ValueBinding => ({ table: 'action.receipts', id }),
  ledgerCopy: (receiptId: string): ValueBinding => ({ table: 'action.ledger_copies', id: receiptId }),
  revertConflict: (id: string, column: 'post_write_value' | 'current_value'): ValueBinding => ({ table: 'action.revert_conflicts', id, column }),
};

export interface PlannedTarget {
  id: string;
  objectId: string;
  connectionId: string;
  sourceObject: string;
  /** For a create, a placeholder until verification captures the identifier. */
  entityReference: string;
  operation: Operation;
  /** A custom operation: the custom action invoked. */
  customAction?: string;
  /** Source fields written: empty for a delete; a custom action's declared changes. */
  fields: string[];
  /** Ontology properties changed, by API name. */
  properties: string[];
  newValues: Record<string, unknown>;
  /** Touched fields for an update, the full readable record for a delete, null for a create. */
  prior: Record<string, unknown> | null;
  idempotencyKey: string;
  connectorVersion: string;
}

export interface ExcludedTarget {
  objectId: string;
  connectionId: string | null;
  reference: string;
  operation: Operation;
  customAction?: string | undefined;
  reason: string;
}

export interface NewMutationInput {
  id: string;
  organisationId: string;
  actionTypeVersionId: string;
  objectTypeId: string;
  origin: 'action' | 'revert' | 'cron' | 'scenario_promotion';
  /** A promotion's origin (39.8): its scenario is recorded on the mutation; the rest is in the manifest. */
  promotion?: Promotion | undefined;
  /** Null for a Cron's mutation: its principal proposes it, on its authorising member's behalf (43.11). */
  proposerMembershipId: string | null;
  cron?: CronOrigin | undefined;
  resolutionPolicy: 'strict' | 'partial';
  riskClass: RiskClass;
  /** A generic governed edit (42.9), or a revert of one: countable as such. */
  genericEdit?: boolean | undefined;
  /** A physical Action's dry run (47.5), or the dry run's receipt a proposal followed. */
  dryRun?: boolean | undefined;
  dryRunReceiptId?: string | undefined;
  /** Structure only: the type and version, the operation, the field names, the object set by reference. */
  manifest: Record<string, unknown>;
  /** Parameter values and new values: sealed. */
  values: Record<string, unknown>;
  intent: string | undefined;
  preview: Preview;
  targets: PlannedTarget[];
  excluded: ExcludedTarget[];
  executionSeparated: boolean;
  /** The blast radius walk's references (43.7), stored with the targets they hang from. */
  blast?: readonly BlastRow[];
  /** Written in the same transaction (a revert's own rows). */
  also?: (db: Queryable) => Promise<void>;
}

export const diffHashOf = (preview: Preview): Buffer => sha256(canonicalJsonBytes(preview));

/** A Cron's mutation (43.11): its principal proposed it; its authorising member is the person it is for. */
export interface CronOrigin {
  principalId: string;
  authorisingMembershipId: string;
  mode: 'propose' | 'execute_within_bounds';
}

const cronColumns = (cron: CronOrigin | undefined) => cron === undefined ? {} : {
  proposerPrincipalId: cron.principalId, authorisingMembershipId: cron.authorisingMembershipId, cronMode: cron.mode,
};

/** Writes a previewed mutation, its targets and prior states, and its events. */
export async function persistMutation(deps: WriteBackDeps, ctx: Context, input: NewMutationInput): Promise<void> {
  const priorRows: { id: string; target: PlannedTarget; field: string | null; value: unknown; absent: boolean; full: boolean }[] = [];
  for (const target of input.targets) {
    if (target.operation === 'create') {
      priorRows.push({ id: uuidv7(), target, field: null, value: null, absent: true, full: false });
    } else {
      for (const [field, value] of Object.entries(target.prior ?? {})) {
        priorRows.push({ id: uuidv7(), target, field, value, absent: false, full: target.operation === 'delete' });
      }
    }
  }
  const sealItems = [
    { binding: bindings.mutation(input.id, 'manifest_values'), value: input.values },
    { binding: bindings.mutation(input.id, 'diff'), value: input.preview },
    ...(input.intent === undefined ? [] : [{ binding: bindings.mutation(input.id, 'intent'), value: input.intent }]),
    ...priorRows.filter((r) => !r.absent).map((r) => ({ binding: bindings.priorState(r.id), value: r.value })),
  ];
  const sealed = await sealValues(deps, ctx, sealItems);
  const manifestValues = sealed[0]!;
  const diff = sealed[1]!;
  const intent = input.intent === undefined ? null : sealed[2]!;
  const priorSealed = sealed.slice(input.intent === undefined ? 2 : 3);
  const diffHash = diffHashOf(input.preview);
  const now = new Date().toISOString();
  const rowCount = input.targets.length;

  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    await mutationRepo.insert(db, {
      id: input.id, organisationId: input.organisationId, intent, manifest: input.manifest as never, manifestValues,
      actionTypeVersionId: input.actionTypeVersionId, objectTypeId: input.objectTypeId, proposerMembershipId: input.proposerMembershipId, ...cronColumns(input.cron),
      origin: input.origin, scenarioId: input.promotion?.scenarioId ?? null, status: 'previewed', resolutionPolicy: input.resolutionPolicy,
      riskClass: input.riskClass, rowCount, genericEdit: input.genericEdit === true,
      dryRun: input.dryRun === true, dryRunReceiptId: input.dryRunReceiptId ?? null,
      diff, diffHash, executionSeparated: input.executionSeparated, previewedAt: now,
    });
    for (const target of input.targets) {
      await mutationTargetRepo.insert(db, {
        id: target.id, organisationId: input.organisationId, mutationId: input.id, connectionId: target.connectionId, objectId: target.objectId,
        entityReference: target.entityReference, operation: target.operation, customAction: target.customAction ?? null,
        fields: target.operation === 'delete' ? [] : target.fields, idempotencyKey: target.idempotencyKey, resolvedAt: now,
      });
    }
    for (const ex of input.excluded) {
      await mutationTargetRepo.insert(db, {
        id: uuidv7(), organisationId: input.organisationId, mutationId: input.id, connectionId: ex.connectionId, objectId: ex.objectId,
        entityReference: null, operation: ex.operation, customAction: ex.customAction ?? null, idempotencyKey: `${input.id}:excluded:${ex.objectId}`, excluded: true,
      });
    }
    let i = 0;
    for (const row of priorRows) {
      await priorStateRepo.insert(db, {
        id: row.id, organisationId: input.organisationId, mutationId: input.id, targetId: row.target.id, entityReference: row.target.entityReference,
        connectionId: row.target.connectionId, field: row.field, value: row.absent ? null : priorSealed[i++]!, valueAbsent: row.absent,
        fullRecord: row.full, readAt: now, connectorVersion: row.target.connectorVersion,
      });
    }
    for (const b of input.blast ?? []) {
      await blastRadiusResultRepo.insert(db, {
        id: uuidv7(), organisationId: input.organisationId, mutationId: input.id, sourceTargetId: b.sourceTargetId, kind: b.kind,
        connectionId: b.connectionId, dependentReference: b.dependentReference, via: b.via, linkTypeId: b.linkTypeId,
        dependentObjectId: b.dependentObjectId, repointable: b.repointable, hop: b.hop, bounded: b.bounded, computedAt: now,
      });
    }
    const event = {
      organisationId: input.organisationId, correlationId: ctx.correlationId, request: ctx.request, service: input.origin === 'revert' ? 'revert' as const : 'actions' as const,
      resource: { type: 'mutation' as const, id: input.id },
    };
    if (input.preview.blastRadius.computed) {
      const radius = input.preview.blastRadius;
      await recordActionEvent(db, { ...event, event: 'blast_radius_computed', detail: {
        dependants: input.blast?.length ?? 0, hops: radius.hops ?? 0, bounded_at_hop: radius.boundedAtHop ?? null,
        cascading: radius.counts?.cascading_delete ?? 0,
      } });
    }
    const fields = [...new Set(input.targets.flatMap((t) => t.properties))].sort().join(',').slice(0, 200);
    await recordActionEvent(db, { ...event, event: 'mutation_proposed', detail: { action_type_version_id: input.actionTypeVersionId, origin: input.origin, row_count: rowCount } });
    if (input.promotion !== undefined) {
      await recordActionEvent(db, { ...event, event: 'scenario_action_promoted', detail: {
        scenario_id: input.promotion.scenarioId, branch_id: input.promotion.branchId, staged_action_id: input.promotion.stagedActionId,
        rows_together: input.promotion.rowsTogether, kept_current: input.promotion.keepCurrent.length,
      } });
    }
    await recordActionEvent(db, { ...event, event: 'mutation_resolved', detail: { resolved: rowCount, excluded: input.excluded.length, policy: input.resolutionPolicy } });
    await recordActionEvent(db, { ...event, event: 'preview_generated', detail: { risk_class: input.riskClass, row_count: rowCount, fields, diff_hash: diffHash.toString('hex') } });
    await recordMutationStage(db, { organisationId: input.organisationId, correlationId: ctx.correlationId, mutationId: input.id, stage: 'previewed', rowCount });
    await input.also?.(db);
  });
}

/** A mutation refused before a preview existed: nothing was read or written (43.10 refused). */
export async function persistRefusal(deps: WriteBackDeps, ctx: Context, input: {
  id: string; organisationId: string; actionTypeVersionId: string; objectTypeId: string; proposerMembershipId: string | null; riskClass: RiskClass;
  cron?: CronOrigin | undefined; promotion?: Promotion | undefined; genericEdit?: boolean | undefined;
  resolutionPolicy: 'strict' | 'partial'; manifest: Record<string, unknown>; values: Record<string, unknown>; intent: string | undefined;
  stage: 'intent' | 'resolve' | 'policy_gate' | 'plan' | 'read_prior_state'; reason: string; executionSeparated: boolean;
}): Promise<void> {
  const sealed = await sealValues(deps, ctx, [
    { binding: bindings.mutation(input.id, 'manifest_values'), value: input.values },
    ...(input.intent === undefined ? [] : [{ binding: bindings.mutation(input.id, 'intent'), value: input.intent }]),
  ]);
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    await mutationRepo.insert(db, {
      id: input.id, organisationId: input.organisationId, intent: input.intent === undefined ? null : sealed[1]!, manifest: input.manifest as never,
      manifestValues: sealed[0]!, actionTypeVersionId: input.actionTypeVersionId, objectTypeId: input.objectTypeId,
      proposerMembershipId: input.proposerMembershipId, origin: input.promotion !== undefined ? 'scenario_promotion' : input.cron === undefined ? 'action' : 'cron',
      scenarioId: input.promotion?.scenarioId ?? null, ...cronColumns(input.cron),
      status: 'refused', resolutionPolicy: input.resolutionPolicy, genericEdit: input.genericEdit === true,
      riskClass: input.riskClass, rowCount: 0, refusedStage: input.stage, refusalReason: input.reason.slice(0, 500),
      executionSeparated: input.executionSeparated, completedAt: new Date().toISOString(),
    });
    await recordActionEvent(db, {
      organisationId: input.organisationId, correlationId: ctx.correlationId, event: 'mutation_refused', request: ctx.request, service: 'actions',
      resource: { type: 'mutation', id: input.id }, detail: { stage: input.stage, reason: input.reason.slice(0, 200) },
    });
    await recordMutationStage(db, { organisationId: input.organisationId, correlationId: ctx.correlationId, mutationId: input.id, stage: 'refused', rowCount: 0 });
  });
}

// ----------------------------------------------------------------------------- reading

export interface LoadedMutation {
  mutation: Mutation;
  targets: MutationTarget[];
  priorStates: PriorState[];
}

export async function loadMutation(db: Queryable, id: string): Promise<LoadedMutation> {
  const mutation = await mutationRepo.findById(db, id);
  if (!mutation) throw new AppError('not_found', 'no such mutation', { code: 'mutation.not_found' });
  return { mutation, targets: await mutationTargetRepo.listByMutation(db, id), priorStates: await priorStateRepo.listByMutation(db, id) };
}

/** Prior values by target and field, opened. */
export async function openPriorStates(deps: WriteBackDeps, ctx: Context, states: readonly PriorState[]): Promise<Map<string, Record<string, unknown>>> {
  const sealed = states.filter((s) => s.value !== null && s.field !== null);
  const opened = await openValues(deps, ctx, sealed.map((s) => ({ binding: bindings.priorState(s.id), sealed: s.value! })));
  const out = new Map<string, Record<string, unknown>>();
  sealed.forEach((s, i) => {
    const record = out.get(s.targetId!) ?? {};
    record[s.field!] = opened[i];
    out.set(s.targetId!, record);
  });
  return out;
}

export async function openPreview(deps: WriteBackDeps, ctx: Context, mutation: Mutation): Promise<Preview | null> {
  if (mutation.diff === null) return null;
  return (await openValues(deps, ctx, [{ binding: bindings.mutation(mutation.id, 'diff'), sealed: mutation.diff }]))[0] as Preview;
}

export async function openManifestValues(deps: WriteBackDeps, ctx: Context, mutation: Mutation): Promise<Record<string, unknown>> {
  if (mutation.manifestValues === null) throw new AppError('conflict', 'the mutation\'s values were purged', { code: 'mutation.purged' });
  return (await openValues(deps, ctx, [{ binding: bindings.mutation(mutation.id, 'manifest_values'), sealed: mutation.manifestValues }]))[0] as Record<string, unknown>;
}

/** Whether this member may read the mutation's values: its proposer (a Cron's authorising member), or a holder of mutation.approve. */
export async function mayReadValues(deps: WriteBackDeps, ctx: Context, mutation: Mutation): Promise<boolean> {
  if (ctx.request.membershipId !== undefined && ctx.request.membershipId === (mutation.proposerMembershipId ?? mutation.authorisingMembershipId)) return true;
  if (ctx.request.membershipId === undefined) return false;
  return permitted(deps, ctx, 'mutation.approve');
}

/** What a waiting canary's random sample says about the rest (45.4; decision 2026-11-11). */
function canaryEvidenceOf(status: Mutation['status'], executions: readonly { phase: string; recordsAttempted: number }[],
  outcomes: { verified: number; diverged: number; failed: number }): MutationView['canaryEvidence'] {
  if (status !== 'canary') return null;
  const sampled = executions.filter((e) => e.phase === 'canary').reduce((n, e) => n + e.recordsAttempted, 0);
  if (sampled === 0) return null;
  const problems = Math.min(sampled, outcomes.diverged + outcomes.failed);
  const bound = Math.round(upperBound(problems, sampled) * 10_000) / 10_000;
  return {
    sampled, problems, problemRateUpper95: bound, randomSample: true,
    statement: `${problems} of ${sampled} records drawn at random diverged or failed. With 95% confidence, fewer than ${(bound * 100).toFixed(1)}% of the rest would, if they behave like the sample.`,
  };
}

export async function mutationView(deps: WriteBackDeps, ctx: Context, id: string, options: { withPreview?: boolean } = {}): Promise<MutationView> {
  const { mutation, chain, executions, outcomes, receipt, revert } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const mutation = await mutationRepo.findById(db, id);
    if (!mutation) throw new AppError('not_found', 'no such mutation', { code: 'mutation.not_found' });
    return {
      mutation,
      chain: await approvalChainRepo.latestForMutation(db, id),
      executions: await mutationExecutionRepo.listByMutation(db, id),
      outcomes: await mutationVerificationRepo.outcomesByMutation(db, id),
      receipt: await receiptRepo.findByMutationId(db, { organisationId: mutation.organisationId, mutationId: id }),
      revert: mutation.origin === 'revert' ? await revertRepo.findByNewMutationId(db, { organisationId: mutation.organisationId, newMutationId: id }) : undefined,
    };
  }, { readOnly: true });
  const showPreview = options.withPreview !== false && await mayReadValues(deps, ctx, mutation);
  return {
    id: mutation.id, status: mutation.status, origin: mutation.origin, actionTypeVersionId: mutation.actionTypeVersionId, genericEdit: mutation.genericEdit,
    dryRun: mutation.dryRun, dryRunReceiptId: mutation.dryRunReceiptId,
    objectTypeId: mutation.objectTypeId,
    riskClass: mutation.riskClass, rowCount: mutation.rowCount, resolutionPolicy: mutation.resolutionPolicy,
    proposerMembershipId: mutation.proposerMembershipId, executionSeparated: mutation.executionSeparated, refusedStage: mutation.refusedStage,
    refusalReason: mutation.refusalReason, diffHash: mutation.diffHash === null ? null : mutation.diffHash.toString('hex'), createdAt: mutation.createdAt,
    previewedAt: mutation.previewedAt, completedAt: mutation.completedAt, expiresAt: mutation.expiresAt,
    preview: showPreview ? await openPreview(deps, ctx, mutation) : null,
    chain: chain === undefined ? null : {
      id: chain.id, status: chain.status, approvalsRequired: chain.approvalsRequired, approvalsReceived: chain.approvalsReceived, expiresAt: chain.expiresAt,
    },
    executions: executions.map((e) => ({
      connectionId: e.connectionId, phase: e.phase, status: e.status, recordsAttempted: e.recordsAttempted, recordsApplied: e.recordsApplied, error: e.error,
    })),
    verification: outcomes,
    canaryEvidence: canaryEvidenceOf(mutation.status, executions, outcomes),
    receiptId: receipt?.id ?? null,
    revertId: revert?.id ?? null,
    promotion: mutation.origin === 'scenario_promotion' ? ((mutation.manifest as { promotion?: MutationView['promotion'] }).promotion ?? null) : null,
  };
}
