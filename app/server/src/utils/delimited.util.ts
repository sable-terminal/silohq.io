// Delimited text (CSV, tab-separated): RFC 4180 quoting, a header row naming the columns.
// Shared by an Import Silo's tabular files (68) and SFTP connections' files (14.4). A cell is
// text; its type is the reader's business. Pure.

import { AppError } from './errors.util.ts';

export const DELIMITERS = [',', '\t', ';', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/** The header row's names (trimmed) and each row by them; a row shorter than the header has empty cells. */
export function parseDelimited(bytes: Buffer, delimiter: Delimiter): { header: string[]; rows: Record<string, string>[] } {
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell.length === 0) {
      quoted = true;
    } else if (ch === delimiter) {
      record.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(cell); cell = '';
      if (record.some((c) => c.length > 0)) records.push(record);
      record = [];
    } else cell += ch;
  }
  if (quoted) throw new AppError('validation', 'the file ends inside a quoted cell', { code: 'import.unterminated_quote' });
  record.push(cell);
  if (record.some((c) => c.length > 0)) records.push(record);
  const [header, ...body] = records;
  if (header === undefined) throw new AppError('validation', 'the file has no header row', { code: 'import.no_header' });
  const names = header.map((h) => h.trim());
  return { header: names, rows: body.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? '']))) };
}
