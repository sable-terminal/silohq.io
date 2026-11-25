// Scenario branches (spec 39.8): staging, opening (staleness, effect, propagation),
// conflict decisions, comparison, promotion and close. The contract is
// contracts/simulation/branch.contract.ts; the pure part (the three-way check and the
// effects) is branchEffects.service.ts.
//
// A branch is its creator's, as its scenario is. Staging asks actions to check the Action
// (intent, resolve, policy gate, and the prior state of the touched properties, read
// through connect-runtime as a proposal reads it), charges a compile under the request's
// key, and keeps the staged Action: its manifest (structure only), its parameters sealed,
// and per target and touched property the base and the staged value, sealed under the
// organisation's key (credential). Opening checks each staged Action against the record
// now, keeps the staleness and the conflicts (names and decisions only), applies each effect
// and walks the graph as a run of the branch, charged as a re-run. Promotion checks again
// and proposes each promotable staged Action through actions, with the branch as origin and
// the bulk guardrails counted across everything promoted together; actions reads prior
// state and builds the preview afresh, never from the base, and approval is requested as
// for any proposal. Promotion never approves.
//
// Nothing here writes to a source: simulation calls no execution path (the architecture
// test asserts it), and the executor and connect-runtime refuse a request naming a branch.

import { checkMutation, listRecentWrites, proposeMutation, type CheckOutcome } from '../../contracts/actions/mutation.contract.ts';
import { openRecordValues, sealRecordValues, type ValueBinding } from '../../contracts/credential/recordValue.contract.ts';
import { charge } from '../../contracts/metering/charge.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import type { BranchView, OpenedBranchView, StagedActionView } from '../../contracts/simulation/branch.contract.ts';
import type { RunView, StatedFailure } from '../../contracts/simulation/scenario.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Scenario } from '../../models/simulation/scenario.model.ts';
import type { ScenarioBranch } from '../../models/simulation/scenarioBranch.model.ts';
import type { StagedAction } from '../../models/simulation/stagedAction.model.ts';
import {
  graphStateRepo, scenarioBranchRepo, scenarioRepo, simulationResultRepo, simulationRunRepo, stagedActionBaseRepo, stagedActionRepo,
} from '../../repos/simulation/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { canvasViewRepo } from '../../repos/clone/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  actionStaleness, checkTarget, effectOf, RECORD_EXISTS, type BaseEntry, type Resolution, type Staleness, type StagedOperation, type StagedTarget,
  type TargetCheck,
} from './branchEffects.service.ts';
import { demand, member, readManifest, recordEvent, secondsOf, type Actor, type Context, type SimulationDeps } from './deps.service.ts';
import type { Origin } from './propagation.service.ts';
import { readRun, walkAndRecord } from './scenarios.service.ts';

const PHYSICAL_STATEMENT = 'Physical actuation: simulated here. On promotion two people approve it, and the physical effect between execution and revert cannot be undone.';
/** Seal and open at most this many values a call (the credential service's bound). */
const VALUE_BATCH = 5_000;

const branchNotFound = (): AppError => new AppError('not_found', 'no such branch', { code: 'simulation.branch_not_found' });
const stagedNotFound = (): AppError => new AppError('not_found', 'no such staged Action', { code: 'simulation.staged_action_not_found' });

/** A staged Action's manifest: structure and identifiers only, never a record value. */
interface StagedManifest {
  actionTypeId: string;
  actionTypeVersionId: string;
  objectTypeId: string;
  operation: StagedOperation;
  riskClass: string;
  physical: boolean;
  targets: { objectId: string; connectionId: string; reference: string; operation: StagedOperation }[];
  /** Touched properties (or fields where no property maps them), by name. */
  properties: string[];
  parameterNames: string[];
  createOn?: string;
}

interface StoredConflict {
  objectId: string;
  connectionId: string;
  reference: string;
  property: string;
  changedBy: string | null;
  changedByKnown: boolean;
  resolution: Resolution | null;
}

type Checked = Extract<CheckOutcome, { outcome: 'checked' }>;

const call = (ctx: Context) => ({ request: ctx.request, correlationId: ctx.correlationId });
const control = (deps: SimulationDeps) => deps.databases.pool('control');
const targetKey = (connectionId: string, reference: string): string => `${connectionId}\u0000${reference}`;

const bindings = {
  values: (id: string): ValueBinding => ({ table: 'simulation.staged_actions', id, column: 'manifest_values' }),
  base: (id: string, column: 'base_value' | 'staged_value'): ValueBinding => ({ table: 'simulation.staged_action_bases', id, column }),
};

async function seal(deps: SimulationDeps, ctx: Context, items: readonly { binding: ValueBinding; value: unknown }[]): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (let i = 0; i < items.length; i += VALUE_BATCH) {
    const batch = items.slice(i, i + VALUE_BATCH);
    const sealed = await deps.services.call(sealRecordValues, {
      body: { items: batch.map((b) => ({ binding: b.binding, value: canonicalJsonBytes({ v: b.value ?? null }).toString('base64') })) },
    }, call(ctx));
    out.push(...sealed.items.map((s) => Buffer.from(s, 'base64')));
  }
  return out;
}

async function open(deps: SimulationDeps, ctx: Context, items: readonly { binding: ValueBinding; sealed: Buffer }[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < items.length; i += VALUE_BATCH) {
    const batch = items.slice(i, i + VALUE_BATCH);
    const opened = await deps.services.call(openRecordValues, {
      body: { items: batch.map((b) => ({ binding: b.binding, sealed: b.sealed.toString('base64') })) },
    }, call(ctx));
    out.push(...opened.items.map((s) => (JSON.parse(Buffer.from(s, 'base64').toString('utf8')) as { v: unknown }).v));
  }
  return out;
}

// ----------------------------------------------------------------------------- views

const retentionDaysOf = (interval: string): number => Number(/(\d+) day/.exec(interval)?.[1] ?? 0);

export function stagedActionView(sa: StagedAction): StagedActionView {
  const m = sa.manifest as unknown as StagedManifest;
  return {
    id: sa.id, sequence: sa.sequence, actionTypeId: sa.actionTypeId, actionTypeVersionId: m.actionTypeVersionId, objectTypeId: m.objectTypeId,
    operation: m.operation, targets: m.targets.length, properties: m.properties, staleness: sa.staleness, stalenessCheckedAt: sa.stalenessCheckedAt,
    conflicts: (sa.conflicts ?? []) as unknown as StoredConflict[], physical: m.physical, statement: m.physical ? PHYSICAL_STATEMENT : null,
    stagedAt: sa.createdAt, promotedActionId: sa.promotedActionId, promotedAt: sa.promotedAt,
  };
}

async function branchViewOf(db: Queryable, branch: ScenarioBranch): Promise<BranchView> {
  const staged = (await stagedActionRepo.listForBranch(db, branch.id)).map(stagedActionView);
  const unpromoted = staged.filter((s) => s.promotedActionId === null);
  const count = (s: Staleness) => unpromoted.filter((x) => x.staleness === s).length;
  return {
    id: branch.id, scenarioId: branch.scenarioId, name: branch.name, label: `Scenario branch: ${branch.name}`, status: branch.status,
    retentionDays: retentionDaysOf(branch.retention), createdAt: branch.createdAt, closedAt: branch.closedAt, basesPurgeAt: branch.basesPurgeAt,
    basesPurged: branch.basesPurgedAt !== null, version: branch.version,
    counts: { clean: count('clean'), conflicted: count('conflicted'), alreadyApplied: count('already_applied'), orphaned: count('orphaned'), promoted: staged.length - unpromoted.length },
    stagedActions: staged,
  };
}

async function ownBranch(deps: SimulationDeps, who: Actor & { membershipId: string }, branchId: string): Promise<{ branch: ScenarioBranch; scenario: Scenario }> {
  const found = await inTransaction(control(deps), who.request, async (db) => {
    const branch = await scenarioBranchRepo.findById(db, branchId);
    return { branch, scenario: branch === undefined ? undefined : await scenarioRepo.findById(db, branch.scenarioId) };
  }, { readOnly: true });
  // Private by default, as its scenario is: another member's branch is not found.
  if (!found.branch || !found.scenario || found.branch.createdBy !== who.membershipId || found.scenario.archivedAt !== null) throw branchNotFound();
  return { branch: found.branch, scenario: found.scenario };
}

async function ownStaged(deps: SimulationDeps, who: Actor & { membershipId: string }, stagedActionId: string) {
  const staged = await inTransaction(control(deps), who.request, (db) => stagedActionRepo.findById(db, stagedActionId), { readOnly: true });
  if (staged === undefined) throw stagedNotFound();
  const { branch, scenario } = await ownBranch(deps, who, staged.branchId).catch(() => { throw stagedNotFound(); });
  return { staged, branch, scenario };
}

const mustBeOpen = (branch: ScenarioBranch): void => {
  if (branch.status === 'closed' || branch.status === 'promoted') {
    throw new AppError('conflict', `the branch is ${branch.status}: nothing more is staged or promoted in it`, { code: 'simulation.branch_not_open' });
  }
};

/** The branch a staged Action belongs to, for its owner. */
export async function branchOfStaged(deps: SimulationDeps, ctx: Context, stagedActionId: string): Promise<string> {
  return (await ownStaged(deps, member(ctx), stagedActionId)).branch.id;
}

/** A retried open, answered from the first: the branch as it stands and the run; values are read again only on a new open. */
export async function replayOpen(deps: SimulationDeps, ctx: Context, runId: string): Promise<OpenedBranchView> {
  const who = member(ctx);
  const run = await inTransaction(control(deps), who.request, (db) => simulationRunRepo.findById(db, runId), { readOnly: true });
  if (run?.branchId == null) throw branchNotFound();
  return { branch: await getBranch(deps, ctx, run.branchId), checks: [], run: await readRun(deps, ctx, runId) };
}

/** A retried promotion, answered from the first: what is promoted in the branch. */
export async function replayPromotion(deps: SimulationDeps, ctx: Context, branchId: string) {
  const branch = await getBranch(deps, ctx, branchId);
  return {
    branch, promoted: branch.stagedActions.filter((s) => s.promotedActionId !== null).map((s) => ({ stagedActionId: s.id, mutationId: s.promotedActionId! })),
    notPromoted: [],
  };
}

export async function getBranch(deps: SimulationDeps, ctx: Context, branchId: string): Promise<BranchView> {
  const who = member(ctx);
  const { branch } = await ownBranch(deps, who, branchId);
  return inTransaction(control(deps), who.request, (db) => branchViewOf(db, branch), { readOnly: true });
}

export async function listBranches(deps: SimulationDeps, ctx: Context, scenarioId: string): Promise<BranchView[]> {
  const who = member(ctx);
  return inTransaction(control(deps), who.request, async (db) => {
    const scenario = await scenarioRepo.findById(db, scenarioId);
    if (!scenario || scenario.ownerMembershipId !== who.membershipId || scenario.archivedAt !== null) {
      throw new AppError('not_found', 'no such scenario', { code: 'simulation.scenario_not_found' });
    }
    const branches = (await scenarioBranchRepo.listForScenario(db, scenarioId)).filter((b) => b.createdBy === who.membershipId);
    return Promise.all(branches.map((b) => branchViewOf(db, b)));
  }, { readOnly: true });
}

// ----------------------------------------------------------------------------- create and close

/** scenario.stage: a branch of a scenario the member owns, or of a new branch scenario. */
export async function createBranch(deps: SimulationDeps, ctx: Context, input: {
  name: string; retentionDays: number;
  from: { kind: 'scenario'; scenarioId: string }
    | { kind: 'object_view' | 'finding' | 'canvas'; scenario: { name: string; mode: 'deterministic' | 'probabilistic'; bounds: { hops: number; fanOut: number; iterations?: number | undefined } } };
}): Promise<BranchView> {
  const who = member(ctx);
  await demand(deps, ctx, 'scenario.stage');
  return inTransaction(control(deps), who.request, async (db) => {
    let scenario: Scenario;
    if (input.from.kind === 'scenario') {
      const found = await scenarioRepo.findById(db, input.from.scenarioId);
      if (!found || found.ownerMembershipId !== who.membershipId || found.archivedAt !== null) {
        throw new AppError('not_found', 'no such scenario', { code: 'simulation.scenario_not_found' });
      }
      scenario = found;
    } else {
      const graphVersion = await graphStateRepo.current(db, who.organisationId);
      scenario = await scenarioRepo.insert(db, {
        id: uuidv7(), organisationId: who.organisationId, ownerMembershipId: who.membershipId, name: input.from.scenario.name, kind: 'branch',
        statedFailure: null, mode: input.from.scenario.mode, bounds: JSON.parse(JSON.stringify(input.from.scenario.bounds)) as Scenario['bounds'],
        graphVersion: String(graphVersion),
      });
      await recordEvent(db, who, ctx.correlationId, {
        event: 'scenario_saved', resource: { type: 'scenario', id: scenario.id }, detail: { form: null, objects: 0, graph_version: graphVersion, kind: 'branch' },
      });
    }
    if (await scenarioBranchRepo.findByScenarioIdAndName(db, { organisationId: who.organisationId, scenarioId: scenario.id, name: input.name })) {
      throw new AppError('conflict', 'the scenario already has a branch of that name', { code: 'simulation.branch_name_taken' });
    }
    const branch = await scenarioBranchRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, scenarioId: scenario.id, name: input.name, createdBy: who.membershipId,
      retention: `${input.retentionDays} days`,
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'branch_created', resource: { type: 'scenario_branch', id: branch.id },
      detail: { scenario_id: scenario.id, opened_from: input.from.kind, retention_days: input.retentionDays },
    });
    return branchViewOf(db, branch);
  });
}

/** Close: nothing more is staged or promoted; the bases purge when the retention ends. */
export async function closeBranch(deps: SimulationDeps, ctx: Context, branchId: string, version: number): Promise<BranchView> {
  const who = member(ctx);
  const { branch } = await ownBranch(deps, who, branchId);
  if (branch.status === 'closed') throw new AppError('conflict', 'the branch is already closed', { code: 'simulation.branch_not_open' });
  return inTransaction(control(deps), who.request, async (db) => {
    const closed = await scenarioBranchRepo.close(db, branch.id, version);
    if (closed === undefined) throw new AppError('conflict', 'the branch changed since you read it', { code: 'simulation.stale_version' });
    return branchViewOf(db, closed);
  });
}

// ----------------------------------------------------------------------------- staging

const refusalError = (refused: Extract<CheckOutcome, { outcome: 'refused' }>): AppError =>
  new AppError(refused.stage === 'policy_gate' ? 'forbidden' : 'validation', `staging refused at ${refused.stage}: ${refused.reason}`, {
    code: 'simulation.stage_refused', details: { stage: refused.stage, reason: refused.reason.slice(0, 200) },
  });

/** Each target's base entries, from the check: touched properties, or the record's existence for a delete. */
function entriesOf(t: Checked['targets'][number]): BaseEntry[] {
  if (t.operation === 'delete') return [{ property: RECORD_EXISTS, field: RECORD_EXISTS, base: true, staged: false }];
  return t.fields.map((f) => ({ property: f.property ?? f.field, field: f.field, base: t.operation === 'create' ? null : f.current, staged: f.staged }));
}

function manifestOf(input: { actionTypeId: string; parameters: Record<string, unknown>; createOn?: string | undefined }, checked: Checked): StagedManifest {
  return {
    actionTypeId: input.actionTypeId, actionTypeVersionId: checked.actionTypeVersionId, objectTypeId: checked.objectTypeId,
    operation: checked.targets[0]!.operation, riskClass: checked.riskClass, physical: checked.physical,
    targets: checked.targets.map((t) => ({ objectId: t.objectId, connectionId: t.connectionId, reference: t.reference, operation: t.operation })),
    properties: [...new Set(checked.targets.flatMap((t) => entriesOf(t).map((e) => e.property)))].sort(),
    parameterNames: Object.keys(input.parameters).sort(),
    ...(input.createOn === undefined ? {} : { createOn: input.createOn }),
  };
}

/**
 * The bases of a check, sealed, as rows for the staged Action. A value is sealed to its row,
 * so a re-staged base keeps the id of the row it replaces (`existing`, by target and property).
 */
async function baseRows(deps: SimulationDeps, ctx: Context, who: Actor, stagedActionId: string, checked: Checked,
  existing: ReadonlyMap<string, string> = new Map()) {
  const now = new Date().toISOString();
  const rows = checked.targets.flatMap((t) => entriesOf(t).map((e) => ({
    id: existing.get(`${targetKey(t.connectionId, t.reference)}\u0000${e.property}`) ?? uuidv7(), organisationId: who.organisationId, stagedActionId, objectTypeId: checked.objectTypeId, objectKey: t.reference, connectionId: t.connectionId,
    property: e.property, base: e.base, staged: e.staged, readAt: now,
  })));
  const sealed = await seal(deps, ctx, rows.flatMap((r) => [
    { binding: bindings.base(r.id, 'base_value'), value: r.base }, { binding: bindings.base(r.id, 'staged_value'), value: r.staged },
  ]));
  return rows.map((r, i) => ({
    id: r.id, organisationId: r.organisationId, stagedActionId: r.stagedActionId, objectTypeId: r.objectTypeId, objectKey: r.objectKey,
    connectionId: r.connectionId, property: r.property, baseValue: sealed[2 * i]!, stagedValue: sealed[2 * i + 1]!, readAt: r.readAt,
  }));
}

async function chargeCompile(deps: SimulationDeps, ctx: Context, correlationId: string): Promise<void> {
  // Staging compiles an intent: metered as a compile, under the request's key (39.9).
  await deps.services.call(charge, { body: { operation: 'compile', correlationId } }, { ...call(ctx), idempotencyKey: ctx.idempotencyKey ?? correlationId });
}

/** scenario.stage: check an Action as a proposal would be, then keep it in the branch with its bases. */
export async function stageAction(deps: SimulationDeps, ctx: Context, branchId: string, input: {
  actionTypeId: string; parameters: Record<string, unknown>; objects: { connectionId: string; reference: string }[]; createOn?: string | undefined;
}): Promise<StagedActionView> {
  const who = member(ctx);
  await demand(deps, ctx, 'scenario.stage');
  const { branch } = await ownBranch(deps, who, branchId);
  mustBeOpen(branch);
  if (input.objects.some((o) => o.reference.startsWith('new:'))) {
    throw new AppError('validation', 'staging an Action on a record an earlier staged Action creates is not built: it needs branch-local identifiers remapped at promotion (an open decision, spec 39.14)',
      { code: 'simulation.branch_local_object' });
  }
  const checked = await deps.services.call(checkMutation, {
    body: { actionTypeId: input.actionTypeId, parameters: input.parameters as never, objects: input.objects, createOn: input.createOn, resolutionPolicy: 'strict' },
  }, call(ctx));
  if (checked.outcome === 'refused') throw refusalError(checked);
  const id = uuidv7();
  await chargeCompile(deps, ctx, id);
  const manifest = manifestOf(input, checked);
  const [values] = await seal(deps, ctx, [{ binding: bindings.values(id), value: { parameters: input.parameters } }]);
  const bases = await baseRows(deps, ctx, who, id, checked);
  return inTransaction(control(deps), who.request, async (db) => {
    const staged = await stagedActionRepo.insert(db, {
      id, organisationId: who.organisationId, branchId, sequence: await stagedActionRepo.nextSequence(db, branchId), actionTypeId: input.actionTypeId,
      manifest: manifest as never, manifestValues: values!, stagedBy: who.membershipId, stalenessCheckedAt: new Date().toISOString(),
    });
    for (const b of bases) await stagedActionBaseRepo.insert(db, b);
    await recordEvent(db, who, ctx.correlationId, {
      event: 'action_staged', resource: { type: 'staged_action', id },
      detail: { branch_id: branchId, action_type_id: input.actionTypeId, operation: manifest.operation, targets: manifest.targets.length, physical: manifest.physical },
    });
    return stagedActionView(staged);
  });
}

/** scenario.stage: check the staged Action again against the record now; its base becomes current and it is clean. */
export async function restageAction(deps: SimulationDeps, ctx: Context, stagedActionId: string): Promise<StagedActionView> {
  const who = member(ctx);
  await demand(deps, ctx, 'scenario.stage');
  const { staged, branch } = await ownStaged(deps, who, stagedActionId);
  mustBeOpen(branch);
  if (staged.promotedActionId !== null) throw new AppError('conflict', 'the staged Action is promoted', { code: 'simulation.staged_promoted' });
  const manifest = staged.manifest as unknown as StagedManifest;
  const parameters = await parametersOf(deps, ctx, staged);
  const checked = await deps.services.call(checkMutation, {
    body: {
      actionTypeId: manifest.actionTypeId, parameters: parameters as never, objects: liveObjects(manifest), createOn: manifest.createOn, resolutionPolicy: 'strict',
    },
  }, call(ctx));
  if (checked.outcome === 'refused') throw refusalError(checked);
  await chargeCompile(deps, ctx, uuidv7());
  const prior = await inTransaction(control(deps), who.request, (db) => stagedActionBaseRepo.listForStagedAction(db, staged.id), { readOnly: true });
  const bases = await baseRows(deps, ctx, who, staged.id, checked,
    new Map(prior.map((r) => [`${targetKey(r.connectionId, r.objectKey)}\u0000${r.property}`, r.id])));
  return inTransaction(control(deps), who.request, async (db) => {
    for (const b of bases) await stagedActionBaseRepo.upsert(db, b);
    const updated = await stagedActionRepo.update(db, staged.id, {
      manifest: manifestOf({ actionTypeId: manifest.actionTypeId, parameters, createOn: manifest.createOn }, checked) as never,
      staleness: 'clean', conflicts: null, stalenessCheckedAt: new Date().toISOString(), version: staged.version + 1,
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'action_staged', resource: { type: 'staged_action', id: staged.id },
      detail: { branch_id: branch.id, action_type_id: manifest.actionTypeId, restaged: true, targets: checked.targets.length },
    });
    return stagedActionView(updated!);
  });
}

/** scenario.stage: the person's decision on conflicted properties: keep the staged value, or take the value now. */
export async function resolveConflicts(deps: SimulationDeps, ctx: Context, stagedActionId: string,
  resolutions: { connectionId: string; reference: string; property: string; choice: Resolution }[]): Promise<StagedActionView> {
  const who = member(ctx);
  await demand(deps, ctx, 'scenario.stage');
  const { staged, branch } = await ownStaged(deps, who, stagedActionId);
  mustBeOpen(branch);
  if (staged.promotedActionId !== null) throw new AppError('conflict', 'the staged Action is promoted', { code: 'simulation.staged_promoted' });
  const conflicts = [...((staged.conflicts ?? []) as unknown as StoredConflict[])];
  for (const r of resolutions) {
    const found = conflicts.find((c) => c.connectionId === r.connectionId && c.reference === r.reference && c.property === r.property);
    if (found === undefined) {
      throw new AppError('validation', `no conflict on ${r.property} of that record: open the branch to check it again`, { code: 'simulation.no_such_conflict' });
    }
    found.resolution = r.choice;
  }
  const unresolved = conflicts.some((c) => c.resolution === null);
  return inTransaction(control(deps), who.request, async (db) => {
    const updated = await stagedActionRepo.update(db, staged.id, {
      conflicts: conflicts as never, staleness: staged.staleness === 'conflicted' && !unresolved ? 'clean' : staged.staleness, version: staged.version + 1,
    });
    return stagedActionView(updated!);
  });
}

// ----------------------------------------------------------------------------- checking

async function parametersOf(deps: SimulationDeps, ctx: Context, staged: StagedAction): Promise<Record<string, unknown>> {
  if (staged.manifestValues === null) {
    throw new AppError('conflict', 'the branch\'s retention has ended: its staged values are purged', { code: 'simulation.branch_purged' });
  }
  const [values] = await open(deps, ctx, [{ binding: bindings.values(staged.id), sealed: staged.manifestValues }]);
  return ((values as { parameters?: Record<string, unknown> } | null)?.parameters) ?? {};
}

const liveObjects = (m: StagedManifest) => m.targets.filter((t) => t.operation !== 'create').map((t) => ({ connectionId: t.connectionId, reference: t.reference }));

/** The staged targets with their bases, opened. */
async function targetsOf(deps: SimulationDeps, ctx: Context, who: Actor, staged: StagedAction): Promise<{ targets: StagedTarget[]; readAt: string | null }> {
  const manifest = staged.manifest as unknown as StagedManifest;
  const rows = await inTransaction(control(deps), who.request, (db) => stagedActionBaseRepo.listForStagedAction(db, staged.id), { readOnly: true });
  if (rows.some((r) => r.purgedAt !== null)) throw new AppError('conflict', 'the branch\'s retention has ended: its bases are purged', { code: 'simulation.branch_purged' });
  const opened = await open(deps, ctx, rows.flatMap((r) => [
    { binding: bindings.base(r.id, 'base_value'), sealed: r.baseValue! }, { binding: bindings.base(r.id, 'staged_value'), sealed: r.stagedValue! },
  ]));
  const byTarget = new Map<string, BaseEntry[]>();
  rows.forEach((r, i) => {
    const k = targetKey(r.connectionId, r.objectKey);
    byTarget.set(k, [...(byTarget.get(k) ?? []), { property: r.property, field: r.property, base: opened[2 * i], staged: opened[2 * i + 1] }]);
  });
  const readAt = rows.length === 0 ? null : rows.map((r) => r.readAt).sort()[0]!;
  return {
    readAt,
    targets: manifest.targets.map((t) => ({ ...t, entries: byTarget.get(targetKey(t.connectionId, t.reference)) ?? [] })),
  };
}

interface Recheck {
  staged: StagedAction;
  manifest: StagedManifest;
  refusal: { stage: string; reason: string } | null;
  targets: TargetCheck[];
  conflicts: StoredConflict[];
  staleness: Staleness;
  parameters: Record<string, unknown>;
}

/**
 * One staged Action against the record now (39.8 staleness): actions checks it again in
 * partial mode, so a record gone is reported, not refused; each touched property is
 * compared three ways; who changed a conflicted property is named where Silo wrote it.
 */
async function recheck(deps: SimulationDeps, ctx: Context, who: Actor, staged: StagedAction): Promise<Recheck> {
  const manifest = staged.manifest as unknown as StagedManifest;
  const parameters = await parametersOf(deps, ctx, staged);
  const { targets, readAt } = await targetsOf(deps, ctx, who, staged);
  const stored = (staged.conflicts ?? []) as unknown as StoredConflict[];
  const out = await deps.services.call(checkMutation, {
    body: { actionTypeId: manifest.actionTypeId, parameters: parameters as never, objects: liveObjects(manifest), createOn: manifest.createOn, resolutionPolicy: 'partial' },
  }, call(ctx));
  if (out.outcome === 'refused') {
    return { staged, manifest, refusal: { stage: out.stage, reason: out.reason }, targets: [], conflicts: stored, staleness: staged.staleness, parameters };
  }
  const notPermitted = out.excluded.filter((e) => e.reason !== 'record_not_found');
  if (notPermitted.length > 0) {
    return {
      staged, manifest, refusal: { stage: 'resolve', reason: `${notPermitted.length} target(s) are on a connection this Action may no longer write` },
      targets: [], conflicts: stored, staleness: staged.staleness, parameters,
    };
  }
  const now = new Map(out.targets.map((t) => [targetKey(t.connectionId, t.reference), Object.fromEntries(t.fields.map((f) => [f.field, f.current]))]));
  const fieldOf = new Map(out.targets.flatMap((t) => t.fields.map((f) => [`${targetKey(t.connectionId, t.reference)}\u0000${f.property ?? f.field}`, f.field] as const)));
  const checks = targets.map((t) => {
    const k = targetKey(t.connectionId, t.reference);
    const resolutions = new Map(stored.filter((c) => c.connectionId === t.connectionId && c.reference === t.reference && c.resolution !== null)
      .map((c) => [c.property, c.resolution!] as const));
    // The base is kept by property; the record now is read by field.
    const entries = t.entries.map((e) => ({ ...e, field: fieldOf.get(`${k}\u0000${e.property}`) ?? e.field }));
    // An upsert that would create starts from no record, as a create does.
    const current = t.operation === 'create' ? {} : t.operation === 'upsert' ? now.get(k) ?? {} : now.get(k) ?? null;
    return checkTarget({ ...t, entries }, current, resolutions);
  });
  const conflicted = checks.flatMap((c) => c.properties.filter((p) => p.state === 'conflicted').map((p) => ({ check: c, property: p })));
  const writes = conflicted.length === 0 || readAt === null ? [] : (await deps.services.call(listRecentWrites, {
    body: { objectIds: [...new Set(conflicted.map((c) => c.check.objectId))], since: readAt },
  }, call(ctx))).writes;
  const conflicts: StoredConflict[] = conflicted.map(({ check, property }) => {
    const writer = writes.find((w) => w.objectId === check.objectId && w.field === property.field);
    return {
      objectId: check.objectId, connectionId: check.connectionId, reference: check.reference, property: property.property,
      changedBy: writer?.proposerMembershipId ?? null, changedByKnown: writer !== undefined, resolution: property.resolution,
    };
  });
  return { staged, manifest, refusal: null, targets: checks, conflicts, staleness: actionStaleness(checks), parameters };
}

/** A promoted staged Action is not checked again: it is the record of what was simulated, against its bases. */
async function asStaged(deps: SimulationDeps, ctx: Context, who: Actor, staged: StagedAction): Promise<Recheck> {
  const { targets } = await targetsOf(deps, ctx, who, staged);
  const checks = targets.map((t) => checkTarget(t, Object.fromEntries(t.entries.map((e) => [e.field, e.base])), new Map()));
  return { staged, manifest: staged.manifest as unknown as StagedManifest, refusal: null, targets: checks, conflicts: [], staleness: staged.staleness, parameters: {} };
}

async function keepStaleness(deps: SimulationDeps, who: Actor, checks: readonly Recheck[]): Promise<void> {
  const fresh = checks.filter((c) => c.refusal === null && c.staged.promotedActionId === null);
  if (fresh.length === 0) return;
  await inTransaction(control(deps), who.request, async (db) => {
    const at = new Date().toISOString();
    for (const c of fresh) {
      await stagedActionRepo.update(db, c.staged.id, { staleness: c.staleness, conflicts: c.conflicts.length === 0 ? null : c.conflicts as never, stalenessCheckedAt: at });
    }
  });
}

const isoSeconds = (seconds: number | null): string | null => (seconds === null ? null : `PT${Math.round(seconds)}S`);

// ----------------------------------------------------------------------------- opening

/** simulation.run: the branch recomputed on current state: staleness, each effect, and the walk from it, as a run. */
export async function openBranch(deps: SimulationDeps, ctx: Context, branchId: string): Promise<{ view: OpenedBranchView; runId: string }> {
  const who = member(ctx);
  await demand(deps, ctx, 'simulation.run');
  const { branch, scenario } = await ownBranch(deps, who, branchId);
  if (branch.basesPurgedAt !== null) {
    throw new AppError('conflict', 'the branch\'s retention has ended: its bases are purged, so it cannot be recomputed', { code: 'simulation.branch_purged' });
  }
  const manifest = await readManifest(deps, ctx);
  const bounds = scenario.bounds as { iterations?: number };
  const iterations = scenario.mode === 'probabilistic' ? Math.min(bounds.iterations ?? 1_000, 10_000) : null;
  const run = await inTransaction(control(deps), who.request, async (db) => simulationRunRepo.insert(db, {
    id: uuidv7(), organisationId: who.organisationId, scenarioId: scenario.id, branchId: branch.id, runByMembershipId: who.membershipId,
    mode: scenario.mode, iterations, graphVersion: String(await graphStateRepo.current(db, who.organisationId)), status: 'running', startedAt: new Date().toISOString(),
  }));
  const failRun = () => inTransaction(control(deps), who.request, (db) => simulationRunRepo.update(db, run.id, { status: 'failed', completedAt: new Date().toISOString() }));

  // Opening recomputes propagation: metered as a re-run (39.9).
  let charged: RunView['charge'] = null;
  try {
    const out = await deps.services.call(charge, { body: { operation: 'simulation_rerun', correlationId: run.id, simulationRunId: run.id } },
      { ...call(ctx), idempotencyKey: ctx.idempotencyKey ?? run.id });
    charged = out.charged ? { operation: 'simulation_rerun', weight: out.weight } : null;
  } catch (error) {
    await failRun();
    throw error;
  }

  let checks: Recheck[];
  try {
    const staged = await inTransaction(control(deps), who.request, (db) => stagedActionRepo.listForBranch(db, branch.id), { readOnly: true });
    checks = [];
    for (const s of staged) checks.push(s.promotedActionId === null ? await recheck(deps, ctx, who, s) : await asStaged(deps, ctx, who, s));
    await keepStaleness(deps, who, checks);
  } catch (error) {
    await failRun();
    throw error;
  }

  const effects = checks.map((c) => ({ check: c, effects: c.refusal !== null ? [] : c.targets.map((t) => effectOf(c.manifest.objectTypeId, t, timePropertiesOf(manifest, c.manifest.objectTypeId))) }));
  const origins = mergeOrigins([
    ...failureOrigins(scenario),
    ...effects.flatMap((e) => e.effects.flatMap((x) => (x.origin === null ? [] : [x.origin]))),
  ]);
  await walkAndRecord(deps, ctx, who, { scenario, run, origins, manifest, charged, failRun, branchId: branch.id });

  const before = checks.filter((c) => c.staged.promotedActionId === null && c.refusal === null);
  const stale = before.filter((c) => c.staleness !== 'clean');
  const view = await inTransaction(control(deps), who.request, async (db) => {
    if (stale.length > 0) {
      const n = (s: Staleness) => before.filter((c) => c.staleness === s).length;
      await recordEvent(db, who, ctx.correlationId, {
        event: 'branch_staleness_detected', resource: { type: 'scenario_branch', id: branch.id },
        detail: { clean: n('clean'), conflicted: n('conflicted'), already_applied: n('already_applied'), orphaned: n('orphaned'), run_id: run.id },
      });
    }
    return branchViewOf(db, (await scenarioBranchRepo.findById(db, branch.id))!);
  });
  return {
    runId: run.id,
    view: {
      branch: view,
      checks: effects.map(({ check, effects: fx }) => ({
        stagedActionId: check.staged.id, staleness: check.staleness, refusal: check.refusal,
        targets: check.targets.map((t, i) => ({
          objectId: t.objectId, connectionId: t.connectionId, reference: t.reference, staleness: t.staleness,
          effect: fx[i]!.origin === null ? { form: null, delay: null, reason: fx[i]!.reason }
            : { form: fx[i]!.origin!.delaySeconds === null ? 'unavailable' as const : 'delayed' as const, delay: isoSeconds(fx[i]!.origin!.delaySeconds), reason: null },
          properties: t.properties.map((p) => ({
            property: p.property, current: (p.current ?? null) as never, branch: (t.operation === 'custom' ? null : p.staged ?? null) as never,
            branchUnknown: t.operation === 'custom', state: p.state, resolution: p.resolution,
          })),
        })),
      })),
      run: await readRun(deps, ctx, run.id, charged),
    },
  };
}

/** The type's date and instant properties: the ones whose move later delays what follows. */
function timePropertiesOf(manifest: OntologyManifest, objectTypeId: string): Set<string> {
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId);
  return new Set((type?.properties ?? []).filter((p) => p.dataType === 'date' || p.dataType === 'timestamp').map((p) => p.apiName));
}

function failureOrigins(scenario: Scenario): Origin[] {
  if (scenario.kind !== 'failure' || scenario.statedFailure === null) return [];
  const f = scenario.statedFailure as unknown as StatedFailure;
  return f.objectIds.map((objectId) => ({ objectTypeId: f.objectTypeId, objectId, delaySeconds: f.form === 'delayed' ? secondsOf(f.delay) : null }));
}

/** One origin per object: unavailable over delayed, the larger delay over the smaller. */
function mergeOrigins(origins: readonly Origin[]): Origin[] {
  const out = new Map<string, Origin>();
  for (const o of origins) {
    const k = `${o.objectTypeId}:${o.objectId}`;
    const prior = out.get(k);
    if (prior === undefined || o.delaySeconds === null || (prior.delaySeconds !== null && o.delaySeconds > prior.delaySeconds)) out.set(k, o);
  }
  return [...out.values()];
}

// ----------------------------------------------------------------------------- comparison

/** The branch against its scenario's latest run, or against another branch of the scenario. */
export async function compareBranch(deps: SimulationDeps, ctx: Context, branchId: string, againstBranchId: string | undefined) {
  const who = member(ctx);
  const { branch, scenario } = await ownBranch(deps, who, branchId);
  const other = againstBranchId === undefined ? undefined : await ownBranch(deps, who, againstBranchId);
  if (other !== undefined && other.branch.scenarioId !== branch.scenarioId) {
    throw new AppError('validation', 'two branches compare only within one scenario', { code: 'simulation.branch_other_scenario' });
  }
  const runs = await inTransaction(control(deps), who.request, async (db) => ({
    here: await simulationRunRepo.latestForBranch(db, branch.id),
    there: other !== undefined ? await simulationRunRepo.latestForBranch(db, other.branch.id) : await simulationRunRepo.latestForScenario(db, scenario.id),
  }), { readOnly: true });
  if (runs.here === undefined) throw new AppError('conflict', 'open the branch first: comparison reads its latest run', { code: 'simulation.branch_not_opened' });
  if (runs.there === undefined && (other !== undefined || scenario.kind === 'failure')) {
    throw new AppError('conflict', other !== undefined ? 'open the other branch first' : 'run the scenario first: comparison reads its latest run',
      { code: 'simulation.branch_not_opened' });
  }
  const here = await readRun(deps, ctx, runs.here.id);
  const there = runs.there === undefined ? undefined : await readRun(deps, ctx, runs.there.id);
  const set = (v: RunView | undefined) => new Map((v?.reached ?? []).map((r) => [`${r.objectTypeId}:${r.objectId}`, r]));
  const [a, b] = [set(here), set(there)];
  const ref = (r: RunView['reached'][number]) => ({ objectTypeId: r.objectTypeId!, objectId: r.objectId! });
  const onlyHere = [...a.entries()].filter(([k]) => !b.has(k)).map(([, r]) => ref(r));
  const onlyThere = [...b.entries()].filter(([k]) => !a.has(k)).map(([, r]) => ref(r));
  const delayChanged = [...a.entries()].filter(([k, r]) => b.has(k) && b.get(k)!.delay !== r.delay)
    .map(([k, r]) => ({ ...ref(r), here: r.delay, there: b.get(k)!.delay }));

  const targets: { branchId: string; objectId: string; property: string; current: never; branch: never }[] = [];
  for (const which of [branch, ...(other === undefined ? [] : [other.branch])]) {
    const staged = await inTransaction(control(deps), who.request, (db) => stagedActionRepo.listForBranch(db, which.id), { readOnly: true });
    for (const s of staged) {
      const c = await recheck(deps, ctx, who, s);
      for (const t of c.targets) {
        for (const p of t.properties) {
          targets.push({ branchId: which.id, objectId: t.objectId, property: p.property, current: (p.current ?? null) as never, branch: (p.staged ?? null) as never });
        }
      }
    }
  }
  const graphChanged = there !== undefined && here.graphVersion !== there.graphVersion;
  await inTransaction(control(deps), who.request, (db) => recordEvent(db, who, ctx.correlationId, {
    event: 'branch_compared', resource: { type: 'scenario_branch', id: branch.id },
    detail: { against: other === undefined ? 'scenario' : 'branch', only_here: onlyHere.length, only_there: onlyThere.length, delay_changed: delayChanged.length, graph_changed: graphChanged },
  }));
  return {
    branchId: branch.id, against: other === undefined ? { kind: 'scenario' as const, id: scenario.id } : { kind: 'branch' as const, id: other.branch.id },
    targets, downstream: { onlyHere, onlyThere, delayChanged }, graphChanged, comparable: !graphChanged,
  };
}

// ----------------------------------------------------------------------------- promotion

const STATEMENTS = {
  conflicted: 'conflicted: a property changed since staging; decide it (keep staged or take current) or stage it again',
  already_applied: 'already applied: the records hold the staged values; nothing to change',
  orphaned: 'orphaned: no record it targets still exists; excluded from promotion',
  promoted: 'already promoted',
} as const;

/** A key of its own for each proposal, derived from the request's, so a retried promotion proposes each staged Action once. */
const proposalKey = (key: string, stagedActionId: string): string => {
  const h = sha256(Buffer.from(`${key}:${stagedActionId}`)).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * scenario.promote: each promotable staged Action enters the mutation path at intent with
 * the branch as its origin. Checked first; conflicted, already applied and orphaned ones are
 * left with a statement; a target gone or already holding its values is left out.
 */
export async function promoteBranch(deps: SimulationDeps, ctx: Context, branchId: string, stagedActionIds: string[] | undefined, canvasViewId?: string) {
  const who = member(ctx);
  await demand(deps, ctx, 'scenario.promote');
  const { branch, scenario } = await ownBranch(deps, who, branchId);
  mustBeOpen(branch);
  // From the canvas (30.9): the view must overlay this scenario; the promotion still enters approval like any other.
  if (canvasViewId !== undefined) {
    const view = await inTransaction(control(deps), who.request, (db) => canvasViewRepo.findById(db, canvasViewId), { readOnly: true });
    if (view === undefined || view.deletedAt !== null || view.scenarioId !== scenario.id) {
      throw new AppError('validation', 'that canvas view does not overlay this branch\'s scenario', { code: 'scenario.canvas_view_mismatch' });
    }
  }
  const all = await inTransaction(control(deps), who.request, (db) => stagedActionRepo.listForBranch(db, branch.id), { readOnly: true });
  const chosen = stagedActionIds === undefined ? all : stagedActionIds.map((id) => all.find((s) => s.id === id) ?? (() => { throw stagedNotFound(); })());
  const notPromoted: { stagedActionId: string; reason: 'conflicted' | 'already_applied' | 'orphaned' | 'refused' | 'promoted'; statement: string; mutationId: string | null }[] = [];
  const checks: Recheck[] = [];
  for (const s of chosen) {
    if (s.promotedActionId !== null) { notPromoted.push({ stagedActionId: s.id, reason: 'promoted', statement: STATEMENTS.promoted, mutationId: s.promotedActionId }); continue; }
    checks.push(await recheck(deps, ctx, who, s));
  }
  await keepStaleness(deps, who, checks);
  const promotable: { check: Recheck; objects: { connectionId: string; reference: string }[] }[] = [];
  for (const c of checks) {
    if (c.refusal !== null) { notPromoted.push({ stagedActionId: c.staged.id, reason: 'refused', statement: `refused at ${c.refusal.stage}: ${c.refusal.reason}`, mutationId: null }); continue; }
    if (c.staleness !== 'clean') { notPromoted.push({ stagedActionId: c.staged.id, reason: c.staleness, statement: STATEMENTS[c.staleness], mutationId: null }); continue; }
    const objects = c.targets.filter((t) => t.operation !== 'create' && t.staleness !== 'orphaned' && t.staleness !== 'already_applied')
      .map((t) => ({ connectionId: t.connectionId, reference: t.reference }));
    promotable.push({ check: c, objects });
  }
  // The bulk guardrails count everything promoted together; promoting together never lowers any approval.
  const rowsTogether = Math.max(1, promotable.reduce((n, p) => n + Math.max(p.objects.length, p.check.manifest.operation === 'create' ? 1 : 0), 0));
  const simulation = await branchSimulation(deps, who, branch.id);

  const promoted: { stagedActionId: string; mutationId: string }[] = [];
  for (const { check, objects } of promotable) {
    const keepCurrent = check.targets.flatMap((t) => t.properties.filter((p) => p.resolution === 'take_current')
      .map((p) => ({ connectionId: t.connectionId, reference: t.reference, property: p.property })));
    const mutation = await deps.services.call(proposeMutation, {
      body: {
        actionTypeId: check.manifest.actionTypeId, parameters: check.parameters as never, objects, createOn: check.manifest.createOn, resolutionPolicy: 'strict',
        promotion: { scenarioId: scenario.id, branchId: branch.id, stagedActionId: check.staged.id, keepCurrent, rowsTogether, simulation },
      },
    }, { ...call(ctx), idempotencyKey: proposalKey(ctx.idempotencyKey ?? uuidv7(), check.staged.id) });
    if (mutation.status === 'refused') {
      notPromoted.push({ stagedActionId: check.staged.id, reason: 'refused', statement: `refused at ${mutation.refusedStage}: ${mutation.refusalReason}`, mutationId: mutation.id });
      continue;
    }
    promoted.push({ stagedActionId: check.staged.id, mutationId: mutation.id });
    await inTransaction(control(deps), who.request, async (db) => {
      await stagedActionRepo.update(db, check.staged.id, { promotedActionId: mutation.id, promotedBy: who.membershipId, promotedAt: new Date().toISOString() });
      await recordEvent(db, who, ctx.correlationId, {
        event: 'staged_action_promoted', resource: { type: 'staged_action', id: check.staged.id },
        detail: { branch_id: branch.id, mutation_id: mutation.id, rows: objects.length, rows_together: rowsTogether },
      });
      if (canvasViewId !== undefined) {
        await recordEvent(db, who, ctx.correlationId, {
          event: 'staged_action_promoted_from_canvas', resource: { type: 'staged_action', id: check.staged.id },
          detail: { canvas_view_id: canvasViewId, scenario_id: scenario.id, branch_id: branch.id, mutation_id: mutation.id },
        });
      }
    });
  }
  const view = await inTransaction(control(deps), who.request, async (db) => {
    const staged = await stagedActionRepo.listForBranch(db, branch.id);
    const status = staged.length > 0 && staged.every((s) => s.promotedActionId !== null) ? 'promoted' as const
      : staged.some((s) => s.promotedActionId !== null) ? 'partially_promoted' as const : branch.status;
    const updated = status === branch.status ? branch : await scenarioBranchRepo.update(db, branch.id, { status, version: branch.version + 1 });
    return branchViewOf(db, updated!);
  });
  return { branch: view, promoted, notPromoted };
}

/** The branch simulation the approver sees with each proposal: its latest run, by reference and counts. */
async function branchSimulation(deps: SimulationDeps, who: Actor, branchId: string) {
  return inTransaction(control(deps), who.request, async (db) => {
    const run = await simulationRunRepo.latestForBranch(db, branchId);
    if (run === undefined) return { runId: null, graphVersion: null, reachedHard: 0, reachedSoft: 0, stopped: 0 };
    const results = await simulationResultRepo.listForRun(db, run.id);
    const reached = results.filter((r) => r.resultKind === 'reached');
    return {
      runId: run.id, graphVersion: Number(run.graphVersion), reachedHard: reached.filter((r) => !r.viaSoftEdge).length,
      reachedSoft: reached.filter((r) => r.viaSoftEdge).length, stopped: results.length - reached.length,
    };
  }, { readOnly: true });
}
