/**
 * What an answer holds, field by field, over every record it matched.
 *
 * ── OVER THE POPULATION, NOT THE PAGE ─────────────────────────────────────
 *
 * An answer lists the first hundred records; the question may have matched
 * two thousand. Anything that describes the answer — a sentence, a chart —
 * that is worked out from the list describes an arbitrary hundred and says
 * nothing about it. So this is computed where the whole population exists, in
 * the concept query, before the list is cut.
 *
 * ── DETERMINISTIC, AND THE ONLY ARITHMETIC ────────────────────────────────
 *
 * Counts, sums, ranges and the most common values. Nothing here is estimated,
 * and it is the set of figures a written answer may use: a model reading an
 * answer is given these rather than asked to add anything up, and a figure in
 * what it writes that is not among them is marked as its own.
 *
 * DISPUTED IS NEITHER PRESENT NOR MISSING. Where systems disagree no value was
 * taken (§6), and counting either reading would be choosing one.
 */

export type FieldProfile = {
  fieldPath: string;
  kind: 'number' | 'date' | 'text' | 'boolean' | 'empty';
  /** Records with a decided, non-empty value. */
  present: number;
  /** Records holding nothing for this field. */
  missing: number;
  /** Records whose systems disagree, so no value was taken. */
  disputed: number;
  number?: { sum: number; minimum: number; maximum: number; average: number };
  /** ISO days, and how many records fall in each month (or year, over a long span). */
  date?: { earliest: string; latest: string; by: 'month' | 'year'; counts: Array<{ period: string; count: number }> };
  /**
   * How many different values there are, and the commonest.
   *
   * THE COMMONEST ONLY WHEN SOMETHING REPEATS. A column of email addresses has
   * as many values as records, and listing ten of them describes nothing.
   */
  values?: { distinct: number; top: Array<{ value: string; count: number }> };
};

type ProfiledEntity = { fields: ReadonlyArray<{ fieldPath: string; value?: unknown; basis: string }> };

/* The commonest values kept per field. Enough to draw a chart, short enough to read. */
const TOP = 12;
/* A value longer than this is cut: it is a label in a chart, not a record. */
const LABEL = 80;
/* Past this many months a monthly count is a wall of bars, so it counts by year. */
const MONTHS = 36;

const DAY = /^(\d{4})-(\d{2})-(\d{2})([T ]|$)/;

const isEmpty = (value: unknown) => value === null || value === undefined || value === '';

const label = (value: unknown): string => {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > LABEL ? `${text.slice(0, LABEL - 1)}…` : text;
};

/** A figure a person could check by hand: no float noise past six places. */
export const settled = (value: number) => Number(value.toFixed(6));

export function profileOf(entities: readonly ProfiledEntity[], fieldPaths: readonly string[]): FieldProfile[] {
  return fieldPaths.map((fieldPath) => {
    const values: unknown[] = [];
    let missing = 0;
    let disputed = 0;

    for (const entity of entities) {
      const field = entity.fields.find((one) => one.fieldPath === fieldPath);
      if (field?.basis === 'disputed') disputed += 1;
      else if (!field || isEmpty(field.value)) missing += 1;
      else values.push(field.value);
    }

    const base = { fieldPath, present: values.length, missing, disputed };
    if (values.length === 0) return { ...base, kind: 'empty' as const };

    if (values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      const numbers = values as number[];
      const sum = numbers.reduce((total, value) => total + value, 0);
      return {
        ...base,
        kind: 'number' as const,
        number: {
          sum: settled(sum),
          minimum: Math.min(...numbers),
          maximum: Math.max(...numbers),
          average: Number((sum / numbers.length).toFixed(2)),
        },
      };
    }

    if (values.every((value) => (value instanceof Date ? !Number.isNaN(value.getTime()) : typeof value === 'string' && DAY.test(value)))) {
      const days = values.map((value) => (value instanceof Date ? value.toISOString() : (value as string)).slice(0, 10)).sort();
      const months = new Set(days.map((day) => day.slice(0, 7)));
      const by = months.size > MONTHS ? ('year' as const) : ('month' as const);
      const counts = new Map<string, number>();
      for (const day of days) {
        const period = by === 'year' ? day.slice(0, 4) : day.slice(0, 7);
        counts.set(period, (counts.get(period) ?? 0) + 1);
      }
      return {
        ...base,
        kind: 'date' as const,
        date: {
          earliest: days[0]!,
          latest: days.at(-1)!,
          by,
          counts: [...counts].map(([period, count]) => ({ period, count })),
        },
      };
    }

    const kind = values.every((value) => typeof value === 'boolean') ? ('boolean' as const) : ('text' as const);
    const counts = new Map<string, number>();
    for (const value of values) counts.set(label(value), (counts.get(label(value)) ?? 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const repeats = ranked.length > 0 && ranked[0]![1] > 1;

    return {
      ...base,
      kind,
      values: {
        distinct: counts.size,
        top: repeats || kind === 'boolean' ? ranked.slice(0, TOP).map(([value, count]) => ({ value, count })) : [],
      },
    };
  });
}
