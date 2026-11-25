import { refusal, upstream } from '../../utils/error.util';
import { decode } from './charset.format';
import { FormatError, type FormatOptions, type FormatParser } from './contract.format';
import { csv } from './csv.format';
import { excel } from './excel.format';
import { fixedWidth } from './fixedWidth.format';
import { json } from './json.format';
import { multipart } from './multipart.format';
import { ndjson } from './ndjson.format';
import { pdf } from './pdf.format';
import { binary, text } from './text.format';
import { xml } from './xml.format';
import { avroFormat, parquet } from './columnar.format';
import { protobufFormat } from './protobuf.format';
import { edi, hl7 } from './interchange.format';
import { wire } from './wire.format';

/**
 * The parsers, and the one decision about which to use.
 *
 * `auto` READS THE CONTENT TYPE, AND SNIFFS ONLY WHAT IT CAN CHECK. A great many
 * JSON APIs answer `text/plain` or nothing at all; a body that starts with `{`
 * is tried as JSON, which either parses or says it does not. Anything that is
 * neither recognised nor recognisable — `application/octet-stream` above all —
 * is refused by name, because guessing a parser for bytes produces a confident
 * wrong answer.
 */

const REGISTRY: Record<string, FormatParser> = {
  json,
  ndjson,
  xml,
  csv,
  text,
  binary,
  excel,
  pdf,
  fixed_width: fixedWidth,
  multipart,
  parquet,
  avro: avroFormat,
  protobuf: protobufFormat,
  edi,
  hl7,
  /* Not a format a document names: the runner's, for transports that answer in it. */
  wire,
};

function byContentType(contentType: string | null): FormatParser | null {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!type) return null;
  for (const parser of Object.values(REGISTRY)) {
    for (const claim of parser.contentTypes) {
      if (claim.startsWith('+') ? type.endsWith(claim) : type === claim) return parser;
    }
  }
  return null;
}

/**
 * A container format that announces itself. Only magic numbers that are
 * unambiguous are read: Parquet's `PAR1` at both ends, Avro's `Obj\x01`, PDF's
 * `%PDF-`. A zip is not one of them — an Excel workbook and a Word document are
 * both zips.
 */
function magic(bytes: Buffer): FormatParser | null {
  if (bytes.length >= 8 && bytes.subarray(0, 4).toString('latin1') === 'PAR1' && bytes.subarray(-4).toString('latin1') === 'PAR1') return parquet;
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x4f, 0x62, 0x6a, 0x01]))) return avroFormat;
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return pdf;
  return null;
}

function sniff(bytes: Buffer): FormatParser | null {
  const head = bytes.subarray(0, 64).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return json;
  if (head.startsWith('<')) return xml;
  if (head === '') return json;
  return null;
}

export function parserFor(format: string, contentType: string | null, bytes: Buffer): FormatParser {
  if (format !== 'auto') {
    const named = REGISTRY[format];
    if (named) return named;
    throw refusal({ message: `Silo has no parser called ${format}.`, code: 'refusal.format_unknown', detail: { format } });
  }

  const found = byContentType(contentType);
  if (found) return found;

  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream') {
    const announced = magic(bytes);
    if (announced) return announced;
  }
  if (type === '' || type === 'text/plain' || type === 'text/html') {
    const guessed = sniff(bytes);
    if (guessed) return guessed;
    if (type === 'text/plain') return text;
  }

  throw refusal({
    message: `The source answered ${contentType ?? 'with no content type'}, and this connector does not say how to read it. Name a format.`,
    code: 'refusal.format_unknown',
    detail: { contentType },
  });
}

/**
 * Bytes to the value expressions run on.
 *
 * AN EMPTY BODY IS NULL, whatever the format — a 204 has nothing to parse, and
 * a parser asked to read nothing would either invent a value or throw.
 */
export async function parseBody(input: {
  bytes: Buffer;
  format: string;
  charset: string;
  contentType: string | null;
  options: FormatOptions;
}): Promise<unknown> {
  if (input.bytes.length === 0) return null;

  const parser = parserFor(input.format, input.contentType, input.bytes);
  const payload = parser.binary ? input.bytes : decode(input.bytes, input.charset, input.contentType);

  try {
    return await parser.parse({ input: payload, options: input.options, contentType: input.contentType });
  } catch (error) {
    /*
     * JSON LINES LOOK LIKE JSON TO A SNIFF. Under `auto`, a body that is one
     * JSON value per line is read as that rather than refused as malformed JSON.
     */
    if (input.format === 'auto' && parser === json && error instanceof FormatError && typeof payload === 'string' && /\}\s*\r?\n\s*\{/.test(payload)) {
      try {
        return await ndjson.parse({ input: payload, options: input.options, contentType: input.contentType });
      } catch {
        /* not JSON lines either: the original error says why */
      }
    }
    if (error instanceof FormatError) {
      throw upstream({
        message: error.message,
        code: 'upstream.malformed_response',
        detail: { format: error.format, at: error.at ?? null },
      });
    }
    throw error;
  }
}

export { decode } from './charset.format';
