// The migration bundle (spec 6.4: "export under tenant context → encrypt to destination
// import key"): one file holding everything the organisation moves, sealed so only the
// destination can open it, written and read as a stream so no process holds it whole.
//
//   "SILOTB02" | header length (4 bytes, big endian) | header (canonical JSON) | segment ...
//   segment: nonce (12) | sealed length (4 bytes, big endian) | ciphertext and GCM tag
//
// The header names the migration, the organisation and both cells, and carries the bundle
// key sealed to the destination's import key. Each segment seals at most SEGMENT_BYTES of
// the payload, gzipped, under AES-256-GCM with its own nonce. Its associated data is the
// header, the segment's number (8 bytes) and whether it is the last (1 byte), so a header
// altered or moved, a segment altered, moved or dropped, a bundle cut short at a segment's
// end, or bytes added after the last, each fail to open. The bundle's checksum is SHA-256
// of the whole file, worked out as it is written and as it is read.
//
// The payload is a sequence of records, each a length (4 bytes, big endian) and msgpack, in
// this order: the organisation's keys (sealed apart, by the credential service), the
// operators its rows name, its row, its member users, each table and its rows in batches,
// the migration and its history, the checksums, each stored file and its bytes in chunks,
// and an end record. The destination reads them in that order and loads as it goes.
//
// What stays behind is STAYS_BEHIND, each with its reason: credentials above all, which
// "are never migrated, because they are sealed under the source cell's keys" (spec 6.4).

import { pack, unpack } from 'msgpackr';
import { createHash, type Hash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { TransferredKey } from '../../contracts/credential/tenantKeys.contract.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { aesGcmOpen, aesGcmSeal, KEY_BYTES, NONCE_BYTES, randomBytes, TAG_BYTES, zeroise } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { sealToImportKey } from '../../utils/importKey.util.ts';

export const BUNDLE_FORMAT = 'silo.tenant_bundle.v2';
const MAGIC = Buffer.from('SILOTB02');
const MAX_HEADER_BYTES = 65_536;
/** Payload bytes per segment, before compression. */
export const SEGMENT_BYTES = 1 << 20;
/** A sealed segment is never more than this: gzip adds little even to bytes that do not compress. */
const MAX_SEALED_BYTES = SEGMENT_BYTES + 65_536;
/** One record's bytes at most: a batch of rows is cut below it, and a file's bytes travel in chunks. */
export const MAX_RECORD_BYTES = 16 << 20;
/** A file's bytes per data record. */
export const DATA_CHUNK_BYTES = 1 << 20;
/** A rows record is cut at this many bytes of row text. */
const ROWS_RECORD_BYTES = 4 << 20;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Tenant tables whose rows do not move, and why. Everything else does. */
export const STAYS_BEHIND: Readonly<Record<string, string>> = {
  'connect.connection_credentials': 'credentials, sealed under the source cell\'s keys: every connection is re-authorised (spec 6.4)',
  'connect.oauth_pending_flows': 'OAuth flows in progress, their verifiers sealed under the source cell\'s keys: started again',
  'connect.agent_enrolment_tokens': 'single-use enrolment tokens for the source cell\'s agent endpoint',
  'iam.identity_providers': 'SSO configuration and its secret, sealed under the source cell\'s keys: set up again, as a connection is re-authorised',
  'iam.user_identities': 'links to the identity providers that stay behind: made again at the first SSO sign-in',
  'iam.credential_unwraps': 'the ledger of unwrapping credentials that stay behind; it stays with them until the source purge',
  'iam.sessions': 'sessions end: everyone signs in again in the destination',
  'platform.outbox': 'the source cell\'s events: the export waits until every one is published',
  'clone.live_subscriptions': 'live connections to the source cell\'s gateway',
  'clone.layout_precomputations': 'a cache, worked out again on demand',
};

/** Tenant tables carried in their own part of the bundle, not as rows of a table. */
export const CARRIED_APART: Readonly<Record<string, string>> = {
  'iam.organisation_keys': 'sealed to the destination by the credential service and wrapped there under the destination KEK',
  'platform.tenant_migrations': 'the migration itself and the organisation\'s earlier ones',
  'platform.tenant_migration_tables': 'the counts and checksums the load is verified against',
};

export interface BundleHeader {
  format: typeof BUNDLE_FORMAT;
  migrationId: string;
  organisationId: string;
  organisationSlug: string;
  sourceCellId: string;
  destinationCellId: string;
  destinationKeyId: string;
  /** The bundle key, sealed to the destination's import key, base64. */
  sealedKey: string;
  createdAt: string;
}

export interface TableChecksum { id: string; schema: string; table: string; rowCount: number; checksum: string }

/** The payload's records, in the order they are written (RECORD_ORDER). Rows are jsonb text. */
export type BundleRecord =
  | { kind: 'keys'; keys: TransferredKey[] }
  | { kind: 'operators'; rows: string[] }
  | { kind: 'organisation'; rows: string[] }
  | { kind: 'users'; rows: string[] }
  | { kind: 'table'; schema: string; table: string; insertable: string[] }
  | { kind: 'rows'; rows: string[] }
  /** The migration's own row and the organisation's earlier migrations and their tables. */
  | { kind: 'migration'; migration: string; history: { migrations: string[]; tables: string[] } }
  | { kind: 'checksums'; checksums: TableChecksum[] }
  | { kind: 'object'; bucket: 'files' | 'siloes'; key: string; contentType: string; bytes: number }
  | { kind: 'data'; body: Buffer }
  | { kind: 'end'; objects: number };

/** Where each record may come; a table's rows follow it, and a file's data follows it. */
export const RECORD_ORDER = ['keys', 'operators', 'organisation', 'users', 'table', 'migration', 'checksums', 'object', 'end'] as const;

// ----------------------------------------------------------------------------- checksums

/** SHA-256 over rows given in byte order of their text, each followed by a newline. */
export function rowHasher(): { add(rows: readonly string[]): void; result(): { rowCount: number; checksum: string } } {
  const hash = createHash('sha256');
  let rowCount = 0;
  return {
    add(rows) {
      for (const row of rows) hash.update(row).update('\n');
      rowCount += rows.length;
    },
    result: () => ({ rowCount, checksum: hash.digest('hex') }),
  };
}

/** The same checksum over rows in any order: sorted by the bytes of their text first, as a cursor reads them (collate "C"). */
export function checksumOf(rows: readonly string[]): { rowCount: number; checksum: string } {
  const hasher = rowHasher();
  hasher.add(rows.map((r) => Buffer.from(r)).sort(Buffer.compare).map((b) => b.toString()));
  return hasher.result();
}

// ----------------------------------------------------------------------------- writing

const bundleKeyDocument = (migrationId: string, key: Buffer): Buffer =>
  canonicalJsonBytes({ aad: 'tenant_bundle', migration_id: migrationId, key: key.toString('base64') });

const segmentAad = (headerBytes: Buffer, index: number, last: boolean): Buffer => {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(index));
  tail[8] = last ? 1 : 0;
  return Buffer.concat([headerBytes, tail]);
};

export interface BundleSink { write(chunk: Buffer): Promise<void> }

export interface BundleWriter {
  write(record: BundleRecord): Promise<void>;
  /** A table's rows, cut into records below ROWS_RECORD_BYTES. */
  writeRows(rows: readonly string[]): Promise<void>;
  /** Seals what is left as the last segment; the sink is then complete. */
  finish(): Promise<{ bytes: number; checksum: Buffer }>;
  /** Forgets the bundle key, for a bundle abandoned part way. */
  discard(): void;
}

export async function createBundleWriter(sink: BundleSink, header: Omit<BundleHeader, 'format' | 'sealedKey'>, destinationKey: string): Promise<BundleWriter> {
  const key = randomBytes(KEY_BYTES);
  const document = bundleKeyDocument(header.migrationId, key);
  let headerBytes: Buffer;
  try {
    headerBytes = canonicalJsonBytes({ format: BUNDLE_FORMAT, ...header, sealedKey: sealToImportKey(destinationKey, document).toString('base64') });
  } catch (error) {
    zeroise(key);
    throw error;
  } finally {
    zeroise(document);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const emit = async (chunk: Buffer): Promise<void> => {
    hash.update(chunk);
    bytes += chunk.length;
    await sink.write(chunk);
  };
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  await emit(Buffer.concat([MAGIC, length, headerBytes]));

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let index = 0;
  let finished = false;

  async function seal(plain: Buffer, last: boolean): Promise<void> {
    const { nonce, ciphertext } = aesGcmSeal(key, await gzipAsync(plain), segmentAad(headerBytes, index, last));
    const size = Buffer.alloc(4);
    size.writeUInt32BE(ciphertext.length);
    index += 1;
    await emit(Buffer.concat([nonce, size, ciphertext]));
  }

  async function write(record: BundleRecord): Promise<void> {
    if (finished) throw new AppError('internal', 'the bundle is already finished');
    const body = pack(record);
    if (body.length > MAX_RECORD_BYTES) throw new AppError('internal', `a bundle record of ${body.length} bytes is over the limit`);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(body.length);
    pending.push(size, body);
    pendingBytes += 4 + body.length;
    if (pendingBytes < SEGMENT_BYTES) return;
    let all = Buffer.concat(pending);
    while (all.length >= SEGMENT_BYTES) {
      await seal(all.subarray(0, SEGMENT_BYTES), false);
      all = all.subarray(SEGMENT_BYTES);
    }
    pending = [Buffer.from(all)];
    pendingBytes = all.length;
  }

  return {
    write,
    async writeRows(rows) {
      let batch: string[] = [];
      let batchBytes = 0;
      for (const row of rows) {
        if (batch.length > 0 && batchBytes + row.length > ROWS_RECORD_BYTES) {
          await write({ kind: 'rows', rows: batch });
          batch = [];
          batchBytes = 0;
        }
        batch.push(row);
        batchBytes += row.length;
      }
      if (batch.length > 0) await write({ kind: 'rows', rows: batch });
    },
    async finish() {
      if (finished) throw new AppError('internal', 'the bundle is already finished');
      try {
        await seal(Buffer.concat(pending), true);
      } finally {
        finished = true;
        zeroise(key);
      }
      return { bytes, checksum: hash.digest() };
    },
    discard() {
      finished = true;
      zeroise(key);
    },
  };
}

// ----------------------------------------------------------------------------- reading

/** Bytes of the bundle by range: start inclusive, end exclusive. */
export interface RangeSource { size: number; read(start: number, end: number): Promise<Buffer> }

const malformed = (why: string): AppError =>
  new AppError('integrity', `not a whole tenant migration bundle: ${why}`, { code: 'tenant_migrations.bundle_malformed' });

/** Reads a source front to back through a window, hashing every byte it hands out. */
function sequential(source: RangeSource, windowBytes: number) {
  const hash = createHash('sha256');
  let position = 0;
  let window: Buffer = Buffer.alloc(0);
  let windowStart = 0;
  return {
    hash: hash as Hash,
    remaining: () => source.size - position,
    position: () => position,
    async take(n: number): Promise<Buffer> {
      if (n < 0 || position + n > source.size) throw malformed('it ends early');
      const out = Buffer.allocUnsafe(n);
      let filled = 0;
      while (filled < n) {
        const offset = position - windowStart;
        if (offset >= window.length) {
          const end = Math.min(source.size, position + Math.max(windowBytes, n - filled));
          window = await source.read(position, end);
          windowStart = position;
          if (window.length !== end - position) throw malformed('a read came back short');
          continue;
        }
        const piece = window.subarray(offset, offset + (n - filled));
        piece.copy(out, filled);
        filled += piece.length;
        position += piece.length;
      }
      hash.update(out);
      return out;
    },
  };
}

async function headerOf(reader: ReturnType<typeof sequential>): Promise<{ header: BundleHeader; headerBytes: Buffer }> {
  if (reader.remaining() < MAGIC.length + 4 || !(await reader.take(MAGIC.length)).equals(MAGIC)) throw malformed('no bundle header');
  const length = (await reader.take(4)).readUInt32BE(0);
  if (length > MAX_HEADER_BYTES) throw malformed('the header is too long');
  const headerBytes = await reader.take(length);
  let header: BundleHeader;
  try {
    header = JSON.parse(headerBytes.toString('utf8')) as BundleHeader;
  } catch {
    throw malformed('the header is not JSON');
  }
  if (header.format !== BUNDLE_FORMAT || typeof header.migrationId !== 'string' || typeof header.sealedKey !== 'string') {
    throw malformed('the header is not a tenant bundle\'s');
  }
  return { header, headerBytes };
}

/** The header alone: which migration, for which cell. Not yet proof of anything: opening the segments is. */
export async function readBundleHeader(source: RangeSource): Promise<BundleHeader> {
  return (await headerOf(sequential(source, MAX_HEADER_BYTES))).header;
}

export interface BundleReader {
  header: BundleHeader;
  /** The records in order. Each segment is opened before any of its records is given out. */
  records(): AsyncGenerator<BundleRecord>;
  /** Once records() has run to the end: the bundle's size and SHA-256. */
  digest(): { bytes: number; checksum: Buffer };
}

export async function openBundleReader(source: RangeSource, key: Buffer, options: { windowBytes?: number } = {}): Promise<BundleReader> {
  const reader = sequential(source, options.windowBytes ?? 8 * SEGMENT_BYTES);
  const { header, headerBytes } = await headerOf(reader);
  let done = false;
  return {
    header,
    async *records() {
      let index = 0;
      let carry: Buffer = Buffer.alloc(0);
      if (reader.remaining() === 0) throw malformed('it has no segments');
      while (reader.remaining() > 0) {
        const nonce = await reader.take(NONCE_BYTES);
        const size = (await reader.take(4)).readUInt32BE(0);
        if (size < TAG_BYTES || size > MAX_SEALED_BYTES) throw malformed('a segment has an impossible length');
        const ciphertext = await reader.take(size);
        const last = reader.remaining() === 0;
        const compressed = aesGcmOpen(key, { nonce, ciphertext }, segmentAad(headerBytes, index, last));
        index += 1;
        let plain: Buffer;
        try {
          plain = await gunzipAsync(compressed, { maxOutputLength: SEGMENT_BYTES });
        } catch {
          throw malformed('a segment does not decompress');
        }
        carry = carry.length === 0 ? plain : Buffer.concat([carry, plain]);
        let offset = 0;
        while (carry.length - offset >= 4) {
          const length = carry.readUInt32BE(offset);
          if (length > MAX_RECORD_BYTES) throw malformed('a record is too long');
          if (carry.length - offset - 4 < length) break;
          const record = unpack(carry.subarray(offset + 4, offset + 4 + length)) as BundleRecord;
          offset += 4 + length;
          if (record.kind === 'data') record.body = Buffer.isBuffer(record.body) ? record.body : Buffer.from(record.body as Uint8Array);
          yield record;
        }
        carry = offset === carry.length ? Buffer.alloc(0) : Buffer.from(carry.subarray(offset));
      }
      if (carry.length > 0) throw malformed('it ends inside a record');
      done = true;
    },
    digest() {
      if (!done) throw new AppError('internal', 'the bundle has not been read to its end');
      return { bytes: source.size, checksum: reader.hash.digest() };
    },
  };
}
