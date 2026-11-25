import { readWorkbook } from '../../utils/spreadsheet.util';
import { checkCount, FormatError, uniqueNames, type FormatParser } from './contract.format';

/**
 * One sheet of a workbook, as rows. Dates come back as ISO strings with no
 * invented time zone — `spreadsheet.util` explains why.
 */
export const excel: FormatParser = {
  name: 'excel',
  contentTypes: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ],
  binary: true,
  async parse({ input, options }) {
    let workbook;
    try {
      workbook = await readWorkbook(Buffer.isBuffer(input) ? input : Buffer.from(String(input)));
    } catch (error) {
      throw new FormatError('excel', `The file is not a workbook Silo can read: ${error instanceof Error ? error.message : 'unreadable'}.`);
    }

    const sheet = typeof options.sheet === 'number' ? workbook.sheets[options.sheet] : options.sheet;
    const rows = workbook.records(sheet);
    if (!rows) throw new FormatError('excel', `The workbook has no sheet ${String(options.sheet)}. It has: ${workbook.sheets.join(', ')}.`);

    const headerAt = (options.headerRow ?? 1) - 1;
    checkCount('excel', rows.length);
    if (options.header === false) return rows.slice(headerAt);

    const names = uniqueNames(rows[headerAt] ?? []);
    return rows
      .slice(headerAt + 1)
      .filter((row) => row.some((cell) => cell !== ''))
      .map((row) => Object.fromEntries(names.map((name, i) => [name, row[i] ?? ''])));
  },
};
