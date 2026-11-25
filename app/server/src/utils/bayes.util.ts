// Bayesian arithmetic for Silo's small-count decisions and, where an organisation turns it on,
// inference beyond observed evidence (decision 2026-11-11). Closed form and deterministic: no
// library, no sampling unless a seeded generator is passed. Every caller says what it assumed.
//
// - Beta-Binomial: a rate from successes and failures, with a Beta prior (default uniform,
//   Beta(1, 1)): the posterior, the probability that the rate is above a threshold, and an
//   equal-tailed credible interval or a one-sided bound.
// - Log-normal lead times: a Normal-Inverse-Gamma prior on the mean and variance of log
//   seconds, updated by observations; the posterior predictive is drawn with a seeded generator.
// - Fellegi-Sunter record matching: per-field agreement probabilities among matches (m) and
//   non-matches (u), each a Beta posterior from confirmed and rejected pairs; a pair's match
//   probability from its agreement pattern and a prior match rate.

import { createHash } from 'node:crypto';

// ----------------------------------------------------------------------------- special functions

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x), x > 0 (Lanczos, g = 7). */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) sum += LANCZOS[i]! / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

const logBeta = (a: number, b: number): number => logGamma(a) + logGamma(b) - logGamma(a + b);

/** The continued fraction of the incomplete beta function (modified Lentz). */
function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

/** The regularised incomplete beta function I_x(a, b): the CDF of Beta(a, b) at x. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(x, a, b)) / a : 1 - (front * betaFraction(1 - x, b, a)) / b;
}

/** The p-quantile of Beta(a, b), by bisection to 1e-10. */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ----------------------------------------------------------------------------- rates (Beta-Binomial)

export interface BetaPrior { a: number; b: number }
export const UNIFORM: BetaPrior = { a: 1, b: 1 };

/** The posterior of a rate after `successes` of `trials`. */
export const ratePosterior = (successes: number, trials: number, prior: BetaPrior = UNIFORM): BetaPrior =>
  ({ a: prior.a + successes, b: prior.b + Math.max(0, trials - successes) });

/** The posterior probability that the rate exceeds `threshold`. */
export function probabilityAbove(threshold: number, successes: number, trials: number, prior: BetaPrior = UNIFORM): number {
  const post = ratePosterior(successes, trials, prior);
  return 1 - betaCdf(threshold, post.a, post.b);
}

/** An equal-tailed credible interval for the rate, at `level` (default 95%). */
export function credibleInterval(successes: number, trials: number, level = 0.95, prior: BetaPrior = UNIFORM): [number, number] {
  const post = ratePosterior(successes, trials, prior);
  const tail = (1 - level) / 2;
  return [betaQuantile(tail, post.a, post.b), betaQuantile(1 - tail, post.a, post.b)];
}

/** A one-sided upper bound on the rate: below it with probability `level`. */
export function upperBound(successes: number, trials: number, level = 0.95, prior: BetaPrior = UNIFORM): number {
  const post = ratePosterior(successes, trials, prior);
  return betaQuantile(level, post.a, post.b);
}

// ----------------------------------------------------------------------------- sampling

/** A seeded uniform generator (mulberry32): the same seed draws the same numbers. */
export function seededUniform(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A standard normal draw (Box-Muller) from a seeded uniform generator. */
export function normal(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** A Gamma(shape, 1) draw (Marsaglia and Tsang), shape > 0. */
export function gamma(shape: number, random: () => number): number {
  if (shape < 1) return gamma(shape + 1, random) * Math.pow(Math.max(random(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// ----------------------------------------------------------------------------- log-normal lead times

/** A Normal-Inverse-Gamma belief about the mean (mu) and variance of log seconds. */
export interface LogNormalBelief { mu: number; kappa: number; alpha: number; beta: number }

/**
 * The prior a stated lead time gives: its median the stated value, weighted as `weight`
 * observations, with a coefficient of variation `spread` (the assumption a caller states).
 */
export function statedPrior(seconds: number, weight: number, spread: number): LogNormalBelief {
  const sigma2 = Math.log(1 + spread * spread);
  const alpha = Math.max(weight / 2, 1.01);
  return { mu: Math.log(Math.max(seconds, 1)), kappa: weight, alpha, beta: sigma2 * (alpha - 1) };
}

/** The belief after observed lead times (seconds). */
export function updateLogNormal(prior: LogNormalBelief, samples: readonly number[]): LogNormalBelief {
  const logs = samples.filter((s) => s > 0).map((s) => Math.log(s));
  const n = logs.length;
  if (n === 0) return prior;
  const mean = logs.reduce((a, b) => a + b, 0) / n;
  const ss = logs.reduce((a, b) => a + (b - mean) ** 2, 0);
  const kappa = prior.kappa + n;
  return {
    mu: (prior.kappa * prior.mu + n * mean) / kappa, kappa, alpha: prior.alpha + n / 2,
    beta: prior.beta + ss / 2 + (prior.kappa * n * (mean - prior.mu) ** 2) / (2 * kappa),
  };
}

/** One draw from the posterior predictive, in seconds. */
export function drawLogNormal(belief: LogNormalBelief, random: () => number): number {
  const variance = belief.beta / gamma(belief.alpha, random);
  const mu = belief.mu + Math.sqrt(variance / belief.kappa) * normal(random);
  return Math.exp(mu + Math.sqrt(variance) * normal(random));
}

// ----------------------------------------------------------------------------- record matching (Fellegi-Sunter)

export interface FieldEvidence {
  /** Confirmed matches compared on this field, and how many agreed. */
  matchesCompared: number;
  matchesAgreeing: number;
  /** Rejected pairs compared on this field, and how many agreed. */
  nonMatchesCompared: number;
  nonMatchesAgreeing: number;
}

/** m and u for a field: posterior means of agreement among matches and among non-matches (uniform priors). */
export function fieldWeights(e: FieldEvidence, prior: { m: BetaPrior; u: BetaPrior } = { m: { a: 9, b: 1 }, u: { a: 1, b: 9 } }): { m: number; u: number } {
  const m = ratePosterior(e.matchesAgreeing, e.matchesCompared, prior.m);
  const u = ratePosterior(e.nonMatchesAgreeing, e.nonMatchesCompared, prior.u);
  return { m: m.a / (m.a + m.b), u: u.a / (u.a + u.b) };
}

/**
 * The probability two records are the same, given per-field agreement (true), disagreement
 * (false) or absence (undefined: no evidence either way), the fields' m and u, and the prior
 * share of candidate pairs that match.
 */
export function matchProbability(agreement: readonly (boolean | undefined)[], weights: readonly { m: number; u: number }[], priorMatchRate: number): number {
  let logOdds = Math.log(priorMatchRate / (1 - priorMatchRate));
  agreement.forEach((agrees, i) => {
    const w = weights[i]!;
    if (agrees === true) logOdds += Math.log(w.m / w.u);
    else if (agrees === false) logOdds += Math.log((1 - w.m) / (1 - w.u));
  });
  return 1 / (1 + Math.exp(-logOdds));
}
