/**
 * §4 — what moves with what, and which fields the customer says matter.
 *
 * THE TYPE THAT IS NOT HERE IS CAUSATION. §4.2 — there is no `causes`, no
 * `direction_of_effect` and no field this layer could put one in. Confounding
 * cannot be ruled out from observational data without stated domain
 * assumptions, and stating those is the modelling engagement §1 refuses to be.
 * A shape that cannot hold a causal claim cannot leak one through a feature
 * nobody reviewed, which is the same guarantee migration 033 makes in SQL.
 *
 * BOTH SIDES OF AN ASSOCIATION ARE CONDITIONS, NOT FINDINGS. A finding is about
 * one entity, and a pair of them has a sample size of one — "these move
 * together, 78 of 94 times" is a statement about two conditions over 94
 * entities, and §4.1 requires that denominator be stated always.
 */

/** A detector's verdict on one measure of one concept. */
export interface Condition {
  detector: string;
  conceptId: string;
  measure: string;
}

/**
 * §4.1 — which came first, WHERE TIMESTAMPS PERMIT.
 *
 * `unknown` IS A FIRST-CLASS ANSWER rather than a gap. It is never computed from
 * `detected_at`: that records when a detector ran, so ordering by it would
 * report the engine's schedule as a fact about the customer's business.
 */
export type TemporalOrder = 'a_first' | 'b_first' | 'concurrent' | 'unknown';

/** §4.1 — which way a relationship COULD run, from the schema's own edges. */
export type StructuralDirection = 'a_to_b' | 'b_to_a' | 'none' | 'unknown';

export interface StoredAssociation {
  id: string;
  a: Condition;
  b: Condition;
  /** Entities showing both. */
  coOccurrence: number;
  /** Entities showing either. §4.1 — stated always. */
  sampleSize: number;
  /** Co-occurrence over the union. Symmetric, like the pair. */
  strength: number;
  /** Observed co-occurrence over what independence would predict. */
  lift: number;
  temporalOrder: TemporalOrder;
  structuralDirection: StructuralDirection;
}

/* ── §4.3 Outcome designations ───────────────────────────────────────────── */

/**
 * WHICH WAY IS BAD, because nothing else can know. Days late: higher is worse.
 * Margin: lower is worse. There is no third answer and no default.
 */
export type OutcomeDirection = 'higher_is_worse' | 'lower_is_worse';

/**
 * §4.3 — a field the customer has named as an outcome that matters.
 *
 * A FIELD PATH, NEVER A THRESHOLD. The customer says which field means late,
 * not what late is; what counts as late is computed against the population, and
 * a number typed in here would be the domain assumption §1 says never ships.
 */
export interface OutcomeDesignation {
  id: string;
  organisationId: string;
  conceptId: string;
  fieldPath: string;
  direction: OutcomeDirection;
  /** What this means to the people who work here, in their words. */
  label: string | null;
  designatedBy: string;
  designatedAt: Date;
  /**
   * RETIRED, NEVER DELETED. Every ranking anybody saw while it stood was ordered
   * by it, and a row that vanishes makes those orderings unexplainable.
   */
  retiredAt: Date | null;
}
