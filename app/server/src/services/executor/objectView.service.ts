// The object view's read (spec 34.2, 34.3; contracts/executor/objectView.contract.ts): one
// object read live now under the reader's access, with each system's own value, its links by
// type and direction, and what did not answer.
//
// It runs on the engine's own machinery (planner programs, the run's reads, the entity graph,
// computed properties, field policies), with two differences from a plan's run:
// - the root is one object: found by its reference (a keyed read of a single system's record)
//   or among the type's population read within bounds, before any link is followed;
// - a system that does not answer leaves the object partial rather than refusing it: the
//   answering systems are shown, and each property one of its systems could not vouch for
//   says so. A bound reached still refuses: a view is never built from part of what it needs.
// It reads live, never from the Object Index: the view is the systems' state now.
// Links are followed from the one object, each on its own: a link over its bound, or through a
// system not answering, says why and the others are still shown. A plan takes at most
// MAX_HOPS links, so more are planned in further rounds, each reading the root again.
// The Actions section checks each Action type's submission criteria against the record it
// writes, as just read, the way the mutation path does: no further read of any system.
// The banner's markings come from policy, field authorities from resolution and extraction
// flags from the Import Silo holding a record, each asked at most once per view: authorities
// only where a value is declared, extractions only for records read from a Silo's store.

import type { z } from 'zod';
import { listActionTypes } from '../../contracts/actions/actionType.contract.ts';
import { readMarkingBanner, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { listFieldAuthorities } from '../../contracts/resolution/authority.contract.ts';
import { readRecordExtractions } from '../../contracts/siloes/import.contract.ts';
import type { ObjectReference, ObjectView, readObjectView as contract } from '../../contracts/executor/objectView.contract.ts';
import { MAX_HOPS, PLAN_SCHEMA_VERSION, queryPlan, type Refusal } from '../../contracts/planner/plan.contract.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { identifierText } from '../../utils/siloObjectId.util.ts';
import { isRefusal, type PropertyAccess } from '../planner/access.service.ts';
import { buildProgram, type HopProgram, type NodeProgram, type Program, type SourceStep } from '../planner/decompose.service.ts';
import { callOptions, type PlanCall } from '../planner/deps.service.ts';
import { activeVersion } from '../planner/manifests.service.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import { recordQueryEvent } from './events.service.ts';
import { computeProperties, Refused, Run, show, type ExecutorDeps } from './execute.service.ts';
import { mergeSingleSource, type MergedObject, type Row } from './merge.service.ts';
import { masked, typed, type Json } from './values.service.ts';

type Outcome = z.output<typeof contract.response>;
type Link = ObjectView['links'][number];
type Failed = { step: SourceStep; reason: string };
type Call = PlanCall & { signal: AbortSignal };
type Extraction = z.output<typeof readRecordExtractions.response>['extractions'][number];
type Authority = z.output<typeof listFieldAuthorities.response>['authorities'][number];

/** Linked objects listed per link: the rest are counted. */
const LINKED_SHOWN = 20;
/** Records whose extraction flags are asked for: at most one per Silo object the object is read from. */
const RECORDS_FLAGGED = 20;

/** Submission criteria are evaluated within the mutation path's bounds. */
const CRITERIA_BOUNDS = { steps: 10_000, timeMs: 10 } as const;

interface Join { linkTypeId: string; routeId: string; direction: 'forward' | 'reverse'; name: string; otherTypeId: string }

const recordReferences = (object: MergedObject) => {
  const seen = new Map<string, { connectionId: string; sourceObject: string; reference: string }>();
  for (const r of object.records) {
    const reference = identifierText(r.row[r.source.identifierFieldPath]);
    if (reference !== undefined) seen.set(`${r.source.connectionId}/${r.source.sourceObject}/${reference}`, { connectionId: r.source.connectionId, sourceObject: r.source.sourceObject, reference });
  }
  return [...seen.values()];
};

const matches = (object: MergedObject, ref: ObjectReference): boolean => ('objectId' in ref ? object.id === ref.objectId
  : object.records.some((r) => r.source.connectionId === ref.connectionId && identifierText(r.row[r.source.identifierFieldPath]) === ref.reference));

/** The root object: its system's record by identifier where it is one system's, else among the population. Undefined: not there. */
async function findRoot(run: Run, node: NodeProgram, ref: ObjectReference): Promise<{ object: MergedObject; failed: Failed[] } | undefined> {
  const organisationId = run.call.request.organisationId!;
  if ('connectionId' in ref && node.mode === 'single_source') {
    const step = node.sources[0]!;
    if (step.source.connectionId !== ref.connectionId) return undefined;
    // The identifier as written, and as a number where it reads as one: the system may hold either.
    const attempts: Json[] = [ref.reference, ...(/^-?\d{1,15}$/.test(ref.reference) ? [Number(ref.reference)] : [])];
    for (const value of attempts) {
      const rows = await run.readStep(step, { field: step.source.identifierFieldPath, op: 'in', value: [value] } as never);
      const objects = mergeSingleSource(organisationId, node, [{ source: step.source, rows }]);
      computeProperties(node, objects, run.now);
      const object = objects.find((o) => matches(o, ref));
      if (object !== undefined) return { object, failed: [] };
    }
    return undefined;
  }
  if ('connectionId' in ref && !node.sources.some((s) => s.source.connectionId === ref.connectionId)) return undefined;
  const reads: { source: SourceStep['source']; rows: Row[] }[] = [];
  const failed: Failed[] = [];
  for (const step of node.sources) {
    try {
      reads.push({ source: step.source, rows: await run.readStep(step, undefined) });
    } catch (error) {
      // A system not answering leaves the view partial; a bound reached refuses it.
      if (error instanceof Refused && error.refusal.code === 'query.source_unavailable') failed.push({ step, reason: error.refusal.reason });
      else throw error;
    }
  }
  // The record asked for is in a system not answering, or nothing answered: there is nothing to show.
  const named = 'connectionId' in ref ? failed.find((f) => f.step.source.connectionId === ref.connectionId) : undefined;
  if (reads.length === 0 || named !== undefined) {
    const down = named ?? failed[0]!;
    throw new Refused({
      code: 'query.source_unavailable', reason: 'the system holding this object is not answering, so it cannot be shown',
      element: { kind: 'connection', id: down.step.source.connectionId }, remedy: 'try again when the connection is healthy',
    });
  }
  const objects = node.access.type.resolutionClass === 'resolvable' ? await run.resolve(node, reads) : mergeSingleSource(organisationId, node, reads);
  computeProperties(node, objects, run.now);
  const object = objects.find((o) => matches(o, ref));
  return object === undefined ? undefined : { object, failed };
}

/** The title of an object at a node, as the reader may see it. */
function titleOf(program: Program, node: number, object: MergedObject): Json | null {
  const access = program.nodes[node]!.access;
  const title = access.properties.get(access.type.titlePropertyIdentityId);
  return title === undefined ? null : show(object, title).value;
}

/** One link from the root, followed on its own: its count and first objects, or why not. */
async function follow(run: Run, hop: HopProgram, root: MergedObject): Promise<Pick<Link, 'count' | 'objects' | 'refusal'>> {
  try {
    const keys = run.boundKeys(run.keysOf(root, hop.fromSource, hop.fromField), hop.index);
    const target = run.program.nodes[hop.to]!;
    if (hop.junction !== undefined) {
      const pairs = keys.length === 0 ? [] : await run.readJunction(hop, keys);
      const toKeys = run.boundKeys(pairs.map(([, t]) => t), hop.index);
      const to = toKeys.length === 0 ? [] : await run.readNode(target, { source: hop.toSource, field: hop.toField, keys: toKeys });
      run.pairThrough(hop.index, [root], to, pairs);
    } else {
      const to = keys.length === 0 ? [] : await run.readNode(target, { source: hop.toSource, field: hop.toField, keys });
      run.pair(hop.index, [root], to);
    }
    const linked = [...(run.links.get(root.id)?.get(hop.index) ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1));
    return {
      count: linked.length,
      objects: linked.slice(0, LINKED_SHOWN).map((o) => ({ id: o.id, objectTypeId: o.typeId, title: titleOf(run.program, hop.to, o), references: recordReferences(o) })),
      refusal: null,
    };
  } catch (error) {
    if (error instanceof Refused) return { count: null, objects: [], refusal: error.refusal };
    throw error;
  }
}

function propertiesOf(run: Run, node: NodeProgram, object: MergedObject, shown: PropertyAccess[], failed: Failed[],
  extractions: Extraction[], authorities: Authority[]): ObjectView['properties'] {
  const readAt = (source: SourceStep['source']) => {
    const step = node.sources.find((s) => s.source === source);
    return (step === undefined ? undefined : run.readAt.get(step)) ?? new Date().toISOString();
  };
  return shown.map((p) => {
    const decided = object.values.get(p.property.identityId) ?? { value: null, state: 'empty' as const };
    const readings = p.computed !== undefined ? [] : object.records.flatMap((r) => {
      const mapping = p.property.mappings.find((m) => m.connectionId === r.source.connectionId && m.sourceObject === r.source.sourceObject);
      if (mapping === undefined) return [];
      const raw = typed(r.row[mapping.fieldPath], p.property.dataType, mapping);
      const reference = identifierText(r.row[r.source.identifierFieldPath]);
      const flag = extractions.find((e) => e.connectionId === r.source.connectionId && e.sourceObject === r.source.sourceObject
        && e.rowRef === reference && e.field === mapping.fieldPath);
      return [{
        connectionId: r.source.connectionId, sourceObject: r.source.sourceObject, fieldPath: mapping.fieldPath,
        connectorVersion: r.source.connectorVersion, readAt: readAt(r.source),
        value: p.effect === 'redact' ? null : p.effect === 'mask' ? masked(raw) : raw,
        extraction: flag === undefined ? null : {
          siloId: flag.siloId, extractionId: flag.extractionId, method: flag.method, document: flag.document, location: flag.location,
          modelScore: flag.modelScore, confirmed: flag.confirmed,
        },
      }];
    });
    const partial = p.property.mappings.some((m) => failed.some((f) => f.step.source.connectionId === m.connectionId && f.step.source.sourceObject === m.sourceObject));
    // The system the decided value came from: named by resolution, or the one system holding a value.
    const holding = readings.filter((r) => r.value !== null);
    const from = decided.state === 'declared' || decided.state === 'only'
      ? decided.from ?? (holding.length === 1 ? holding[0]!.connectionId : null) : null;
    const authority = decided.state === 'declared' && decided.authorityId !== undefined ? authorities.find((a) => a.id === decided.authorityId) : undefined;
    return {
      identityId: p.property.identityId, apiName: p.property.apiName, displayName: p.property.displayName, dataType: p.property.dataType,
      effect: p.effect, state: decided.state, value: show(object, p).value, from,
      authority: authority === undefined ? null : {
        id: authority.id, winningConnectionId: authority.winningConnectionId, condition: authority.condition, reason: authority.reason,
        declaredBy: authority.declaredBy, declaredAt: authority.declaredAt,
      },
      readings, partial, computed: p.computed !== undefined,
    };
  });
}

/**
 * The Actions section (34.5): each confirmed Action type targeting the type that the reader
 * may see (its markings held), with its submission criteria checked against the record it
 * writes, as the mutation path checks them: CEL over the record's properties by API name (only
 * those the reader reads plainly) and the parameters, here none.
 */
async function actionsOf(deps: ExecutorDeps, call: Call, typeId: string, object: MergedObject, shown: PropertyAccess[]): Promise<ObjectView['actions']> {
  const options = callOptions(call);
  const { actionTypes } = await deps.services.call(listActionTypes, { query: { status: 'confirmed', objectTypeId: typeId, limit: 500 } }, options);
  // An Action that creates objects acts on the type, not on this object.
  const candidates = actionTypes.filter((t) => !t.isSystem && t.current !== null && t.current.objectTypeId === typeId
    && !t.current.rules.some((r) => r.kind === 'create_object'));
  if (candidates.length === 0) return [];
  const access = await deps.services.call(resolveAccess, { body: { actionTypes: candidates.map((t) => t.id) } }, options);
  const visible = new Set(access.decision === 'allow' ? access.actionTypes.filter((a) => a.visible).map((a) => a.id) : []);
  return candidates.filter((t) => visible.has(t.id)).sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)).map((t) => {
    const v = t.current!;
    const base = {
      actionTypeId: t.id, apiName: t.apiName, displayName: t.displayName, version: v.version, riskClass: v.riskClass,
      physical: v.riskClass === 'physical' || v.sideEffects.some((e) => e.physical), revertBehaviour: v.revertBehaviour, parameters: v.parameters,
    };
    // The record it writes: the object's record in the first system the type may write through.
    const record = v.permittedConnections
      .map((c) => object.records.find((r) => r.source.connectionId === c && r.source.sourceObject === v.permittedOperations[c]?.sourceObject))
      .find((r) => r !== undefined);
    const reference = record === undefined ? undefined : identifierText(record.row[record.source.identifierFieldPath]);
    if (record === undefined || reference === undefined) return { ...base, target: null, state: 'no_record' as const, criterion: null };
    const target = { connectionId: record.source.connectionId, reference };
    if (v.submissionCriteria === null) return { ...base, target, state: 'available' as const, criterion: null };
    const current: Record<string, Json> = {};
    for (const p of shown) {
      if (p.effect !== 'allow' || p.computed !== undefined) continue;
      const m = p.property.mappings.find((x) => x.connectionId === record.source.connectionId && x.sourceObject === record.source.sourceObject);
      if (m !== undefined && record.row[m.fieldPath] !== undefined) current[p.property.apiName] = record.row[m.fieldPath]!;
    }
    let met: unknown;
    try {
      met = compileCel(v.submissionCriteria, { object: 'map', params: 'map' }).evaluate({ object: current, params: {} }, CRITERIA_BOUNDS);
    } catch {
      // Criteria reading the parameters wait for them; otherwise a criterion that cannot be evaluated refuses, as at resolve.
      return { ...base, target, state: /\bparams\b/.test(v.submissionCriteria) ? 'checked_on_submit' as const : 'criteria_failed' as const, criterion: v.submissionCriteria };
    }
    return met === true ? { ...base, target, state: 'available' as const, criterion: null }
      : { ...base, target, state: 'criteria_failed' as const, criterion: v.submissionCriteria };
  });
}

/** One program's read of the root: the run, the object and the systems that did not answer; or why there is none. */
async function rootOf(deps: ExecutorDeps, call: Call, program: Program, ref: ObjectReference)
  : Promise<{ outcome: 'found'; run: Run; object: MergedObject; failed: Failed[] } | { outcome: 'not_found' } | { outcome: 'refused'; refusal: Refusal }> {
  const run = new Run(deps, call, program, call.signal);
  try {
    const found = await findRoot(run, program.nodes[0]!, ref);
    return found === undefined ? { outcome: 'not_found' } : { outcome: 'found', run, ...found };
  } catch (error) {
    if (error instanceof Refused) return { outcome: 'refused', refusal: error.refusal };
    throw error;
  }
}

const linkHead = (j: Join) => ({ linkTypeId: j.linkTypeId, direction: j.direction, name: j.name, otherTypeId: j.otherTypeId });
const byName = (a: { name: string; linkTypeId: string }, b: { name: string; linkTypeId: string }) => a.name.localeCompare(b.name) || a.linkTypeId.localeCompare(b.linkTypeId);

export async function readObjectView(deps: ExecutorDeps, given: Call, input: { objectTypeId: string; object: ObjectReference }): Promise<Outcome> {
  // The whole view within the executor's wall-time bound, as a plan run is (27.4).
  const call: Call = { ...given, signal: AbortSignal.any([given.signal, AbortSignal.timeout(deps.bounds.wallTimeMs)]) };
  try {
    return await viewOf(deps, call, input);
  } catch (error) {
    if (call.signal.aborted && !given.signal.aborted) {
      return {
        outcome: 'refusal',
        refusal: { code: 'query.bound_wall_time', reason: 'the object took longer than the time bound to read; refused rather than shown in part', bound: { name: 'wall_time', limit: deps.bounds.wallTimeMs } },
      };
    }
    throw error;
  }
}

async function viewOf(deps: ExecutorDeps, call: Call, input: { objectTypeId: string; object: ObjectReference }): Promise<Outcome> {
  const version = await activeVersion(deps, call);
  const plan = (body: object) => queryPlan.parse({ schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: version.id, ...body });

  // What the reader may see of the type and of the links joining it. A type they may not see
  // is not found, so its existence is not disclosed.
  const probe = await buildProgram(deps, call, plan({ nodes: [{ objectTypeId: input.objectTypeId }] }), {}, { index: false });
  if (isRefusal(probe)) return probe.code === 'plan.object_type_unavailable' ? { outcome: 'not_found' } : { outcome: 'refusal', refusal: probe };
  const access = probe.access;
  const typeAccess = probe.nodes[0]!.access;
  const type = typeAccess.type;
  // The generated layout's order (34.6): the primary first, then as the type declares them.
  const primary = type.primaryKeyPropertyIdentityId ?? type.titlePropertyIdentityId;
  const shown = [...type.properties.filter((p) => p.identityId === primary), ...type.properties.filter((p) => p.identityId !== primary)]
    .map((p) => typeAccess.properties.get(p.identityId)).filter((p): p is PropertyAccess => p !== undefined);
  const joins: Join[] = [];
  for (const { link, routes } of access.links.values()) {
    const route = routes.find((r) => r.id === link.defaultRouteId) ?? routes[0];
    if (route === undefined) continue;
    if (link.fromTypeId === type.id) {
      // A link from the type to itself reads the same both ways: listed once, forward.
      joins.push({ linkTypeId: link.id, routeId: route.id, direction: 'forward', name: link.forwardName, otherTypeId: link.toTypeId });
    } else if (link.toTypeId === type.id) {
      joins.push({ linkTypeId: link.id, routeId: route.id, direction: 'reverse', name: link.reverseName, otherTypeId: link.fromTypeId });
    }
  }
  joins.sort(byName);
  const titleProperty = (typeId: string) => {
    const t = access.types.get(typeId);
    return t !== undefined && t.properties.has(t.type.titlePropertyIdentityId) ? t.type.titlePropertyIdentityId : undefined;
  };
  const programFor = (batch: Join[], withRoot: boolean) => buildProgram(deps, call, plan({
    nodes: [{ objectTypeId: type.id }, ...batch.map((j) => ({ objectTypeId: j.otherTypeId }))],
    hops: batch.map((j, i) => ({ from: 0, to: i + 1, linkTypeId: j.linkTypeId, routeId: j.routeId })),
    select: [
      ...(withRoot ? shown.map((p) => ({ node: 0, property: p.property.identityId })) : []),
      ...batch.flatMap((j, i) => { const t = titleProperty(j.otherTypeId); return t === undefined ? [] : [{ node: i + 1, property: t }]; }),
    ],
  }), {}, { index: false });

  // The root, read with its first links where they plan together; else alone, each link after it on its own.
  const rounds: Join[][] = [];
  for (let i = MAX_HOPS; i < joins.length; i += MAX_HOPS) rounds.push(joins.slice(i, i + MAX_HOPS));
  let pending = joins.slice(0, MAX_HOPS);
  let program = await programFor(pending, true);
  if (isRefusal(program)) {
    rounds.unshift(...pending.map((j) => [j]));
    pending = [];
    program = await programFor([], true);
    if (isRefusal(program)) return { outcome: 'refusal', refusal: program };
  }
  const read = await rootOf(deps, call, program, input.object);
  if (read.outcome === 'not_found') return { outcome: 'not_found' };
  if (read.outcome === 'refused') return { outcome: 'refusal', refusal: read.refusal };
  // Properties computed over links (21.11): the root's hidden hops, then their values.
  try {
    await read.run.readHidden(program.nodes[0]!, [read.object]);
  } catch (error) {
    if (error instanceof Refused) return { outcome: 'refusal', refusal: error.refusal };
    throw error;
  }
  const links: Link[] = [];
  for (const [i, j] of pending.entries()) links.push({ ...linkHead(j), ...await follow(read.run, program.hops[i]!, read.object) });
  for (const batch of rounds) {
    const more = await programFor(batch, false);
    if (isRefusal(more)) {
      for (const j of batch) links.push({ ...linkHead(j), count: null, objects: [], refusal: more });
      continue;
    }
    // By the Silo id now found: the same object, whichever reference opened it.
    const root = await rootOf(deps, call, more, 'objectId' in input.object || more.nodes[0]!.mode === 'merged' ? { objectId: read.object.id } : input.object);
    for (const [i, j] of batch.entries()) {
      links.push(root.outcome === 'found' ? { ...linkHead(j), ...await follow(root.run, more.hops[i]!, root.object) }
        : { ...linkHead(j), count: null, objects: [], refusal: root.outcome === 'refused' ? root.refusal : null });
    }
  }
  links.sort(byName);

  const { run, object, failed } = read;
  const references = recordReferences(object);
  const siloHeld = new Set([...program.nodes[0]!.sources].filter((s) => run.siloOf.has(s)).map((s) => `${s.source.connectionId}/${s.source.sourceObject}`));
  const flaggable = references.filter((r) => siloHeld.has(`${r.connectionId}/${r.sourceObject}`));
  const options = callOptions(call);
  const [banner, authorities, extractions, actions] = await Promise.all([
    deps.services.call(readMarkingBanner, { body: { objectTypeId: type.id, propertyIds: shown.map((p) => p.property.identityId) } }, options),
    type.resolutionClass === 'resolvable' && [...object.values.values()].some((d) => d.state === 'declared')
      ? deps.services.call(listFieldAuthorities, { query: { objectTypeId: type.id, includeRevoked: 'true' } }, options).then((r) => r.authorities)
      : Promise.resolve([] as Authority[]),
    flaggable.length === 0 ? Promise.resolve([] as Extraction[])
      : deps.services.call(readRecordExtractions, {
        body: { records: flaggable.slice(0, RECORDS_FLAGGED).map((r) => ({ connectionId: r.connectionId, sourceObject: r.sourceObject, rowRef: r.reference })) },
      }, options).then((r) => r.extractions),
    // The Actions section degrades alone (34.2): actions or policy not answering leaves it null.
    actionsOf(deps, call, type.id, object, shown).catch((error: unknown) => {
      if (isAppError(error) && ['unavailable', 'timeout', 'upstream', 'capacity', 'rate_limited'].includes(error.category)) return null;
      throw error;
    }),
  ]);
  const view: ObjectView = {
    id: object.id, objectTypeId: type.id, typeVersionId: type.typeVersionId, ontologyVersionId: version.id, readAt: new Date().toISOString(),
    title: titleOf(program, 0, object), markings: banner.markings,
    binding: type.resolutionClass === 'resolvable'
      ? {
        kind: 'match_key',
        keys: type.matchKeys.map((k) => {
          const p = type.properties.find((x) => x.identityId === k.propertyIdentityId)!;
          return { identityId: p.identityId, apiName: p.apiName, normalisation: k.normalisation };
        }),
      }
      : { kind: 'identifier' },
    references, unmatched: object.unmatched,
    properties: propertiesOf(run, program.nodes[0]!, object, shown, failed, extractions, authorities),
    withheld: typeAccess.withheld.map((p) => ({ identityId: p.identityId, apiName: p.apiName, displayName: p.displayName })),
    links,
    incomplete: failed.map((f) => ({ connectionId: f.step.source.connectionId, sourceObject: f.step.source.sourceObject, reason: f.reason })),
    actions,
  };
  await recordQueryEvent(deps.databases, call.request, call.correlationId, 'object_view_opened', {
    object_type_id: type.id, object_id: object.id, withheld: view.withheld.length,
  });
  return { outcome: 'object', view };
}
