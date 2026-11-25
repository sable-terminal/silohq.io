import { detectDelimiter } from '../../utils/fileParser.util';
import { checkCount, FormatError, uniqueNames, type FormatParser } from './contract.format';

/**
 * CSV, as systems really export it.
 *
 * RFC 4180 with a declared quote character, a delimiter that can be detected, a
 * header that can be absent or preceded by title lines, and duplicate column
 * names made unique rather than silently overwriting each other.
 */

function records(text: string, delimiter: string, quote: string): { rows: string[][]; open: boolean } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === quote) {
        if (text[i + 1] === quote) {
          field += quote;
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === quote) quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { rows, open: quoted };
}

export const csv: FormatParser = {
  name: 'csv',
  contentTypes: ['text/csv', 'application/csv', 'text/comma-separated-values'],
  binary: false,
  parse({ input, options }) {
    const text = String(input);
    const delimiter = !options.delimiter || options.delimiter === 'auto' ? detectDelimiter(text) : options.delimiter;
    const { rows, open } = records(text, delimiter, options.quote ?? '"');

    /* An unclosed quote swallowed the rest of the file into one field. That is not a result. */
    if (open) throw new FormatError('csv', 'A quoted field is never closed, so the rest of the file cannot be read.');

    const kept = rows.slice(options.skipLines ?? 0).filter((row) => !(row.length === 1 && row[0] === ''));
    checkCount('csv', kept.length);

    if (options.header === false) return kept;

    const [head, ...body] = kept;
    if (!head) return [];
    const names = uniqueNames(head);
    return body.map((row) => {
      const out: Record<string, string> = {};
      names.forEach((name, index) => {
        out[name] = row[index] ?? '';
      });
      return out;
    });
  },
};
