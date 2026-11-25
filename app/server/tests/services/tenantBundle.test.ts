// The tenant migration bundle's format (spec 6.4): written and read as a stream of sealed
// segments. A bundle crosses segments whole and reads back the same through any window; a
// segment altered, dropped, moved or added, and a header altered, each refuse to open.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  checksumOf, createBundleWriter, openBundleReader, readBundleHeader, rowHasher, SEGMENT_BYTES, type BundleRecord, type RangeSource,
} from '../../src/services/tenant-migrations/bundle.service.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';
import { openX25519, x25519FromSeed } from '../../src/utils/importKey.util.ts';

const recipient = x25519FromSeed(randomBytes(32));
const header = {
  migrationId: uuidv7(), organisationId: uuidv7(), organisationSlug: 'acme', sourceCellId: 'uk-1', destinationCellId: 'ded-a',
  destinationKeyId: 'import-1', createdAt: '2026-11-15T09:00:00.000Z',
};
const MAGIC_AND_LENGTH = 12;

const rows = Array.from({ length: 20_000 }, (_, i) => JSON.stringify({ id: i, note: randomBytes(48).toString('hex') }));
const file = randomBytes(2 * SEGMENT_BYTES + 777);
const records: BundleRecord[] = [
  { kind: 'keys', keys: [] },
  { kind: 'operators', rows: [] },
  { kind: 'organisation', rows: ['{"id": "o"}'] },
  { kind: 'users', rows: [] },
  { kind: 'table', schema: 'iam', table: 'notes', insertable: ['id', 'note'] },
  { kind: 'rows', rows: rows.slice(0, 10_000) },
  { kind: 'rows', rows: rows.slice(10_000) },
  { kind: 'object', bucket: 'files', key: 'org/x/files/y', contentType: 'application/octet-stream', bytes: file.length },
  { kind: 'data', body: file.subarray(0, SEGMENT_BYTES) },
  { kind: 'data', body: file.subarray(SEGMENT_BYTES) },
  { kind: 'end', objects: 1 },
];

async function written(): Promise<{ bytes: Buffer; checksum: Buffer }> {
  const chunks: Buffer[] = [];
  const writer = await createBundleWriter({ async write(chunk) { chunks.push(chunk); } }, header, recipient.publicKeyPem);
  for (const record of records) await writer.write(record);
  const out = await writer.finish();
  const bytes = Buffer.concat(chunks);
  assert.equal(out.bytes, bytes.length);
  return { bytes, checksum: out.checksum };
}

const sourceOf = (bytes: Buffer): RangeSource => ({ size: bytes.length, read: async (start, end) => Buffer.from(bytes.subarray(start, end)) });

async function keyOf(bytes: Buffer): Promise<Buffer> {
  const found = await readBundleHeader(sourceOf(bytes));
  const document = JSON.parse(openX25519(recipient.privateKey, Buffer.from(found.sealedKey, 'base64')).toString()) as { key: string };
  return Buffer.from(document.key, 'base64');
}

async function readAll(bytes: Buffer, key: Buffer, windowBytes?: number): Promise<{ records: BundleRecord[]; checksum: Buffer }> {
  const reader = await openBundleReader(sourceOf(bytes), key, windowBytes === undefined ? {} : { windowBytes });
  const out: BundleRecord[] = [];
  for await (const record of reader.records()) out.push(record);
  return { records: out, checksum: reader.digest().checksum };
}

/** Where each segment starts and ends. */
function segments(bytes: Buffer): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let at = MAGIC_AND_LENGTH + bytes.readUInt32BE(8);
  while (at < bytes.length) {
    const end = at + 16 + bytes.readUInt32BE(at + 12);
    out.push({ start: at, end });
    at = end;
  }
  return out;
}

const integrity = (error: unknown): boolean => (error as { category?: string }).category === 'integrity';

describe('the streamed tenant bundle (spec 6.4)', () => {
  let bundle: { bytes: Buffer; checksum: Buffer };
  let key: Buffer;

  test('records cross segments whole and read back the same through any window', async () => {
    bundle = await written();
    key = await keyOf(bundle.bytes);
    assert.ok(segments(bundle.bytes).length >= 4, 'several segments');
    assert.deepEqual(bundle.checksum, createHash('sha256').update(bundle.bytes).digest(), 'the checksum is SHA-256 of the whole file');
    for (const windowBytes of [undefined, 4_096, 1_000_003]) {
      const read = await readAll(bundle.bytes, key, windowBytes);
      assert.deepEqual(read.records, records);
      assert.deepEqual(read.checksum, bundle.checksum, 'the reader works out the same checksum');
    }
    const found = await readBundleHeader(sourceOf(bundle.bytes));
    assert.deepEqual([found.migrationId, found.destinationCellId], [header.migrationId, header.destinationCellId]);
  });

  test('a segment altered, dropped, moved or added, or the header altered, refuses to open', async () => {
    const parts = segments(bundle.bytes);
    const flipped = Buffer.from(bundle.bytes);
    const at = parts[1]!.start + 40;
    flipped.writeUInt8(flipped.readUInt8(at) ^ 1, at);
    await assert.rejects(readAll(flipped, key), integrity, 'a byte changed');

    const cut = bundle.bytes.subarray(0, parts[1]!.end);
    await assert.rejects(readAll(cut, key), integrity, 'cut short at a segment\'s end');

    const last = parts[parts.length - 1]!;
    const added = Buffer.concat([bundle.bytes, bundle.bytes.subarray(last.start, last.end)]);
    await assert.rejects(readAll(added, key), integrity, 'a segment added after the last');

    const [a, b] = [parts[0]!, parts[1]!];
    const swapped = Buffer.concat([
      bundle.bytes.subarray(0, a.start), bundle.bytes.subarray(b.start, b.end), bundle.bytes.subarray(a.start, a.end), bundle.bytes.subarray(b.end),
    ]);
    await assert.rejects(readAll(swapped, key), integrity, 'two segments swapped');

    const renamed = Buffer.from(bundle.bytes.toString('latin1').replace('"ded-a"', '"ded-b"'), 'latin1');
    assert.equal(renamed.length, bundle.bytes.length);
    await assert.rejects(readAll(renamed, key), integrity, 'the header altered');
  });

  test('a table\'s checksum is the same over its rows in any order as over a cursor\'s byte order', () => {
    const some = ['{"b": 1}', '{"a": "é"}', '{"a": "z"}', '{"a": "\u{1F600}"}', '{"a": "�"}'];
    const hasher = rowHasher();
    hasher.add(some.map((r) => Buffer.from(r)).sort(Buffer.compare).map((r) => r.toString()));
    assert.deepEqual(checksumOf([...some].reverse()), hasher.result());
    assert.equal(checksumOf(some).rowCount, 5);
  });
});
