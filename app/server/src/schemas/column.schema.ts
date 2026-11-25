// The Zod form of each Postgres column type, with the rules a single-column check can
// state. The generated table schemas (src/schemas/<schema>/<name>.schema.ts) are built
// from these, so a value they accept is one Postgres accepts for that column, as far as
// one column can say. Keys, foreign keys, row-level security and checks across columns
// stay with the database: a value this accepts can still be refused there.
//
// Values have the shapes the models describe (infra/postgres.infra.ts type parsers):
// timestamps are ISO 8601 strings with an offset, dates 'YYYY-MM-DD', bigint and numeric
// decimal strings, bytea a Buffer.

import { z } from 'zod';
import type { JsonValue } from '../models/table.model.ts';
import { isUuid } from '../utils/id.util.ts';

export interface Range {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export interface TextRules {
  /** length(btrim(x)) > 0. */
  nonBlank?: boolean;
  /** length(btrim(x)) >= n, for other thresholds. */
  trimmedMinChars?: number;
  /** length(x), in characters as Postgres counts them (code points). */
  minChars?: number;
  maxChars?: number;
  /** octet_length(x): UTF-8 bytes. */
  minBytes?: number;
  maxBytes?: number;
  /** x ~ pattern. Translated with the s flag: in Postgres, . matches a newline. */
  pattern?: RegExp;
}

export interface ByteRules {
  minBytes?: number;
  maxBytes?: number;
}

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonRules {
  /** jsonb_typeof(x). */
  type?: JsonType;
  /** octet_length(x::text): the size of the jsonb text form. */
  maxBytes?: number;
}

export interface ArrayRules {
  /** cardinality(x). */
  minItems?: number;
  maxItems?: number;
}

export interface NumericRules extends Range {
  precision?: number;
  scale?: number;
}

// Postgres length() counts code points; a JavaScript string's length counts UTF-16 units.
const charCount = (value: string): number => {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
};

// btrim(x) with one argument removes spaces only, not all white space.
const btrim = (value: string): string => value.replace(/^ +| +$/g, '');

const describeRange = (r: Range): string => [
  r.gt !== undefined ? `above ${r.gt}` : '', r.gte !== undefined ? `at least ${r.gte}` : '',
  r.lt !== undefined ? `below ${r.lt}` : '', r.lte !== undefined ? `at most ${r.lte}` : '',
].filter(Boolean).join(' and ');

const inRange = (value: number, r: Range): boolean =>
  (r.gt === undefined || value > r.gt) && (r.gte === undefined || value >= r.gte)
  && (r.lt === undefined || value < r.lt) && (r.lte === undefined || value <= r.lte);

const hasRange = (r: Range): boolean => r.gt !== undefined || r.gte !== undefined || r.lt !== undefined || r.lte !== undefined;

function text(rules: TextRules = {}): z.ZodString {
  // Postgres text cannot hold a NUL character.
  let schema = z.string().regex(/^[^\u0000]*$/, 'must not contain a NUL character');
  if (rules.nonBlank) schema = schema.refine((v) => charCount(btrim(v)) > 0, 'must not be blank');
  const { trimmedMinChars, minChars, maxChars, minBytes, maxBytes, pattern } = rules;
  if (trimmedMinChars !== undefined) {
    schema = schema.refine((v) => charCount(btrim(v)) >= trimmedMinChars, `must be at least ${trimmedMinChars} characters`);
  }
  if (minChars !== undefined) schema = schema.refine((v) => charCount(v) >= minChars, `must be at least ${minChars} characters`);
  if (maxChars !== undefined) schema = schema.refine((v) => charCount(v) <= maxChars, `must be at most ${maxChars} characters`);
  if (minBytes !== undefined) {
    schema = schema.refine((v) => Buffer.byteLength(v, 'utf8') >= minBytes, `must be at least ${minBytes} bytes`);
  }
  if (maxBytes !== undefined) {
    schema = schema.refine((v) => Buffer.byteLength(v, 'utf8') <= maxBytes, `must be at most ${maxBytes} bytes`);
  }
  if (pattern !== undefined) schema = schema.regex(pattern);
  return schema;
}

function int(bits: 16 | 32, range: Range): z.ZodNumber {
  const limit = 2 ** (bits - 1);
  let schema = z.number().int().min(-limit).max(limit - 1);
  if (range.gt !== undefined) schema = schema.gt(range.gt);
  if (range.gte !== undefined) schema = schema.gte(range.gte);
  if (range.lt !== undefined) schema = schema.lt(range.lt);
  if (range.lte !== undefined) schema = schema.lte(range.lte);
  return schema;
}

const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

// Zod runs a refinement even after a format check failed, so each one guards its input.
const WHOLE = /^-?\d{1,19}$/;

function int8(range: Range = {}): z.ZodString {
  let schema = z.string().regex(WHOLE, 'must be a whole number')
    .refine((v) => !WHOLE.test(v) || (BigInt(v) >= INT8_MIN && BigInt(v) <= INT8_MAX), 'must fit in 64 bits');
  if (hasRange(range)) schema = schema.refine((v) => !WHOLE.test(v) || inRange(Number(v), range), `must be ${describeRange(range)}`);
  return schema;
}

// Postgres rounds extra decimal places and refuses only digits before the point beyond
// precision - scale, so that is all this checks.
const DECIMAL = /^-?\d+(\.\d+)?$/;
const wholeDigits = (v: string): number => v.replace(/^-/, '').split('.')[0]!.replace(/^0+/, '').length;

function numeric(rules: NumericRules = {}): z.ZodString {
  let schema = z.string().regex(DECIMAL, 'must be a decimal number');
  const { precision, scale = 0 } = rules;
  if (precision !== undefined) {
    const whole = precision - scale;
    schema = schema.refine((v) => !DECIMAL.test(v) || wholeDigits(v) <= whole,
      `must have at most ${whole} digits before the decimal point`);
  }
  if (hasRange(rules)) schema = schema.refine((v) => !DECIMAL.test(v) || inRange(Number(v), rules), `must be ${describeRange(rules)}`);
  return schema;
}

function float(range: Range = {}): z.ZodNumber {
  let schema = z.number();
  if (range.gt !== undefined) schema = schema.gt(range.gt);
  if (range.gte !== undefined) schema = schema.gte(range.gte);
  if (range.lt !== undefined) schema = schema.lt(range.lt);
  if (range.lte !== undefined) schema = schema.lte(range.lte);
  return schema;
}

function bytes(rules: ByteRules = {}): z.ZodType<Buffer> {
  let schema: z.ZodType<Buffer> = z.instanceof(Buffer);
  const { minBytes, maxBytes } = rules;
  if (minBytes !== undefined && minBytes === maxBytes) {
    return schema.refine((v) => v.length === minBytes, `must be exactly ${minBytes} bytes`);
  }
  if (minBytes !== undefined) schema = schema.refine((v) => v.length >= minBytes, `must be at least ${minBytes} bytes`);
  if (maxBytes !== undefined) schema = schema.refine((v) => v.length <= maxBytes, `must be at most ${maxBytes} bytes`);
  return schema;
}

const jsonTypeOf = (value: JsonValue): JsonType =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : (typeof value as 'object' | 'string' | 'number' | 'boolean');

// A number as jsonb prints it: numeric in plain decimal, never an exponent (1e21 prints
// as 1 followed by 21 zeros).
function jsonbNumber(n: number): string {
  const text = JSON.stringify(n);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text;
  const digits = m[2]! + (m[3] ?? '');
  const point = 1 + Number(m[4]);
  if (point >= digits.length) return `${m[1]}${digits}${'0'.repeat(point - digits.length)}`;
  if (point <= 0) return `${m[1]}0.${'0'.repeat(-point)}${digits}`;
  return `${m[1]}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// The byte length of a value in jsonb's text form, which octet_length(x::text) measures:
// jsonb prints ", " between items and ": " after keys, and drops duplicate keys.
export function jsonbTextBytes(value: JsonValue): number {
  if (typeof value === 'number') return jsonbNumber(value).length;
  if (value === null || typeof value !== 'object') return Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (Array.isArray(value)) {
    return 2 + value.reduce<number>((sum, item, i) => sum + jsonbTextBytes(item) + (i > 0 ? 2 : 0), 0);
  }
  const entries = Object.entries(value);
  return 2 + entries.reduce<number>((sum, [key, item], i) =>
    sum + Buffer.byteLength(JSON.stringify(key), 'utf8') + 2 + jsonbTextBytes(item) + (i > 0 ? 2 : 0), 0);
}

const jsonValue: z.ZodType<JsonValue> = z.json();

function json(rules: JsonRules = {}): z.ZodType<JsonValue> {
  let schema = jsonValue;
  const { type, maxBytes } = rules;
  if (type !== undefined) schema = schema.refine((v) => jsonTypeOf(v) === type, `must be a JSON ${type}`);
  if (maxBytes !== undefined) schema = schema.refine((v) => jsonbTextBytes(v) <= maxBytes, `must be at most ${maxBytes} bytes`);
  return schema;
}

function array<T extends z.ZodType>(element: T, rules: ArrayRules = {}): z.ZodArray<T> {
  let schema = z.array(element);
  if (rules.minItems !== undefined) schema = schema.min(rules.minItems);
  if (rules.maxItems !== undefined) schema = schema.max(rules.maxItems);
  return schema;
}

// pgvector's text form, '[0.1,0.2,...]', with its declared dimensions.
function vector(dimensions?: number): z.ZodString {
  const NUMBER = '-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  let schema = z.string().regex(new RegExp(`^\\[\\s*${NUMBER}(?:\\s*,\\s*${NUMBER})*\\s*\\]$`), 'must be a vector');
  if (dimensions !== undefined) {
    schema = schema.refine((v) => v.split(',').length === dimensions, `must have ${dimensions} dimensions`);
  }
  return schema;
}

export const column = {
  uuid: (): z.ZodString => z.string().refine(isUuid, 'must be a UUID in lowercase'),
  text,
  int2: (range: Range = {}): z.ZodNumber => int(16, range),
  int4: (range: Range = {}): z.ZodNumber => int(32, range),
  int8,
  numeric,
  float,
  bool: (): z.ZodBoolean => z.boolean(),
  date: () => z.iso.date(),
  timestamptz: () => z.iso.datetime({ offset: true }),
  /** Postgres interval text, as the models carry it. */
  interval: (): z.ZodString => text({ nonBlank: true }),
  /** ltree labels: letters, digits, underscore and hyphen, separated by dots. */
  ltree: (): z.ZodString => z.string().regex(/^(?:[A-Za-z0-9_-]{1,1000}(?:\.[A-Za-z0-9_-]{1,1000})*)?$/, 'must be a label path'),
  /** A network in CIDR notation, as Postgres writes it: an IPv4 or IPv6 address and a prefix length. */
  cidr: (): z.ZodString => z.string().regex(/^(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|[0-9a-f:]+(?::\d{1,3}(?:\.\d{1,3}){3})?\/\d{1,3})$/, 'must be a network in CIDR notation'),
  bytes,
  json,
  array,
  vector,
};
