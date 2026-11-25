// The Warehouse's reads as a planner source (spec 69.6; decision 2026-11-14): every value bound
// as a parameter typed by its column, in order; as-of reads from the history; aggregates with
// the engine's rules for disputes.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { aggregateCurrent, changesAfter, readAsOfCurrent } from '../../src/services/warehouse-schema/generator/warehouse.generator.ts';

const ref = { projectId: 'acme-wh', dataset: 'silo' };

describe('warehouse reads (69.6)', () => {
  test('as of: rows first observed by the instant, then the first change after it', () => {
    const current = readAsOfCurrent(ref, 'supplier', ['rating'], '2026-11-01T00:00:00.000Z', 101);
    assert.deepEqual(current.values, ['2026-11-01T00:00:00.000Z', 101]);
    assert.deepEqual(current.types, ['TIMESTAMP', 'INT64']);
    assert.match(current.text, /`_first_observed_at` is null or `_first_observed_at` <= @p1/);
    assert.match(current.text, /`rating__disputed`/);
    const later = changesAfter(ref, 'supplier__history', ['rating'], '2026-11-01T00:00:00.000Z', ['o1']);
    assert.deepEqual(later.types, ['TIMESTAMP', ['STRING'], ['STRING']]);
    assert.match(later.text, /qualify row_number\(\) over \(partition by `silo_object_id`, `property` order by `observed_at`\) = 1/);
  });

  test('aggregate: filters bound in order and typed, the first unmet filter decides a dispute, disputed keys apart', () => {
    const statement = aggregateCurrent(ref, 'supplier', {
      groupBy: ['region'],
      measures: [{ fn: 'count', column: null }, { fn: 'avg', column: 'rating' }, { fn: 'max', column: 'rating' }, { fn: 'count_distinct', column: 'name' }],
      filters: [{ column: 'rating', type: 'INT64', op: 'gte', value: 11 }, { column: 'region', type: 'STRING', op: 'in', value: ['north', 'east'] },
        { column: 'name', type: 'STRING', op: 'is_null' }],
      counted: ['region', 'rating', 'name'],
      limit: 1003,
    });
    assert.deepEqual(statement.values, [11, ['north', 'east'], 1003]);
    assert.deepEqual(statement.types, ['INT64', ['STRING'], 'INT64']);
    assert.ok(!statement.text.includes('north'), 'no value in the text');
    // Disputed at filter i only where every filter before it is met.
    assert.match(statement.text, /\(`_d0`\) or \(`_d1` and `_f0`\) or \(`_d2` and `_f0` and `_f1`\)/);
    assert.match(statement.text, /`name` is null and not coalesce\(`name__disputed`, false\)/, 'a disputed value is not empty');
    assert.match(statement.text, /when coalesce\(`region__disputed`, false\) then 'key'/);
    assert.match(statement.text, /to_json_string\(sum\(`rating`\)\) as `_m1`/);
    assert.match(statement.text, /to_json_string\(max\(`rating`\)\) as `_m2`/);
    assert.match(statement.text, /count\(distinct `name`\) as `_m3`/);
    assert.ok(!statement.text.includes('`_m0_n`'), 'a count of objects needs no column');
  });

  test('aggregate with no filters and no groups: one group of every object', () => {
    const statement = aggregateCurrent(ref, 'supplier', { groupBy: [], measures: [{ fn: 'count', column: null }], filters: [], counted: [], limit: 4 });
    assert.deepEqual(statement.values, [4]);
    assert.match(statement.text, /case when false then 'filter' when false then 'key' else 'ok' end/);
    assert.match(statement.text, /where \(true\) or \(false\)/);
  });
});
