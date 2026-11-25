// The margin floor calculator (spec 74.4, 74.7) and the invoice terms, with no database.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACTS_DEFAULTS } from '../../src/config/contracts.config.ts';
import { daysFromTerms } from '../../src/services/billing/invoicing.service.ts';
import { MEASURED_AFTER, quoteMargin, termMonths, UNMEASURED_WARNING, type QuotedTerms } from '../../src/services/billing/margin.service.ts';

const terms: QuotedTerms = {
  platformFee: 20_000, seatCount: 50, seatRate: 40, tokenAllocation: 1_000, simulationAllocation: 5, storageIncludedBytes: 100 * 1024 ** 3,
  sovereign: false, fdeOnboardingBundled: false, termStart: '2027-01-01', termEnd: '2027-12-31',
};
const unmeasured = { logged: 12, sampled: 12, meanTokens: 9_000 };

test('a term counts whole months, a part month as a month', () => {
  assert.equal(termMonths('2027-01-01', '2027-12-31'), 12);
  assert.equal(termMonths('2027-01-15', '2027-02-14'), 1);
  assert.equal(termMonths('2027-01-15', '2027-02-20'), 2);
  assert.equal(termMonths('2027-03-01', '2027-03-01'), 1);
});

test('the price, each cost term and the margin over the term (74.4)', () => {
  const q = quoteMargin(terms, { supportLoad: 2_000 }, unmeasured, CONTRACTS_DEFAULTS);
  assert.equal(q.termMonths, 12);
  assert.equal(q.price, 20_000 + 50 * 40 * 12);
  // 50 seats x 1,000 compiles x 12 months x (15,000 tokens x £1.03 per million), until measured.
  assert.equal(q.costPerCompile, 0.01545);
  assert.equal(q.cost.compiles, 9_270);
  assert.equal(q.cost.simulations, 50 * 5 * 12 * 0.5);
  assert.equal(q.cost.storage, 100 * 0.02 * 12);
  assert.equal(q.cost.support, 2_000);
  assert.equal(q.cost.total, 9_270 + 1_500 + 24 + 2_000);
  assert.equal(q.margin, Math.round(((44_000 - 12_794) / 44_000) * 10_000) / 10_000);
  assert.equal(q.belowFloor, false);
  assert.equal(q.annualValue, 44_000);
  assert.equal(q.referenceAnnualValue, 50_000);
});

test('until fifty compiles are logged every quote carries the warning; then the measured mean prices a compile (74.7)', () => {
  const before = quoteMargin(terms, {}, unmeasured, CONTRACTS_DEFAULTS);
  assert.equal(before.measured, false);
  assert.equal(before.warning, UNMEASURED_WARNING);
  const after = quoteMargin(terms, {}, { logged: MEASURED_AFTER, sampled: 50, meanTokens: 60_000 }, CONTRACTS_DEFAULTS);
  assert.equal(after.measured, true);
  assert.equal(after.warning, null);
  assert.equal(after.costPerCompile, 0.0618);
  assert.ok(after.margin < before.margin, 'longer prompts cost more');
});

test('once fifty compiles are priced at their routes\' own prices, their mean cost is the cost per compile (D106)', () => {
  const tokens = quoteMargin(terms, {}, { logged: MEASURED_AFTER, sampled: 50, meanTokens: 60_000, priced: 49, meanCost: 0.02 }, CONTRACTS_DEFAULTS);
  assert.deepEqual([tokens.costBasis, tokens.costPerCompile], ['measured_tokens', 0.0618], 'forty-nine priced is not enough');
  const priced = quoteMargin(terms, {}, { logged: MEASURED_AFTER, sampled: 50, meanTokens: 60_000, priced: 50, meanCost: 0.02 }, CONTRACTS_DEFAULTS);
  assert.deepEqual([priced.costBasis, priced.costPerCompile, priced.measured, priced.warning], ['route_prices', 0.02, true, null]);
  assert.equal(quoteMargin(terms, {}, unmeasured, CONTRACTS_DEFAULTS).costBasis, 'estimate');
});

test('a thin deal is below the floor; bundled onboarding, dedicated capacity and the sovereign uplift all cost', () => {
  const thin = quoteMargin({ ...terms, seatRate: 10, platformFee: 0 }, {}, unmeasured, CONTRACTS_DEFAULTS);
  assert.equal(thin.belowFloor, true);
  const levers = { dedicatedCapacity: 1_000, sovereignUplift: 3_000, fdeEngagementCost: 4_000 };
  const plain = quoteMargin(terms, levers, unmeasured, CONTRACTS_DEFAULTS);
  assert.equal(plain.cost.sovereign, 0, 'no uplift unless sovereign');
  assert.equal(plain.cost.fde, 0, 'no engagement cost unless bundled');
  const full = quoteMargin({ ...terms, sovereign: true, fdeOnboardingBundled: true }, levers, unmeasured, CONTRACTS_DEFAULTS);
  assert.equal(full.cost.total - plain.cost.total, 7_000);
  const free = quoteMargin({ ...terms, platformFee: 0, seatRate: 0 }, {}, unmeasured, CONTRACTS_DEFAULTS);
  assert.equal(free.margin, -1, 'a deal with cost and no price');
});

test('days until due come from the payment terms', () => {
  assert.equal(daysFromTerms('net 45'), 45);
  assert.equal(daysFromTerms('Net30 from invoice date'), 30);
  assert.equal(daysFromTerms('on receipt'), 30);
});
