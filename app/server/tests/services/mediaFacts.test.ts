// Media facts (D237): the kind and type a file's bytes say, and what they give without decoding:
// an image's size (turned by a JPEG's orientation) and when it was taken, video's length and frame,
// audio's length, a PDF's pages. Anything else is not media; bytes cut short give no facts.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mediaFacts } from '../../src/services/siloes-import/mediaFacts.service.ts';
import { flac, jpeg, mp3, mp4, oggOpus, oggVorbis, pdf, png, wav, webm } from './media.helper.ts';

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

describe('media facts (D237)', () => {
  test('images: size from the header; a JPEG turned by its orientation, and when it was taken', () => {
    assert.deepEqual(mediaFacts(png(640, 480)), { kind: 'image', contentType: 'image/png', width: 640, height: 480 });
    assert.deepEqual(mediaFacts(jpeg({ width: 4000, height: 3000, orientation: 6, taken: '2026:03:01 09:30:00' })),
      { kind: 'image', contentType: 'image/jpeg', width: 3000, height: 4000, capturedAt: '2026-03-01T09:30:00' });
    assert.deepEqual(mediaFacts(jpeg({ width: 800, height: 600 })), { kind: 'image', contentType: 'image/jpeg', width: 800, height: 600, capturedAt: '2026-03-01T09:30:00' });
    const gif = Buffer.concat([Buffer.from('GIF89a'), u16le(32), u16le(16), Buffer.alloc(8)]);
    assert.deepEqual(mediaFacts(gif), { kind: 'image', contentType: 'image/gif', width: 32, height: 16 });
    const vp8x = Buffer.concat([Buffer.from('RIFF'), u32le(30), Buffer.from('WEBPVP8X'), u32le(10), Buffer.alloc(4), Buffer.from([0x3f, 0x01, 0x00, 0xef, 0x00, 0x00])]);
    assert.deepEqual(mediaFacts(vp8x), { kind: 'image', contentType: 'image/webp', width: 320, height: 240 });
    const vp8l = Buffer.concat([Buffer.from('RIFF'), u32le(30), Buffer.from('WEBPVP8L'), u32le(10), Buffer.from([0x2f]), u32le((99) | (49 << 14)), Buffer.alloc(4)]);
    assert.deepEqual(mediaFacts(vp8l), { kind: 'image', contentType: 'image/webp', width: 100, height: 50 });
  });

  test('video: duration and frame size from the index, at the start or (read from the tail) at the end; an audio-only MP4 is audio', () => {
    const start = mp4({ seconds: 95, tracks: [{ handler: 'vide', width: 1920, height: 1080 }, { handler: 'soun' }] });
    assert.deepEqual(mediaFacts(start), { kind: 'video', contentType: 'video/mp4', durationMs: 95_000, width: 1920, height: 1080 });
    const end = mp4({ seconds: 12, tracks: [{ handler: 'vide', width: 1280, height: 720 }], moovAtEnd: true, mdat: 4096 });
    assert.deepEqual(mediaFacts(end.subarray(0, 64), end.subarray(end.length - 600), end.length), { kind: 'video', contentType: 'video/mp4', durationMs: 12_000, width: 1280, height: 720 });
    assert.deepEqual(mediaFacts(end.subarray(0, 64), Buffer.alloc(0), end.length), { kind: 'video', contentType: 'video/mp4' }, 'no index held: no facts, still video');
    assert.deepEqual(mediaFacts(mp4({ brand: 'qt  ', seconds: 3, tracks: [{ handler: 'vide', width: 640, height: 360 }] })),
      { kind: 'video', contentType: 'video/quicktime', durationMs: 3000, width: 640, height: 360 });
    assert.deepEqual(mediaFacts(mp4({ brand: 'M4A ', seconds: 200, tracks: [{ handler: 'soun' }] })), { kind: 'audio', contentType: 'audio/mp4', durationMs: 200_000 });
    assert.deepEqual(mediaFacts(webm({ seconds: 7.5, width: 640, height: 480 })), { kind: 'video', contentType: 'video/webm', durationMs: 7500, width: 640, height: 480 });
    assert.deepEqual(mediaFacts(webm({ seconds: 60, audioOnly: true })), { kind: 'audio', contentType: 'audio/webm', durationMs: 60_000 });
  });

  test('audio: WAV, FLAC, Ogg (Vorbis, Opus) and MP3 (constant bitrate, and Xing)', () => {
    assert.deepEqual(mediaFacts(wav(3)), { kind: 'audio', contentType: 'audio/wav', durationMs: 3000 });
    assert.deepEqual(mediaFacts(flac(90)), { kind: 'audio', contentType: 'audio/flac', durationMs: 90_000 });
    const vorbis = oggVorbis(42);
    assert.deepEqual(mediaFacts(vorbis, vorbis), { kind: 'audio', contentType: 'audio/ogg', durationMs: 42_000 });
    const opus = oggOpus(10);
    assert.deepEqual(mediaFacts(opus, opus), { kind: 'audio', contentType: 'audio/ogg', durationMs: 10_000 });
    const cbr = mp3(4);
    const out = mediaFacts(cbr)!;
    assert.equal(out.contentType, 'audio/mpeg');
    assert.ok(Math.abs(out.durationMs! - 4000) < 20, String(out.durationMs));
    const vbr = mediaFacts(mp3(30, true))!;
    assert.ok(Math.abs(vbr.durationMs! - 30_000) < 50, String(vbr.durationMs));
  });

  test('a PDF\'s pages; anything else is not media', () => {
    assert.deepEqual(mediaFacts(pdf(12)), { kind: 'document', contentType: 'application/pdf', pages: 12 });
    assert.deepEqual(mediaFacts(Buffer.from('%PDF-1.7\n%compressed page tree\n')), { kind: 'document', contentType: 'application/pdf' });
    assert.equal(mediaFacts(Buffer.from('id,name\n1,a\n')), undefined);
    assert.equal(mediaFacts(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined, 'SVG can carry script: not media');
    assert.equal(mediaFacts(Buffer.alloc(0)), undefined);
    assert.deepEqual(mediaFacts(png(1, 1).subarray(0, 20)), undefined, 'cut short');
  });
});
