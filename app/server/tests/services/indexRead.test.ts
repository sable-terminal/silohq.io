// The planner's read of an Object Index (spec 69.6; decision 2026-11-14): every value bound as
// a parameter with its column's type, in order; the keys of a split plan as a semi-join; and
// an entry returned only where the reader satisfies every marking of the columns read.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { selectEntries } from '../../src/services/warehouse-schema/generator/index.generator.ts';

const ref = { projectId: 'silo-siloes', dataset: 'oi_acme' };

describe('index read (69.6)', () => {
  test('filters, keys and markings: values bound in order, each typed by its column', () => {
    const statement = selectEntries(ref, 'ix__abc', {
      select: ['name', 'status'],
      filters: [{ column: 'status', type: 'STRING', op: 'eq', value: 'open' }, { column: 'amount', type: 'NUMERIC', op: 'gte', value: 100 },
        { column: 'region', type: 'STRING', op: 'in', value: ['north', 'south'] }, { column: 'closed', type: 'DATE', op: 'is_null' }],
      keys: ['o1', 'o2'], satisfied: ['m1'], limit: 50,
    });
    assert.deepEqual(statement.values, ['open', 100, ['north', 'south'], ['o1', 'o2'], ['m1'], 50]);
    assert.deepEqual(statement.types, ['STRING', 'NUMERIC', ['STRING'], ['STRING'], ['STRING'], 'INT64']);
    assert.match(statement.text, /`closed` is null\), false\)/, 'no dispute recorded: empty is empty');
    assert.ok(!statement.text.includes('open') && !statement.text.includes('north'), 'no value in the text');
    for (const column of ['name', 'status', 'amount', 'region', 'closed']) {
      assert.ok(statement.text.includes(`\`${column}__markings\``) || statement.text.includes(column), column);
    }
    assert.match(statement.text, /not exists \(select 1 from unnest\(array_concat\(`_marking_ids`/);
    assert.match(statement.text, /coalesce\(\(`status` = @p1\), false\) as `_f0`, false as `_d0`/, 'nothing disputable: nothing excluded on a dispute');
  });

  test('disputes as the engine treats them: a disputed value is not empty, and the first unmet filter decides', () => {
    const statement = selectEntries(ref, 'ix__abc', {
      select: ['name', 'region'], filters: [{ column: 'region', type: 'STRING', op: 'eq', value: 'north' }, { column: 'name', type: 'STRING', op: 'is_null' }],
      keys: null, satisfied: [], limit: 10, stated: ['name', 'region'],
    });
    assert.deepEqual(statement.values, ['north', [], 10]);
    assert.match(statement.text, /`name` is null and not coalesce\(`name__state` = 'disputed', false\)/);
    assert.match(statement.text, /\(`_d0`\) or \(`_d1` and `_f0`\)\) as `_excluded`/);
    assert.match(statement.text, /`region__state` as `region__state`/);
  });

  test('no filters and no keys reads the satisfied entries, bounded', () => {
    const statement = selectEntries(ref, 'ix__abc', { select: ['name'], filters: [], keys: null, satisfied: [], limit: 10 });
    assert.deepEqual(statement.values, [[], 10]);
    assert.match(statement.text, /where true/);
    assert.match(statement.text, /from f where \(true\) or \(false\)/);
  });
});
