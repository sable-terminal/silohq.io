// The basemap (spec 29.3; D87, D227): the Protomaps PMTiles archive in the tiles bucket, read
// here by byte ranges (every store adapter reads a range; none needs to sign a URL) and served
// one vector tile at a time through the gateway, for a member who may view canvases. The
// archive's header and directories are cached in the process; a tile is decompressed here, so
// the browser takes plain vector tile bytes. Refused, saying so, where the cell has no archive.

import { PMTiles, TileType, type RangeResponse, type Source } from 'pmtiles';
import { objectKey, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import { demand, type Context, type FilesDeps } from './deps.service.ts';

const unconfigured = () => new AppError('unavailable', 'this cell serves no basemap', { code: 'map_tiles.unconfigured' });

/** The archive in the tiles bucket as PMTiles reads it: ranges, under a key naming the archive. */
function storeSource(store: ObjectStore, key: string): Source {
  const object = objectKey.basemap(key);
  return {
    getKey: () => `tiles/${key}`,
    async getBytes(offset: number, length: number): Promise<RangeResponse> {
      const bytes = await store.getRange('tiles', object, offset, offset + length - 1);
      return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    },
  };
}

const archives = new WeakMap<ObjectStore, Map<string, PMTiles>>();
function archiveOf(deps: FilesDeps): PMTiles {
  if (deps.tilesConfigured === false) throw unconfigured();
  const byKey = archives.get(deps.store) ?? new Map<string, PMTiles>();
  archives.set(deps.store, byKey);
  let archive = byKey.get(deps.config.mapTilesKey);
  if (archive === undefined) {
    archive = new PMTiles(storeSource(deps.store, deps.config.mapTilesKey));
    byKey.set(deps.config.mapTilesKey, archive);
  }
  return archive;
}

async function header(deps: FilesDeps) {
  try {
    const h = await archiveOf(deps).getHeader();
    if (h.tileType !== TileType.Mvt) throw new AppError('unavailable', 'the basemap archive holds no vector tiles', { code: 'map_tiles.not_vector' });
    return h;
  } catch (error) {
    if (error instanceof AppError) throw error;
    // No archive at the key, or not one: the map draws its plain grid instead (32.8).
    throw unconfigured();
  }
}

export async function mapTilesSource(deps: FilesDeps, ctx: Context) {
  await demand(deps, ctx, 'clone.view');
  const h = await header(deps);
  return {
    format: 'mvt' as const, minZoom: h.minZoom, maxZoom: h.maxZoom, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat] as [number, number, number, number],
    attribution: deps.config.mapTilesAttribution,
  };
}

export async function readMapTile(deps: FilesDeps, ctx: Context, at: { z: number; x: number; y: number }) {
  await demand(deps, ctx, 'clone.view');
  const h = await header(deps);
  if (at.x >= 2 ** at.z || at.y >= 2 ** at.z) throw new AppError('validation', 'no such tile at that zoom', { code: 'map_tiles.out_of_range' });
  if (at.z < h.minZoom || at.z > h.maxZoom) return { content: null };
  const tile = await archiveOf(deps).getZxy(at.z, at.x, at.y);
  return { content: tile === undefined ? null : Buffer.from(tile.data).toString('base64') };
}
