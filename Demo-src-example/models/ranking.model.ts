/**
 * §5 — a ranking, as it was stored when somebody was shown it.
 *
 * REFERENCES AND COMMENTARY, NOTHING ELSE. Finding ids with a rank and a
 * rationale, ids that share a factor, ids that were left out and why. There is
 * no field here for a figure or a row, because the model was never sent one —
 * which is what makes §5.2's promise structural rather than a habit.
 *
 * THE ARITHMETIC OF PRODUCING ONE LIVES IN `engine/ranking`, which takes and
 * returns the same three lists without knowing a database exists. This is what
 * the row turns into.
 */

/** One finding's place in the order, with the reason it is there. */
export interface Ranked {
  findingId: string;
  rank: number;
  rationale: string;
}

/** Findings the model says share a factor. */
export interface Grouping {
  findingIds: string[];
  sharedFactor: string;
}

/**
 * A finding the model set aside.
 *
 * KEPT, NOT DISCARDED. §5.3 — omitted findings stay visible on request. The
 * model narrows attention; it never removes evidence.
 */
export interface Omission {
  findingId: string;
  reason: string;
}

export interface StoredRanking {
  id: string;
  /**
   * WHICH MODEL SAID THIS. Half of answering "why was this first in March" is
   * knowing what was doing the ordering, and model versions change underneath a
   * deployment without anybody in this system being told.
   */
  modelVersion: string;
  ordered: Ranked[];
  groupings: Grouping[];
  omitted: Omission[];
  createdAt: Date;
}
