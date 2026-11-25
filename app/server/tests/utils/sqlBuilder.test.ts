// The SQL builder for customer systems: values are always bound, identifiers always
// quoted by the dialect, and nothing chosen at run time becomes text unless it is on the
// keyword list.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DIALECTS, ident, keyword, render, sql, type SqlKeyword } from '../../src/utils/sqlBuilder.util.ts';

describe('sql builder', () => {
  test('every value is a bound parameter, in order, in each dialect\'s placeholder form', () => {
    const where = sql`${ident('status')} = ${'open'} and ${ident('amount')} > ${100}`;
    const query = sql`select ${ident('id')} from ${ident('sales', 'orders')} where ${where} limit ${50}`;
    assert.deepEqual(render(query, 'postgres'), {
      text: 'select "id" from "sales"."orders" where "status" = $1 and "amount" > $2 limit $3', values: ['open', 100, 50],
    });
    assert.equal(render(query, 'sqlserver').text, 'select [id] from [sales].[orders] where [status] = @p1 and [amount] > @p2 limit @p3');
    assert.equal(render(query, 'oracle').text, 'select "id" from "sales"."orders" where "status" = :1 and "amount" > :2 limit :3');
    assert.equal(render(query, 'mysql').text, 'select `id` from `sales`.`orders` where `status` = ? and `amount` > ? limit ?');
    assert.equal(render(query, 'bigquery').text, 'select `id` from `sales`.`orders` where `status` = @p1 and `amount` > @p2 limit @p3');
    for (const dialect of DIALECTS) assert.deepEqual(render(query, dialect).values, ['open', 100, 50], dialect);
  });

  test('an injection attempt in a value stays a value', () => {
    const hostile = "x'; drop table orders; --";
    const rendered = render(sql`select 1 from ${ident('t')} where ${ident('name')} = ${hostile}`, 'postgres');
    assert.equal(rendered.text, 'select 1 from "t" where "name" = $1');
    assert.deepEqual(rendered.values, [hostile]);
  });

  test('identifiers are escaped by each dialect, and refused where a dialect cannot hold them', () => {
    const weird = ident('a"b]c`d');
    assert.equal(render(sql`${weird}`, 'postgres').text, '"a""b]c`d"');
    assert.equal(render(sql`${weird}`, 'sqlserver').text, '[a"b]]c`d]');
    assert.equal(render(sql`${weird}`, 'mysql').text, '`a"b]c``d`');
    assert.equal(render(sql`${ident('a`b\\c')}`, 'bigquery').text, '`a\\`b\\\\c`');
    assert.throws(() => render(sql`${weird}`, 'oracle'), TypeError);
    assert.throws(() => render(sql`${ident('x'.repeat(64))}`, 'postgres'), TypeError, 'Postgres would truncate it');
    assert.throws(() => ident('bad\u0000'), TypeError);
    assert.throws(() => ident(''), TypeError);
  });

  test('run-time words come from the keyword list only', () => {
    assert.equal(render(sql`order by ${ident('created_at')} ${keyword('desc')}`, 'postgres').text, 'order by "created_at" desc');
    assert.throws(() => keyword('drop table' as SqlKeyword), TypeError);
    // A string is a value, never text, even when it looks like a keyword.
    assert.deepEqual(render(sql`order by ${ident('x')} ${'desc'}`, 'postgres'), { text: 'order by "x" $1', values: ['desc'] });
  });

  test('join and list build from fragments and bound values', () => {
    const conditions = [sql`${ident('a')} = ${1}`, sql`${ident('b')} in (${sql.list(['x', 'y'])})`];
    const rendered = render(sql`where ${sql.join(conditions, sql` and `)}`, 'postgres');
    assert.deepEqual(rendered, { text: 'where "a" = $1 and "b" in ($2, $3)', values: [1, 'x', 'y'] });
    assert.throws(() => sql.list([]), TypeError);
    assert.throws(() => sql`${undefined}`, TypeError);
  });
});
