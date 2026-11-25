// The basemap (spec 29.3; D87, D227): the Protomaps PMTiles archive in the cell's tiles bucket,
// read by byte ranges and served one vector tile at a time through the gateway, uncompressed,
// for a member who may view canvases; what it is (zoom range, bounds, attribution); and, where
// the cell holds no archive, a statement that it serves no basemap. The archive here is a real
// one, written byte by byte: one gzipped tile at zoom 0.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mapTilesSource, readMapTile } from '../../src/contracts/files/mapTiles.contract.ts';
import { objectKey } from '../../src/infra/objectStorage.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createFilesService } from '../../src/routes/files/index.route.ts';
import { createConnectCell, type ConnectCell, type Signed } from './connect.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';
import { pmtilesArchive } from './pmtiles.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
const store = createMemoryStore();
const TILE = Buffer.from('a vector tile, as Protomaps writes one');

before(async () => {
  await store.put('tiles', objectKey.basemap('basemaps/uk.pmtiles'), pmtilesArchive(TILE), 'application/octet-stream');
  cell = await createConnectCell();
  await cell.start(createFilesService({ store }), 'files', 'test_app', {
    OBJECT_STORE: 'gcs', OBJECT_BUCKET_FILES: 'silo-files-test', OBJECT_BUCKET_TILES: 'silo-tiles-test', MAP_TILES_KEY: 'basemaps/uk.pmtiles',
  });
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
});

describe('the basemap through the gateway (spec 29.3; D227)', () => {
  test('what it is: vector tiles, their zoom range and bounds, with the attribution its data needs', async () => {
    const source = await gateway.call(mapTilesSource, {}, cell.as(root));
    assert.deepEqual([source.format, source.minZoom, source.maxZoom, source.bounds], ['mvt', 0, 0, [-8, 49.5, 2, 61]]);
    assert.match(source.attribution, /OpenStreetMap/);
  });

  test('a tile, uncompressed, read from the archive by ranges; none beyond its zooms; a tile off the grid refused', async () => {
    const tile = await gateway.call(readMapTile, { params: { z: 0, x: 0, y: 0 } }, cell.as(root));
    assert.equal(Buffer.from(tile.content!, 'base64').toString(), TILE.toString());
    assert.equal((await gateway.call(readMapTile, { params: { z: 1, x: 0, y: 0 } }, cell.as(root))).content, null);
    await assert.rejects(gateway.call(readMapTile, { params: { z: 0, x: 1, y: 0 } }, cell.as(root)), { code: 'map_tiles.out_of_range' });
  });

  test('without an archive, the cell says it serves no basemap', async () => {
    store.objects.clear();
    const other = await createConnectCell();
    try {
      await other.start(createFilesService({ store: createMemoryStore() }), 'files', 'test_app', {
        OBJECT_STORE: 'gcs', OBJECT_BUCKET_FILES: 'silo-files-test', OBJECT_BUCKET_TILES: 'silo-tiles-test', MAP_TILES_KEY: 'basemaps/none.pmtiles',
      });
      const someone = await other.signIn('root@acme.example');
      await assert.rejects(other.client('gateway').call(mapTilesSource, {}, other.as(someone)), { code: 'map_tiles.unconfigured' });
    } finally {
      await other.close();
    }
  });
});
