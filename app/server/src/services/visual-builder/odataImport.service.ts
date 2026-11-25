// A visual-builder draft from an OData service's $metadata (spec 14.4: OData's discovery model;
// SAP S/4HANA and ECC are reached through OData). Pure, and no model call, as the WSDL and
// GraphQL imports are (import.service.ts): the CSDL document is compiled to a manifest the
// person then edits, tries and publishes.
//
// - Version from the document: edmx Version 4.0 is OData 4.0; 1.0 with DataServiceVersion
//   2.0 (or none) is OData 2.0.
// - Each entity set becomes an object: its entity type's key properties the identifier, its
//   primitive properties the fields (EDM types mapped to field types, and kept per property
//   for typed literals), every field filterable by equality, comparison where it is ordered,
//   contains and startswith on strings, sortable, and $top as the limit.
// - Relationships from referential constraints: version 4.0's on navigation properties,
//   version 2.0's on associations, as foreign keys between the objects drafted.
// - Writes are not declared: whether the service accepts them is not in $metadata (SAP
//   annotates it only sometimes), so the person declares them.
// A document carrying a DTD is refused unread. Authentication is not described.

import { XMLParser } from 'fast-xml-parser';
import { EDM_TYPES, type EdmType, type FieldType, type FilterOp, type ManifestInput } from '../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { toName } from '../schema-inference/infer.service.ts';

interface Identity { name: string; provider: string }

const VERSION = '0.1.0';
const MAX_OBJECTS = 50;
const MAX_FIELDS = 200;
const MAX_PAGES = 1_000;

const FIELD_TYPE: Readonly<Record<EdmType, FieldType>> = {
  'Edm.String': 'string', 'Edm.Guid': 'string', 'Edm.Boolean': 'boolean', 'Edm.Byte': 'integer', 'Edm.SByte': 'integer', 'Edm.Int16': 'integer',
  'Edm.Int32': 'integer', 'Edm.Int64': 'integer', 'Edm.Decimal': 'number', 'Edm.Double': 'number', 'Edm.Single': 'number', 'Edm.Date': 'date',
  'Edm.DateTime': 'date-time', 'Edm.DateTimeOffset': 'date-time',
};
const ORDERED: ReadonlySet<FieldType> = new Set(['integer', 'number', 'date', 'date-time']);

type El = Record<string, unknown>;
const list = (value: unknown): El[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value as El[] : [value as El]);
const attr = (el: El | undefined, name: string): string | undefined => (el?.[`@_${name}`] as string | undefined);
const local = (qualified: string): string => qualified.slice(qualified.lastIndexOf('.') + 1);

function unique(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

export function importOdataMetadata(text: string, identity: Identity, baseUrl: string | undefined): { document: ManifestInput; notes: string[] } {
  if (/<!DOCTYPE/i.test(text)) throw new AppError('validation', 'a $metadata document carrying a DTD is refused', { code: 'visual.import_dtd' });
  if (baseUrl === undefined) throw new AppError('validation', 'name the service root URL: $metadata does not say where the service is', { code: 'visual.import_base_url' });
  const url = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?$/.exec(baseUrl.replace(/\/\$metadata$/, ''));
  if (url === null) throw new AppError('validation', 'the service root is an origin and a path', { code: 'visual.import_base_url' });
  let parsed: El;
  try {
    parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false }).parse(text) as El;
  } catch {
    throw new AppError('validation', 'the $metadata document is not XML', { code: 'visual.import_invalid' });
  }
  const edmx = parsed['Edmx'] as El | undefined;
  if (edmx === undefined) throw new AppError('validation', 'not a CSDL document: no Edmx element', { code: 'visual.import_invalid' });
  const dataServices = edmx['DataServices'] as El | undefined;
  const version = attr(edmx, 'Version') === '4.0' || attr(edmx, 'Version') === '4.01' ? '4.0' as const : '2.0' as const;
  const schemas = list(dataServices?.['Schema']);
  const notes: string[] = ['auth_not_described', 'writes_not_described'];

  const entityTypes = new Map<string, El>();
  const associations = new Map<string, El>();
  for (const schema of schemas) {
    const ns = attr(schema, 'Namespace') ?? '';
    const alias = attr(schema, 'Alias');
    for (const type of list(schema['EntityType'])) {
      const name = attr(type, 'Name')!;
      entityTypes.set(`${ns}.${name}`, type);
      if (alias) entityTypes.set(`${alias}.${name}`, type);
    }
    for (const assoc of list(schema['Association'])) associations.set(`${ns}.${attr(assoc, 'Name')}`, assoc);
  }
  const sets = schemas.flatMap((s) => list(s['EntityContainer']).flatMap((c) => list(c['EntitySet'])));
  if (sets.length === 0) throw new AppError('validation', 'the $metadata describes no entity set', { code: 'visual.import_no_objects' });
  if (sets.length > MAX_OBJECTS) notes.push(`entity_sets_beyond_${MAX_OBJECTS}_left_out`);

  const taken = new Set<string>();
  const objectBySet = new Map<string, { name: string; typeName: string; fields: Map<string, string> }>();
  const objects: ManifestInput['objects'] = [];
  for (const set of sets.slice(0, MAX_OBJECTS)) {
    const setName = attr(set, 'Name')!;
    const typeName = attr(set, 'EntityType')!;
    const type = entityTypes.get(typeName);
    if (type === undefined) { notes.push(`entity_set_${setName}_type_unknown`); continue; }
    const keyNames = list((type['Key'] as El | undefined)?.['PropertyRef']).map((r) => attr(r, 'Name')!);
    const properties = list(type['Property']).filter((p) => (EDM_TYPES as readonly string[]).includes(attr(p, 'Type') ?? ''));
    const skipped = list(type['Property']).length - properties.length;
    if (skipped > 0) notes.push(`${setName}_complex_properties_left_out`);
    if (keyNames.length === 0 || !keyNames.every((k) => properties.some((p) => attr(p, 'Name') === k))) {
      notes.push(`entity_set_${setName}_has_no_primitive_key`);
      continue;
    }
    const fieldTaken = new Set<string>();
    const fieldOf = new Map<string, string>();
    const types: Record<string, EdmType> = {};
    const fields = properties.slice(0, MAX_FIELDS).map((p) => {
      const property = attr(p, 'Name')!;
      const edm = attr(p, 'Type') as EdmType;
      const name = unique(toName(property), fieldTaken);
      fieldOf.set(property, name);
      types[property] = edm;
      return { name, type: FIELD_TYPE[edm], nullable: attr(p, 'Nullable') !== 'false', ...(name === property ? {} : { path: property }) };
    });
    if (properties.length > MAX_FIELDS) notes.push(`${setName}_fields_beyond_${MAX_FIELDS}_left_out`);
    const filters = fields.map((f) => {
      const ops: FilterOp[] = ['eq', 'ne', 'in', 'is_null', 'is_not_null'];
      if (ORDERED.has(f.type)) ops.push('lt', 'lte', 'gt', 'gte');
      if (f.type === 'string') ops.push('contains', 'starts_with');
      return { field: f.name, ops };
    });
    const name = unique(toName(setName), taken);
    objectBySet.set(setName, { name, typeName, fields: fieldOf });
    objects.push({
      name, identifier: keyNames.map((k) => fieldOf.get(k)!), fields,
      source: { kind: 'odata', servicePath: '/', entitySet: setName, types, maxPages: MAX_PAGES },
      pushdown: { filters, sort: fields.map((f) => ({ field: f.name })), limit: {} },
    });
  }
  if (objects.length === 0) throw new AppError('validation', 'no entity set has a primitive key to identify its records by', { code: 'visual.import_no_objects' });

  // Relationships: a dependent's property referring to a principal's key, between drafted objects.
  const setsOfType = (qualified: string) => [...objectBySet.entries()].filter(([, o]) => o.typeName === qualified || local(o.typeName) === local(qualified));
  const relate = (dependentType: string, property: string, principalType: string, principalProperty: string) => {
    for (const [, dependent] of setsOfType(dependentType)) {
      for (const [, principal] of setsOfType(principalType)) {
        const field = dependent.fields.get(property);
        const target = principal.fields.get(principalProperty);
        if (field === undefined || target === undefined) continue;
        const object = objects.find((o) => o.name === dependent.name)!;
        const relationships = (object.relationships ??= []);
        if (!relationships.some((r) => r.field === field && r.targetObject === principal.name)) {
          relationships.push({ field, targetObject: principal.name, targetField: target, kind: 'foreign_key' });
        }
      }
    }
  };
  for (const [qualified, type] of entityTypes) {
    for (const nav of list(type['NavigationProperty'])) {
      const target = (attr(nav, 'Type') ?? '').replace(/^Collection\((.*)\)$/, '$1');
      for (const constraint of list(nav['ReferentialConstraint'])) {
        if (version === '4.0' && target !== '') relate(qualified, attr(constraint, 'Property')!, target, attr(constraint, 'ReferencedProperty')!);
      }
    }
  }
  for (const assoc of associations.values()) {
    const constraint = assoc['ReferentialConstraint'] as El | undefined;
    if (constraint === undefined) continue;
    const ends = new Map(list(assoc['End']).map((e) => [attr(e, 'Role')!, attr(e, 'Type')!]));
    const principal = constraint['Principal'] as El;
    const dependent = constraint['Dependent'] as El;
    const pRefs = list(principal?.['PropertyRef']);
    const dRefs = list(dependent?.['PropertyRef']);
    pRefs.forEach((p, i) => {
      const d = dRefs[i];
      if (d !== undefined) relate(ends.get(attr(dependent, 'Role')!)!, attr(d, 'Name')!, ends.get(attr(principal, 'Role')!)!, attr(p, 'Name')!);
    });
  }

  return {
    document: {
      schemaVersion: '1', identity: { ...identity, version: VERSION }, transport: { viaAgent: false, baseUrl: `${url[1]}${(url[2] ?? '').replace(/\/$/, '')}` },
      protocol: { kind: 'odata', version }, auth: { strategy: 'none', fields: [] }, objects,
    },
    notes,
  };
}
