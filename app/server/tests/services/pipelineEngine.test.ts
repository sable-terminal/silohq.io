// Pipeline steps (D235): filter, compute, join, aggregate, sort, select, dedupe and limit; an error
// naming its step; CSV that cannot run as a spreadsheet formula.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSteps, StepError, toCsv, type Compile, type Table } from '../../src/services/workspace/pipelineEngine.service.ts';

// A tiny stand-in for CEL: column names and number literals with > and *, enough to test the steps.
const compile: Compile = (expression, columns) => {
  const m = /^(\w+)\s*(>|\*)\s*(\w+)$/.exec(expression);
  if (m === null) throw new Error('unsupported');
  const val = (t: string, row: Record<string, unknown>) => (columns.includes(t) ? row[t] : Number(t));
  return (row) => (m[2] === '>' ? (val(m[1]!, row) as number) > (val(m[3]!, row) as number) : (val(m[1]!, row) as number) * (val(m[3]!, row) as number));
};
const invoices: Table = { columns: ['id', 'customer', 'total'], rows: [['i1', 'c1', 10], ['i2', 'c2', 30], ['i3', 'c1', 50], ['i4', 'c3', 5], ['i4', 'c3', 5]] };
const customers: Table = { columns: ['code', 'name'], rows: [['c1', 'Acme'], ['c2', 'Globex']] };

test('filter, compute, join, aggregate, sort: invoices over 6 by customer name, with a doubled total', () => {
  const out = runSteps(new Map([['invoices', invoices], ['customers', customers]]), 'invoices', [
    { op: 'dedupe', by: [] },
    { op: 'filter', cel: 'total > 6' },
    { op: 'compute', as: 'doubled', cel: 'total * 2' },
    { op: 'join', input: 'customers', on: [['customer', 'code']], kind: 'left' },
    { op: 'aggregate', by: ['customers_name'], measures: [{ as: 'invoices', fn: 'count' }, { as: 'sum_doubled', fn: 'sum', column: 'doubled' }] },
    { op: 'sort', by: [{ column: 'sum_doubled', direction: 'desc' }] },
  ], compile);
  assert.deepEqual(out, { columns: ['customers_name', 'invoices', 'sum_doubled'], rows: [['Acme', 2, 120], ['Globex', 1, 60]] });
});

test('select renames and drops; a left join keeps rows without a match; an inner join does not', () => {
  const left = runSteps(new Map([['i', invoices], ['c', customers]]), 'i', [{ op: 'join', input: 'c', on: [['customer', 'code']], kind: 'left' }, { op: 'select', columns: [{ from: 'id' }, { from: 'c_name', as: 'name' }] }], compile);
  assert.deepEqual(left.rows.map((r) => r[1]), ['Acme', 'Globex', 'Acme', null, null]);
  const inner = runSteps(new Map([['i', invoices], ['c', customers]]), 'i', [{ op: 'join', input: 'c', on: [['customer', 'code']], kind: 'inner' }], compile);
  assert.equal(inner.rows.length, 3);
});

test('an error names its step; a row an expression fails on is left out of a filter and blank in a computed column', () => {
  assert.throws(() => runSteps(new Map([['i', invoices]]), 'i', [{ op: 'select', columns: [{ from: 'nope' }] }], compile), (e) => e instanceof StepError && e.step === 1);
  assert.throws(() => runSteps(new Map([['i', invoices]]), 'i', [{ op: 'limit', rows: 2 }, { op: 'compute', as: 'x', cel: 'not supported here' }], compile), (e) => e instanceof StepError && e.step === 2);
});

test('CSV: quoted where it must be, a leading formula character neutralised', () => {
  assert.equal(toCsv({ columns: ['a', 'b'], rows: [['=SUM(1)', 'x, "y"'], [null, 3]] }), `a,b\r\n'=SUM(1),"x, ""y"""\r\n,3\r\n`);
});
