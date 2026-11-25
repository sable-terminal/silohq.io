import { decodeSlice } from './charset.format';
import { checkCount, FormatError, type FormatParser } from './contract.format';

/**
 * Fixed-width records, cut from BYTES.
 *
 * ── BYTES, NOT CHARACTERS ─────────────────────────────────────────────────
 *
 * A mainframe record holds text in EBCDIC beside packed decimals and binary
 * integers. Decoding the record to text first — which is what the first design
 * did — destroys every number in it before a column is cut (finding F9). So the
 * record stays bytes; each text column is decoded on its own with
 * `recordCharset`, and each numeric column is read as the number it is.
 *
 * ── FIXED BLOCKS HAVE NO LINE ENDINGS ─────────────────────────────────────
 *
 * RECFM=FB, the mainframe default, is records of exactly `recordLength` bytes
 * one after another. Without `recordLength` a record ends at a newline — `\n`,
 * `\r\n`, or EBCDIC's own `0x15`.
 */

const EBCDIC_NAME = /^(ibm|cp|ebcdic)/i;

function splitRecords(bytes: Buffer, recordLength: number | undefined, ebcdic: boolean): Buffer[] {
  if (recordLength) {
    if (bytes.length % recordLength !== 0) {
      throw new FormatError('fixed_width', `The file is ${bytes.length} bytes, which is not a whole number of ${recordLength}-byte records.`);
    }
    const out: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += recordLength) out.push(bytes.subarray(at, at + recordLength));
    return out;
  }
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    const b = bytes[i];
    const end = i === bytes.length || b === 0x0a || (ebcdic && (b === 0x15 || b === 0x25));
    if (!end) continue;
    let stop = i;
    if (stop > start && bytes[stop - 1] === 0x0d) stop -= 1;
    if (stop > start) out.push(bytes.subarray(start, stop));
    start = i + 1;
  }
  return out;
}

/** COMP-3: two decimal digits per byte, the last nibble the sign (C or F positive, D negative). */
export function unpack(bytes: Buffer, scale: number): number {
  let digits = '';
  for (let i = 0; i < bytes.length; i++) {
    const high = bytes[i]! >> 4;
    const low = bytes[i]! & 0x0f;
    digits += String(high);
    if (i < bytes.length - 1) digits += String(low);
    else if (low === 0x0d || low === 0x0b) digits = `-${digits}`;
  }
  return Number(digits) / 10 ** scale;
}

/**
 * Zoned decimal: one digit per byte in the low nibble; the sign is the high
 * nibble of the last byte (D negative) in EBCDIC, or an overpunch letter in
 * ASCII exports (`}`, `J`–`R` negative, `{`, `A`–`I` positive).
 */
export function unzone(bytes: Buffer, scale: number, ebcdic: boolean): number {
  let digits = '';
  let negative = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const last = i === bytes.length - 1;
    if (ebcdic) {
      digits += String(b & 0x0f);
      if (last && b >> 4 === 0x0d) negative = true;
      continue;
    }
    const c = String.fromCharCode(b);
    if (last && /[{A-I}J-R]/.test(c)) {
      if (c === '{') digits += '0';
      else if (c === '}') {
        digits += '0';
        negative = true;
      } else if (c >= 'A' && c <= 'I') digits += String(c.charCodeAt(0) - 64);
      else {
        digits += String(c.charCodeAt(0) - 73);
        negative = true;
      }
    } else digits += c;
  }
  const value = Number(digits) / 10 ** scale;
  return negative ? -value : value;
}

export const fixedWidth: FormatParser = {
  name: 'fixed_width',
  contentTypes: [],
  binary: true,
  parse({ input, options }) {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'latin1');
    const columns = options.columns ?? [];
    if (columns.length === 0) throw new FormatError('fixed_width', 'Say which columns each record has.');

    const charset = options.recordCharset ?? 'latin1';
    const ebcdic = EBCDIC_NAME.test(charset) && !/^cp12/i.test(charset);
    const records = splitRecords(bytes, options.recordLength, ebcdic).slice(options.skipLines ?? 0);
    checkCount('fixed_width', records.length);

    return records.map((record, index) => {
      const row: Record<string, string | number | null> = {};
      for (const column of columns) {
        if (column.start + column.length > record.length) {
          if (options.recordLength) {
            throw new FormatError('fixed_width', `Record ${index + 1} is too short for ${column.name}.`, { line: index + 1 });
          }
          row[column.name] = null;
          continue;
        }
        const slice = record.subarray(column.start, column.start + column.length);
        const scale = column.scale ?? 0;
        switch (column.type ?? 'text') {
          case 'packed':
            row[column.name] = unpack(slice, scale);
            break;
          case 'zoned':
            row[column.name] = unzone(slice, scale, ebcdic);
            break;
          case 'binary': {
            const signed = column.signed ?? true;
            const n = signed ? slice.readIntBE(0, Math.min(slice.length, 6)) : slice.readUIntBE(0, Math.min(slice.length, 6));
            row[column.name] = n / 10 ** scale;
            break;
          }
          default: {
            const decoded = decodeSlice(slice, charset);
            row[column.name] = column.trim === false ? decoded : decoded.trim();
          }
        }
      }
      return row;
    });
  },
};
