// The base map drawn (D227): MapLibre, loaded only when a map layout is opened, in a layer under
// the canvas that takes no input of its own; the canvas moves it. Its worker is served by the
// gateway from this origin (next.config.ts copies it into the export), and its tiles come by a
// custom protocol that calls the gateway, so the session cookie and the gateway's checks apply to
// every tile. A cell without tiles, or tiles that cannot be read, gives "base map unavailable".

import { ApiError, api } from '../api/client.api.ts';
import { MAX_MAP_ZOOM, baseMapStyle, cameraOf, decodeTile, tileAddress, type BaseMapColours, type BaseMapSource } from './baseMap.canvas.ts';

export type BaseMapAvailability = { source: BaseMapSource } | { unavailable: string };

const UNCONFIGURED = 'this cell holds no map tiles';
const UNREADABLE = 'its tiles could not be read';

let available: Promise<BaseMapAvailability> | undefined;
/** What the cell serves, asked once per page. */
export function baseMapAvailability(): Promise<BaseMapAvailability> {
  available ??= api.call('mapTilesSource', {}).then(
    (source): BaseMapAvailability => ({ source }),
    (e: unknown): BaseMapAvailability => ({ unavailable: e instanceof ApiError && e.code === 'map_tiles.unconfigured' ? UNCONFIGURED : UNREADABLE }),
  );
  return available;
}

// The protocol is MapLibre's, for the page: each mounted map hears when the tiles fail.
const listeners = new Set<(reason: string) => void>();
let failures = 0;
let drawn = false;
let registered = false;

/** Refused, or failing before any tile was read, or three in a row: the base map is unavailable. */
function failed(e: unknown): void {
  const refused = e instanceof ApiError && (e.code === 'map_tiles.unconfigured' || e.status === 401 || e.status === 403);
  failures += 1;
  if (refused || !drawn || failures >= 3) for (const l of listeners) l(refused && e.code === 'map_tiles.unconfigured' ? UNCONFIGURED : UNREADABLE);
}

export interface MountedBaseMap {
  /** Moves the map to the canvas's view; hidden where MapLibre cannot draw that zoom. */
  follow(view: { target: readonly number[]; zoom: number }): void;
  remove(): void;
}

export async function mountBaseMap(el: HTMLElement, source: BaseMapSource, colours: BaseMapColours, view: { target: readonly number[]; zoom: number },
  onUnavailable: (reason: string) => void): Promise<MountedBaseMap> {
  const maplibre = await import('maplibre-gl');
  maplibre.setWorkerUrl(`/maplibre/maplibre-gl-worker.mjs?v=${maplibre.getVersion()}`);
  if (!registered) {
    maplibre.addProtocol('silo', async (params, abort) => {
      try {
        const tile = await api.call('readMapTile', { params: tileAddress(params.url) }, { signal: abort.signal });
        failures = 0;
        drawn = true;
        return { data: decodeTile(tile.content) };
      } catch (e) {
        if (!abort.signal.aborted) failed(e);
        throw e;
      }
    });
    registered = true;
  }
  const start = cameraOf(view);
  const map = new maplibre.Map({
    container: el, style: baseMapStyle(source, colours) as never, interactive: false, attributionControl: false, renderWorldCopies: false,
    fadeDuration: 0, minZoom: 0, maxZoom: MAX_MAP_ZOOM, center: start.center, zoom: Math.max(0, Math.min(MAX_MAP_ZOOM, start.zoom)),
    // The image export reads this canvas with the canvas's own (29.10).
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  const listener = (reason: string) => onUnavailable(reason);
  listeners.add(listener);
  return {
    follow(next) {
      const c = cameraOf(next);
      const drawable = c.zoom >= 0 && c.zoom <= MAX_MAP_ZOOM;
      el.style.visibility = drawable ? 'visible' : 'hidden';
      if (drawable) map.jumpTo(c);
    },
    remove() { listeners.delete(listener); map.remove(); },
  };
}
