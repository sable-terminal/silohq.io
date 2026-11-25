import { modifiedZ } from '../detectors/shared.detector';

/**
 * §5 — how much one finding is worth looking at, within its own detector.
 *
 * ── What a score is, and the thing it must not become ──────────────────────
 *
 * An ordering aid. A hundred findings arrive from one run and somebody has an
 * afternoon; this decides what they read first. It is NOT a claim that a
 * high-scoring finding is real or that a low-scoring one is not — every finding
 * here is arithmetic that already held before this ran, and §5.3's rule that
 * nothing is removed applies to a score of 0.02 exactly as it does to a 0.98.
 *
 * ── Within a detector, never across ────────────────────────────────────────
 *
 * A disagreement's deviation is two systems differing by 40%. An outlier's is a
 * value 6 median-absolute-deviations from its population. Those are different
 * arithmetics over different populations and the numbers are not commensurable;
 * dividing one by the other produces an ordering that looks principled and is
 * not. So everything here is relative to the OTHER findings of the SAME
 * detector in the SAME run, and putting a disagreement beside a timing
 * deviation is §5's ranking stage, which reads the whole set and explains
 * itself.
 *
 * ── Every component is passed in ───────────────────────────────────────────
 *
 * Nothing here fetches. Deviation and population come from the detector that
 * computed them; corroboration and path concentration from the detector service
 * once a run has finished and it can see the whole set; persistence from the
 * findings table, which already knows how long this one has been true; outcome
 * proximity from the outcome designations somebody recorded. Assembling them is
 * a service's job and scoring them is arithmetic, which is why this file can be
 * tested without a database.
 *
 * ── Absent is not zero ─────────────────────────────────────────────────────
 *
 * Nobody has designated an outcome; the Silo has one run of history and cannot
 * say whether anything persists. Scoring those as zero would rank a finding
 * DOWN for a fact nobody has recorded, which reads as evidence of
 * unimportance and is evidence of nothing. An absent component is left out of
 * the average and named in `from`, so a 0.8 computed from two components can be
 * told apart from a 0.8 computed from six.
 */

/**
 * What is known about one finding, relative to its own detector's run.
 *
 * Every field is optional because every one of them can honestly be unknown,
 * and the shape is the enforcement: there is no sentinel that means "none", so
 * nothing can quietly substitute one.
 */
export type Components = {
  /**
   * How far out this finding is, against the spread of the same detector's
   * other findings in the same run.
   */
  deviationMagnitude?: number;
  /** How many entities the detector examined to reach it. */
  populationSize?: number;
  /** How many OTHER detectors raised something about the same entity. */
  corroboration?: number;
  /** How much of this concept's trouble arrives at the same related instance. */
  pathConcentration?: number;
  /** How many consecutive runs this same finding has been raised in. */
  persistence?: number;
  /** How close the measure sits to something the customer called an outcome. */
  outcomeProximity?: number;
};

export type Scored = {
  /** 0 to 1. An ordering aid within one detector's run, and nothing more. */
  score: number;
  /** Each component as it was scored, so a reader can see what carried it. */
  components: Components;
  /** Which components were known. A score from two is not a score from six. */
  from: Array<keyof Components>;
};

/**
 * HOW MUCH EACH COMPONENT MOVES THE ANSWER, stated once and in the open.
 *
 * Deviation leads because it is the only component computed from the
 * customer's actual records — everything else is a fact about the finding's
 * surroundings. Corroboration and outcome proximity come next: several
 * detectors independently noticing the same entity, and the measure being one
 * somebody said they care about, are the two things most likely to make a
 * reader glad they looked. Population size is a confidence weight rather than a
 * signal, which is why it is the lightest.
 */
export const WEIGHTS: Record<keyof Components, number> = {
  deviationMagnitude: 0.3,
  corroboration: 0.2,
  outcomeProximity: 0.2,
  pathConcentration: 0.125,
  persistence: 0.125,
  populationSize: 0.05,
};

/** What each component is measured against, so the constants are not hidden. */
const SCALE = {
  /**
   * The modified z-score at which a finding counts as fully out.
   *
   * SIX, WHICH IS WELL PAST ANY DETECTOR'S OWN THRESHOLD. The detectors raise
   * at three-ish; this is asking a different question — not "is this out" but
   * "is this the one to read first" — and a scale that saturated at the
   * raising threshold would score every finding in the run at 1.
   */
  deviation: 6,
  /** Where population size stops adding confidence. */
  population: 500,
  /** Detectors agreeing. Three independent ones is as corroborated as it gets. */
  corroboration: 3,
  /** Runs. A month of daily runs is as persistent as this needs to distinguish. */
  persistence: 30,
} as const;

/**
 * Score one finding against the run it came from.
 *
 * DETERMINISTIC AND ORDER-INDEPENDENT, like everything else that reaches a
 * finding: the same run scored twice gives the same numbers, and the numbers do
 * not depend on which order the findings came back in.
 */
export function score(input: {
  finding: { deviation: number | null; populationN: number };
  /**
   * The same detector's other findings in the same run — what "far out" is
   * measured against. A run of one has no spread and says so by scoring no
   * deviation component at all rather than by scoring it zero.
   */
  population: { deviations: readonly number[] };
  /** Detectors other than this one that raised something about this entity. */
  corroboratedBy?: readonly string[];
  /**
   * Where this concept's findings arrive, through the relationships walked.
   * `sharing` is how many reach the same instance this one does.
   */
  paths?: { sharing: number; total: number };
  /** Consecutive runs this finding has been raised in, this one included. */
  runs?: number;
  /**
   * Hops from this finding's measure to something designated an outcome, or
   * null where the walk found none. Zero means the measure IS the outcome.
   */
  hopsToOutcome?: number | null;
}): Scored {
  const components: Components = {};

  const magnitude = deviationMagnitude(input.finding.deviation, input.population.deviations);
  if (magnitude !== null) components.deviationMagnitude = magnitude;

  /*
   * POPULATION IS A CONFIDENCE WEIGHT, NOT A SIGNAL. A disagreement found over
   * four entities may be the most important thing in the estate; it is just
   * less certain to be a pattern than the same finding over forty thousand.
   */
  components.populationSize = saturating(input.finding.populationN, SCALE.population);

  if (input.corroboratedBy) {
    components.corroboration = saturating(input.corroboratedBy.length, SCALE.corroboration);
  }

  if (input.paths && input.paths.total > 0) {
    /*
     * CONCENTRATION, NOT COUNT. Forty invoice findings that all reach one
     * supplier is a different shape from forty that reach forty — the first
     * points somewhere, and where it points is upstream of the trouble rather
     * than the cause of it.
     */
    components.pathConcentration = clamp(input.paths.sharing / input.paths.total);
  }

  /*
   * A FINDING THAT KEEPS COMING BACK IS DIFFERENT FROM ONE THAT APPEARED ONCE,
   * and the difference is not that it is worse. It is that nobody has dealt
   * with it, which is the thing a reader most often wants surfaced.
   *
   * A FIRST SIGHTING SCORES NO PERSISTENCE AT ALL, rather than zero. It has not
   * failed to persist; it has not been asked yet, and there is no second
   * observation to answer with. Scoring it zero would be worse than merely
   * wrong: EVERY finding starts at one run, so it would push every newly
   * raised finding to the bottom of the list on its first appearance — which is
   * often exactly when somebody most wants to see it.
   *
   * This was the code contradicting its own comment, and a test written to
   * match the code rather than the intent kept it that way.
   */
  if (input.runs !== undefined && input.runs > 1) {
    components.persistence = saturating(input.runs - 1, SCALE.persistence - 1);
  }

  if (input.hopsToOutcome !== undefined && input.hopsToOutcome !== null) {
    /*
     * §4.2 — AN OUTCOME IS SOMETHING THE CUSTOMER SAID THEY CARE ABOUT, and
     * nothing in this product decides what one is. Proximity decays by hop
     * because a measure two relationships from a designated outcome is a
     * weaker statement about that outcome than the outcome's own measure, and
     * because past a few hops everything is connected to everything.
     */
    components.outcomeProximity = 1 / (1 + Math.max(0, input.hopsToOutcome));
  }

  const from = (Object.keys(components) as Array<keyof Components>).sort();

  /*
   * A WEIGHTED MEAN OVER WHAT IS KNOWN, with the weights renormalised across
   * exactly those components. Dividing by the full weight instead would make
   * every score with a missing component sit below every score without one —
   * ranking findings by how much the system happens to know about them.
   */
  const total = from.reduce((sum, key) => sum + WEIGHTS[key], 0);
  const weighted = from.reduce((sum, key) => sum + WEIGHTS[key] * (components[key] ?? 0), 0);

  return { score: total === 0 ? 0 : round(weighted / total), components, from };
}

/**
 * How far out, against the same detector's other findings.
 *
 * MEDIAN AND MAD, NOT MEAN AND STANDARD DEVIATION, for the reason the detectors
 * already give: the outliers this is scoring are in the population being
 * measured, and they drag a mean toward themselves until nothing looks unusual.
 *
 * A MAD OF ZERO MEANS PERFECTLY CONSISTENT, which is the clearest evidence a
 * value standing apart is remarkable rather than an absence of signal — the
 * same inversion `outlying` documents. It falls back to a multiple of the
 * median, which is the only thing left to compare against.
 */
function deviationMagnitude(
  deviation: number | null,
  population: readonly number[],
): number | null {
  if (deviation === null) return null;

  const values = population.filter((value) => Number.isFinite(value)).map(Math.abs);
  /* A run of one has no spread to measure against, and inventing one would
     score every single-finding run at the same arbitrary number. */
  if (values.length < 2) return null;

  const centre = median(values);
  const spread = median(values.map((value) => Math.abs(value - centre)));

  if (spread > 0) return clamp(modifiedZ(Math.abs(deviation), centre, spread) / SCALE.deviation);

  /* Flat population. A median of nought has no multiple — everything is
     infinitely far from it, and that is nobody's ordering. */
  if (centre <= 0) return null;
  return clamp(Math.abs(deviation) / (centre * SCALE.deviation));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/** Rises quickly then flattens: more is better, and twice as much is not twice. */
const saturating = (value: number, scale: number) => clamp(Math.max(0, value) / scale);

const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/* Four places, so a score is stable across machines and comparable as text. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;
