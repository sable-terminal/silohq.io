// Reading an Excel workbook for Import (spec 68.2: tabular, read by columns, certain, never a
// model), written without a library. Pure: no I/O.
//
// An .xlsx file is a zip of XML parts. The zip is read from its central directory (local
// headers may defer their sizes to a data descriptor); each part is inflated with a ceiling,
// so a small file cannot expand without bound. The first sheet in the workbook's order is
// read: its first non-empty row is the header, the rows below are records, cells by column.
// Shared strings, inline strings, numbers, booleans and formula results are read as text,
// as a CSV cell would be; a number in a date field is an Excel serial date, converted where
// the field is typed (the workbook says whether it counts from 1900 or 1904).

import { inflateRawSync } from 'node:zlib';
import { AppError } from '../../utils/errors.util.ts';

/** No part of a workbook inflates past this. */
const MAX_PART_BYTES = 256 * 1024 * 1024;

const refuse = (code: string, message: string) => new AppError('validation', message, { code });

/** The parts of a zip, by name, from its central directory. */
export function zipEntries(bytes: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw refuse('import.workbook_unreadable', 'the workbook is not a readable zip');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw refuse('import.workbook_too_large', 'the workbook is too large to read: export the sheet as CSV');
  const parts = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw refuse('import.workbook_unreadable', 'the workbook\'s directory is damaged');
    const method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw refuse('import.workbook_unreadable', 'a part of the workbook is damaged');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) parts.set(name, data);
    else if (method === 8) {
      try {
        parts.set(name, inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }));
      } catch {
        throw refuse('import.workbook_unreadable', 'a part of the workbook does not inflate, or is too large');
      }
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}

const unescape = (text: string): string => text
  .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');

/** The text of every <t> in a fragment (a shared string may be rich text: several runs). */
const textOf = (xml: string): string => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1]!)).join('');

/** A cell reference's column, from 0: A is 0, Z 25, AA 26. */
function columnOf(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export interface Workbook {
  header: string[];
  rows: Record<string, string>[];
  /** The serial dates' epoch: 1900 (the default) or 1904. */
  dateSystem: 1900 | 1904;
}

/** The first sheet of an .xlsx workbook, as a header and rows of text cells. */
export function parseWorkbook(bytes: Buffer): Workbook {
  const parts = zipEntries(bytes);
  const part = (name: string) => parts.get(name)?.toString('utf8');
  const workbook = part('xl/workbook.xml');
  if (workbook === undefined) throw refuse('import.workbook_unreadable', 'the file is a zip, but not an Excel workbook');
  const dateSystem = /<workbookPr[^>]*\bdate1904="(1|true)"/.test(workbook) ? 1904 : 1900;
  const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const rels = part('xl/_rels/workbook.xml.rels') ?? '';
  const target = firstSheet === undefined ? undefined
    : [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1]!).find((a) => a.includes(`Id="${firstSheet}"`))
      ?.match(/Target="([^"]+)"/)?.[1];
  const sheetPath = target === undefined ? 'xl/worksheets/sheet1.xml' : target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = part(sheetPath);
  if (sheet === undefined) throw refuse('import.workbook_unreadable', 'the workbook has no sheet to read');
  const shared = [...(part('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));

  const table: string[][] = [];
  for (const row of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const inner = c[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1] ?? 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const text = type === 's' ? (v === undefined ? '' : shared[Number(v)] ?? '')
        : type === 'inlineStr' ? textOf(inner)
          : type === 'b' ? (v === '1' ? 'true' : v === '0' ? 'false' : '')
            : type === 'e' ? '' : unescape(v ?? '');
      cells[ref === undefined ? cells.length : columnOf(ref)] = text;
    }
    if (cells.some((x) => x !== undefined && x.length > 0)) table.push(Array.from(cells, (x) => x ?? ''));
  }
  const [header, ...body] = table;
  if (header === undefined) throw refuse('import.no_header', 'the sheet has no header row');
  const names = header.map((h) => h.trim());
  return { header: names, rows: body.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? '']))), dateSystem };
}

/** An Excel serial date as an ISO date or instant, in UTC; undefined when the text is not one. */
export function fromSerial(text: string, dateSystem: 1900 | 1904, type: 'date' | 'timestamp'): string | undefined {
  if (!/^\d+(\.\d+)?$/.test(text.trim())) return undefined;
  const serial = Number(text);
  // 1900: day 1 is 1900-01-01, counting the 1900-02-29 that never was, hence the 1899-12-30 epoch for later dates.
  const epoch = dateSystem === 1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const instant = new Date(epoch + Math.round(serial * 86_400_000));
  if (Number.isNaN(instant.getTime())) return undefined;
  return type === 'date' ? instant.toISOString().slice(0, 10) : instant.toISOString();
}
