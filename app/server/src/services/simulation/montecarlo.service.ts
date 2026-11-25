// Probabilistic propagation (spec 39.5): Monte Carlo over the confirmed graph, only where
// evidence supports it. Each iteration samples each observed edge's lead time from its own
// observations (the empirical distribution, never a shape fitted to it) and walks the path
// with the deterministic rules. A path with any edge lacking observations is computed
// deterministically, and its result says so: a stated lead time is never widened into a range.
//
// Per affected object: the probability of being affected, the median delay and the spread,
// with every edge's sample size beside it; never a single headline probability for a
// scenario. Edges are sampled independently, which understates the tail; every probabilistic
// output says so. The iteration count is bounded and stated. The draws are seeded from the
// run, so a run can be reproduced.

import { createHash } from 'node:crypto';
import { drawLogNormal, statedPrior, updateLogNormal, type LogNormalBelief } from '../../utils/bayes.util.ts';

export const DEFAULT_ITERATIONS = 1_000;
export const MAX_ITERATIONS = 10_000;
export const INDEPENDENCE_STATEMENT = 'Edges are sampled independently: two delays that share a cause are not correlated here, which understates the tail.';

export interface PathEdge {
  id: string;
  kind: 'hard' | 'soft' | 'resource';
  leadSeconds: number;
  bufferSeconds: number;
  /** Observed lead times in seconds, for an edge whose source is history; null where it has none. */
  samples: readonly number[] | null;
}

/**
 * One walk of a path, as the deterministic rules have it: from a failure (null), a hard edge
 * fails the next object and a soft edge delays it by its lead less its buffer; a delay loses
 * each edge's buffer, and a buffer that absorbs it ends the path. undefined: not affected.
 */
export function pathOutcome(path: readonly PathEdge[], origin: number | null, lead: (e: PathEdge) => number): number | null | undefined {
  let d = origin;
  for (const e of path) {
    if (d === null) d = e.kind === 'hard' ? null : Math.max(lead(e) - e.bufferSeconds, 0);
    else {
      d -= e.bufferSeconds;
      if (d <= 0) return undefined;
    }
  }
  return d;
}

export const observed = (path: readonly PathEdge[]): boolean => path.length > 0 && path.every((e) => e.samples !== null && e.samples.length > 0);

/** A seeded generator (mulberry32): the same run draws the same numbers. */
export function seeded(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const rank = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;

export interface PathResult {
  probability: number;
  /** The object fails outright in every iteration that reaches it. */
  fails: boolean;
  /** Seconds, over the iterations that delay it; null where it fails. */
  median: number | null;
  p10: number | null;
  p90: number | null;
  iterations: number;
}

// Inference beyond observations (decision 2026-11-11; D72), only where the organisation turns it on.
/** A stated lead time as the prior median, weighted as this many observations, with this coefficient of variation. */
export const PRIOR_WEIGHT = 2;
export const PRIOR_SPREAD = 0.5;
export const INFERENCE_STATEMENT = `Paths marked inferred go beyond observed history, because your organisation turned simulation inference on: each edge's lead time is a log-normal belief with its stated lead time as the median, weighted as ${PRIOR_WEIGHT} observations with a ${PRIOR_SPREAD * 100}% spread, updated by whatever was observed. Observed-only paths are unchanged.`;

/** An edge's lead-time belief: the stated lead time as a prior, updated by its observations. */
export const beliefOf = (e: PathEdge): LogNormalBelief => updateLogNormal(statedPrior(e.leadSeconds, PRIOR_WEIGHT, PRIOR_SPREAD), e.samples ?? []);

export function simulatePath(path: readonly PathEdge[], origin: number | null, iterations: number, random: () => number,
  infer = false): PathResult {
  let affected = 0;
  let failed = 0;
  const delays: number[] = [];
  const beliefs = infer ? new Map(path.map((e) => [e.id, beliefOf(e)])) : undefined;
  for (let i = 0; i < iterations; i += 1) {
    const out = pathOutcome(path, origin, (e) => (beliefs !== undefined ? drawLogNormal(beliefs.get(e.id)!, random)
      : e.samples !== null && e.samples.length > 0 ? e.samples[Math.floor(random() * e.samples.length)]! : e.leadSeconds));
    if (out === undefined) continue;
    affected += 1;
    if (out === null) failed += 1;
    else delays.push(out);
  }
  delays.sort((a, b) => a - b);
  const fails = affected > 0 && failed === affected;
  return {
    probability: Math.round((affected / iterations) * 10_000) / 10_000, fails, iterations,
    median: delays.length === 0 ? null : rank(delays, 0.5), p10: delays.length === 0 ? null : rank(delays, 0.1), p90: delays.length === 0 ? null : rank(delays, 0.9),
  };
}
