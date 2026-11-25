/**
 * §3 — what a detector computed, and what somebody decided about it.
 *
 * A FINDING IS ARITHMETIC. Every field here was calculated from rows the
 * detectors were handed, and `observed`, `expected` and `deviation` are the only
 * numbers that come from a customer's records — `entity_ref` says WHICH
 * instance, by identifier, and never what it contained. That line is drawn in
 * migration 032 and this file is the second place it has to hold.
 *
 * NOTHING HERE KNOWS WHICH DETECTORS EXIST. `detector` is a string, matching the
 * services that pass one, and the closed set of ten lives in the schema's CHECK
 * where a detector nobody wrote cannot be recorded.
 */

/** §3 — which of source, Silo or both supplied a history detector's range. */
export type HistorySource = 'source' | 'silo' | 'both';

/**
 * Where one figure in a finding was read from.
 *
 * THE HISTORY SOURCE IS PER READING, not per finding. A baseline from a Silo
 * and a current period from the source is one finding with two lineages, which
 * is the arrangement that makes a six-month question answerable against a system
 * that keeps ninety days.
 */
export interface Lineage {
  connectionId: string;
  fieldPath: string;
  historySource?: string;
  /** Import §5 — set when the value cited was read from a document and not yet confirmed. */
  certainty?: 'near' | 'inferred';
}

export interface Finding {
  id: string;
  organisationId: string;
  detector: string;
  conceptId: string;
  /** Which instance, by identifier. Never by value. */
  entityRef: string;
  measure: string;
  observed: number | null;
  expected: number | null;
  /** Normalised, so findings of different magnitudes can be ordered together. */
  deviation: number | null;
  population: Record<string, unknown>;
  populationN: number;
  evidence: unknown;
  lineage: Lineage[];
  confidence: number | null;
  detectedAt: Date;
  /** §4.1 — when the thing HAPPENED. Null wherever the detector knew no time. */
  occurredAt: Date | null;
  historySource: HistorySource | null;
}

/**
 * A finding with the name of the concept it is about.
 *
 * THE NAME IS NOT ON THE FINDING AND MUST NOT BE COPIED ONTO IT. A concept can
 * be renamed, and a stored name would leave every finding raised before the
 * rename describing a concept that no longer goes by it.
 */
export interface NamedFinding {
  id: string;
  detector: string;
  conceptId: string;
  conceptName: string;
  entityRef: string;
  measure: string;
  observed: number | null;
  expected: number | null;
  deviation: number | null;
  populationN: number;
}

/** §3.2 — what one person decided about one finding. */
export type Disposition = 'confirmed' | 'dismissed' | 'not_relevant';

/**
 * §3's ten checks, as a list TypeScript can read.
 *
 * THE DATABASE ALREADY HAS THIS AS A CHECK CONSTRAINT, and that copy is the
 * authority — a detector nobody wrote cannot emit anything, so the closed set
 * is enforced where rows are written. This one exists because anything naming a
 * detector in an interface had no way to be told it had misspelled one, and a
 * scheduled check watching "dupplication" would simply never fire.
 */
export const DETECTORS = [
  'disagreement',
  'absence',
  'duplication',
  'referential_break',
  'sequence_violation',
  'outlier',
  'concentration',
  'timing_deviation',
  'drift',
  'recurrence',
] as const;

export type Detector = (typeof DETECTORS)[number];

/**
 * A finding as ONE PERSON sees it.
 *
 * §6.6 — THE DISPOSITION IS THEIR OWN AND NOBODY ELSE'S. A colleague dismissing
 * this finding has not agreed on anybody else's behalf that it is noise, so the
 * only decision that can appear beside a finding is the reader's.
 */
export interface FindingForReader extends NamedFinding {
  lineage: unknown;
  detectedAt: Date;
  disposition: Disposition | null;
  /**
   * §5 — what to read first, and what that judgement was made of.
   *
   * THE COMPONENTS TRAVEL WITH THE SCORE, ALWAYS. A reader asking why one
   * finding sits above another is owed the six numbers rather than the one, the
   * same way §5.2 requires a ranking to cite rather than assert.
   *
   * Null on anything raised before scoring existed, which is honest: nothing
   * re-scores an old finding, because the run it would have been scored against
   * is gone.
   */
  score: number | null;
  scoreComponents: Record<string, number> | null;
  /** When it was FIRST true, as opposed to when it was last confirmed. */
  firstDetectedAt: Date;
  /** How many runs have raised it. One means this is the first sighting. */
  raisedCount: number;
}

/** §5 — a finding as the ranking layer reads it, before it is summarised. */
export interface RankableFinding extends NamedFinding {
  confidence: number | null;
  occurredAt: Date | null;
}

/**
 * What §4 needs of a finding to associate it with another.
 *
 * NO FIGURES, BECAUSE ASSOCIATION COUNTS ENTITIES. Which condition held, on
 * which entity, against how large a population, and when — the arithmetic in
 * `engine/associations` never sees a value, and cannot leak one into a claim
 * about two conditions moving together.
 *
 * The engine takes this shape with `occurredAt` as an ISO string; converting it
 * is the service's job, because a repo hands back the Date it read.
 */
export interface FindingFact {
  /**
   * The connection the entity was read from, taken from the finding's lineage.
   *
   * NULL WHERE LINEAGE DID NOT RECORD ONE. §4's one-hop join needs it — a link
   * names an object in a particular system — and a finding without it simply
   * cannot participate, which is better than guessing at a connection.
   */
  connectionId?: string | null;
  id: string;
  detector: string;
  conceptId: string;
  measure: string;
  entityRef: string;
  populationN: number;
  occurredAt: Date | null;
}

/**
 * §5.5 — how often findings of one shape get set aside here.
 *
 * ORGANISATION-WIDE, THOUGH A DISPOSITION IS PERSONAL. One dismissal silences a
 * finding for the person who made it; forty across a team is a fact about what
 * this organisation cares about, and that is the fact worth telling the model.
 */
export interface DismissalRate {
  detector: string;
  conceptId: string;
  measure: string;
  raised: number;
  dismissed: number;
}

/**
 * §3.2 — WHETHER A DECISION HAS TO EXPLAIN ITSELF.
 *
 * DERIVED, BECAUSE THE SCHEMA ALREADY SAYS IT. `finding_dispositions_dismissal_explained`
 * is the same rule as a CHECK; a second copy written out at a call site is the
 * one that ends up disagreeing with the database, and the disagreement surfaces
 * as a constraint violation rather than as a sentence anybody can act on.
 *
 * Confirming needs no words — the finding already says what it is. "Not worth
 * looking at" is the judgement that later needs defending, and an unexplained
 * one is indistinguishable from a misclick.
 */
export function needsReason(disposition: Disposition): boolean {
  return disposition === 'dismissed';
}
