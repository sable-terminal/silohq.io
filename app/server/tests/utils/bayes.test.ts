// The Bayesian arithmetic (decision 2026-11-11): closed-form values checked against known
// results, and the seeded samplers against their means.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { seeded } from '../../src/services/simulation/montecarlo.service.ts';
import {
  betaCdf, betaQuantile, credibleInterval, drawLogNormal, fieldWeights, gamma, logGamma, matchProbability, probabilityAbove, statedPrior,
  updateLogNormal, upperBound,
} from '../../src/utils/bayes.util.ts';

const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

describe('special functions', () => {
  test('ln Γ matches factorials', () => {
    near(logGamma(5), Math.log(24), 1e-10, 'ln Γ(5)');
    near(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10, 'ln Γ(1/2)');
  });

  test('the incomplete beta function and its inverse', () => {
    near(betaCdf(0.5, 2, 2), 0.5, 1e-12, 'symmetric');
    near(betaCdf(0.9, 20, 2), 0.9 ** 20 * 3, 1e-10, 'I_x(a, 2) = x^a (a + 1 - a x)');
    near(betaQuantile(0.3, 1, 1), 0.3, 1e-9, 'uniform');
    near(betaCdf(betaQuantile(0.95, 7, 3), 7, 3), 0.95, 1e-9, 'the quantile inverts the CDF');
  });
});

describe('rates (Beta-Binomial)', () => {
  test('the chance a rate is above a threshold', () => {
    near(probabilityAbove(0.9, 19, 20), 1 - 0.9 ** 20 * 3, 1e-10, '19 of 20 under a uniform prior');
    assert.ok(probabilityAbove(0.9, 9, 10) < probabilityAbove(0.9, 90, 100), 'more evidence, more certainty');
  });

  test('none failing in a hundred: the rest fails below about 3%, with 95% confidence', () => {
    near(upperBound(0, 100), 1 - 0.05 ** (1 / 101), 1e-8, 'Beta(1, 101) 95th percentile');
    const [lo, hi] = credibleInterval(30, 100);
    assert.ok(lo < 0.3 && hi > 0.3 && hi - lo < 0.2);
  });
});

describe('sampling and lead times', () => {
  test('gamma draws have the right mean', () => {
    const random = seeded('gamma');
    let sum = 0;
    for (let i = 0; i < 20_000; i++) sum += gamma(3, random);
    near(sum / 20_000, 3, 0.05, 'mean of Gamma(3, 1)');
  });

  test('a stated lead time is the prior median; observations pull the belief towards them', () => {
    const day = 86_400;
    const prior = statedPrior(2 * day, 2, 0.5);
    const draws = (belief: ReturnType<typeof statedPrior>) => {
      const random = seeded('lead');
      const out = Array.from({ length: 4_001 }, () => drawLogNormal(belief, random)).sort((a, b) => a - b);
      return out[2_000]!;
    };
    near(draws(prior) / day, 2, 0.15, 'prior median, days');
    const posterior = updateLogNormal(prior, Array.from({ length: 50 }, () => 5 * day));
    near(draws(posterior) / day, 5, 0.6, 'fifty observations of five days outweigh a stated two');
  });
});

describe('record matching (Fellegi-Sunter)', () => {
  test('agreement on a discriminating field raises the probability; disagreement lowers it', () => {
    const email = fieldWeights({ matchesCompared: 50, matchesAgreeing: 48, nonMatchesCompared: 50, nonMatchesAgreeing: 1 });
    const city = fieldWeights({ matchesCompared: 50, matchesAgreeing: 45, nonMatchesCompared: 50, nonMatchesAgreeing: 30 });
    const prior = 0.1;
    const both = matchProbability([true, true], [email, city], prior);
    const cityOnly = matchProbability([false, true], [email, city], prior);
    const unknown = matchProbability([undefined, undefined], [email, city], prior);
    near(unknown, prior, 1e-12, 'no evidence: the prior');
    assert.ok(both > 0.8 && cityOnly < prior, `${both} ${cityOnly}`);
  });
});
