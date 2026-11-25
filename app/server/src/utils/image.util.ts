// What an image is, from its bytes (spec 56.2: content type by server-side sniffing, never the
// client's header), and its pixel size from its own header. PNG, JPEG and WebP; SVG is
// recognised and sanitised by svg.util.ts. Pure.

export interface RasterImage { contentType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number }

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG, JPEG or WebP and its size, or undefined when the bytes are none of them (or their header is cut short). */
export function rasterImage(bytes: Buffer): RasterImage | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG) && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { contentType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // Segment by segment to the first start-of-frame marker (C0 to CF, but for C4, C8 and CC).
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { contentType: 'image/jpeg', height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      }
      at += 2 + length;
    }
    return undefined;
  }
  if (bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { contentType: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = bytes;
      return { contentType: 'image/webp', width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!), height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)) };
    }
    if (chunk === 'VP8X') return { contentType: 'image/webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  return undefined;
}

/** An SVG's declared size: its width and height in pixels, else its viewBox's; undefined when it declares neither. */
export function svgSize(svg: string): { width: number; height: number } | undefined {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(root)?.[1];
  const px = (v: string | undefined) => (v !== undefined && /^\s*\d+(\.\d+)?\s*(px)?\s*$/.test(v) ? Math.ceil(parseFloat(v)) : undefined);
  const [w, h] = [px(attr('width')), px(attr('height'))];
  if (w !== undefined && h !== undefined) return { width: w, height: h };
  const box = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box.every(Number.isFinite)) return { width: Math.ceil(box[2]!), height: Math.ceil(box[3]!) };
  return undefined;
}
