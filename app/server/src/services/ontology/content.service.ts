// The ontology's content as the service holds it: the manifest's elements, plus what the
// rows need and the manifest does not show (who confirmed each mapping). Pure: hashing,
// stripping to the manifest view, diffing two versions and classing each change (spec
// 25.5). The database layer (store.service.ts) reads and writes these.

import {
  MANIFEST_SCHEMA_VERSION, type FunctionView, type InterfaceView, type LinkTypeView, type ObjectTypeView, type OntologyContent,
  type PropertyView, type SharedPropertyView,
} from '../../contracts/ontology/manifest.contract.ts';
import type { ChangeClass, ChangeView, ElementKind } from '../../contracts/ontology/proposal.contract.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';

export interface MappingEntry {
  connectionId: string;
  sourceObject: string;
  fieldPath: string;
  valueMap: Record<string, string> | null;
  sourceTimeZone: string | null;
  confidence: number;
  /** The person who confirmed it (rows only; not in the manifest). */
  confirmedBy: string;
  confirmedAt: string;
}
export type PropertyEntry = Omit<PropertyView, 'mappings'> & { mappings: MappingEntry[] };
export type ObjectTypeEntry = Omit<ObjectTypeView, 'properties'> & { properties: PropertyEntry[] };

export interface Content {
  objectTypes: ObjectTypeEntry[];
  linkTypes: LinkTypeView[];
  sharedProperties: SharedPropertyView[];
  interfaces: InterfaceView[];
  functions: FunctionView[];
}

export type AnyEntry = ObjectTypeEntry | LinkTypeView | SharedPropertyView | InterfaceView | FunctionView;
export type EntryOf<K extends ElementKind> = K extends 'object_type' ? ObjectTypeEntry : K extends 'link_type' ? LinkTypeView
  : K extends 'shared_property' ? SharedPropertyView : K extends 'interface' ? InterfaceView : FunctionView;

export const KIND_LISTS = {
  object_type: 'objectTypes', link_type: 'linkTypes', shared_property: 'sharedProperties', interface: 'interfaces', function: 'functions',
} as const satisfies Record<ElementKind, keyof Content>;

export const emptyContent = (): Content => ({ objectTypes: [], linkTypes: [], sharedProperties: [], interfaces: [], functions: [] });

const byApiName = <T extends { apiName: string }>(a: T, b: T): number => (a.apiName < b.apiName ? -1 : a.apiName > b.apiName ? 1 : 0);

/** The manifest's view of the content: sorted, mapping confirmations dropped. */
export function toView(content: Content): OntologyContent {
  return {
    objectTypes: [...content.objectTypes].sort(byApiName).map((t) => ({
      ...t,
      properties: [...t.properties].sort(byApiName).map((p) => ({
        ...p,
        mappings: [...p.mappings]
          .sort((a, b) => `${a.connectionId}/${a.sourceObject}`.localeCompare(`${b.connectionId}/${b.sourceObject}`))
          .map(({ confirmedBy: _by, confirmedAt: _at, ...m }) => m),
      })),
      contributingObjects: [...t.contributingObjects].sort((a, b) =>
        `${a.connectionId}/${a.sourceObject}`.localeCompare(`${b.connectionId}/${b.sourceObject}`)),
      timeFields: [...t.timeFields].sort((a, b) => a.propertyIdentityId.localeCompare(b.propertyIdentityId)),
      implements: [...t.implements].sort((a, b) => a.interfaceId.localeCompare(b.interfaceId)),
    })),
    linkTypes: [...content.linkTypes].sort(byApiName).map((l) => ({ ...l, routes: [...l.routes].sort((a, b) => a.position - b.position) })),
    sharedProperties: [...content.sharedProperties].sort(byApiName),
    interfaces: [...content.interfaces].sort(byApiName),
    functions: [...content.functions].sort(byApiName),
  };
}

/** SHA-256 (hex) over the canonical manifest content: equal content, equal hash. */
export function contentHash(content: Content): Buffer {
  return sha256(canonicalJsonBytes({ schemaVersion: MANIFEST_SCHEMA_VERSION, ...toView(content) }));
}

export function entriesOf<K extends ElementKind>(content: Content, kind: K): EntryOf<K>[] {
  return content[KIND_LISTS[kind]] as EntryOf<K>[];
}

export function findById<K extends ElementKind>(content: Content, kind: K, id: string): EntryOf<K> | undefined {
  return entriesOf(content, kind).find((e) => e.id === id);
}

export function findByApiName<K extends ElementKind>(content: Content, kind: K, name: string): EntryOf<K> | undefined {
  return entriesOf(content, kind).find((e) => e.apiName === name);
}

/** The content with these entries put in place of (or beside) what it had. */
export function withEntries(content: Content, entries: { kind: ElementKind; entry: AnyEntry }[]): Content {
  const next: Content = {
    objectTypes: [...content.objectTypes], linkTypes: [...content.linkTypes], sharedProperties: [...content.sharedProperties],
    interfaces: [...content.interfaces], functions: [...content.functions],
  };
  for (const { kind, entry } of entries) {
    const list = next[KIND_LISTS[kind]] as AnyEntry[];
    const at = list.findIndex((e) => e.id === entry.id);
    if (at >= 0) list[at] = entry;
    else list.push(entry);
  }
  return next;
}

// ----------------------------------------------------------------------------- change classes

const ORDER: Record<ChangeClass, number> = { additive: 0, compatible: 1, breaking: 2 };
export const highest = (classes: readonly ChangeClass[]): ChangeClass | null =>
  classes.length === 0 ? null : classes.reduce((a, b) => (ORDER[b] > ORDER[a] ? b : a));

const same = (a: unknown, b: unknown): boolean => canonicalJsonBytes(a ?? null).equals(canonicalJsonBytes(b ?? null));

interface Classified { changeClass: ChangeClass; notes: string[] }

class Notes {
  readonly items: [string, ChangeClass][] = [];
  add(note: string, changeClass: ChangeClass): void {
    this.items.push([note, changeClass]);
  }
  result(): Classified {
    return {
      changeClass: highest(this.items.map(([, c]) => c)) ?? 'compatible',
      notes: [...new Set(this.items.map(([n]) => n))].sort(),
    };
  }
}

const mappingKey = (m: { connectionId: string; sourceObject: string }) => `${m.connectionId}/${m.sourceObject}`;

function classifyObjectType(before: ObjectTypeEntry, after: ObjectTypeEntry): Classified {
  const notes = new Notes();
  if (before.displayName !== after.displayName || before.pluralName !== after.pluralName) notes.add('display_name_changed', 'compatible');
  if (before.description !== after.description) notes.add('description_changed', 'compatible');
  if (!same(before.visual, after.visual)) notes.add('visual_changed', 'compatible');
  if (before.titlePropertyIdentityId !== after.titlePropertyIdentityId) notes.add('title_property_changed', 'compatible');
  if (before.primaryKeyPropertyIdentityId !== after.primaryKeyPropertyIdentityId) notes.add('primary_key_changed', 'breaking');
  if (before.resolutionClass !== after.resolutionClass) {
    // A single-source type gaining a second contributing object is compatible (spec 22.6).
    notes.add('resolution_class_changed', after.resolutionClass === 'resolvable' ? 'compatible' : 'breaking');
  }
  if (!same(before.matchKeys, after.matchKeys)) notes.add('match_strategy_changed', 'breaking');
  // Declaring (or withdrawing) a disjoint split changes how aggregates may be computed, never what they are (27.7).
  if ((before.disjointSources === true) !== (after.disjointSources === true)) notes.add('source_partition_changed', 'compatible');
  if (before.defaultTimeFieldPropertyIdentityId !== after.defaultTimeFieldPropertyIdentityId) {
    notes.add('default_time_field_changed', before.defaultTimeFieldPropertyIdentityId === null ? 'compatible' : 'breaking');
  }
  const beforeObjects = new Set(before.contributingObjects.map(mappingKey));
  const afterObjects = new Set(after.contributingObjects.map(mappingKey));
  for (const key of afterObjects) if (!beforeObjects.has(key)) notes.add('contributing_object_added', 'additive');
  for (const key of beforeObjects) if (!afterObjects.has(key)) notes.add('contributing_object_removed', 'breaking');
  for (const o of after.contributingObjects) {
    const was = before.contributingObjects.find((b) => mappingKey(b) === mappingKey(o));
    if (was && was.identifierFieldPath !== o.identifierFieldPath) notes.add('identifier_field_changed', 'breaking');
  }

  const beforeProps = new Map(before.properties.map((p) => [p.identityId, p]));
  const afterProps = new Map(after.properties.map((p) => [p.identityId, p]));
  for (const [id, p] of afterProps) {
    const was = beforeProps.get(id);
    if (!was) {
      notes.add('property_added', 'additive');
      continue;
    }
    if (was.dataType !== p.dataType || !same(was.typeParams, p.typeParams)) notes.add('property_type_changed', 'breaking');
    if (was.apiName !== p.apiName) notes.add('property_renamed', 'breaking');
    if (was.displayName !== p.displayName || was.description !== p.description) notes.add('property_display_changed', 'compatible');
    if (was.nullable !== p.nullable) notes.add('property_nullability_changed', p.nullable ? 'compatible' : 'breaking');
    if (was.sharedPropertyId !== p.sharedPropertyId) notes.add('property_shared_property_changed', 'breaking');
    if (was.computedFunctionVersionId !== p.computedFunctionVersionId) notes.add('property_function_changed', 'compatible');
    const wasMappings = new Map(was.mappings.map((m) => [mappingKey(m), m]));
    const nowMappings = new Map(p.mappings.map((m) => [mappingKey(m), m]));
    for (const [key, m] of nowMappings) {
      const old = wasMappings.get(key);
      if (!old) notes.add('mapping_added', 'additive');
      else if (old.fieldPath !== m.fieldPath || !same(old.valueMap, m.valueMap) || old.sourceTimeZone !== m.sourceTimeZone) {
        notes.add('mapping_changed', 'breaking');
      }
    }
    for (const key of wasMappings.keys()) if (!nowMappings.has(key)) notes.add('mapping_removed', 'breaking');
  }
  for (const id of beforeProps.keys()) if (!afterProps.has(id)) notes.add('property_removed', 'breaking');

  const beforeTime = new Map(before.timeFields.map((t) => [t.propertyIdentityId, t]));
  for (const t of after.timeFields) {
    const was = beforeTime.get(t.propertyIdentityId);
    if (!was) notes.add('time_field_declared', 'additive');
    else if (was.meaning !== t.meaning) notes.add('time_field_meaning_changed', 'compatible');
  }
  for (const id of beforeTime.keys()) if (!after.timeFields.some((t) => t.propertyIdentityId === id)) notes.add('time_field_removed', 'breaking');

  const beforeImpl = new Map(before.implements.map((i) => [i.interfaceId, i]));
  for (const i of after.implements) {
    const was = beforeImpl.get(i.interfaceId);
    if (!was) notes.add('interface_implemented', 'additive');
    else if (!same(was, i)) notes.add('interface_binding_changed', 'breaking');
  }
  for (const id of beforeImpl.keys()) if (!after.implements.some((i) => i.interfaceId === id)) notes.add('interface_unimplemented', 'breaking');
  return notes.result();
}

/** A route's identity: where its key is held and what it references, in which system (D248). */
export const routeKey = (r: Pick<LinkTypeView['routes'][number], 'connectionId' | 'sourceObject' | 'foreignKeyField' | 'referencedField' | 'junctionObject'
  | 'referencedConnectionId' | 'referencedObject'>) =>
  `${r.connectionId}/${r.sourceObject}/${r.foreignKeyField}/${r.referencedField}/${r.junctionObject ?? ''}`
  + (r.referencedConnectionId == null ? '' : `/${r.referencedConnectionId}/${r.referencedObject ?? ''}`);

function classifyLinkType(before: LinkTypeView, after: LinkTypeView): Classified {
  const notes = new Notes();
  if (before.forwardName !== after.forwardName || before.reverseName !== after.reverseName) notes.add('names_changed', 'compatible');
  if (before.fromTypeId !== after.fromTypeId || before.toTypeId !== after.toTypeId) notes.add('endpoints_changed', 'breaking');
  if (before.cardinality !== after.cardinality) notes.add('cardinality_changed', 'breaking');
  const was = new Set(before.routes.map(routeKey));
  const now = new Set(after.routes.map(routeKey));
  for (const key of now) if (!was.has(key)) notes.add('route_added', 'additive');
  for (const key of was) if (!now.has(key)) notes.add('route_removed', 'breaking');
  if (before.defaultRouteId !== after.defaultRouteId) {
    notes.add('default_route_changed', before.defaultRouteId === null ? 'compatible' : 'breaking');
  }
  return notes.result();
}

function classifySharedProperty(before: SharedPropertyView, after: SharedPropertyView): Classified {
  const notes = new Notes();
  if (before.displayName !== after.displayName || before.description !== after.description) notes.add('display_changed', 'compatible');
  // Changing a shared property's type breaks every type using it (spec 21.10).
  if (before.dataType !== after.dataType || !same(before.typeParams, after.typeParams)) notes.add('type_changed', 'breaking');
  return notes.result();
}

function classifyInterface(before: InterfaceView, after: InterfaceView): Classified {
  const notes = new Notes();
  if (before.displayName !== after.displayName || before.description !== after.description) notes.add('display_changed', 'compatible');
  for (const id of after.requiredSharedPropertyIds) if (!before.requiredSharedPropertyIds.includes(id)) notes.add('requirement_added', 'breaking');
  for (const id of before.requiredSharedPropertyIds) if (!after.requiredSharedPropertyIds.includes(id)) notes.add('requirement_removed', 'compatible');
  for (const n of after.requiredLinkTypeNames) if (!before.requiredLinkTypeNames.includes(n)) notes.add('link_requirement_added', 'breaking');
  for (const n of before.requiredLinkTypeNames) if (!after.requiredLinkTypeNames.includes(n)) notes.add('link_requirement_removed', 'compatible');
  return notes.result();
}

function classifyFunction(before: FunctionView, after: FunctionView): Classified {
  const notes = new Notes();
  if (before.description !== after.description) notes.add('description_changed', 'compatible');
  // A new version moves no existing reference (spec 21.11).
  if (before.version.id !== after.version.id) notes.add('version_published', 'additive');
  return notes.result();
}

/** The class of one element's change (spec 25.5); a new element is additive. */
export function classify<K extends ElementKind>(kind: K, before: EntryOf<K> | undefined, after: EntryOf<K>): Classified {
  if (before === undefined) return { changeClass: 'additive', notes: ['created'] };
  switch (kind) {
    case 'object_type': return classifyObjectType(before as ObjectTypeEntry, after as ObjectTypeEntry);
    case 'link_type': return classifyLinkType(before as LinkTypeView, after as LinkTypeView);
    case 'shared_property': return classifySharedProperty(before as SharedPropertyView, after as SharedPropertyView);
    case 'interface': return classifyInterface(before as InterfaceView, after as InterfaceView);
    default: return classifyFunction(before as FunctionView, after as FunctionView);
  }
}

/**
 * What an entry is, setting aside where it sits (status), which row holds it (type
 * version) and the order rows come back in: the manifest view's ordering is canonical.
 */
function substance(kind: ElementKind, entry: AnyEntry): unknown {
  const single = { ...emptyContent(), [KIND_LISTS[kind]]: [entry] } as Content;
  const viewed = entriesOf(toView(single) as unknown as Content, kind)[0] as unknown as Record<string, unknown>;
  const { status: _s, typeVersionId: _v, ...rest } = viewed;
  return rest;
}

export const ELEMENT_KIND_LIST: readonly ElementKind[] = ['shared_property', 'interface', 'function', 'object_type', 'link_type'];

/**
 * Every element that differs between two contents, with its class. An element the base has
 * and the head does not was retired between them (a retirement, or a rollback to a version
 * without it): breaking, since everything that names it fails.
 */
export function diff(base: Content, head: Content): ChangeView[] {
  const changes: ChangeView[] = [];
  for (const kind of ELEMENT_KIND_LIST) {
    for (const entry of entriesOf(head, kind)) {
      const before = findById(base, kind, entry.id);
      if (before !== undefined && same(substance(kind, before), substance(kind, entry))) continue;
      const { changeClass, notes } = classify(kind, before, entry as never);
      changes.push({ kind, id: entry.id, apiName: entry.apiName, operation: before ? 'change' : 'create', changeClass, notes });
    }
    for (const entry of entriesOf(base, kind)) {
      if (findById(head, kind, entry.id) !== undefined) continue;
      changes.push({ kind, id: entry.id, apiName: entry.apiName, operation: 'retire', changeClass: 'breaking', notes: ['retired'] });
    }
  }
  return changes;
}
