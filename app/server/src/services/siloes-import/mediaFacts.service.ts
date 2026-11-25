// Media facts (D237): what kind of media a file is and what can be read from its own bytes,
// without decoding it and without a library. Images give their size (and, for a JPEG, the
// orientation that swaps it and when it was taken); video gives its duration and frame size;
// audio its duration; a PDF its page count where its page tree is readable. Read from the first
// and last bytes of the file (MP4's index may be at either end; Ogg's length is in its last
// page), so a large file is never read whole. A fact that cannot be read is left out, never
// guessed: the file is still media.

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface MediaFacts {
  kind: MediaKind;
  contentType: string;
  width?: number;
  height?: number;
  durationMs?: number;
  pages?: number;
  /** When a photo was taken, as its camera wrote it (EXIF DateTimeOriginal), with no zone: local time. */
  capturedAt?: string;
}

/** How much of each end of a file the facts are read from. */
export const MEDIA_HEAD_BYTES = 512 * 1024;
export const MEDIA_TAIL_BYTES = 512 * 1024;

const ascii = (b: Buffer, at: number, length: number) => (at + length <= b.length ? b.toString('latin1', at, at + length) : '');
const positive = (n: number) => Number.isFinite(n) && n > 0;
const dims = (width: number, height: number) => (positive(width) && positive(height) && width <= 1_000_000 && height <= 1_000_000 ? { width, height } : {});
const duration = (ms: number) => (Number.isFinite(ms) && ms > 0 && ms < 1e12 ? { durationMs: Math.round(ms) } : {});

/** The kind and type a file's bytes say it is, or undefined when it is not media Silo shows. */
export function mediaFacts(head: Buffer, tail: Buffer = Buffer.alloc(0), size = head.length): MediaFacts | undefined {
  try {
    if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47 && ascii(head, 12, 4) === 'IHDR') {
      return { kind: 'image', contentType: 'image/png', ...dims(head.readUInt32BE(16), head.readUInt32BE(20)) };
    }
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: 'image', contentType: 'image/jpeg', ...jpeg(head) };
    if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return { kind: 'image', contentType: 'image/gif', ...dims(head.readUInt16LE(6), head.readUInt16LE(8)) };
    if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return { kind: 'image', contentType: 'image/webp', ...webp(head) };
    if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return { kind: 'audio', contentType: 'audio/wav', ...wav(head, size) };
    if (ascii(head, 4, 4) === 'ftyp') return isoMedia(head, tail, size);
    if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return matroska(head);
    if (ascii(head, 0, 4) === 'fLaC') return { kind: 'audio', contentType: 'audio/flac', ...flac(head) };
    if (ascii(head, 0, 4) === 'OggS') return ogg(head, tail.length > 0 ? tail : head);
    if (ascii(head, 0, 3) === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && mp3Header(head, 0) !== undefined)) {
      return { kind: 'audio', contentType: 'audio/mpeg', ...mp3(head, size) };
    }
    if (ascii(head, 0, 5) === '%PDF-') return { kind: 'document', contentType: 'application/pdf', ...pdf(head, tail) };
  } catch {
    // Bytes that end early or lie about their lengths: what the kind is stays known only if checked above.
  }
  return undefined;
}

// ----------------------------------------------------------------------------- images

function jpeg(b: Buffer): Partial<MediaFacts> {
  let at = 2;
  let size: { width: number; height: number } | undefined;
  let orientation = 1;
  let capturedAt: string | undefined;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) break;
    const marker = b[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { at += marker === 0xff ? 1 : 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = b.readUInt16BE(at + 2);
    if (length < 2) break;
    if (marker === 0xe1 && ascii(b, at + 4, 6) === 'Exif\0\0') ({ orientation, capturedAt } = exif(b.subarray(at + 10, at + 2 + length)));
    // Start of frame: any SOFn but DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && at + 9 <= b.length) {
      size = { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  const turned = orientation >= 5 && orientation <= 8;
  return {
    ...(size === undefined ? {} : turned ? dims(size.height, size.width) : dims(size.width, size.height)),
    ...(capturedAt === undefined ? {} : { capturedAt }),
  };
}

/** EXIF's orientation (IFD0, 0x0112) and DateTimeOriginal (the Exif IFD's 0x9003). */
function exif(t: Buffer): { orientation: number; capturedAt?: string } {
  const little = ascii(t, 0, 2) === 'II';
  if (!little && ascii(t, 0, 2) !== 'MM') return { orientation: 1 };
  const u16 = (at: number) => (little ? t.readUInt16LE(at) : t.readUInt16BE(at));
  const u32 = (at: number) => (little ? t.readUInt32LE(at) : t.readUInt32BE(at));
  const entries = (ifd: number) => {
    const out = new Map<number, number>();
    if (ifd + 2 > t.length) return out;
    const n = Math.min(u16(ifd), 500);
    for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= t.length; i++) out.set(u16(ifd + 2 + i * 12), ifd + 2 + i * 12);
    return out;
  };
  const ifd0 = entries(u32(4));
  const orientationAt = ifd0.get(0x0112);
  const orientation = orientationAt === undefined ? 1 : u16(orientationAt + 8);
  const exifAt = ifd0.get(0x8769);
  const dateAt = exifAt === undefined ? undefined : entries(u32(exifAt + 8)).get(0x9003);
  if (dateAt === undefined || u32(dateAt + 4) < 19) return { orientation };
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(ascii(t, u32(dateAt + 8), 19));
  return m === null || m[1] === '0000' ? { orientation } : { orientation, capturedAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` };
}

function webp(b: Buffer): Partial<MediaFacts> {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) return dims(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return dims((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X' && b.length >= 30) return dims(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  return {};
}

// ----------------------------------------------------------------------------- ISO base media (MP4, MOV, M4A, AVIF)

interface Box { type: string; start: number; body: number; end: number }

/** The boxes inside [from, to) of b; a box running past the bytes held ends there. */
function boxes(b: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = b.readUInt32BE(at);
    let body = at + 8;
    if (size === 1 && at + 16 <= to) { size = Number(b.readBigUInt64BE(at + 8)); body = at + 16; }
    if (size === 0) size = to - at;
    if (size < body - at) break;
    out.push({ type: ascii(b, at + 4, 4), start: at, body, end: Math.min(at + size, to) });
    at += size;
  }
  return out;
}
const child = (b: Buffer, box: Box | undefined, type: string, skip = 0) => (box === undefined ? undefined : boxes(b, box.body + skip, box.end).find((x) => x.type === type));
const children = (b: Buffer, box: Box, type: string) => boxes(b, box.body, box.end).filter((x) => x.type === type);

function isoMedia(head: Buffer, tail: Buffer, size: number): MediaFacts {
  const brand = ascii(head, 8, 4);
  const brands = new Set([brand, ...Array.from({ length: Math.max(0, Math.min(16, (head.readUInt32BE(0) - 16) / 4)) }, (_, i) => ascii(head, 16 + i * 4, 4))]);
  if (brands.has('avif') || brands.has('avis')) return { kind: 'image', contentType: 'image/avif', ...ispe(head) };
  // The index (moov) is at the start of a file made for streaming, else at its end.
  const moov = findMoov(head) ?? findMoov(tail, size - tail.length);
  const audioOnly = brand === 'M4A ' || brand === 'M4B ';
  const quicktime = brand === 'qt  ';
  if (moov === undefined) return audioOnly ? { kind: 'audio', contentType: 'audio/mp4' } : { kind: 'video', contentType: quicktime ? 'video/quicktime' : 'video/mp4' };
  const { b, box } = moov;
  const facts: Partial<MediaFacts> = {};
  const mvhd = child(b, box, 'mvhd');
  if (mvhd !== undefined) {
    const v1 = b[mvhd.body] === 1;
    const timescale = b.readUInt32BE(mvhd.body + (v1 ? 20 : 12));
    const length = v1 ? Number(b.readBigUInt64BE(mvhd.body + 24)) : b.readUInt32BE(mvhd.body + 16);
    if (timescale > 0) Object.assign(facts, duration((length / timescale) * 1000));
  }
  let video = false;
  for (const trak of children(b, box, 'trak')) {
    const hdlr = child(b, child(b, trak, 'mdia'), 'hdlr');
    if (hdlr === undefined || ascii(b, hdlr.body + 8, 4) !== 'vide') continue;
    video = true;
    const tkhd = child(b, trak, 'tkhd');
    if (tkhd !== undefined && facts.width === undefined) Object.assign(facts, dims(b.readUInt32BE(tkhd.end - 8) / 65536, b.readUInt32BE(tkhd.end - 4) / 65536));
  }
  if (!video) return { kind: 'audio', contentType: 'audio/mp4', ...facts };
  return { kind: 'video', contentType: quicktime ? 'video/quicktime' : 'video/mp4', ...facts };
}

/** The moov box, whole, in bytes that start at `offset` of the file (0 for the head). */
function findMoov(b: Buffer, offset = 0): { b: Buffer; box: Box } | undefined {
  if (b.length < 8) return undefined;
  if (offset === 0) {
    const box = boxes(b, 0, b.length).find((x) => x.type === 'moov');
    return box !== undefined && box.end <= b.length ? { b, box } : undefined;
  }
  // In the tail the box boundaries are unknown: find "moov" whose size reaches no further than the end.
  for (let at = b.indexOf('moov', 4, 'latin1'); at >= 4; at = b.indexOf('moov', at + 1, 'latin1')) {
    const size = b.readUInt32BE(at - 4);
    if (size >= 8 && at - 4 + size <= b.length) return { b, box: { type: 'moov', start: at - 4, body: at + 4, end: at - 4 + size } };
  }
  return undefined;
}

/** An AVIF's image size: its ispe property, wherever it sits in meta. */
function ispe(b: Buffer): Partial<MediaFacts> {
  const at = b.indexOf('ispe', 0, 'latin1');
  return at < 4 || at + 16 > b.length ? {} : dims(b.readUInt32BE(at + 8), b.readUInt32BE(at + 12));
}

// ----------------------------------------------------------------------------- Matroska and WebM

/** An EBML variable-length integer at `at`: its value and length. */
function vint(b: Buffer, at: number, keepMarker = false): { value: number; length: number; unknown: boolean } | undefined {
  const first = b[at];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if (length > 8 || at + length > b.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> length);
  let ones = value === (0xff >> length);
  for (let i = 1; i < length; i++) { value = value * 256 + b[at + i]!; ones &&= b[at + i] === 0xff; }
  return { value, length, unknown: !keepMarker && ones };
}

function* elements(b: Buffer, from: number, to: number): Generator<{ id: number; body: number; end: number }> {
  let at = from;
  while (at < to) {
    const id = vint(b, at, true);
    if (id === undefined) return;
    const size = vint(b, at + id.length);
    if (size === undefined) return;
    const body = at + id.length + size.length;
    const end = size.unknown ? to : Math.min(body + size.value, to);
    yield { id: id.value, body, end };
    at = end;
  }
}

const uint = (b: Buffer, from: number, to: number) => { let v = 0; for (let i = from; i < to; i++) v = v * 256 + b[i]!; return v; };
const float = (b: Buffer, from: number, to: number) => (to - from === 4 ? b.readFloatBE(from) : to - from === 8 ? b.readDoubleBE(from) : NaN);

function matroska(b: Buffer): MediaFacts | undefined {
  let docType = '';
  let facts: Partial<MediaFacts> = {};
  let video = false;
  let audio = false;
  for (const top of elements(b, 0, b.length)) {
    if (top.id === 0x1a45dfa3) for (const e of elements(b, top.body, top.end)) if (e.id === 0x4282) docType = ascii(b, e.body, e.end - e.body);
    if (top.id !== 0x18538067) continue;
    for (const section of elements(b, top.body, top.end)) {
      if (section.id === 0x1549a966) {
        let scale = 1_000_000;
        let length = NaN;
        for (const e of elements(b, section.body, section.end)) {
          if (e.id === 0x2ad7b1) scale = uint(b, e.body, e.end);
          if (e.id === 0x4489) length = float(b, e.body, e.end);
        }
        facts = { ...facts, ...duration((length * scale) / 1e6) };
      }
      if (section.id === 0x1654ae6b) {
        for (const entry of elements(b, section.body, section.end)) {
          if (entry.id !== 0xae) continue;
          for (const e of elements(b, entry.body, entry.end)) {
            if (e.id === 0x83) { const t = uint(b, e.body, e.end); video ||= t === 1; audio ||= t === 2; }
            if (e.id === 0xe0 && facts.width === undefined) {
              let w = 0; let h = 0;
              for (const v of elements(b, e.body, e.end)) { if (v.id === 0xb0) w = uint(b, v.body, v.end); if (v.id === 0xba) h = uint(b, v.body, v.end); }
              facts = { ...facts, ...dims(w, h) };
            }
          }
        }
      }
    }
  }
  if (docType !== 'webm' && docType !== 'matroska') return undefined;
  const webm = docType === 'webm';
  if (!video && audio) return { kind: 'audio', contentType: webm ? 'audio/webm' : 'audio/x-matroska', ...facts };
  return { kind: 'video', contentType: webm ? 'video/webm' : 'video/x-matroska', ...facts };
}

// ----------------------------------------------------------------------------- audio

function wav(b: Buffer, size: number): Partial<MediaFacts> {
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= b.length) {
    const id = ascii(b, at, 4);
    const length = b.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 16 <= b.length) byteRate = b.readUInt32LE(at + 16);
    if (id === 'data') return byteRate > 0 ? duration((Math.min(length, size - at - 8) / byteRate) * 1000) : {};
    at += 8 + length + (length % 2);
  }
  return {};
}

function flac(b: Buffer): Partial<MediaFacts> {
  // STREAMINFO is the first metadata block: sample rate in 20 bits, total samples in 36, after the sizes.
  if (b.length < 26 || (b[4]! & 0x7f) !== 0) return {};
  const at = 8 + 10;
  const rate = (b[at]! << 12) | (b[at + 1]! << 4) | (b[at + 2]! >> 4);
  const samples = (b[at + 3]! & 0x0f) * 2 ** 32 + b.readUInt32BE(at + 4);
  return rate > 0 && samples > 0 ? duration((samples / rate) * 1000) : {};
}

function ogg(head: Buffer, tail: Buffer): MediaFacts {
  const segments = head[26] ?? 0;
  const payload = 27 + segments;
  let rate = 0;
  let preSkip = 0;
  let contentType = 'audio/ogg';
  if (ascii(head, payload, 7) === '\x01vorbis') rate = head.readUInt32LE(payload + 12);
  else if (ascii(head, payload, 8) === 'OpusHead') { rate = 48_000; preSkip = head.readUInt16LE(payload + 10); contentType = 'audio/ogg'; }
  else if (ascii(head, payload, 5) === '\x80theo') return { kind: 'video', contentType: 'video/ogg' };
  const last = tail.lastIndexOf('OggS', tail.length - 4, 'latin1');
  if (rate === 0 || last < 0 || last + 14 > tail.length) return { kind: 'audio', contentType };
  const granule = Number(tail.readBigUInt64LE(last + 6));
  return { kind: 'audio', contentType, ...duration(((granule - preSkip) / rate) * 1000) };
}

const MP3_BITRATES: Record<string, number[]> = {
  // MPEG-1 layer III, then MPEG-2/2.5 layer III, kbit/s by index.
  '1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };

function mp3Header(b: Buffer, at: number): { bitrate: number; rate: number; samples: number; mpeg1: boolean; mono: boolean } | undefined {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return undefined;
  const version = (b[at + 1]! >> 3) & 3;
  const layer = (b[at + 1]! >> 1) & 3;
  if (version === 1 || layer !== 1) return undefined;
  const bitrate = MP3_BITRATES[version === 3 ? '1' : '2']![(b[at + 2]! >> 4) & 0x0f];
  const rate = MP3_RATES[version]?.[(b[at + 2]! >> 2) & 3];
  if (!bitrate || !rate) return undefined;
  return { bitrate: bitrate * 1000, rate, samples: version === 3 ? 1152 : 576, mpeg1: version === 3, mono: (b[at + 3]! >> 6) === 3 };
}

function mp3(b: Buffer, size: number): Partial<MediaFacts> {
  let at = 0;
  if (ascii(b, 0, 3) === 'ID3' && b.length >= 10) at = 10 + ((b[6]! & 0x7f) << 21 | (b[7]! & 0x7f) << 14 | (b[8]! & 0x7f) << 7 | (b[9]! & 0x7f)) + ((b[5]! & 0x10) ? 10 : 0);
  while (at + 4 <= b.length && mp3Header(b, at) === undefined) at++;
  const h = mp3Header(b, at);
  if (h === undefined) return {};
  // A Xing or Info header (VBR) counts the frames; otherwise the stream is taken as constant bitrate.
  const side = h.mpeg1 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);
  const tag = ascii(b, at + 4 + side, 4);
  if ((tag === 'Xing' || tag === 'Info') && (b.readUInt32BE(at + 8 + side) & 1)) return duration(((b.readUInt32BE(at + 12 + side) * h.samples) / h.rate) * 1000);
  const vbri = ascii(b, at + 36, 4) === 'VBRI' ? b.readUInt32BE(at + 36 + 14) : 0;
  if (vbri > 0) return duration(((vbri * h.samples) / h.rate) * 1000);
  return duration((((size - at) * 8) / h.bitrate) * 1000);
}

// ----------------------------------------------------------------------------- PDF

/** A PDF's page count: the largest /Count of a /Type /Pages node in the bytes read; none where its page tree is compressed out of reach. */
function pdf(head: Buffer, tail: Buffer): Partial<MediaFacts> {
  let best = 0;
  for (const b of [head, tail]) {
    const text = b.toString('latin1');
    for (const m of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) {
      best = Math.max(best, Number(m[1] ?? m[2]));
    }
  }
  return best > 0 && best < 1_000_000 ? { pages: best } : {};
}
