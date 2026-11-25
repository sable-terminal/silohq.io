// Drift between a connection and its manifest (spec 17.3), decided from structure only: the
// manifest's declarations, the conformance run on the version, the structure observed now
// (connect-runtime's observeObject) and the structure observed at the last re-check. Pure,
// so each rule is tested on its own.
//
// The rename-versus-meaning rule is deliberately strict, because erring permissive silently
// corrupts every answer downstream: a declared field that is absent from every sampled record
// is renamed only when exactly one new path is present whose type and format fit the declared
// type and whose sample distribution (presence, distinctness, length, date shape) matches the
// old field's at the last re-check. Without a baseline, or with none or several candidates,
// it is a change of meaning, and the connection halts.

import type { ConformanceTest, Gate } from '../../contracts/conformance/conformance.contract.ts';
import type { Observation, ObservedField } from '../../contracts/connect-runtime/observe.contract.ts';
import type { ChangeKind, Drift, ManifestChange } from '../../contracts/connector-maintenance/maintenance.contract.ts';
import { AGGREGATE_FUNCTIONS, type FieldType, type Manifest, type ManifestObject } from '../../contracts/connect/manifest.contract.ts';

/** How far a candidate's sample may sit from the old field's and still be the same field. */
export const RENAME_TOLERANCE = { presence: 0.2, distinctness: 0.25, dateShape: 0.2, lengthRatio: 0.3, lengthAbsolute: 2 } as const;
/** A new path is proposed as a field when at least this share of the sample carries a value. */
export const NEW_FIELD_PRESENCE = 0.5;
/** At most this many new fields in one proposal. */
export const NEW_FIELDS_PER_PROPOSAL = 50;

/** One object's structure at a re-check, as kept in the probe run's findings. */
export interface ObjectStructure {
  object: string;
  observable: boolean;
  reason: string | null;
  records: number;
  fields: ObservedField[];
}

export type ObjectObservation = ObjectStructure | { object: string; error: string };

export interface ProposalPlan {
  changeKind: ChangeKind;
  changes: ManifestChange[];
  drift: Drift[];
  /** A halt: the connection stops serving; nothing is repaired. */
  halt: boolean;
  /** Repaired without review once its sandbox run passes (a rename, a lost pushdown). */
  auto: boolean;
}

export interface Analysis {
  drift: Drift[];
  proposals: ProposalPlan[];
}

const ratio = (part: number, whole: number): number => (whole <= 0 ? 0 : part / whole);

/** The path a REST field reads, or undefined for a computed field (no path to observe). */
export const declaredPath = (field: ManifestObject['fields'][number]): string | undefined =>
  field.value !== undefined ? undefined : field.path ?? field.name;

/** Whether the values seen at a path fit a declared type: ok, a widening (integer to number), or incompatible. */
export function fit(type: FieldType, seen: ObservedField): 'ok' | 'widen' | 'incompatible' {
  const k = seen.kinds;
  const strings = k.string;
  switch (type) {
    case 'json':
      return 'ok';
    case 'string':
      return k.object + k.array === 0 ? 'ok' : 'incompatible';
    case 'integer':
      if (k.boolean + k.object + k.array > 0 || strings > seen.numericStrings) return 'incompatible';
      return k.number > 0 ? 'widen' : 'ok';
    case 'number':
      return k.boolean + k.object + k.array > 0 || strings > seen.numericStrings ? 'incompatible' : 'ok';
    case 'boolean':
      return k.boolean === seen.present ? 'ok' : 'incompatible';
    case 'date':
      return strings === seen.present && seen.dateLike === strings ? 'ok' : 'incompatible';
    case 'date-time':
      return strings === seen.present && seen.dateTimeLike === strings ? 'ok' : 'incompatible';
  }
}

/** The type a newly seen path would be declared as. */
export function inferType(seen: ObservedField): FieldType {
  const k = seen.kinds;
  if (k.object + k.array > 0) return 'json';
  if (k.boolean === seen.present) return 'boolean';
  if (k.integer === seen.present) return 'integer';
  if (k.integer + k.number === seen.present) return 'number';
  if (k.string === seen.present) {
    if (seen.dateTimeLike === k.string && seen.dateLike < k.string) return 'date-time';
    if (seen.dateLike === k.string) return 'date';
    return 'string';
  }
  return 'json';
}

/** Whether a candidate path now looks like the old field did at the last re-check. */
export function consistent(before: ObservedField, beforeRecords: number, now: ObservedField, nowRecords: number): boolean {
  const t = RENAME_TOLERANCE;
  if (Math.abs(ratio(before.present, beforeRecords) - ratio(now.present, nowRecords)) > t.presence) return false;
  if (Math.abs(ratio(before.distinct, before.present) - ratio(now.distinct, now.present)) > t.distinctness) return false;
  const dominant = (f: ObservedField) => Object.entries(f.kinds).sort(([, a], [, b]) => b - a)[0]![0];
  if (before.present > 0 && now.present > 0 && dominant(before) !== dominant(now)) return false;
  if (Math.abs(ratio(before.dateLike, before.present) - ratio(now.dateLike, now.present)) > t.dateShape) return false;
  if (Math.abs(ratio(before.dateTimeLike, before.present) - ratio(now.dateTimeLike, now.present)) > t.dateShape) return false;
  if ((before.meanLength === null) !== (now.meanLength === null)) return false;
  if (before.meanLength !== null && now.meanLength !== null) {
    const gap = Math.abs(before.meanLength - now.meanLength);
    if (gap > t.lengthAbsolute && gap > t.lengthRatio * Math.max(before.meanLength, now.meanLength)) return false;
  }
  return true;
}

/** A manifest field name for a newly seen path: lower snake case, unique in the object. */
export function fieldNameFor(path: string, taken: ReadonlySet<string>): string {
  let base = path.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 56);
  if (!/^[a-z]/.test(base)) base = `f_${base}`.slice(0, 56);
  if (base === '' || base === 'f_') base = 'field';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  return name;
}

const failedWith = (tests: readonly ConformanceTest[], id: string, code: string): boolean =>
  tests.some((t) => t.id === id && t.outcome === 'failed' && t.reason === `error:${code}`);

/**
 * Drift and what to do about it, per spec 17.3. `baseline` is the structure at the last
 * completed re-check (by object), if there was one.
 */
export function analyse(input: {
  manifest: Manifest;
  tests: readonly ConformanceTest[];
  gate: Pick<Gate, 'failingOperators'>;
  observations: readonly ObjectObservation[];
  baseline: ReadonlyMap<string, ObjectStructure>;
}): Analysis {
  const drift: Drift[] = [];
  const renames: { change: ManifestChange; drift: Drift }[] = [];
  const widenings: { change: ManifestChange; drift: Drift }[] = [];
  const additions: { change: ManifestChange; drift: Drift }[] = [];
  const meaning: Drift[] = [];
  const removed: Drift[] = [];
  const incompatible: Drift[] = [];

  for (const object of input.manifest.objects) {
    const observed = input.observations.find((o) => o.object === object.name);
    const gone = failedWith(input.tests, `read.list.${object.name}`, 'source.not_found')
      || (observed !== undefined && 'error' in observed && observed.error === 'source.not_found');
    if (gone) {
      const d: Drift = { kind: 'object_removed', object: object.name, field: null, detail: 'source:not_found' };
      drift.push(d);
      removed.push(d);
      continue;
    }

    if (observed === undefined || 'error' in observed || !observed.observable || observed.records === 0) {
      // Structure is not visible here: a field whose values no longer fit its type shows only
      // as conformance's type test, which cannot say which field. A wrong type halts.
      const types = input.tests.find((t) => t.id === `read.types.${object.name}`);
      if (types?.outcome === 'failed' && types.reason?.startsWith('type_mismatches:') === true) {
        const d: Drift = { kind: 'type_changed', object: object.name, field: null, detail: types.reason.slice(0, 300) };
        drift.push(d);
        incompatible.push(d);
      }
      continue;
    }

    const records = observed.records;
    const seen = new Map(observed.fields.map((f) => [f.path, f]));
    const declared = object.fields.map((f) => ({ field: f, path: declaredPath(f) }));
    const claimed = new Set(declared.flatMap((d) => (d.path === undefined ? [] : [d.path])));
    const jsonPaths = declared.filter((d) => d.field.type === 'json' && d.path !== undefined).map((d) => d.path!);
    const container = (f: ObservedField) => f.present > 0 && f.kinds.object === f.present;
    const unclaimed = observed.fields.filter((f) => !claimed.has(f.path) && !container(f)
      && ![...claimed].some((p) => p.startsWith(`${f.path}.`))
      && !jsonPaths.some((p) => f.path.startsWith(`${p}.`)));
    const consumed = new Set<string>();
    const before = input.baseline.get(object.name);

    for (const { field, path } of declared) {
      if (path === undefined) continue;
      const now = seen.get(path);
      if (now === undefined || now.present + now.nulls === 0) {
        const old = before?.fields.find((f) => f.path === path);
        const candidates = old === undefined ? [] : unclaimed.filter((c) => !consumed.has(c.path)
          && fit(field.type, c) === 'ok' && consistent(old, before!.records, c, records));
        if (old !== undefined && candidates.length === 1) {
          const to = candidates[0]!.path;
          consumed.add(to);
          const d: Drift = { kind: 'rename', object: object.name, field: field.name, detail: `path:${path}->${to}`.slice(0, 300) };
          drift.push(d);
          renames.push({ change: { op: 'rename_field', object: object.name, field: field.name, fromPath: path, toPath: to }, drift: d });
        } else {
          const why = old === undefined ? 'no_baseline' : `candidates:${candidates.length}`;
          const d: Drift = { kind: 'meaning_changed', object: object.name, field: field.name, detail: `absent:${path}:${why}`.slice(0, 300) };
          drift.push(d);
          meaning.push(d);
        }
        continue;
      }
      if (now.present === 0) continue;
      const verdict = fit(field.type, now);
      if (verdict === 'widen') {
        const d: Drift = { kind: 'type_widened', object: object.name, field: field.name, detail: `${field.type}->number` };
        drift.push(d);
        widenings.push({ change: { op: 'widen_type', object: object.name, field: field.name, from: field.type, to: 'number' }, drift: d });
      } else if (verdict === 'incompatible') {
        const kinds = Object.entries(now.kinds).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(',');
        const d: Drift = { kind: 'type_changed', object: object.name, field: field.name, detail: `declared:${field.type};seen:${kinds}`.slice(0, 300) };
        drift.push(d);
        incompatible.push(d);
      }
    }

    const taken = new Set(object.fields.map((f) => f.name));
    for (const candidate of unclaimed) {
      if (consumed.has(candidate.path) || ratio(candidate.present, records) < NEW_FIELD_PRESENCE) continue;
      if (additions.filter((a) => a.drift.object === object.name).length >= NEW_FIELDS_PER_PROPOSAL) break;
      const name = fieldNameFor(candidate.path, taken);
      taken.add(name);
      const type = inferType(candidate);
      const d: Drift = { kind: 'new_field', object: object.name, field: name, detail: `path:${candidate.path};type:${type}`.slice(0, 300) };
      drift.push(d);
      additions.push({ change: { op: 'add_field', object: object.name, field: name, type, path: candidate.path }, drift: d });
    }
  }

  // Declared pushdown the source no longer honours (spec 17.2: removed from the version). Only
  // a result that differs from the same operation in memory is evidence of that; a test that
  // failed on a source error (the object gone, the source down) says nothing about the filter.
  const removedObjects = new Set(removed.map((d) => d.object));
  const differs = (o: { object: string; field: string; op: string }) => input.tests.some((t) => t.class === 'filter_pushdown'
    && t.outcome === 'failed' && t.object === o.object && t.operator?.field === o.field && t.operator.op === o.op
    && t.reason !== null && !t.reason.startsWith('error:'));
  const lostDrift: Drift[] = [];
  const lostOther: ManifestChange[] = [];
  const byFilter = new Map<string, { object: string; field: string; ops: string[] }>();
  for (const op of input.gate.failingOperators) {
    if (removedObjects.has(op.object) || !differs(op)) continue;
    lostDrift.push({ kind: 'pushdown_lost', object: op.object, field: op.field === '*' ? null : op.field, detail: `op:${op.op}` });
    if (op.op === 'sort') lostOther.push({ op: 'remove_sort', object: op.object, field: op.field });
    else if ((AGGREGATE_FUNCTIONS as readonly string[]).includes(op.op)) lostOther.push({ op: 'remove_aggregate', object: op.object, function: op.op });
    else {
      const key = `${op.object}\u0000${op.field}`;
      const entry = byFilter.get(key) ?? { object: op.object, field: op.field, ops: [] };
      entry.ops.push(op.op);
      byFilter.set(key, entry);
    }
  }
  drift.push(...lostDrift);
  const lostChanges: ManifestChange[] = [
    ...[...byFilter.values()].map((f): ManifestChange => ({ op: 'remove_filter', object: f.object, field: f.field, ops: f.ops })),
    ...lostOther,
  ];

  const proposals: ProposalPlan[] = [];
  if (removed.length > 0) proposals.push({ changeKind: 'object_removed', changes: [], drift: removed, halt: true, auto: false });
  if (meaning.length > 0) proposals.push({ changeKind: 'semantic', changes: [], drift: meaning, halt: true, auto: false });
  if (incompatible.length > 0) proposals.push({ changeKind: 'type_changed', changes: [], drift: incompatible, halt: true, auto: false });
  if (renames.length > 0) proposals.push({ changeKind: 'rename', changes: renames.map((r) => r.change), drift: renames.map((r) => r.drift), halt: false, auto: true });
  if (lostChanges.length > 0) proposals.push({ changeKind: 'pushdown_lost', changes: lostChanges, drift: lostDrift, halt: false, auto: true });
  if (widenings.length > 0) proposals.push({ changeKind: 'type_changed', changes: widenings.map((w) => w.change), drift: widenings.map((w) => w.drift), halt: false, auto: false });
  if (additions.length > 0) proposals.push({ changeKind: 'new_field', changes: additions.map((a) => a.change), drift: additions.map((a) => a.drift), halt: false, auto: false });
  return { drift, proposals };
}

/**
 * The repaired manifest document: the changes applied to a copy, at a new version, without
 * the conformance block of the version repaired (a run on that version says nothing of this one).
 */
export function repairedDocument(document: Record<string, unknown>, changes: readonly ManifestChange[], version: string): Record<string, unknown> {
  const doc = structuredClone(document) as {
    identity: { version: string }; conformance?: unknown;
    objects: {
      name: string;
      fields: { name: string; type: string; path?: string; nullable?: boolean; provenance?: string }[];
      pushdown?: {
        filters?: { field: string; ops: string[] }[];
        sort?: { field: string }[];
        aggregates?: { functions: string[]; groupBy?: boolean };
      };
    }[];
  };
  doc.identity.version = version;
  delete doc.conformance;
  const objectOf = (name: string) => {
    const o = doc.objects.find((x) => x.name === name);
    if (o === undefined) throw new TypeError(`no object ${name}`);
    return o;
  };
  for (const change of changes) {
    const object = objectOf(change.object);
    switch (change.op) {
      case 'rename_field': {
        const field = object.fields.find((f) => f.name === change.field)!;
        field.path = change.toPath;
        break;
      }
      case 'widen_type': {
        const field = object.fields.find((f) => f.name === change.field)!;
        field.type = change.to;
        break;
      }
      case 'add_field':
        object.fields.push({ name: change.field, type: change.type, path: change.path, nullable: true, provenance: 'observed' });
        break;
      case 'remove_filter': {
        const filters = object.pushdown?.filters ?? [];
        for (const f of filters) if (f.field === change.field) f.ops = f.ops.filter((op) => !change.ops.includes(op));
        if (object.pushdown !== undefined) object.pushdown.filters = filters.filter((f) => f.ops.length > 0);
        break;
      }
      case 'remove_sort':
        if (object.pushdown?.sort !== undefined) object.pushdown.sort = object.pushdown.sort.filter((s) => s.field !== change.field);
        break;
      case 'remove_aggregate': {
        const aggregates = object.pushdown?.aggregates;
        if (aggregates !== undefined) {
          aggregates.functions = aggregates.functions.filter((fn) => fn !== change.function);
          if (aggregates.functions.length === 0) delete object.pushdown!.aggregates;
        }
        break;
      }
    }
  }
  return doc as unknown as Record<string, unknown>;
}

/** The next patch version not yet taken by the connector. */
export function nextVersion(from: string, taken: ReadonlySet<string>): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(from);
  const [major, minor, patch] = match === null ? [1, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let p = patch + 1; ; p++) {
    const v = `${major}.${minor}.${p}`;
    if (!taken.has(v)) return v;
  }
}
