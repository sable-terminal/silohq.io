/**
 * What every detector needs, in one place.
 *
 * THESE ARE THE DECISIONS THAT MUST BE THE SAME ACROSS ALL TEN. Whether a blank
 * string counts as absent, whether "12.5" is a number, how a dotted path is
 * read — a detector answering any of those differently from its neighbours
 * produces findings that cannot be compared with theirs, and §5's ranking layer
 * has to compare them.
 */

export type Row = Record<string, unknown>;

/** Read a field by dotted path. */
export function at(row: Row, path: string): unknown {
  return path.split('.').reduce<unknown>((value, part) => {
    if (value === null || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[part];
  }, row);
}

/**
 * ABSENT MEANS ABSENT, AND AN EMPTY STRING IS ABSENT.
 *
 * A system that writes `''` where it has nothing is saying the same thing as
 * one that writes null, and treating them differently makes the absence
 * detector's answer depend on which vendor wrote the row. Zero is NOT absent —
 * a balance of nought is a fact somebody recorded.
 */
export function absent(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Only a number can be compared with a number. */
export function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The key two rows are the same entity by.
 *
 * NORMALISED ONLY BY TRIMMING AND CASE. §2.6 — that much is typography rather
 * than identity: a trailing space is not a different invoice. Anything beyond
 * it is a judgement about what the customer means, which is an unresolved pair
 * and a person's decision, never a similarity score.
 *
 * NULL WHERE ANY PART IS MISSING. A partial key is not a key; matching on it
 * would merge every row that happens to be missing the same field.
 */
export function keyOf(row: Row, fields: string[]): string | null {
  const parts: string[] = [];

  for (const field of fields) {
    const value = at(row, field);
    if (absent(value)) return null;
    parts.push(String(value).trim().toLowerCase());
  }

  return parts.join(' ');
}

/**
 * §3.2 — deviation, normalised so findings can be ranked against each other.
 *
 * AGAINST THE LARGER OF THE TWO, because dividing by either side alone makes
 * the same gap look bigger or smaller depending which was asked first.
 */
export function deviationOf(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? 0 : Math.abs(a - b) / scale;
}

/**
 * What every detector emits.
 *
 * ONE SHAPE FOR ALL TEN, because §5's ranking layer has to order them against
 * each other and cannot do that across ten shapes. It lives here rather than in
 * `federated.ts` because history detectors emit it too, and a type owned by one
 * of three emitters is a type the other two import for no reason.
 */
export type Detected = {
  entityRef: string;
  measure: string;
  observed: number;
  expected: number;
  deviation: number;
  /** Contributing rows, by identifier. Never by contents. */
  evidence: string[];
  /**
   * When the thing happened, for the detectors that read a timestamp field.
   *
   * NOT EVERY FINDING HAS ONE, and that is not a gap to be filled. An outlier on
   * a total is a fact about a number, not about a moment; a duplicate exists
   * rather than occurs. §4's temporal ordering says `unknown` where this is
   * absent, which is the honest answer rather than a missing feature.
   */
  occurredAt?: string;
};

export type Outcome = { findings: Detected[]; populationN: number };

/**
 * A date field's value, as an instant, or null where it is not one.
 *
 * A DATE-SHAPED STRING, NOT WHATEVER `Date.parse` WILL SWALLOW. `Date.parse('3')`
 * returns a real instant in most engines, and a sequence step holding `"3"` was
 * producing a confident `occurredAt` in March 2001 — which §4 then used to order
 * one condition before another. A parser this lax turns any integer column into
 * a timestamp.
 *
 * The guard is the same one the client's archetype selection uses, for the same
 * reason: a bare number in a string is not a date, and an ISO-ish one is.
 */
export function instant(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!/^\d{4}-\d{2}/.test(value.trim())) return null;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The middle value of an already-sorted list.
 *
 * MEDIAN AND MAD RATHER THAN MEAN AND STANDARD DEVIATION, everywhere in this
 * subsystem. A single extreme value inflates the standard deviation enough to
 * bring itself back inside the band — the larger the outlier, the better it
 * hides — and the same trap catches a slow instance dragging up the "normal"
 * duration it is being compared against.
 */
export function middleOf(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Median absolute deviation, on the same scale as a standard deviation. */
export function spreadOf(values: number[]): { median: number; mad: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const median = middleOf(sorted);
  const mad = middleOf([...sorted.map((v) => Math.abs(v - median))].sort((a, b) => a - b));
  return { median, mad };
}

/** 0.6745 puts the MAD on the same scale as a standard deviation. */
export function modifiedZ(value: number, median: number, mad: number): number {
  return mad === 0 ? 0 : (0.6745 * Math.abs(value - median)) / mad;
}

/**
 * Is this value outside what the population normally does?
 *
 * ── The case that was answered four different ways ─────────────────────────
 *
 * A MAD of zero means the population is PERFECTLY CONSISTENT, which is the
 * clearest possible evidence that one value standing apart is remarkable — and
 * it is also the case where no z-score can be computed, because there is no
 * spread to divide by.
 *
 * Four detectors met that case and three invented their own answer: timing used
 * three times the median, recurrence used a floor, drift used a relative change,
 * and outlier gave up and reported nothing. So a hundred invoices at exactly
 * £100 and one at £4,000 produced a finding from one detector, silence from
 * another, and the difference was not a decision anybody made.
 *
 * THE FALLBACK IS A MULTIPLE OF THE MEDIAN because it is the only thing left to
 * compare against when the spread is gone, and three is high enough that a
 * perfectly flat population has to be genuinely departed from.
 */
export function outlying(
  value: number,
  spread: { median: number; mad: number },
  threshold: number,
  options: { multipleWhenFlat?: number } = {},
): boolean {
  if (spread.mad > 0) return modifiedZ(value, spread.median, spread.mad) > threshold;

  const multiple = options.multipleWhenFlat ?? 3;
  /* A median of zero has no multiple: everything is infinitely far from it, and
     "this column is not always nought" is nobody's finding. */
  return spread.median > 0 && Math.abs(value) >= spread.median * multiple;
}

/**
 * Compare two strings the same way on every machine.
 *
 * NOT `localeCompare`, WHOSE RESULT DEPENDS ON THE RUNTIME'S ICU DATA. Two
 * servers running the same build can order the same findings differently, which
 * makes "deterministic" a claim that holds only on the machine it was checked
 * on.
 */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * An entity reference, bounded to what the column will accept.
 *
 * `findings.entity_ref` is `CHECK (length(trim(entity_ref)) BETWEEN 1 AND 512)`,
 * and a detector is not always handed a short identifier: a concentration group
 * is whatever field the customer said to group by, and a composite key is
 * several fields joined. One long value does not produce one bad finding — the
 * INSERT violates the constraint and takes down the entire detector run, every
 * run, until somebody changes the data.
 *
 * TRUNCATED WITH A MARK, NOT SILENTLY. A reference that was cut is one somebody
 * may fail to find in the source, and it should be obvious that is why.
 */
export function refOf(value: unknown): string {
  const text = String(value ?? '').trim();
  return text.length <= 512 ? text : `${text.slice(0, 509)}...`;
}
