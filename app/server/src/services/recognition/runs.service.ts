// Running detectors on demand (spec 38.2 to 38.5), within the runner's visibility.
//
// For one object type: each requested (or every enabled) detector is checked against what
// it declares it needs, then the population is read once through the executor with every
// property a runnable detector examines. Each detector's run is one transaction: the run
// row (recorded even when it produced nothing), its thresholds (derived from the
// population the first time, persisted and reused), the findings with their objects,
// connections, scores and lineage (the finding's markings come from lineage, spec 58.6),
// the earlier findings it supersedes, the links between findings about the same objects,
// and the audit events. After commit, the runner is told of the run's strongest finding.

import type { ObjectTypeView } from '../../contracts/ontology/manifest.contract.ts';
import { raiseNotification } from '../../contracts/notify/notification.contract.ts';
import { readHistory } from '../../contracts/siloes/siloes.contract.ts';
import type { RunState, RunView } from '../../contracts/recognition/detector.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Detector } from '../../models/recognition/detector.model.ts';
import type { DetectorRun } from '../../models/recognition/detectorRun.model.ts';
import {
  detectorConfigurationRepo, detectorRepo, detectorRunRepo, detectorThresholdRepo, findingConnectionRepo, findingLinkRepo, findingMarkingRepo,
  findingObjectRepo, findingRepo, findingScoreRepo, type DetectorConfiguration,
} from '../../repos/recognition/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { reportLineageWriteFailure, writeLineage } from '../lineage/writer.service.ts';
import { access, actor, demand, readManifest, recordEvent, typeOf, type Actor, type Context, type RecognitionDeps } from './deps.service.ts';
import {
  DETECTOR_VERSION, deriveThreshold, isFederated, PER_PROPERTY, runDetector, type ExaminedProperty, type FederatedDetector, type RawFinding,
} from './detectors.service.ts';
import { readPopulation, type PopulationRead } from './population.service.ts';
import { deriveHistoryThreshold, drift, isHistory, recurrence, timingDeviation, type HistoryDetector } from './history.service.ts';

interface Plan {
  detector: Detector;
  examined: ExaminedProperty[];
  examinedIds: string[];
  state?: { state: Exclude<RunState, 'ran'>; detail: Record<string, string | number> };
}

export async function runDetectorsOn(deps: RecognitionDeps, ctx: Context, input: { objectTypeId: string; detectors?: string[] | undefined })
  : Promise<{ runs: RunView[]; disabled: string[] }> {
  const who = actor(ctx);
  await demand(deps, ctx, 'recognition.run');
  const manifest = await readManifest(deps, ctx);
  const type = typeOf(manifest, input.objectTypeId);
  const control = deps.databases.pool('control');
  const { registry, configurations } = await inTransaction(control, who.request, async (db) => ({
    registry: await detectorRepo.listActive(db),
    configurations: await detectorConfigurationRepo.listForType(db, type.id),
  }), { readOnly: true });

  const wanted = input.detectors ?? registry.map((d) => d.key);
  const unknown = wanted.filter((key) => !registry.some((d) => d.key === key));
  if (unknown.length > 0) {
    throw new AppError('validation', 'no such detector', { code: 'recognition.detector_unknown', details: { detector: unknown[0]! } });
  }
  const configOf = (d: Detector): DetectorConfiguration | undefined => configurations.find((c) => c.detectorId === d.id);
  const chosen = registry.filter((d) => wanted.includes(d.key));
  const disabled = chosen.filter((d) => configOf(d)?.enabled === false).map((d) => d.key);
  const enabled = chosen.filter((d) => configOf(d)?.enabled !== false);

  // What the runner may examine: visible, with no field policy (masked or redacted values
  // cannot be examined without disclosing them in a finding).
  const configured = [...new Set(enabled.flatMap((d) => configOf(d)?.propertyIdentityIds ?? []))];
  const decision = await access(deps, ctx, {
    objectTypes: [type.id], properties: configured, connections: type.contributingObjects.map((c) => c.connectionId),
  });
  if (!decision.allowed || !decision.typeVisible(type.id)) {
    throw new AppError('not_found', 'no such object type', { code: 'recognition.object_type_not_found' });
  }
  const plans: Plan[] = enabled.map((detector) => planFor(detector, configOf(detector), type, decision.propertyClear));

  const runnable = plans.filter((p) => p.state === undefined && !isHistory(p.detector.key));
  const population: PopulationRead | undefined = runnable.length === 0 ? undefined
    : await readPopulation(deps, ctx, manifest, type.id, [...new Set(runnable.flatMap((p) => p.examinedIds))]);

  const runs: RunView[] = [];
  for (const plan of plans) {
    const startedAt = new Date().toISOString();
    if (plan.state === undefined && isHistory(plan.detector.key)) {
      runs.push(await runHistory(deps, who, ctx.correlationId, plan, type, startedAt));
      continue;
    }
    if (plan.state !== undefined || population === undefined || population.kind !== 'read') {
      const state = plan.state ?? { state: population!.kind as Exclude<RunState, 'ran'>, detail: (population as { detail: Record<string, string | number> }).detail };
      runs.push(await recordStateRun(deps, who, ctx.correlationId, plan, type, state, startedAt));
      continue;
    }
    runs.push(await recordFindingsRun(deps, who, ctx.correlationId, plan, type, population, startedAt));
  }
  return { runs, disabled };
}

/** What a detector needs (38.2), checked before anything is read. */
function planFor(detector: Detector, config: DetectorConfiguration | undefined, type: ObjectTypeView, clear: (id: string) => boolean): Plan {
  // Timeliness examines the time field it is given (decision 2026-11-14), not named properties.
  const named = detector.key === 'timeliness'
    ? (config?.timeFieldIdentityId === null || config?.timeFieldIdentityId === undefined ? [] : [config.timeFieldIdentityId])
    : (config?.propertyIdentityIds ?? []);
  const properties = named.flatMap((id) => {
    const p = type.properties.find((q) => q.identityId === id && q.status === 'active');
    return p === undefined ? [] : [p];
  });
  const visible = properties.filter((p) => clear(p.identityId));
  const plan: Plan = {
    detector, examined: visible.map((p) => ({ apiName: p.apiName, dataType: p.dataType })), examinedIds: visible.map((p) => p.identityId),
  };
  if (detector.requiresTimeField && (config?.timeFieldIdentityId ?? null) === null) {
    plan.state = { state: 'not_configured', detail: { missing: 'time_field' } };
  } else if (detector.requiresProperty && plan.examined.length === 0) {
    plan.state = { state: 'not_configured', detail: { missing: 'property', notVisible: properties.length - visible.length } };
  } else if (detector.executionMode === 'history') {
    // Spec 38.2: the three history detectors run over the transitions Siloes Capture holds
    // (chapter 67), read when the run comes to them. Each examines the one property it is given.
    if (!isHistory(detector.key)) plan.state = { state: 'not_configured', detail: { missing: 'detector_rules' } };
    else if (plan.examined.length === 0) plan.state = { state: 'not_configured', detail: { missing: 'property', notVisible: properties.length - visible.length } };
  } else if (!isFederated(detector.key)) {
    plan.state = { state: 'not_configured', detail: { missing: 'detector_rules' } };
  }
  return plan;
}

const runRow = (who: Actor, plan: Plan, type: ObjectTypeView, startedAt: string, state: RunState, detail: Record<string, string | number> | null,
  population: number | null, findings: number): Parameters<typeof detectorRunRepo.insert>[1] => ({
  id: uuidv7(), organisationId: who.organisationId, detectorId: plan.detector.id, detectorVersion: plan.detector.currentVersion,
  objectTypeId: type.id, properties: plan.examined.map((p) => p.apiName), state, stateDetail: detail,
  populationCount: population === null ? null : String(population), baseline: null, findingsCount: findings,
  runByMembershipId: who.membershipId ?? null, startedAt, completedAt: new Date().toISOString(),
});

async function recordStateRun(deps: RecognitionDeps, who: Actor, correlationId: string, plan: Plan, type: ObjectTypeView,
  state: { state: Exclude<RunState, 'ran'>; detail: Record<string, string | number> }, startedAt: string,
  baseline?: { have: number; need: number; unit: string }): Promise<RunView> {
  const row = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const run = await detectorRunRepo.insert(db, { ...runRow(who, plan, type, startedAt, state.state, state.detail, null, 0), baseline: (baseline ?? null) as never });
    await recordEvent(db, who, correlationId, {
      event: 'detector_run', resource: { type: 'detector_run', id: run.id },
      detail: { detector: plan.detector.key, state: state.state, object_type_id: type.id, findings: 0 },
    });
    return run;
  });
  return runView(row, plan.detector.key);
}

async function recordFindingsRun(deps: RecognitionDeps, who: Actor, correlationId: string, plan: Plan, type: ObjectTypeView,
  population: Extract<PopulationRead, { kind: 'read' }>, startedAt: string): Promise<RunView> {
  const key = plan.detector.key as FederatedDetector;
  return persistFindingsRun(deps, who, correlationId, plan, type, startedAt, {
    population: population.objects.length,
    raise: (thresholdOf) => runDetector(key, population.objects, plan.examined, thresholdOf).findings,
    coverage: (properties) => coverageOf(population, properties),
    perProperty: PER_PROPERTY[key], derive: () => deriveThreshold(key, population.objects.length), inputs: [],
  });
}

/** Transitions a history detector reads in one run; more is refused as bounded, never judged in part. */
export const HISTORY_LIMIT = 10_000;

/**
 * A history detector's run (38.2, 67.4): the property's transitions from the history
 * resolver. No Silo holds them: history_unavailable. Fewer than the detector's minimum
 * baseline (in transitions, or days since capture began): accumulating_baseline, with how
 * much there is and how much is needed; it never runs on a thin baseline.
 */
async function runHistory(deps: RecognitionDeps, who: Actor, correlationId: string, plan: Plan, type: ObjectTypeView, startedAt: string): Promise<RunView> {
  const key = plan.detector.key as HistoryDetector;
  const property = plan.examined[0]!.apiName;
  const baseline = plan.detector.minimumBaseline as { amount: number; unit: 'days' | 'transitions' } | null;
  const read = await deps.services.call(readHistory, {
    body: { objectTypeId: type.id, property, minimumTransitions: baseline?.unit === 'transitions' ? baseline.amount : 0, limit: HISTORY_LIMIT },
  }, { request: who.request, correlationId });
  const state = (s: Exclude<RunState, 'ran'>, detail: Record<string, string | number>, have?: { have: number; need: number; unit: string }) =>
    recordStateRun(deps, who, correlationId, plan, type, { state: s, detail }, startedAt, have);
  if (read.state === 'unavailable' || read.state === 'withheld') return state('history_unavailable', { history: read.state });
  if (read.state === 'building') {
    return state('accumulating_baseline', { have: read.have, need: read.need, unit: 'transitions' }, { have: read.have, need: read.need, unit: 'transitions' });
  }
  if (baseline?.unit === 'days') {
    const days = read.capturedFrom === null ? 0 : Math.floor((Date.now() - Date.parse(read.capturedFrom)) / 86_400_000);
    if (days < baseline.amount) return state('accumulating_baseline', { have: days, need: baseline.amount, unit: 'days' }, { have: days, need: baseline.amount, unit: 'days' });
  }
  if (read.have > HISTORY_LIMIT || read.transitions.length < read.have) return state('bounded', { transitions: read.have, limit: HISTORY_LIMIT });

  const transitions = read.transitions;
  const now = new Date();
  const compute = (threshold: number) => key === 'timing_deviation' ? timingDeviation(transitions, property, now, () => threshold)
    : key === 'drift' ? drift(transitions, property, () => threshold) : recurrence(transitions, property, () => threshold);
  const objects = new Set(transitions.map((t) => t.objectRef)).size;
  return persistFindingsRun(deps, who, correlationId, plan, type, startedAt, {
    population: objects,
    raise: (thresholdOf) => compute(thresholdOf(property)).findings.map((f) => ({ ...f, thresholdProperty: property })),
    coverage: () => ({ decided: objects, disputed: 0, empty: 0, unchecked: 0 }),
    perProperty: true, derive: () => deriveHistoryThreshold(read.have),
    inputs: read.siloId === null ? [] : [{ node: { kind: 'silo', refId: read.siloId, version: '1' }, relation: 'read_via' }],
  });
}

/** What one run raised, and how its run is told: shared by the federated and the history detectors. */
interface Raising {
  population: number;
  raise: (thresholdOf: (property: string | null) => number) => RawFinding[];
  coverage: (properties: readonly string[]) => { decided: number; disputed: number; empty: number; unchecked: number };
  perProperty: boolean;
  derive: () => number;
  /** Lineage inputs besides the type and connections: the Silo a history detector read. */
  inputs: { node: { kind: 'silo'; refId: string; version: string }; relation: 'read_via' }[];
}

async function persistFindingsRun(deps: RecognitionDeps, who: Actor, correlationId: string, plan: Plan, type: ObjectTypeView, startedAt: string,
  raising: Raising): Promise<RunView> {
  const key = plan.detector.key;
  const control = deps.databases.pool('control');
  const raisedAt = new Date().toISOString();
  const findingIds: string[] = [];
  const lineageActor = { organisationId: who.organisationId, createdBy: { membershipId: who.membershipId, servicePrincipalId: who.servicePrincipalId } };
  let failedArtefact: string | undefined;
  let run: DetectorRun;
  try {
    run = await inTransaction(control, who.request, async (db) => {
      const thresholds = await thresholdsFor(db, who.organisationId, plan, type.id, raising.perProperty, raising.derive);
      const raised: RawFinding[] = raising.raise((property) => thresholds.get(property ?? '')!);
      const inserted = await detectorRunRepo.insert(db, runRow(who, plan, type, startedAt, 'ran', null, raising.population, raised.length));
      await findingRepo.supersedeCurrent(db, plan.detector.id, type.id, raisedAt);

      for (const f of raised) {
        const id = uuidv7();
        findingIds.push(id);
        const connections = connectionsOf(type, f.properties);
        await findingRepo.insert(db, {
          id, organisationId: who.organisationId, detectorRunId: inserted.id, detectorId: plan.detector.id, objectTypeId: type.id,
          objectRefs: { objectIds: f.objectIds }, properties: f.properties,
          computation: {
            statistic: f.statistic, value: f.value, threshold: f.threshold, comparison: 'ge', population: raising.population, sampleSize: f.sampleSize,
          },
          coverage: raising.coverage(f.properties), raisedAt,
        });
        await findingObjectRepo.insertMany(db, who.organisationId, f.objectIds.map((objectKey) => ({ findingId: id, objectTypeId: type.id, objectKey })));
        await findingConnectionRepo.insertMany(db, who.organisationId, connections.map((c) => ({ findingId: id, connectionId: c.connectionId })));
        await findingScoreRepo.insert(db, { organisationId: who.organisationId, findingId: id, detectorId: plan.detector.id, score: String(f.score), computedAt: raisedAt });
        // A finding is an artefact: its lineage and inherited markings in this transaction (spec 59.3, 58.6).
        failedArtefact = id;
        const written = await writeLineage(db, lineageActor, {
          artefact: { kind: 'finding', refId: id, version: '1' },
          inputs: [
            { node: { kind: 'object_type_version', refId: type.id, version: type.typeVersionId }, relation: 'derives' },
            ...connections.map((c) => ({ node: { kind: 'connection' as const, refId: c.connectionId, version: c.connectorVersion }, relation: 'read_via' as const })),
            ...raising.inputs,
          ],
        });
        failedArtefact = undefined;
        await findingMarkingRepo.insertMany(db, who.organisationId, written.markingIds.map((markingId) => ({ findingId: id, markingId })));
        await recordEvent(db, who, correlationId, {
          event: 'finding_raised', resource: { type: 'finding', id },
          detail: { detector: key, run_id: inserted.id, objects: f.objectIds.length, statistic: f.statistic },
        });
      }

      // Links between findings about the same objects, each stored both ways (38.3).
      const pairs = new Map<string, { findingId: string; linkedFindingId: string; shared: number }>();
      for (const p of await findingObjectRepo.sharedWithCurrent(db, findingIds)) {
        const [a, b] = p.findingId < p.linkedFindingId ? [p.findingId, p.linkedFindingId] : [p.linkedFindingId, p.findingId];
        pairs.set(`${a}:${b}`, { findingId: a, linkedFindingId: b, shared: p.shared });
      }
      await findingLinkRepo.insertBothWays(db, who.organisationId, [...pairs.values()]);
      await recordEvent(db, who, correlationId, {
        event: 'detector_run', resource: { type: 'detector_run', id: inserted.id },
        detail: { detector: key, state: 'ran', object_type_id: type.id, population: raising.population, findings: raised.length },
      });
      return inserted;
    });
  } catch (error) {
    if (failedArtefact !== undefined && (error as { code?: string }).code === 'lineage.write_failed') {
      await reportLineageWriteFailure(control, lineageActor, { kind: 'finding', refId: failedArtefact, version: '1' }, correlationId, 'recognition')
        .catch((e: unknown) => deps.logger.failure('recording the lineage failure failed', e, { event: 'recognition.lineage_failure_unrecorded' }));
    }
    throw error;
  }

  // The runner hears of the run's strongest finding (Home, spec 33): one item per run, not per finding.
  if (who.membershipId !== undefined && findingIds.length > 0) {
    await deps.services.call(raiseNotification, {
      body: { recipientMembershipId: who.membershipId, kind: 'finding_new', source: { findingId: findingIds[0]! } },
    }, { request: who.request, correlationId }).catch((error: unknown) => deps.logger.failure('raising the finding notification failed', error, {
      event: 'recognition.notify_failed', resourceId: run.id,
    }));
  }
  return runView(run, key);
}

/** The persisted thresholds a run uses, derived from this population where none exists yet (38.5). */
async function thresholdsFor(db: Queryable, organisationId: string, plan: Plan, objectTypeId: string, perProperty: boolean, derive: () => number)
  : Promise<Map<string, number>> {
  const properties: (string | null)[] = perProperty ? plan.examined.map((p) => p.apiName) : [null];
  const out = new Map<string, number>();
  for (const property of properties) {
    let row = await detectorThresholdRepo.findByDetectorIdAndObjectTypeIdAndProperty(db, { organisationId, detectorId: plan.detector.id, objectTypeId, property });
    if (row === undefined) {
      try {
        row = await detectorThresholdRepo.insert(db, {
          id: uuidv7(), organisationId, detectorId: plan.detector.id, objectTypeId, property, value: String(derive()),
          origin: 'derived', tuned: false,
        });
      } catch (error) {
        if (fromDatabaseError(error).category !== 'conflict') throw error;
        throw new AppError('conflict', 'another run is deriving this detector\'s threshold; run it again', { code: 'recognition.run_concurrent' });
      }
    }
    out.set(property ?? '', Number(row.value));
  }
  return out;
}

/** The contributing systems behind the properties a finding names; every one when it names none. */
function connectionsOf(type: ObjectTypeView, properties: readonly string[]) {
  const named = type.properties.filter((p) => properties.includes(p.apiName));
  const ids = new Set(properties.length === 0 ? type.contributingObjects.map((c) => c.connectionId) : named.flatMap((p) => p.mappings.map((m) => m.connectionId)));
  const seen = new Set<string>();
  return type.contributingObjects.filter((c) => ids.has(c.connectionId) && !seen.has(c.connectionId) && seen.add(c.connectionId));
}

function coverageOf(population: Extract<PopulationRead, { kind: 'read' }>, properties: readonly string[]) {
  const n = population.objects.length;
  if (properties.length === 0) return { decided: n, disputed: 0, empty: 0, unchecked: 0 };
  const disputed = properties.reduce((s, p) => s + (population.coverage.disputed[p] ?? 0), 0);
  const empty = properties.reduce((s, p) => s + (population.coverage.empty[p] ?? 0), 0);
  return { decided: Math.max(n * properties.length - disputed - empty, 0), disputed, empty, unchecked: 0 };
}

export function runView(run: DetectorRun, detectorKey: string): RunView {
  const baseline = run.baseline as { have: number; need: number; unit: string } | null;
  return {
    runId: run.id, detector: detectorKey, detectorVersion: run.detectorVersion, objectTypeId: run.objectTypeId, properties: run.properties,
    state: run.state, stateDetail: run.stateDetail as Record<string, never> | null,
    populationCount: run.populationCount === null ? null : Number(run.populationCount), baseline, findingsCount: run.findingsCount,
    startedAt: run.startedAt, completedAt: run.completedAt,
  };
}

export { DETECTOR_VERSION };
