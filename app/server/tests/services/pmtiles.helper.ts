// A Protomaps archive and a vector tile, written byte by byte for tests of the base map (D227):
// PMTiles v3 (a 127-byte header, a root directory of one entry, empty metadata, one gzipped tile
// at 0/0/0) and Mapbox Vector Tile 2 (named layers of squares, as polygons in a 4096 extent).

import { gzipSync } from 'node:zlib';

const varint = (n: number): number[] => {
  const out: number[] = [];
  for (; n >= 0x80; n = Math.floor(n / 0x80)) out.push((n & 0x7f) | 0x80);
  return [...out, n];
};

/** One tile, at 0/0/0, in an archive covering bounds [west, south, east, north]. */
export function pmtilesArchive(tile: Buffer, bounds: [number, number, number, number] = [-8, 49.5, 2, 61]): Buffer {
  const gz = gzipSync(tile);
  const directory = Buffer.from([...varint(1), ...varint(0), ...varint(1), ...varint(gz.length), ...varint(1)]);
  const metadata = Buffer.from('{}');
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'latin1');
  header.writeUInt8(3, 7);
  const u64 = (at: number, n: number) => header.writeBigUInt64LE(BigInt(n), at);
  const root = 127;
  u64(8, root); u64(16, directory.length);
  u64(24, root + directory.length); u64(32, metadata.length);
  u64(40, 0); u64(48, 0);
  u64(56, root + directory.length + metadata.length); u64(64, gz.length);
  u64(72, 1); u64(80, 1); u64(88, 1);
  // Clustered; internal compression none; tiles gzipped; vector (MVT); zooms 0 to 0.
  header.writeUInt8(1, 96); header.writeUInt8(1, 97); header.writeUInt8(2, 98); header.writeUInt8(1, 99);
  header.writeUInt8(0, 100); header.writeUInt8(0, 101);
  bounds.forEach((v, i) => header.writeInt32LE(Math.round(v * 10_000_000), 102 + 4 * i));
  return Buffer.concat([header, directory, metadata, gz]);
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);
const field = (tag: number, body: number[]) => [...varint(tag), ...varint(body.length), ...body];

/** A vector tile: each layer's squares [x0, y0, x1, y1] in tile units (0 to 4096), clockwise. */
export function vectorTile(layers: { name: string; squares: [number, number, number, number][] }[]): Buffer {
  const out: number[] = [];
  for (const layer of layers) {
    const body: number[] = [...varint((15 << 3) | 0), 2, ...field((1 << 3) | 2, [...Buffer.from(layer.name)])];
    for (const [x0, y0, x1, y1] of layer.squares) {
      const w = x1 - x0;
      const h = y1 - y0;
      const geometry = [9, zigzag(x0), zigzag(y0), 26, zigzag(w), 0, 0, zigzag(h), zigzag(-w), 0, 15].flatMap(varint);
      body.push(...field((2 << 3) | 2, [...varint((3 << 3) | 0), 3, ...field((4 << 3) | 2, geometry)]));
    }
    body.push(...varint((5 << 3) | 0), ...varint(4096));
    out.push(...field((3 << 3) | 2, body));
  }
  return Buffer.from(out);
}
