// Spreadsheet and PDF exports (spec 41.2), written without a library: a workbook whose zip
// and parts a reader opens, text that never runs as a formula, the markings on every sheet
// and page; a PDF whose cross-reference points at its objects, with the table header and the
// markings on every page.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crc32, inflateRawSync, inflateSync } from 'node:zlib';
import type { ExportDocument } from '../../src/services/render/document.service.ts';
import { renderPdf } from '../../src/services/render/pdf.service.ts';
import { renderXlsx } from '../../src/services/render/xlsx.service.ts';

const doc = (rows: number): ExportDocument => ({
  name: 'Open invoices', markings: ['Finance', 'Personal'],
  head: [['Silo export', 'Open invoices'], ['Markings', 'Finance; Personal'], ['Objects', rows]],
  header: ['Invoice', 'Customer', 'Total', 'Paid'],
  rows: Array.from({ length: rows }, (_, i) => [`i${i}`, i === 0 ? '=HYPERLINK("http://evil.example")' : 'Brill & Sons <plc>', i * 10.5, i % 2 === 0]),
});

/** The parts of a zip, read from its local headers, each checked against its CRC. */
function unzip(bytes: Buffer): Map<string, string> {
  const parts = new Map<string, string>();
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50;) {
    const size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const content = inflateRawSync(bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size));
    assert.equal(crc32(content), bytes.readUInt32LE(at + 14), `${name}'s CRC`);
    parts.set(name, content.toString('utf8'));
    at += 30 + nameLength + size;
  }
  return parts;
}

describe('spreadsheet exports', () => {
  test('a workbook of one sheet: the head, the table, typed numbers, text that never runs, the markings in its header', () => {
    const parts = unzip(renderXlsx(doc(3)));
    assert.deepEqual([...parts.keys()], ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']);
    const sheet = parts.get('xl/worksheets/sheet1.xml')!;
    assert.ok(!sheet.includes('<f>'), 'no formula anywhere');
    assert.ok(sheet.includes('<c r="B5" t="inlineStr"><is><t xml:space="preserve">Customer</t></is></c>'), 'the table header after the head and a blank row');
    assert.ok(sheet.includes('<t xml:space="preserve">=HYPERLINK(&quot;http://evil.example&quot;)</t>'), 'a formula-looking value is inert text');
    assert.ok(sheet.includes('<c r="C7"><v>10.5</v></c>') && sheet.includes('<c r="D6" t="b"><v>1</v></c>'), 'numbers and booleans keep their types');
    assert.ok(sheet.includes('Brill &amp; Sons &lt;plc&gt;'));
    assert.match(sheet, /<oddHeader>&amp;CMarkings: Finance; Personal<\/oddHeader>/);
  });
});

describe('PDF exports', () => {
  test('pages with the markings, the page number and the table header on each; a cross-reference that points at its objects', () => {
    const pdf = renderPdf(doc(100));
    const text = pdf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'));
    const pages = (text.match(/\/Type \/Page /g) ?? []).length;
    assert.ok(pages >= 2, 'a hundred rows run over several pages');
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    assert.equal(text.slice(start, start + 4), 'xref');
    const offsets = [...text.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, offset), `object ${i + 1} is where the table says`));
    const streams = [...text.matchAll(/<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)]
      .map((m) => inflateSync(pdf.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]))).toString('latin1'));
    assert.equal(streams.length, pages);
    streams.forEach((content, i) => {
      assert.ok(content.includes('(Markings: Finance; Personal)'), `page ${i + 1} carries the markings`);
      assert.ok(content.includes(`page ${i + 1} of ${pages}`));
      assert.ok(content.includes('(Customer)'), `page ${i + 1} repeats the table header`);
    });
    assert.ok(streams[0]!.includes('(=HYPERLINK\\("http://evil.example"\\))'), 'delimiters escaped');
  });
});
