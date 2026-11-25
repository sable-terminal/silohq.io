// Inference over what a probe read (spec 14.6): pure functions from records, held in memory
// for the length of one call, to structure and counts. Nothing here keeps, logs or returns a
// value: types, formats, presence, nulls, distinctness and overlaps are counted, and the
// counts are the evidence.
//
// Records mode:
// - the records: a body that is an array is the records; an object envelope holds them in
//   its longest array of objects (to depth 3), whose path becomes the records expression;
// - fields: every key path to depth 3, an object of many keys or of keys that look like
//   identifiers being a map (one json field, never expanded: its keys are values);
// - types on the manifest's lattice, with the share of values that fit as confidence;
// - the identifier: a field present, non-null and unique in every sampled record, named
//   id first, then <object>_id, uuid, key or code;
// - relationships: a field named <target>_id whose values fall among the target's
//   identifiers, by counted overlap;
// - paging hints: an envelope key naming a cursor, a next link or a page count.
// Catalogue mode: information_schema rows to tables, columns, keys and foreign keys.

import type { FieldType } from '../../contracts/connect/manifest.contract.ts';
import type {
  InferredField, InferredObject, InferredRelationship, PagingHint,
} from '../../contracts/schema-inference/inference.contract.ts';

const MAX_DEPTH = 3;
/** An object with more keys than this is a map: its keys are values, never fields. */
const MAP_KEYS = 200;
const MAX_FIELDS = 2_000;
/** Distinct values counted per field before counting stops (evidence says at least this many). */
const DISTINCT_CAP = 10_000;

export type Raw = unknown;
type Kind = 'null' | 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI = /^(https?:\/\/|\/)[^\s]*$/;
const DECIMAL = /^-?\d+\.\d+$/;
const ID_LIKE_KEY = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z]{1,4}[_-]?\d{3,})$/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function kindOf(value: unknown): Kind {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'bigint') return 'integer';
  if (Array.isArray(value)) return 'array';
  return 'object';
}

function formatOf(value: string): string | null {
  if (DATE.test(value)) return 'date';
  if (DATE_TIME.test(value)) return 'date-time';
  if (UUID.test(value)) return 'uuid';
  if (EMAIL.test(value)) return 'email';
  if (URI.test(value)) return 'uri';
  if (DECIMAL.test(value)) return 'decimal';
  return null;
}

/** A source key as a manifest name: lower snake case, at most 63 characters, starting with a letter. */
export function toName(key: string): string {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const named = /^[a-z]/.test(snake) ? snake : `f_${snake}`;
  return named.slice(0, 63).replace(/_+$/, '') || 'field';
}

/** Unique names for a list of paths, in order. */
function uniqueNames(paths: readonly string[]): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const path of paths) {
    const base = toName(path.replaceAll('.', '_'));
    let candidate = base;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${base.slice(0, 59)}_${n}`;
    taken.add(candidate);
    out.set(path, candidate);
  }
  return out;
}

const isMap = (value: Record<string, unknown>): boolean => {
  const keys = Object.keys(value);
  return keys.length > MAP_KEYS || (keys.length >= 3 && keys.every((k) => ID_LIKE_KEY.test(k)));
};

/** Leaf paths of a record, objects expanded to MAX_DEPTH unless they are maps. */
function leaves(record: Record<string, unknown>, prefix: string, depth: number, out: Map<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    if (key.includes('.') || key.trim() === '') continue; // not addressable by a dot path
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(value) && depth < MAX_DEPTH && !isMap(value) && Object.keys(value).length > 0) {
      leaves(value, path, depth + 1, out);
    } else {
      out.set(path, value);
    }
  }
}

interface FieldStats {
  present: number;
  nulls: number;
  kinds: Map<Kind, number>;
  formats: Map<string, number>;
  distinct: Set<string>;
  distinctCapped: boolean;
}

const newStats = (): FieldStats => ({ present: 0, nulls: 0, kinds: new Map(), formats: new Map(), distinct: new Set(), distinctCapped: false });
const bump = <K>(map: Map<K, number>, key: K): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

function observe(stats: FieldStats, value: unknown): void {
  stats.present += 1;
  const kind = kindOf(value);
  bump(stats.kinds, kind);
  if (kind === 'null') {
    stats.nulls += 1;
    return;
  }
  if (kind === 'string') {
    const format = formatOf(value as string);
    if (format !== null) bump(stats.formats, format);
  }
  if (stats.distinct.size < DISTINCT_CAP) stats.distinct.add(kind === 'object' || kind === 'array' ? JSON.stringify(value) : String(value));
  else stats.distinctCapped = true;
}

/** The manifest type the observed kinds fit, and the share of non-null values that fit it. */
function typeOf(stats: FieldStats): { type: FieldType; format: string | null; fit: number } {
  const nonNull = stats.present - stats.nulls;
  if (nonNull === 0) return { type: 'string', format: null, fit: 0 };
  const count = (k: Kind) => stats.kinds.get(k) ?? 0;
  const strings = count('string');
  const candidates: { type: FieldType; format: string | null; fits: number }[] = [
    { type: 'boolean', format: null, fits: count('boolean') },
    { type: 'integer', format: null, fits: count('integer') },
    { type: 'number', format: null, fits: count('integer') + count('number') },
    { type: 'json', format: null, fits: count('object') + count('array') },
  ];
  const dated = stats.formats.get('date') ?? 0;
  const timed = stats.formats.get('date-time') ?? 0;
  if (dated > 0) candidates.push({ type: 'date', format: 'date', fits: dated });
  if (timed > 0) candidates.push({ type: 'date-time', format: 'date-time', fits: timed });
  // A string field fits every string; its format is the one most strings share, if all do.
  const [topFormat, topCount] = [...stats.formats.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  candidates.push({
    type: 'string', format: topFormat !== null && topCount === strings ? topFormat : null,
    // Numbers and booleans also read as strings, but only prefer string when strings lead.
    fits: strings,
  });
  const best = candidates.sort((a, b) => b.fits - a.fits || rank(a.type) - rank(b.type))[0]!;
  // Mixed strings with numbers or booleans: string holds both.
  if ((best.type === 'boolean' || best.type === 'integer' || best.type === 'number') && strings > 0) {
    return { type: 'string', format: null, fit: (strings + best.fits) / nonNull };
  }
  return { type: best.type, format: best.format, fit: best.fits / nonNull };
}

// Narrower types first when equally supported.
const rank = (type: FieldType): number => ['date', 'date-time', 'boolean', 'integer', 'number', 'string', 'json'].indexOf(type);

/** Confidence from fit, discounted while few records support it. */
const confident = (fit: number, support: number): number => Math.round(fit * Math.min(1, 0.5 + support / 40) * 100) / 100;

export interface RecordsFound {
  /** JSONata path to the records: "$" for the body itself. */
  recordsPath: string;
  records: Record<string, unknown>[];
  /** The envelope around the records, when there is one. */
  envelope: Record<string, unknown> | null;
}

/** Where the records sit in a probe's raw rows (each the whole body, or each a record). */
export function findRecords(raw: readonly Raw[]): RecordsFound {
  if (raw.length === 1 && isPlainObject(raw[0])) {
    const body = raw[0];
    let best: { path: string; items: Record<string, unknown>[]; depth: number } | undefined;
    const walk = (value: Record<string, unknown>, prefix: string, depth: number): void => {
      for (const [key, child] of Object.entries(value)) {
        if (key.includes('.') || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (Array.isArray(child) && child.length > 0 && child.every(isPlainObject)) {
          if (best === undefined || child.length > best.items.length || (child.length === best.items.length && depth < best.depth)) {
            best = { path, items: child as Record<string, unknown>[], depth };
          }
        } else if (isPlainObject(child) && depth < MAX_DEPTH && !isMap(child)) {
          walk(child, path, depth + 1);
        }
      }
    };
    walk(body, '', 1);
    if (best !== undefined) return { recordsPath: best.path, records: best.items, envelope: body };
    return { recordsPath: '$', records: [body], envelope: null };
  }
  return { recordsPath: '$', records: raw.filter(isPlainObject), envelope: null };
}

const CURSOR_KEY = /^(next|next_?cursor|cursor|next_?page_?token|after|end_?cursor|continuation_?token)$/i;
const PAGES_KEY = /^(total_?pages|page_?count|last_?page|pages)$/i;
const OFFSET_KEY = /^(offset|skip)$/i;
const PAGING_HOMES = /^(paging|pagination|page_?info|meta|links|_links|cursor)$/i;

/** Hints at how the envelope pages: cursor, next link, page count or offset. Values are only classified. */
export function pagingHints(envelope: Record<string, unknown> | null): PagingHint[] {
  if (envelope === null) return [];
  const hints: PagingHint[] = [];
  const look = (value: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (CURSOR_KEY.test(key) && (typeof child === 'string' || child === null)) {
        const link = typeof child === 'string' && URI.test(child);
        hints.push({ style: link ? 'next_url' : 'cursor', path, confidence: depth === 1 ? 0.8 : 0.7 });
      } else if (PAGES_KEY.test(key) && typeof child === 'number') {
        hints.push({ style: 'page', path, confidence: 0.7 });
      } else if (OFFSET_KEY.test(key) && typeof child === 'number') {
        hints.push({ style: 'offset', path, confidence: 0.6 });
      } else if (isPlainObject(child) && depth < 2 && PAGING_HOMES.test(key)) {
        look(child, path, depth + 1);
      }
    }
  };
  look(envelope, '', 1);
  return hints.sort((a, b) => b.confidence - a.confidence).slice(0, 10);
}

export interface RecordFields {
  fields: InferredField[];
  /** Field name to its values, kept only for the identifier and relationship counts of this call. */
  values: Map<string, unknown[]>;
}

/** Fields, types and counts over records. */
export function inferFields(records: readonly Record<string, unknown>[], prefix = ''): RecordFields {
  const stats = new Map<string, FieldStats>();
  const values = new Map<string, unknown[]>();
  for (const record of records) {
    const found = new Map<string, unknown>();
    leaves(record, '', 1, found);
    for (const [path, value] of found) {
      if (!stats.has(path)) {
        if (stats.size >= MAX_FIELDS) continue;
        stats.set(path, newStats());
        values.set(path, []);
      }
      observe(stats.get(path)!, value);
      values.get(path)!.push(value);
    }
  }
  const names = uniqueNames([...stats.keys()]);
  const sampled = records.length;
  const fields: InferredField[] = [];
  const byName = new Map<string, unknown[]>();
  for (const [path, s] of stats) {
    const { type, format, fit } = typeOf(s);
    const name = names.get(path)!;
    const types: Record<string, number> = {};
    for (const [kind, n] of s.kinds) types[kind] = n;
    fields.push({
      name, path: prefix === '' ? path : `${prefix}.${path}`, type, nullable: s.nulls > 0 || s.present < sampled, format,
      // A field seen in few of the records is less certain however well its values fit.
      confidence: confident(fit * (sampled === 0 ? 0 : s.present / sampled), s.present - s.nulls),
      evidence: { sampled, present: s.present, nulls: s.nulls, distinct: s.distinct.size, types },
    });
    byName.set(name, values.get(path)!);
  }
  return { fields, values: byName };
}

const singular = (word: string): string =>
  word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('ses') ? word.slice(0, -2) : word.endsWith('s') ? word.slice(0, -1) : word;

/** The identifier: present, non-null and unique in every sampled record, by name preference. */
export function inferIdentifier(objectName: string, fields: readonly InferredField[], sampled: number): InferredObject['identifier'] {
  if (sampled === 0) return null;
  const own = `${singular(objectName)}_id`;
  const preference = (name: string): number =>
    name === 'id' ? 0 : name === own ? 1 : /^(uuid|key|code|number|ref)$/.test(name) ? 2 : name.endsWith('_id') ? 4 : 3;
  const candidates = fields
    .filter((f) => (f.type === 'string' || f.type === 'integer') && f.evidence.present === sampled && f.evidence.nulls === 0
      && f.evidence.distinct === sampled && !f.path.includes('.'))
    .sort((a, b) => preference(a.name) - preference(b.name));
  const chosen = candidates[0];
  if (chosen === undefined) return null;
  const base = preference(chosen.name) <= 1 ? 0.95 : preference(chosen.name) === 2 ? 0.8 : 0.6;
  return {
    fields: [chosen.name],
    confidence: confident(base, sampled),
    evidence: { unique: chosen.evidence.distinct, nonNull: sampled - chosen.evidence.nulls },
  };
}

export interface ObjectSample {
  name: string;
  identifier: string | null;
  fields: readonly InferredField[];
  values: Map<string, unknown[]>;
}

/** Relationships by name and counted overlap: <target>_id whose values fall among the target's identifiers. */
export function inferRelationships(objects: readonly ObjectSample[]): Map<string, InferredRelationship[]> {
  const out = new Map<string, InferredRelationship[]>();
  const keys = new Map<string, Set<string>>();
  for (const o of objects) {
    if (o.identifier !== null) keys.set(o.name, new Set((o.values.get(o.identifier) ?? []).map((v) => String(v))));
  }
  for (const o of objects) {
    const found: InferredRelationship[] = [];
    for (const field of o.fields) {
      const match = /^(.+)_id$/.exec(field.name);
      if (match === null || field.name === o.identifier) continue;
      const stem = match[1]!;
      const target = objects.find((t) => t.name !== o.name && t.identifier !== null && (t.name === stem || singular(t.name) === stem));
      if (target === undefined) continue;
      const known = keys.get(target.name)!;
      const checked = (o.values.get(field.name) ?? []).filter((v) => v !== null && v !== undefined);
      const matched = checked.filter((v) => known.has(String(v))).length;
      const overlap = checked.length === 0 ? 0 : matched / checked.length;
      found.push({
        field: field.name, targetObject: target.name, targetField: target.identifier!, kind: 'foreign_key',
        confidence: Math.round((0.5 + 0.5 * overlap) * 100) / 100,
        evidence: { declared: false, checked: checked.length, matched },
      });
    }
    out.set(o.name, found);
  }
  return out;
}

// ----------------------------------------------------------------------------- catalogue

export interface CatalogueRows {
  columns: Record<string, unknown>[];
  constraints: Record<string, unknown>[];
  keys: Record<string, unknown>[];
  references: Record<string, unknown>[];
}

/** information_schema data types to the manifest's lattice. Standard type names, never a dialect. */
export function catalogueType(dataType: string): FieldType {
  const t = dataType.toLowerCase();
  if (/^(smallint|integer|int|bigint|tinyint|mediumint|int[248]?)$/.test(t)) return 'integer';
  if (/^(numeric|decimal|real|double precision|double|float.*|money|number)/.test(t)) return 'number';
  if (/^(boolean|bool|bit)$/.test(t)) return 'boolean';
  if (t === 'date') return 'date';
  if (/^(timestamp|datetime)/.test(t)) return 'date-time';
  if (/^(json|jsonb|variant|object|array)/.test(t) || t.endsWith('[]')) return 'json';
  return 'string';
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const tableKey = (schema: string, table: string): string => `${schema}\u0000${table}`;

/** Tables, columns, primary keys and foreign keys from the information_schema views. */
export function inferCatalogue(rows: CatalogueRows, excluded: ReadonlySet<string>): InferredObject[] {
  const tables = new Map<string, { schema: string; table: string; columns: { name: string; type: FieldType; nullable: boolean; position: number }[] }>();
  for (const c of rows.columns) {
    const schema = str(c['table_schema']);
    if (excluded.has(schema)) continue;
    const table = str(c['table_name']);
    const key = tableKey(schema, table);
    if (!tables.has(key)) tables.set(key, { schema, table, columns: [] });
    tables.get(key)!.columns.push({
      name: str(c['column_name']), type: catalogueType(str(c['data_type'])), nullable: str(c['is_nullable']).toUpperCase() !== 'NO',
      position: Number(c['ordinal_position'] ?? 0),
    });
  }
  const constraintKey = (schema: string, name: string): string => `${schema}\u0000${name}`;
  const kinds = new Map<string, { type: string; table: string }>();
  for (const k of rows.constraints) {
    kinds.set(constraintKey(str(k['constraint_schema']), str(k['constraint_name'])), {
      type: str(k['constraint_type']).toUpperCase(), table: tableKey(str(k['table_schema']), str(k['table_name'])),
    });
  }
  const columnsOf = new Map<string, { table: string; column: string; position: number }[]>();
  for (const k of rows.keys) {
    const key = constraintKey(str(k['constraint_schema']), str(k['constraint_name']));
    if (!columnsOf.has(key)) columnsOf.set(key, []);
    columnsOf.get(key)!.push({ table: tableKey(str(k['table_schema']), str(k['table_name'])), column: str(k['column_name']), position: Number(k['ordinal_position'] ?? 0) });
  }
  for (const list of columnsOf.values()) list.sort((a, b) => a.position - b.position);

  // Object names: the table name, qualified by schema where two schemas share it.
  const counts = new Map<string, number>();
  for (const t of tables.values()) counts.set(t.table, (counts.get(t.table) ?? 0) + 1);
  const objectNames = uniqueNames([...tables.values()].map((t) => ((counts.get(t.table) ?? 0) > 1 ? `${t.schema}_${t.table}` : t.table)));
  const nameOf = (t: { schema: string; table: string }): string =>
    objectNames.get((counts.get(t.table) ?? 0) > 1 ? `${t.schema}_${t.table}` : t.table)!;

  const objects: InferredObject[] = [];
  for (const [key, t] of tables) {
    t.columns.sort((a, b) => a.position - b.position);
    const fieldNames = uniqueNames(t.columns.map((c) => c.name));
    const fields: InferredField[] = t.columns.map((c) => ({
      name: fieldNames.get(c.name)!, path: c.name, type: c.type, nullable: c.nullable, format: null, confidence: 1,
      evidence: { sampled: 0, present: 0, nulls: 0, distinct: 0, types: {} },
    }));
    const fieldOf = (column: string): string | undefined => fieldNames.get(column);
    let identifier: InferredObject['identifier'] = null;
    const relationships: InferredRelationship[] = [];
    for (const [constraint, info] of kinds) {
      if (info.table !== key) continue;
      const cols = columnsOf.get(constraint) ?? [];
      if (info.type === 'PRIMARY KEY' && cols.length > 0 && cols.length <= 8) {
        identifier = { fields: cols.map((c) => fieldOf(c.column)!).filter(Boolean), confidence: 1, evidence: { unique: 0, nonNull: 0 } };
      }
      if (info.type === 'FOREIGN KEY') {
        const ref = rows.references.find((r) => constraintKey(str(r['constraint_schema']), str(r['constraint_name'])) === constraint);
        if (ref === undefined) continue;
        const target = columnsOf.get(constraintKey(str(ref['unique_constraint_schema']), str(ref['unique_constraint_name']))) ?? [];
        const targetTable = target[0] === undefined ? undefined : tables.get(target[0].table);
        if (targetTable === undefined || cols.length !== 1 || target.length !== 1) continue; // composite keys: declared by a person
        const field = fieldOf(cols[0]!.column);
        const targetField = uniqueNames(targetTable.columns.map((c) => c.name)).get(target[0]!.column);
        if (field === undefined || targetField === undefined) continue;
        relationships.push({
          field, targetObject: nameOf(targetTable), targetField, kind: 'foreign_key', confidence: 1,
          evidence: { declared: true, checked: 0, matched: 0 },
        });
      }
    }
    if (identifier === null) {
      const unique = [...kinds].find(([constraint, info]) => info.table === key && info.type === 'UNIQUE' && (columnsOf.get(constraint)?.length ?? 0) === 1);
      if (unique !== undefined) {
        identifier = { fields: [fieldOf(columnsOf.get(unique[0])![0]!.column)!], confidence: 0.9, evidence: { unique: 0, nonNull: 0 } };
      }
    }
    objects.push({
      name: nameOf(t), object: nameOf(t), recordsPath: null, table: { schema: t.schema, table: t.table }, sampled: 0, identifier,
      fields, relationships, paging: [], declared: [], typeMismatches: 0,
    });
  }
  return objects.sort((a, b) => a.name.localeCompare(b.name));
}
