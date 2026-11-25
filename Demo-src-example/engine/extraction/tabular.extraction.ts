import type { DefinitionField, DefinitionObject } from '../../schemas/siloDefinition.schema';
import type { ExtractedRow } from '../../models/rowStore.model';

/**
 * §3 — tabular extraction: read columns, certainly.
 *
 * ── PURE, LIKE THE REST OF THE ENGINE ───────────────────────────────────────
 *
 * Handed records already split into cells, and returns rows. Reading the file,
 * choosing a sheet, and storing the result belong to the service; what a cell
 * means under a definition belongs here, where it can be tested without a file.
 *
 * ── A VALUE THAT DOES NOT FIT IS REFUSED, NOT COERCED ───────────────────────
 *
 * "£1,234" is not a number and "N/A" is not a date. Storing them as null, or as
 * whatever a lenient parser made of them, produces a total that is quietly
 * wrong. The row is rejected with the line and the reason, the probe shows it,
 * and the definition — or the file — is corrected by a person.
 */

export interface Rejection {
  rowRef: string;
  field: string;
  reason: string;
}

export interface TabularOutcome {
  rows: ExtractedRow[];
  rejected: Rejection[];
  /** Columns the definition names that the header row does not have. */
  missingColumns: string[];
  /** Data rows read, whatever became of them. */
  rowsRead: number;
}

/**
 * Split raw records at the header row into a header and its data rows.
 *
 * HEADER ROWS ARE 1-BASED, like every spreadsheet a person has ever looked at.
 */
export function atHeader(records: string[][], headerRow: number): { headers: string[]; data: string[][]; firstDataRow: number } {
  const headers = (records[headerRow - 1] ?? []).map((cell) => cell.trim());
  return { headers, data: records.slice(headerRow), firstDataRow: headerRow + 1 };
}

export function extractTable(input: {
  object: DefinitionObject;
  headers: string[];
  data: string[][];
  /** The 1-based row number of `data[0]` in the file. */
  firstDataRow: number;
  /** Prefixed to the row number: "row " for a CSV file, "Sheet1 row " for a workbook. */
  rowRefPrefix: string;
}): TabularOutcome {
  const { object } = input;
  const index = new Map(input.headers.map((header, at) => [header, at]));

  const missingColumns = object.fields
    .map((f) => (f.extraction.method === 'column' ? f.extraction.column : null))
    .filter((column): column is string => column !== null && !index.has(column.trim()));

  /*
   * A DEFINITION THAT CANNOT FIND ITS COLUMNS EXTRACTS NOTHING FROM THIS FILE.
   * Reading the rows anyway would store records with the missing fields null,
   * which is a file that looks imported and is not.
   */
  if (missingColumns.length > 0) {
    return { rows: [], rejected: [], missingColumns, rowsRead: input.data.length };
  }

  const rows: ExtractedRow[] = [];
  const rejected: Rejection[] = [];
  const identifiers = new Set(object.identifier);

  input.data.forEach((record, at) => {
    const rowRef = `${input.rowRefPrefix}${input.firstDataRow + at}`;

    /* A row of nothing is a gap in the export, not a record. */
    if (record.every((cell) => cell.trim() === '')) return;

    const values: Record<string, unknown> = {};
    let refused: Rejection | null = null;

    for (const f of object.fields) {
      if (f.extraction.method !== 'column') continue;
      const column = f.extraction.column.trim();
      const raw = record[index.get(column)!] ?? '';
      const outcome = coerce(raw, f);

      if (!outcome.ok) {
        refused = { rowRef, field: f.name, reason: outcome.reason };
        break;
      }

      if (outcome.value === null && (!f.nullable || identifiers.has(f.name))) {
        refused = {
          rowRef,
          field: f.name,
          reason: identifiers.has(f.name) ? 'An identifier is empty.' : 'A required value is empty.',
        };
        break;
      }

      values[f.name] = outcome.value;
    }

    if (refused) rejected.push(refused);
    else rows.push({ rowRef, values, methods: {} });
  });

  return { rows, rejected, missingColumns: [], rowsRead: input.data.length };
}

type Coerced = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * One cell, under one field's declared type.
 *
 * STRINGS ARE KEPT EXACTLY AS WRITTEN. Every other type is trimmed, because a
 * number with a trailing space is still the number, but a code with a trailing
 * space may not be the same code.
 */
export function coerce(raw: string, f: Pick<DefinitionField, 'type' | 'format'>): Coerced {
  if (f.type === 'string') return { ok: true, value: raw === '' ? null : raw };

  const text = raw.trim();
  if (text === '') return { ok: true, value: null };

  switch (f.type) {
    case 'number': {
      /*
       * PLAIN, OR COMMA-GROUPED WITH A POINT. "1,234.56" is unambiguous in the
       * exports this reads; "1.234,56" is the same figure in half of Europe, and
       * reading it as 1.234 is an error of three orders of magnitude.
       */
      if (/^-?\d+(\.\d+)?$/.test(text)) return { ok: true, value: Number(text) };
      if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return { ok: true, value: Number(text.replace(/,/g, '')) };
      return { ok: false, reason: `"${truncate(text)}" is not a plain number.` };
    }

    case 'boolean': {
      const lower = text.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(lower)) return { ok: true, value: true };
      if (['false', 'no', 'n', '0'].includes(lower)) return { ok: true, value: false };
      return { ok: false, reason: `"${truncate(text)}" is not yes or no.` };
    }

    case 'date': {
      const date = parseDate(text, f.format);
      return date
        ? { ok: true, value: date }
        : { ok: false, reason: `"${truncate(text)}" is not a date written ${f.format}.` };
    }

    case 'datetime': {
      /*
       * A TIME WITHOUT A ZONE IS REFUSED. "2021-03-28 01:30" is a time that did
       * not happen in London and happened once in Paris; storing it as UTC
       * moves every record by an hour for half the year.
       */
      if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
        return { ok: false, reason: `"${truncate(text)}" is not a date and time with a zone.` };
      }
      const at = Date.parse(text.replace(' ', 'T'));
      return Number.isNaN(at)
        ? { ok: false, reason: `"${truncate(text)}" is not a real date and time.` }
        : { ok: true, value: new Date(at).toISOString() };
    }

    case 'json': {
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false, reason: 'The value is not valid JSON.' };
      }
    }
  }
}

/** A calendar date that exists, as YYYY-MM-DD. Null for anything else. */
export function parseDate(text: string, format: DefinitionField['format']): string | null {
  let parts: RegExpMatchArray | null = null;
  let year = 0;
  let month = 0;
  let day = 0;

  switch (format) {
    case 'iso':
      parts = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (parts) [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      break;
    case 'dd/mm/yyyy':
      parts = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (parts) [day, month, year] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      break;
    case 'mm/dd/yyyy':
      parts = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (parts) [month, day, year] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      break;
    case 'yyyymmdd':
      parts = text.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (parts) [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
      break;
  }

  if (!parts) return null;

  /* The 31st of February parses in every lenient library. */
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function truncate(text: string): string {
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}
