// Reading a zip archive (PKWARE APPNOTE 6.3) by range, never whole: the central directory
// from the end, then the entries in batches of neighbours. Zip64 is read (an archive of
// more than 65,535 entries, as OSV's exports are); entries are stored or deflated, and
// each is checked against its CRC-32. Encrypted entries, and archives split over disks,
// are refused. Fleet reads advisory exports this way (spec 11.1).

import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';
import { AppError } from './errors.util.ts';

const inflateRawAsync = promisify(inflateRaw);

/** Bytes by range: start inclusive, end exclusive. */
export interface ZipSource { size: number; read(start: number, end: number): Promise<Buffer> }

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 65_535;
const FULL32 = 0xffffffff;

const malformed = (why: string): AppError => new AppError('integrity', `not a zip archive Silo reads: ${why}`, { code: 'zip.malformed' });

export interface ZipArchive { entries: ZipEntry[]; directoryOffset: number }

const u64 = (buffer: Buffer, at: number): number => {
  const value = buffer.readBigUInt64LE(at);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed('a zip64 field is too large');
  return Number(value);
};

async function readExactly(source: ZipSource, start: number, end: number): Promise<Buffer> {
  if (start < 0 || end > source.size || start > end) throw malformed('a zip structure points outside the archive');
  const out = await source.read(start, end);
  if (out.length !== end - start) throw malformed('a read came back short');
  return out;
}

/** The archive's entries, from its central directory, in directory order. */
export async function zipEntries(source: ZipSource): Promise<ZipArchive> {
  const tailStart = Math.max(0, source.size - (22 + MAX_COMMENT) - 20);
  const tail = await readExactly(source, tailStart, source.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw malformed('no end of central directory');
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw malformed('archives split over disks are not read');
  let count = tail.readUInt16LE(eocd + 10);
  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === FULL32 || offset === FULL32) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) throw malformed('a zip64 archive without its locator');
    const recordAt = u64(tail, locator + 8);
    const record = await readExactly(source, recordAt, recordAt + 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw malformed('no zip64 end of central directory');
    count = u64(record, 32);
    size = u64(record, 40);
    offset = u64(record, 48);
  }
  const directory = await readExactly(source, offset, offset + size);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) throw malformed('a central directory entry is malformed');
    const flags = directory.readUInt16LE(at + 8);
    if ((flags & 0x1) !== 0) throw malformed('encrypted entries are not read');
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    let compressedSize = directory.readUInt32LE(at + 20);
    let entrySize = directory.readUInt32LE(at + 24);
    let local = directory.readUInt32LE(at + 42);
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    // The zip64 extra field holds, in this order, whichever of these were too large.
    for (let e = at + 46 + nameLength; e + 4 <= at + 46 + nameLength + extraLength;) {
      const id = directory.readUInt16LE(e);
      const length = directory.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let field = e + 4;
        if (entrySize === FULL32) {
          entrySize = u64(directory, field);
          field += 8;
        }
        if (compressedSize === FULL32) {
          compressedSize = u64(directory, field);
          field += 8;
        }
        if (local === FULL32) local = u64(directory, field);
      }
      e += 4 + length;
    }
    entries.push({ name, method: directory.readUInt16LE(at + 10), crc32: directory.readUInt32LE(at + 16), compressedSize, size: entrySize, offset: local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, directoryOffset: offset };
}

/**
 * The entries' contents, read in batches of neighbours of about batchBytes, in archive
 * order. Each is inflated and checked against its CRC-32 and size before it is given out.
 */
export async function* zipContents(source: ZipSource, archive: ZipArchive, options: { batchBytes?: number } = {})
  : AsyncGenerator<{ entry: ZipEntry; body: Buffer }> {
  const batchBytes = options.batchBytes ?? 8 << 20;
  const sorted = [...archive.entries].sort((a, b) => a.offset - b.offset);
  // An entry ends where the next begins; the last, where the central directory does.
  const endOf = (i: number): number => (i + 1 < sorted.length ? sorted[i + 1]!.offset : archive.directoryOffset);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && endOf(j + 1) - sorted[i]!.offset <= batchBytes) j += 1;
    const start = sorted[i]!.offset;
    const batch = await readExactly(source, start, endOf(j));
    for (let k = i; k <= j; k++) {
      const entry = sorted[k]!;
      const at = entry.offset - start;
      if (at + 30 > batch.length || batch.readUInt32LE(at) !== LOCAL) throw malformed(`${entry.name}: no local header`);
      const dataAt = at + 30 + batch.readUInt16LE(at + 26) + batch.readUInt16LE(at + 28);
      if (dataAt + entry.compressedSize > batch.length) throw malformed(`${entry.name}: its data runs past the next entry`);
      const data = batch.subarray(dataAt, dataAt + entry.compressedSize);
      let body: Buffer;
      if (entry.method === 0) body = Buffer.from(data);
      else if (entry.method === 8) body = await inflateRawAsync(data, { maxOutputLength: Math.max(entry.size, 1) });
      else throw malformed(`${entry.name}: compression method ${entry.method} is not read`);
      if (body.length !== entry.size || crc32(body) !== entry.crc32) throw malformed(`${entry.name}: its size or CRC-32 does not match`);
      yield { entry, body };
    }
    i = j + 1;
  }
}
