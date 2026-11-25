import {
  absent,
  at,
  deviationOf,
  instant,
  middleOf,
  modifiedZ,
  outlying,
  spreadOf,
  type Detected,
  type Outcome,
  type Row,
} from './shared.detector';

/**
 * §3 — the three detectors that need a baseline over time.
 *
 * THEY ARE NOT GATED ON STORAGE, AND THAT IS THE WHOLE POINT. They need
 * historical data; they do not need a Silo. `engine/history` resolves where the
 * history comes from — usually the source system, which already holds it — and
 * these functions take the rows they are given and do arithmetic on them. None
 * of them knows whether the rows arrived from an ERP, from a Silo, or from both
 * merged together, which is exactly why the gate was in the wrong place.
 *
 * ARITHMETIC, AND NOTHING ELSE. §3.3 — no model participates, the same rows
 * produce the same findings, and every finding can be explained by showing the
 * computation. The only difference from the other seven is the shape of the
 * input: these read a range rather than a snapshot.
 *
 * EVERY ONE OF THEM REPORTS `occurredAt`. These are the detectors with a
 * genuine event time — a duration ends somewhere, a rate changed in some
 * period, an exception recurred on some date — which is what makes §4.1's
 * temporal ordering real rather than theoretical.
 */

const NOTHING: Outcome = { findings: [], populationN: 0 };
const DAY = 24 * 60 * 60 * 1000;

/* ── Timing deviation ────────────────────────────────────────────────────── */

/**
 * An instance taking materially longer than the norm for its class.
 *
 * THE NORM COMES FROM FINISHED INSTANCES ONLY, and this is the subtle part. An
 * instance still running has a duration measured to now — it is truncated, not
 * short — so including open ones in the median drags the "normal" duration
 * downward, and the longer something has been stuck the more it lowers the bar
 * it is about to be measured against.
 *
 * OPEN INSTANCES ARE STILL TESTED, because a claim open 31 days against a norm
 * of 4 is the single most useful finding this detector produces, and waiting
 * for it to close before saying so is waiting for the damage to be done.
 *
 * ONLY LONGER COUNTS. "Materially longer" is the spec's phrase and it is the
 * right one: something finishing unusually fast is not a problem anybody wants
 * paging them, and reporting it doubles the list to no purpose.
 */
export function detectTimingDeviation(
  rows: Row[],
  input: {
    identifierField: string;
    startField: string;
    /** Absent on a row means it has not finished. */
    endField: string;
    /** Compare like with like, where the customer says what "like" is. */
    classField?: string;
  },
  options: { threshold: number; at?: number },
): Outcome {
  const now = options.at ?? Date.now();

  type Instance = {
    ref: string;
    klass: string;
    days: number;
    open: boolean;
    startedAt: number;
    endedAt: number;
  };
  const instances: Instance[] = [];

  for (const row of rows) {
    const started = instant(at(row, input.startField));
    if (started === null) continue;

    const finished = instant(at(row, input.endField));
    const endedAt = finished ?? now;

    /* A record that finished before it started is a data quality problem and
       not a duration; reporting it as fast would be nonsense. */
    if (endedAt < started) continue;

    instances.push({
      ref: String(at(row, input.identifierField) ?? ''),
      klass: input.classField ? String(at(row, input.classField) ?? '') : '',
      days: (endedAt - started) / DAY,
      open: finished === null,
      startedAt: started,
      endedAt,
    });
  }

  if (instances.length === 0) return NOTHING;

  const byClass = new Map<string, Instance[]>();
  for (const one of instances) {
    byClass.set(one.klass, [...(byClass.get(one.klass) ?? []), one]);
  }

  const findings: Detected[] = [];

  for (const [klass, members] of byClass) {
    const closed = members.filter((one) => !one.open);
    /* Five finished instances is the fewest a median means anything over. */
    if (closed.length < 5) continue;

    let spread = spreadOf(closed.map((one) => one.days));

    /*
     * ── A class that mostly closes the same day ───────────────────────────
     *
     * Where more than half of a class finishes in under a day, the median
     * duration is zero and so is the MAD — and this detector reported NOTHING,
     * for any instance, however long. A support queue where 60% close within
     * the hour is the ordinary shape of a support queue, and the ticket open
     * for thirty days is exactly the finding somebody wants.
     *
     * The comparison becomes the norm AMONG THE ONES THAT TOOK ANY TIME, which
     * is the only meaningful baseline left: "things like this usually take four
     * days" is still true even when most are closed on arrival.
     */
    if (spread.median === 0) {
      const took = closed.map((one) => one.days).filter((days) => days > 0);
      if (took.length < 5) continue;
      spread = spreadOf(took);
    }

    for (const one of members) {
      if (one.days <= spread.median) continue;

      /*
       * A MAD OF ZERO MEANS PERFECTLY CONSISTENT, WHICH IS THE CLEAREST CASE
       * AND NOT THE ABSENT ONE. Every express order takes one day; this one
       * took nine. A z-score cannot be computed against no spread, and treating
       * that as "no signal" silences the detector exactly where the class is
       * most predictable — which is where a deviation matters most.
       */
      if (!outlying(one.days, spread, options.threshold)) continue;

      findings.push({
        entityRef: one.ref,
        measure: klass === '' ? 'duration' : `duration (${klass})`,
        observed: Math.round(one.days * 100) / 100,
        expected: Math.round(spread.median * 100) / 100,
        deviation: deviationOf(one.days, spread.median),
        /* Open instances are worth marking: the number will keep growing. */
        evidence: one.open ? [one.ref, 'still open'] : [one.ref],
        /*
         * §4.1 — WHEN IT HAPPENED, AND AN OPEN INSTANCE HAS NOT HAPPENED YET.
         * This used to stamp an open instance with `endedAt`, which for an open
         * one is the detector's own run clock — so every still-running finding
         * claimed to have occurred at the moment the detector looked, and §4
         * ordered real events against a scheduling artefact. The start is the
         * event that did occur: this began then, and is still going.
         */
        occurredAt: new Date(one.open ? one.startedAt : one.endedAt).toISOString(),
      });
    }
  }

  return { findings, populationN: instances.length };
}

/* ── Drift ───────────────────────────────────────────────────────────────── */

/**
 * A previously stable rate that has changed.
 *
 * THE SENTENCE CONTAINS TWO CLAIMS AND THE FIRST ONE IS THE HARD ONE. That the
 * rate has moved is a subtraction. That it was PREVIOUSLY STABLE is what needs
 * the history, and it is what separates a finding from noise: a rate that has
 * always been jumpy moving again is not drift, it is Tuesday.
 *
 * THE MOST RECENT BUCKET IS DISCARDED WHEN IT IS INCOMPLETE. A window that is
 * three days into a fortnight holds a third of its eventual rows, and comparing
 * it against full buckets reports a collapse in volume every single time the
 * detector runs. This is the defect this detector would otherwise ship with.
 *
 * A RATE NEEDS A DENOMINATOR OR IT IS A VOLUME. With `subjectField`, the rate is
 * the share of each bucket's records where that field is set — rejections among
 * orders, say. Without it, the measure is volume and says so, because a count
 * per period moves for business reasons that are nobody's exception.
 */
export function detectDrift(
  rows: Row[],
  input: {
    dateField: string;
    /** Present on a row means it counted. Absent means volume is the measure. */
    subjectField?: string;
    /** What the rate is called in the finding. */
    label: string;
  },
  options: { bucketDays: number; threshold: number; minimumBuckets?: number; at?: number },
): Outcome {
  const now = options.at ?? Date.now();
  const minimumBuckets = options.minimumBuckets ?? 5;
  const bucket = options.bucketDays * DAY;

  type Bucket = { index: number; rows: number; counted: number; latest: number };
  const buckets = new Map<number, Bucket>();

  const seen = rows
    .map((row) => instant(at(row, input.dateField)))
    .filter((value): value is number => value !== null && value <= now);

  if (seen.length === 0) return { findings: [], populationN: rows.length };

  /*
   * ── Buckets anchor on the newest row, not on the clock ────────────────────
   *
   * Anchoring on `now` made the same rows produce different findings depending
   * on the hour the detector happened to run, which §3.3 forbids outright. It
   * was also wrong in a way that produced findings rather than losing them: a
   * source whose data ends three weeks ago put every row at index 2 or higher,
   * so "the most recent finished period" was EMPTY and the series read as a
   * total collapse in volume — every run, for ever, on any table that stopped
   * being written to.
   *
   * Anchored here, index 0 is the period containing the newest record and index
   * 1 is the last one known to be complete. Both are facts about the data.
   */
  const anchor = Math.max(...seen);

  for (const row of rows) {
    const when = instant(at(row, input.dateField));
    if (when === null || when > now) continue;

    const index = Math.floor((anchor - when) / bucket);
    const held = buckets.get(index) ?? { index, rows: 0, counted: 0, latest: 0 };

    held.rows += 1;
    if (!input.subjectField || !absent(at(row, input.subjectField))) held.counted += 1;
    held.latest = Math.max(held.latest, when);

    buckets.set(index, held);
  }

  /*
   * INDEX 0 IS THE BUCKET WE ARE STANDING IN, and it is incomplete by
   * definition. Index 1 is the most recent finished period and is the one
   * compared against everything older.
   */
  const current = buckets.get(1);
  if (!current || current.rows === 0) return { findings: [], populationN: rows.length };

  const baseline = [...buckets.values()]
    .filter((one) => one.index > 1 && one.rows > 0)
    .sort((a, b) => a.index - b.index);

  if (baseline.length < minimumBuckets) return { findings: [], populationN: rows.length };

  /*
   * A PERIOD HOLDING ONE ROW IS NOT A RATE. One rejection in a fortnight that
   * normally sees four hundred records is a 100% rejection rate on paper, and a
   * detector reporting that has found a quiet fortnight rather than a change in
   * the business. A fifth of the usual volume is the fewest that can carry a
   * proportion worth reading.
   */
  const usualVolume = middleOf([...baseline.map((one) => one.rows)].sort((a, b) => a - b));
  if (input.subjectField && current.rows < Math.max(5, usualVolume * 0.2)) {
    return { findings: [], populationN: rows.length };
  }

  const rateOf = (one: Bucket) => (input.subjectField ? one.counted / one.rows : one.rows);

  const rates = baseline.map(rateOf);
  const { median, mad } = spreadOf(rates);

  /*
   * WAS IT EVER STABLE? A baseline whose own spread is half its level was never
   * stable, so there is no "previously stable rate" to have changed and the
   * whole premise of the finding fails. Saying nothing is the correct output.
   */
  if (median > 0 && mad / median > 0.5) return { findings: [], populationN: rows.length };

  const observed = rateOf(current);
  const change = deviationOf(observed, median);

  /*
   * ── A baseline of exactly zero is the strongest signal there is ───────────
   *
   * This used to return nothing when the median was zero, on the reasoning that
   * a relative change against zero is undefined. It is — and the case it was
   * silencing is the largest move a rate can make: ten fortnights with no
   * rejections at all, then a fortnight with forty. The one series whose
   * stability is beyond argument produced the one finding nobody got told about.
   *
   * `deviationOf` normalises against the LARGER side, so a move from 0 to
   * anything is a deviation of 1 and the relative floor below passes it. All
   * that is needed is not to refuse it first.
   */
  const brokeSilence = median === 0 && observed > 0;

  /*
   * A PERFECTLY FLAT BASELINE IS THE STRONGEST EVIDENCE, NOT THE WEAKEST, and
   * getting this backwards is the bug this comment exists to prevent. Ten
   * fortnights at exactly 10% have a MAD of zero, so no z-score can be computed
   * — and a detector that reads that as "no signal" refuses to report the one
   * series whose stability is beyond argument. Against a flat line the test is
   * the size of the move instead, and the bar is high.
   */
  const outlying =
    brokeSilence || (mad === 0 ? change >= 0.5 : modifiedZ(observed, median, mad) > options.threshold);

  if (!outlying) return { findings: [], populationN: rows.length };

  /*
   * AND THE MOVE HAS TO BE BIG ENOUGH FOR A PERSON TO CARE. Without this, one
   * extra rejection in a quiet fortnight clears a z-score against a tight
   * baseline and becomes a finding somebody has to read.
   */
  if (change < 0.2) return { findings: [], populationN: rows.length };

  return {
    findings: [
      {
        entityRef: input.label,
        measure: input.subjectField ? `${input.label} rate` : `${input.label} volume`,
        observed: Math.round(observed * 10_000) / 10_000,
        expected: Math.round(median * 10_000) / 10_000,
        deviation: change,
        evidence: baseline.map((one) => `${one.index} periods ago: ${Math.round(rateOf(one) * 10_000) / 10_000}`),
        occurredAt: new Date(current.latest).toISOString(),
      },
    ],
    populationN: rows.length,
  };
}

/* ── Recurrence ──────────────────────────────────────────────────────────── */

/**
 * The same exception repeatedly from the same source.
 *
 * AGAINST THE OTHER SOURCES, NOT AGAINST A NUMBER. Four failures from one
 * supplier is unremarkable where every supplier has four and is the finding
 * where the rest have none. A fixed threshold cannot tell those apart, and it is
 * the comparison that makes this worth running rather than the count.
 *
 * A FLOOR AS WELL, because with a median of zero the comparison alone flags
 * anything that happened twice — and "it happened twice" is not recurrence, it
 * is a coincidence with a small sample behind it.
 */
export function detectRecurrence(
  rows: Row[],
  input: {
    /** Whose recurrence: a supplier, a connection, a step, a person. */
    sourceField: string;
    dateField: string;
  },
  options: { threshold: number; floor?: number },
): Outcome {
  const floor = options.floor ?? 3;

  const bySource = new Map<string, { count: number; latest: number; refs: string[] }>();

  for (const row of rows) {
    const source = at(row, input.sourceField);
    if (absent(source)) continue;

    const when = instant(at(row, input.dateField));
    if (when === null) continue;

    const key = String(source).trim();
    const held = bySource.get(key) ?? { count: 0, latest: 0, refs: [] };

    held.count += 1;
    held.latest = Math.max(held.latest, when);
    /* Dates, not contents: the evidence is when, never what. */
    if (held.refs.length < 20) held.refs.push(new Date(when).toISOString());

    bySource.set(key, held);
  }

  if (bySource.size < 2) return { findings: [], populationN: bySource.size };

  const counts = [...bySource.values()].map((one) => one.count);
  const { median, mad } = spreadOf(counts);

  const findings: Detected[] = [];

  for (const [source, held] of bySource) {
    if (held.count < floor) continue;
    if (held.count <= median) continue;

    /*
     * WHERE EVERY SOURCE HAS THE SAME COUNT THE MAD IS ZERO and no comparison is
     * possible. One source above a flat line is still worth saying when it
     * clears the floor by a distance — the alternative is silence in the case
     * where nine suppliers have one failure each and the tenth has twelve.
     */
    const outlying =
      mad === 0 ? held.count >= Math.max(floor, median * 3) : modifiedZ(held.count, median, mad) > options.threshold;

    if (!outlying) continue;

    findings.push({
      entityRef: source,
      measure: input.sourceField,
      observed: held.count,
      expected: Math.round(median * 100) / 100,
      deviation: deviationOf(held.count, median),
      evidence: held.refs,
      occurredAt: new Date(held.latest).toISOString(),
    });
  }

  return { findings, populationN: bySource.size };
}

/* ── §3.4 Derived thresholds ─────────────────────────────────────────────── */

/**
 * §3.4 — derived from the population, not configured, so a newly connected
 * system produces sensible findings on the first run.
 *
 * THE SAME SHAPE AS THE OTHER SEVEN. `deriveTolerance` and its neighbours make
 * the argument at length; these are the three history detectors' first-run
 * numbers, and `map.service` persists whatever they become.
 */
export function deriveTimingThreshold(instances: number): number {
  /* Below twenty the median is itself unstable, so the bar goes up rather than
     the detector pretending to a precision it does not have. */
  return instances < 20 ? 5 : 3.5;
}

export function deriveDriftThreshold(buckets: number): number {
  /* With only the minimum number of periods, the spread is a rough estimate and
     a low bar would turn that roughness into findings. */
  return buckets <= 6 ? 4.5 : 3.5;
}

export function deriveRecurrenceThreshold(sources: number): number {
  return sources < 10 ? 4.5 : 3.5;
}

/**
 * How long a period drift buckets by.
 *
 * WIDE ENOUGH TO HOLD ENOUGH ROWS, NARROW ENOUGH TO NOTICE. Over a long range a
 * fortnight gives a dozen buckets; over a short one a week is all that fits, and
 * daily buckets measure the shape of the working week rather than anything about
 * the business.
 */
export function deriveBucketDays(rangeDays: number): number {
  if (rangeDays >= 150) return 14;
  if (rangeDays >= 60) return 7;
  return 3;
}
