// Reports (D233): headings, text and live blocks (an object set's objects; a workbook's computed
// cells) read for whoever opens the report, as them, never stored; each block checked against what
// the owner may see when saved; shared to open; exported into Files as a PDF of what the exporter
// sees, carrying the markings of what its blocks read. Real processes: the files cell.

import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { downloadFile } from '../../src/contracts/files/file.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { createReport, exportReport, getReport, readReportBlocks, saveReport, shareReport, type ReportDocument } from '../../src/contracts/workspace/report.contract.ts';
import { createWorkbook, saveWorkbook } from '../../src/contracts/workspace/workbook.contract.ts';
import { createFilesCell, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let reportId: string;
let setId: string;
let workbookId: string;

/** The text a PDF draws: each page stream inflated, its strings joined. */
function pdfText(bytes: Buffer): string {
  const out: string[] = [];
  for (let at = bytes.indexOf('stream\n'); at >= 0; at = bytes.indexOf('stream\n', at + 7)) {
    const end = bytes.indexOf('\nendstream', at);
    try { out.push(inflateSync(bytes.subarray(at + 7, end)).toString('latin1')); } catch { /* not a deflated stream */ }
  }
  return [...out.join('\n').matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1')).join('\n');
}

before(async () => {
  f = await createFilesCell();
  setId = (await f.gateway.call(saveObjectSet, {
    body: { name: 'All invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } } },
  }, f.keyed(f.member))).id;
  const wb = await f.gateway.call(createWorkbook, { body: { name: 'Receivables' } }, f.keyed(f.member));
  workbookId = wb.id;
  await f.gateway.call(saveWorkbook, {
    params: { workbookId }, body: {
      lockVersion: wb.lockVersion, document: {
        schemaVersion: '1', sheets: [{ id: 'sheet-1', name: 'Summary', cells: { A1: 'Measure', B1: 'Value', A2: 'Total', B2: '=SUM(B11:B60)', A3: 'Invoices', B3: '=COUNT(B11:B60)' } }],
        liveRanges: [{ id: 'range-1', sheetId: 'sheet-1', anchor: 'A10', objectSetId: setId, propertyIds: [f.prop('customer'), f.prop('total')], limit: 50 }],
      },
    },
  }, f.cell.as(f.member));
});

after(async () => {
  await f?.close();
});

const doc = (): ReportDocument => ({
  schemaVersion: '1', blocks: [
    { id: 'title', kind: 'heading', text: 'Month-end receivables', level: 1 },
    { id: 'intro', kind: 'text', text: 'Open invoices and what the workbook makes of them.' },
    { id: 'figures', kind: 'workbook', caption: 'Figures', workbookId, sheetId: 'sheet-1', range: 'A1:B3', header: true },
    { id: 'invoices', kind: 'objects', caption: 'The first three invoices', objectSetId: setId, propertyIds: [f.prop('customer'), f.prop('total')], limit: 3 },
  ],
});

describe('reports (D233)', () => {
  test('saved with headings, text and live blocks; a block over a foreign property or a workbook the owner may not open refused', async () => {
    const made = await f.gateway.call(createReport, { body: { name: 'Month end' } }, f.keyed(f.member));
    reportId = made.id;
    assert.deepEqual(made.document.blocks.map((b) => b.kind), ['heading']);
    const other = await f.gateway.call(createWorkbook, { body: { name: 'Not yours' } }, f.keyed(f.root));
    const refused = async (document: ReportDocument, code: string) =>
      assert.rejects(f.gateway.call(saveReport, { params: { reportId }, body: { document, lockVersion: made.lockVersion } }, f.cell.as(f.member)), { code });
    await refused({ ...doc(), blocks: [{ id: 'x', kind: 'workbook', workbookId: other.id, sheetId: 'sheet-1', range: 'A1:B2', header: true }] }, 'workspace.report_workbook_unknown');
    await refused({ ...doc(), blocks: [{ id: 'x', kind: 'objects', objectSetId: setId, propertyIds: ['00000000-0000-4000-8000-000000000001'], limit: 5 }] }, 'workspace.report_property_unknown');
    const saved = await f.gateway.call(saveReport, { params: { reportId }, body: { document: doc(), lockVersion: made.lockVersion } }, f.cell.as(f.member));
    assert.equal(saved.document.blocks.length, 4);
  });

  test('its blocks read for the owner: the workbook\'s figures computed, the set\'s first objects, nothing stored', async () => {
    const { blocks } = await f.gateway.call(readReportBlocks, { params: { reportId } }, f.cell.as(f.member));
    const [figures, invoices] = [blocks.find((b) => b.id === 'figures')!, blocks.find((b) => b.id === 'invoices')!];
    assert.deepEqual([figures.header, figures.rows.map((r) => r[0]), figures.refused], [['Measure', 'Value'], ['Total', 'Invoices'], null]);
    assert.ok(Number(figures.rows[1]![1]) > 0, 'the COUNT over the workbook\'s live range');
    assert.deepEqual([invoices.header, invoices.rows.length <= 3, invoices.refused], [['Customer', 'Total'], true, null]);
    assert.equal(JSON.stringify((await f.gateway.call(getReport, { params: { reportId } }, f.cell.as(f.member))).document).includes(String(invoices.rows[0]![0])), false);
  });

  test('shared to open: read for the recipient as them, a workbook not shared with them refused with why', async () => {
    await f.gateway.call(shareReport, { params: { reportId }, body: { grantee: { kind: 'membership', membershipId: f.outsider.membershipId }, access: 'view' } }, f.cell.as(f.member));
    const { blocks } = await f.gateway.call(readReportBlocks, { params: { reportId } }, f.cell.as(f.outsider));
    assert.equal(blocks.find((b) => b.id === 'figures')!.refused, 'the workbook is not shared with you');
    const invoices = blocks.find((b) => b.id === 'invoices')!;
    assert.ok(invoices.refused !== null || invoices.rows.length === 0, 'the outsider has no grant on the connection');
  });

  test('exported into Files as a PDF of what the exporter sees, with the markings of what it read', async () => {
    const marking = await f.gateway.call(createMarking, { body: { name: 'Receivables', kind: 'classification', rank: 1 } }, f.cell.as(f.root));
    await f.gateway.call(grantClearance, { body: { markingId: marking.id, holder: { kind: 'membership', id: f.member.membershipId } } }, f.cell.as(f.root));
    await f.gateway.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'object_type', id: invoiceType(f.manifest) } } }, f.cell.as(f.root));
    const { file } = await f.gateway.call(exportReport, { params: { reportId }, body: {} }, f.keyed(f.member));
    assert.deepEqual([file.name, file.contentType, file.provenance?.sourceKind, file.markings.map((m) => m.name)], ['Month end.pdf', 'application/pdf', 'report', ['Receivables']]);
    const bytes = Buffer.from((await f.gateway.call(downloadFile, { params: { fileId: file.id } }, f.cell.as(f.member))).content, 'base64');
    assert.equal(bytes.toString('latin1', 0, 5), '%PDF-');
    const text = pdfText(bytes);
    for (const expected of ['Markings: Receivables', 'Month-end receivables', 'Open invoices and what the workbook makes of them.', 'Figures', 'Measure', 'The first three invoices', 'Customer']) {
      assert.ok(text.includes(expected), `${expected} in the PDF`);
    }
  });
});
