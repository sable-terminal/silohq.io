/**
 * What a response looks like, without what it says.
 *
 * ── THE MODEL SEES STRUCTURE, NEVER A RECORD ──────────────────────────────
 *
 * A build repairs a connector from what the real system answered, and the
 * repair is done by a model. What reaches it is this: keys, and the TYPE of
 * each value — `string(datetime)`, `integer`, `[ {…} ] (100 items)` — so it can
 * see where the records are, what a field is called and where paging lives,
 * and cannot see a name, an email or an amount.
 *
 * KEYS THAT ARE DATA ARE FOLDED. Some APIs key an object by record id —
 * `{ "18231": {…}, "18232": {…} }` — and those keys are values in disguise.
 * An object with many keys that all look like identifiers is shown as one
 * `<id>` entry and a count.
 */

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const ID_LIKE = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z]{0,4}[_-]?[0-9A-Za-z]{12,})$/;

const MAX_DEPTH = 5;
const MAX_KEYS = 60;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function scalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') {
    if (value === '') return 'string(empty)';
    if (ISO_DATETIME.test(value)) return 'string(datetime)';
    if (ISO_DATE.test(value)) return 'string(date)';
    if (NUMERIC.test(value)) return 'string(number)';
    return 'string';
  }
  return typeof value;
}

/** Several objects' keys merged: every key any of them has, typed by the first value that is not null. */
function merged(items: Json[]): Json {
  const out: Json = {};
  for (const item of items.slice(0, 25)) {
    for (const [key, value] of Object.entries(item)) {
      if (!(key in out) || out[key] === null || out[key] === undefined) out[key] = value;
      else if (isObject(out[key]) && isObject(value)) out[key] = merged([out[key] as Json, value]);
    }
  }
  return out;
}

function describe(value: unknown, depth: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const objects = value.filter(isObject);
    const inner = objects.length === value.length ? describe(merged(objects), depth + 1) : scalar(value.find((v) => v !== null && v !== undefined));
    return `[${inner}] (${value.length} item${value.length === 1 ? '' : 's'})`;
  }
  if (!isObject(value)) return scalar(value);
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  if (depth >= MAX_DEPTH) return '{…}';
  if (keys.length > 8 && keys.every((k) => ID_LIKE.test(k))) {
    const values = keys.map((k) => value[k]);
    const inner = values.every(isObject) ? describe(merged(values as Json[]), depth + 1) : scalar(values[0]);
    return `{ <id>: ${inner} } (${keys.length} keys)`;
  }
  const shown = keys.slice(0, MAX_KEYS).map((k) => `${JSON.stringify(k)}: ${describe(value[k], depth + 1)}`);
  if (keys.length > MAX_KEYS) shown.push(`… ${keys.length - MAX_KEYS} more keys`);
  return `{ ${shown.join(', ')} }`;
}

/** The structure of a parsed response or a list of records, as one line of text a model can read. */
export function shapeOf(value: unknown): string {
  return describe(value, 0);
}
