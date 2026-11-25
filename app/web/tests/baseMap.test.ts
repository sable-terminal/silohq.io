// The base map's pure parts (D227): the map camera for a canvas view (layout units are Web
// Mercator, so a canvas zoom is a map zoom less log2(WORLD / 512)); the style, which MapLibre's
// own validator accepts, with no labels, sprites or glyphs to fetch; and a tile's address and bytes.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { ZOOM_SHIFT, baseMapStyle, cameraOf, decodeTile, tileAddress } from '../src/canvas/baseMap.canvas.ts';
import { WORLD, mercator } from '../src/canvas/layouts.canvas.ts';

const SOURCE = { format: 'mvt' as const, minZoom: 0, maxZoom: 15, bounds: [-8, 49.5, 2, 61] as [number, number, number, number], attribution: '© OpenStreetMap contributors' };
const GREY: [number, number, number] = [128, 128, 128];
const COLOURS = { surface: GREY, sunken: GREY, border: GREY, strong: GREY, text: GREY, info: GREY, ok: GREY };

describe('the base map (29.3; D227)', () => {
  test('the camera: a canvas view of a place is the map centred on it, the zoom shifted to MapLibre\'s 512-pixel world', () => {
    const london = mercator({ lon: -0.1276, lat: 51.5072 });
    const c = cameraOf({ target: london, zoom: -4 });
    assert.ok(Math.abs(c.center[0] + 0.1276) < 1e-9 && Math.abs(c.center[1] - 51.5072) < 1e-9, String(c.center));
    assert.equal(c.zoom, -4 + Math.log2(WORLD / 512));
    // A whole world on screen is 512 pixels wide at map zoom 0: the canvas scale times WORLD.
    assert.ok(Math.abs(512 * 2 ** c.zoom - WORLD * 2 ** -4) < 1e-6);
    assert.ok(ZOOM_SHIFT > 10.9 && ZOOM_SHIFT < 11);
    assert.deepEqual(cameraOf({ target: [0, -WORLD], zoom: 0 }).center, [0, 85.05], 'clamped to Web Mercator');
  });

  test('the style is one MapLibre accepts, from the archive\'s own zooms and bounds, with nothing to fetch but tiles', () => {
    const style = baseMapStyle(SOURCE, COLOURS);
    assert.deepEqual(validateStyleMin(style as never), []);
    assert.equal(style['glyphs'], undefined);
    assert.equal(style['sprite'], undefined);
    const layers = style['layers'] as { type: string }[];
    assert.ok(layers.every((l) => l.type !== 'symbol'), 'no labels');
    assert.deepEqual((style['sources'] as Record<string, unknown>)['protomaps'], { type: 'vector', tiles: ['silo://{z}/{x}/{y}'], minzoom: 0, maxzoom: 15, bounds: SOURCE.bounds, attribution: SOURCE.attribution });
  });

  test('a tile by its address; its bytes from base64; none for an empty tile', () => {
    assert.deepEqual(tileAddress('silo://12/2046/1362'), { z: 12, x: 2046, y: 1362 });
    assert.throws(() => tileAddress('https://tiles.example.com/1/2/3'));
    assert.deepEqual(new Uint8Array(decodeTile(Buffer.from([1, 2, 250]).toString('base64'))), new Uint8Array([1, 2, 250]));
    assert.equal(decodeTile(null).byteLength, 0);
  });
});
