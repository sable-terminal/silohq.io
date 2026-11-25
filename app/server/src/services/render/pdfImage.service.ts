// A site plan as a PDF image (spec 29.4, 29.10): a canvas exported over a plan prints the plan
// under it. Written here without a library, from the bytes the plan was registered from:
//
// - A JPEG goes in as it is (DCTDecode), its size and colour from its start-of-frame; greyscale
//   and RGB are printed, CMYK is not (undefined, so the export prints without the plan and says so).
// - A PNG is decoded (its scanlines unfiltered) to 8-bit greyscale or RGB, its transparency as a
//   soft mask, and compressed again (FlateDecode): greyscale, RGB, palette and either with alpha,
//   at 1 to 16 bits; an interlaced PNG is not printed.
//
// A plan larger than MAX_PIXELS is not printed either: the drawing stands, flagged.

import { deflateSync, inflateSync } from 'node:zlib';

export interface PdfImage {
  width: number;
  height: number;
  colourSpace: 'DeviceGray' | 'DeviceRGB';
  filter: 'DCTDecode' | 'FlateDecode';
  /** The image's samples as they go into the PDF stream (compressed by `filter`). */
  data: Buffer;
  /** Transparency, as 8-bit greyscale compressed with FlateDecode; absent where opaque. */
  alpha?: Buffer | undefined;
}

export const MAX_PIXELS = 25_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pdfImageOf(bytes: Buffer): PdfImage | undefined {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return png(bytes);
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  return undefined;
}

function jpeg(bytes: Buffer): PdfImage | undefined {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1]!;
    const length = bytes.readUInt16BE(i + 2);
    // Start of frame: baseline, extended, progressive, lossless (not the DHT, JPG or DAC markers).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = bytes.readUInt16BE(i + 5);
      const width = bytes.readUInt16BE(i + 7);
      const components = bytes[i + 9];
      if (width * height > MAX_PIXELS || (components !== 1 && components !== 3)) return undefined;
      return { width, height, colourSpace: components === 1 ? 'DeviceGray' : 'DeviceRGB', filter: 'DCTDecode', data: bytes };
    }
    i += 2 + length;
  }
  return undefined;
}

function png(bytes: Buffer): PdfImage | undefined {
  let width = 0; let height = 0; let depth = 0; let colourType = 0; let interlace = 0;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const data: Buffer[] = [];
  for (let i = 8; i + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.toString('latin1', i + 4, i + 8);
    const body = bytes.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]!; colourType = body[9]!; interlace = body[12]!; }
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    i += 12 + length;
  }
  if (width === 0 || height === 0 || interlace !== 0 || width * height > MAX_PIXELS || data.length === 0) return undefined;
  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 3 ? 1 : colourType === 4 ? 2 : colourType === 6 ? 4 : 0;
  if (channels === 0 || (colourType === 3 && palette === undefined)) return undefined;
  const raw = unfilter(inflateSync(Buffer.concat(data)), width, height, channels, depth);
  if (raw === undefined) return undefined;

  // To 8-bit samples per pixel: grey or RGB, and alpha where the image carries it.
  const grey = colourType === 0 || colourType === 4;
  const out = Buffer.alloc(width * height * (grey ? 1 : 3));
  const hasAlpha = colourType === 4 || colourType === 6 || (colourType === 3 && transparency !== undefined);
  const alpha = hasAlpha ? Buffer.alloc(width * height) : undefined;
  const sample = (row: Buffer, index: number): number => {
    if (depth === 8) return row[index]!;
    if (depth === 16) return row[index * 2]!;
    const perByte = 8 / depth;
    const byte = row[Math.floor(index / perByte)]!;
    const shift = 8 - depth * ((index % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const stride = Math.ceil((width * channels * depth) / 8);
  const scaleUp = depth < 8 && colourType === 0 ? 255 / ((1 << depth) - 1) : 1;
  for (let y = 0; y < height; y += 1) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (colourType === 3) {
        const index = sample(row, x);
        out[p * 3] = palette![index * 3] ?? 0; out[p * 3 + 1] = palette![index * 3 + 1] ?? 0; out[p * 3 + 2] = palette![index * 3 + 2] ?? 0;
        if (alpha !== undefined) alpha[p] = transparency![index] ?? 255;
      } else if (grey) {
        out[p] = Math.round(sample(row, x * channels) * scaleUp);
        if (alpha !== undefined) alpha[p] = sample(row, x * channels + 1);
      } else {
        out[p * 3] = sample(row, x * channels); out[p * 3 + 1] = sample(row, x * channels + 1); out[p * 3 + 2] = sample(row, x * channels + 2);
        if (alpha !== undefined) alpha[p] = sample(row, x * channels + 3);
      }
    }
  }
  const opaque = alpha === undefined || alpha.every((a) => a === 255);
  return {
    width, height, colourSpace: grey ? 'DeviceGray' : 'DeviceRGB', filter: 'FlateDecode', data: deflateSync(out),
    alpha: opaque ? undefined : deflateSync(alpha!),
  };
}

/** PNG scanlines with their filters undone (none, sub, up, average, Paeth). Undefined where the data is short. */
function unfilter(data: Buffer, width: number, height: number, channels: number, depth: number): Buffer | undefined {
  const stride = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, Math.floor((channels * depth) / 8));
  if (data.length < height * (stride + 1)) return undefined;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = data[y * (stride + 1)]!;
    const line = data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const at = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out[at + x - bpp]! : 0;
      const b = y > 0 ? out[at - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[at - stride + x - bpp]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return undefined;
      out[at + x] = v & 0xff;
    }
  }
  return out;
}
