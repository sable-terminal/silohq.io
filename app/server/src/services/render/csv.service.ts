// CSV exports (spec 41.2). Pure: an answer in, a document out.
//
// The document opens with what must travel with the figures: its name, the markings it
// carries (invariant 7), when it was computed, and its coverage (invariant 10: an uncertain
// total is uncertain in the spreadsheet). Then the table. A property the reader may not see
// in clear is stated, not left as a gap: a redacted column is headed as omitted and every
// cell says so; a masked value is printed masked; a disputed value is printed as disputed;
// an undecided measure as undecided.
//
// Cells are quoted as RFC 4180 asks, and any text a spreadsheet would read as a formula
// (beginning =, +, -, @, tab or carriage return) is prefixed with an apostrophe, so an
// export never runs a value from a source as a formula on the reader's machine.

import { exportDocument, type DocumentInput } from './document.service.ts';

const FORMULA = /^[=+\-@\t\r]/;

export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (FORMULA.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const line = (cells: readonly unknown[]): string => `${cells.map(cell).join(',')}\r\n`;

export type CsvInput = DocumentInput;

export function renderCsv(input: CsvInput): string {
  const doc = exportDocument(input);
  let out = doc.head.map((pair) => line(pair)).join('');
  out += '\r\n';
  out += line(doc.header);
  for (const row of doc.rows) out += line(row);
  return out;
}
