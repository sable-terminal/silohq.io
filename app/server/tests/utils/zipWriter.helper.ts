// A zip archive written in memory for tests (PKWARE APPNOTE 6.3): entries deflated or
// stored, and, when asked, the zip64 end records an archive of more than 65,535 entries
// carries (OSV's exports do), so the reader's zip64 path is exercised without that many.

import { crc32, deflateRawSync } from 'node:zlib';

export function zipOf(entries: readonly { name: string; body: Buffer; store?: boolean }[], options: { zip64?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.store ? entry.body : deflateRawSync(entry.body);
    const method = entry.store ? 0 : 8;
    const crc = crc32(entry.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(entry.body.length, 24);
    header.writeUInt16LE(name.length, 28);
    let extra = Buffer.alloc(0);
    if (options.zip64) {
      // The local header offset given in the zip64 extra field, as a large archive gives it.
      header.writeUInt32LE(0xffffffff, 42);
      extra = Buffer.alloc(12);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(offset), 4);
    } else {
      header.writeUInt32LE(offset, 42);
    }
    header.writeUInt16LE(extra.length, 30);
    central.push(header, name, extra);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end: Buffer[] = [];
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    end.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  eocd.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...parts, directory, ...end, eocd]);
}
