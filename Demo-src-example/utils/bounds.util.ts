/**
 * The ceilings a query may not exceed, and the refusal when it would.
 *
 * IT REFUSES, IT NEVER TRUNCATES. A truncated result is the most dangerous thing
 * this system could return: it looks like an answer, it is a number somebody will
 * act on, and nothing about it says it is wrong. "Your top 50 suppliers by spend"
 * silently cut at row 50 of an unsorted scan is not a smaller right answer, it is
 * a confident wrong one.
 *
 * THIS IS THE HONEST-REFUSAL GUARANTEE. Everything else in the product is a claim
 * about accuracy; this is the mechanism.
 */

export interface Limits {
  maxRows: number;
  maxBytes: number;
  maxMilliseconds: number;
  /** Sources a single question may reach. Beyond this the plan is unreviewable. */
  maxSources: number;
  /**
   * Relationships a walk may cross. §4.1 — a path of four is already at the
   * edge of what a reader can hold, and one of nine is not an explanation.
   */
  maxHops: number;
  /**
   * Instances a single hop may carry forward. A walk fans out multiplicatively
   * — one supplier reaches a thousand invoices reaches ten thousand lines — and
   * this is the ceiling that catches it on the hop that does it rather than
   * after the fan-out is already paid for.
   */
  maxFrontier: number;
  /**
   * §2.6 — requests one completion pass may make of a customer's systems.
   *
   * THE ASYMMETRY IS THE PROBLEM. The first pass reads up to `maxRows` in ONE
   * request. Going back for counterparts turns that into one request per batch:
   * forty thousand entities against a source declaring a hundred values per
   * `in` is EIGHT HUNDRED SEQUENTIAL REQUESTS at one production system, from a
   * single question, which is slow for us and looks like an attack to them.
   *
   * We are a guest on those databases. Past this the question is refused and
   * says how to narrow it, rather than being answered eventually.
   */
  maxCompletionRequests: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRows: 50_000,
  maxBytes: 32 * 1024 * 1024,
  maxMilliseconds: 60_000,
  maxSources: 12,
  maxHops: 4,
  maxFrontier: 5_000,
  maxCompletionRequests: 50,
};

export type BoundKind = 'rows' | 'bytes' | 'time' | 'sources' | 'hops' | 'frontier';

export interface BoundsExceeded {
  kind: BoundKind;
  limit: number;
  observed: number;
  /** What the reader can do about it. A refusal without this is a dead end. */
  suggestion: string;
}

export function checkRows(observed: number, limits = DEFAULT_LIMITS): BoundsExceeded | null {
  if (observed <= limits.maxRows) return null;
  return {
    kind: 'rows',
    limit: limits.maxRows,
    observed,
    suggestion: 'Narrow the date range, or add a filter, or aggregate rather than listing.',
  };
}

export function checkBytes(observed: number, limits = DEFAULT_LIMITS): BoundsExceeded | null {
  if (observed <= limits.maxBytes) return null;
  return {
    kind: 'bytes',
    limit: limits.maxBytes,
    observed,
    suggestion: 'Select fewer fields, or aggregate at the source.',
  };
}

export function checkDuration(observed: number, limits = DEFAULT_LIMITS): BoundsExceeded | null {
  if (observed <= limits.maxMilliseconds) return null;
  return {
    kind: 'time',
    limit: limits.maxMilliseconds,
    observed,
    suggestion: 'Reduce the range, or save this as a scheduled view that runs in the background.',
  };
}

export function checkSources(observed: number, limits = DEFAULT_LIMITS): BoundsExceeded | null {
  if (observed <= limits.maxSources) return null;
  return {
    kind: 'sources',
    limit: limits.maxSources,
    observed,
    suggestion: 'Ask about fewer systems at once.',
  };
}

/**
 * How far a walk may travel, checked before the first hop is paid for.
 *
 * A ROUTE IS KNOWN IN FULL BEFORE ANY OF IT RUNS — it comes from the concept
 * graph, which is types rather than data — so an over-long walk is refused
 * without touching a source at all.
 */
export function checkHops(observed: number, limits = DEFAULT_LIMITS): BoundsExceeded | null {
  if (observed <= limits.maxHops) return null;
  return {
    kind: 'hops',
    limit: limits.maxHops,
    observed,
    suggestion: 'Ask about two things that sit closer together, or walk it in two steps.',
  };
}

/**
 * How wide a walk has got, checked at the hop that widened it.
 *
 * REFUSES RATHER THAN SAMPLING, for the reason at the top of this file. A walk
 * cut at the first five thousand invoices reaches a set of orders that is not
 * the set of orders that supplier touched, and the path it prints looks exactly
 * like one that is complete.
 */
export function checkFrontier(observed: number, limits = DEFAULT_LIMITS): BoundsExceeded | null {
  if (observed <= limits.maxFrontier) return null;
  return {
    kind: 'frontier',
    limit: limits.maxFrontier,
    observed,
    suggestion: 'Start from one instance rather than a set, or filter before walking.',
  };
}

/**
 * A budget checked while a query runs, not only after.
 *
 * CHECKING AFTERWARDS IS TOO LATE FOR TWO OF THE FOUR. Time and bytes are spent
 * as they accumulate: a 60-second limit discovered at second 300 has already cost
 * the source system five minutes of load. This is polled during streaming so the
 * query stops at the ceiling rather than being judged at the end.
 */
export class BoundsBudget {
  private bytes = 0;
  private rows = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly limits: Limits = DEFAULT_LIMITS) {}

  /** Returns the breach, or null. Called per chunk. */
  add(rows: number, bytes: number): BoundsExceeded | null {
    this.rows += rows;
    this.bytes += bytes;
    return (
      checkRows(this.rows, this.limits) ??
      checkBytes(this.bytes, this.limits) ??
      checkDuration(Date.now() - this.startedAt, this.limits)
    );
  }

  get consumed(): { rows: number; bytes: number; milliseconds: number } {
    return { rows: this.rows, bytes: this.bytes, milliseconds: Date.now() - this.startedAt };
  }
}
