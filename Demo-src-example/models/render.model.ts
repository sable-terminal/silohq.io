/**
 * §7.3 — which archetype a result was drawn as, and whether the person
 * disagreed.
 *
 * NOTHING HERE PICKS ONE. The precedence lives in the client and is fixed, so
 * the same result always draws the same way; a selection that consulted this
 * would make the drawing depend on who had been looking at it. These types are
 * what gets recorded afterwards.
 *
 * NO VALUES. An archetype name, a reference to the result, and who overrode it.
 * Nothing about what the result contained — this is the learned layer's
 * neighbour and it must not become the place data leaks into.
 */

/**
 * The ten of §7.
 *
 * `table` IS THE FLOOR AND IS ALWAYS AMONG THE ALTERNATIVES, which is what
 * makes §7.4's guarantee that any result renders true rather than hoped for.
 */
export type Archetype =
  | 'chain'
  | 'network'
  | 'hierarchy'
  | 'series'
  | 'ranking'
  | 'distribution'
  | 'comparison'
  | 'composition'
  | 'figure'
  | 'table';

export interface RenderSelection {
  id: string;
  organisationId: string;
  /**
   * WHAT WAS DRAWN, BY REFERENCE. A result is not a row in this database — it
   * is the answer to a question, which exists for as long as somebody is
   * looking at it, so the caller's own handle for it is all there is to record.
   */
  resultRef: string;
  chosen: Archetype;
  /** The others that also fit, in precedence order. */
  alternatives: Archetype[];
  /** Null until somebody disagrees, which is the event worth waiting for. */
  overriddenTo: Archetype | null;
  membershipId: string;
  selectedAt: Date;
  overriddenAt: Date | null;
}

/**
 * How often one archetype is argued with.
 *
 * THE ONLY REASON THE TABLE EXISTS. A high override rate is §7.3's precedence
 * being wrong for a shape that keeps coming up — which is a number somebody can
 * act on, rather than the anecdote it would otherwise be.
 */
export interface OverrideRate {
  chosen: string;
  drawn: number;
  overridden: number;
  mostlyTo: string | null;
}
