import iconv from 'iconv-lite';
import { EBCDIC } from './ebcdicTables.format';

/**
 * Bytes to text, before any parser sees them.
 *
 * ── A BOM ALWAYS WINS, AND IS ALWAYS STRIPPED ─────────────────────────────
 *
 * Excel writes a UTF-8 byte-order mark at the front of every CSV it exports,
 * and a decoder that keeps it turns the first column's name into
 * `﻿invoice_id` — which matches nothing, so the first field of every row
 * quietly reads as missing. Whatever the manifest says, a BOM says more.
 *
 * ── A CHARSET IS A NAME, NOT A CHOICE FROM A LIST ─────────────────────────
 *
 * The first design enumerated eight Western encodings, which left out every
 * mainframe code page, all of Central and Eastern Europe, and Japanese and
 * Chinese exports. A connector names its encoding as the file's author would;
 * this module says whether Silo can decode it (MANIFEST-V2 §9.8).
 *
 * ── A BAD BYTE IS A VISIBLE FACT, NOT AN EXCEPTION ────────────────────────
 *
 * A replacement character in one cell is something a person can see and ask
 * about. An exception loses the whole file.
 */

/** Names an EBCDIC table answers to: `ibm037`, `cp037`, `ibm-037`, `ebcdic-cp-us` for 037. */
const EBCDIC_ALIASES: Readonly<Record<string, string>> = {
  'ebcdic-cp-us': 'ibm037',
  'ebcdic-cp-ca': 'ibm037',
  'ebcdic-cp-gb': 'ibm285',
  'ebcdic-cp-de': 'ibm273',
  'ebcdic-cp-fr': 'ibm297',
  'ebcdic-cp-it': 'ibm280',
  'ebcdic-cp-es': 'ibm284',
  'ebcdic-cp-dk': 'ibm277',
  'ebcdic-cp-no': 'ibm277',
  'ebcdic-cp-fi': 'ibm278',
  'ebcdic-cp-se': 'ibm278',
  'ebcdic-cp-is': 'ibm871',
  'ebcdic-international': 'ibm500',
};

const normalise = (name: string): string => name.trim().toLowerCase().replace(/_/g, '-');

function ebcdicTable(name: string): readonly number[] | null {
  const plain = normalise(name);
  const aliased = EBCDIC_ALIASES[plain];
  if (aliased) return EBCDIC[aliased] ?? null;
  const match = /^(?:ibm|cp)-?0*(\d{3,4})$/.exec(plain);
  if (!match) return null;
  const digits = match[1]!;
  return EBCDIC[`ibm${digits.length === 3 ? digits : digits}`] ?? EBCDIC[`ibm${digits.padStart(3, '0')}`] ?? null;
}

/** Whether Silo can decode this encoding. `auto` always can. */
export function knownCharset(name: string): boolean {
  if (normalise(name) === 'auto') return true;
  if (ebcdicTable(name)) return true;
  return iconv.encodingExists(name);
}

/** Every EBCDIC page Silo carries, for the builder to offer by name. */
export const EBCDIC_PAGES: readonly string[] = Object.keys(EBCDIC);

function bomOf(bytes: Buffer): { charset: string; length: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { charset: 'utf-8', length: 3 };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { charset: 'utf-16le', length: 2 };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { charset: 'utf-16be', length: 2 };
  return null;
}

function charsetFromContentType(contentType: string | null): string | null {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '');
  return match && knownCharset(match[1]!) ? match[1]! : null;
}

/** Decode single-byte EBCDIC through its table. */
function decodeEbcdic(bytes: Buffer, table: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCodePoint(table[bytes[i]!]!);
  return out;
}

/**
 * Decode bytes to text: a BOM, then the manifest's charset (unless `auto`), then
 * the content type's `charset=`, then UTF-8.
 */
export function decode(bytes: Buffer, charset: string, contentType: string | null): string {
  const bom = bomOf(bytes);
  if (bom) return iconv.decode(bytes.subarray(bom.length), bom.charset);

  const chosen = normalise(charset) === 'auto' ? (charsetFromContentType(contentType) ?? 'utf-8') : charset;

  const table = ebcdicTable(chosen);
  if (table) return decodeEbcdic(bytes, table);

  return iconv.decode(bytes, iconv.encodingExists(chosen) ? chosen : 'utf-8');
}

/** One EBCDIC byte range, decoded — for a text column cut out of a binary record. */
export function decodeSlice(bytes: Buffer, charset: string): string {
  const table = ebcdicTable(charset);
  return table ? decodeEbcdic(bytes, table) : iconv.decode(bytes, knownCharset(charset) ? charset : 'utf-8');
}
