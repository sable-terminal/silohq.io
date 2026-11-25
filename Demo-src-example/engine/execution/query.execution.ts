
/**
 * What the engine is asked to do, and what it did.
 *
 * ONE SHAPE FOR EVERY TRANSPORT. A question does not know whether the answer
 * comes from Postgres over ODBC or a REST endpoint behind OAuth — that is the
 * separation §3 draws, and it is what lets the layer above reason about
 * ontology concepts rather than about HTTP.
 */

export type Comparison = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'is_null';

export interface Filter {
  field: string;
  op: Comparison;
  value?: unknown;
}

export interface Query {
  object: string;
  filters: Filter[];
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
  /** Fields to return. Empty means all of them. */
  fields: string[];
  limit: number;
}

/**
 * What actually reached the source, as opposed to what was asked for.
 *
 * REPORTED, NOT ASSUMED. §6 declares pushdown per connector because every
 * system supports a different subset, and the caller has to know which half of
 * its question was answered by the source and which by us — the difference
 * decides whether the row count it is looking at is the whole truth or a page.
 */
export interface Pushdown {
  filters: Filter[];
  sort: boolean;
  limit: boolean;
  fields: boolean;
}

export interface Result {
  rows: Array<Record<string, unknown>>;
  /** What the source did for us. Everything else was done here, in memory. */
  pushedDown: Pushdown;
  /** How many the source actually sent, before anything was filtered locally. */
  fetched: number;
  durationMs: number;
}

/** The filters the source could not take, which have to be applied here. */
export function localFilters(query: Query, pushed: Pushdown): Filter[] {
  const done = new Set(pushed.filters);
  return query.filters.filter((f) => !done.has(f));
}

/**
 * Apply a filter in memory.
 *
 * ONLY FOR WHAT THE SOURCE COULD NOT DO. It exists because §6 says what cannot
 * be pushed down comes back and is bounded — not as a general query engine, and
 * deliberately not as one: anything clever here is work a source could have done
 * on an index.
 */
export function matches(row: Record<string, unknown>, filter: Filter): boolean {
  const value = row[filter.field];

  switch (filter.op) {
    case 'eq':
      return value === filter.value;
    case 'neq':
      return value !== filter.value;
    case 'is_null':
      return value === null || value === undefined;
    case 'in':
      return Array.isArray(filter.value) && filter.value.includes(value);
    case 'contains':
      return typeof value === 'string' && typeof filter.value === 'string'
        ? value.toLowerCase().includes(filter.value.toLowerCase())
        : false;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      /*
       * COMPARISON REFUSES RATHER THAN COERCES. JavaScript will happily order a
       * string against a number and produce an answer nobody meant; a filter
       * that quietly matches nothing is a wrong answer wearing the costume of an
       * empty result.
       */
      if (value === null || value === undefined || filter.value === null) return false;
      const a = value as number | string;
      const b = filter.value as number | string;
      if (typeof a !== typeof b) return false;

      /*
       * ── TWO DATES ARE COMPARED AS MOMENTS, NOT AS SPELLINGS ──────────────
       *
       * A date column holds `2026-01-01`. A period resolves to the instant
       * `2026-01-01T00:00:00.000Z`. As TEXT the first is shorter and therefore
       * SMALLER, so `>= from` excluded the very day that was asked for — and
       * `< until` let the following day in. Asked for today, a date-only column
       * returned TOMORROW'S rows and none of today's.
       *
       * It also disagreed with the source: SQL promotes a date to a timestamp
       * and compares them correctly, so the same question answered one way when
       * the filter was pushed down and another when it was applied here.
       */
      const left = instantOf(a);
      const right = instantOf(b);
      if (left !== null && right !== null) {
        if (filter.op === 'gt') return left > right;
        if (filter.op === 'gte') return left >= right;
        if (filter.op === 'lt') return left < right;
        return left <= right;
      }

      if (filter.op === 'gt') return a > b;
      if (filter.op === 'gte') return a >= b;
      if (filter.op === 'lt') return a < b;
      return a <= b;
    }
  }
}

/**
 * The moment an ISO date or timestamp names, or nothing.
 *
 * DELIBERATELY NARROW. Only the shapes ISO-8601 actually defines are read as
 * moments — `Date.parse` will accept all manner of prose and invent a date for
 * it, which is how a text field that happens to start with a number becomes a
 * timestamp nobody meant.
 */
const ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function instantOf(value: number | string): number | null {
  if (typeof value !== 'string' || !ISO.test(value)) return null;

  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/**
 * Whether a value can mean anything under that operator.
 *
 * NEITHER HALF OF A MISMATCH ANNOUNCES ITSELF. `in` with a bare string reaches
 * a SQL source as `= ANY($1)` against a non-array and either errors deep in a
 * driver or matches nothing; `eq` with an array matches nothing at all, which
 * comes back as a confident empty answer. Both are the model getting the shape
 * wrong, and both are cheaper to refuse here than to explain afterwards.
 */
export function valueFits(op: Comparison, value: unknown): string | null {
  if (op === 'is_null') {
    /*
     * IT TAKES NO VALUE, AND `null` IS HOW JSON SAYS THAT. Refusing an explicit
     * null made this path stricter than the two zod schemas, than `matches`,
     * and than the raw `/query` route — which all accept it and mean the same
     * thing. A rule that only one of four doors enforces is not a rule, it is
     * an inconsistency that surfaces as an unexplainable rejection.
     */
    return value === undefined || value === null ? null : 'is_null takes no value.';
  }

  if (value === undefined) return `${op} needs a value.`;

  /*
   * NULL IS NOT A VALUE TO COMPARE AGAINST, IT IS A QUESTION ABOUT ABSENCE.
   *
   * `matches` reads `eq` as `value === filter.value`, so locally a null filter
   * MATCHES the rows whose column is null. Pushed to SQL the same filter
   * becomes `col = NULL`, which is never true and matches NOTHING. The same
   * question answers two different ways depending on whether the source could
   * push it down, and neither answer says so.
   *
   * `is_null` is the operator that asks this, and it is already offered.
   */
  if (value === null) return `${op} cannot compare against nothing. Use is_null.`;

  if (op === 'in') {
    if (!Array.isArray(value)) return 'in needs a list of values.';
    if (value.length === 0) return 'in needs at least one value.';
    if (value.some((one) => one === null)) {
      return 'in cannot contain nothing. Use is_null for that.';
    }
    return value.every((one) => isScalar(one)) ? null : 'in needs a list of plain values.';
  }

  if (Array.isArray(value)) return `${op} takes one value, not a list.`;

  if (op === 'contains') {
    return typeof value === 'string' ? null : 'contains needs a piece of text.';
  }

  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    /* A string is still accepted: `numeric` columns arrive from some drivers as
       strings, and dates are compared as text. An object or a boolean cannot be
       ordered against anything. */
    return typeof value === 'number' || typeof value === 'string'
      ? null
      : `${op} needs a number or a date.`;
  }

  return isScalar(value) ? null : `${op} needs a plain value.`;
}

const isScalar = (value: unknown): boolean =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

/**
 * Sort rows here, for a source that could not. Nulls last whichever way, because
 * a missing value is absent rather than smaller than everything.
 */
export function sortLocally(rows: Array<Record<string, unknown>>, sort: Query['sort']): Array<Record<string, unknown>> {
  return [...rows].sort((left, right) => {
    for (const { field, direction } of sort) {
      const a = left[field];
      const b = right[field];
      if (a === b) continue;
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      const order = (a as number) < (b as number) ? -1 : 1;
      return direction === 'desc' ? -order : order;
    }
    return 0;
  });
}

/**
 * What Silo writes onto a row about the row — where a value was read from, how
 * certain the reading was — as opposed to what the source holds. Narrowing a
 * row to the fields asked for keeps these: a figure without its certainty is a
 * figure presented with more authority than it has.
 */
const ANNOTATIONS = ['_provenance', '_certainty', '_confidence', '_receivedAt'] as const;

export function pickFields(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = row[field];
  for (const note of ANNOTATIONS) if (note in row) out[note] = row[note];
  return out;
}
