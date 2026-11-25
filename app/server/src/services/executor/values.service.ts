// Values as the engine compares them: a source's field value typed by the ontology
// property it maps to, compared in that type, and shown under the reader's field policy.
//
// - Numbers compare as numbers, dates as calendar dates (YYYY-MM-DD), timestamps as
//   instants (a value with no offset is the mapping's source time zone, else UTC), text by
//   code point, booleans false before true.
// - Coded fields go through the mapping's declared value map.
// - Masked values keep at most the last four characters of text; redacted values are gone.
//   Neither is ever filtered, sorted, grouped or measured (the planner refuses that).

import type { z } from 'zod';
import type { FilterOp } from '../../contracts/connect/manifest.contract.ts';
import type { DataType, propertyMappingView } from '../../contracts/ontology/manifest.contract.ts';
import type { FilterValue, Scalar } from '../planner/decompose.service.ts';

type Mapping = z.infer<typeof propertyMappingView>;
export type Json = z.core.util.JSONType;

const OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;

/** The zone's wall time as an instant: the offset that zone had then. */
function wallToInstant(text: string, timeZone: string): number {
  const guess = Date.parse(`${text.replace(' ', 'T')}Z`);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(at / 1000) * 1000;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

/** A source value as the property's type. Unreadable values are empty, never guessed. */
export function typed(raw: unknown, type: DataType, mapping: Mapping): Json | null {
  if (raw === null || raw === undefined) return null;
  if (mapping.valueMap !== null) {
    const mapped = mapping.valueMap[String(raw)];
    if (mapped === undefined) return null;
    if (type === 'boolean') return mapped === 'true' ? true : mapped === 'false' ? false : null;
    return mapped;
  }
  switch (type) {
    case 'integer':
    case 'decimal': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n)) return null;
      return type === 'integer' && !Number.isInteger(n) ? null : n;
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : null;
    case 'date': {
      if (typeof raw !== 'string' || !DATE.test(raw)) return null;
      return raw.slice(0, 10);
    }
    case 'timestamp': {
      if (typeof raw !== 'string') return null;
      const instant = OFFSET.test(raw) ? Date.parse(raw)
        : mapping.sourceTimeZone !== null ? wallToInstant(raw, mapping.sourceTimeZone) : Date.parse(`${raw.replace(' ', 'T')}${DATE.test(raw) && raw.length === 10 ? 'T00:00:00' : ''}Z`);
      return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
    }
    case 'string':
    case 'enum':
      return typeof raw === 'object' ? null : String(raw);
    default:
      return raw as Json;
  }
}

/** Order within one type; empty values are handled by the caller (they sort last). */
export function compareTyped(a: Json, b: Json, type: DataType): number {
  if (type === 'timestamp') return Date.parse(a as string) - Date.parse(b as string);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A decided value against a filter. Empty values match only is_null. */
export function satisfies(value: Json | null, op: FilterOp, operand: FilterValue, type: DataType): boolean {
  if (op === 'is_null') return value === null;
  if (op === 'is_not_null') return value !== null;
  if (value === null) return false;
  const cmp = (o: Scalar) => compareTyped(value, o as Json, type);
  switch (op) {
    case 'eq': return cmp(operand as Scalar) === 0;
    case 'ne': return cmp(operand as Scalar) !== 0;
    case 'lt': return cmp(operand as Scalar) < 0;
    case 'lte': return cmp(operand as Scalar) <= 0;
    case 'gt': return cmp(operand as Scalar) > 0;
    case 'gte': return cmp(operand as Scalar) >= 0;
    case 'in': return (operand as Scalar[]).some((o) => cmp(o) === 0);
    case 'contains': return typeof value === 'string' && value.includes(String(operand));
    case 'starts_with': return typeof value === 'string' && value.startsWith(String(operand));
  }
}

/** Values two systems agree on are equal as JSON. */
export const sameValue = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A masked value: at most the last four characters of text; other types show nothing. */
export function masked(value: Json | null): Json | null {
  if (value === null) return null;
  const text = typeof value === 'string' ? value : null;
  if (text === null) return null;
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`;
}
