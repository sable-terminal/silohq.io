// The base map under a map layout (spec 29.3, 32.8; D227): the cell's own vector tiles, from the
// Protomaps archive it holds, fetched through the gateway one tile at a time, so no tile provider
// ever sees the viewer, and the same in a sovereign or air-gapped cell. MapLibre draws them under
// the canvas, without labels (no font service is needed, and labels would compete with the
// clones'), in the theme's own quiet colours, so state is still what is seen first (29.7). The
// camera follows the canvas's: layout units are Web Mercator (canvasLayouts WORLD), so a canvas
// zoom is a map zoom shifted by log2(WORLD / 512). When the tiles cannot be read the canvas says
// "base map unavailable" and draws its plain coordinate grid instead (29.12).

import type { Output } from '../api/client.api.ts';
import { WORLD } from './layouts.canvas.ts';

export type BaseMapSource = Output<'mapTilesSource'>;
type Rgb = [number, number, number];
export interface BaseMapColours { surface: Rgb; sunken: Rgb; border: Rgb; strong: Rgb; text: Rgb; info: Rgb; ok: Rgb }

/** MapLibre's world at zoom 0, in pixels: the canvas's zoom plus this is the map's. */
export const ZOOM_SHIFT = Math.log2(WORLD / 512);
/** The deepest zoom MapLibre draws; beyond it the base map is not shown. */
export const MAX_MAP_ZOOM = 24;

/** The map camera for a canvas view: its centre in degrees and its zoom. */
export function cameraOf(view: { target: readonly number[]; zoom: number }): { center: [number, number]; zoom: number } {
  const [x, y] = [view.target[0] ?? 0, view.target[1] ?? 0];
  const lon = Math.max(-180, Math.min(180, (x / WORLD) * 360));
  const lat = (Math.atan(Math.sinh((-y / WORLD) * 2 * Math.PI)) * 180) / Math.PI;
  return { center: [lon, Math.max(-85.05, Math.min(85.05, lat))], zoom: view.zoom + ZOOM_SHIFT };
}

const css = (c: Rgb, alpha = 1) => (alpha === 1 ? `rgb(${c.join(',')})` : `rgba(${c.join(',')},${alpha})`);
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as Rgb;

/**
 * The style: land, water, green space, buildings, roads and boundaries from the Protomaps
 * basemap layers, no labels, no sprites, no glyphs; each colour a step off the canvas's surface.
 */
export function baseMapStyle(source: BaseMapSource, c: BaseMapColours, tiles = 'silo://{z}/{x}/{y}'): Record<string, unknown> {
  const s = 'protomaps';
  const fill = (id: string, layer: string, colour: string, filter?: unknown[], minzoom?: number) =>
    ({ id, type: 'fill', source: s, 'source-layer': layer, paint: { 'fill-color': colour }, ...(filter === undefined ? {} : { filter }), ...(minzoom === undefined ? {} : { minzoom }) });
  const road = (id: string, kinds: string[], colour: string, widths: [number, number, number, number], minzoom: number) => ({
    id, type: 'line', source: s, 'source-layer': 'roads', minzoom, filter: ['in', ['get', 'kind'], ['literal', kinds]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': colour, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], widths[0], widths[1], widths[2], widths[3]] },
  });
  return {
    version: 8,
    sources: {
      [s]: { type: 'vector', tiles: [tiles], minzoom: source.minZoom, maxzoom: source.maxZoom, bounds: source.bounds, attribution: source.attribution },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': css(mix(c.sunken, c.info, 0.12)) } },
      fill('earth', 'earth', css(c.surface)),
      fill('green', 'landuse', css(mix(c.surface, c.ok, 0.1)), ['in', ['get', 'kind'], ['literal', ['park', 'forest', 'wood', 'nature_reserve', 'grass', 'garden', 'golf_course', 'cemetery', 'recreation_ground', 'farmland']]]),
      fill('built', 'landuse', css(mix(c.surface, c.text, 0.04)), ['in', ['get', 'kind'], ['literal', ['industrial', 'commercial', 'residential', 'railway', 'retail', 'military', 'hospital', 'school', 'university', 'aerodrome']]], 10),
      fill('water', 'water', css(mix(c.surface, c.info, 0.22))),
      fill('buildings', 'buildings', css(mix(c.surface, c.text, 0.08)), undefined, 14),
      road('roads-minor', ['minor_road', 'other'], css(mix(c.surface, c.border, 0.8)), [12, 0.5, 18, 8], 12),
      road('roads-medium', ['medium_road'], css(c.border), [10, 0.5, 18, 10], 10),
      road('roads-major', ['major_road'], css(c.border), [7, 0.6, 18, 14], 7),
      road('roads-highway', ['highway'], css(c.strong), [5, 0.6, 18, 16], 5),
      {
        id: 'rail', type: 'line', source: s, 'source-layer': 'roads', minzoom: 11, filter: ['==', ['get', 'kind'], 'rail'],
        paint: { 'line-color': css(c.strong, 0.6), 'line-width': 1, 'line-dasharray': [3, 2] },
      },
      {
        id: 'boundaries', type: 'line', source: s, 'source-layer': 'boundaries',
        paint: { 'line-color': css(c.strong, 0.8), 'line-width': ['match', ['get', 'kind'], 'country', 1.4, 0.8], 'line-dasharray': [4, 2] },
      },
    ],
  };
}

/** A tile through the gateway, as MapLibre's custom protocol hands one over. */
export function tileAddress(url: string): { z: number; x: number; y: number } {
  const m = /^silo:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (m === null) throw new Error(`not a base map tile: ${url}`);
  return { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
}

export function decodeTile(content: string | null): ArrayBuffer {
  if (content === null) return new ArrayBuffer(0);
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
