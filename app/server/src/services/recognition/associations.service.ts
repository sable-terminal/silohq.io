// Association analysis and outcomes of interest (spec 38.6).
//
// Populations are named: the objects a detector's current findings name on a type, and the
// objects a designated outcome holds for (a yes/no property true, or a finding kind on it).
// For each pair on one type, the objects in both, over the type's population (the sample
// size, always stated). For each link type joining two types with populations, the objects
// of one linked to at least one object of the other, in the link type's direction.
//
// Temporal order needs evidence, not detection timestamps: every run re-raises its findings,
// so when a finding was raised says only when the detector last ran. Each population of a
// detector instead knows, per object, when its current episode began (the first run naming
// it since a run that examined it and did not) and when it was last examined and absent. A
// precedes B on an object only when a run of B examined it and did not name it while A was
// already naming it; otherwise the order is not known and is counted as unordered.
//
// The language is fixed and never causal; a name that would put a causal word into a
// statement is replaced by its API name, or by a neutral phrase. Each computation records
// the set it replaced. Associations are counts over identifiers, computed once for the
// organisation; the reader's access decides at read which they may see: the types, the
// link type, every property the populations rest on, and every marking on their findings.

import { readResultPage, runPlan, type ResultObject } from '../../contracts/executor/result.contract.ts';
import type { LinkTypeView, ObjectTypeView, OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import type { AssociationView, OutcomeView } from '../../contracts/recognition/association.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Association } from '../../models/recognition/association.model.ts';
import type { OutcomeDesignation } from '../../models/recognition/outcomeDesignation.model.ts';
import {
  associationComputationRepo, associationRepo, detectorRepo, detectorRunRepo, findingMarkingRepo, findingObjectRepo, findingRepo, outcomeDesignationRepo,
} from '../../repos/recognition/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { access, actor, demand, member, readManifest, recordEvent, typeOf, type Context, type RecognitionDeps } from './deps.service.ts';
import { readPopulation } from './population.service.ts';

/** Finding-object rows one computation reads; more is refused, never truncated. */
export const MAX_MEMBERSHIP = 200_000;

// ----------------------------------------------------------------------------- the arithmetic

export interface Membership {
  /** Ms since the epoch the current episode began; null where no moment applies (a property). */
  start: number | null;
  /** Ms since the epoch of the latest run that examined the object and did not name it. */
  lastAbsent: number | null;
}

export interface Population {
  objectTypeId: string;
  property: string | null;
  detectorId: string | null;
  name: string;
  outcome: boolean;
  members: ReadonlyMap<string, Membership>;
}

export interface Computed {
  left: Population;
  right: Population;
  linkTypeId: string | null;
  linkDirection: 'forward' | 'reverse' | null;
  coOccurrence: number;
  sampleSize: number;
  temporalOrder: { precedes: number; follows: number; unordered: number; of: number } | null;
  statement: string;
}

const CAUSAL = /\b(cause|causes|caused|drive|drives|driven)\b/i;
const FORBIDDEN = /\b(cause|causes|caused|drive|drives|driven|fraud|fraudulent)\b/i;

/** A name safe in fixed language: the first candidate with no causal word, else the neutral phrase. */
export function neutral(neutralPhrase: string, ...candidates: (string | null | undefined)[]): string {
  return candidates.find((c): c is string => typeof c === 'string' && c.trim() !== '' && !FORBIDDEN.test(c)) ?? neutralPhrase;
}

/** The last guard: a statement in fixed language never carries a causal word or an assertion of fraud. */
export function fixedLanguage(statement: string): string {
  if (FORBIDDEN.test(statement)) {
    throw new AppError('internal', 'a statement left the fixed language', { code: 'recognition.language_not_fixed' });
  }
  return statement;
}

/** A precedes B on an object: B examined it and did not name it while A already named it. */
function order(a: Membership, b: Membership): 'precedes' | 'follows' | 'unordered' {
  if (a.start === null || b.start === null) return 'unordered';
  if (b.lastAbsent !== null && a.start <= b.lastAbsent) return 'precedes';
  if (a.lastAbsent !== null && b.start <= a.lastAbsent) return 'follows';
  return 'unordered';
}

function temporal(left: Population, right: Population, shared: readonly string[]): Computed['temporalOrder'] {
  if (left.detectorId === null || right.detectorId === null || shared.length === 0) return null;
  const counts = { precedes: 0, follows: 0, unordered: 0, of: shared.length };
  for (const key of shared) counts[order(left.members.get(key)!, right.members.get(key)!)] += 1;
  return counts;
}

function temporalSentence(left: Population, right: Population, t: Computed['temporalOrder']): string {
  if (t === null) return '';
  const parts: string[] = [];
  if (t.precedes > 0) parts.push(` ${left.name} precedes ${right.name} in ${t.precedes} of ${t.of} instances.`);
  if (t.follows > 0) parts.push(` ${right.name} precedes ${left.name} in ${t.follows} of ${t.of} instances.`);
  return parts.join('');
}

/** An outcome is always the right side; otherwise by name. */
function sides(a: Population, b: Population): [Population, Population] {
  if (a.outcome !== b.outcome) return a.outcome ? [b, a] : [a, b];
  return a.name.localeCompare(b.name) <= 0 ? [a, b] : [b, a];
}

/**
 * Pairs within one type. Every pair touching an outcome is stated, even at zero (what does
 * not co-occur with an outcome is worth knowing); other pairs only where they co-occur.
 */
export function associateWithin(populations: readonly Population[], sampleSize: number, plural: string): Computed[] {
  const out: Computed[] = [];
  const live = populations.filter((p) => p.members.size > 0);
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const [left, right] = sides(live[i]!, live[j]!);
      const shared = [...left.members.keys()].filter((k) => right.members.has(k));
      if (shared.length === 0 && !left.outcome && !right.outcome) continue;
      const temporalOrder = temporal(left, right, shared);
      out.push({
        left, right, linkTypeId: null, linkDirection: null, coOccurrence: shared.length, sampleSize, temporalOrder,
        statement: fixedLanguage(`${left.name} occurs together with ${right.name} in ${shared.length} of ${sampleSize} ${plural}.${temporalSentence(left, right, temporalOrder)}`),
      });
    }
  }
  return out;
}

/**
 * Across a link type, from the left type's side: the left population's objects linked to at
 * least one object of the right population. Stated only where some are.
 */
export function associateAcross(lefts: readonly Population[], rights: readonly Population[], linked: ReadonlyMap<string, ReadonlySet<string>>,
  link: { id: string; direction: 'forward' | 'reverse'; name: string }, sampleSize: number, leftPlural: string, rightPlural: string): Computed[] {
  const out: Computed[] = [];
  for (const left of lefts.filter((p) => p.members.size > 0)) {
    for (const right of rights.filter((p) => p.members.size > 0)) {
      let count = 0;
      for (const key of left.members.keys()) {
        const reached = linked.get(key);
        if (reached !== undefined && [...reached].some((k) => right.members.has(k))) count += 1;
      }
      if (count === 0) continue;
      out.push({
        left, right, linkTypeId: link.id, linkDirection: link.direction, coOccurrence: count, sampleSize, temporalOrder: null,
        statement: fixedLanguage(`${left.name} on ${leftPlural} is linked through ${link.name} to ${right.name} on ${rightPlural} in ${count} of ${sampleSize} ${leftPlural}.`),
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- outcomes

function outcomeView(row: OutcomeDesignation, detectorKeys: ReadonlyMap<string, string>): OutcomeView {
  return {
    id: row.id, objectTypeId: row.objectTypeId, property: row.property,
    detector: row.detectorId === null ? null : detectorKeys.get(row.detectorId) ?? 'retired',
    designatedBy: row.designatedBy, designatedAt: row.designatedAt,
  };
}

/** outcome.designate (38.6): a yes/no property the designator may examine, or a finding kind. */
export async function designateOutcome(deps: RecognitionDeps, ctx: Context, input: { objectTypeId: string; property?: string | undefined; detector?: string | undefined })
  : Promise<OutcomeView> {
  const who = member(ctx);
  await demand(deps, ctx, 'outcome.designate', { type: 'object_type', id: input.objectTypeId });
  const manifest = await readManifest(deps, ctx);
  const type = typeOf(manifest, input.objectTypeId);
  const property = input.property === undefined ? undefined : type.properties.find((p) => p.apiName === input.property && p.status !== 'retired');
  const decision = await access(deps, ctx, { objectTypes: [type.id], properties: property === undefined ? [] : [property.identityId] });
  if (!decision.allowed || !decision.typeVisible(type.id)) throw new AppError('not_found', 'no such object type', { code: 'recognition.object_type_not_found' });
  if (input.property !== undefined) {
    if (property === undefined || !decision.propertyClear(property.identityId)) {
      throw new AppError('validation', 'no such property on the type', { code: 'recognition.outcome_property_unknown' });
    }
    if (property.dataType !== 'boolean') {
      throw new AppError('validation', 'an outcome property is yes or no', { code: 'recognition.outcome_not_boolean', details: { dataType: property.dataType } });
    }
  }
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const detector = input.detector === undefined ? undefined : await detectorRepo.findByKey(db, input.detector);
    if (input.detector !== undefined && (detector === undefined || detector.status !== 'active')) {
      throw new AppError('validation', 'no such detector', { code: 'recognition.detector_unknown', details: { detector: input.detector } });
    }
    const outcome = { property: property?.apiName ?? null, detectorId: detector?.id ?? null };
    if (await outcomeDesignationRepo.findLive(db, type.id, outcome) !== undefined) {
      throw new AppError('conflict', 'this outcome is already designated', { code: 'recognition.outcome_exists' });
    }
    const row = await outcomeDesignationRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, objectTypeId: type.id, ...outcome, designatedBy: who.membershipId,
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'outcome_designated', resource: { type: 'outcome_designation', id: row.id },
      detail: { object_type_id: type.id, property: outcome.property, detector: detector?.key ?? null, change: 'designated' },
    });
    return outcomeView(row, new Map(detector === undefined ? [] : [[detector.id, detector.key]]));
  });
}

export async function revokeOutcome(deps: RecognitionDeps, ctx: Context, outcomeId: string): Promise<OutcomeView & { revokedAt: string }> {
  const who = member(ctx);
  const found = await inTransaction(deps.databases.pool('control'), who.request, (db) => outcomeDesignationRepo.findById(db, outcomeId), { readOnly: true });
  if (found === undefined) throw new AppError('not_found', 'no such outcome', { code: 'recognition.outcome_not_found' });
  await demand(deps, ctx, 'outcome.designate', { type: 'object_type', id: found.objectTypeId });
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const row = await outcomeDesignationRepo.revoke(db, outcomeId, who.membershipId, new Date().toISOString());
    if (row === undefined) throw new AppError('conflict', 'the outcome is already revoked', { code: 'recognition.outcome_revoked' });
    const registry = await detectorRepo.listActive(db);
    await recordEvent(db, who, ctx.correlationId, {
      event: 'outcome_designated', resource: { type: 'outcome_designation', id: row.id },
      detail: { object_type_id: row.objectTypeId, property: row.property, detector: registry.find((d) => d.id === row.detectorId)?.key ?? null, change: 'revoked' },
    });
    return { ...outcomeView(row, new Map(registry.map((d) => [d.id, d.key]))), revokedAt: row.revokedAt! };
  });
}

/** Live outcomes on types and properties the reader can see; the rest counted. */
export async function listOutcomes(deps: RecognitionDeps, ctx: Context, objectTypeId: string | undefined): Promise<{ outcomes: OutcomeView[]; withheld: number }> {
  const who = actor(ctx);
  const manifest = await readManifest(deps, ctx);
  const { rows, keys } = await inTransaction(deps.databases.pool('control'), who.request, async (db) => ({
    rows: await outcomeDesignationRepo.listLive(db, objectTypeId), keys: new Map((await detectorRepo.listActive(db)).map((d) => [d.id, d.key])),
  }), { readOnly: true });
  if (rows.length === 0) return { outcomes: [], withheld: 0 };
  const identityOf = (row: OutcomeDesignation) => manifest.objectTypes.find((t) => t.id === row.objectTypeId)?.properties.find((p) => p.apiName === row.property)?.identityId;
  const decision = await access(deps, ctx, {
    objectTypes: rows.map((r) => r.objectTypeId), properties: rows.flatMap((r) => { const id = identityOf(r); return id === undefined ? [] : [id]; }),
  });
  const visible = rows.filter((r) => decision.allowed && decision.typeVisible(r.objectTypeId)
    && (r.property === null || (identityOf(r) !== undefined && decision.propertyClear(identityOf(r)!))));
  return { outcomes: visible.map((r) => outcomeView(r, keys)), withheld: rows.length - visible.length };
}

// ----------------------------------------------------------------------------- computing

interface Skip { kind: 'outcome' | 'link_type'; id: string; reason: 'bounded' | 'source_unreachable' | 'not_visible' | 'retired' | 'ambiguous_route' }

/** Linked object ids from each object of the link type's from type, read through the executor under the computing actor's access. */
async function readLinks(deps: RecognitionDeps, ctx: Context, manifest: OntologyManifest, link: LinkTypeView, routeId: string)
  : Promise<{ kind: 'read'; forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> } | { kind: Skip['reason'] }> {
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  const out = await deps.services.call(runPlan, {
    body: {
      plan: {
        schemaVersion: '1', ontologyVersionId: manifest.version.id, nodes: [{ objectTypeId: link.fromTypeId, filters: [] }, { objectTypeId: link.toTypeId, filters: [] }],
        hops: [{ from: 0, to: 1, linkTypeId: link.id, routeId }], select: [], sort: [],
      },
      parameters: {}, trigger: 'structured', useCache: false,
    },
  }, call);
  if (out.outcome === 'refusal') return { kind: out.refusal.code === 'query.source_unavailable' ? 'source_unreachable' : 'bounded' };
  const objects: ResultObject[] = [...out.result.page.objects];
  for (let index = 1; index < out.result.page.count; index += 1) {
    objects.push(...(await deps.services.call(readResultPage, { params: { queryId: out.result.queryId, page: index } }, call)).objects);
  }
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const o of objects) {
    for (const reached of o.links['0'] ?? []) {
      forward.set(o.id, (forward.get(o.id) ?? new Set()).add(reached.id));
      reverse.set(reached.id, (reverse.get(reached.id) ?? new Set()).add(o.id));
    }
  }
  return { kind: 'read', forward, reverse };
}

/** The objects a yes/no outcome holds for, read under the computing actor's access. */
async function readOutcome(deps: RecognitionDeps, ctx: Context, manifest: OntologyManifest, type: ObjectTypeView, propertyApiName: string)
  : Promise<{ kind: 'read'; members: Map<string, Membership>; population: number } | { kind: Skip['reason'] }> {
  const property = type.properties.find((p) => p.apiName === propertyApiName && p.status !== 'retired');
  if (property === undefined) return { kind: 'retired' };
  const decision = await access(deps, ctx, { objectTypes: [type.id], properties: [property.identityId] });
  if (!decision.allowed || !decision.typeVisible(type.id) || !decision.propertyClear(property.identityId)) return { kind: 'not_visible' };
  const read = await readPopulation(deps, ctx, manifest, type.id, [property.identityId]);
  if (read.kind !== 'read') return { kind: read.kind };
  const members = new Map<string, Membership>();
  for (const o of read.objects) if (o.values[property.apiName] === true) members.set(o.id, { start: null, lastAbsent: null });
  return { kind: 'read', members, population: read.objects.length };
}

/** recognition.run: the organisation's associations afresh; the new set supersedes the last. */
export async function computeAssociations(deps: RecognitionDeps, ctx: Context) {
  const who = actor(ctx);
  await demand(deps, ctx, 'recognition.run');
  const manifest = await readManifest(deps, ctx);
  const control = deps.databases.pool('control');
  const stored = await inTransaction(control, who.request, async (db) => ({
    episodes: await findingObjectRepo.currentEpisodes(db, MAX_MEMBERSHIP + 1),
    populations: await detectorRunRepo.latestRanPopulations(db),
    outcomes: await outcomeDesignationRepo.listLive(db),
    registry: await detectorRepo.listActive(db),
    previous: await associationComputationRepo.latest(db),
  }), { readOnly: true });
  if (stored.episodes.length > MAX_MEMBERSHIP) {
    throw new AppError('capacity', 'too many current findings to analyse at once', {
      code: 'recognition.associations_bounded', details: { bound: 'finding_objects', limit: MAX_MEMBERSHIP },
    });
  }
  const skipped: Skip[] = [];
  const types = new Map(manifest.objectTypes.filter((t) => t.status === 'active').map((t) => [t.id, t]));
  const detectorName = (id: string) => {
    const d = stored.registry.find((x) => x.id === id);
    return neutral('a detector', d?.name, d?.key);
  };
  const byType = new Map<string, Population[]>();
  const add = (p: Population) => byType.set(p.objectTypeId, [...(byType.get(p.objectTypeId) ?? []), p]);

  // Detector populations, from current findings.
  const grouped = new Map<string, Map<string, Membership>>();
  for (const e of stored.episodes) {
    if (!types.has(e.objectTypeId)) continue;
    const key = `${e.objectTypeId}/${e.detectorId}`;
    grouped.set(key, (grouped.get(key) ?? new Map()).set(e.objectKey, { start: e.episodeStartMs, lastAbsent: e.lastAbsentMs }));
  }
  const outcomeDetectors = new Set(stored.outcomes.filter((o) => o.detectorId !== null).map((o) => `${o.objectTypeId}/${o.detectorId}`));
  for (const [key, members] of grouped) {
    const [objectTypeId, detectorId] = key.split('/') as [string, string];
    add({ objectTypeId, property: null, detectorId, name: detectorName(detectorId), outcome: outcomeDetectors.has(key), members });
  }
  // A designated finding kind with no current findings is still a population: empty, so stated nowhere.
  // Yes/no outcomes, read now.
  const outcomeReads = new Map<string, number>();
  for (const o of stored.outcomes.filter((x) => x.property !== null)) {
    const type = types.get(o.objectTypeId);
    if (type === undefined) { skipped.push({ kind: 'outcome', id: o.id, reason: 'retired' }); continue; }
    const read = await readOutcome(deps, ctx, manifest, type, o.property!);
    if (read.kind !== 'read') { skipped.push({ kind: 'outcome', id: o.id, reason: read.kind }); continue; }
    outcomeReads.set(type.id, Math.max(outcomeReads.get(type.id) ?? 0, read.population));
    const property = type.properties.find((p) => p.apiName === o.property)!;
    add({ objectTypeId: type.id, property: o.property, detectorId: null, name: `${neutral('the designated property', property.displayName, property.apiName)}: yes`, outcome: true, members: read.members });
  }

  const sampleOf = (typeId: string): number => {
    const union = new Set((byType.get(typeId) ?? []).flatMap((p) => [...p.members.keys()]));
    return Math.max(Number(stored.populations.find((p) => p.objectTypeId === typeId)?.population ?? 0), outcomeReads.get(typeId) ?? 0, union.size);
  };
  const pluralOf = (type: ObjectTypeView) => neutral('objects', type.pluralName, type.apiName);

  const computed: Computed[] = [];
  for (const [typeId, populations] of byType) {
    const sample = sampleOf(typeId);
    if (sample === 0) continue;
    computed.push(...associateWithin(populations, sample, pluralOf(types.get(typeId)!)));
  }

  // Structural direction: link types joining two types that both have populations.
  const links = manifest.linkTypes.filter((l) => l.status === 'active' && byType.has(l.fromTypeId) && byType.has(l.toTypeId));
  const linkAccess = links.length === 0 ? undefined : await access(deps, ctx, { objectTypes: links.flatMap((l) => [l.fromTypeId, l.toTypeId]) });
  for (const link of links) {
    const routeId = link.defaultRouteId ?? (link.routes.length === 1 ? link.routes[0]!.id : undefined);
    if (routeId === undefined) { skipped.push({ kind: 'link_type', id: link.id, reason: 'ambiguous_route' }); continue; }
    if (!linkAccess!.allowed || !linkAccess!.typeVisible(link.fromTypeId) || !linkAccess!.typeVisible(link.toTypeId)) {
      skipped.push({ kind: 'link_type', id: link.id, reason: 'not_visible' });
      continue;
    }
    let read: Awaited<ReturnType<typeof readLinks>>;
    try {
      read = await readLinks(deps, ctx, manifest, link, routeId);
    } catch (error) {
      if (isAppError(error) && (error.category === 'forbidden' || error.category === 'not_found')) read = { kind: 'not_visible' };
      else throw error;
    }
    if (read.kind !== 'read') { skipped.push({ kind: 'link_type', id: link.id, reason: read.kind }); continue; }
    const from = types.get(link.fromTypeId)!;
    const to = types.get(link.toTypeId)!;
    computed.push(...associateAcross(byType.get(from.id)!, byType.get(to.id)!, read.forward,
      { id: link.id, direction: 'forward', name: neutral('a link', link.forwardName, link.apiName) }, sampleOf(from.id), pluralOf(from), pluralOf(to)));
    computed.push(...associateAcross(byType.get(to.id)!, byType.get(from.id)!, read.reverse,
      { id: link.id, direction: 'reverse', name: neutral('a link', link.reverseName, link.apiName) }, sampleOf(to.id), pluralOf(to), pluralOf(from)));
  }

  const computedAt = new Date().toISOString();
  const computation = await inTransaction(control, who.request, async (db) => {
    const row = await associationComputationRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, supersedesComputationId: stored.previous?.id ?? null,
      computedByMembershipId: who.membershipId ?? null, computedAt,
    });
    for (const c of computed) {
      await associationRepo.insert(db, {
        id: uuidv7(), organisationId: who.organisationId, computationId: row.id,
        leftObjectTypeId: c.left.objectTypeId, leftProperty: c.left.property, leftDetectorId: c.left.detectorId,
        rightObjectTypeId: c.right.objectTypeId, rightProperty: c.right.property, rightDetectorId: c.right.detectorId,
        linkTypeId: c.linkTypeId, linkDirection: c.linkDirection,
        coOccurrenceCount: String(c.coOccurrence), sampleSize: String(c.sampleSize),
        temporalOrder: c.temporalOrder, statement: c.statement, computedAt,
      });
    }
    await recordEvent(db, who, ctx.correlationId, {
      event: 'associations_computed', resource: { type: 'association_computation', id: row.id },
      detail: {
        associations: computed.length, object_types: byType.size, outcomes: stored.outcomes.length, skipped: skipped.length,
        supersedes: stored.previous?.id ?? null,
      },
    });
    return row;
  });
  return {
    computation: { id: computation.id, computedAt: computation.computedAt, supersedes: computation.supersedesComputationId },
    associations: computed.length,
    skipped: skipped.map((s) => ({ kind: s.kind, id: s.id, reason: s.reason === 'ambiguous_route' ? 'not_visible' as const : s.reason })),
  };
}

// ----------------------------------------------------------------------------- reading

/** What each detector population on a type rests on, for the reader's access: its findings' properties and markings. */
export async function restsOn(db: Queryable, objectTypeIds: readonly string[]) {
  const [properties, markings] = await Promise.all([
    findingRepo.currentPropertiesBy(db, objectTypeIds), findingMarkingRepo.currentMarkingsBy(db, objectTypeIds),
  ]);
  return { properties, markings };
}

/** The latest computation's associations the reader may see; the rest counted. */
export async function listAssociations(deps: RecognitionDeps, ctx: Context, query: { objectTypeId?: string | undefined; outcomeId?: string | undefined })
  : Promise<{ computation: { id: string; computedAt: string; supersedes: string | null } | null; associations: AssociationView[]; withheld: number }> {
  const who = actor(ctx);
  const manifest = await readManifest(deps, ctx);
  const read = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const latest = await associationComputationRepo.latest(db);
    if (latest === undefined) return undefined;
    const outcome = query.outcomeId === undefined ? undefined : await outcomeDesignationRepo.findById(db, query.outcomeId);
    if (query.outcomeId !== undefined && outcome === undefined) throw new AppError('not_found', 'no such outcome', { code: 'recognition.outcome_not_found' });
    let rows = await associationRepo.listFor(db, latest.id, query.objectTypeId);
    if (outcome !== undefined) {
      rows = rows.filter((r) => (r.rightObjectTypeId === outcome.objectTypeId && r.rightProperty === outcome.property && r.rightDetectorId === outcome.detectorId)
        || (r.leftObjectTypeId === outcome.objectTypeId && r.leftProperty === outcome.property && r.leftDetectorId === outcome.detectorId));
    }
    const typeIds = [...new Set(rows.flatMap((r) => [r.leftObjectTypeId, r.rightObjectTypeId]))];
    return {
      latest, rows, rests: await restsOn(db, typeIds), outcomes: await outcomeDesignationRepo.listLive(db),
      registry: await detectorRepo.listActive(db),
    };
  }, { readOnly: true });
  if (read === undefined) return { computation: null, associations: [], withheld: 0 };
  const { visible, withheld } = await visibleAssociations(deps, ctx, manifest, read.rows, read.rests, read.outcomes, read.registry);
  return {
    computation: { id: read.latest.id, computedAt: read.latest.computedAt, supersedes: read.latest.supersedesComputationId },
    associations: visible, withheld,
  };
}

type Rests = Awaited<ReturnType<typeof restsOn>>;

/** Keeps the associations whose every part the reader may see (38.11), as views. */
export async function visibleAssociations(deps: RecognitionDeps, ctx: Context, manifest: OntologyManifest, rows: readonly Association[], rests: Rests,
  outcomes: readonly OutcomeDesignation[], registry: readonly { id: string; key: string; name: string }[]): Promise<{ visible: AssociationView[]; withheld: number }> {
  if (rows.length === 0) return { visible: [], withheld: 0 };
  const typeOfId = (id: string) => manifest.objectTypes.find((t) => t.id === id);
  const identity = (typeId: string, apiName: string) => typeOfId(typeId)?.properties.find((p) => p.apiName === apiName)?.identityId;
  /** Property identities and markings one side rests on; undefined when a name no longer resolves. */
  const sideNeeds = (typeId: string, property: string | null, detectorId: string | null) => {
    if (property !== null) {
      const id = identity(typeId, property);
      return id === undefined ? undefined : { properties: [id], markings: [] as string[] };
    }
    const named = rests.properties.filter((p) => p.objectTypeId === typeId && p.detectorId === detectorId).flatMap((p) => p.properties);
    const ids = named.map((n) => identity(typeId, n));
    if (ids.some((id) => id === undefined)) return undefined;
    return {
      properties: ids as string[],
      markings: rests.markings.filter((m) => m.objectTypeId === typeId && m.detectorId === detectorId).map((m) => m.markingId),
    };
  };
  const needs = rows.map((r) => ({ left: sideNeeds(r.leftObjectTypeId, r.leftProperty, r.leftDetectorId), right: sideNeeds(r.rightObjectTypeId, r.rightProperty, r.rightDetectorId) }));
  const decision = await access(deps, ctx, {
    objectTypes: rows.flatMap((r) => [r.leftObjectTypeId, r.rightObjectTypeId]),
    properties: needs.flatMap((n) => [...(n.left?.properties ?? []), ...(n.right?.properties ?? [])]),
    markings: needs.flatMap((n) => [...(n.left?.markings ?? []), ...(n.right?.markings ?? [])]),
  });
  const clear = (side: { properties: string[]; markings: string[] } | undefined) => side !== undefined
    && side.properties.every((id) => decision.propertyClear(id)) && side.markings.every((m) => decision.markingSatisfied(m));
  const isOutcome = (typeId: string, property: string | null, detectorId: string | null) =>
    outcomes.some((o) => o.objectTypeId === typeId && o.property === property && o.detectorId === detectorId);
  const side = (typeId: string, property: string | null, detectorId: string | null) => {
    const d = registry.find((x) => x.id === detectorId);
    const p = property === null ? undefined : typeOfId(typeId)?.properties.find((x) => x.apiName === property);
    return {
      objectTypeId: typeId, property, detector: detectorId === null ? null : d?.key ?? 'retired',
      name: property !== null ? `${neutral('the designated property', p?.displayName, property)}: yes` : neutral('a detector', d?.name, d?.key),
      outcome: isOutcome(typeId, property, detectorId),
    };
  };
  const visible: AssociationView[] = [];
  rows.forEach((r, i) => {
    const seen = decision.allowed && decision.typeVisible(r.leftObjectTypeId) && decision.typeVisible(r.rightObjectTypeId)
      && clear(needs[i]!.left) && clear(needs[i]!.right);
    if (!seen) return;
    const t = r.temporalOrder as { precedes: number; follows: number; unordered: number; of: number } | null;
    visible.push({
      id: r.id, left: side(r.leftObjectTypeId, r.leftProperty, r.leftDetectorId), right: side(r.rightObjectTypeId, r.rightProperty, r.rightDetectorId),
      relation: r.linkTypeId === null ? 'occurs_together' : 'linked_through', linkTypeId: r.linkTypeId, linkDirection: r.linkDirection as 'forward' | 'reverse' | null,
      coOccurrence: Number(r.coOccurrenceCount), sampleSize: Number(r.sampleSize), temporalOrder: t, statement: r.statement, computedAt: r.computedAt,
    });
  });
  return { visible, withheld: rows.length - visible.length };
}
