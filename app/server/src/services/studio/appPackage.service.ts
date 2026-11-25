// App packages (D231): an app's definition carried to another organisation, a test cell's to a
// production cell's, say. A definition names ontology elements by their ids, which mean nothing
// elsewhere, so the package also names each element it uses by its API name (a property with its
// type's, a link type, a Function, an Action type, a shared property). Imported, each is found in
// the receiving organisation's ontology by that name and its id put in place; one not found there
// is named, and the draft's validation says what it breaks. Pure: no I/O.

export const PACKAGE_FORMAT = 'silo.app-package';
export const REFERENCE_KINDS = ['object_type', 'property', 'link_type', 'function', 'action_type', 'shared_property'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];
export interface Reference { id: string; kind: ReferenceKind; apiName: string; objectType?: string | undefined }

/** What the mapping reads of an ontology: elements by id and API name. */
export interface Vocabulary {
  objectTypes: { id: string; apiName: string; properties: { identityId: string; apiName: string }[] }[];
  linkTypes: { id: string; apiName: string }[];
  functions: { id: string; apiName: string }[];
  sharedProperties: { id: string; apiName: string }[];
  actionTypes: { id: string; apiName: string }[];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Every element the definition names, anywhere in it (a widget's columns, a filter, a text's label), by API name. */
export function referencesOf(definition: Record<string, unknown>, v: Vocabulary): { references: Reference[]; unresolved: string[] } {
  const ids = [...new Set(JSON.stringify(definition).match(UUID) ?? [])];
  const references: Reference[] = [];
  const unresolved: string[] = [];
  for (const id of ids) {
    const type = v.objectTypes.find((t) => t.id === id);
    if (type !== undefined) { references.push({ id, kind: 'object_type', apiName: type.apiName }); continue; }
    const owner = v.objectTypes.find((t) => t.properties.some((p) => p.identityId === id));
    if (owner !== undefined) {
      references.push({ id, kind: 'property', apiName: owner.properties.find((p) => p.identityId === id)!.apiName, objectType: owner.apiName });
      continue;
    }
    const found = ([['link_type', v.linkTypes], ['function', v.functions], ['action_type', v.actionTypes], ['shared_property', v.sharedProperties]] as const)
      .map(([kind, list]) => ({ kind, hit: list.find((x) => x.id === id) })).find((x) => x.hit !== undefined);
    if (found !== undefined) references.push({ id, kind: found.kind, apiName: found.hit!.apiName });
    else unresolved.push(id);
  }
  return { references, unresolved };
}

/** The receiving organisation's id for a reference, by API name; undefined where it has none. */
function targetOf(r: Reference, v: Vocabulary): string | undefined {
  switch (r.kind) {
    case 'object_type': return v.objectTypes.find((t) => t.apiName === r.apiName)?.id;
    case 'property': return v.objectTypes.find((t) => t.apiName === r.objectType)?.properties.find((p) => p.apiName === r.apiName)?.identityId;
    case 'link_type': return v.linkTypes.find((x) => x.apiName === r.apiName)?.id;
    case 'function': return v.functions.find((x) => x.apiName === r.apiName)?.id;
    case 'action_type': return v.actionTypes.find((x) => x.apiName === r.apiName)?.id;
    case 'shared_property': return v.sharedProperties.find((x) => x.apiName === r.apiName)?.id;
  }
}

/** The definition with each reference's id replaced by the receiving organisation's; those it has none for, named. */
export function remap(definition: Record<string, unknown>, references: readonly Reference[], v: Vocabulary)
  : { definition: Record<string, unknown>; mapped: number; unmapped: Omit<Reference, 'id'>[] } {
  const ids = new Map<string, string>();
  const unmapped: Omit<Reference, 'id'>[] = [];
  for (const r of references) {
    const target = targetOf(r, v);
    if (target === undefined) unmapped.push({ kind: r.kind, apiName: r.apiName, ...(r.objectType === undefined ? {} : { objectType: r.objectType }) });
    else ids.set(r.id, target);
  }
  // One pass: an id put in place is never replaced again.
  const text = JSON.stringify(definition).replace(UUID, (id) => ids.get(id) ?? id);
  return { definition: JSON.parse(text) as Record<string, unknown>, mapped: ids.size, unmapped };
}
