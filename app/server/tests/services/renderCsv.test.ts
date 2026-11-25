// The CSV document (spec 41.2): what travels with the figures, what is stated rather than
// left as a gap, and no formula from a source ever running on the reader's machine.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { QueryResult } from '../../src/contracts/executor/result.contract.ts';
import type { QueryPlan } from '../../src/contracts/planner/plan.contract.ts';
import { cell, renderCsv } from '../../src/services/render/csv.service.ts';

const T = '00000000-0000-7000-8000-000000000001';
const P = (n: number) => `00000000-0000-7000-8000-00000000010${n}`;

// Cast: the result object grows fields this document does not read.
const base = (over: Partial<QueryResult>): QueryResult => ({
  queryId: T, planHash: 'a'.repeat(64), ontologyVersionId: T, kind: 'objects', columns: [], measures: [], population: 2, total: 2,
  page: { index: 0, count: 0, objects: [], groups: [] },
  coverage: { objects: 2, unmatched: 1, disputed: { total: 1 }, empty: {}, unchecked: {}, excludedByDispute: 3 },
  lineage: [], periods: [], localFilters: [], aggregateForm: null, defaults: { timeFields: [], routes: [] }, cached: false,
  computedAt: '2026-11-02T09:00:00.000Z', ...over,
}) as unknown as QueryResult;

const plan = { schemaVersion: '1', ontologyVersionId: T, nodes: [{ objectTypeId: T, filters: [] }], hops: [], select: [], sort: [] } as unknown as QueryPlan;

describe('cells', () => {
  test('quoted as RFC 4180 asks', () => {
    assert.equal(cell('plain'), 'plain');
    assert.equal(cell('Brill, plc'), '"Brill, plc"');
    assert.equal(cell('say "hi"'), '"say ""hi"""');
    assert.equal(cell('two\nlines'), '"two\nlines"');
    assert.equal(cell(null), '');
    assert.equal(cell(-5), '-5', 'a number is a number');
  });

  test('text a spreadsheet would run as a formula is made inert', () => {
    for (const formula of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) assert.ok(cell(formula).replace(/^"/, '').startsWith('\''), formula);
    assert.equal(cell('=HYPERLINK("http://evil.example")'), '"\'=HYPERLINK(""http://evil.example"")"');
  });
});

describe('the document', () => {
  test('opens with its name, markings, time and coverage; omitted and masked columns say so', () => {
    const result = base({
      columns: [
        { node: 0, property: P(1), apiName: 'invoice_id', displayName: 'Invoice', dataType: 'string', effect: 'allow' },
        { node: 0, property: P(2), apiName: 'customer', displayName: 'Customer', dataType: 'string', effect: 'redact' },
        { node: 0, property: P(3), apiName: 'iban', displayName: 'IBAN', dataType: 'string', effect: 'mask' },
        { node: 0, property: P(4), apiName: 'total', displayName: 'Total', dataType: 'decimal', effect: 'allow' },
      ],
    });
    const rows = [
      { id: T, objectTypeId: T, values: { invoice_id: 'i1', iban: '****1234', total: 120 }, disputed: [], masked: ['iban'], redacted: ['customer'], unmatched: false, links: {} },
      { id: T, objectTypeId: T, values: { invoice_id: 'i2', iban: '****9876' }, disputed: ['total'], masked: ['iban'], redacted: ['customer'], unmatched: true, links: {} },
    ];
    const csv = renderCsv({ name: 'Open invoices', markings: ['Finance', 'Personal'], plan, result, rows });
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'Silo export,Open invoices');
    assert.equal(lines[1], 'Markings,Finance; Personal');
    assert.ok(csv.includes('Records without a full match key,1'));
    assert.ok(csv.includes('Objects excluded by a disputed filter value,3'));
    assert.ok(csv.includes('Disputed values,total: 1'));
    assert.ok(csv.includes('Omitted for this reader,Customer'));
    assert.ok(lines.includes('Invoice,Customer (omitted),IBAN (masked),Total'));
    assert.ok(lines.includes('i1,[omitted],****1234,120'));
    assert.ok(lines.includes('i2,[omitted],****9876,[disputed]'));
  });

  test('groups: an undecided measure is printed as undecided, with what was left out', () => {
    const result = base({
      kind: 'groups', total: 2, measures: [{ as: 'open_total', fn: 'sum', node: 0, property: P(4) }],
    });
    const rows = [
      { key: { status: 'open' }, measures: { open_total: 420 }, objects: 2, excluded: { open_total: 0 } },
      { key: { status: 'paid' }, measures: { open_total: null }, objects: 1, excluded: { open_total: 1 } },
    ];
    const csv = renderCsv({ name: 'By status', markings: [], plan, result, rows });
    assert.ok(csv.includes('Markings,None'));
    assert.ok(csv.includes('status,open_total,Objects,open_total: values left out\r\n'));
    assert.ok(csv.includes('open,420,2,0\r\n'));
    assert.ok(csv.includes('paid,[undecided],1,1\r\n'));
  });
});
