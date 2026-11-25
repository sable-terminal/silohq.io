// Reading files for Import (spec 68.2): what a file is, judged from its bytes and never from
// the client's header, and the rows of a tabular file. Pure: no I/O.
//
// Tabular: CSV and TSV (RFC 4180 quoting; the delimiter is whichever of tab or comma the
// header line holds more of), and Excel workbooks (read in workbook.service.ts). A structured or prose document is a PDF, plain text or an image; which of the two
// it is follows from the definition its source uses.

import { AppError } from '../../utils/errors.util.ts';
import { parseDelimited } from '../../utils/delimited.util.ts';
export { parseDelimited };

export type Sniffed =
  | { kind: 'tabular'; contentType: 'text/csv' | 'text/tab-separated-values' }
  | { kind: 'document'; contentType: 'application/pdf' | 'text/plain' | 'image/png' | 'image/jpeg' }
  | { kind: 'workbook'; contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  | { kind: 'other'; contentType: 'application/octet-stream' };

const starts = (bytes: Buffer, magic: number[]) => magic.every((b, i) => bytes[i] === b);

export function sniff(bytes: Buffer, filename: string): Sniffed {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46])) return { kind: 'document', contentType: 'application/pdf' };
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) return { kind: 'document', contentType: 'image/png' };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { kind: 'document', contentType: 'image/jpeg' };
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return /\.xlsx$/i.test(filename) ? { kind: 'workbook', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
      : { kind: 'other', contentType: 'application/octet-stream' };
  }
  const text = bytes.subarray(0, 64 * 1024).toString('utf8');
  if (text.includes('�') || /[\u0000-\u0008\u000E-\u001F]/.test(text)) return { kind: 'other', contentType: 'application/octet-stream' };
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = header.split('\t').length - 1;
  const commas = header.split(',').length - 1;
  if (tabs > 0 && tabs >= commas) return { kind: 'tabular', contentType: 'text/tab-separated-values' };
  if (commas > 0 && /\.(csv|txt)$/i.test(filename)) return { kind: 'tabular', contentType: 'text/csv' };
  if (commas > 0 && text.split(/\r?\n/).slice(0, 5).every((l) => l.length === 0 || l.split(',').length === commas + 1)) {
    return { kind: 'tabular', contentType: 'text/csv' };
  }
  return { kind: 'document', contentType: 'text/plain' };
}

/** Rows of a delimited file: the header names, and each row's cells by header. */
const INTEGER = /^-?\d{1,19}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A cell as its field's type; an empty cell is null; undefined when it is not of the type. */
export function cellValue(text: string, type: 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp' | 'json'): unknown {
  const t = text.trim();
  if (t.length === 0) return null;
  switch (type) {
    case 'string': return text;
    case 'integer': return INTEGER.test(t) ? t : undefined;
    case 'decimal': return DECIMAL.test(t.replaceAll(',', '')) ? t.replaceAll(',', '') : undefined;
    case 'boolean': return /^(true|yes|y|1)$/i.test(t) ? true : /^(false|no|n|0)$/i.test(t) ? false : undefined;
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined;
    // ISO 8601 only: Date.parse alone reads "A-1" as a date.
    case 'timestamp': return !TIMESTAMP.test(t) || Number.isNaN(Date.parse(t)) ? undefined : new Date(t).toISOString();
    case 'json':
      try {
        return JSON.parse(t) as unknown;
      } catch {
        return undefined;
      }
  }
}

// ----------------------------------------------------------------------------- drafting a definition (68.3)

type ImportType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp';

/** A header as a field name: lower snake case, starting with a letter, no double underscore. */
export function fieldNameOf(header: string, taken: Set<string>): string {
  let base = header.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_{2,}/g, '_');
  if (!/^[a-z]/.test(base)) base = `f_${base}`.replace(/_{2,}/g, '_').replace(/_+$/, '');
  base = base.slice(0, 60) || 'field';
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`.slice(0, 63);
  taken.add(name);
  return name;
}

/** The narrowest type every non-empty value of a column reads as; a column with no value is text. */
export function inferType(values: readonly string[], typed: (text: string, type: ImportType) => unknown = cellValue): ImportType {
  const present = values.filter((v) => v.trim().length > 0);
  if (present.length === 0) return 'string';
  for (const type of ['integer', 'decimal', 'boolean', 'date', 'timestamp'] as const) {
    // A column of 0s and 1s is a number, not a flag; a number is no timestamp.
    if (type === 'boolean' && present.every((v) => /^[01]$/.test(v.trim()))) continue;
    if (type === 'timestamp' && present.every((v) => /^-?\d+(\.\d+)?$/.test(v.trim()))) continue;
    if (present.every((v) => typed(v, type) !== undefined)) return type;
  }
  return 'string';
}

const IDENTIFYING = /(^id$|_id$|^ref$|_ref$|reference|_no$|^no$|number$|^code$|_code$|^key$)/;

/**
 * A draft object for a tabular file: a field per column (named from its header, typed by its
 * values, read by column, certain) and, where a column looks like and behaves as a key (named
 * like one, never empty, never repeated), that column as its identifier. Structure only: the
 * draft holds header names and types, never a value.
 */
export function draftTabular(name: string, header: readonly string[], rows: readonly Record<string, string>[],
  typed?: (text: string, type: ImportType) => unknown) {
  const taken = new Set<string>(['row_ref', 'received_at']);
  const fields = header.filter((h) => h.length > 0).map((column) => ({
    name: fieldNameOf(column, taken), type: inferType(rows.map((r) => r[column] ?? ''), typed), extraction: { kind: 'column' as const, column },
  }));
  const identifier = fields.find((f) => IDENTIFYING.test(f.name) && (() => {
    const values = rows.map((r) => (r[f.extraction.column] ?? '').trim());
    return values.every((v) => v.length > 0) && new Set(values).size === values.length;
  })());
  return { name, ...(identifier === undefined ? {} : { identifier: identifier.name }), fields };
}
