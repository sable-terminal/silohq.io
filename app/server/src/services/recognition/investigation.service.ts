// Investigation (spec 38.8): questions of the estate rather than of the business, each
// composed from detector output, association analysis and federated reads, about one type.
//
//   gaps            current: empty values per property, records standing alone for want of a
//                   match key, properties held by one system only, open resolution proposals.
//                   history: when a property became empty, and from which system.
//   contradictions  current: disputed values per property (field authority, chapter 23) and
//                   the disagreement detector's findings. history: on the disputed objects,
//                   which system changed the value last, and since when.
//   anomalies       current: the federated detectors' findings. history: deviation from an
//                   object's own past (timing deviation, drift).
//   clusters        history throughout: clustering is a statement about repetition over time.
//                   Recurrence, associations over a designated outcome, and shared identifiers.
//
// Without a Capture Silo holding the type's history (or what the reader may read of it) the
// answer is the current part and a statement naming what it cannot answer; a history part is
// never computed from current state. Every statement is a computed fact in fixed language:
// counts, names, moments. No record value appears, investigation never asserts fraud, and a
// person decides what a cluster means.

import { listResolutionProposals } from '../../contracts/resolution/proposal.contract.ts';
import type { ObjectTypeView, PropertyView } from '../../contracts/ontology/manifest.contract.ts';
import type { AnswerPart, AssociationView, Question } from '../../contracts/recognition/association.contract.ts';
import type { FindingView } from '../../contracts/recognition/finding.contract.ts';
import { readCaptureCoverage, readHistory } from '../../contracts/siloes/siloes.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import {
  associationComputationRepo, associationRepo, detectorRepo, detectorRunRepo, findingRepo, outcomeDesignationRepo,
} from '../../repos/recognition/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { fixedLanguage, neutral, restsOn, visibleAssociations } from './associations.service.ts';
import { access, actor, demand, readManifest, typeOf, type Context, type RecognitionDeps } from './deps.service.ts';
import { assemble, visibleTo } from './findings.service.ts';
import { readPopulation, type PopulationRead } from './population.service.ts';
import { HISTORY_LIMIT } from './runs.service.ts';

/** Findings an investigation draws on. */
const FINDINGS_LIMIT = 500;

const DETECTORS: Record<Question, { current: string[]; history: string[] }> = {
  gaps: { current: ['missing_value', 'unmatched_record'], history: [] },
  contradictions: { current: ['disagreement'], history: [] },
  anomalies: { current: ['outlier', 'uniqueness', 'timeliness', 'duplicate_value'], history: ['timing_deviation', 'drift'] },
  clusters: { current: ['duplicate_value'], history: ['recurrence'] },
};

const NEEDS_CAPTURE: Record<Question, (plural: string) => string> = {
  gaps: (p) => `When a gap opened, or a system stopped populating a field, needs captured history of ${p}: a Capture Silo.`,
  contradictions: (p) => `When a contradiction began, and which system changed, needs captured history of ${p}: a Capture Silo.`,
  anomalies: (p) => `Deviation from an object's own past (timing deviation, drift) needs captured history of ${p}: a Capture Silo.`,
  clusters: (p) => `Clustering is a statement about repetition over time: it needs captured history of ${p}: a Capture Silo.`,
};

type History = 'held' | 'not_held' | 'unavailable';

interface Capture { history: History; properties: string[] }

/** What Capture holds of the type that the reader may read. */
async function captureOf(deps: RecognitionDeps, ctx: Context, objectTypeId: string): Promise<Capture> {
  try {
    const read = await deps.services.call(readCaptureCoverage, { body: { objectTypeId } }, { request: ctx.request, correlationId: ctx.correlationId });
    return read.state === 'silo' && read.properties.length > 0 ? { history: 'held', properties: read.properties } : { history: 'not_held', properties: [] };
  } catch (error) {
    if (isAppError(error) && ['unavailable', 'timeout', 'capacity', 'rate_limited', 'upstream'].includes(error.category)) return { history: 'unavailable', properties: [] };
    throw error;
  }
}

const part = (p: Partial<AnswerPart> & Pick<AnswerPart, 'kind' | 'count' | 'statement'>): AnswerPart => ({
  property: null, detector: null, connectionId: null, of: null, at: null, ...p, statement: fixedLanguage(p.statement),
});

const empty = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const iso = (t: string): string => new Date(t).toISOString();

export async function investigate(deps: RecognitionDeps, ctx: Context, input: { question: Question; objectTypeId: string }) {
  const who = actor(ctx);
  await demand(deps, ctx, 'recognition.run');
  const manifest = await readManifest(deps, ctx);
  const type = typeOf(manifest, input.objectTypeId);
  const candidates = type.properties.filter((p) => p.status !== 'retired' && p.computedFunctionVersionId === null);
  const decision = await access(deps, ctx, { objectTypes: [type.id], properties: candidates.map((p) => p.identityId) });
  if (!decision.allowed || !decision.typeVisible(type.id)) throw new AppError('not_found', 'no such object type', { code: 'recognition.object_type_not_found' });
  // What may be examined: visible with no field policy, as a detector examines (38.2).
  const examined = candidates.filter((p) => decision.propertyClear(p.identityId));
  const plural = neutral('objects', type.pluralName, type.apiName);
  const nameOf = (p: PropertyView) => neutral('a property', p.displayName, p.apiName);
  const capture = await captureOf(deps, ctx, type.id);
  const held = capture.history === 'held';
  const wanted = DETECTORS[input.question];
  const historyAsked = input.question === 'clusters' ? held : true;

  // The stored part: findings, latest runs, associations over outcomes.
  const stored = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const registry = await detectorRepo.listActive(db);
    const keys = [...wanted.current, ...(held ? wanted.history : [])];
    const ids = registry.filter((d) => keys.includes(d.key)).map((d) => d.id);
    const rows = ids.length === 0 || (input.question === 'clusters' && !held) ? []
      : (await findingRepo.list(db, { objectTypeId: type.id, includeSuperseded: false, limit: FINDINGS_LIMIT })).filter((f) => ids.includes(f.detectorId));
    const latest = await associationComputationRepo.latest(db);
    const outcomes = await outcomeDesignationRepo.listLive(db, type.id);
    const associations = input.question !== 'clusters' || !held || latest === undefined || outcomes.length === 0 ? []
      : (await associationRepo.listFor(db, latest.id, type.id)).filter((a) => outcomes.some((o) =>
        (a.rightObjectTypeId === o.objectTypeId && a.rightProperty === o.property && a.rightDetectorId === o.detectorId)
        || (a.leftObjectTypeId === o.objectTypeId && a.leftProperty === o.property && a.leftDetectorId === o.detectorId)));
    const typeIds = [...new Set(associations.flatMap((a) => [a.leftObjectTypeId, a.rightObjectTypeId]))];
    return {
      registry, assembled: await assemble(db, rows, manifest, undefined), latestRuns: await detectorRunRepo.latestPerDetector(db, type.id),
      associations, outcomes: await outcomeDesignationRepo.listLive(db),
      rests: associations.length === 0 ? { properties: [], markings: [] } : await restsOn(db, typeIds),
    };
  }, { readOnly: true });
  const { visible, withheld: findingsWithheld } = await visibleTo(deps, ctx, stored.assembled);
  const findings = visible.map((a) => a.view);
  const shownAssociations = await visibleAssociations(deps, ctx, manifest, stored.associations, stored.rests, stored.outcomes, stored.registry);
  const detectorName = (key: string) => neutral('a detector', stored.registry.find((d) => d.key === key)?.name, key);

  // The federated read, for the questions whose current part rests on values.
  let population: PopulationRead | undefined;
  if ((input.question === 'gaps' || input.question === 'contradictions') && examined.length > 0) {
    population = await readPopulation(deps, ctx, manifest, type.id, examined.map((p) => p.identityId));
  }
  const read = population?.kind === 'read' ? population : undefined;
  const ranPopulation = Math.max(0, ...stored.latestRuns.filter((r) => r.state === 'ran').map((r) => Number(r.populationCount ?? 0)));

  const current: AnswerPart[] = [];
  const historical: AnswerPart[] = [];
  const requiresCapture: string[] = [];
  const history = (property: string, objectRefs?: string[]) => deps.services.call(readHistory, {
    body: { objectTypeId: type.id, property, ...(objectRefs === undefined ? {} : { objectRefs }), limit: HISTORY_LIMIT },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  const needsCapture = () => { if (!held) requiresCapture.push(NEEDS_CAPTURE[input.question](plural)); };
  const findingParts = (keys: readonly string[], into: AnswerPart[]) => {
    for (const key of keys) {
      const own = findings.filter((f) => f.detector === key);
      const run = stored.latestRuns.find((r) => stored.registry.find((d) => d.id === r.detectorId)?.key === key);
      if (own.length > 0) {
        const objects = new Set(own.flatMap((f) => f.objectIds)).size;
        into.push(part({ kind: 'findings', detector: key, count: objects, of: ranPopulation || null,
          statement: `${detectorName(key)} names ${objects} ${plural} in ${own.length} current findings.` }));
      } else {
        into.push(detectorState(key, run, plural, detectorName(key)));
      }
    }
  };

  if (input.question === 'gaps') {
    if (read !== undefined) {
      const total = read.objects.length;
      for (const p of examined) {
        const n = read.coverage.empty[p.apiName] ?? 0;
        if (n > 0) current.push(part({ kind: 'empty_values', property: p.apiName, count: n, of: total, statement: `${nameOf(p)} is empty on ${n} of ${total} ${plural}.` }));
      }
      if (read.coverage.unmatched > 0) {
        current.push(part({ kind: 'unmatched_records', count: read.coverage.unmatched, of: total,
          statement: `${read.coverage.unmatched} of ${total} ${plural} stand alone: no full match key to resolve them by.` }));
      }
    }
    current.push(...singleSystem(type, examined, nameOf));
    current.push(...await openProposals(deps, ctx, type.id, plural));
    findingParts(wanted.current, current);
    needsCapture();
    if (held && read !== undefined) {
      for (const p of examined.filter((x) => (read.coverage.empty[x.apiName] ?? 0) > 0)) {
        if (!capture.properties.includes(p.apiName)) { requiresCapture.push(`When ${nameOf(p)} became empty needs it captured: it is not in the Capture Silo.`); continue; }
        const h = await history(p.apiName);
        const toEmpty = h.transitions.filter((t) => !empty(t.previousValue) && empty(t.newValue));
        if (toEmpty.length === 0) {
          historical.push(part({ kind: 'became_empty', property: p.apiName, count: 0, at: h.capturedFrom === null ? null : iso(h.capturedFrom),
            statement: `${nameOf(p)} has not become empty in captured history: where it is empty, it was empty when capture began.` }));
          continue;
        }
        for (const [connectionId, ts] of groupBy(toEmpty, (t) => t.connectionId)) {
          const objects = new Set(ts.map((t) => t.objectRef)).size;
          const first = ts.map((t) => iso(t.observedAt)).sort()[0]!;
          historical.push(part({ kind: 'became_empty', property: p.apiName, connectionId, count: ts.length, of: null, at: first,
            statement: `${nameOf(p)} became empty ${ts.length} times on ${objects} ${plural} from one system, the first at ${first}.` }));
        }
      }
    }
  }

  if (input.question === 'contradictions') {
    if (read !== undefined) {
      const total = read.objects.length;
      for (const p of examined) {
        const n = read.coverage.disputed[p.apiName] ?? 0;
        if (n > 0) current.push(part({ kind: 'disputed_values', property: p.apiName, count: n, of: total, statement: `${nameOf(p)} is disputed between systems on ${n} of ${total} ${plural}.` }));
      }
    }
    findingParts(wanted.current, current);
    needsCapture();
    if (held && read !== undefined) {
      for (const p of examined.filter((x) => (read.coverage.disputed[x.apiName] ?? 0) > 0)) {
        if (!capture.properties.includes(p.apiName)) { requiresCapture.push(`When ${nameOf(p)} began to disagree needs it captured: it is not in the Capture Silo.`); continue; }
        const disputed = read.objects.filter((o) => o.disputed.includes(p.apiName)).map((o) => o.id).slice(0, 1_000);
        const h = await history(p.apiName, disputed);
        const lastBy = new Map<string, { connectionId: string; at: string }>();
        for (const t of h.transitions) {
          const was = lastBy.get(t.objectRef);
          if (was === undefined || iso(t.observedAt) > was.at) lastBy.set(t.objectRef, { connectionId: t.connectionId, at: iso(t.observedAt) });
        }
        if (lastBy.size === 0) {
          historical.push(part({ kind: 'last_changed_by', property: p.apiName, count: 0, of: disputed.length,
            statement: `${nameOf(p)} has not changed on the disputed ${plural} in captured history: they disagreed when capture began.` }));
          continue;
        }
        for (const [connectionId, changes] of groupBy([...lastBy.values()], (c) => c.connectionId)) {
          const earliest = changes.map((c) => c.at).sort()[0]!;
          historical.push(part({ kind: 'last_changed_by', property: p.apiName, connectionId, count: changes.length, of: disputed.length, at: earliest,
            statement: `On ${changes.length} of ${disputed.length} ${plural} where ${nameOf(p)} is disputed, the latest change came from one system, the earliest of them at ${earliest}.` }));
        }
      }
    }
  }

  if (input.question === 'anomalies') {
    findingParts(wanted.current, current);
    needsCapture();
    if (held) findingParts(wanted.history, historical);
  }

  if (input.question === 'clusters') {
    needsCapture();
    if (held) {
      findingParts(wanted.history, historical);
      for (const a of shownAssociations.visible) {
        current.push(part({ kind: 'outcome_association', detector: a.left.detector, property: a.left.property, count: a.coOccurrence, of: a.sampleSize, statement: a.statement }));
      }
      for (const f of findings.filter((x) => x.detector === 'duplicate_value')) {
        const names = f.properties.map((n) => { const p = type.properties.find((x) => x.apiName === n); return p === undefined ? n : nameOf(p); });
        current.push(part({ kind: 'shared_identifier', detector: 'duplicate_value', property: f.properties[0] ?? null, count: f.objectIds.length, of: f.computation.population || null,
          statement: `${f.objectIds.length} ${plural} share a value of ${names.join(', ')}.` }));
      }
    }
  }

  return {
    question: input.question, objectTypeId: type.id, history: capture.history, capturedProperties: capture.properties,
    population: read !== undefined ? read.objects.length : (ranPopulation || null),
    incomplete: population === undefined || population.kind === 'read' ? null : { reason: population.kind, detail: population.detail },
    current, historical: historyAsked ? historical : [], requiresCapture, findings: findings as FindingView[],
    associations: shownAssociations.visible as AssociationView[], withheld: findingsWithheld + shownAssociations.withheld,
  };
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

/** A detector with no current findings: whether it ran, and if not why. */
function detectorState(key: string, run: { state: string; baseline: unknown; populationCount: string | null } | undefined, plural: string, name: string): AnswerPart {
  if (run === undefined) return part({ kind: 'detector_state', detector: key, count: 0, statement: `${name} has not run on ${plural}.` });
  switch (run.state) {
    case 'ran': return part({ kind: 'findings', detector: key, count: 0, of: Number(run.populationCount ?? 0) || null, statement: `${name} names no ${plural} in its latest run.` });
    case 'accumulating_baseline': {
      const b = run.baseline as { have: number; need: number; unit?: string } | null;
      return part({ kind: 'detector_state', detector: key, count: b?.have ?? 0, of: b?.need ?? null,
        statement: `${name} is building a baseline on ${plural}: ${b?.have ?? 0} of ${b?.need ?? 0} ${b?.unit ?? 'observations'}.` });
    }
    case 'history_unavailable': return part({ kind: 'detector_state', detector: key, count: 0, statement: `${name} found no captured history of ${plural} to read in its latest run.` });
    case 'not_configured': return part({ kind: 'detector_state', detector: key, count: 0, statement: `${name} is not configured on ${plural}.` });
    case 'source_unreachable': return part({ kind: 'detector_state', detector: key, count: 0, statement: `${name} could not reach a system in its latest run on ${plural}.` });
    default: return part({ kind: 'detector_state', detector: key, count: 0, statement: `${name} stopped at a bound in its latest run on ${plural}.` });
  }
}

/** Properties only one system populates, where the type has more than one. */
function singleSystem(type: ObjectTypeView, examined: readonly PropertyView[], nameOf: (p: PropertyView) => string): AnswerPart[] {
  const systems = new Set(type.contributingObjects.map((c) => c.connectionId)).size;
  if (systems < 2) return [];
  return examined.flatMap((p) => {
    const own = [...new Set(p.mappings.map((m) => m.connectionId))];
    return own.length !== 1 ? [] : [part({
      kind: 'single_system', property: p.apiName, connectionId: own[0]!, count: 1, of: systems,
      statement: `${nameOf(p)} is held by one system only, of ${systems} that hold this type.`,
    })];
  });
}

/** Unresolved pairs put to a person: open resolution proposals on the type, where the reader may list them. */
async function openProposals(deps: RecognitionDeps, ctx: Context, objectTypeId: string, plural: string): Promise<AnswerPart[]> {
  try {
    const { proposals } = await deps.services.call(listResolutionProposals, { query: { status: 'open', objectTypeId, limit: 200 } },
      { request: ctx.request, correlationId: ctx.correlationId });
    if (proposals.length === 0) return [];
    const affected = proposals.reduce((n, p) => n + p.affectedCount, 0);
    return [part({ kind: 'open_resolution_proposals', count: proposals.length,
      statement: `${proposals.length} resolution proposals are open on ${plural}, affecting ${affected} objects.` })];
  } catch (error) {
    if (isAppError(error) && (error.category === 'forbidden' || error.category === 'unavailable')) return [];
    throw error;
  }
}
