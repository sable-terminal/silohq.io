import { inflateRawSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import avro from 'avsc';
import { checkCount, FormatError, type FormatParser } from './contract.format';

/**
 * The columnar and row-container formats data warehouses and message buses
 * use: Parquet and Avro. (Protocol Buffers, which needs a descriptor from
 * outside the bytes, is in its own file.)
 *
 * BOTH CARRY THEIR SCHEMA, AND THE VALUES COME OUT PLAIN. Whatever the format's own types, what an
 * expression sees is JSON-shaped: 64-bit integers as text (a number would lose
 * digits), bytes as base64, timestamps as ISO 8601.
 */

function plain(value: unknown, depth = 0): unknown {
  if (depth > 32) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map((one) => plain(one, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = plain(v, depth + 1);
    return out;
  }
  return value;
}

const bytesOf = (input: string | Buffer): Buffer => (Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'latin1'));

export const parquet: FormatParser = {
  name: 'parquet',
  contentTypes: ['application/vnd.apache.parquet', 'application/x-parquet'],
  binary: true,
  async parse({ input }) {
    const bytes = bytesOf(input);
    const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await parquetReadObjects({ file, compressors });
    } catch (error) {
      throw new FormatError('parquet', `The file is not Parquet Silo can read: ${error instanceof Error ? error.message : 'unreadable'}.`);
    }
    checkCount('parquet', rows.length);
    return rows.map((row) => plain(row));
  },
};

type Codec = (buffer: Buffer, done: (error: Error | null, out?: Buffer) => void) => void;
const codec = (inflate: (buffer: Buffer) => Uint8Array): Codec => (buffer, done) => {
  try {
    done(null, Buffer.from(inflate(buffer)));
  } catch (error) {
    done(error as Error);
  }
};

/** Snappy's raw format opens with the uncompressed length as a varint. */
function snappyLength(bytes: Uint8Array): number {
  let length = 0;
  for (let i = 0, shift = 0; i < 5 && i < bytes.length; i++, shift += 7) {
    length |= (bytes[i]! & 0x7f) << shift;
    if ((bytes[i]! & 0x80) === 0) return length >>> 0;
  }
  throw new FormatError('avro', 'A snappy block has no length.');
}

/**
 * THE CODECS THE AVRO SPECIFICATION NAMES THAT SYSTEMS ACTUALLY USE. `null` and
 * `deflate` are required by the specification; snappy is what Hadoop and Kafka
 * Connect write, with a CRC-32 of the block after it; zstandard is 1.9 onwards.
 * bzip2 and xz are left to fail by name.
 */
const AVRO_CODECS: Record<string, Codec> = {
  null: codec((buffer) => buffer),
  deflate: codec((buffer) => inflateRawSync(buffer)),
  snappy: codec((buffer) => {
    const block = buffer.subarray(0, buffer.length - 4);
    return compressors.SNAPPY!(block, snappyLength(block));
  }),
  zstandard: codec((buffer) => compressors.ZSTD!(buffer, 0)),
};

export const avroFormat: FormatParser = {
  name: 'avro',
  contentTypes: ['avro/binary', 'application/avro', 'application/vnd.apache.avro+binary'],
  binary: true,
  async parse({ input }) {
    const bytes = bytesOf(input);
    const records: unknown[] = [];
    const decoder = new avro.streams.BlockDecoder({ codecs: AVRO_CODECS });
    let header = false;
    await new Promise<void>((resolve, reject) => {
      decoder.on('metadata', () => {
        header = true;
      });
      decoder.on('data', (record: unknown) => {
        records.push(plain(record));
        if (records.length > 200_000) decoder.destroy(new FormatError('avro', 'The file holds more records than one read may.'));
      });
      decoder.on('error', (error: Error) => reject(error instanceof FormatError ? error : new FormatError('avro', `The file is not an Avro container Silo can read: ${error.message}.`)));
      /* A truncated header ends the stream quietly; an empty table is not what arrived. */
      decoder.on('end', () => (header ? resolve() : reject(new FormatError('avro', 'The body is not an Avro container: its header is missing or cut short.'))));
      Readable.from([bytes]).pipe(decoder);
    });
    checkCount('avro', records.length);
    return records;
  },
};
