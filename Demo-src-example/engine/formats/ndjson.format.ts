import { checkCount, FormatError, type FormatParser } from './contract.format';

/** One JSON document per line — exports, logs, streaming APIs. */
export const ndjson: FormatParser = {
  name: 'ndjson',
  contentTypes: ['application/x-ndjson', 'application/ndjson', 'application/jsonl', 'application/x-jsonlines'],
  binary: false,
  parse({ input }) {
    const lines = String(input).split(/\r?\n/);
    const out: unknown[] = [];
    lines.forEach((line, index) => {
      if (line.trim() === '') return;
      try {
        out.push(JSON.parse(line));
      } catch {
        throw new FormatError('ndjson', `Line ${index + 1} is not JSON.`, { line: index + 1 });
      }
    });
    checkCount('ndjson', out.length);
    return out;
  },
};
