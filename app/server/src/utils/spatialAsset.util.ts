// Spatial assets for the Clone Canvas (spec 29.4, 29.5; D208), read from their bytes, never
// from what a client says they are:
//
// - A plan's raster size from its PNG IHDR or JPEG start-of-frame. Only PNG and JPEG are
//   served as they are; SVG and PDF are rasterised by the render service first.
// - A glTF 2.0 binary model checked self-contained: the GLB header and chunks, asset version
//   2.0, no buffer or image fetched from a URI (a data: URI is inside the file), extensions
//   outside the supported list stripped and named (refused where the model requires one),
//   its node names kept for anchoring. Geometry is never read beyond the counts.

import { AppError } from './errors.util.ts';

export interface RasterSize { format: 'png' | 'jpeg'; width: number; height: number }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's or JPEG's pixel size from its header; undefined for any other bytes. */
export function rasterSize(bytes: Buffer): RasterSize | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('latin1', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { format: 'png', width, height } : undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) return undefined;
      const marker = bytes[at + 1]!;
      // Fill bytes, and markers with no length.
      if (marker === 0xff) { at += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      const length = bytes.readUInt16BE(at + 2);
      // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (at + 9 > bytes.length) return undefined;
        const height = bytes.readUInt16BE(at + 5);
        const width = bytes.readUInt16BE(at + 7);
        return width > 0 && height > 0 ? { format: 'jpeg', width, height } : undefined;
      }
      if (marker === 0xda || length < 2) return undefined;
      at += 2 + length;
    }
  }
  return undefined;
}

/** Extensions a model may use (spec 29.5: "unlisted extensions stripped and named"). */
export const SUPPORTED_GLTF_EXTENSIONS: ReadonlySet<string> = new Set([
  'KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_texture_basisu', 'EXT_texture_webp',
  'KHR_materials_unlit', 'KHR_materials_emissive_strength', 'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_volume',
  'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_sheen', 'KHR_lights_punctual',
]);

export const MAX_MODEL_BYTES = 200 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export interface CheckedModel {
  /** The model as it will be served: unlisted extensions stripped from its JSON chunk. */
  glb: Buffer;
  nodeNames: string[];
  report: {
    gltfVersion: '2.0'; generator: string | null; nodes: number; meshes: number; materials: number; textures: number;
    extensionsKept: string[]; extensionsStripped: string[];
  };
}

const reject = (reason: string, message: string): AppError =>
  new AppError('validation', message, { code: 'asset_model.rejected', details: { reason } });

/** Removes every `extensions[name]` for the names stripped, anywhere in the document. */
function strip(value: unknown, names: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) strip(v, names);
  } else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const extensions = object['extensions'];
    if (extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions)) {
      for (const name of names) delete (extensions as Record<string, unknown>)[name];
      if (Object.keys(extensions).length === 0) delete object['extensions'];
    }
    for (const [key, v] of Object.entries(object)) if (key !== 'extensions') strip(v, names);
  }
}

/** A glTF 2.0 binary, checked self-contained, its unlisted extensions stripped; refused (asset_model.rejected, with the reason) otherwise. */
export function checkGlb(bytes: Buffer): CheckedModel {
  if (bytes.length > MAX_MODEL_BYTES) throw reject('too_large', 'a model is at most 200 MB');
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== GLB_MAGIC) throw reject('not_glb', 'only glTF 2.0 binary (.glb) is taken');
  if (bytes.readUInt32LE(4) !== 2) throw reject('version', 'only glTF 2.0 is taken');
  if (bytes.readUInt32LE(8) !== bytes.length) throw reject('length', 'the file is not the length its header says');
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== CHUNK_JSON || 20 + jsonLength > bytes.length) throw reject('json_chunk', 'the first chunk is not the model\'s JSON');
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength).trimEnd()) as Record<string, unknown>;
  } catch {
    throw reject('json', 'the model\'s JSON does not parse');
  }
  const rest = bytes.subarray(20 + jsonLength);
  let bin: Buffer | undefined;
  if (rest.length > 0) {
    if (rest.length < 8 || rest.readUInt32LE(4) !== CHUNK_BIN || 8 + rest.readUInt32LE(0) > rest.length) throw reject('bin_chunk', 'the second chunk is not binary data');
    bin = rest.subarray(0, 8 + rest.readUInt32LE(0));
  }
  if ((doc['asset'] as { version?: unknown } | undefined)?.version !== '2.0') throw reject('version', 'only glTF 2.0 is taken');
  // Self-contained: rendering fetches nothing outside the cell.
  for (const kind of ['buffers', 'images'] as const) {
    for (const item of (doc[kind] as { uri?: unknown }[] | undefined) ?? []) {
      if (typeof item.uri === 'string' && !item.uri.startsWith('data:')) throw reject('external_uri', `a model is self-contained: its ${kind} name a URI`);
    }
  }
  const used = ((doc['extensionsUsed'] as unknown[] | undefined) ?? []).filter((e): e is string => typeof e === 'string');
  const required = ((doc['extensionsRequired'] as unknown[] | undefined) ?? []).filter((e): e is string => typeof e === 'string');
  const unsupportedRequired = required.filter((e) => !SUPPORTED_GLTF_EXTENSIONS.has(e));
  if (unsupportedRequired.length > 0) throw reject('extension_required', `the model requires an extension not supported: ${unsupportedRequired.join(', ').slice(0, 200)}`);
  const stripped = used.filter((e) => !SUPPORTED_GLTF_EXTENSIONS.has(e)).sort();
  let glb = bytes;
  if (stripped.length > 0) {
    strip(doc, new Set(stripped));
    doc['extensionsUsed'] = used.filter((e) => SUPPORTED_GLTF_EXTENSIONS.has(e));
    if ((doc['extensionsUsed'] as string[]).length === 0) delete doc['extensionsUsed'];
    let json = Buffer.from(JSON.stringify(doc), 'utf8');
    if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
    const header = Buffer.alloc(20);
    const total = 20 + json.length + (bin?.length ?? 0);
    header.writeUInt32LE(GLB_MAGIC, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
    header.writeUInt32LE(json.length, 12); header.writeUInt32LE(CHUNK_JSON, 16);
    glb = Buffer.concat([header, json, ...(bin === undefined ? [] : [bin])]);
  }
  const count = (key: string) => ((doc[key] as unknown[] | undefined) ?? []).length;
  const nodeNames = [...new Set(((doc['nodes'] as { name?: unknown }[] | undefined) ?? [])
    .map((n) => n.name).filter((n): n is string => typeof n === 'string' && n.trim().length > 0 && n.length <= 200))].slice(0, 10_000);
  const generator = (doc['asset'] as { generator?: unknown }).generator;
  return {
    glb, nodeNames,
    report: {
      gltfVersion: '2.0', generator: typeof generator === 'string' ? generator.slice(0, 200) : null, nodes: count('nodes'), meshes: count('meshes'),
      materials: count('materials'), textures: count('textures'), extensionsKept: used.filter((e) => SUPPORTED_GLTF_EXTENSIONS.has(e)).sort(),
      extensionsStripped: stripped,
    },
  };
}

// ----------------------------------------------------------------------------- positions on a plan

export interface GeoPoint { lon: number; lat: number }

/**
 * A WGS 84 position in the forms sources give it: {lat, lon} (or latitude, longitude, lng), a
 * GeoJSON Point, [lon, lat], or "lat,lon". Undefined for anything else or out of range.
 */
export function readPosition(value: unknown): GeoPoint | undefined {
  let point: GeoPoint | undefined;
  if (typeof value === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/u.exec(value);
    point = m === null ? undefined : { lat: Number(m[1]), lon: Number(m[2]) };
  } else if (Array.isArray(value)) {
    point = value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number' ? { lon: value[0], lat: value[1] } : undefined;
  } else if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (v['type'] === 'Point' && Array.isArray(v['coordinates'])) return readPosition(v['coordinates']);
    const lat = v['lat'] ?? v['latitude'];
    const lon = v['lon'] ?? v['lng'] ?? v['longitude'];
    point = typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : undefined;
  }
  if (point === undefined || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) return undefined;
  return point;
}

/** Plan pixels from a position: the affine fit of a georeferenced plan. */
export type Georeference = (point: GeoPoint) => { x: number; y: number };

/**
 * The least-squares affine fit from longitude and latitude to plan pixels through three or more
 * control points (29.4); undefined when the points do not fix a plane (fewer than three, or
 * all on one line), so nothing is placed from them.
 */
export function fitGeoreference(points: readonly { x: number; y: number; lat: number; lon: number }[]): Georeference | undefined {
  if (points.length < 3) return undefined;
  // Centred on the points' mean, so the normal equations stay well conditioned at building scale.
  const mLon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  const mLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  let suu = 0; let suv = 0; let svv = 0;
  for (const p of points) { const u = p.lon - mLon; const v = p.lat - mLat; suu += u * u; suv += u * v; svv += v * v; }
  const det = suu * svv - suv * suv;
  const scale = Math.max(suu, svv);
  if (scale === 0 || Math.abs(det) <= 1e-12 * scale * scale) return undefined;
  const solve = (target: (p: { x: number; y: number }) => number) => {
    const mean = points.reduce((s, p) => s + target(p), 0) / points.length;
    let su = 0; let sv = 0;
    for (const p of points) { const t = target(p) - mean; su += (p.lon - mLon) * t; sv += (p.lat - mLat) * t; }
    return { a: (su * svv - sv * suv) / det, b: (sv * suu - su * suv) / det, c: mean };
  };
  const fx = solve((p) => p.x);
  const fy = solve((p) => p.y);
  return (point) => {
    const u = point.lon - mLon;
    const v = point.lat - mLat;
    return { x: fx.a * u + fx.b * v + fx.c, y: fy.a * u + fy.b * v + fy.c };
  };
}
