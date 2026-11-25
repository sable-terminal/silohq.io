import type { Traced } from './lineage.util';

/**
 * Preparing a result for export.
 *
 * REDACTED TO WHAT THE PERSON EXPORTING MAY SEE, NOT WHAT THE VIEW CONTAINS. A
 * saved view compiled by somebody with clearance on salary, exported by somebody
 * without it, must not carry those figures out of the building in a spreadsheet.
 * The permission check happens at export, against the exporter, every time.
 *
 * IT PRODUCES A NEUTRAL STRUCTURE, NOT A FILE. The binary writers — xlsx, docx,
 * PDF — are heavy dependencies and belong in infra. What must not vary between
 * formats is which cells are present, so that decision is made once, here.
 */

export interface ExportColumn {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'money';
  /** Currency for money columns. Carried per column, never assumed. */
  currency?: string;
}

export interface ExportDocument {
  title: string;
  generatedAt: Date;
  generatedBy: string;
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
  /**
   * A note stating what was withheld.
   *
   * PRESENT WHENEVER ANYTHING WAS REMOVED. A redacted export that looks complete
   * is a document somebody will circulate as the full picture, and the omission
   * is invisible precisely because it is an omission.
   */
  redactionNote?: string;
  /** Source attribution, so an exported figure is still traceable. */
  sources: string[];
}

export interface ExportPermissions {
  deniedFields: ReadonlySet<string>;
  maskedFields: ReadonlySet<string>;
}

export function prepare(input: {
  title: string;
  columns: readonly ExportColumn[];
  rows: ReadonlyArray<Record<string, unknown>>;
  permissions: ExportPermissions;
  exportedBy: string;
  sources: readonly string[];
  now?: Date;
}): ExportDocument {
  const removed: string[] = [];
  const masked: string[] = [];

  const columns = input.columns.filter((column) => {
    if (input.permissions.deniedFields.has(column.key)) {
      removed.push(column.label);
      return false;
    }
    if (input.permissions.maskedFields.has(column.key)) masked.push(column.label);
    return true;
  });

  const rows = input.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const column of columns) {
      out[column.key] = input.permissions.maskedFields.has(column.key)
        ? maskValue(row[column.key])
        : row[column.key];
    }
    return out;
  });

  const notes: string[] = [];
  if (removed.length > 0) notes.push(`${removed.length} column(s) were removed: ${removed.join(', ')}.`);
  if (masked.length > 0) notes.push(`${masked.length} column(s) are masked: ${masked.join(', ')}.`);

  return {
    title: input.title,
    generatedAt: input.now ?? new Date(),
    generatedBy: input.exportedBy,
    columns,
    rows,
    redactionNote: notes.length > 0 ? `${notes.join(' ')} You do not have access to this data.` : undefined,
    sources: [...input.sources],
  };
}

/**
 * Masking keeps the shape and destroys the value.
 *
 * A MASKED NUMBER MUST NOT REMAIN A NUMBER. Replacing 184000 with 0 leaves a
 * column that still sums, still charts and still looks like data — and the total
 * is then wrong in a way nothing on the page indicates.
 */
function maskValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return '••••';
}

/**
 * CSV, which is the one format light enough to belong here.
 *
 * EVERY FIELD IS QUOTED. Conditional quoting means deciding per value whether it
 * contains a delimiter, a quote or a newline, and the case that gets missed
 * corrupts the file silently.
 */
export function toCsv(document: ExportDocument): string {
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };

  const lines = [
    document.columns.map((c) => escape(c.label)).join(','),
    ...document.rows.map((row) => document.columns.map((c) => escape(row[c.key])).join(',')),
  ];

  /*
   * THE PROVENANCE IS IN THE FILE. An exported spreadsheet outlives the session
   * that made it and gets forwarded without context; the footer is what lets
   * somebody six months later work out where the numbers came from and whether
   * anything was withheld.
   */
  lines.push('');
  lines.push(escape(`Generated ${document.generatedAt.toISOString()} by ${document.generatedBy}`));
  lines.push(escape(`Sources: ${document.sources.join('; ')}`));
  if (document.redactionNote) lines.push(escape(document.redactionNote));

  return lines.join('\r\n');
}

/** Attach lineage to a figure destined for a cell. */
export function withLineage(traced: Traced<unknown>): { value: unknown; source: string } {
  return {
    value: traced.value,
    source: traced.sources.map((s) => `${s.connectionName}.${s.fieldPath}`).join(', '),
  };
}
