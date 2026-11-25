// Authoring elements on a branch (spec 21.5 to 21.11). A definition names other elements
// by API name; it is resolved against the branch's head, checked against the source layer
// (the connection declares the object and field), and committed as a new version on the
// branch. Nothing here touches main.
//
// What is checked, beyond the schema's own rules:
// - every contributing object, mapping and route names an object and field the connection
//   declares, and a mapping's source is a contributing object of the type;
// - a link route of origin declared_fk is a key the connection's manifest declares; a link
//   Silo cannot show the declared key for does not exist (spec 21.8);
// - a resolvable type has match keys mapped on every contributing object (spec 23.1), a
//   single-source type a primary key;
// - a property of a shared property has its type; a computed property's function version
//   exists, computes a property and returns its type;
// - functions and match key normalisations type-check as CEL over their declared inputs,
//   with no clock but the one passed in (spec 21.11).

import type {
  FunctionDefinition, InterfaceDefinition, LinkTypeDefinition, ObjectTypeDefinition, SharedPropertyDefinition,
} from '../../contracts/ontology/element.contract.ts';
import type {
  FunctionView, InterfaceView, LinkTypeView, ObjectTypeView, SharedPropertyView, VersionView,
} from '../../contracts/ontology/manifest.contract.ts';
import type { ElementKind } from '../../contracts/ontology/proposal.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { OntologyBranch } from '../../models/ontology/ontologyBranch.model.ts';
import { functionVersionRepo, ontologyBranchRepo, ontologyProposalRepo, ontologyVersionRepo } from '../../repos/ontology/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import {
  classify, diff, findByApiName, findById, routeKey, toView, withEntries, type AnyEntry, type Content, type MappingEntry, type ObjectTypeEntry,
  type PropertyEntry,
} from './content.service.ts';
import { acting, allowed, demand, person, recordEvent, type Acting, type Context, type OntologyDeps, type OntologyEvent } from './deps.service.ts';
import { createSourceSchemas, type SourceSchemas } from './sourceSchema.service.ts';
import { commit, readContent, versionToView, type Write } from './store.service.ts';

const refuse = (code: string, message: string, details: Record<string, string | number | boolean> = {}): AppError =>
  new AppError('validation', message, { code, details });

const unique = (names: readonly string[], what: string): void => {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw refuse('ontology.duplicate_name', `${what} ${n} appears twice`, { name: n });
    seen.add(n);
  }
};

function checkCel(source: string, inputs: Parameters<typeof compileCel>[1], code: string): void {
  try {
    compileCel(source, inputs);
  } catch {
    throw refuse(code, 'the expression does not type-check over its declared inputs');
  }
}

const roundConfidence = (c: number): number => Math.round(c * 1000) / 1000;

// ----------------------------------------------------------------------------- object types

export interface Authoring {
  content: Content;
  sources: SourceSchemas;
  /** Who confirms what a person writes: the author for their own mappings, the confirmer in derivation. */
  confirmer: string;
  now: string;
  /** Mapping confidence: 1 for what a person writes, the derivation's own for accepted proposals. */
  confidence?: (property: string, connectionId: string) => number;
}

export async function resolveObjectType(def: Omit<ObjectTypeDefinition, 'expectedHeadVersionId'>, name: string, a: Authoring): Promise<ObjectTypeEntry> {
  const before = findByApiName(a.content, 'object_type', name);
  unique(def.properties.map((p) => p.apiName), 'property');
  const keyOf = (o: { connectionId: string; sourceObject: string }) => `${o.connectionId}/${o.sourceObject}`;
  unique(def.contributingObjects.map(keyOf), 'contributing object');

  const contributing: ObjectTypeEntry['contributingObjects'] = [];
  for (const o of def.contributingObjects) {
    const object = await a.sources.object(o.connectionId, o.sourceObject);
    await a.sources.field(o.connectionId, o.sourceObject, o.identifierFieldPath);
    contributing.push({ connectionId: o.connectionId, sourceObject: o.sourceObject, identifierFieldPath: o.identifierFieldPath, connectorVersion: object.connectorVersion });
  }
  const contributingKeys = new Set(contributing.map(keyOf));
  const resolutionClass = contributing.length >= 2 ? 'resolvable' : 'single_source';

  const properties: PropertyEntry[] = [];
  for (const p of def.properties) {
    const previous = before?.properties.find((q) => q.apiName === (p.previousApiName ?? p.apiName));
    let sharedPropertyId: string | null = null;
    if (p.sharedProperty !== undefined) {
      const shared = findByApiName(a.content, 'shared_property', p.sharedProperty);
      if (!shared) throw refuse('ontology.shared_property_unknown', `no shared property ${p.sharedProperty}`, { name: p.sharedProperty });
      if (shared.dataType !== p.dataType) {
        throw refuse('ontology.shared_property_type', `${p.apiName} must have the type of ${p.sharedProperty}`, { property: p.apiName });
      }
      sharedPropertyId = shared.id;
    }
    if (p.computedFunctionVersionId !== undefined) {
      const fn = a.content.functions.find((f) => f.version.id === p.computedFunctionVersionId);
      if (!fn || fn.kind !== 'computed_property') {
        throw refuse('ontology.function_unknown', `${p.apiName} names no computed-property function version on this branch`, { property: p.apiName });
      }
      if (fn.version.outputType.dataType !== p.dataType) {
        throw refuse('ontology.function_output_type', `${p.apiName} must have the type its function returns`, { property: p.apiName });
      }
      if (p.mappings.length > 0) throw refuse('ontology.computed_property_mapped', `${p.apiName} is computed and has no mappings`, { property: p.apiName });
    } else if (p.mappings.length === 0) {
      throw refuse('ontology.property_unmapped', `${p.apiName} maps no source field`, { property: p.apiName });
    }
    unique(p.mappings.map(keyOf), `mapping of ${p.apiName} from`);
    const mappings: MappingEntry[] = [];
    for (const m of p.mappings) {
      if (!contributingKeys.has(keyOf(m))) {
        throw refuse('ontology.mapping_source', `${p.apiName} maps from an object that does not contribute to the type`, { property: p.apiName });
      }
      await a.sources.field(m.connectionId, m.sourceObject, m.fieldPath);
      if (m.valueMap !== undefined && p.dataType !== 'enum' && p.dataType !== 'boolean') {
        throw refuse('ontology.value_map_type', 'a value map normalises an enum or boolean property only', { property: p.apiName });
      }
      if (m.sourceTimeZone !== undefined && p.dataType !== 'timestamp') {
        throw refuse('ontology.time_zone_type', 'a source time zone applies to a timestamp property only', { property: p.apiName });
      }
      if (m.sourceTimeZone !== undefined && !Intl.supportedValuesOf('timeZone').includes(m.sourceTimeZone) && m.sourceTimeZone !== 'UTC') {
        throw refuse('ontology.time_zone_unknown', 'the source time zone is not a known IANA zone', { property: p.apiName });
      }
      // A mapping already confirmed with these exact terms keeps its confirmation.
      const kept = previous?.mappings.find((q) => keyOf(q) === keyOf(m) && q.fieldPath === m.fieldPath);
      mappings.push({
        connectionId: m.connectionId, sourceObject: m.sourceObject, fieldPath: m.fieldPath, valueMap: m.valueMap ?? null,
        sourceTimeZone: m.sourceTimeZone ?? null, confidence: roundConfidence(a.confidence?.(p.apiName, m.connectionId) ?? 1),
        confirmedBy: kept?.confirmedBy ?? a.confirmer, confirmedAt: kept?.confirmedAt ?? a.now,
      });
    }
    properties.push({
      identityId: previous?.identityId ?? uuidv7(), apiName: p.apiName, displayName: p.displayName, description: p.description ?? null,
      dataType: p.dataType, typeParams: p.typeParams, nullable: p.nullable, isMatchKey: def.matchKeys.some((k) => k.property === p.apiName),
      sharedPropertyId, computedFunctionVersionId: p.computedFunctionVersionId ?? null, status: 'active', mappings,
    });
  }
  const prop = (apiName: string, role: string): PropertyEntry => {
    const found = properties.find((p) => p.apiName === apiName);
    if (!found) throw refuse('ontology.property_unknown', `the ${role} names no property of the type`, { role, property: apiName });
    return found;
  };

  if (resolutionClass === 'single_source') {
    if (def.primaryKey === undefined) throw refuse('ontology.primary_key_required', 'a single-source type names its primary key property');
    if (def.matchKeys.length > 0) throw refuse('ontology.match_keys_single_source', 'a single-source type has no match keys: nothing to resolve');
  } else {
    if (def.primaryKey !== undefined) throw refuse('ontology.primary_key_resolvable', 'a resolvable type is keyed by the Silo object id');
    if (def.matchKeys.length === 0) throw refuse('ontology.match_keys_required', 'a resolvable type resolves through match keys (spec 23.1)');
  }
  if (def.disjointSources && (resolutionClass !== 'resolvable' || contributing.length < 2)) {
    throw refuse('ontology.disjoint_sources_invalid', 'only a resolvable type with several contributing objects can be declared to split its objects between them');
  }
  unique(def.matchKeys.map((k) => k.property), 'match key');
  const matchKeys = def.matchKeys.map((k) => {
    const p = prop(k.property, 'match key');
    if (p.computedFunctionVersionId !== null) throw refuse('ontology.match_key_computed', 'a match key is a mapped property', { property: k.property });
    for (const o of contributing) {
      if (!p.mappings.some((m) => keyOf(m) === keyOf(o))) {
        throw refuse('ontology.match_key_unmapped', `match key ${k.property} must be mapped on every contributing object`, { property: k.property });
      }
    }
    if (k.normalisation !== undefined) checkCel(k.normalisation, { value: 'string' }, 'ontology.normalisation_invalid');
    return { propertyIdentityId: p.identityId, normalisation: k.normalisation ?? null };
  });

  unique(def.timeFields.map((t) => t.property), 'time field');
  if (def.timeFields.filter((t) => t.isDefault).length > 1) throw refuse('ontology.default_time_field', 'at most one time field is the default');
  const timeFields = def.timeFields.map((t) => {
    const p = prop(t.property, 'time field');
    if (p.dataType !== 'date' && p.dataType !== 'timestamp') {
      throw refuse('ontology.time_field_type', 'a time field is a date or timestamp property', { property: t.property });
    }
    return { propertyIdentityId: p.identityId, meaning: t.meaning, isDefault: t.isDefault };
  });

  const id = before?.id ?? uuidv7();
  const implementations = def.implements.map((i) => {
    const iface = findByApiName(a.content, 'interface', i.interface);
    if (!iface) throw refuse('ontology.interface_unknown', `no interface ${i.interface}`, { name: i.interface });
    const propertyBindings: Record<string, string> = {};
    for (const sharedId of iface.requiredSharedPropertyIds) {
      const shared = findById(a.content, 'shared_property', sharedId)!;
      const bound = i.propertyBindings[shared.apiName];
      if (bound === undefined) throw refuse('ontology.binding_missing', `${i.interface} needs ${shared.apiName} bound`, { interface: i.interface });
      const p = prop(bound, `binding of ${shared.apiName}`);
      if (p.dataType !== shared.dataType) throw refuse('ontology.binding_type', `${bound} must have the type of ${shared.apiName}`, { property: bound });
      propertyBindings[sharedId] = p.identityId;
    }
    const linkBindings: Record<string, string> = {};
    for (const required of iface.requiredLinkTypeNames) {
      const bound = i.linkBindings[required];
      const link = bound === undefined ? undefined : findByApiName(a.content, 'link_type', bound);
      if (!link || (link.fromTypeId !== id && link.toTypeId !== id)) {
        throw refuse('ontology.link_binding', `${i.interface} needs ${required} bound to a link type of this type`, { interface: i.interface });
      }
      linkBindings[required] = link.id;
    }
    return { interfaceId: iface.id, propertyBindings, linkBindings };
  });

  return {
    id, typeVersionId: before?.typeVersionId ?? id, apiName: name, status: before?.status ?? 'proposed', displayName: def.displayName,
    pluralName: def.pluralName, description: def.description ?? null, resolutionClass, matchKeys, ...(def.disjointSources ? { disjointSources: true } : {}),
    primaryKeyPropertyIdentityId: def.primaryKey === undefined ? null : prop(def.primaryKey, 'primary key').identityId,
    titlePropertyIdentityId: prop(def.title, 'title').identityId,
    defaultTimeFieldPropertyIdentityId: timeFields.find((t) => t.isDefault)?.propertyIdentityId ?? null,
    contributingObjects: contributing, properties, timeFields, implements: implementations, visual: def.visual,
  };
}

// ----------------------------------------------------------------------------- link types

export async function resolveLinkType(def: Omit<LinkTypeDefinition, 'expectedHeadVersionId'>, name: string, a: Authoring): Promise<LinkTypeView> {
  const before = findByApiName(a.content, 'link_type', name);
  const from = findByApiName(a.content, 'object_type', def.from);
  const to = findByApiName(a.content, 'object_type', def.to);
  if (!from || !to) throw refuse('ontology.object_type_unknown', 'a link joins two object types of this branch', { from: def.from, to: def.to });
  const owns = (t: ObjectTypeEntry, connectionId: string, sourceObject: string) =>
    t.contributingObjects.some((o) => o.connectionId === connectionId && o.sourceObject === sourceObject);
  const routes: LinkTypeView['routes'] = [];
  for (const [position, r] of def.routes.entries()) {
    if (def.cardinality === 'many_to_many' && r.junctionObject === undefined) {
      throw refuse('ontology.junction_required', 'a many-to-many route runs through a junction object', { position });
    }
    if (def.cardinality !== 'many_to_many' && r.junctionObject !== undefined) {
      throw refuse('ontology.junction_unexpected', 'only a many-to-many route has a junction object', { position });
    }
    const holder = r.junctionObject ?? r.sourceObject;
    if (r.junctionObject === undefined && !owns(from, r.connectionId, r.sourceObject) && !owns(to, r.connectionId, r.sourceObject)) {
      throw refuse('ontology.route_source', 'a route reads a key held by an object of one of the linked types', { position });
    }
    await a.sources.field(r.connectionId, holder, r.foreignKeyField);
    // The referenced end in another system (D248): the other linked type's object there, its field read there.
    if (r.referencedConnectionId !== undefined || r.referencedObject !== undefined) {
      if (r.referencedConnectionId === undefined || r.referencedObject === undefined) {
        throw refuse('ontology.route_reference', 'a route into another system names both the connection and the object it reads there', { position });
      }
      if (r.junctionObject !== undefined) throw refuse('ontology.route_reference', 'a route through a junction object runs in one system', { position });
      if (r.origin === 'declared_fk') {
        throw refuse('ontology.route_not_declared', 'no connection declares a key into another system; a person declares it instead', { position });
      }
      const holderType = owns(from, r.connectionId, r.sourceObject) ? from : to;
      const otherType = holderType === from ? to : from;
      if (!owns(otherType, r.referencedConnectionId, r.referencedObject)) {
        throw refuse('ontology.route_reference', 'the referenced object is one the other linked type is read from', { position });
      }
      await a.sources.field(r.referencedConnectionId, r.referencedObject, r.referencedField);
    }
    if (r.origin === 'declared_fk') {
      const object = await a.sources.object(r.connectionId, holder);
      const declared = object.relationships.some((k) => k.field === r.foreignKeyField && k.targetField === r.referencedField && k.kind !== 'reference');
      if (!declared) {
        throw refuse('ontology.route_not_declared', 'the connection declares no such foreign key; a person may declare it instead', { position });
      }
    }
    const key = routeKey({ ...r, junctionObject: r.junctionObject ?? null });
    const kept = before?.routes.find((q) => q.position === position && routeKey(q) === key && q.origin === r.origin);
    routes.push({
      id: kept?.id ?? uuidv7(), position, connectionId: r.connectionId, sourceObject: r.sourceObject, foreignKeyField: r.foreignKeyField,
      referencedField: r.referencedField, junctionObject: r.junctionObject ?? null,
      ...(r.referencedConnectionId === undefined ? {} : { referencedConnectionId: r.referencedConnectionId, referencedObject: r.referencedObject! }),
      origin: r.origin,
    });
  }
  if (def.defaultRoute !== undefined && def.defaultRoute >= routes.length) {
    throw refuse('ontology.default_route', 'the default route is one of the routes');
  }
  return {
    id: before?.id ?? uuidv7(), apiName: name, status: before?.status ?? 'proposed', forwardName: def.forwardName, reverseName: def.reverseName,
    fromTypeId: from.id, toTypeId: to.id, cardinality: def.cardinality, routes,
    defaultRouteId: def.defaultRoute === undefined ? null : routes[def.defaultRoute]!.id,
  };
}

export function resolveSharedProperty(def: SharedPropertyDefinition, name: string, a: Pick<Authoring, 'content'>): SharedPropertyView {
  const before = findByApiName(a.content, 'shared_property', name);
  return {
    id: before?.id ?? uuidv7(), apiName: name, status: before?.status ?? 'proposed', displayName: def.displayName,
    description: def.description ?? null, dataType: def.dataType, typeParams: def.typeParams,
  };
}

export function resolveInterface(def: InterfaceDefinition, name: string, a: Pick<Authoring, 'content'>): InterfaceView {
  const before = findByApiName(a.content, 'interface', name);
  unique(def.requiredSharedProperties, 'required shared property');
  return {
    id: before?.id ?? uuidv7(), apiName: name, status: before?.status ?? 'proposed', displayName: def.displayName,
    description: def.description ?? null,
    requiredSharedPropertyIds: def.requiredSharedProperties.map((sp) => {
      const shared = findByApiName(a.content, 'shared_property', sp);
      if (!shared) throw refuse('ontology.shared_property_unknown', `no shared property ${sp}`, { name: sp });
      return shared.id;
    }),
    requiredLinkTypeNames: def.requiredLinkTypeNames,
  };
}

export async function resolveFunction(db: Queryable, def: FunctionDefinition, name: string, a: Pick<Authoring, 'content'>): Promise<FunctionView> {
  const before = findByApiName(a.content, 'function', name);
  if (before && before.kind !== def.kind) throw refuse('ontology.function_kind_fixed', 'a function keeps its kind; publish a new function');
  const typeIds = def.inputs.objectTypes.map((t) => {
    const found = findByApiName(a.content, 'object_type', t);
    if (!found) throw refuse('ontology.object_type_unknown', `no object type ${t}`, { name: t });
    return found.id;
  });
  const propertyIds = def.inputs.properties.map(({ objectType, property }) => {
    const found = findByApiName(a.content, 'object_type', objectType)?.properties.find((p) => p.apiName === property);
    if (!found) throw refuse('ontology.property_unknown', `no property ${objectType}.${property}`, { property });
    return found.identityId;
  });
  const linkIds = def.inputs.linkTypes.map((l) => {
    const found = findByApiName(a.content, 'link_type', l);
    if (!found) throw refuse('ontology.link_type_unknown', `no link type ${l}`, { name: l });
    return found.id;
  });
  checkCel(def.expression, { object: 'map', links: 'map', params: 'map', now: 'timestamp' }, 'ontology.function_invalid');
  return {
    id: before?.id ?? uuidv7(), apiName: name, status: before?.status ?? 'proposed', kind: def.kind, description: def.description ?? null,
    version: {
      id: uuidv7(), version: before ? (await functionVersionRepo.maxVersion(db, before.id)) + 1 : 1, expression: def.expression,
      inputs: { objectTypeIds: typeIds, propertyIdentityIds: propertyIds, linkTypeIds: linkIds, parameters: def.inputs.parameters },
      outputType: { dataType: def.outputType.dataType, typeParams: def.outputType.typeParams },
      costLimit: def.costLimit,
    },
  };
}

// ----------------------------------------------------------------------------- commits

export interface CommitOptions {
  expectedHeadVersionId?: string | undefined;
  /** The actor may commit to a branch someone else owns (ontology.manage, or confirming a derivation). */
  mayCommitToOthers: boolean;
  /** Confirming a derivation writes to its branch while its proposal is in review. */
  duringReview?: boolean;
}

export interface Built {
  writes: { kind: ElementKind; entry: AnyEntry; publishesFunctionVersion?: boolean }[];
  events: OntologyEvent[];
}

export interface Committed {
  version: VersionView;
  content: Content;
  /** False when the writes changed nothing: the head is returned as it was. */
  changed: boolean;
}

/** Locks the branch, checks it takes commits, builds the writes from its head and commits them. */
export async function commitOnBranch(deps: OntologyDeps, ctx: Context, actor: Acting, branchId: string, options: CommitOptions,
  build: (db: Queryable, head: { branch: OntologyBranch; content: Content; sources: SourceSchemas }) => Promise<Built>): Promise<Committed> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const branch = await ontologyBranchRepo.lock(db, branchId);
    if (!branch) throw new AppError('not_found', 'no such branch', { code: 'ontology.branch_not_found' });
    if (branch.kind === 'main') throw new AppError('forbidden', 'main changes only by a merged proposal (spec 25.4)', { code: 'ontology.main_merge_only' });
    if (branch.status !== 'open') throw new AppError('conflict', 'the branch is closed', { code: 'ontology.branch_closed' });
    if (branch.ownerMembershipId !== null && branch.ownerMembershipId !== actor.membershipId && !options.mayCommitToOthers) {
      throw new AppError('forbidden', 'the branch is someone else\'s', { code: 'ontology.not_branch_owner' });
    }
    if (options.expectedHeadVersionId !== undefined && options.expectedHeadVersionId !== branch.headVersionId) {
      throw new AppError('conflict', 'the branch moved since you read it', { code: 'ontology.branch_moved' });
    }
    if (!options.duringReview) {
      const open = await ontologyProposalRepo.openForBranch(db, branch.id);
      if (open && open.status !== 'draft') {
        throw new AppError('conflict', 'the branch is under review: withdraw the proposal to change it', { code: 'ontology.branch_in_review' });
      }
    }
    const content = await readContent(db, actor.organisationId, branch.headVersionId!);
    const built = await build(db, { branch, content, sources: createSourceSchemas(db) });
    const changed = new Set(diff(content, withEntries(content, built.writes)).map((c) => c.id));
    const writes: Write[] = built.writes.filter((w) => changed.has(w.entry.id)).map((w) => {
      const before = findById(content, w.kind, w.entry.id);
      return { ...w, operation: before ? 'change' : 'create', changeClass: classify(w.kind, before as never, w.entry as never).changeClass };
    });
    if (writes.length === 0) {
      return { version: versionToView((await ontologyVersionRepo.findById(db, branch.headVersionId!))!, branch), content, changed: false };
    }
    const result = await commit(db, {
      organisationId: actor.organisationId, branch, parentVersionId: branch.headVersionId!, parentContent: content, kind: 'change', actor, writes,
    });
    for (const e of built.events) {
      if (changed.has(e.resource.id) || e.resource.type === 'ontology_branch' || e.resource.type === 'ontology_proposal') {
        await recordEvent(db, actor, ctx.correlationId, e);
      }
    }
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'ontology_change_committed', resource: { type: 'ontology_version', id: result.version.id },
      detail: { branch_id: branch.id, elements: writes.length },
    });
    return { version: versionToView(result.version, branch), content: result.content, changed: true };
  });
}

/** The person writing a mapping confirms it; a service principal cannot (spec 22.8). */
const mappingConfirmer = (actor: Acting, def: { properties: { mappings: unknown[] }[] }): string => {
  if (actor.membershipId === undefined && def.properties.some((p) => p.mappings.length > 0)) {
    throw new AppError('forbidden', 'a mapping is confirmed by a person: a service principal proposes through derivation', {
      code: 'ontology.person_required',
    });
  }
  return actor.membershipId ?? '';
};

const MANAGE_NOTES = new Set(['visual_changed', 'default_time_field_changed', 'default_route_changed']);

async function mayCommitToOthers(deps: OntologyDeps, ctx: Context): Promise<boolean> {
  return allowed(deps, ctx, 'ontology.manage');
}

const elementView = <T>(content: Content, kind: ElementKind, id: string): T => {
  const view = toView(content);
  const list = { object_type: view.objectTypes, link_type: view.linkTypes, shared_property: view.sharedProperties, interface: view.interfaces, function: view.functions }[kind] as { id: string }[];
  return list.find((e) => e.id === id) as T;
};

export async function putObjectType(deps: OntologyDeps, ctx: Context, branchId: string, name: string, def: ObjectTypeDefinition)
  : Promise<{ version: VersionView; element: ObjectTypeView }> {
  const actor = acting(ctx);
  await demand(deps, ctx, 'ontology.propose');
  const confirmer = mappingConfirmer(actor, def);
  const others = await mayCommitToOthers(deps, ctx);
  let entryId = '';
  let manageChecked = false;
  const run = () => commitOnBranch(deps, ctx, actor, branchId, { expectedHeadVersionId: def.expectedHeadVersionId, mayCommitToOthers: others }, async (_db, head) => {
    const entry = await resolveObjectType(def, name, { content: head.content, sources: head.sources, confirmer, now: new Date().toISOString() });
    entryId = entry.id;
    const before = findById(head.content, 'object_type', entry.id);
    if (!manageChecked && before && classify('object_type', before, entry).notes.some((n) => MANAGE_NOTES.has(n))) {
      throw new NeedsManage();
    }
    const resource = { type: 'object_type', id: entry.id };
    const notes = before ? classify('object_type', before, entry).notes : [];
    const events: OntologyEvent[] = [];
    if (!before) events.push({ event: 'object_type_proposed', resource, detail: { branch_id: branchId, properties: entry.properties.length } });
    if (notes.includes('visual_changed')) events.push({ event: 'visual_metadata_changed', resource });
    if (!before ? entry.timeFields.length > 0 : notes.includes('time_field_declared')) events.push({ event: 'time_field_declared', resource });
    const mapped = entry.properties.reduce((n, p) => n + p.mappings.filter((m) => !before?.properties.find((q) => q.identityId === p.identityId)
      ?.mappings.some((o) => o.connectionId === m.connectionId && o.sourceObject === m.sourceObject && o.fieldPath === m.fieldPath)).length, 0);
    if (mapped > 0) events.push({ event: 'property_mapped', resource: { type: 'object_type', id: entry.id }, detail: { mappings: mapped } });
    // A mapping the type had and no longer has: its property stops reading that source field (21.6).
    const unmapped = (before?.properties ?? []).reduce((n, q) => n + q.mappings.filter((o) => !entry.properties.find((p) => p.identityId === q.identityId)
      ?.mappings.some((m) => m.connectionId === o.connectionId && m.sourceObject === o.sourceObject && m.fieldPath === o.fieldPath)).length, 0);
    if (unmapped > 0) events.push({ event: 'property_unmapped', resource: { type: 'object_type', id: entry.id }, detail: { mappings: unmapped } });
    return { writes: [{ kind: 'object_type', entry }], events };
  });
  let result: Committed;
  try {
    result = await run();
  } catch (error) {
    if (!(error instanceof NeedsManage)) throw mapApiNameConflict(error);
    await demand(deps, ctx, 'ontology.manage');
    manageChecked = true;
    result = await run().catch((e: unknown) => { throw mapApiNameConflict(e); });
  }
  return { version: result.version, element: elementView(result.content, 'object_type', entryId) };
}

/** Thrown inside a commit when the edit needs ontology.manage; the decision is asked outside the transaction. */
class NeedsManage extends Error {}

function mapApiNameConflict(error: unknown): unknown {
  if (error instanceof AppError && error.category === 'conflict' && error.code !== 'ontology.branch_moved' && error.code !== 'ontology.branch_in_review'
    && error.code !== 'ontology.branch_closed') {
    return new AppError('conflict', 'that API name is taken by an element on another branch', { code: 'ontology.api_name_taken' });
  }
  return error;
}

async function putSimple<K extends 'link_type' | 'shared_property' | 'interface'>(deps: OntologyDeps, ctx: Context, branchId: string,
  kind: K, expectedHeadVersionId: string | undefined, resolve: (head: { content: Content; sources: SourceSchemas }) => Promise<AnyEntry> | AnyEntry,
  created: OntologyEvent['event']) {
  const actor = acting(ctx);
  const others = await mayCommitToOthers(deps, ctx);
  let entryId = '';
  let manageChecked = false;
  const run = () => commitOnBranch(deps, ctx, actor, branchId, { expectedHeadVersionId, mayCommitToOthers: others }, async (_db, head) => {
    const entry = await resolve(head);
    entryId = entry.id;
    const before = findById(head.content, kind, entry.id);
    if (!manageChecked && before && classify(kind, before as never, entry as never).notes.some((n) => MANAGE_NOTES.has(n))) throw new NeedsManage();
    const events: OntologyEvent[] = before ? [] : [{ event: created, resource: { type: kind, id: entry.id }, detail: { branch_id: branchId } }];
    if (kind === 'link_type' && (entry as LinkTypeView).defaultRouteId !== ((before as LinkTypeView | undefined)?.defaultRouteId ?? null)) {
      events.push({ event: 'link_default_route_set', resource: { type: kind, id: entry.id } });
    }
    return { writes: [{ kind, entry }], events };
  });
  let result: Committed;
  try {
    result = await run();
  } catch (error) {
    if (!(error instanceof NeedsManage)) throw mapApiNameConflict(error);
    await demand(deps, ctx, 'ontology.manage');
    manageChecked = true;
    result = await run().catch((e: unknown) => { throw mapApiNameConflict(e); });
  }
  return { version: result.version, element: elementView<never>(result.content, kind, entryId) };
}

export async function putLinkType(deps: OntologyDeps, ctx: Context, branchId: string, name: string, def: LinkTypeDefinition)
  : Promise<{ version: VersionView; element: LinkTypeView }> {
  await demand(deps, ctx, 'ontology.propose');
  return putSimple(deps, ctx, branchId, 'link_type', def.expectedHeadVersionId,
    (head) => resolveLinkType(def, name, { content: head.content, sources: head.sources, confirmer: '', now: '' }), 'link_type_proposed');
}

export async function putSharedProperty(deps: OntologyDeps, ctx: Context, branchId: string, name: string, def: SharedPropertyDefinition)
  : Promise<{ version: VersionView; element: SharedPropertyView }> {
  // Curating shared properties and interfaces is ontology.manage (spec 21.17).
  await demand(deps, ctx, 'ontology.manage');
  return putSimple(deps, ctx, branchId, 'shared_property', def.expectedHeadVersionId, (head) => resolveSharedProperty(def, name, head),
    'shared_property_created');
}

export async function putInterface(deps: OntologyDeps, ctx: Context, branchId: string, name: string, def: InterfaceDefinition)
  : Promise<{ version: VersionView; element: InterfaceView }> {
  await demand(deps, ctx, 'ontology.manage');
  return putSimple(deps, ctx, branchId, 'interface', def.expectedHeadVersionId, (head) => resolveInterface(def, name, head), 'interface_created');
}

export async function putFunction(deps: OntologyDeps, ctx: Context, branchId: string, name: string, def: FunctionDefinition)
  : Promise<{ version: VersionView; element: FunctionView }> {
  const actor = person(ctx, 'publishing a function');
  await demand(deps, ctx, 'function.author');
  const others = await mayCommitToOthers(deps, ctx);
  let entryId = '';
  const result = await commitOnBranch(deps, ctx, actor, branchId, { expectedHeadVersionId: def.expectedHeadVersionId, mayCommitToOthers: others },
    async (db, head) => {
      const entry = await resolveFunction(db, def, name, head);
      entryId = entry.id;
      const before = findById(head.content, 'function', entry.id);
      if (before && before.version.expression === entry.version.expression && JSON.stringify(before.version.inputs) === JSON.stringify(entry.version.inputs)
        && JSON.stringify(before.version.outputType) === JSON.stringify(entry.version.outputType) && before.version.costLimit === entry.version.costLimit) {
        // The same version again: nothing new to publish.
        return { writes: [{ kind: 'function', entry: { ...entry, version: before.version } }], events: [] };
      }
      return {
        writes: [{ kind: 'function', entry, publishesFunctionVersion: true }],
        events: [{ event: 'function_version_published', resource: { type: 'function', id: entry.id }, detail: { version: entry.version.version, branch_id: branchId } }],
      };
    }).catch((e: unknown) => { throw mapApiNameConflict(e); });
  return { version: result.version, element: elementView(result.content, 'function', entryId) };
}

