// Data pipelines (D235): object sets read as the person running it, transformed by the closed steps,
// previewed with nothing kept (a failing step named), and run into an Import Silo source as a CSV
// file, from where it is data like any other. A run never declassifies: it is refused until the
// output Silo carries every marking of what the inputs read. Writing needs silo.import, as the
// person. Real processes: the files cell with Import Siloes.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { createImportSilo, createSource, listFiles } from '../../src/contracts/siloes/import.contract.ts';
import { createPipeline, getPipelineRun, listPipelineRuns, previewPipeline, runPipeline, type PipelineDocument } from '../../src/contracts/workspace/pipeline.contract.ts';
import { inTx } from '../db/harness.helper.ts';
import { createFilesCell, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let setId: string;
let siloId: string;
let sourceId: string;
let pipelineId: string;

before(async () => {
  f = await createFilesCell({ siloes: true });
  await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query('update iam.organisations set storage_enabled = true where id = $1', [f.cell.org]));
  siloId = (await f.gateway.call(createImportSilo, { body: { name: 'Derived', purpose: 'Pipeline outputs', retentionDays: 365 } }, f.keyed(f.root))).id;
  sourceId = (await f.gateway.call(createSource, { params: { siloId }, body: { kind: 'upload' } }, f.cell.as(f.root))).id;
  setId = (await f.gateway.call(saveObjectSet, {
    body: { name: 'Invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } } },
  }, f.keyed(f.root))).id;
});

after(async () => {
  await f?.close();
});

const doc = (): PipelineDocument => ({
  schemaVersion: '1',
  inputs: [{ id: 'invoices', objectSetId: setId, propertyIds: [f.prop('invoice_id'), f.prop('customer'), f.prop('total')], limit: 1000 }],
  steps: [
    { op: 'filter', cel: 'total > 100' },
    { op: 'compute', as: 'doubled', cel: 'total * 2' },
    { op: 'select', columns: [{ from: 'invoice_id', as: 'invoice' }, { from: 'customer' }, { from: 'doubled' }] },
    { op: 'sort', by: [{ column: 'doubled', direction: 'desc' }] },
  ],
  output: { siloId, sourceId, filename: 'large-invoices.csv' },
});

describe('data pipelines (D235)', () => {
  test('previewed as the person, nothing kept: the steps\' table, and a failing step named', async () => {
    pipelineId = (await f.gateway.call(createPipeline, { body: { name: 'Large invoices', document: doc() } }, f.keyed(f.root))).id;
    const preview = await f.gateway.call(previewPipeline, { params: { pipelineId }, body: {} }, f.cell.as(f.root));
    assert.deepEqual([preview.columns, preview.rows, preview.failedStep], [['invoice', 'customer', 'doubled'], [['i3', 'Brill, plc', 600], ['i1', 'Acme Ltd', 240]], null]);
    const broken = await f.gateway.call(previewPipeline, { params: { pipelineId }, body: { document: { ...doc(), steps: [{ op: 'select', columns: [{ from: 'nope' }] }] } } }, f.cell.as(f.root));
    assert.deepEqual(broken.failedStep, { step: 1, message: 'there is no column nope at this step' });
  });

  test('run into an Import Silo source as CSV, recorded with its rows and file', async () => {
    const run = await f.gateway.call(runPipeline, { params: { pipelineId } }, f.keyed(f.root));
    assert.deepEqual([run.status, run.rows, run.failure], ['completed', 2, null]);
    const files = (await f.gateway.call(listFiles, { params: { siloId } }, f.cell.as(f.root))).files;
    assert.ok(files.some((x) => x.id === run.siloFileId && x.filename === 'large-invoices.csv'));
    assert.deepEqual((await f.cell.migrate.query(`select payload->>'event' as e from platform.outbox where payload->>'event' like 'pipeline_run_%' order by seq`)).rows.map((r) => r.e),
      ['pipeline_run_started', 'pipeline_run_completed']);
  });

  test('writing needs silo.import, as the person: a member without it is refused, and the run says so', async () => {
    const theirSet = (await f.gateway.call(saveObjectSet, {
      body: { name: 'My invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } } },
    }, f.keyed(f.member))).id;
    const mine = await f.gateway.call(createPipeline, {
      body: { name: 'Mine', document: { ...doc(), inputs: [{ id: 'invoices', objectSetId: theirSet, propertyIds: [f.prop('invoice_id'), f.prop('total')], limit: 100 }], steps: [] } },
    }, f.keyed(f.member));
    await assert.rejects(f.gateway.call(runPipeline, { params: { pipelineId: mine.id } }, f.keyed(f.member)));
    const [run] = (await f.gateway.call(listPipelineRuns, { params: { pipelineId: mine.id } }, f.cell.as(f.member))).runs;
    assert.equal(run!.status, 'failed');
    // Read by its id, as a failed run's notification opens it (D268): its owner only.
    const one = await f.gateway.call(getPipelineRun, { params: { runId: run!.id } }, f.cell.as(f.member));
    assert.deepEqual([one.pipelineId, one.status, one.failure], [mine.id, 'failed', run!.failure]);
    await assert.rejects(f.gateway.call(getPipelineRun, { params: { runId: run!.id } }, f.cell.as(f.root)), { code: 'workspace.pipeline_run_not_found' });
  });

  test('never a declassification: refused until the Silo carries the inputs\' marking', async () => {
    const marking = await f.gateway.call(createMarking, { body: { name: 'Billing', kind: 'classification', rank: 1 } }, f.cell.as(f.root));
    await f.gateway.call(grantClearance, { body: { markingId: marking.id, holder: { kind: 'membership', id: f.root.membershipId } } }, f.cell.as(f.root));
    await f.gateway.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'object_type', id: invoiceType(f.manifest) } } }, f.cell.as(f.root));
    const refused = await f.gateway.call(runPipeline, { params: { pipelineId } }, f.keyed(f.root));
    assert.deepEqual([refused.status, refused.failure], ['failed', 'the output Silo does not carry Billing, which its inputs do']);
    await f.gateway.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'silo', id: siloId } } }, f.cell.as(f.root));
    const done = await f.gateway.call(runPipeline, { params: { pipelineId } }, f.keyed(f.root));
    assert.equal(done.status, 'completed');
    assert.deepEqual((await f.gateway.call(listPipelineRuns, { params: { pipelineId } }, f.cell.as(f.root))).runs.map((r) => r.status), ['completed', 'failed', 'completed']);
  });

});
