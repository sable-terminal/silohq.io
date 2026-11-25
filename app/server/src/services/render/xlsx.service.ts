// Spreadsheet exports (spec 41.2): an Office Open XML workbook (.xlsx) with one sheet, written
// here without a library: the package is a zip of five XML parts. The sheet opens with the
// document's head (markings, computed at, coverage, what is omitted), then the table, and
// the markings are printed in every page header too (invariant 7). Text is written as inline
// strings, which a spreadsheet never evaluates, so a value from a source can never run as a
// formula; numbers and booleans keep their types. Characters XML cannot carry are dropped.

import { crc32, deflateRawSync } from 'node:zlib';
import { text, type ExportDocument } from './document.service.ts';

// Characters XML 1.0 refuses, removed rather than escaped.
const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const xml = (value: string): string => value.replace(INVALID, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Column letters: A, B, ... Z, AA, ... */
function column(index: number): string {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}

function cellXml(ref: string, value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const t = text(value);
  if (t === '') return '';
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(t)}</t></is></c>`;
}

function sheet(doc: ExportDocument): string {
  const lines: unknown[][] = [...doc.head.map(([label, value]) => [label, value]), [], doc.header, ...doc.rows];
  const rows = lines.map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => cellXml(`${column(c)}${r + 1}`, v)).join('')}</row>`).join('');
  const markings = doc.markings.length === 0 ? 'Markings: none' : `Markings: ${doc.markings.join('; ')}`;
  // &C centres the header; && is a literal ampersand in header text.
  const header = xml(markings.replaceAll('&', '&&'));
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${rows}</sheetData>`
    + `<headerFooter><oddHeader>&amp;C${header}</oddHeader><oddFooter>&amp;C${header}</oddFooter></headerFooter>`
    + '</worksheet>';
}

const PARTS = (doc: ExportDocument): [string, string][] => [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>'],
  ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>'],
  ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '</Relationships>'],
  ['xl/worksheets/sheet1.xml', sheet(doc)],
];

/** A zip archive of the parts, deflated (PKZIP 2.0: no extensions, fixed 1980 timestamps so equal input gives equal bytes). */
export function zip(parts: readonly [string, Buffer][]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(content);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12); entry.writeUInt16LE(DOS_DATE, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(content.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt16LE(0, 30); entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34); entry.writeUInt16LE(0, 36); entry.writeUInt32LE(0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, end]);
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function renderXlsx(doc: ExportDocument): Buffer {
  return zip(PARTS(doc).map(([name, content]) => [name, Buffer.from(content, 'utf8')]));
}

// ----------------------------------------------------------------------------- workbooks (D232)

const sheetName = (name: string, i: number, used: Set<string>): string => {
  // A sheet name Excel takes: at most 31 characters, none of []:*?/\, unique.
  let n = name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || `Sheet${i + 1}`;
  for (let k = 2; used.has(n.toLowerCase()); k++) n = `${n.slice(0, 28)} ${k}`;
  used.add(n.toLowerCase());
  return n;
};

/**
 * A workbook's sheets as computed values (formulas already evaluated, so nothing in the file can
 * run): text as inline strings, numbers and booleans typed. The markings are printed in every page
 * header, and on a first sheet before the rest with any note the export carries.
 */
export function renderWorkbookXlsx(sheets: readonly { name: string; rows: unknown[][] }[], markings: readonly string[], notes: readonly string[] = []): Buffer {
  const used = new Set<string>();
  const label = markings.length === 0 ? 'Markings: none' : `Markings: ${markings.join('; ')}`;
  const all = [{ name: 'Markings', rows: [[label], ...notes.map((n) => [n])] }, ...sheets];
  const names = all.map((s, i) => sheetName(s.name, i, used));
  const header = xml(label.replaceAll('&', '&&'));
  const worksheet = (rows: unknown[][]) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${rows.map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => cellXml(`${column(c)}${r + 1}`, v)).join('')}</row>`).join('')}</sheetData>`
    + `<headerFooter><oddHeader>&amp;C${header}</oddHeader><oddFooter>&amp;C${header}</oddFooter></headerFooter>`
    + '</worksheet>';
  const parts: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + all.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + all.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + '</Relationships>'],
    ...all.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, worksheet(s.rows)] as [string, string]),
  ];
  return zip(parts.map(([name, content]) => [name, Buffer.from(content, 'utf8')]));
}

