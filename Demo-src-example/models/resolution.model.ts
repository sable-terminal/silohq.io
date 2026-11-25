/**
 * §2.6 — the failure path, kept separate on purpose.
 *
 * THIS IS THE ONLY PLACE INFERENCE TOUCHES IDENTITY, which is why it is its own
 * model, its own repo and its own service rather than a corner of the concept
 * layer. Everywhere else, two rows are the same entity because their agreed
 * match keys are equal — arithmetic, no judgement, no threshold. Here the
 * matcher has failed, a model is asked to guess, and a person decides.
 *
 * KEEPING THE BOUNDARY VISIBLE IS THE POINT. A reviewer asking "where does the
 * AI affect what counts as the same customer" should be able to be handed one
 * directory and told: here, and nowhere else.
 */

/** Who suggested the two are one entity. */
export type ProposedBy = 'resolver' | 'model';

/**
 * A pair the exact matcher could not match.
 *
 * IT IS A QUESTION, NOT A FINDING. Either the record is genuinely missing on
 * the other side, or it is spelled differently and nobody has said so. The
 * resolver cannot tell those apart, does not try, and records the question.
 *
 * REFS, NOT VALUES. `valueRefA` is how the source identifies the row, never
 * what the row says — the same line §2.5 and §3.2 draw.
 */
export interface UnresolvedPair {
  id: string;
  organisationId: string;
  conceptId: string;
  connectionA: string;
  valueRefA: string;
  connectionB: string;
  /** Empty while the question is "this has no counterpart" rather than "is it this one". */
  valueRefB: string;
  proposedBy: ProposedBy;
  /** Why the model thinks so. Kept so a person can disagree with the reasoning. */
  modelRationale: string | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  rejectedAt: Date | null;
  proposedAt: Date;
}

export type PairState = 'open' | 'confirmed' | 'rejected';

/**
 * DERIVED, NOT STORED. Three columns already say it between them, and a fourth
 * that could disagree with them is the bug `seat.model` describes: the column
 * everything reads is the one that goes stale.
 */
export function stateOf(pair: UnresolvedPair): PairState {
  if (pair.confirmedAt) return 'confirmed';
  if (pair.rejectedAt) return 'rejected';
  return 'open';
}

/**
 * A decided pair, promoted to an exact mapping.
 *
 * §2.6 — "never inferred again". Once this row exists, resolution reads it as
 * fact and the model is never consulted about that pair a second time. That is
 * the whole promise: inference happens once, in front of a person, and
 * everything afterwards is arithmetic.
 */
export interface ConfirmedResolution {
  id: string;
  organisationId: string;
  conceptId: string;
  connectionA: string;
  valueRefA: string;
  connectionB: string;
  valueRefB: string;
  pairId: string | null;
  confirmedBy: string;
  confirmedAt: Date;
}

/**
 * Put a pair in the order the database stores it.
 *
 * "A IS B" AND "B IS A" ARE ONE FACT. Two rows for it can be decided
 * differently, and the resolver would take whichever the planner returned
 * first — so both tables carry a CHECK that the connections are ordered, and
 * every writer and reader passes through here rather than remembering to sort.
 */
export function canonical<T extends { connectionA: string; valueRefA: string; connectionB: string; valueRefB: string }>(
  pair: T,
): T {
  /*
   * A ONE-SIDED QUESTION IS DIRECTIONAL AND MUST NOT BE ORDERED. "This row in
   * Netsuite has no counterpart in Sage" and "this row in Sage has no
   * counterpart in Netsuite" are two different questions about two different
   * records — not one fact written twice. Swapping by connection would move the
   * reference that was actually read out of a source into the empty column.
   */
  if (pair.valueRefB.trim() === '') return pair;
  if (pair.connectionA <= pair.connectionB) return pair;

  return {
    ...pair,
    connectionA: pair.connectionB,
    valueRefA: pair.valueRefB,
    connectionB: pair.connectionA,
    valueRefB: pair.valueRefA,
  };
}
