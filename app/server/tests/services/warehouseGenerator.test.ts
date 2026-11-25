// The warehouse generator (spec 69.14): the exact text it renders, with every value bound.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addColumns, createTable, HASHES_COLUMN, ID_COLUMN, mergeCurrent, propertyColumns, readCurrent,
} from '../../src/services/warehouse-schema/generator/warehouse.generator.ts';
import { columnFor } from '../../src/services/warehouse-schema/warehouse.service.ts';

const ref = { projectId: 'silo-uklon1-abc', dataset: 'silo_warehouse' };

describe('the warehouse generator', () => {
  test('tables and columns: identifiers quoted, types constant, nothing else in the text', () => {
    assert.equal(createTable(ref, 'supplier', [ID_COLUMN, ...propertyColumns('rating', 'INT64'), HASHES_COLUMN]).text,
      'create table if not exists `silo-uklon1-abc`.`silo_warehouse`.`supplier` (`silo_object_id` STRING NOT NULL, `rating` INT64, '
      + '`rating__disputed` BOOL, `rating__sources` INT64, `_hashes` JSON)');
    assert.equal(addColumns(ref, 'supplier', [{ name: 'rating__v2', type: 'NUMERIC' }]).text,
      'alter table `silo-uklon1-abc`.`silo_warehouse`.`supplier` add column if not exists `rating__v2` NUMERIC');
    assert.equal(createTable(ref, 'a`b', [ID_COLUMN]).text.includes('`a\\`b`'), true, 'a backtick in a name is escaped');
  });

  test('rows are one bound, typed array of structs; ids are bound too', () => {
    const merge = mergeCurrent(ref, 'supplier', [ID_COLUMN, { name: 'rating', type: 'INT64' }], [{ silo_object_id: 'x', rating: 5 }]);
    assert.equal(merge.text, 'merge `silo-uklon1-abc`.`silo_warehouse`.`supplier` t using unnest(@p1) s on t.`silo_object_id` = s.`silo_object_id` '
      + 'when matched then update set `rating` = s.`rating` when not matched then insert (`silo_object_id`, `rating`) values (s.`silo_object_id`, s.`rating`)');
    assert.deepEqual(merge.values, [[{ silo_object_id: 'x', rating: 5 }]]);
    assert.deepEqual(merge.types, [[{ silo_object_id: 'STRING', rating: 'INT64' }]]);
    const read = readCurrent(ref, 'supplier', ['rating'], ['x', "y' or 1=1"]);
    assert.ok(read.text.endsWith('where `silo_object_id` in unnest(@p1)'));
    assert.deepEqual(read.values, [['x', "y' or 1=1"]]);
  });

  test('a changed type gets a versioned column; history is never rewritten', () => {
    const existing = new Map<string, 'INT64' | 'NUMERIC' | 'STRING' | undefined>([['rating', 'INT64'], ['rating__v2', 'NUMERIC']]);
    assert.deepEqual(columnFor(existing, 'rating', 'INT64'), { name: 'rating', exists: true });
    assert.deepEqual(columnFor(existing, 'rating', 'NUMERIC'), { name: 'rating__v2', exists: true });
    assert.deepEqual(columnFor(existing, 'rating', 'STRING'), { name: 'rating__v3', exists: false });
    assert.deepEqual(columnFor(existing, 'region', 'STRING'), { name: 'region', exists: false });
  });
});
