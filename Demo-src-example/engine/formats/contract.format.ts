import type { z } from 'zod';
import { bounds } from '../../utils/error.util';

/**
 * A parser: bytes in, a JSON-shaped value out, on which every expression runs.
 *
 * PARSERS KNOW NOTHING ABOUT RECORDS. A CSV parser returns rows and an XML
 * parser returns the document; where the records are inside that is the
 * manifest's `records` expression. That keeps a parser a page long and lets one
 * serve an S3 listing, a SOAP body and a bank's statement drop.
 *
 * A PARSER MAY RETURN BYTES. An attachment, a file inside a listing, the part of
 * a multipart response — a `Buffer` anywhere in the result is turned into a blob
 * handle by the runner before an expression sees it (MANIFEST-V2 §9.8), so
 * nothing large is ever copied through the evaluator as a string.
 */

export interface FormatOptions {
  delimiter?: 'auto' | ',' | ';' | '\t' | '|';
  header?: boolean;
  skipLines?: number;
  quote?: string;
  columns?: Array<{
    name: string;
    start: number;
    length: number;
    type?: 'text' | 'packed' | 'zoned' | 'binary';
    scale?: number;
    signed?: boolean;
    trim?: boolean;
  }>;
  recordLength?: number;
  recordCharset?: string;
  sheet?: string | number;
  headerRow?: number;
  arrays?: string[];
  removeNamespaces?: boolean;
  message?: string;
  /** Protocol Buffers: a base64 `FileDescriptorSet` (what `protoc --descriptor_set_out` writes). */
  descriptor?: string;
  standard?: 'x12' | 'edifact';
  version?: string;
}

export interface ParseInput {
  /** Decoded text for a text parser; the raw bytes for a binary one. */
  input: string | Buffer;
  options: FormatOptions;
  contentType: string | null;
}

export interface FormatParser {
  readonly name: string;
  /** Content types this parser claims when the manifest says `auto`. */
  readonly contentTypes: readonly string[];
  /** Whether `parse` wants raw bytes (excel, pdf, fixed-width, binary) or decoded text. */
  readonly binary: boolean;
  parse(input: ParseInput): unknown | Promise<unknown>;
}

/**
 * A parse failure, with where it happened when that is known.
 *
 * NEVER A PARTIAL RESULT. Half a CSV is a shorter answer that looks complete.
 */
export class FormatError extends Error {
  constructor(
    readonly format: string,
    message: string,
    readonly at?: { line?: number; offset?: number },
  ) {
    super(message);
    this.name = 'FormatError';
  }
}

/**
 * THE MOST RECORDS ONE RESPONSE MAY PARSE TO. Bytes are already bounded, but a
 * small body can still describe an enormous table — a CSV of empty rows, an XML
 * document of self-closing elements. Past this the parse is refused.
 */
const MAX_PARSED_RECORDS = 200_000;

export function checkCount(format: string, count: number): void {
  if (count > MAX_PARSED_RECORDS) {
    throw bounds({
      message: `The ${format} response holds more than ${MAX_PARSED_RECORDS.toLocaleString('en-GB')} records. Ask the source for less.`,
      code: 'bounds.parse_ceiling',
      detail: { format, limit: MAX_PARSED_RECORDS },
    });
  }
}

/**
 * How many nodes a parsed document has, stopping as soon as it passes the
 * bound — so counting an enormous document is not itself the expensive part.
 */
export function checkNodes(format: string, value: unknown, limit = MAX_PARSED_RECORDS * 10): void {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const one = stack.pop();
    count += 1;
    if (count > limit) {
      throw bounds({
        message: `The ${format} response is larger than Silo will read in one go. Ask the source for less.`,
        code: 'bounds.parse_ceiling',
        detail: { format, limit },
      });
    }
    if (Array.isArray(one)) stack.push(...one);
    else if (one !== null && typeof one === 'object' && !Buffer.isBuffer(one)) stack.push(...Object.values(one));
  }
}

/** Make header names unique the way a spreadsheet user would expect: `amount`, `amount_2`. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw, index) => {
    const base = raw.trim() === '' ? `column_${index + 1}` : raw.trim();
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

export type Schema<T> = z.ZodType<T>;
