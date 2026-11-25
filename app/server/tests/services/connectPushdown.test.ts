// The pushdown compiler's rules (spec 14.5): only what the manifest declares is pushed
// down, and a limit or sort only when nothing residual could change its meaning; and the
// SQL engine's generated statement in each dialect.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { manifestSchema, type Manifest } from '../../src/contracts/connect/manifest.contract.ts';
import { planStep, type PlanStepInput } from '../../src/contracts/connect/step.contract.ts';
import { selectStatement } from '../../src/services/connect-runtime/protocols/sql/query.protocol.ts';
import { applyResidual } from '../../src/services/connect-runtime/engine.service.ts';
import { objectOf, restPatches, splitPushdown } from '../../src/services/pushdown-compiler/compile.service.ts';

const sqlManifest = (dialect: string): Manifest => manifestSchema.parse({
  schemaVersion: '1', identity: { name: 'Orders', provider: 'Example', version: '1.0.0' }, transport: { viaAgent: true },
  protocol: { kind: 'sql', dialect }, auth: { strategy: 'none' },
  objects: [{
    name: 'orders', identifier: ['id'],
    fields: [{ name: 'id', type: 'integer' }, { name: 'region', type: 'string', column: 'Region Name' }, { name: 'amount', type: 'number' },
      { name: 'note', type: 'string' }],
    source: { kind: 'sql', schema: 'sales', table: 'orders' },
    pushdown: {
      filters: [{ field: 'id', ops: ['eq', 'in', 'gt'] }, { field: 'note', ops: ['contains'] }],
      sort: [{ field: 'amount' }],
      aggregates: { functions: ['count', 'sum'], groupBy: true },
    },
  }],
});

const restManifest: Manifest = manifestSchema.parse({
  schemaVersion: '1', identity: { name: 'CRM', provider: 'Example', version: '1.0.0' }, transport: { viaAgent: false, baseUrl: 'https://api.example.com' },
  protocol: { kind: 'rest' }, auth: { strategy: 'none' }, params: [{ name: 'portal', label: 'Portal' }],
  objects: [{
    name: 'deals', identifier: ['id'], fields: [{ name: 'id', type: 'string' }, { name: 'stage', type: 'string' }, { name: 'amount', type: 'number' }],
    source: { kind: 'rest', request: { method: 'GET', path: '/deals' }, records: { jsonata: 'items' } },
    pushdown: {
      filters: [
        { field: 'stage', ops: ['eq', 'in'], patch: { cel: 'op == "in" ? {"query": {"stages": value.join(",")}} : {"query": {"stage": value}}' } },
      ],
      sort: [{ field: 'amount', patch: { cel: '{"query": {"order": field + ":" + direction, "portal": params.portal}}' } }],
      limit: { patch: { cel: '{"query": {"per_page": string(limit)}}' } },
    },
  }],
});

const split = (m: Manifest, step: PlanStepInput) => splitPushdown(m, objectOf(m, step.object), planStep.parse(step));

describe('the split (spec 14.5)', () => {
  const m = sqlManifest('postgres');

  test('a filter is native exactly when its field and operator are declared', () => {
    const s = split(m, { object: 'orders', filters: [{ field: 'id', op: 'gt', value: 3 }, { field: 'id', op: 'lt', value: 9 }, { field: 'region', op: 'eq', value: 'n' }] });
    assert.deepEqual(s.native.filters.map((f) => f.op), ['gt']);
    assert.deepEqual(s.residual.filters.map((f) => `${f.field}.${f.op}`), ['id.lt', 'region.eq']);
  });

  test('a limit is native only when nothing residual could change which rows it keeps', () => {
    assert.equal(split(m, { object: 'orders', limit: 5 }).native.limit, 5);
    assert.equal(split(m, { object: 'orders', limit: 5, sort: [{ field: 'amount', direction: 'desc' }] }).native.limit, 5);
    const residualFilter = split(m, { object: 'orders', limit: 5, filters: [{ field: 'region', op: 'eq', value: 'n' }] });
    assert.equal(residualFilter.native.limit, null);
    assert.equal(residualFilter.residual.limit, 5);
    const residualSort = split(m, { object: 'orders', limit: 5, sort: [{ field: 'amount' }, { field: 'region' }] });
    assert.deepEqual([residualSort.native.sort, residualSort.native.limit], [[], null], 'sort is native only as a whole');
  });

  test('an aggregate is native when every function, grouping and filter is', () => {
    const native = split(m, { object: 'orders', aggregate: { groupBy: ['region'], measures: [{ fn: 'sum', field: 'amount', as: 'total' }] }, sort: [{ field: 'total', direction: 'desc' }], limit: 2 });
    assert.ok(native.native.aggregate !== null);
    assert.deepEqual([native.native.sort.length, native.native.limit], [1, 2]);
    const avg = split(m, { object: 'orders', aggregate: { measures: [{ fn: 'avg', field: 'amount', as: 'mean' }] } });
    assert.equal(avg.native.aggregate, null);
    const filtered = split(m, { object: 'orders', filters: [{ field: 'region', op: 'eq', value: 'n' }], aggregate: { measures: [{ fn: 'count', as: 'n' }] } });
    assert.equal(filtered.native.aggregate, null, 'a residual filter must apply before the aggregate');
    assert.equal(split(restManifest, { object: 'deals', aggregate: { measures: [{ fn: 'count', as: 'n' }] } }).native.aggregate, null, 'REST never aggregates at source');
  });

  test('unknown fields are refused', () => {
    assert.throws(() => split(m, { object: 'orders', fields: ['nope'] }), { code: 'step.field_unknown' });
    assert.throws(() => split(m, { object: 'orders', sort: [{ field: 'total' }] }), { code: 'step.field_unknown' });
  });

  test('REST: the native part becomes the manifest\'s patches, with parameters', async () => {
    const object = objectOf(restManifest, 'deals');
    const s = splitPushdown(restManifest, object, planStep.parse({
      object: 'deals', filters: [{ field: 'stage', op: 'in', value: ['won', 'lost'] }], sort: [{ field: 'amount', direction: 'desc' }], limit: 20,
    }));
    assert.deepEqual(await restPatches(object, s.native, { portal: 'p-9' }, new Date()), [
      { query: { stages: 'won,lost' } }, { query: { order: 'amount:desc', portal: 'p-9' } }, { query: { per_page: '20' } },
    ]);
  });

  test('the residual part: filter, aggregate, sort, limit, nulls last', () => {
    const rows = [{ r: 'n', a: 3 }, { r: 's', a: 1 }, { r: 'n', a: null }, { r: 's', a: 5 }, { r: 'e', a: 2 }];
    assert.deepEqual(applyResidual(rows, {
      filters: [{ field: 'a', op: 'is_not_null' }], aggregate: { groupBy: ['r'], measures: [{ fn: 'sum', field: 'a', as: 't' }, { fn: 'count', as: 'n' }] },
      sort: [{ field: 't', direction: 'desc' }], limit: 2,
    }), [{ r: 's', t: 6, n: 2 }, { r: 'n', t: 3, n: 1 }]);
    assert.deepEqual(applyResidual(rows, { filters: [], aggregate: null, sort: [{ field: 'a', direction: 'asc' }], limit: null }).map((r) => r.a), [1, 2, 3, 5, null]);
  });
});

describe('generated SQL in each dialect', () => {
  const step = (m: Manifest) => split(m, {
    object: 'orders', filters: [{ field: 'id', op: 'in', value: [1, 2] }, { field: 'note', op: 'contains', value: '50%_off' }],
    sort: [{ field: 'amount', direction: 'desc' }], limit: 10,
  }).native;
  const fields = (m: Manifest) => objectOf(m, 'orders').fields.slice(0, 2);
  const statement = (dialect: string) => {
    const m = sqlManifest(dialect);
    return selectStatement(dialect as never, objectOf(m, 'orders'), step(m), fields(m), 10);
  };

  test('postgres: quoted identifiers, numbered placeholders, LIMIT, LIKE ... ESCAPE', () => {
    const s = statement('postgres');
    assert.equal(s.text, 'select "id" as "id", "Region Name" as "region" from "sales"."orders" where "id" in ($1, $2) and "note" like $3 escape \'!\' order by "amount" desc limit $4');
    assert.deepEqual(s.values, [1, 2, '%50!%!_off%', 10]);
  });

  test('sqlserver: brackets, named placeholders, OFFSET ... FETCH', () => {
    const s = statement('sqlserver');
    assert.match(s.text, /^select \[id\] as \[id\], \[Region Name\] as \[region\] from \[sales\]\.\[orders\] where \[id\] in \(@p1, @p2\)/);
    assert.match(s.text, /order by \[amount\] desc offset 0 rows fetch next @p4 rows only$/);
    const m = sqlManifest('sqlserver');
    const unordered = selectStatement('sqlserver', objectOf(m, 'orders'), split(m, { object: 'orders', limit: 3 }).native, fields(m), 3);
    assert.match(unordered.text, /order by \(select null\) offset 0 rows fetch next @p1 rows only$/);
  });

  test('oracle: FETCH FIRST; mysql: backticks and ?; bigquery: backslash LIKE escapes, no ESCAPE clause', () => {
    assert.match(statement('oracle').text, /order by "amount" desc fetch first :4 rows only$/);
    assert.match(statement('mysql').text, /^select `id` as `id`.* where `id` in \(\?, \?\) and `note` like \? escape '!' order by `amount` desc limit \?$/);
    const bq = statement('bigquery');
    assert.match(bq.text, /`note` like @p3 order by/);
    assert.equal(bq.values[2], '%50\\%\\_off%');
  });

  test('an aggregate statement: functions from the keyword list, aliases quoted, grouped by column', () => {
    const m = sqlManifest('postgres');
    const s = selectStatement('postgres', objectOf(m, 'orders'),
      split(m, { object: 'orders', aggregate: { groupBy: ['region'], measures: [{ fn: 'count', as: 'n' }, { fn: 'sum', field: 'amount', as: 'total' }] } }).native,
      [], 101);
    assert.equal(s.text, 'select "Region Name" as "region", count(*) as "n", sum("amount") as "total" from "sales"."orders" group by "Region Name" limit $1');
  });
});
