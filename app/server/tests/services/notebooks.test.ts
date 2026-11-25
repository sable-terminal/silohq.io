// Notebooks (D239): cells computed in order for whoever runs them, as them, nothing read stored:
// objects from a saved set, a compiled plan's answer, steps over an earlier table, statistics and
// a chart; a cell whose table cannot be made says why, and so does each cell that reads it. A
// question cell's plan is set only by asking it (the asking itself is notebookQuestions.test.ts's,
// over a recording engine). Shared to open; exported into Files as a sheet per table. Real
// processes: the files cell.

import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { compilePlan } from '../../src/contracts/compile/compile.contract.ts';
import { downloadFile } from '../../src/contracts/files/file.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import {
  askNotebookQuestion, createNotebook, exportNotebook, getNotebook, runNotebook, saveNotebook, shareNotebook, type NotebookDocument,
} from '../../src/contracts/workspace/notebook.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createFilesCell, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let setId: string;
let notebookId: string;
let lockVersion: number;

before(async () => {
  f = await createFilesCell();
  setId = (await f.gateway.call(saveObjectSet, {
    body: { name: 'All invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } } },
  }, f.keyed(f.member))).id;
});

after(async () => {
  await f?.close();
});

const doc = (extra: NotebookDocument['cells'] = []): NotebookDocument => ({
  schemaVersion: '1',
  cells: [
    { id: 'intro', kind: 'text', text: 'Receivables by status.' },
    { id: 'read', kind: 'objects', name: 'invoices', objectSetId: setId, propertyIds: [f.prop('invoice_id'), f.prop('status'), f.prop('total')], limit: 100, withIds: false },
    { id: 'shape', kind: 'transform', name: 'by_status', input: 'invoices', steps: [{ op: 'aggregate', by: ['status'], measures: [{ as: 'owed', fn: 'sum', column: 'total' }, { as: 'n', fn: 'count' }] }, { op: 'sort', by: [{ column: 'owed', direction: 'desc' }] }] },
    { id: 'summary', kind: 'stats', source: 'invoices', columns: ['total', 'status'] },
    { id: 'bars', kind: 'chart', source: 'by_status', chart: 'bar', x: 'status', y: 'owed', bins: 20 },
    ...extra,
  ],
});

describe('notebooks (D239)', () => {
  test('cells computed in order for the owner: objects, a transform, statistics and a chart; nothing read is stored', async () => {
    const made = await f.gateway.call(createNotebook, { body: { name: 'Receivables' } }, f.keyed(f.member));
    notebookId = made.id;
    const saved = await f.gateway.call(saveNotebook, { params: { notebookId }, body: { document: doc(), lockVersion: made.lockVersion } }, f.cell.as(f.member));
    lockVersion = saved.lockVersion;
    const { outputs } = await f.gateway.call(runNotebook, { params: { notebookId }, body: {} }, f.cell.as(f.member));
    const out = (id: string) => outputs.find((o) => o.cellId === id)!;
    assert.deepEqual([out('intro').output, out('intro').refused], [null, null]);
    const read = out('read').output;
    assert.equal(read?.kind, 'table');
    if (read?.kind === 'table') assert.deepEqual([read.columns, read.total], [['invoice_id', 'status', 'total'], 3]);
    const shaped = out('shape').output;
    if (shaped?.kind === 'table') assert.deepEqual(shaped.rows, [['open', 420, 2], ['paid', 80, 1]]);
    const summary = out('summary').output;
    if (summary?.kind === 'stats') {
      assert.deepEqual([summary.columns[0]!.numeric?.min, summary.columns[0]!.numeric?.max, summary.columns[0]!.numeric?.median], [80, 300, 120]);
      assert.deepEqual(summary.columns[1]!.top[0], { value: 'open', count: 2 });
    } else assert.fail('statistics');
    const bars = out('bars').output;
    assert.deepEqual(bars?.kind === 'chart' ? bars.bars : undefined, [{ label: 'open', value: 420 }, { label: 'paid', value: 80 }]);
    const stored = JSON.stringify((await f.gateway.call(getNotebook, { params: { notebookId } }, f.cell.as(f.member))).document);
    assert.ok(!stored.includes('Brill'), 'what the cells read is never kept');
  });

  test('a cell whose table cannot be made says why, and so does each cell reading it; a step\'s error names the step', async () => {
    const broken = doc();
    (broken.cells[2] as Extract<NotebookDocument['cells'][number], { kind: 'transform' }>).steps = [{ op: 'select', columns: [{ from: 'nope' }] }];
    const { outputs } = await f.gateway.call(runNotebook, { params: { notebookId }, body: { document: broken } }, f.cell.as(f.member));
    assert.equal(outputs.find((o) => o.cellId === 'shape')!.refused, 'step 1: there is no column nope at this step');
    assert.equal(outputs.find((o) => o.cellId === 'bars')!.refused, 'its table by_status could not be made');
    assert.ok(outputs.find((o) => o.cellId === 'summary')!.refused === null, 'the rest stand');
    await assert.rejects(f.gateway.call(saveNotebook, { params: { notebookId }, body: { document: { schemaVersion: '1', cells: [{ id: 'x', kind: 'stats', source: 'nothing', columns: [] }] }, lockVersion } }, f.cell.as(f.member)));
  });

  test('a question cell: its plan set only by asking, in a saved cell of the version read; a compiled plan runs for each reader', async () => {
    const withQuestion = doc([{ id: 'ask', kind: 'question', name: 'by_customer', label: 'Totals by customer', planId: null, bindingId: uuidv7() }]);
    const saved = await f.gateway.call(saveNotebook, { params: { notebookId }, body: { document: withQuestion, lockVersion } }, f.cell.as(f.member));
    lockVersion = saved.lockVersion;
    const forged = structuredClone(withQuestion);
    (forged.cells.at(-1) as { planId: string | null }).planId = uuidv7();
    await assert.rejects(f.gateway.call(saveNotebook, { params: { notebookId }, body: { document: forged, lockVersion } }, f.cell.as(f.member)), { code: 'workspace.notebook_plan_not_asked' });
    await assert.rejects(f.gateway.call(askNotebookQuestion, { params: { notebookId }, body: { cellId: 'nope', question: 'Total owed by customer', lockVersion } }, f.keyed(f.member)),
      { code: 'workspace.notebook_cell_unknown' });
    await assert.rejects(f.gateway.call(askNotebookQuestion, { params: { notebookId }, body: { cellId: 'ask', question: 'Total owed by customer', lockVersion: lockVersion - 1 } }, f.keyed(f.member)),
      { code: 'workspace.notebook_stale' });
    const notAsked = (await f.gateway.call(runNotebook, { params: { notebookId }, body: {} }, f.cell.as(f.member))).outputs.find((o) => o.cellId === 'ask')!;
    assert.equal(notAsked.refused, 'not asked yet');

    // A plan in the cell, as asking would have put it (here a structured plan, which binds nothing).
    const plan = await f.gateway.call(compilePlan, {
      body: {
        plan: {
          schemaVersion: '1', ontologyVersionId: f.manifest.version.id, nodes: [{ objectTypeId: invoiceType(f.manifest), filters: [] }], hops: [], select: [], sort: [],
          aggregate: { groupBy: [{ node: 0, property: f.prop('customer') }], measures: [{ fn: 'sum', node: 0, property: f.prop('total'), as: 'owed' }] },
        },
        execute: false,
      },
    }, f.cell.as(f.member));
    assert.ok(plan.outcome === 'plan' || plan.outcome === 'answer');
    const planId = plan.planId;
    await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `update workspace.notebooks set document = jsonb_set(document, '{cells,5,planId}', to_jsonb($2::text)) where id = $1`, [notebookId, planId]));
    const answered = (await f.gateway.call(runNotebook, { params: { notebookId }, body: {} }, f.cell.as(f.member))).outputs.find((o) => o.cellId === 'ask')!;
    assert.equal(answered.refused, null, JSON.stringify(answered));
    if (answered.output?.kind === 'table') assert.equal(answered.output.total, 3);
  });

  test('shared to open: run for the recipient as them; only its owner runs a draft; exported into Files as a sheet per table', async () => {
    await f.gateway.call(shareNotebook, { params: { notebookId }, body: { grantee: { kind: 'membership', membershipId: f.outsider.membershipId }, access: 'view' } }, f.cell.as(f.member));
    const theirs = await f.gateway.call(runNotebook, { params: { notebookId }, body: {} }, f.cell.as(f.outsider));
    // The outsider has no grant on the connection: the set is not read for them, and every cell after says so.
    assert.ok(theirs.outputs.find((o) => o.cellId === 'read')!.refused !== null, JSON.stringify(theirs.outputs[1]));
    assert.equal(theirs.outputs.find((o) => o.cellId === 'shape')!.refused, 'its table invoices could not be made');
    await assert.rejects(f.gateway.call(runNotebook, { params: { notebookId }, body: { document: doc() } }, f.cell.as(f.outsider)), { code: 'workspace.notebook_draft_not_yours' });

    const { file } = await f.gateway.call(exportNotebook, { params: { notebookId }, body: {} }, f.keyed(f.member));
    assert.equal(file.name, 'Receivables.xlsx');
    const got = await f.gateway.call(downloadFile, { params: { fileId: file.id } }, f.cell.as(f.member));
    const bytes = Buffer.from(got.content as string, 'base64');
    const parts: string[] = [];
    for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50;) {
      const size = bytes.readUInt32LE(at + 18);
      const nameLength = bytes.readUInt16LE(at + 26);
      const extra = bytes.readUInt16LE(at + 28);
      const data = bytes.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size);
      parts.push((bytes.readUInt16LE(at + 8) === 8 ? inflateRawSync(data) : data).toString('utf8'));
      at += 30 + nameLength + extra + size;
    }
    const all = parts.join('\n');
    for (const sheet of ['invoices', 'by_status', 'invoices_stats', 'by_customer']) assert.ok(all.includes(`name="${sheet}"`), sheet);
  });
});
