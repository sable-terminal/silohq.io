// A gzipped POSIX tar (ustar): the organisation export's bundle (spec 2.6), readable
// without Silo by any tar. Regular files only, mode 0644, owner 0, one modification time.
// A name longer than 100 bytes is split into the 155-byte prefix and the name at a slash; a
// file over 8 GiB, or a name that cannot be split, is refused.
//
// tarGzip builds one in memory; createTarGzipWriter writes one as it goes, each file in
// gzip members of its own (RFC 1952 lets a file hold several, and gunzip and tar read them
// as one stream), so the bundle is never held whole.

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gzipSync } from 'node:zlib';

const gzipAsync = promisify(gzip);

const BLOCK = 512;
const MAX_SIZE = 8 ** 11 - 1;

export interface TarFile { path: string; body: Buffer }

function field(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value, offset, length, 'utf8');
}

const octal = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, '0')}\0`;

function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new RangeError(`a tar path cannot hold ${path}`);
}

function header(path: string, size: number, mtime: number): Buffer {
  if (size > MAX_SIZE) throw new RangeError(`${path} is larger than a tar entry holds`);
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(path);
  field(h, 0, 100, name);
  field(h, 100, 8, octal(0o644, 8));
  field(h, 108, 8, octal(0, 8));
  field(h, 116, 8, octal(0, 8));
  field(h, 124, 12, octal(size, 12));
  field(h, 136, 12, octal(mtime, 12));
  field(h, 148, 8, '        ');
  field(h, 156, 1, '0');
  field(h, 257, 6, 'ustar\0');
  field(h, 263, 2, '00');
  field(h, 345, 155, prefix);
  let sum = 0;
  for (const byte of h) sum += byte;
  field(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

export function tarGzip(files: readonly TarFile[], modifiedAt: Date): Buffer {
  const mtime = Math.floor(modifiedAt.getTime() / 1000);
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(header(file.path, file.body.length, mtime), file.body);
    const pad = (BLOCK - (file.body.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

export interface TarGzipWriter {
  /** One file: its header, its bytes and its padding, each gzipped and handed to the sink. */
  add(path: string, body: Buffer): Promise<void>;
  /** The end of the archive; then the archive's size and SHA-256, as written. */
  finish(): Promise<{ bytes: number; sha256: Buffer }>;
}

export function createTarGzipWriter(sink: { write(chunk: Buffer): Promise<void> }, modifiedAt: Date): TarGzipWriter {
  const mtime = Math.floor(modifiedAt.getTime() / 1000);
  const hash = createHash('sha256');
  let bytes = 0;
  const member = async (plain: Buffer): Promise<void> => {
    const packed = await gzipAsync(plain);
    hash.update(packed);
    bytes += packed.length;
    await sink.write(packed);
  };
  return {
    async add(path, body) {
      // The body is a member of its own, so it is never copied beside its header.
      await member(header(path, body.length, mtime));
      if (body.length > 0) await member(body);
      const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
      if (pad > 0) await member(Buffer.alloc(pad));
    },
    async finish() {
      await member(Buffer.alloc(BLOCK * 2));
      return { bytes, sha256: hash.digest() };
    },
  };
}

/** The files of a tarGzip archive, for checking one (tests, and anyone reading an export). */
export function readTar(archive: Buffer): TarFile[] {
  const files: TarFile[] = [];
  for (let at = 0; at + BLOCK <= archive.length;) {
    const h = archive.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    const text = (offset: number, length: number) => h.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(text(124, 12).trim(), 8);
    const prefix = text(345, 155);
    const name = text(0, 100);
    files.push({ path: prefix ? `${prefix}/${name}` : name, body: Buffer.from(archive.subarray(at + BLOCK, at + BLOCK + size)) });
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
