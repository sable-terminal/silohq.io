// Media files built byte by byte for tests (D237): PNG (its header only, or one a browser draws),
// JPEG with EXIF, MP4 (its index before or after its media), WebM, WAV, FLAC, Ogg, MP3 and PDF.

import { crc32, deflateSync } from 'node:zlib';

const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16be = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const box = (type: string, ...body: Buffer[]) => { const inner = Buffer.concat(body); return Buffer.concat([u32be(8 + inner.length), Buffer.from(type, 'latin1'), inner]); };

/** An MP4: ftyp, then the index (mvhd, and a track per handler with its frame size) before or after the media data. */
export function mp4(o: { brand?: string; seconds: number; tracks: { handler: 'vide' | 'soun'; width?: number; height?: number }[]; moovAtEnd?: boolean; mdat?: number }): Buffer {
  const timescale = 1000;
  const mvhd = box('mvhd', Buffer.from([0, 0, 0, 0]), u32be(0), u32be(0), u32be(timescale), u32be(o.seconds * timescale), Buffer.alloc(80));
  const traks = o.tracks.map((t) => box('trak',
    box('tkhd', Buffer.from([0, 0, 0, 7]), Buffer.alloc(76), u32be((t.width ?? 0) * 65536), u32be((t.height ?? 0) * 65536)),
    box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(t.handler, 'latin1'), Buffer.alloc(12)))));
  const moov = box('moov', mvhd, ...traks);
  const ftyp = box('ftyp', Buffer.from(o.brand ?? 'isom', 'latin1'), u32be(512), Buffer.from('isomiso2mp41', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(o.mdat ?? 64));
  return Buffer.concat(o.moovAtEnd ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

export function png(width: number, height: number): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32be(13), Buffer.from('IHDR'), u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0]), u32be(0)]);
}

/** A JPEG with an EXIF block (orientation, DateTimeOriginal) and a baseline frame header. */
export function jpeg(o: { width: number; height: number; orientation?: number; taken?: string }): Buffer {
  // TIFF, big-endian: IFD0 at 8 with orientation and the Exif IFD pointer; the Exif IFD with DateTimeOriginal.
  const date = Buffer.from(`${o.taken ?? '2026:03:01 09:30:00'}\0`, 'latin1');
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + 2 * 12 + 4;
  const dateAt = exifIfd + 2 + 12 + 4;
  const tiff = Buffer.concat([
    Buffer.from('MM'), u16be(42), u32be(ifd0),
    u16be(2),
    u16be(0x0112), u16be(3), u32be(1), u16be(o.orientation ?? 1), u16be(0),
    u16be(0x8769), u16be(4), u32be(1), u32be(exifIfd),
    u32be(0),
    u16be(1),
    u16be(0x9003), u16be(2), u32be(date.length), u32be(dateAt),
    u32be(0),
    date,
  ]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(2 + 6 + tiff.length), Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const sof = Buffer.concat([Buffer.from([0xff, 0xc0]), u16be(17), Buffer.from([8]), u16be(o.height), u16be(o.width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(16), Buffer.from([0xff, 0xd9])]);
}

export function wav(seconds: number, rate = 8000): Buffer {
  const data = Buffer.alloc(seconds * rate * 2);
  const fmt = Buffer.concat([u16le(1), u16le(1), u32le(rate), u32le(rate * 2), u16le(2), u16le(16)]);
  return Buffer.concat([Buffer.from('RIFF'), u32le(4 + 8 + fmt.length + 8 + data.length), Buffer.from('WAVE'), Buffer.from('fmt '), u32le(fmt.length), fmt, Buffer.from('data'), u32le(data.length), data]);
}

const ebml = (id: number[], body: Buffer) => {
  const size = body.length < 127 ? Buffer.from([0x80 | body.length]) : Buffer.from([0x40 | (body.length >> 8), body.length & 0xff]);
  return Buffer.concat([Buffer.from(id), size, body]);
};

export function webm(o: { seconds: number; width?: number; height?: number; audioOnly?: boolean }): Buffer {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], Buffer.from('webm')));
  const length = Buffer.alloc(8); length.writeDoubleBE(o.seconds * 1000);
  const info = ebml([0x15, 0x49, 0xa9, 0x66], Buffer.concat([ebml([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])), ebml([0x44, 0x89], length)]));
  const track = o.audioOnly
    ? ebml([0xae], ebml([0x83], Buffer.from([2])))
    : ebml([0xae], Buffer.concat([ebml([0x83], Buffer.from([1])), ebml([0xe0], Buffer.concat([ebml([0xb0], u16be(o.width ?? 0)), ebml([0xba], u16be(o.height ?? 0))]))]));
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], track);
  // An unknown-size segment, as a live recorder writes it.
  const segment = Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), info, tracks]);
  return Buffer.concat([header, segment]);
}

export function flac(seconds: number, rate = 44_100): Buffer {
  const info = Buffer.alloc(34);
  const samples = seconds * rate;
  info[10] = (rate >> 12) & 0xff; info[11] = (rate >> 4) & 0xff; info[12] = ((rate & 0x0f) << 4) | (1 << 1);
  info[13] = (15 << 4) | Math.floor(samples / 2 ** 32); info.writeUInt32BE(samples % 2 ** 32, 14);
  return Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), info]);
}

function oggPage(granule: bigint, payload: Buffer): Buffer {
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1'); head.writeBigUInt64LE(granule, 6); head[26] = 1;
  return Buffer.concat([head, Buffer.from([payload.length]), payload]);
}

export function oggVorbis(seconds: number, rate = 44_100): Buffer {
  const id = Buffer.concat([Buffer.from('\x01vorbis', 'latin1'), u32le(0), Buffer.from([2]), u32le(rate), Buffer.alloc(13)]);
  return Buffer.concat([oggPage(0n, id), oggPage(BigInt(seconds * rate), Buffer.alloc(10))]);
}

export function oggOpus(seconds: number): Buffer {
  const id = Buffer.concat([Buffer.from('OpusHead', 'latin1'), Buffer.from([1, 2]), u16le(312), u32le(48_000), Buffer.alloc(3)]);
  return Buffer.concat([oggPage(0n, id), oggPage(BigInt(seconds * 48_000 + 312), Buffer.alloc(10))]);
}

/** A constant-bitrate MPEG-1 layer III stream at 128 kbit/s and 44.1 kHz, behind an ID3 tag. */
export function mp3(seconds: number, xing = false): Buffer {
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 10]), Buffer.alloc(10)]);
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const frameBytes = Math.floor((144 * 128_000) / 44_100);
  if (xing) {
    const frames = Math.round((seconds * 44_100) / 1152);
    const first = Buffer.alloc(frameBytes);
    header.copy(first, 0);
    first.write('Xing', 4 + 32, 'latin1'); first.writeUInt32BE(1, 8 + 32); first.writeUInt32BE(frames, 12 + 32);
    return Buffer.concat([id3, first, Buffer.alloc(1000)]);
  }
  const body = Buffer.alloc(Math.round((seconds * 128_000) / 8));
  header.copy(body, 0);
  return Buffer.concat([id3, body]);
}

export function pdf(pages: number): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count ${pages} >> endobj\n%%EOF\n`, 'latin1');
}


/** A PNG a browser can draw: an RGB image of one colour, with its pixel data and checksums. */
export function decodablePng(width: number, height: number, rgb: [number, number, number] = [32, 96, 160]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
  };
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3]!)]);
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
