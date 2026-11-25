// Workbooks (D232): a spreadsheet of typed cells and formulas with live ranges over object sets.
// Saved by its owner, each live range checked against what the owner may see and the cells it
// would cover; read for whoever opens it, as them; shared to open or to copy within the sharing
// policy; exported into Files as a spreadsheet of computed values carrying the markings of what
// its ranges read. Real processes: the files cell (workspace, executor, files, policy).

import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { downloadFile } from '../../src/contracts/files/file.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import {
  copyWorkbook, createWorkbook, exportWorkbook, getWorkbook, listWorkbooks, readWorkbookRanges, saveWorkbook, shareWorkbook, type WorkbookDocument,
} from '../../src/contracts/workspace/workbook.contract.ts';
import { createFilesCell, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let workbookId: string;
let setId: string;

/** The parts of a zip, as an .xlsx is: its local file headers read in order, each inflated. */
function unzip(bytes: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50;) {
    const method = bytes.readUInt16LE(at + 8);
    const size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extra = bytes.readUInt16LE(at + 28);
    const name = bytes.toString('utf8', at + 30, at + 30 + nameLength);
    const data = bytes.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size);
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString('utf8'));
    at += 30 + nameLength + extra + size;
  }
  return out;
}

before(async () => {
  f = await createFilesCell();
  setId = (await f.gateway.call(saveObjectSet, {
    body: { name: 'All invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } } },
  }, f.keyed(f.member))).id;
});

after(async () => {
  await f?.close();
});

const doc = (extra: Partial<WorkbookDocument> = {}): WorkbookDocument => ({
  schemaVersion: '1',
  sheets: [{ id: 'sheet-1', name: 'Invoices', cells: { A1: 'Invoices by customer', D1: '=SUM(B4:B103)', D2: '=COUNT(B4:B103)', E1: '=D1/D2' } }],
  liveRanges: [{ id: 'range-1', sheetId: 'sheet-1', anchor: 'A3', objectSetId: setId, propertyIds: [f.prop('customer'), f.prop('total')], limit: 100 }],
  ...extra,
});

describe('workbooks (D232)', () => {
  test('made blank, saved with typed cells, formulas and a live range; a range over typed cells, another range or an unknown property refused', async () => {
    const made = await f.gateway.call(createWorkbook, { body: { name: 'Receivables' } }, f.keyed(f.member));
    workbookId = made.id;
    assert.deepEqual([made.access, made.document.sheets.length, made.document.liveRanges], ['owner', 1, []]);
    const refused = async (document: WorkbookDocument, code: string) =>
      assert.rejects(f.gateway.call(saveWorkbook, { params: { workbookId }, body: { document, lockVersion: made.lockVersion } }, f.cell.as(f.member)), { code });
    await refused(doc({ sheets: [{ id: 'sheet-1', name: 'Invoices', cells: { A5: 'typed here' } }] }), 'workspace.range_covers_cells');
    await refused(doc({ liveRanges: [...doc().liveRanges, { id: 'range-2', sheetId: 'sheet-1', anchor: 'B10', objectSetId: setId, propertyIds: [f.prop('status')], limit: 5 }] }), 'workspace.range_overlaps');
    await refused(doc({ liveRanges: [{ ...doc().liveRanges[0]!, propertyIds: [f.manifest.objectTypes.find((t) => t.apiName !== 'invoice')?.properties[0]?.identityId ?? '00000000-0000-4000-8000-000000000001'] }] }), 'workspace.range_property_unknown');
    const saved = await f.gateway.call(saveWorkbook, { params: { workbookId }, body: { document: doc(), lockVersion: made.lockVersion } }, f.cell.as(f.member));
    assert.equal(saved.document.liveRanges.length, 1);
    await assert.rejects(f.gateway.call(saveWorkbook, { params: { workbookId }, body: { document: doc(), lockVersion: made.lockVersion } }, f.cell.as(f.member)),
      { code: 'workspace.workbook_stale' });
  });

  test('its live range read for the owner: a header of property names, then a row per object; nothing read is stored', async () => {
    const { ranges } = await f.gateway.call(readWorkbookRanges, { params: { workbookId } }, f.cell.as(f.member));
    assert.deepEqual([ranges[0]!.header, ranges[0]!.refused, ranges[0]!.withheld], [['Customer', 'Total'], null, 0]);
    assert.ok(ranges[0]!.rows.length > 0 && ranges[0]!.rows.length === Math.min(ranges[0]!.total, 100));
    const stored = await f.gateway.call(getWorkbook, { params: { workbookId } }, f.cell.as(f.member));
    assert.equal(JSON.stringify(stored.document).includes(String(ranges[0]!.rows[0]![0])), false, 'a range\'s values never stored');
  });

  test('shared to open, it is read for the recipient as them; copying needs a copy share; only the owner edits', async () => {
    await f.gateway.call(shareWorkbook, { params: { workbookId }, body: { grantee: { kind: 'membership', membershipId: f.outsider.membershipId }, access: 'view' } }, f.cell.as(f.member));
    const theirs = await f.gateway.call(getWorkbook, { params: { workbookId } }, f.cell.as(f.outsider));
    assert.equal(theirs.access, 'view');
    assert.deepEqual((await f.gateway.call(listWorkbooks, { query: { filter: 'shared' } }, f.cell.as(f.outsider))).workbooks.map((w) => w.id), [workbookId]);
    // The outsider has no grant on the connection: the set is not read for them, and says so.
    const { ranges } = await f.gateway.call(readWorkbookRanges, { params: { workbookId } }, f.cell.as(f.outsider));
    assert.ok(ranges[0]!.refused !== null || ranges[0]!.rows.length === 0, JSON.stringify(ranges[0]));
    await assert.rejects(f.gateway.call(saveWorkbook, { params: { workbookId }, body: { document: doc(), lockVersion: theirs.lockVersion } }, f.cell.as(f.outsider)),
      { code: 'workspace.workbook_not_found' });
    await assert.rejects(f.gateway.call(copyWorkbook, { params: { workbookId }, body: { name: 'Mine' } }, f.keyed(f.outsider)), { code: 'workspace.workbook_copy_not_shared' });
    await f.gateway.call(shareWorkbook, { params: { workbookId }, body: { grantee: { kind: 'membership', membershipId: f.outsider.membershipId }, access: 'copy' } }, f.cell.as(f.member));
    const copied = await f.gateway.call(copyWorkbook, { params: { workbookId }, body: { name: 'Mine' } }, f.keyed(f.outsider));
    assert.deepEqual([copied.access, copied.ownerMembershipId, copied.document.liveRanges.length], ['owner', f.outsider.membershipId, 1]);
  });

  test('exported into Files: each sheet\'s values computed, formulas over the live range evaluated, the markings of what it read printed', async () => {
    const marking = await f.gateway.call(createMarking, { body: { name: 'Receivables', kind: 'classification', rank: 1 } }, f.cell.as(f.root));
    await f.gateway.call(grantClearance, { body: { markingId: marking.id, holder: { kind: 'membership', id: f.member.membershipId } } }, f.cell.as(f.root));
    await f.gateway.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'object_type', id: invoiceType(f.manifest) } } }, f.cell.as(f.root));
    const { file } = await f.gateway.call(exportWorkbook, { params: { workbookId }, body: {} }, f.keyed(f.member));
    assert.deepEqual([file.name, file.provenance?.sourceKind, file.markings.map((m) => m.name)], ['Receivables.xlsx', 'workbook', ['Receivables']]);
    const parts = unzip(Buffer.from((await f.gateway.call(downloadFile, { params: { fileId: file.id } }, f.cell.as(f.member))).content, 'base64'));
    assert.match(parts.get('xl/workbook.xml')!, /<sheet name="Markings"[^>]*\/><sheet name="Invoices"/);
    assert.match(parts.get('xl/worksheets/sheet1.xml')!, /Markings: Receivables/);
    const sheet = parts.get('xl/worksheets/sheet2.xml')!;
    const { ranges } = await f.gateway.call(readWorkbookRanges, { params: { workbookId } }, f.cell.as(f.member));
    const sum = ranges[0]!.rows.reduce((n, row) => n + Number(row[1] ?? 0), 0);
    assert.ok(sheet.includes(`<c r="D1"><v>${sum}</v></c>`), `the SUM over the live range: ${sum}`);
    assert.ok(sheet.includes('<c r="A4" t="inlineStr">'), 'the live range\'s rows, as values');
    assert.ok(!sheet.includes('<f>'), 'no formula in the file: only values');
  });
});
