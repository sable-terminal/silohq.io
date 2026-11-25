// A site plan printed under an exported canvas (spec 29.4, 29.10): PNG and JPEG read into PDF
// images from their own bytes, a PNG's scanline filters undone and its transparency kept as a
// soft mask; what cannot be printed is answered as such, so the export says so.

import assert from 'node:assert/strict';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { pdfImageOf } from '../../src/services/render/pdfImage.service.ts';

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

function png(width: number, height: number, colourType: number, depth: number, scanlines: Buffer, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = colourType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

describe('plans as PDF images (spec 29.4, 29.10)', () => {
  test('an RGBA PNG: its filters undone (none, sub, up, Paeth), colour and transparency apart', () => {
    // Two pixels a row: row 0 unfiltered; row 1 by "up" (the bytes are differences from row 0); row 2 by Paeth.
    const rows = Buffer.from([
      0, 10, 20, 30, 255, 40, 50, 60, 128,
      2, 1, 1, 1, 0, 1, 1, 1, 0,
      4, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const image = pdfImageOf(png(2, 3, 6, 8, rows))!;
    assert.deepEqual([image.width, image.height, image.colourSpace, image.filter], [2, 3, 'DeviceRGB', 'FlateDecode']);
    assert.deepEqual([...inflateSync(image.data)], [10, 20, 30, 40, 50, 60, 11, 21, 31, 41, 51, 61, 11, 21, 31, 41, 51, 61]);
    assert.deepEqual([...inflateSync(image.alpha!)], [255, 128, 255, 128, 255, 128]);
  });

  test('a palette PNG at 4 bits, with transparency from tRNS; an opaque greyscale one has no mask', () => {
    const palette = chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255]));
    const trns = chunk('tRNS', Buffer.from([255, 0]));
    const image = pdfImageOf(png(2, 1, 3, 4, Buffer.from([0, 0x01]), [palette, trns]))!;
    assert.deepEqual([...inflateSync(image.data)], [255, 0, 0, 0, 0, 255]);
    assert.deepEqual([...inflateSync(image.alpha!)], [255, 0]);
    const grey = pdfImageOf(png(3, 1, 0, 8, Buffer.from([1, 5, 5, 5])))!;
    assert.deepEqual([grey.colourSpace, [...inflateSync(grey.data)], grey.alpha], ['DeviceGray', [5, 10, 15], undefined], 'sub: each the sum of those before');
  });

  test('a JPEG goes in as it is, sized from its frame; what cannot be printed is answered as such', () => {
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x04, 0, 0]), sof, Buffer.from([0xff, 0xd9])]);
    const image = pdfImageOf(jpeg)!;
    assert.deepEqual([image.width, image.height, image.colourSpace, image.filter, image.data === jpeg], [64, 32, 'DeviceRGB', 'DCTDecode', true]);
    assert.equal(pdfImageOf(Buffer.from('<svg/>')), undefined);
    const interlaced = png(1, 1, 2, 8, Buffer.from([0, 1, 2, 3]));
    interlaced[8 + 8 + 12] = 1;
    assert.equal(pdfImageOf(interlaced), undefined, 'an interlaced PNG is not printed');
  });
});
