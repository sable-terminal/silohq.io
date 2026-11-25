// Scenario branches' pure part (spec 39.8): the three-way staleness check of revert over a
// staged Action's bases, what a staged Action does in the walk's terms, and the refusal of
// any request naming a branch by the services that touch sources.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SCENARIO_BRANCH_HEADER, type AnyContract } from '../../src/contracts/endpoint.contract.ts';
import { refuseBranchReference } from '../../src/middleware/branch.middleware.ts';
import {
  actionStaleness, checkTarget, effectOf, RECORD_EXISTS, type StagedTarget,
} from '../../src/services/simulation/branchEffects.service.ts';

const DAY = 86_400;
const target = (entries: StagedTarget['entries'], operation: StagedTarget['operation'] = 'update_partial'): StagedTarget => ({
  objectId: '00000000-0000-4000-8000-000000000001', connectionId: '00000000-0000-4000-8000-0000000000c1', reference: 'c1', operation, entries,
});
const none = new Map<string, 'keep_staged' | 'take_current'>();

describe('staleness, three ways (spec 39.8, chapter 46)', () => {
  const staged = target([{ property: 'score', field: 'score', base: 10, staged: 55 }, { property: 'name', field: 'name', base: 'Ann', staged: 'Ann B' }]);

  test('the value now equal to the base is clean; equal to the staged value is already applied; anything else conflicts', () => {
    assert.equal(checkTarget(staged, { score: 10, name: 'Ann' }, none).staleness, 'clean');
    assert.equal(checkTarget(staged, { score: 55, name: 'Ann B' }, none).staleness, 'already_applied');
    const conflicted = checkTarget(staged, { score: 12, name: 'Ann' }, none);
    assert.equal(conflicted.staleness, 'conflicted');
    assert.deepEqual(conflicted.properties.map((p) => [p.property, p.state]), [['score', 'conflicted'], ['name', 'clean']]);
    assert.equal(checkTarget(staged, { score: 55, name: 'Ann' }, none).staleness, 'clean', 'part applied, part as based: applies as staged');
  });

  test('a decision on each conflicted property clears the conflict; a record gone is orphaned', () => {
    assert.equal(checkTarget(staged, { score: 12, name: 'Ann' }, new Map([['score', 'take_current']])).staleness, 'clean');
    assert.equal(checkTarget(staged, null, none).staleness, 'orphaned');
  });

  test('a delete is based on the record existing; a create has nothing to compare; a custom action is never already applied', () => {
    const deleting = target([{ property: RECORD_EXISTS, field: RECORD_EXISTS, base: true, staged: false }], 'delete');
    assert.equal(checkTarget(deleting, {}, none).staleness, 'clean');
    assert.equal(checkTarget(deleting, null, none).staleness, 'orphaned');
    assert.equal(checkTarget(target([{ property: 'name', field: 'name', base: null, staged: 'New' }], 'create'), null, none).staleness, 'clean');
    const custom = target([{ property: 'status', field: 'status', base: 'active', staged: null }], 'custom');
    assert.equal(checkTarget(custom, { status: null }, none).staleness, 'conflicted');
  });

  test('a staged Action over its targets: partial staleness is first-class', () => {
    const clean = checkTarget(staged, { score: 10, name: 'Ann' }, none);
    const gone = checkTarget(staged, null, none);
    const applied = checkTarget(staged, { score: 55, name: 'Ann B' }, none);
    const conflicted = checkTarget(staged, { score: 1, name: 'Ann' }, none);
    assert.equal(actionStaleness([clean, gone]), 'clean', 'a gone target is left out; the rest promote');
    assert.equal(actionStaleness([gone]), 'orphaned');
    assert.equal(actionStaleness([applied, gone]), 'already_applied');
    assert.equal(actionStaleness([clean, conflicted]), 'conflicted');
  });
});

describe('a staged Action\'s effect in the walk\'s terms (spec 39.8)', () => {
  const type = '00000000-0000-4000-8000-0000000000aa';
  const times = new Set(['due', 'ships_at']);

  test('a delete makes its target unavailable; a date moved later delays it by the largest move', () => {
    const deleting = checkTarget(target([{ property: RECORD_EXISTS, field: RECORD_EXISTS, base: true, staged: false }], 'delete'), {}, none);
    assert.deepEqual(effectOf(type, deleting, times).origin, { objectTypeId: type, objectId: deleting.objectId, delaySeconds: null });
    const moved = checkTarget(target([
      { property: 'due', field: 'due', base: '2026-12-01', staged: '2026-12-04' },
      { property: 'ships_at', field: 'ships_at', base: '2026-12-01T10:00:00Z', staged: '2026-12-02T10:00:00Z' },
    ]), { due: '2026-12-01', ships_at: '2026-12-01T10:00:00Z' }, none);
    assert.equal(effectOf(type, moved, times).origin?.delaySeconds, 3 * DAY);
  });

  test('nothing propagates from a date moved earlier, a property that is no date, a property taken as current, or a create', () => {
    const earlier = checkTarget(target([{ property: 'due', field: 'due', base: '2026-12-04', staged: '2026-12-01' }]), { due: '2026-12-04' }, none);
    assert.match(effectOf(type, earlier, times).reason ?? '', /moves no date later/);
    const score = checkTarget(target([{ property: 'score', field: 'score', base: 1, staged: 2 }]), { score: 1 }, none);
    assert.equal(effectOf(type, score, times).origin, null);
    const kept = checkTarget(target([{ property: 'due', field: 'due', base: '2026-12-01', staged: '2026-12-09' }]), { due: '2026-12-02' }, new Map([['due', 'take_current']]));
    assert.equal(effectOf(type, kept, times).origin, null);
    const created = checkTarget(target([{ property: 'due', field: 'due', base: null, staged: '2026-12-09' }], 'create'), null, none);
    assert.match(effectOf(type, created, times).reason ?? '', /no links/);
  });

  test('the move is measured from the value now, not the base', () => {
    const since = checkTarget(target([{ property: 'due', field: 'due', base: '2026-12-01', staged: '2026-12-05' }]), { due: '2026-12-03' }, new Map([['due', 'keep_staged']]));
    assert.equal(effectOf(type, since, times).origin?.delaySeconds, 2 * DAY);
  });
});

describe('the executor and connect-runtime refuse a request naming a branch (spec 39.8)', () => {
  const contract = (service: string) => ({ service, id: `${service}.x` }) as unknown as AnyContract;
  const run = (service: string, req: { headers: Record<string, string>; body?: unknown }) => {
    let passed = false;
    refuseBranchReference(contract(service))(req as never, {} as never, () => { passed = true; });
    return passed;
  };

  test('the header, or a body naming a branch, a staged Action or a promotion, is refused there and nowhere else', () => {
    assert.throws(() => run('executor', { headers: { [SCENARIO_BRANCH_HEADER]: 'b1' }, body: {} }), { code: 'branch.not_executable' });
    assert.throws(() => run('connect-runtime', { headers: {}, body: { scenarioBranchId: 'b1' } }), { code: 'branch.not_executable' });
    assert.throws(() => run('connect-runtime', { headers: {}, body: { stagedActionId: 's1' } }), { code: 'branch.not_executable' });
    assert.equal(run('executor', { headers: {}, body: { plan: {} } }), true);
    assert.equal(run('actions', { headers: {}, body: { promotion: {} } }), true, 'actions takes a promotion, from simulation');
  });
});
