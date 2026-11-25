// The basemap for spatial canvases (spec 29.3, 32.8; decisions 2026-11-14 and 2026-11-23): a
// Protomaps PMTiles archive Silo hosts in its own tiles bucket, read through the gateway one
// vector tile at a time, so no tile provider sees a viewer's address or session and nothing
// is fetched beyond the cell: it works in the sovereign cell and air-gapped as well. Where the
// cell holds no archive, the map draws a plain coordinate grid marked "base map unavailable".

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

/** clone.view: what the basemap is: its tiles' kind, zoom range and bounds, and the attribution its data's licence requires. */
export const mapTilesSource = defineContract({
  service: 'files', name: 'mapTilesSource', method: 'GET', path: '/v1/map-tiles', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    format: z.literal('mvt'),
    minZoom: z.int().min(0).max(30),
    maxZoom: z.int().min(0).max(30),
    bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    /** Shown on the map, as the data's licence requires. */
    attribution: z.string(),
  }),
});

/** clone.view: one vector tile, uncompressed (Mapbox Vector Tile bytes, base64); null where the archive has none there. */
export const readMapTile = defineContract({
  service: 'files', name: 'readMapTile', method: 'GET', path: '/v1/map-tiles/:z/:x/:y', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ z: z.coerce.number().int().min(0).max(24), x: z.coerce.number().int().min(0), y: z.coerce.number().int().min(0) }),
  response: z.object({ content: z.base64().nullable() }),
});
