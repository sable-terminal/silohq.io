import { sniff, type SniffedType } from './mimeSniff.util';

/**
 * Turning an uploaded file into rows.
 *
 * FOR SYSTEMS WITH NO API. The upload route accepts what a system already
 * exports: a spreadsheet, a CSV, a PDF report.
 *
 * THE FORMAT IS DECIDED FROM THE BYTES, NEVER THE EXTENSION. A `.csv` that is
 * really an xlsx parses to one column of binary noise, and nothing about the
 * result says so — it looks like a file with strange contents rather than a file
 * read the wrong way.
 *
 * CSV IS PARSED HERE; THE BINARY FORMATS ARE DELEGATED. Comma-separated values
 * are a small, well-specified problem with genuine subtleties — quoted fields,
 * escaped quotes, embedded newlines — that are easy to get wrong by splitting on
 * commas. xlsx, docx and PDF are large formats that need real libraries, which
 * are injected rather than imported so this module stays testable and the
 * dependency stays optional.
 */

export interface ParsedTable {
  headers: string[];
  rows: Array<Record<string, string>>;
  /** Set when parsing succeeded partially. Never silently dropped. */
  warnings: string[];
}

export interface BinaryParsers {
  xlsx?: (buffer: Buffer) => Promise<ParsedTable>;
  pdf?: (buffer: Buffer) => Promise<{ text: string }>;
  docx?: (buffer: Buffer) => Promise<{ text: string }>;
}

/**
 * RFC 4180 with the concessions reality requires.
 *
 * A CHARACTER-BY-CHARACTER SCAN RATHER THAN A SPLIT. `a,"b,c",d` has three
 * fields; splitting on commas gives four. `"he said ""hi"""` contains escaped
 * quotes. A quoted field may contain a newline, so lines cannot be separated
 * before fields are parsed. Every one of those breaks a regex approach.
 */
/**
 * RFC 4180 records, with no header interpretation.
 *
 * SEPARATE FROM `parseCsv` BECAUSE AN EXPORT'S HEADER IS NOT ALWAYS ITS FIRST
 * LINE. Accounting exports open with a title, a date range and a blank line
 * before the column names, and a quoted field may hold a newline — so which
 * record is the header can only be decided after the records are split, never
 * by counting lines.
 */
export function parseCsvRecords(
  text: string,
  delimiter = ',',
): { records: string[][]; unclosedQuote: boolean } {
  // A BOM survives from Excel and would become part of the first header name.
  const source = text.replace(/^﻿/, '');

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // \r\n counts once.
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return { records: rows, unclosedQuote: quoted };
}

/**
 * Which separator a text export uses, from the characters outside quotes on its
 * first non-empty line. A tie goes to the comma.
 */
export function detectDelimiter(text: string): ',' | ';' | '\t' | '|' {
  const line = text.replace(/^﻿/, '').split(/\r?\n/).find((one) => one.trim() !== '') ?? '';
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let quoted = false;

  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char in counts) counts[char as keyof typeof counts] += 1;
  }

  let best: keyof typeof counts = ',';
  for (const candidate of [';', '\t', '|'] as const) {
    if (counts[candidate] > counts[best]) best = candidate;
  }
  return best;
}

export function parseCsv(text: string, delimiter = ','): ParsedTable {
  const warnings: string[] = [];
  const { records: rows, unclosedQuote: quoted } = parseCsvRecords(text, delimiter);

  if (quoted) warnings.push('A quoted field was not closed. The last row may be wrong.');
  if (rows.length === 0) return { headers: [], rows: [], warnings: ['The file was empty.'] };

  const headers = rows[0]!.map((h, i) => h.trim() || `column_${i + 1}`);

  const duplicates = headers.filter((h, i) => headers.indexOf(h) !== i);
  if (duplicates.length > 0) {
    // Left as-is: renaming silently would break a mapping written against the
    // customer's own header names.
    warnings.push(`Duplicate column names: ${[...new Set(duplicates)].join(', ')}.`);
  }

  const parsed = rows.slice(1).map((cells, index) => {
    if (cells.length !== headers.length) {
      warnings.push(`Row ${index + 2} has ${cells.length} values for ${headers.length} columns.`);
    }
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])) as Record<string, string>;
  });

  return { headers, rows: parsed, warnings };
}

export interface ParseResult {
  ok: boolean;
  type: SniffedType | 'text/csv';
  table?: ParsedTable;
  text?: string;
  reason?: string;
}

export async function parse(
  buffer: Buffer,
  filename: string,
  parsers: BinaryParsers = {},
): Promise<ParseResult> {
  const type = sniff(buffer);

  if (type === 'application/zip') {
    // Every Office format is a zip. Which one it is cannot be told from the
    // signature, so the extension is the only hint available — used here as a
    // hint about a file already known to be a zip, not as a claim about content.
    if (/\.xlsx$/i.test(filename) && parsers.xlsx) {
      return { ok: true, type, table: await parsers.xlsx(buffer) };
    }
    if (/\.docx$/i.test(filename) && parsers.docx) {
      const { text } = await parsers.docx(buffer);
      return { ok: true, type, text };
    }
    return { ok: false, type, reason: 'No parser is configured for this Office format.' };
  }

  if (type === 'application/pdf') {
    if (!parsers.pdf) return { ok: false, type, reason: 'No PDF parser is configured.' };
    const { text } = await parsers.pdf(buffer);
    return { ok: true, type, text };
  }

  if (type === 'unknown') {
    /*
     * A CSV IS TEXT AND HAS NO SIGNATURE, SO "UNKNOWN" IS THE EXPECTED ANSWER FOR
     * ONE. It is only treated as CSV if it decodes as UTF-8 without replacement
     * characters — which is what stops an arbitrary binary being read as a
     * single enormous column of nonsense.
     */
    const text = buffer.toString('utf8');
    if (!text.includes('�')) {
      return { ok: true, type: 'text/csv', table: parseCsv(text) };
    }
    return { ok: false, type, reason: 'The file is not text and its format was not recognised.' };
  }

  return { ok: false, type, reason: `${type} cannot be read as data.` };
}
