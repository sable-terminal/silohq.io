import { numeric, type Merged } from './merge.ontology';

/**
 * §7 — exact figures over every record a question matched.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * A write-up was shown a summary of each field and the first sixty records.
 * For three companies that is the answer; for eight thousand invoices,
 * "revenue by month" was a model's impression of sixty of them. A figure a
 * person will act on has to be computed, over all of it, by something that
 * cannot round, skip or imagine.
 *
 * So the plan says what to work out — a breakdown by a field, a trend over
 * time, two fields against each other — and it is worked out here, over every
 * matched entity after resolution, where a record two systems hold is one
 * record and counted once.
 *
 * ── AND IT SAYS WHAT IT COULD NOT INCLUDE ──────────────────────────────────
 *
 * A record whose group is disputed between systems belongs to no group that
 * anybody can name, and one whose measure is disputed has no figure to add.
 * Neither is dropped silently: each table counts them (`left`), because a
 * breakdown short by ninety disputed invoices looks exactly like one that is
 * not.
 *
 * ARITHMETIC OVER WHAT IT IS HANDED. Nothing here reads a system.
 */

export type Measure = {
  operation: 'count' | 'sum' | 'average' | 'minimum' | 'maximum';
  /** The number field measured. Absent for a count of records. */
  field?: string;
};

export type AnalysisSpec =
  /** One row per value of a field. `top` keeps the largest (or, ascending, the smallest) groups. */
  | { kind: 'breakdown'; by: string; measure: Measure; top?: number; order?: 'asc' | 'desc' }
  /** One row per period of a date field, in order. */
  | { kind: 'trend'; time: string; every: 'day' | 'month' | 'quarter' | 'year'; measure: Measure }
  /** One row per pair of values of two fields. */
  | { kind: 'crosstab'; by: [string, string]; measure: Measure };

export type AnalysisTable = {
  kind: AnalysisSpec['kind'];
  /** The field or fields the rows are keyed by. */
  by: string[];
  measure: Measure;
  /** For a trend, the period each row covers. */
  every?: 'day' | 'month' | 'quarter' | 'year';
  rows: Array<{ key: string[]; value: number | null; records: number }>;
  /** Records the table could not place or measure, by why. */
  left: {
    /** The grouping field is disputed between systems, so the record belongs to no nameable group. */
    disputed: number;
    /** The measured field is disputed or not a number on the record, so it added nothing to its group's figure. */
    unmeasured: number;
  };
  /** Groups beyond `top`, and the records in them — said, so a top five is never read as the whole. */
  beyond?: { groups: number; records: number };
};

/* Past this many groups a table is a list of records, and the answer already has those. */
const GROUPS_MOST = 500;
const NONE = '(none)';

const fieldOf = (entity: { fields: readonly Merged[] }, fieldPath: string) => entity.fields.find((one) => one.fieldPath === fieldPath);

/** A group's name for a value: text as written, a number or boolean as text, nothing as "(none)". */
function keyOf(field: Merged | undefined): string | null {
  if (!field || field.basis === 'disputed') return field ? null : NONE;
  const value = field.value;
  if (value === null || value === undefined || value === '') return NONE;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim() || NONE;
  return NONE;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** The period a date falls in, as sortable text: `2026`, `2026-Q1`, `2026-03`, `2026-03-18`. */
function periodOf(field: Merged | undefined, every: 'day' | 'month' | 'quarter' | 'year'): string | null {
  if (!field || field.basis === 'disputed') return field ? null : NONE;
  const match = typeof field.value === 'string' ? ISO_DATE.exec(field.value) : null;
  if (!match) return NONE;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  if (every === 'year') return year;
  if (every === 'quarter') return `${year}-Q${Math.ceil(Number(month) / 3)}`;
  if (every === 'month') return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

type Group = { key: string[]; records: number; sum: number; counted: number; minimum: number | null; maximum: number | null };

function figureOf(group: Group, measure: Measure): number | null {
  if (measure.operation === 'count') return group.records;
  if (group.counted === 0) return null;
  if (measure.operation === 'sum') return group.sum;
  if (measure.operation === 'average') return group.sum / group.counted;
  return measure.operation === 'minimum' ? group.minimum : group.maximum;
}

export function analyse(
  entities: ReadonlyArray<{ fields: readonly Merged[] }>,
  specs: readonly AnalysisSpec[],
): AnalysisTable[] {
  return specs.map((spec) => {
    const groups = new Map<string, Group>();
    const left = { disputed: 0, unmeasured: 0 };

    for (const entity of entities) {
      const key =
        spec.kind === 'breakdown'
          ? [keyOf(fieldOf(entity, spec.by))]
          : spec.kind === 'trend'
            ? [periodOf(fieldOf(entity, spec.time), spec.every)]
            : spec.by.map((fieldPath) => keyOf(fieldOf(entity, fieldPath)));

      if (key.some((part) => part === null)) {
        left.disputed += 1;
        continue;
      }

      const id = key.join('\u0000');
      const group = groups.get(id) ?? { key: key as string[], records: 0, sum: 0, counted: 0, minimum: null, maximum: null };
      group.records += 1;

      if (spec.measure.field !== undefined) {
        const measured = fieldOf(entity, spec.measure.field);
        const held = measured && measured.basis !== 'disputed' ? measured.value : null;
        /* READ AS A TOTAL READS IT: a decimal a database returned as text is a number, and `open` is not nought. */
        const value = numeric(held);
        if (value !== null) {
          group.sum += value;
          group.counted += 1;
          group.minimum = group.minimum === null ? value : Math.min(group.minimum, value);
          group.maximum = group.maximum === null ? value : Math.max(group.maximum, value);
        } else if (spec.measure.operation !== 'count' && ((held !== null && held !== undefined && held !== '') || measured?.basis === 'disputed')) {
          left.unmeasured += 1;
        }
      }

      groups.set(id, group);
    }

    let rows = [...groups.values()].map((group) => ({ key: group.key, value: figureOf(group, spec.measure), records: group.records }));

    /* A trend runs in time; everything else, biggest first unless asked otherwise. Names break ties, so two runs agree. */
    const byName = (a: { key: string[] }, b: { key: string[] }) => (a.key.join('\u0000') < b.key.join('\u0000') ? -1 : a.key.join('\u0000') > b.key.join('\u0000') ? 1 : 0);
    if (spec.kind === 'trend') rows.sort(byName);
    else {
      const ascending = spec.kind === 'breakdown' && spec.order === 'asc';
      rows.sort((a, b) => ((ascending ? 1 : -1) * ((a.value ?? -Infinity) - (b.value ?? -Infinity))) || byName(a, b));
    }

    const keep = Math.min(spec.kind === 'breakdown' && spec.top ? spec.top : GROUPS_MOST, GROUPS_MOST);
    const cut = rows.slice(keep);
    rows = rows.slice(0, keep);

    return {
      kind: spec.kind,
      by: spec.kind === 'breakdown' ? [spec.by] : spec.kind === 'trend' ? [spec.time] : [...spec.by],
      measure: spec.measure,
      ...(spec.kind === 'trend' ? { every: spec.every } : {}),
      rows,
      left,
      ...(cut.length > 0 ? { beyond: { groups: cut.length, records: cut.reduce((sum, row) => sum + row.records, 0) } } : {}),
    };
  });
}
