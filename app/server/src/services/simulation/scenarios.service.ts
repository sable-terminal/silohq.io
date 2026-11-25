// Failure scenarios (spec 39.6, 39.7) and their runs (39.4, 39.9).
//
// A run: the runner holds simulation.run and owns the scenario (scenarios are private by
// default; sharing is not built). The run row is written, then charged (a first run as a
// simulation, a later one as a re-run at the reduced rate) under the request's key, so a
// retry is never charged twice; a refused charge fails the run with the bound named. The
// graph is walked on current data, read once through the executor under the runner's own
// permissions and discarded; the results persist as references, paths and delays, with
// the run's lineage, in one transaction. The runner is told when it completes.

import type { DependencyEdge } from '../../models/simulation/dependencyEdge.model.ts';
import { readDemand, shortfalls, type Constrained } from './capacity.service.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { credibleInterval } from '../../utils/bayes.util.ts';
import {
  DEFAULT_ITERATIONS, INDEPENDENCE_STATEMENT, INFERENCE_STATEMENT, MAX_ITERATIONS, observed, pathOutcome, seeded, simulatePath, type PathEdge,
} from './montecarlo.service.ts';
import { readResultPage, runPlan, type ResultObject } from '../../contracts/executor/result.contract.ts';
import { charge } from '../../contracts/metering/charge.contract.ts';
import { raiseNotification } from '../../contracts/notify/notification.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import type { ResultView, RunView, ScenarioView, StatedFailure } from '../../contracts/simulation/scenario.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Scenario } from '../../models/simulation/scenario.model.ts';
import type { SimulationRun } from '../../models/simulation/simulationRun.model.ts';
import {
  dependencyEdgeRepo, graphStateRepo, scenarioRepo, simulationResultEdgeRepo, simulationResultRepo, simulationRunRepo,
} from '../../repos/simulation/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { reportLineageWriteFailure, writeLineage } from '../lineage/writer.service.ts';
import { demand, member, readManifest, recordEvent, secondsOf, visibility, type Actor, type Context, type SimulationDeps } from './deps.service.ts';
import { walk, walkEdge, type LinkReader, type Origin, type Walk } from './propagation.service.ts';

import { viewShareRepo } from '../../repos/workspace/index.repo.ts';
import { membershipRepo, scopeRepo } from '../../repos/iam/index.repo.ts';
import { effectivePolicy, granteeOf, permitted, type EffectivePolicy } from '../workspace/sharing.service.ts';
import type { ShareGrantee, ViewShareView } from '../../contracts/workspace/sharing.contract.ts';
import type { ViewAccess } from '../../contracts/workspace/view.contract.ts';
import type { ViewShare } from '../../models/workspace/viewShare.model.ts';
const scenarioNotFound = (): AppError => new AppError('not_found', 'no such scenario', { code: 'simulation.scenario_not_found' });

export function scenarioView(s: Scenario, access: ScenarioView['access'] = 'owner'): ScenarioView {
  return {
    id: s.id, name: s.name, access, kind: s.kind, statedFailure: s.statedFailure as StatedFailure | null, mode: s.mode,
    bounds: s.bounds as ScenarioView['bounds'], graphVersion: Number(s.graphVersion), version: s.version, createdAt: s.createdAt,
  };
}

/** simulation.run: save a failure scenario. The forms and mode not built yet are refused with a statement. */
export async function saveScenario(deps: SimulationDeps, ctx: Context, input: {
  name: string; statedFailure: StatedFailure; mode: 'deterministic' | 'probabilistic'; bounds: { hops: number; fanOut: number; iterations?: number | undefined };
}): Promise<ScenarioView> {
  const who = member(ctx);
  await demand(deps, ctx, 'simulation.run');
  const manifest = await readManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === input.statedFailure.objectTypeId && t.status === 'active');
  const seen = await visibility(deps, ctx, { objectTypes: [input.statedFailure.objectTypeId] });
  if (type === undefined || !seen.typeVisible(type.id)) {
    throw new AppError('not_found', 'no such object type', { code: 'simulation.object_type_not_found' });
  }
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const graphVersion = await graphStateRepo.current(db, who.organisationId);
    const scenario = await scenarioRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, ownerMembershipId: who.membershipId, name: input.name, kind: 'failure',
      statedFailure: JSON.parse(JSON.stringify(input.statedFailure)) as Scenario['statedFailure'], mode: input.mode, bounds: JSON.parse(JSON.stringify(input.bounds)) as Scenario['bounds'], graphVersion: String(graphVersion),
    });
    await writeLineage(db, { organisationId: who.organisationId, createdBy: { membershipId: who.membershipId } }, {
      artefact: { kind: 'scenario', refId: scenario.id, version: String(scenario.version) },
      inputs: [{ node: { kind: 'object_type_version', refId: type.id, version: type.typeVersionId }, relation: 'uses' }],
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'scenario_saved', resource: { type: 'scenario', id: scenario.id },
      detail: { form: input.statedFailure.form, objects: input.statedFailure.objectIds.length, graph_version: graphVersion },
    });
    return scenarioView(scenario);
  });
}

type Held = ScenarioView['access'];
const RANK: Readonly<Record<Held, number>> = { view: 0, run: 1, copy: 2, owner: 3 };

/**
 * What a member holds on a scenario (39.7, the saved-view model): its owner, or the best live
 * share that reaches them and the owner's current sharing policy still permits.
 */
async function heldOn(db: Queryable, scenario: Scenario, membershipId: string): Promise<Held | undefined> {
  if (scenario.archivedAt !== null) return undefined;
  if (scenario.ownerMembershipId === membershipId) return 'owner';
  const shares = await viewShareRepo.liveReachingScenario(db, scenario.id, membershipId);
  if (shares.length === 0) return undefined;
  const policy = await effectivePolicy(db, scenario.organisationId, scenario.ownerMembershipId);
  let best: Held | undefined;
  for (const share of shares) {
    if (!await permitted(db, scenario.ownerMembershipId, granteeOf(share), policy)) continue;
    const held = share.access as Held;
    if (best === undefined || RANK[held] > RANK[best]) best = held;
  }
  return best;
}

/** The scenario, held at least as `need`; otherwise not found (private by default, 39.7). */
async function heldScenario(deps: SimulationDeps, who: Actor & { membershipId: string }, scenarioId: string, need: Held)
  : Promise<{ scenario: Scenario; held: Held }> {
  const found = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const scenario = await scenarioRepo.findById(db, scenarioId);
    return scenario === undefined ? undefined : { scenario, held: await heldOn(db, scenario, who.membershipId) };
  }, { readOnly: true });
  if (found === undefined || found.held === undefined || RANK[found.held] < RANK[need]) throw scenarioNotFound();
  return { scenario: found.scenario, held: found.held };
}

const ownScenario = async (deps: SimulationDeps, who: Actor & { membershipId: string }, scenarioId: string): Promise<Scenario> =>
  (await heldScenario(deps, who, scenarioId, 'owner')).scenario;

export async function listScenarios(deps: SimulationDeps, ctx: Context, filter: 'mine' | 'shared' = 'mine'): Promise<ScenarioView[]> {
  const who = member(ctx);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    if (filter === 'mine') return (await scenarioRepo.listForOwner(db, who.membershipId)).map((s) => scenarioView(s));
    const out: ScenarioView[] = [];
    for (const id of await viewShareRepo.scenariosReaching(db, who.membershipId)) {
      const scenario = await scenarioRepo.findById(db, id);
      const held = scenario === undefined ? undefined : await heldOn(db, scenario, who.membershipId);
      if (scenario !== undefined && held !== undefined && held !== 'owner') out.push(scenarioView(scenario, held));
    }
    return out;
  }, { readOnly: true });
}

/** The object view's scenarios section (34.2): those the reader holds that stage an Action on the object or reach it. */
export async function listObjectScenarios(deps: SimulationDeps, ctx: Context, input: { objectTypeId: string; objectId: string }) {
  const who = member(ctx);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const touching = await scenarioRepo.touchingObject(db, input);
    const ids = [...new Set([...touching.staged.map((s) => s.scenarioId), ...touching.reached.map((r) => r.scenarioId)])];
    const scenarios = [];
    for (const id of ids) {
      const scenario = await scenarioRepo.findById(db, id);
      const held = scenario === undefined ? undefined : await heldOn(db, scenario, who.membershipId);
      if (scenario === undefined || held === undefined) continue;
      const seen = new Set<string>();
      scenarios.push({
        scenario: scenarioView(scenario, held),
        staged: touching.staged.filter((s) => s.scenarioId === id).map((s) => ({
          branchId: s.branchId, branchName: s.branchName, branchStatus: s.branchStatus as never, stagedActionId: s.stagedActionId,
          actionTypeId: s.actionTypeId, staleness: s.staleness as never,
        })),
        // One entry a run: an object reached by several paths is reached once.
        reached: touching.reached.filter((r) => r.scenarioId === id && !seen.has(r.runId) && seen.add(r.runId) !== undefined).map((r) => ({
          runId: r.runId, branchId: r.branchId, completedAt: r.completedAt,
          effect: r.capacityShortfall !== null ? 'constrained' as const : r.delaySeconds === null ? 'fails' as const : 'delayed' as const,
          delay: r.delaySeconds === null ? null : `PT${Math.round(r.delaySeconds)}S`,
          unavailableFor: r.unavailableSeconds === null ? null : `PT${Math.round(r.unavailableSeconds)}S`,
          probability: r.probability === null ? null : Number(r.probability),
        })),
      });
    }
    return { scenarios: scenarios.sort((a, b) => a.scenario.name.localeCompare(b.scenario.name) || a.scenario.id.localeCompare(b.scenario.id)) };
  }, { readOnly: true });
}

export async function getScenario(deps: SimulationDeps, ctx: Context, scenarioId: string): Promise<ScenarioView> {
  const { scenario, held } = await heldScenario(deps, member(ctx), scenarioId, 'view');
  return scenarioView(scenario, held);
}

/** The owner shares a failure scenario within the sharing policy (39.7); a branch scenario stays its owner's. */
export async function shareScenario(deps: SimulationDeps, ctx: Context, scenarioId: string, input: {
  grantee: ShareGrantee; access: ViewAccess; expiresAt?: string | undefined;
}): Promise<ViewShareView> {
  const who = member(ctx);
  await demand(deps, ctx, 'simulation.share');
  if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= Date.now()) {
    throw new AppError('validation', 'a share expires in the future', { code: 'simulation.share_expiry_past' });
  }
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const scenario = await scenarioRepo.findById(db, scenarioId);
    if (!scenario || scenario.ownerMembershipId !== who.membershipId || scenario.archivedAt !== null) throw scenarioNotFound();
    if (scenario.kind === 'branch') throw new AppError('validation', 'a branch scenario is not shared', { code: 'simulation.share_branch' });
    const grantee = input.grantee;
    if (grantee.kind === 'membership') {
      if (grantee.membershipId === who.membershipId) throw new AppError('validation', 'a scenario is not shared with its owner', { code: 'simulation.share_self' });
      const target = await membershipRepo.findById(db, grantee.membershipId);
      if (!target || target.status !== 'active') {
        throw new AppError('validation', 'share with an active member of this organisation', { code: 'simulation.share_grantee_unknown' });
      }
    } else if (grantee.kind === 'scope') {
      const scope = await scopeRepo.findById(db, grantee.scopeId);
      if (!scope || scope.archivedAt !== null) throw new AppError('validation', 'no such scope', { code: 'simulation.share_grantee_unknown' });
    }
    const policy = await effectivePolicy(db, who.organisationId, who.membershipId);
    if (!await permitted(db, who.membershipId, grantee, policy)) {
      throw new AppError('forbidden', `the sharing policy (${policy.viewSharingPolicy}) does not allow this share`, {
        code: 'simulation.share_forbidden', details: { policy: policy.viewSharingPolicy },
      });
    }
    const now = new Date().toISOString();
    const existing = await viewShareRepo.findForScenarioGrantee(db, scenario.id, {
      ...(grantee.kind === 'membership' ? { membershipId: grantee.membershipId } : {}),
      ...(grantee.kind === 'scope' ? { scopeId: grantee.scopeId } : {}),
      ...(grantee.kind === 'organisation' ? { organisation: true as const } : {}),
    });
    const row = existing
      ? (await viewShareRepo.update(db, existing.id, {
        access: input.access, expiresAt: input.expiresAt ?? null, revokedAt: null, suspendedAt: null, sharedBy: who.membershipId, sharedAt: now,
      }))!
      : await viewShareRepo.insert(db, {
        id: uuidv7(), organisationId: who.organisationId, scenarioId: scenario.id,
        membershipId: grantee.kind === 'membership' ? grantee.membershipId : null, scopeId: grantee.kind === 'scope' ? grantee.scopeId : null,
        organisationWide: grantee.kind === 'organisation' ? true : null, access: input.access, sharedBy: who.membershipId, sharedAt: now,
        expiresAt: input.expiresAt ?? null,
      });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'scenario_shared', resource: { type: 'scenario', id: scenario.id },
      detail: { share_id: row.id, grantee: grantee.kind, access: input.access, expires: input.expiresAt !== undefined, change: 'shared' },
    });
    return shareViewOf(db, row, who.membershipId, policy);
  });
}

async function shareViewOf(db: Queryable, share: ViewShare, ownerId: string, policy: EffectivePolicy): Promise<ViewShareView> {
  let state: ViewShareView['state'] = share.revokedAt !== null ? 'revoked' : share.suspendedAt !== null ? 'suspended'
    : share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now() ? 'expired' : 'live';
  if (state === 'live' && !await permitted(db, ownerId, granteeOf(share), policy)) state = 'forbidden_by_policy';
  return {
    id: share.id, viewId: share.scenarioId!, grantee: granteeOf(share), access: share.access, sharedBy: share.sharedBy, sharedAt: share.sharedAt,
    expiresAt: share.expiresAt, revokedAt: share.revokedAt, suspendedAt: share.suspendedAt, state,
  };
}

export async function revokeScenarioShare(deps: SimulationDeps, ctx: Context, scenarioId: string, shareId: string): Promise<ViewShareView> {
  const who = member(ctx);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const scenario = await scenarioRepo.findById(db, scenarioId);
    if (!scenario || scenario.ownerMembershipId !== who.membershipId) throw scenarioNotFound();
    const found = await viewShareRepo.findById(db, shareId);
    if (!found || found.scenarioId !== scenario.id) throw new AppError('not_found', 'no such share', { code: 'simulation.share_not_found' });
    const row = found.revokedAt !== null ? found : (await viewShareRepo.update(db, found.id, { revokedAt: new Date().toISOString() }))!;
    if (found.revokedAt === null) {
      await recordEvent(db, who, ctx.correlationId, {
        event: 'scenario_shared', resource: { type: 'scenario', id: scenario.id }, detail: { share_id: found.id, change: 'revoked' },
      });
    }
    return shareViewOf(db, row, who.membershipId, await effectivePolicy(db, who.organisationId, who.membershipId));
  });
}

export async function listScenarioShares(deps: SimulationDeps, ctx: Context, scenarioId: string): Promise<ViewShareView[]> {
  const who = member(ctx);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const scenario = await scenarioRepo.findById(db, scenarioId);
    if (!scenario || scenario.ownerMembershipId !== who.membershipId) throw scenarioNotFound();
    const policy = await effectivePolicy(db, who.organisationId, who.membershipId);
    const out: ViewShareView[] = [];
    for (const row of await viewShareRepo.listForScenario(db, scenario.id)) out.push(await shareViewOf(db, row, who.membershipId, policy));
    return out;
  }, { readOnly: true });
}

/** A holder of copy access saves the scenario as their own: private, theirs, run under their permissions. */
export async function copyScenario(deps: SimulationDeps, ctx: Context, scenarioId: string, name: string): Promise<ScenarioView> {
  const who = member(ctx);
  const { scenario } = await heldScenario(deps, who, scenarioId, 'copy');
  return saveScenario(deps, ctx, {
    name, statedFailure: scenario.statedFailure as StatedFailure, mode: scenario.mode as 'deterministic' | 'probabilistic',
    bounds: scenario.bounds as never,
  } as never);
}

/** For one edge, every upstream object's linked objects, through the executor (data fetched once per edge per run). */
export function linkReader(deps: SimulationDeps, ctx: Context, manifest: OntologyManifest): LinkReader {
  return async (edge) => {
    const link = manifest.linkTypes.find((l) => l.id === edge.via);
    const routeId = link?.defaultRouteId ?? link?.routes[0]?.id;
    if (link === undefined || routeId === undefined) return { kind: 'links', links: new Map() };
    const call = { request: ctx.request, correlationId: ctx.correlationId };
    const out = await deps.services.call(runPlan, {
      body: {
        plan: {
          schemaVersion: '1', ontologyVersionId: manifest.version.id, nodes: [{ objectTypeId: edge.from, filters: [] }, { objectTypeId: edge.to, filters: [] }],
          hops: [{ from: 0, to: 1, linkTypeId: link.id, routeId }], select: [], sort: [],
        },
        parameters: {}, trigger: 'structured', useCache: false,
      },
    }, call);
    if (out.outcome === 'refusal') {
      if (out.refusal.code.startsWith('query.bound_')) return { kind: 'bounded' };
      throw new AppError('unavailable', 'a system the walk needs is not answering, so no result is given as if complete', {
        code: 'simulation.source_unavailable', details: { refusal: out.refusal.code },
      });
    }
    const objects: ResultObject[] = [...out.result.page.objects];
    for (let index = 1; index < out.result.page.count; index += 1) {
      objects.push(...(await deps.services.call(readResultPage, { params: { queryId: out.result.queryId, page: index } }, call)).objects);
    }
    return { kind: 'links', links: new Map(objects.map((o) => [o.id, (o.links['0'] ?? o.links[0] ?? []).map((x) => x.id)])) };
  };
}

const iso8601 = (seconds: number | null): string | null => (seconds === null ? null : `PT${Math.round(seconds)}S`);

/** simulation.run: run or re-run a scenario on current data and the current graph. */
export async function runScenario(deps: SimulationDeps, ctx: Context, scenarioId: string): Promise<{ view: RunView; runId: string }> {
  const who = member(ctx);
  await demand(deps, ctx, 'simulation.run');
  // A shared scenario runs under the opener's permissions (39.7): their decision, their visibility, their charge.
  const { scenario } = await heldScenario(deps, who, scenarioId, 'run');
  if (scenario.kind === 'branch') {
    throw new AppError('validation', 'a branch scenario runs by opening its branches', { code: 'simulation.branch_scenario' });
  }
  const failure = scenario.statedFailure as StatedFailure;
  const bounds = scenario.bounds as { hops: number; fanOut: number; iterations?: number };
  const probabilistic = scenario.mode === 'probabilistic';
  const iterations = probabilistic ? Math.min(bounds.iterations ?? DEFAULT_ITERATIONS, MAX_ITERATIONS) : null;
  const manifest = await readManifest(deps, ctx);
  const control = deps.databases.pool('control');

  const run = await inTransaction(control, who.request, async (db) => {
    const graphVersion = await graphStateRepo.current(db, who.organisationId);
    return simulationRunRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, scenarioId, runByMembershipId: who.membershipId, mode: scenario.mode, iterations,
      // The organisation's choice at the time of the run is kept with it (D72).
      inferred: probabilistic && (await organisationRepo.findById(db, who.organisationId))?.inferenceSimulation === true,
      graphVersion: String(graphVersion), status: 'running', startedAt: new Date().toISOString(),
    });
  });
  const failRun = () => inTransaction(control, who.request, (db) => simulationRunRepo.update(db, run.id, { status: 'failed', completedAt: new Date().toISOString() }));

  // The charge (spec 39.9, 73): a first run is a simulation, a later one a re-run.
  let charged: RunView['charge'] = null;
  try {
    const earlier = await inTransaction(control, who.request, (db) => simulationRunRepo.countEarlier(db, scenarioId, run.id), { readOnly: true });
    const operation = earlier > 0 ? 'simulation_rerun' as const : 'simulation' as const;
    const out = await deps.services.call(charge, { body: { operation, correlationId: run.id, simulationRunId: run.id } },
      { request: ctx.request, correlationId: ctx.correlationId, idempotencyKey: ctx.idempotencyKey ?? run.id });
    charged = out.charged ? { operation, weight: out.weight } : null;
  } catch (error) {
    await failRun();
    throw error;
  }

  const origins: Origin[] = failure.objectIds.map((objectId) => ({
    objectTypeId: failure.objectTypeId, objectId, delaySeconds: failure.form === 'delayed' ? secondsOf(failure.delay) : null,
    unavailableSeconds: failure.form === 'unavailable_for_period' ? secondsOf(failure.period) : null,
  }));
  await walkAndRecord(deps, ctx, who, {
    scenario, run, origins, manifest, charged, failRun,
    capacityRemaining: failure.form === 'reduced_capacity' ? failure.capacityRemaining! : failure.form === 'delayed' ? null : 0,
  });

  await deps.services.call(raiseNotification, {
    body: { recipientMembershipId: who.membershipId, kind: 'scenario_run_complete', source: { simulationRunId: run.id } },
  }, { request: who.request, correlationId: ctx.correlationId }).catch((error: unknown) => deps.logger.failure('raising the run notification failed', error, {
    event: 'simulation.notify_failed', resourceId: run.id,
  }));
  return { view: await readRun(deps, ctx, run.id, charged), runId: run.id };
}

export interface WalkRecordInput {
  scenario: Scenario;
  run: SimulationRun;
  origins: Origin[];
  manifest: OntologyManifest;
  charged: RunView['charge'];
  failRun: () => Promise<unknown>;
  /** A branch's run (39.8). */
  branchId?: string | undefined;
  /** The share of capacity a stated failure leaves its resources (D86): reduced capacity's, 0 when unavailable; none when delayed. */
  capacityRemaining?: number | null | undefined;
}

/**
 * The walk from its origins on current data, and its record: results as references, paths
 * and delays (or probabilities, 39.5), stops, the run completed, lineage and events, in one
 * transaction. A failure fails the run.
 */
export async function walkAndRecord(deps: SimulationDeps, ctx: Context, who: Actor & { membershipId: string }, input: WalkRecordInput): Promise<void> {
  const { scenario, run, origins, manifest, charged, failRun } = input;
  const control = deps.databases.pool('control');
  const bounds = scenario.bounds as { hops: number; fanOut: number; iterations?: number };
  const probabilistic = run.mode === 'probabilistic';
  const iterations = run.iterations;
  const originTypes = [...new Set(origins.map((o) => o.objectTypeId))];
  let result: Walk;
  let cleared: (id: string) => boolean;
  // Each history edge's observations (39.5): what a probabilistic run samples from.
  const samplesOf = new Map<string, number[]>();
  const constrained: (Constrained & { edge: DependencyEdge })[] = [];
  try {
    const live = await inTransaction(control, who.request, (db) => dependencyEdgeRepo.list(db), { readOnly: true });
    for (const e of live) {
      const samples = (e.evidenceRef as { history?: { samples?: unknown } } | null)?.history?.samples;
      if (e.source === 'history' && Array.isArray(samples) && samples.length > 0) samplesOf.set(e.id, samples.map(Number));
    }
    const seen = await visibility(deps, ctx, { objectTypes: [...originTypes, ...live.flatMap((e) => [e.fromObjectTypeId, e.toObjectTypeId])] });
    cleared = seen.typeVisible;
    if (originTypes.some((t) => !cleared(t))) throw scenarioNotFound();
    // Capacity (D86): resources a failure leaves short, along each confirmed resource edge from them.
    const remaining = input.capacityRemaining ?? null;
    if (remaining !== null) {
      const resourceIds = new Set(origins.map((o) => o.objectId));
      for (const edge of live.filter((e) => e.kind === 'resource' && e.status === 'confirmed' && originTypes.includes(e.fromObjectTypeId)
        && e.consumption !== null)) {
        if (!cleared(edge.toObjectTypeId)) continue;
        const demand = await readDemand(deps, ctx, manifest, edge, resourceIds);
        if (demand === 'bounded') continue;
        for (const c of shortfalls(demand, Number(edge.consumption), remaining)) constrained.push({ ...c, edge });
      }
    }
    result = await walk({
      origins, bounds,
      edgesFrom: async (types) => (await inTransaction(control, who.request, (db) => dependencyEdgeRepo.liveFrom(db, types), { readOnly: true })).map(walkEdge),
      cleared, links: linkReader(deps, ctx, manifest), keepAbsorbed: probabilistic,
      // Recovery from history where it is held (the median observed lead time), else the stated one.
      recoverySeconds: (e) => {
        const samples = samplesOf.get(e.id);
        if (samples === undefined || samples.length === 0) return e.leadSeconds;
        const sorted = [...samples].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      },
    });
  } catch (error) {
    await failRun();
    throw error;
  }

  const lineageActor = { organisationId: who.organisationId, createdBy: { membershipId: who.membershipId } };
  const artefact = { kind: 'simulation_result' as const, refId: run.id, version: '1' };
  try {
    const random = seeded(run.id);
    await inTransaction(control, who.request, async (db) => {
      for (const r of result.reached) {
        const path: PathEdge[] = r.path.map((e) => ({ id: e.id, kind: e.kind, leadSeconds: e.leadSeconds, bufferSeconds: e.bufferSeconds, samples: samplesOf.get(e.id) ?? null }));
        let row: { pathMode: 'deterministic' | 'probabilistic' | 'inferred'; delay: number | null; probability: number | null; spread: Record<string, number | null> | null };
        if (probabilistic && observed(path)) {
          const sim = simulatePath(path, r.originDelaySeconds, iterations!, random);
          if (sim.probability === 0) continue;
          row = { pathMode: 'probabilistic', delay: sim.fails ? null : sim.median, probability: sim.probability,
            spread: { p10: sim.p10, p50: sim.median, p90: sim.p90, iterations: sim.iterations } };
        } else if (probabilistic && run.inferred) {
          // The organisation turned inference on (D72): the path is simulated from beliefs, and marked inferred.
          const sim = simulatePath(path, r.originDelaySeconds, iterations!, random, true);
          if (sim.probability === 0) continue;
          row = { pathMode: 'inferred', delay: sim.fails ? null : sim.median, probability: sim.probability,
            spread: { p10: sim.p10, p50: sim.median, p90: sim.p90, iterations: sim.iterations } };
        } else if (probabilistic) {
          // A path with an edge lacking observations is computed deterministically, and says so (39.5).
          const out = pathOutcome(path, r.originDelaySeconds, (e) => e.leadSeconds);
          if (out === undefined) continue;
          row = { pathMode: 'deterministic', delay: out, probability: null, spread: null };
        } else {
          row = { pathMode: 'deterministic', delay: r.delaySeconds, probability: null, spread: null };
        }
        const id = uuidv7();
        await simulationResultRepo.insert(db, {
          id, organisationId: who.organisationId, runId: run.id, resultKind: 'reached', affectedObjectTypeId: r.objectTypeId, affectedObjectKey: r.objectId,
          viaSoftEdge: r.viaSoftEdge, pathMode: row.pathMode, accumulatedDelay: row.delay === null ? null : `${Math.round(row.delay)} seconds`,
          unavailableFor: row.delay === null && r.unavailableSeconds !== null ? `${Math.round(r.unavailableSeconds)} seconds` : null,
          probability: row.probability === null ? null : String(row.probability), delaySpread: row.spread as never,
        });
        await simulationResultEdgeRepo.insertMany(db, r.path.map((e, i) => ({
          organisationId: who.organisationId, resultId: id, position: i + 1, edgeId: e.id, edgeKind: e.kind, edgeSource: e.source,
          sampleSize: samplesOf.get(e.id)?.length ?? null,
        })));
      }
      for (const c of constrained) {
        const id = uuidv7();
        await simulationResultRepo.insert(db, {
          id, organisationId: who.organisationId, runId: run.id, resultKind: 'reached', affectedObjectTypeId: c.edge.toObjectTypeId,
          affectedObjectKey: c.dependantId, pathMode: 'deterministic', capacityShortfall: String(c.shortfall), capacityPeriod: c.edge.capacityPeriod,
        });
        await simulationResultEdgeRepo.insertMany(db, [{
          organisationId: who.organisationId, resultId: id, position: 1, edgeId: c.edge.id, edgeKind: c.edge.kind, edgeSource: c.edge.source, sampleSize: null,
        }]);
      }
      for (const s of result.stopped) {
        await simulationResultRepo.insert(db, {
          id: uuidv7(), organisationId: who.organisationId, runId: run.id, resultKind: 'stopped', pathMode: 'deterministic', stopReason: s.reason,
          stopEdgeId: s.edgeId, stopObjectTypeId: s.objectTypeId, stopHop: s.hop,
        });
        if (s.reason === 'unconfirmed_edge') {
          await recordEvent(db, who, ctx.correlationId, {
            event: 'simulation_crossed_unconfirmed_edge', resource: { type: 'simulation_run', id: run.id }, detail: { edge_id: s.edgeId },
          });
        }
      }
      await simulationRunRepo.update(db, run.id, { status: 'completed', completedAt: new Date().toISOString(), boundedAtHop: result.boundedAtHop });
      const types = [...new Set([...originTypes, ...result.reached.map((r) => r.objectTypeId)])];
      await writeLineage(db, lineageActor, {
        artefact,
        inputs: [
          { node: { kind: 'scenario', refId: scenario.id, version: String(scenario.version) }, relation: 'simulates' },
          ...types.flatMap((id) => {
            const t = manifest.objectTypes.find((x) => x.id === id);
            return t === undefined ? [] : [{ node: { kind: 'object_type_version' as const, refId: t.id, version: t.typeVersionId }, relation: 'derives' as const }];
          }),
        ],
      });
      await recordEvent(db, who, ctx.correlationId, {
        event: 'simulation_run', resource: { type: 'simulation_run', id: run.id },
        detail: {
          scenario_id: scenario.id, graph_version: Number(run.graphVersion), reached_hard: result.reached.filter((r) => !r.viaSoftEdge).length,
          reached_soft: result.reached.filter((r) => r.viaSoftEdge).length, stopped: result.stopped.length, resource_edges_skipped: result.resourceEdgesSkipped,
          operation: charged?.operation ?? null, branch_id: input.branchId ?? null,
        },
      });
      if (result.boundedAtHop !== null) {
        await recordEvent(db, who, ctx.correlationId, {
          event: 'simulation_bounded', resource: { type: 'simulation_run', id: run.id }, detail: { hop: result.boundedAtHop, fan_out: bounds.fanOut },
        });
      }
    });
  } catch (error) {
    if (isAppError(error) && error.code === 'lineage.write_failed') {
      await reportLineageWriteFailure(control, lineageActor, artefact, ctx.correlationId, 'simulation')
        .catch((e: unknown) => deps.logger.failure('recording the lineage failure failed', e, { event: 'simulation.lineage_failure_unrecorded' }));
    }
    await failRun();
    throw error;
  }
}

/** A run as the reader sees it: results on object types they are not cleared for are withheld and counted. */
export async function readRun(deps: SimulationDeps, ctx: Context, runId: string, chargeView: RunView['charge'] = null): Promise<RunView> {
  const who = member(ctx);
  const loaded = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const run = await simulationRunRepo.findById(db, runId);
    if (run === undefined) return undefined;
    const scenario = await scenarioRepo.findById(db, run.scenarioId);
    const results = await simulationResultRepo.listForRun(db, runId);
    const edges = await simulationResultEdgeRepo.listFor(db, results.map((r) => r.id));
    return { run, scenario, results, edges };
  }, { readOnly: true });
  const held = loaded?.scenario === undefined ? undefined
    : await inTransaction(deps.databases.pool('control'), who.request, (db) => heldOn(db, loaded.scenario!, who.membershipId), { readOnly: true });
  if (loaded === undefined || held === undefined) {
    throw new AppError('not_found', 'no such run', { code: 'simulation.run_not_found' });
  }
  const seen = await visibility(deps, ctx, { objectTypes: loaded.results.flatMap((r) => (r.affectedObjectTypeId ? [r.affectedObjectTypeId] : [])) });
  const view = (r: (typeof loaded.results)[number]): ResultView => ({
    kind: r.resultKind, objectTypeId: r.affectedObjectTypeId, objectId: r.affectedObjectKey, viaSoftEdge: r.viaSoftEdge,
    delay: iso8601(r.delaySeconds),
    effect: r.resultKind === 'stopped' ? null : r.capacityShortfall !== null ? 'constrained' : r.delaySeconds === null ? 'fails' : 'delayed',
    shortfall: r.capacityShortfall === null ? null : Number(r.capacityShortfall),
    period: (r.capacityPeriod ?? null) as 'day' | 'week' | 'month' | null,
    unavailableFor: r.unavailableSeconds === null ? null : iso8601(r.unavailableSeconds),
    pathMode: r.pathMode, probability: r.probability === null ? null : Number(r.probability),
    probabilityInterval: r.probability === null || loaded.run.iterations === null ? null
      : credibleInterval(Math.round(Number(r.probability) * loaded.run.iterations), loaded.run.iterations)
        .map((x) => Math.round(x * 10_000) / 10_000) as [number, number],
    spread: r.delaySpread === null ? null : (({ p10, p50, p90 }: Record<string, number | null>) => ({ p10: iso8601(p10 ?? null), p50: iso8601(p50 ?? null), p90: iso8601(p90 ?? null) }))(
      r.delaySpread as Record<string, number | null>),
    path: loaded.edges.filter((e) => e.resultId === r.id).map((e) => ({ edgeId: e.edgeId, kind: e.edgeKind, source: e.edgeSource, sampleSize: e.sampleSize })),
    stop: r.resultKind === 'stopped' ? { reason: r.stopReason!, edgeId: r.stopEdgeId, objectTypeId: r.stopObjectTypeId, hop: r.stopHop } : null,
  });
  const visible = loaded.results.filter((r) => r.affectedObjectTypeId === null || seen.typeVisible(r.affectedObjectTypeId));
  return runViewOf(loaded.run, chargeView, visible.filter((r) => r.resultKind === 'reached').map(view),
    visible.filter((r) => r.resultKind === 'stopped').map(view), loaded.results.length - visible.length);
}

function runViewOf(run: SimulationRun, chargeView: RunView['charge'], reached: ResultView[], stopped: ResultView[], withheld: number): RunView {
  return {
    runId: run.id, scenarioId: run.scenarioId, mode: run.mode, graphVersion: Number(run.graphVersion), status: run.status, boundedAtHop: run.boundedAtHop,
    startedAt: run.startedAt, completedAt: run.completedAt, charge: chargeView, reached, stopped, withheld,
    iterations: run.iterations, statement: run.mode === 'probabilistic' ? INDEPENDENCE_STATEMENT : null,
    inferred: run.inferred, inferenceStatement: run.inferred ? INFERENCE_STATEMENT : null,
  };
}

/** Which objects entered or left the affected set, and whether the graph changed between the runs (39.7). */
export async function compareRuns(deps: SimulationDeps, ctx: Context, scenarioId: string, fromRunId: string, toRunId: string) {
  const who = member(ctx);
  await heldScenario(deps, who, scenarioId, 'view');
  const [a, b] = [await readRun(deps, ctx, fromRunId), await readRun(deps, ctx, toRunId)];
  if (a.scenarioId !== scenarioId || b.scenarioId !== scenarioId) throw new AppError('not_found', 'no such run', { code: 'simulation.run_not_found' });
  const set = (v: RunView) => new Map(v.reached.map((r) => [`${r.objectTypeId}:${r.objectId}`, { objectTypeId: r.objectTypeId!, objectId: r.objectId! }]));
  const [before, after] = [set(a), set(b)];
  const entered = [...after.entries()].filter(([k]) => !before.has(k)).map(([, v]) => v);
  const left = [...before.entries()].filter(([k]) => !after.has(k)).map(([, v]) => v);
  const graphChanged = a.graphVersion !== b.graphVersion;
  await inTransaction(deps.databases.pool('control'), who.request, (db) => recordEvent(db, who, ctx.correlationId, {
    event: 'scenario_compared', resource: { type: 'scenario', id: scenarioId },
    detail: { entered: entered.length, left: left.length, graph_changed: graphChanged },
  }));
  return { entered, left, graphChanged, comparable: !graphChanged };
}

/** A scenario's own runs, newest first, without their results (D269). */
export async function listRuns(deps: SimulationDeps, ctx: Context, scenarioId: string, limit: number) {
  const who = member(ctx);
  await heldScenario(deps, who, scenarioId, 'view');
  const rows = await inTransaction(deps.databases.pool('control'), who.request, (db) => simulationRunRepo.listForScenario(db, scenarioId, limit), { readOnly: true });
  return {
    runs: rows.map((r) => ({
      runId: r.id, mode: r.mode, iterations: r.iterations, graphVersion: Number(r.graphVersion), status: r.status, boundedAtHop: r.boundedAtHop,
      inferred: r.inferred, runBy: r.runByMembershipId, startedAt: r.startedAt, completedAt: r.completedAt,
    })),
  };
}

/** A scenario's latest completed run as stored, the graph's version now, and whether it changed since (30.9). */
export async function latestRun(deps: SimulationDeps, ctx: Context, scenarioId: string): Promise<{ run: RunView | null; graphVersion: number; graphChanged: boolean }> {
  const who = member(ctx);
  await heldScenario(deps, who, scenarioId, 'view');
  const { run, graphVersion } = await inTransaction(deps.databases.pool('control'), who.request, async (db) => ({
    run: await simulationRunRepo.latestForScenario(db, scenarioId), graphVersion: await graphStateRepo.current(db, who.organisationId),
  }), { readOnly: true });
  if (run === undefined) return { run: null, graphVersion, graphChanged: false };
  const view = await readRun(deps, ctx, run.id);
  return { run: view, graphVersion, graphChanged: view.graphVersion !== graphVersion };
}
