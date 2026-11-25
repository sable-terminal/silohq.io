/**
 * Simulation §4 — probabilistic propagation.
 *
 * ── §4.1: THE LINE THIS FILE EXISTS TO NOT CROSS ──────────────────────────
 *
 * "Observed history only. An edge with four hundred recorded instances has a
 * distribution. An edge with a lead time somebody typed has a single number and
 * no distribution at all... Inventing a distribution from an estimate is the
 * specific dishonesty that makes probabilistic simulation worthless, and it is
 * easy to do accidentally."
 *
 * The easy accident is a helper that takes a lead time and a plausible spread
 * and returns a sampler. There is none here. A path is sampled only where every
 * edge on it has observed quantiles; anywhere else it is computed exactly as
 * §3 computes it and the row says so.
 *
 * ── §4.4: THE LIMITATION IS STATED, NOT HIDDEN ────────────────────────────
 *
 * "No correlation between edges. Two delays that in reality share a cause are
 * sampled independently, which understates the tail. This is a known limitation
 * of the method and it is stated in the output rather than hidden."
 *
 * So `INDEPENDENCE_CAVEAT` travels with every probabilistic result, in the
 * output rather than in this comment.
 */

/** §4.4 — said in the answer, because it changes how the answer should be read. */
export const INDEPENDENCE_CAVEAT =
  'Edge delays are sampled independently. Two delays that share a cause in reality — one ' +
  'bad week at one supplier — move together, and this method cannot know that. The effect ' +
  'is that the worst outcomes are less likely here than they are in practice.';

/**
 * A lead time as history observed it: the minimum, nine deciles, the maximum.
 *
 * ELEVEN VALUES, ASCENDING. Sampling by interpolating between them cannot
 * produce a lead time shorter than the shortest ever seen or longer than the
 * longest, and it keeps whatever skew the operation has — neither of which is
 * true of a mean and a deviation, which describe a shape nobody observed.
 */
export type Quantiles = readonly number[];

export function quantilesOf(samples: readonly number[]): number[] {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;

  return [
    sorted[0]!,
    ...Array.from({ length: 9 }, (_, i) => at((i + 1) / 10)),
    sorted[sorted.length - 1]!,
  ];
}

/**
 * A repeatable stream of numbers in [0, 1).
 *
 * SEEDED, AND THAT IS NOT A TESTING CONVENIENCE. §5 compares two runs and says
 * "whether that was data moving or the graph changing"; a comparison between
 * two probabilistic runs of an unchanged scenario against unchanged data should
 * show nothing moving, and with an unseeded generator it would show noise that
 * a reader has no way to tell from a real difference. The seed is derived from
 * the run so two different runs still explore differently.
 *
 * mulberry32: small, fast, and adequate for Monte Carlo over a few thousand
 * iterations. Not for anything that needs to be unguessable.
 */
export function streamFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from a string, so a run id produces the same stream twice. */
export function seedOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * One draw from an observed distribution, by inverse transform.
 *
 * LINEAR BETWEEN NEIGHBOURING DECILES. The alternative — returning the decile
 * itself — would make every sampled lead time one of eleven values, and a
 * histogram of the result would show eleven spikes that are an artefact of the
 * storage rather than anything the operation does.
 */
export function sample(quantiles: Quantiles, u: number): number {
  const steps = quantiles.length - 1;
  const position = Math.min(steps - 1e-9, Math.max(0, u * steps));
  const lower = Math.floor(position);
  const fraction = position - lower;
  const a = quantiles[lower]!;
  const b = quantiles[Math.min(steps, lower + 1)]!;
  return a + (b - a) * fraction;
}

export interface SampledPath {
  /** Ascending edge delays along the path, as observed. Null where an edge has none. */
  quantiles: Array<Quantiles | null>;
  /** The exact accumulated delay §3 computes, used when any edge lacks observations. */
  statedDelayHours: number;
}

export interface Estimate {
  /** §4.2 — "the proportion of runs in which it was affected". */
  probability: number;
  /** §4.3 — "median delay, and the spread". */
  medianHours: number;
  p10Hours: number;
  p90Hours: number;
  /** §4.1 — true where the path was computed deterministically instead. */
  estimated: boolean;
}

/**
 * §4.2 — "Each run samples each edge's lead time from its observed distribution
 * and propagates."
 *
 * ── THE TOPOLOGY IS NOT SAMPLED ───────────────────────────────────────────
 *
 * §2.3 makes the graph a set of assertions a person confirmed. A run that
 * sometimes did not traverse a confirmed edge would be modelling doubt about
 * the edge, which is not what a lead time distribution measures and not
 * something the product has any evidence for. So every iteration reaches the
 * same records, and what varies is when.
 *
 * That is also why §6 can say "iterations multiply the arithmetic, though not
 * the queries": the walk and its entity resolution happen once.
 *
 * ── A PATH WITH ONE UNOBSERVED EDGE IS NOT SAMPLED AT ALL ────────────────
 *
 * §4.1 — "Where any edge on a path lacks observations, that path is computed
 * deterministically and the result says so per path". Not partly sampled:
 * mixing a measured distribution with a typed number produces a spread that
 * looks derived from evidence for the whole path when half of it was asserted.
 */
export function estimate(input: {
  path: SampledPath;
  iterations: number;
  horizonHours: number;
  next: () => number;
}): Estimate {
  const { path, iterations, horizonHours, next } = input;

  if (path.quantiles.some((one) => one === null)) {
    return {
      probability: path.statedDelayHours <= horizonHours ? 1 : 0,
      medianHours: path.statedDelayHours,
      p10Hours: path.statedDelayHours,
      p90Hours: path.statedDelayHours,
      estimated: true,
    };
  }

  const observed = path.quantiles as Quantiles[];
  const delays: number[] = [];
  let within = 0;

  for (let i = 0; i < iterations; i += 1) {
    let delay = 0;
    /* §4.4 — one independent draw per edge, which is the understating
       assumption the caveat names. */
    for (const quantiles of observed) delay += sample(quantiles, next());
    delays.push(delay);
    if (delay <= horizonHours) within += 1;
  }

  delays.sort((a, b) => a - b);
  const at = (fraction: number) =>
    delays[Math.min(delays.length - 1, Math.max(0, Math.ceil(fraction * delays.length) - 1))]!;

  return {
    probability: within / iterations,
    medianHours: at(0.5),
    p10Hours: at(0.1),
    p90Hours: at(0.9),
    estimated: false,
  };
}
