// The scheduler's pure parts: schedules in a time zone (spec 40.7) and conditions over a
// run's answer and the state kept from the last (spec 40.3).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ConditionView } from '../../src/contracts/scheduler/cron.contract.ts';
import { evaluate, type PreviousState, type RunFacts } from '../../src/services/scheduler/conditions.service.ts';
import { checkSchedule, missedBetween, nextOccurrence, occurrences, parseSchedule } from '../../src/services/scheduler/schedule.service.ts';
import { isAppError } from '../../src/utils/errors.util.ts';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

describe('schedules (spec 40.7)', () => {
  test('five fields, in the organisation\'s time zone, never the server\'s', () => {
    const daily = parseSchedule('0 9 * * *');
    // 09:00 in London is 08:00 UTC in summer and 09:00 UTC in winter.
    assert.equal(iso(nextOccurrence(daily, at('2026-07-01T10:00:00Z'), 'Europe/London')), '2026-07-02T08:00:00.000Z');
    assert.equal(iso(nextOccurrence(daily, at('2026-12-01T10:00:00Z'), 'Europe/London')), '2026-12-02T09:00:00.000Z');
    assert.equal(iso(nextOccurrence(daily, at('2026-12-01T10:00:00Z'), 'America/New_York')), '2026-12-01T14:00:00.000Z');
  });

  test('a skipped local time does not fire; a repeated one fires once, at the first', () => {
    const half = parseSchedule('30 1 * * *');
    // 29 March 2026: London's clocks go from 01:00 to 02:00, so 01:30 does not exist.
    assert.equal(iso(nextOccurrence(half, at('2026-03-28T02:00:00Z'), 'Europe/London')), '2026-03-30T00:30:00.000Z');
    // 25 October 2026: 01:30 happens twice (BST, then GMT); it fires at the first only.
    const runs = occurrences(half, at('2026-10-24T12:00:00Z'), 'Europe/London', 3).map(iso);
    assert.deepEqual(runs, ['2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z', '2026-10-27T01:30:00.000Z']);
  });

  test('lists, ranges, steps, and day of month or day of week when both are restricted', () => {
    const s = parseSchedule('0,30 8-9 * * 1-5');
    const weekdays = occurrences(s, at('2026-11-06T09:45:00Z'), 'UTC', 4).map(iso);
    // Friday 6 November after 09:45, so Monday 9 November.
    assert.deepEqual(weekdays, ['2026-11-09T08:00:00.000Z', '2026-11-09T08:30:00.000Z', '2026-11-09T09:00:00.000Z', '2026-11-09T09:30:00.000Z']);
    const either = parseSchedule('0 12 1 * 0');
    const next = occurrences(either, at('2026-11-01T13:00:00Z'), 'UTC', 2).map(iso);
    assert.deepEqual(next, ['2026-11-08T12:00:00.000Z', '2026-11-15T12:00:00.000Z'], 'Sundays, and the 1st when it comes');
    assert.equal(iso(nextOccurrence(parseSchedule('0 0 29 2 *'), at('2026-03-01T00:00:00Z'), 'UTC')), '2028-02-29T00:00:00.000Z');
    assert.equal(iso(nextOccurrence(parseSchedule('0 0 * * 7'), at('2026-11-02T00:00:00Z'), 'UTC')), '2026-11-08T00:00:00.000Z', '7 is Sunday too');
  });

  test('refused: the wrong number of fields, names, out of range, and runs closer than the minimum interval', () => {
    for (const bad of ['* * * *', '0 9 * * MON', '60 * * * *', '0 24 * * *', '0 0 0 * *', '*/0 * * * *', '5-1 * * * *', '0 0 L * *']) {
      assert.throws(() => parseSchedule(bad), (e: unknown) => isAppError(e) && e.code === 'scheduler.schedule_invalid', bad);
    }
    assert.throws(() => checkSchedule('*/5 * * * *', 'UTC', 15, at('2026-11-02T00:00:00Z')),
      (e: unknown) => isAppError(e) && e.code === 'scheduler.interval_too_short' && e.category === 'bounds');
    assert.doesNotThrow(() => checkSchedule('*/15 * * * *', 'UTC', 15, at('2026-11-02T00:00:00Z')));
    assert.throws(() => checkSchedule('0 0 31 2 *', 'UTC', 15, at('2026-11-02T00:00:00Z')), /never fires/);
  });

  test('missed runs are counted, never run', () => {
    const daily = parseSchedule('0 9 * * *');
    assert.equal(missedBetween(daily, at('2026-11-01T09:00:00Z'), at('2026-11-04T10:00:00Z'), 'UTC'), 3);
    assert.equal(missedBetween(daily, at('2026-11-01T09:00:00Z'), at('2026-11-01T09:30:00Z'), 'UTC'), 0);
  });
});

// ----------------------------------------------------------------------------- conditions

let next = 0;
const node = (kind: ConditionView['kind'], operator: string | null, value: unknown = null, target: unknown = null,
  combinator: 'AND' | 'OR' | null = null, operands: ConditionView[] = []): ConditionView =>
  ({ id: `00000000-0000-7000-8000-${String(next += 1).padStart(12, '0')}`, kind, operator, value, target, combinator, operands });
const facts = (total: number, figure?: number, resultHash?: string): RunFacts => ({ total, resultHash, figure: () => figure });
const none: PreviousState = { resultHash: null, rowCount: null, figures: {} };
const NOW = at('2026-11-02T12:00:00Z');

describe('conditions (spec 40.3)', () => {
  test('no condition is a schedule that always fires; result conditions read the answer\'s size', () => {
    assert.equal(evaluate(null, facts(0), none, NOW).outcome, 'met');
    assert.equal(evaluate(node('result', 'returned_rows'), facts(2), none, NOW).outcome, 'met');
    assert.equal(evaluate(node('result', 'returned_rows'), facts(0), none, NOW).outcome, 'not_met');
    assert.equal(evaluate(node('result', 'returned_none'), facts(0), none, NOW).outcome, 'met');
  });

  test('a count crosses a threshold when it is past it now and was not at the last run', () => {
    const above10 = node('result', 'count_crossed', { threshold: 10, direction: 'above' });
    assert.equal(evaluate(above10, facts(12), none, NOW).outcome, 'met', 'first run, past it');
    assert.equal(evaluate(above10, facts(12), { ...none, rowCount: 11 }, NOW).outcome, 'not_met', 'already past it');
    assert.equal(evaluate(above10, facts(12), { ...none, rowCount: 9 }, NOW).outcome, 'met');
    assert.equal(evaluate(above10, facts(9), { ...none, rowCount: 12 }, NOW).outcome, 'not_met');
  });

  test('differs from previous compares keyed hashes; the first run sets the baseline', () => {
    const differs = node('result', 'differs_from_previous');
    const first = evaluate(differs, facts(2, undefined, 'aa'), none, NOW);
    assert.equal(first.outcome, 'not_met');
    assert.equal(first.next.resultHash, 'aa');
    assert.equal(evaluate(differs, facts(2, undefined, 'aa'), { ...none, resultHash: 'aa' }, NOW).outcome, 'not_met');
    assert.equal(evaluate(differs, facts(2, undefined, 'bb'), { ...none, resultHash: 'aa' }, NOW).outcome, 'met');
  });

  test('value conditions over one figure; an undecided figure is indeterminate, never a quiet no', () => {
    const above = node('value', 'above', { threshold: 100 }, { measure: 'open_total' });
    assert.equal(evaluate(above, facts(1, 120), none, NOW).outcome, 'met');
    assert.equal(evaluate(above, facts(1, 80), none, NOW).outcome, 'not_met');
    assert.equal(evaluate(above, facts(1, undefined), none, NOW).outcome, 'indeterminate');
    const moved = node('value', 'changed_by_proportion', { proportion: 0.1 }, { measure: 'open_total' });
    const baseline = evaluate(moved, facts(1, 100), none, NOW);
    assert.equal(baseline.outcome, 'not_met');
    assert.equal(evaluate(moved, facts(1, 111), baseline.next as PreviousState, NOW).outcome, 'met');
    assert.equal(evaluate(moved, facts(1, 105), baseline.next as PreviousState, NOW).outcome, 'not_met');
    const still = node('value', 'unchanged_for', { hours: 24 }, { measure: 'open_total' });
    const kept = evaluate(still, facts(1, 50), none, NOW).next as PreviousState;
    assert.equal(evaluate(still, facts(1, 50), kept, NOW + 23 * 3_600_000).outcome, 'not_met');
    const later = evaluate(still, facts(1, 50), kept, NOW + 25 * 3_600_000);
    assert.equal(later.outcome, 'met');
    assert.equal(later.next.figures['measure:open_total']!.changedAt, new Date(NOW).toISOString(), 'an unchanged figure keeps when it last changed');
  });

  test('composites: AND and OR, with indeterminate between met and not met', () => {
    const met = node('result', 'returned_rows');
    const notMet = node('result', 'returned_none');
    const unknown = node('value', 'above', { threshold: 1 }, { measure: 'x' });
    const and = (...o: ConditionView[]) => node('composite', null, null, null, 'AND', o);
    const or = (...o: ConditionView[]) => node('composite', null, null, null, 'OR', o);
    assert.equal(evaluate(and(met, notMet), facts(2), none, NOW).outcome, 'not_met');
    assert.equal(evaluate(and(met, unknown), facts(2), none, NOW).outcome, 'indeterminate');
    assert.equal(evaluate(and(notMet, unknown), facts(2), none, NOW).outcome, 'not_met');
    assert.equal(evaluate(or(notMet, unknown), facts(2), none, NOW).outcome, 'indeterminate');
    assert.equal(evaluate(or(unknown, met), facts(2), none, NOW).outcome, 'met');
    assert.equal(evaluate(or(notMet, and(met, met)), facts(2), none, NOW).outcome, 'met');
  });
});
