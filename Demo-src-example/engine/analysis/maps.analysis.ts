/**
 * §6 — the learned layer, and the two computations inside it.
 *
 * WHAT A MAP HOLDS IS REFERENCES, COUNTS AND DISPOSITIONS. §6.1 — no values,
 * ever. Nothing in this file reads a customer's data, because there is nowhere
 * in a map for a customer's data to be. That is why §6.1 can say a map holds
 * even with Siloes off: the learning layer never depended on storage, because it
 * never learned from data.
 *
 * IT NEVER CHANGES WHAT A DETECTOR COMPUTES. §6.6. A weight moves what gets
 * ranked and which connections get reached for; detection stays arithmetic, and
 * a finding can still be explained by showing the subtraction. The moment a
 * learned number reaches inside the computation, "the same data produces the
 * same findings" stops being true and nobody can say when it stopped.
 */

/* ── §6.4 Resolving a map against whoever opened it ──────────────────────── */

export type MapElement =
  | { kind: 'link'; conceptIds: [string, string] }
  | { kind: 'weight'; conceptId: string; detector: string }
  | { kind: 'threshold'; conceptId: string; detector: string }
  | { kind: 'relevance'; connectionId: string };

export type Reach = {
  /** Concepts this person can actually resolve, per `concept.service.list`. */
  concepts: Set<string>;
  /** Connections this person holds a read grant on, per `readableIds`. */
  connections: Set<string>;
};

export type Resolution<T> = {
  kept: T[];
  dropped: T[];
  /** Of everything in the map, the share this person can actually use. */
  coverage: number;
  /** The connections the map draws on that this person cannot reach. */
  unreachableConnections: string[];
};

function reaches(element: MapElement, reach: Reach): boolean {
  switch (element.kind) {
    case 'link':
      /* BOTH ENDS. A link to a concept somebody cannot resolve is not half a
         link, it is a line to somewhere they cannot go. */
      return element.conceptIds.every((id) => reach.concepts.has(id));
    case 'weight':
    case 'threshold':
      return reach.concepts.has(element.conceptId);
    case 'relevance':
      return reach.connections.has(element.connectionId);
  }
}

/**
 * §6.4 — a map resolves against the OPENER, never against its owner.
 *
 * A MAP MUST NEVER BECOME A PERMISSION ESCALATION, which is the whole of this
 * function. A shared map routinely references concepts the recipient cannot
 * see; opening it must drop those rather than resolve them with the owner's
 * reach. Anything else turns "share my map" into "lend somebody my grants",
 * which is the kind of feature that is discovered during an audit.
 *
 * WARNED, NOT SILENTLY DEGRADED. §6.4 again: a map built on engineering systems
 * and shared with somebody who has no grant on them is largely inert, and the
 * share should say so rather than leave them to notice. `coverage` is that
 * sentence as a number, and the unreachable connections are named so somebody
 * can go and ask for a grant.
 */
export function resolveFor<T extends MapElement>(
  elements: T[],
  reach: Reach,
): Resolution<T> {
  const kept: T[] = [];
  const dropped: T[] = [];

  for (const element of elements) {
    (reaches(element, reach) ? kept : dropped).push(element);
  }

  const unreachable = new Set<string>();
  for (const element of dropped) {
    if (element.kind === 'relevance') unreachable.add(element.connectionId);
  }

  return {
    kept,
    dropped,
    /*
     * AN EMPTY MAP IS FULLY COVERED, NOT ZERO. A new map nobody has taught
     * anything is not a map the opener is locked out of, and reporting 0%
     * would send somebody to ask for grants they already have.
     */
    coverage: elements.length === 0 ? 1 : kept.length / elements.length,
    unreachableConnections: [...unreachable].sort(),
  };
}

/* ── §6.6 What a disposition does to a weight ────────────────────────────── */

/**
 * Neutral, and where a detector on a concept starts.
 *
 * ONE MEANS "NO OPINION YET". A map with no history must rank exactly as though
 * it were not there, or the first run of a new map is worse than no map — which
 * is the fastest way to teach somebody to ignore the feature.
 */
export const NEUTRAL_WEIGHT = 1;

/**
 * How much a detector on a concept is worth to this person.
 *
 * SMOOTHED, SO ONE DECISION DOES NOT DECIDE. `(signal + 1) / (noise + 1)` means
 * a single dismissal moves the weight to a half rather than to zero, and it
 * takes a pattern to move it far. Somebody's first irritated dismissal on a
 * Friday should not silence a detector on Monday.
 *
 * IT IS A RATIO, NOT A SCORE, and that is what makes it explainable: "you have
 * set aside eleven of these and acted on one" is the sentence behind the number,
 * and it is the sentence the interface should show rather than 0.167.
 *
 * BOUNDED BOTH WAYS. The column allows 0 to 10; clamping here keeps a map that
 * has seen a hundred confirmations and no dismissals from ranking one detector
 * so far above everything else that nothing else is ever read.
 */
export function weightOf(signal: number, noise: number): number {
  const raw = (signal + 1) / (noise + 1);
  return Math.round(Math.min(10, Math.max(0.1, raw)) * 1000) / 1000;
}

/**
 * §6.6 — which counter a disposition moves.
 *
 * `not_relevant` IS NOISE AND `dismissed` IS NOISE, BUT THEY ARE NOT THE SAME
 * SENTENCE. "This is wrong" and "this is right and I do not care" both mean the
 * detector should be quieter for this person; the difference matters to whoever
 * reads the audit log, which is why the disposition is kept in full there and
 * only its direction reaches the map.
 *
 * CONFIRMING IS THE ONLY SIGNAL. Not opening a finding, not scrolling past it —
 * a person actually saying it was right. A map that counted attention rather
 * than judgement would learn that whatever is at the top matters, having put it
 * there itself.
 */
export function directionOf(disposition: string): 'signal' | 'noise' | null {
  if (disposition === 'confirmed') return 'signal';
  if (disposition === 'dismissed' || disposition === 'not_relevant') return 'noise';
  return null;
}

/**
 * §3.4 — where a threshold should move, given what people did with what it
 * raised.
 *
 * ── DETERMINISTIC, AND THAT IS A DEVIATION WORTH STATING ───────────────────
 *
 * §3.4 says "the AI stage adjusts it". This runs AT the AI stage and the model
 * does not pick the number, because a threshold is the thing that decides
 * whether a finding exists at all — and a number a model chose cannot be
 * explained to somebody asking why an exception stopped appearing. §6.6 already
 * says the map may move thresholds; this is that mechanism, and it keeps §3.3's
 * promise that a finding is always explainable by showing the computation.
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 * Mostly dismissed means the threshold is too loose and is letting through
 * things this person does not consider exceptions: raise it. Mostly confirmed
 * means it is earning its keep and could afford to catch more: lower it.
 *
 * BOUNDED MOVEMENT AND AN EVIDENCE FLOOR. A single Friday dismissal must not
 * move anything, and no single adjustment may move a threshold more than a
 * quarter — a detector that went quiet overnight is indistinguishable from one
 * that was switched off, which is the failure this is most likely to cause.
 */
export const TUNING_NEEDS_DECISIONS = 5;

export function tunedThreshold(
  current: number,
  signal: number,
  noise: number,
): { value: number; moved: boolean } {
  const decisions = signal + noise;

  /* Not enough for a pattern. A threshold that moves on one opinion is a
     threshold nobody can predict. */
  if (decisions < TUNING_NEEDS_DECISIONS || current <= 0) {
    return { value: current, moved: false };
  }

  /* Smoothed the same way `weightOf` is, for the same reason. */
  const worth = (signal + 1) / (decisions + 2);

  /*
   * 0.5 IS THE NEUTRAL POINT, where confirmations and dismissals balance.
   * Above it the detector is useful and may catch more; below it, less.
   */
  const move = Math.max(-0.25, Math.min(0.25, (0.5 - worth) / 2));
  const value = Math.round(current * (1 + move) * 1000) / 1000;

  return { value, moved: value !== current };
}
