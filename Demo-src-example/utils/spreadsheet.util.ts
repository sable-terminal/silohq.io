import ExcelJS from 'exceljs';

/**
 * Import §3 — a workbook, as records of text.
 *
 * ── WHY EVERY CELL BECOMES TEXT HERE ────────────────────────────────────────
 *
 * The extraction engine has one set of rules for what a value means under a
 * definition, and a CSV arrives as text. Handing it Excel's own types instead
 * would give spreadsheets a second, laxer set of rules — a cell Excel stored as
 * a number would skip the check a CSV of the same export is held to.
 *
 * ── DATES KEEP EXACTLY WHAT EXCEL KNOWS, AND NO MORE ────────────────────────
 *
 * Excel stores a date as a serial number with no time zone. A date with no time
 * part becomes `YYYY-MM-DD`. A date with a time becomes `YYYY-MM-DDTHH:mm:ss`
 * with NO zone, which the engine refuses for a datetime field — because writing
 * `Z` here would assert UTC about a time the workbook never said was UTC.
 */

export interface Workbook {
  sheets: string[];
  /** Every row of a sheet as text cells, 1-based rows at index 0. The first sheet if unnamed. */
  records(sheet?: string): string[][] | null;
}

export async function readWorkbook(buffer: Buffer): Promise<Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheets = workbook.worksheets.map((one) => one.name);

  return {
    sheets,
    records(sheet?: string) {
      const worksheet = sheet ? workbook.getWorksheet(sheet) : workbook.worksheets[0];
      if (!worksheet) return null;

      const width = worksheet.columnCount;
      const out: string[][] = [];

      for (let r = 1; r <= worksheet.rowCount; r++) {
        const row = worksheet.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c).value));
        out.push(cells);
      }

      return out;
    },
  };
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dateText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;

  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((run) => run.text).join('');
    }
    /* A formula: the value it last calculated, which is what the export showed. */
    if ('result' in value) return cellText((value as { result?: ExcelJS.CellValue }).result ?? null);
    if ('text' in value) return String((value as { text: unknown }).text ?? '');
    /* An error cell (#N/A, #DIV/0!) holds no value. */
    if ('error' in value) return '';
  }

  return String(value);
}

function dateText(value: Date): string {
  const iso = value.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19);
}
