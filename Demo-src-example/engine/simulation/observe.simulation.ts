import { quantilesOf } from './montecarlo.simulation';

/**
 * Simulation §2.2 — lead times derived from what actually happened.
 *
 * "Where a Silo holds enough, observed lead times are derived from what
 * actually happened: the elapsed time between the upstream event and the
 * downstream one, with the distribution and the sample size. This is far better
 * than an estimate and it is only available where history exists."
 *
 * ── WHAT THIS READS, AND WHAT IT CANNOT ───────────────────────────────────
 *
 * Times. Nothing else. A transition row holds the value before and the value
 * after, and those two columns are the entire subject of the storage
 * disclosure; deriving a lead time needs WHEN a thing changed and never WHAT it
 * said. §8 makes that a rule about the table it writes — "counts and
 * statistics, never values" — and this file is where the rule is kept or
 * broken, because it is the only thing that sees both sides.
 *
 * ── §3.3 AGAIN, IN A PLACE IT IS EASY TO FORGET ───────────────────────────
 *
 * "Never that one thing caused another." An elapsed time between two events is
 * not evidence that the first produced the second. What it measures is how long
 * the gap USUALLY IS on an edge somebody has already asserted is a dependency,
 * which is a different and much weaker claim — and the only one the graph
 * supports. So nothing here discovers edges; it puts numbers on edges a person
 * asserted.
 */

/** A moment something changed. No value, no field, deliberately. */
export interface Event {
  entityRef: string;
  at: Date;
}

export interface Distribution {
  count: number;
  /**
   * §4.1 — the minimum, nine deciles and the maximum.
   *
   * COMPUTED HERE AND NOT LATER, because the samples do not survive. A Silo's
   * retention window sweeps the transitions these were derived from, and a
   * distribution recoverable only from data that has been deleted is a
   * distribution that stops existing.
   */
  quantiles: number[];
  meanHours: number;
  medianHours: number;
  p90Hours: number;
  minHours: number;
  maxHours: number;
  stdDevHours: number;
  observedFrom: Date;
  observedTo: Date;
}

const HOUR = 60 * 60 * 1000;

/**
 * Pair each upstream event with the first downstream event that followed it.
 *
 * ── THE FIRST ONE AFTER, AND ONLY IF THERE IS ONE ────────────────────────
 *
 * An upstream event with no downstream event after it contributes NOTHING
 * rather than a large number. The obvious alternative — treating "hasn't
 * happened yet" as a very long lead time — is how a distribution acquires a
 * tail made entirely of things that are still in progress, and the median
 * drifts up every time the sweep runs on a quiet week.
 *
 * ── ONE SAMPLE PER UPSTREAM EVENT, NOT PER PAIR OF EVENTS ────────────────
 *
 * A downstream entity that changed forty times after one upstream change is
 * one observation of the gap, not forty. Counting all forty would put a sample
 * size of four hundred next to an edge seen ten times, which is exactly the
 * figure §4.3 says must be shown honestly.
 */
export function elapsed(input: {
  upstream: readonly Event[];
  downstream: readonly Event[];
  /** Which downstream entities belong to which upstream one. */
  pairs: ReadonlyMap<string, readonly string[]>;
}): number[] {
  const downstreamByEntity = new Map<string, Date[]>();
  for (const event of input.downstream) {
    const at = downstreamByEntity.get(event.entityRef);
    if (at) at.push(event.at);
    else downstreamByEntity.set(event.entityRef, [event.at]);
  }
  for (const times of downstreamByEntity.values()) times.sort((a, b) => a.getTime() - b.getTime());

  const samples: number[] = [];

  for (const event of input.upstream) {
    let soonest: number | null = null;

    for (const ref of input.pairs.get(event.entityRef) ?? []) {
      for (const at of downstreamByEntity.get(ref) ?? []) {
        if (at.getTime() <= event.at.getTime()) continue;
        const gap = at.getTime() - event.at.getTime();
        if (soonest === null || gap < soonest) soonest = gap;
        /* Times are sorted, so the first one after this event is the nearest
           for this entity; nothing later can beat it. */
        break;
      }
    }

    if (soonest !== null) samples.push(soonest / HOUR);
  }

  return samples;
}

/**
 * §8 — "sample count, distribution parameters, observed from, observed to".
 *
 * THE MEDIAN IS THE ONE THAT GETS PROPOSED. One order that sat for two hundred
 * days drags a mean into a figure that describes nothing, and a proposal exists
 * to be sanity-checked at a glance by somebody who knows the operation.
 *
 * Returns null for an empty sample: §4.1's "inventing a distribution from an
 * estimate is the specific dishonesty that makes probabilistic simulation
 * worthless", and a distribution over nothing is the purest form of it.
 */
export function distributionOf(
  samples: readonly number[],
  window: { from: Date; to: Date },
): Distribution | null {
  if (samples.length === 0) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  const mean = sorted.reduce((sum, one) => sum + one, 0) / count;

  /* Nearest-rank, so every reported figure is a gap that actually happened
     rather than an interpolation between two that did. */
  const at = (fraction: number) =>
    sorted[Math.min(count - 1, Math.max(0, Math.ceil(fraction * count) - 1))]!;

  const variance = sorted.reduce((sum, one) => sum + (one - mean) ** 2, 0) / count;

  return {
    count,
    /*
     * COMPUTED BY THE THING THAT SAMPLES THEM, not here. The storage format and
     * the sampler have to agree about how many values there are and what they
     * mean, and two functions that each know half of that is how a distribution
     * ends up written in one shape and read in another.
     */
    quantiles: quantilesOf(sorted),
    meanHours: mean,
    medianHours: at(0.5),
    p90Hours: at(0.9),
    minHours: sorted[0]!,
    maxHours: sorted[count - 1]!,
    stdDevHours: Math.sqrt(variance),
    observedFrom: window.from,
    observedTo: window.to,
  };
}

/**
 * §2.2 — "Where a Silo holds ENOUGH."
 *
 * ── WHY THERE IS A FLOOR, AND WHY IT IS NOT ONE ──────────────────────────
 *
 * §4.1 illustrates with "an edge with four hundred recorded instances", which
 * is a distribution by any standard, and §4.3 with "eleven observations", which
 * is shown WITH that number beside it rather than hidden. So the spec's own
 * position is that a thin sample is reported honestly, not suppressed.
 *
 * The floor here governs only one thing: whether a lead time is PROPOSED from
 * the sample. Below it the observation is still recorded, count and all,
 * because §4.3 wants the number visible; above it the median is stable enough
 * that one more instance does not move it by days, which is the difference
 * between a proposal and a coin toss wearing a decimal point.
 */
export const MIN_SAMPLES_TO_PROPOSE = 30;

/**
 * A duration a person can read, from a figure in hours.
 *
 * ROUNDED TO THE UNIT IT IS STATED IN, because a proposal reading "5.03 days"
 * claims a precision the sample does not have and invites somebody to confirm
 * it unchanged rather than think about it.
 */
export function asLeadTime(hours: number): { value: number; unit: 'hours' | 'days' | 'weeks' } {
  if (hours < 48) return { value: Math.max(1, Math.round(hours)), unit: 'hours' };
  if (hours < 24 * 21) return { value: Math.round(hours / 24), unit: 'days' };
  return { value: Math.round(hours / 168), unit: 'weeks' };
}
