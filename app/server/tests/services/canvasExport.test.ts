// Exporting a canvas view (spec 29.10): drawn for its exporter now, a PDF in Files printed with
// when it was computed, the state age of each source, its markings, its flags and the count
// not placed; a list layout prints as a table; a layout not drawn yet is refused, naming it.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { completeImageExport, exportCanvasView, getRenderJob, saveCanvasView } from '../../src/contracts/canvas-layout/canvasView.contract.ts';
import { downloadFile, type FileView } from '../../src/contracts/files/file.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createFilesCell, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let setId = '';

const canvas = async (name: string, layoutKind: string) => (await f.gateway.call(saveCanvasView, {
  body: { canvasScope: 'set', objectSetId: setId, name, layoutKind } as never,
}, f.keyed(f.member))).id;
const exportOf = (canvasViewId: string) => f.gateway.call(exportCanvasView, { params: { canvasViewId }, body: {} }, f.keyed(f.member));
/** The page content of a PDF, inflated. */
async function pages(file: FileView): Promise<string> {
  const pdf = Buffer.from((await f.gateway.call(downloadFile, { params: { fileId: file.id } }, f.cell.as(f.member))).content, 'base64');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  const text = pdf.toString('latin1');
  return [...text.matchAll(/<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)]
    .map((m) => inflateSync(pdf.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]))).toString('latin1')).join('\n');
}

before(async () => {
  f = await createFilesCell({ canvas: true });
  setId = (await f.gateway.call(saveObjectSet, { body: {
    name: 'Invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } },
  } }, f.keyed(f.member))).id;
});

after(async () => {
  await f?.close();
});

describe('exporting a canvas view (spec 29.10)', () => {
  test('a drawing in Files: computed time, state age by source, markings, flags, every object placed, provenance to the view', async () => {
    const viewId = await canvas('Invoices drawn', 'graph_layered');
    const out = await exportOf(viewId);
    assert.equal(out.outcome, 'exported', JSON.stringify(out));
    const { file, placed, notPlaced } = out as { file: FileView; placed: number; notPlaced: number };
    assert.deepEqual([file.name, file.contentType, placed, notPlaced], ['Invoices drawn.pdf', 'application/pdf', 3, 0]);
    const content = await pages(file);
    for (const expected of ['(Markings: none)', 'computed at', 'State age by source: crm', 'Flags: 0 not placed', 'i1 \\(normal\\)']) {
      assert.ok(content.includes(expected), `prints ${expected}`);
    }
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      'select source_kind, source_canvas_view_id from files.file_provenance where file_id = $1', [file.id]));
    assert.deepEqual(rows[0], { source_kind: 'canvas_view', source_canvas_view_id: viewId });
  });

  test('a list prints as a table; a map prints what it can place and says why not the rest; a 3D canvas is refused, naming its layout', async () => {
    const list = await exportOf(await canvas('Invoices listed', 'list'));
    assert.equal(list.outcome, 'exported');
    const content = await pages((list as { file: FileView }).file);
    assert.ok(content.includes('(Invoice number)') && content.includes('(i3)'), 'the table, headed by the type\'s title');
    // No Located property in the type's clone layout: nothing has a position, every invoice is counted as not placed.
    const mapped = await exportOf(await canvas('Invoices mapped', 'spatial_map'));
    assert.equal(mapped.outcome, 'exported');
    const { placed, notPlaced, file } = mapped as { placed: number; notPlaced: number; file: FileView };
    assert.deepEqual([placed, notPlaced > 0], [0, true]);
    const printed = await pages(file);
    assert.ok(printed.includes(`(Flags: ${notPlaced} not placed`) && printed.includes('Base map unavailable'), 'the count not placed, and the missing base map, printed');
    const modelled = await exportOf(await canvas('Invoices in 3D', 'spatial_3d'));
    assert.deepEqual([modelled.outcome, (modelled as { code: string }).code], ['refused', 'canvas.export_layout_unsupported']);
    void uuidv7;
  });
});

describe('PNG export from the exporter\'s own browser (D225)', () => {
  // A one-pixel PNG, as a browser would hand back.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  test('begun, it says what the image must print; the image comes back once and is filed as the exporter\'s export', async () => {
    const viewId = await canvas('Invoices as an image', 'graph_layered');
    const begun = await f.gateway.call(exportCanvasView, { params: { canvasViewId: viewId }, body: { format: 'png', width: 1200, height: 800 } }, f.keyed(f.member));
    assert.equal(begun.outcome, 'awaiting_image', JSON.stringify(begun));
    const { job, stamp } = begun as { job: { id: string; status: string; width: number }; stamp: { markings: string[]; sources: { name: string }[]; computedAt: string } };
    assert.deepEqual([job.status, job.width, stamp.markings, stamp.sources.map((x) => x.name)], ['queued', 1200, [], ['crm']]);
    assert.ok(Date.parse(stamp.computedAt) > 0);
    assert.equal((await f.gateway.call(getRenderJob, { params: { jobId: job.id } }, f.cell.as(f.member))).status, 'queued');

    const done = await f.gateway.call(completeImageExport, { params: { jobId: job.id }, body: { content: PNG } }, f.cell.as(f.member));
    assert.equal(done.outcome, 'exported', JSON.stringify(done));
    const file = (done as { file: FileView }).file;
    assert.deepEqual([file.name, done.job.status, done.job.fileId], ['Invoices as an image.png', 'completed', file.id]);
    const image = await f.gateway.call(downloadFile, { params: { fileId: file.id } }, f.cell.as(f.member));
    assert.deepEqual([image.contentType, image.content], ['image/png', PNG]);
    await assert.rejects(f.gateway.call(completeImageExport, { params: { jobId: job.id }, body: { content: PNG } }, f.cell.as(f.member)), { code: 'canvas.render_job_closed' });
  });

  test('only a PNG within the size the export was begun for, and only the exporter\'s own', async () => {
    const viewId = await canvas('Invoices again', 'graph_layered');
    const begun = await f.gateway.call(exportCanvasView, { params: { canvasViewId: viewId }, body: { format: 'png', width: 640, height: 480 } }, f.keyed(f.member));
    const jobId = (begun as { job: { id: string } }).job.id;
    await assert.rejects(f.gateway.call(completeImageExport, { params: { jobId }, body: { content: Buffer.from('<svg/>').toString('base64') } }, f.cell.as(f.member)),
      { code: 'canvas.image_invalid' });
    await assert.rejects(f.gateway.call(completeImageExport, { params: { jobId }, body: { content: PNG } }, f.cell.as(f.root)), { code: 'canvas.render_job_not_found' });
  });
});
