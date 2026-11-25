import {
  absent,
  at,
  compare,
  deviationOf,
  keyOf,
  middleOf,
  numeric,
  outlying,
  refOf,
  spreadOf,
  type Row,
} from './shared.detector';

/**
 * §3 — the six remaining detectors that run without a baseline.
 *
 * EACH COMPUTES A FACT, NEVER A JUDGEMENT. "This field is empty in 94 of 100
 * records" is a fact. "This field is badly maintained" is a judgement, and it
 * belongs to §5's ranking layer, which reads findings and may reorder them but
 * may not invent one.
 *
 * FEDERATED MEANS NO HISTORY. Every one of these answers from a single pass
 * over rows fetched now. The three that need a baseline over time — timing
 * deviation, drift, recurrence — are §3.1's storage split and are not here,
 * because a federated query has no yesterday to compare against.
 *
 * THE POPULATION IS ALWAYS RETURNED. §4.1 says sample size is stated always,
 * and a detector that reports a rate without its denominator has produced an
 * assertion rather than a finding.
 */

/* The emitted shape and the statistics every detector shares now live in
   `shared.ts`, because history detectors emit them too. */
export type { Detected, Outcome } from './shared.detector';
import type { Detected, Outcome } from './shared.detector';

const NOTHING: Outcome = { findings: [], populationN: 0 };

/* ── Absence ─────────────────────────────────────────────────────────────── */

/**
 * A field empty far more often than its population norm.
 *
 * THE NORM IS THE OTHER FIELDS ON THE SAME OBJECT, which is the only baseline a
 * federated pass has. A field 94% empty means nothing on its own — an optional
 * note is supposed to be empty — and means a great deal when every other field
 * beside it is 99% filled. That contrast is the finding; the raw rate is not.
 *
 * THE MEDIAN, NOT THE MEAN. Three mostly-empty fields would drag a mean down
 * far enough to make themselves look normal, which is precisely the case this
 * detector exists to catch.
 */
export function detectAbsence(
  rows: Row[],
  fields: string[],
  options: { tolerance: number },
): Outcome {
  if (rows.length === 0 || fields.length < 2) return NOTHING;

  const emptiness = new Map<string, number>();
  for (const field of fields) {
    const empty = rows.filter((row) => absent(at(row, field))).length;
    emptiness.set(field, empty / rows.length);
  }

  const rates = [...emptiness.values()].sort((a, b) => a - b);
  const middle = Math.floor(rates.length / 2);
  const norm =
    rates.length % 2 === 0 ? ((rates[middle - 1]! + rates[middle]!) / 2) : rates[middle]!;

  const findings: Detected[] = [];
  for (const [field, rate] of emptiness) {
    if (rate <= norm) continue;

    const deviation = rate - norm;
    if (deviation <= options.tolerance) continue;

    findings.push({
      entityRef: field,
      measure: 'emptiness',
      observed: rate,
      expected: norm,
      deviation,
      evidence: [],
    });
  }

  return { findings, populationN: rows.length };
}

/* ── Duplication ─────────────────────────────────────────────────────────── */

/**
 * Multiple records where identity should be unique.
 *
 * IDENTITY IS DECLARED, NOT GUESSED. The caller names the fields that are
 * supposed to identify a record — the concept's match keys — because "these two
 * rows look similar" is not duplication, it is a similarity score, and §2.6
 * keeps those out of the data path entirely.
 *
 * A ROW WITH NO KEY IS NOT A DUPLICATE OF ANOTHER ROW WITH NO KEY. Two records
 * both missing their invoice number are two records missing their invoice
 * number; grouping them together would report the absence detector's finding
 * under the wrong name.
 */
export function detectDuplication(
  rows: Row[],
  identityFields: string[],
  identifierField: string,
): Outcome {
  if (rows.length === 0 || identityFields.length === 0) return NOTHING;

  const groups = new Map<string, string[]>();
  let keyed = 0;

  for (const row of rows) {
    const key = keyOf(row, identityFields);
    if (key === null) continue;

    keyed += 1;
    const ref = String(at(row, identifierField) ?? '');
    groups.set(key, [...(groups.get(key) ?? []), ref]);
  }

  const findings: Detected[] = [];
  for (const [key, refs] of groups) {
    if (refs.length < 2) continue;

    /*
     * §3.2 — THE ENTITY REFERENCE IS AN IDENTIFIER, LIKE EVERY OTHER DETECTOR'S.
     * This used to emit the match key: the identity fields' values, concatenated
     * and case-folded. Two consequences, and the second is the worse one.
     *
     * It is a value read out of records, where the column is specified to hold
     * a reference. And it meant a duplication finding and an outlier finding
     * about the SAME ROW carried different entity refs — so §4 could not relate
     * them and §5 could not group them, which is most of what those layers are
     * for.
     *
     * Sorted, so the row this is filed under does not depend on fetch order;
     * `findings_unique` keys on it, and a re-run must find the same row.
     */
    const ordered = [...refs].sort(compare);

    findings.push({
      entityRef: ordered[0]!,
      measure: identityFields.join(' + '),
      observed: refs.length,
      /* One is what uniqueness means, so it is what was expected. */
      expected: 1,
      deviation: deviationOf(refs.length, 1),
      /* The key is what they collided on, which is the thing worth showing. */
      evidence: [key, ...ordered],
    });
  }

  return { findings, populationN: keyed };
}

/* ── Referential break ───────────────────────────────────────────────────── */

/**
 * A link pointing at nothing.
 *
 * ONLY WHERE BOTH SIDES WERE ACTUALLY READ. A reference into a system this
 * query did not reach is not broken — it is unchecked, and reporting it as
 * broken would turn a permission boundary or a timed-out source into a data
 * quality problem. The caller passes the target rows because passing them is
 * the proof they were fetched.
 *
 * AN ABSENT REFERENCE IS NOT A BROKEN ONE. A row with no supplier is the
 * absence detector's business; a row naming a supplier who does not exist is
 * this one's.
 */
export function detectReferentialBreak(
  rows: Row[],
  input: { referenceField: string; identifierField: string; targetRows: Row[]; targetKeyField: string },
): Outcome {
  if (rows.length === 0) return NOTHING;

  const targets = new Set(
    input.targetRows
      .map((row) => at(row, input.targetKeyField))
      .filter((value) => !absent(value))
      .map((value) => String(value).trim().toLowerCase()),
  );

  const findings: Detected[] = [];
  let checked = 0;

  for (const row of rows) {
    const reference = at(row, input.referenceField);
    if (absent(reference)) continue;

    checked += 1;
    if (targets.has(String(reference).trim().toLowerCase())) continue;

    findings.push({
      entityRef: refOf(at(row, input.identifierField)),
      measure: input.referenceField,
      /* One link, pointing nowhere. The figures are the count, not the value. */
      observed: 0,
      expected: 1,
      deviation: 1,
      evidence: [String(at(row, input.identifierField) ?? '')],
    });
  }

  return { findings, populationN: checked };
}

/* ── Sequence violation ──────────────────────────────────────────────────── */

/**
 * Step B occurred without step A.
 *
 * THE ORDER IS DECLARED. Nothing here infers that dispatch follows payment —
 * that is domain knowledge, and §1 says none ships with the product. The caller
 * states the sequence, having got it from the customer, and this checks it.
 *
 * ONLY EARLIER STEPS COUNT AS MISSING. An entity at step three with step four
 * unreached has not violated anything; one at step three with step two missing
 * has. The difference is the whole detector.
 */
export function detectSequenceViolation(
  rows: Row[],
  input: { identifierField: string; stepFields: string[] },
): Outcome {
  if (rows.length === 0 || input.stepFields.length < 2) return NOTHING;

  const findings: Detected[] = [];

  for (const row of rows) {
    const reached = input.stepFields.map((field) => !absent(at(row, field)));
    const furthest = reached.lastIndexOf(true);
    if (furthest <= 0) continue;

    const skipped = input.stepFields.filter((_, i) => i < furthest && !reached[i]);
    if (skipped.length === 0) continue;

    /*
     * THE STEP IT REACHED IS A TIME, WHERE THE FIELD HOLDS ONE. A sequence is
     * declared over fields that record when something happened, so the furthest
     * one reached is when this entity got into the state being reported — the
     * only detector here with a genuine event time, and §4.1's "where
     * timestamps permit" made real.
     */
    const reachedAt = at(row, input.stepFields[furthest]!);
    const occurredAt =
      typeof reachedAt === 'string' && !Number.isNaN(Date.parse(reachedAt))
        ? new Date(reachedAt).toISOString()
        : reachedAt instanceof Date
          ? reachedAt.toISOString()
          : undefined;

    findings.push({
      entityRef: refOf(at(row, input.identifierField)),
      measure: input.stepFields[furthest]!,
      observed: furthest + 1 - skipped.length,
      expected: furthest + 1,
      deviation: skipped.length / (furthest + 1),
      evidence: skipped,
      ...(occurredAt ? { occurredAt } : {}),
    });
  }

  return { findings, populationN: rows.length };
}

/* ── Outlier ─────────────────────────────────────────────────────────────── */

/**
 * A value outside the distribution for its population.
 *
 * MEDIAN AND MAD, NOT MEAN AND STANDARD DEVIATION. A single extreme value
 * inflates the standard deviation enough to bring itself back inside the band —
 * the larger the outlier, the better it hides. The median absolute deviation
 * does not move when one value runs away, which is the entire reason to prefer
 * it here.
 *
 * A POPULATION THAT DOES NOT VARY HAS NO OUTLIERS. Where the MAD is zero every
 * value is either the median or infinitely far from it, and reporting the
 * second is reporting that a constant column contains a number that is not the
 * constant — which is duplication's business, or nobody's.
 */
export function detectOutlier(
  rows: Row[],
  input: { identifierField: string; measure: string },
  options: { threshold: number },
): Outcome {
  const values: Array<{ ref: string; value: number }> = [];

  for (const row of rows) {
    const value = numeric(at(row, input.measure));
    if (value === null) continue;
    values.push({ ref: refOf(at(row, input.identifierField)), value });
  }

  if (values.length < 5) return { findings: [], populationN: values.length };

  const spread = spreadOf(values.map((v) => v.value));

  const findings: Detected[] = [];
  for (const { ref, value } of values) {
    /*
     * A FLAT POPULATION IS THE CLEAREST CASE, NOT THE ABSENT ONE. This used to
     * return nothing whenever the MAD was zero — so a hundred invoices at
     * exactly £100 and one at £4,000 reported silence, which is the single most
     * obvious outlier a population can contain. `outlying` is the one answer
     * all four detectors now give.
     */
    if (!outlying(value, spread, options.threshold)) continue;

    findings.push({
      entityRef: ref,
      measure: input.measure,
      observed: value,
      expected: spread.median,
      deviation: deviationOf(value, spread.median),
      evidence: [ref],
    });
  }

  return { findings, populationN: values.length };
}

/* ── Concentration ───────────────────────────────────────────────────────── */

/**
 * Disproportionate dependency on one node.
 *
 * DISPROPORTIONATE AGAINST AN EVEN SPREAD, which is the only baseline available
 * without knowing the domain. Forty per cent through one supplier is ordinary
 * where there are two suppliers and remarkable where there are fifty, and the
 * share alone cannot tell those apart.
 *
 * IT COUNTS ROWS, OR SUMS A MEASURE. Half the orders and half the spend are
 * different kinds of dependency and a customer will care about different ones
 * on different days, so both are reachable and the finding says which it is.
 */
export function detectConcentration(
  rows: Row[],
  input: { groupField: string; weightField?: string },
  options: { multiple: number },
): Outcome {
  const weights = new Map<string, number>();
  let total = 0;

  for (const row of rows) {
    const group = at(row, input.groupField);
    if (absent(group)) continue;

    const weight = input.weightField ? numeric(at(row, input.weightField)) : 1;
    if (weight === null || weight <= 0) continue;

    const key = String(group).trim();
    weights.set(key, (weights.get(key) ?? 0) + weight);
    total += weight;
  }

  if (weights.size < 2 || total === 0) return { findings: [], populationN: weights.size };

  /* What each node would hold if nothing were concentrated anywhere. */
  const even = 1 / weights.size;

  const findings: Detected[] = [];
  for (const [group, weight] of weights) {
    const share = weight / total;
    if (share < even * options.multiple) continue;

    findings.push({
      /*
       * THE GROUP IS THE ENTITY HERE, and its own value is the only name it
       * has — "this supplier holds 40% of the spend" is about the supplier, and
       * there is no separate identifier for a group. That puts whatever the
       * customer chose to group by into the reference column, which is the same
       * bargain every other detector makes with `identifierField`, except that
       * a group field is likelier to be long. `refOf` is what stops a long one
       * aborting the run.
       */
      entityRef: refOf(group),
      measure: input.weightField ?? 'count',
      observed: share,
      expected: even,
      deviation: share - even,
      evidence: [],
    });
  }

  return { findings, populationN: weights.size };
}

/* ── §3.4 Derived thresholds ─────────────────────────────────────────────── */

/**
 * §3.4 — DERIVED FROM THE POPULATION, NOT CONFIGURED.
 *
 * `deriveTolerance` in `disagreement.ts` makes the same argument at length: an
 * initial threshold comes from the question itself so a newly connected system
 * produces sensible findings on the first run, and the model's tuning persists
 * afterwards against the concept and detector. These are that first run's
 * numbers for the six detectors here.
 *
 * SMALL POPULATIONS NEED LOOSER THRESHOLDS, NOT TIGHTER ONES, which is the
 * opposite of the intuition. Over twelve records a field empty a third more
 * often than its neighbours is four records — well inside what chance produces.
 * Over twelve thousand, the same proportion is a fact about the system.
 */
export function deriveAbsenceTolerance(populationN: number): number {
  if (populationN <= 50) return 0.4;
  if (populationN <= 1000) return 0.25;
  return 0.15;
}

/**
 * Modified z-score, on the MAD scale.
 *
 * 3.5 IS THE PUBLISHED FIGURE and using it rather than a number of my own means
 * a finding can be explained by naming the method instead of defending a
 * constant. Below twenty values the median is itself unstable, so the bar goes
 * up rather than the detector pretending to a precision it does not have.
 */
export function deriveOutlierThreshold(populationN: number): number {
  return populationN < 20 ? 5 : 3.5;
}

/**
 * How many times an even share counts as disproportionate.
 *
 * IT HAS TO TIGHTEN AS THE POOL GROWS, and a fixed multiple does the opposite.
 * Among four suppliers an even share is 25% and three times that is most of the
 * business; among a hundred an even share is 1%, and three times it is 3% —
 * which is nothing, so a fixed multiple would flag a dozen ordinary suppliers.
 * The square root keeps the flagged share meaningful at both ends.
 */
export function deriveConcentrationMultiple(nodes: number): number {
  /*
   * IT MUST STAY BELOW THE NODE COUNT OR THE THRESHOLD IS UNREACHABLE. An even
   * share is `1 / nodes`, so a multiple of three asks for `3 / nodes` — which is
   * 150% of the business across two suppliers and 100% across three. Both are
   * impossible, so concentration reported nothing at exactly the sizes where
   * concentration is most acute: 99% through one of two suppliers was silent.
   *
   * Capping at nine tenths of the node count keeps the demanded share under one
   * at every size, and leaves the square root doing the work as the pool grows.
   */
  return Math.min(Math.max(3, Math.sqrt(nodes)), nodes * 0.9);
}
