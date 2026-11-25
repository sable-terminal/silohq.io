// Excel workbooks for Import (spec 68.2): tabular, read by columns, certain, never a model.
// The first sheet's first non-empty row is the header; shared, rich and inline strings,
// numbers, booleans and formula results read as text; a gap in a row is an empty cell; a
// number in a date field is a serial date, counted from 1900 or 1904 as the workbook says.
// A zip that is not a workbook, or a part that inflates without bound, is refused.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { zip } from '../../src/services/render/xlsx.service.ts';
import { draftTabular, fieldNameOf, inferType, sniff } from '../../src/services/siloes-import/tabular.service.ts';
import { fromSerial, parseWorkbook } from '../../src/services/siloes-import/workbook.service.ts';

const workbook = (sheet: string, options: { date1904?: boolean; shared?: string[] } = {}) => zip([
  ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>')],
  ['xl/workbook.xml', Buffer.from(`<workbook xmlns:r="r">${options.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>`
    + '<sheet name="Summary" sheetId="2" r:id="rId9"/><sheet name="Other" sheetId="1" r:id="rId1"/></sheets></workbook>')],
  ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId9" Target="worksheets/sheet2.xml"/></Relationships>')],
  ['xl/sharedStrings.xml', Buffer.from(`<sst>${(options.shared ?? []).map((s) => `<si>${s}</si>`).join('')}</sst>`)],
  ['xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Wrong sheet</t></is></c></row></sheetData></worksheet>')],
  ['xl/worksheets/sheet2.xml', Buffer.from(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`)],
]);

describe('Excel workbooks (spec 68.2)', () => {
  test('the first sheet in the workbook\'s order: header, typed cells as text, gaps empty', () => {
    const bytes = workbook(
      '<row r="1"/>'
      + '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2" t="inlineStr"><is><t>Amount</t></is></c><c r="D2" t="s"><v>2</v></c><c r="E2" t="s"><v>3</v></c></row>'
      + '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" t="s"><v>5</v></c><c r="C3"><v>120.5</v></c><c r="D3"><v>46296</v></c><c r="E3" t="b"><v>1</v></c></row>'
      + '<row r="4"><c r="A4" t="str"><f>CONCAT("INV","-2")</f><v>INV-2</v></c><c r="C4"><v>99</v></c><c r="E4" t="b"><v>0</v></c></row>',
      { shared: ['<t>Invoice</t>', '<t>Supplier</t>', '<t>Date</t>', '<t>Paid</t>', '<t>INV-1</t>', '<r><t>Acme </t></r><r><t>&amp; Co</t></r>'] },
    );
    assert.deepEqual(sniff(bytes, 'export.xlsx').kind, 'workbook');
    const read = parseWorkbook(bytes);
    assert.deepEqual(read.header, ['Invoice', 'Supplier', 'Amount', 'Date', 'Paid']);
    assert.deepEqual(read.rows, [
      { Invoice: 'INV-1', Supplier: 'Acme & Co', Amount: '120.5', Date: '46296', Paid: 'true' },
      { Invoice: 'INV-2', Supplier: '', Amount: '99', Date: '', Paid: 'false' },
    ]);
    assert.equal(read.dateSystem, 1900);
  });

  test('serial dates from 1900 or 1904; text that is not a number is no serial date', () => {
    assert.equal(fromSerial('46296', 1900, 'date'), '2026-10-01');
    assert.equal(fromSerial('46296.5', 1900, 'timestamp'), '2026-10-01T12:00:00.000Z');
    assert.equal(fromSerial('44834', 1904, 'date'), '2026-10-01');
    assert.equal(fromSerial('2026-10-01', 1900, 'date'), undefined);
    assert.equal(parseWorkbook(workbook('<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>', { date1904: true })).dateSystem, 1904);
  });

  test('a zip that is not a workbook, a damaged one, or a part that would inflate without bound is refused', () => {
    assert.throws(() => parseWorkbook(zip([['word/document.xml', Buffer.from('<w/>')]])), { code: 'import.workbook_unreadable' });
    assert.throws(() => parseWorkbook(Buffer.from('PK\u0003\u0004 not really a zip')), { code: 'import.workbook_unreadable' });
    const bomb = deflateRawSync(Buffer.alloc(300 * 1024 * 1024));
    const bytes = workbook('<row r="1"/>');
    // Replace the first sheet's stored bytes with a bomb by building the zip by hand around it.
    const name = Buffer.from('xl/workbook.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(bomb.length, 18); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(bomb.length, 20); central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12);
    end.writeUInt32LE(30 + name.length + bomb.length, 16);
    assert.throws(() => parseWorkbook(Buffer.concat([local, name, bomb, central, name, end])), { code: 'import.workbook_unreadable' });
    assert.ok(bytes.length > 0);
  });
});

describe('a definition drafted from a tabular file (spec 68.3)', () => {
  test('a field per column, named from its header, typed by the narrowest type every value reads as; a key column as the identifier', () => {
    const header = ['Invoice No', 'Supplier', 'Amount', 'Issued', 'Paid', 'Lines', 'Notes', '2nd ref', 'Supplier'];
    const rows = [
      { 'Invoice No': 'A-1', Supplier: 'Acme', Amount: '1,200.50', Issued: '2026-10-01', Paid: 'yes', Lines: '3', Notes: '', '2nd ref': 'x' },
      { 'Invoice No': 'A-2', Supplier: 'Brill', Amount: '99', Issued: '2026-10-02', Paid: 'no', Lines: '1', Notes: '', '2nd ref': 'y' },
    ];
    const draft = draftTabular('Invoices', header, rows);
    assert.deepEqual(draft.fields.map((f) => [f.name, f.type, f.extraction.column]), [
      ['invoice_no', 'string', 'Invoice No'], ['supplier', 'string', 'Supplier'], ['amount', 'decimal', 'Amount'], ['issued', 'date', 'Issued'],
      ['paid', 'boolean', 'Paid'], ['lines', 'integer', 'Lines'], ['notes', 'string', 'Notes'], ['f_2nd_ref', 'string', '2nd ref'], ['supplier_2', 'string', 'Supplier'],
    ]);
    assert.equal(draft.identifier, 'invoice_no', 'named like a key, never empty, never repeated');
    assert.equal(draftTabular('X', ['Code'], [{ Code: 'a' }, { Code: 'a' }]).identifier, undefined, 'a repeated key is no identifier');
  });

  test('types: 0 and 1 are numbers, numbers are not timestamps, an empty column is text', () => {
    assert.equal(inferType(['0', '1', '1']), 'integer');
    assert.equal(inferType(['1700000000', '1']), 'integer');
    assert.equal(inferType(['2026-10-01T10:00:00Z', '2026-10-02 09:00']), 'timestamp');
    assert.equal(inferType(['', ' ']), 'string');
    assert.equal(fieldNameOf('__Weird  Name!!', new Set()), 'weird_name');
  });
});
