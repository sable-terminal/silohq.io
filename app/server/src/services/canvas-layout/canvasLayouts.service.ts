// The canvas layouts (spec 29.2, 29.3, 29.4), as pure functions of the members' structure:
// positions only, never a value kept. Each places what it can and names what it cannot, with the
// reason, so no member is silently omitted (the "not placed" tray). The list is the floor and
// places nothing.
//
// One module for every drawing of a canvas: the web client lays out with it in a Web Worker
// (app/web/src/clones/layouts.ts re-exports it) and an export draws with it here, so a canvas
// exported is the canvas seen. The graph layouts, the hierarchy and the timeline are the layout
// engine's (layoutEngine.service.ts, which also precomputes sets above the client threshold,
// 29.8): layered graphs Sugiyama-style with the edges closing a cycle named and drawn
// distinctly, the hierarchy with each member's container, and every node's cluster for the
// lowest zoom. Added here: stages as columns, nested regions to three levels, the present on a
// timeline, positions on a map (WGS 84 or British National Grid) and on a plan.

import { layout as engine } from './layoutEngine.service.ts';

export type LayoutKind = 'schematic' | 'graph_force' | 'graph_layered' | 'spatial_map' | 'spatial_plan' | 'spatial_3d' | 'hierarchy' | 'timeline' | 'list';

export interface LayoutNode {
  id: string;
  /** schematic: the stage, as text. */
  stage?: string | null | undefined;
  /** timeline: epoch milliseconds. lane: the lane's label. */
  time?: number | null | undefined;
  lane?: string | null | undefined;
  /** spatial_map: the Located value as the source gave it, read in the layout's CRS. */
  position?: unknown;
  /** spatial_plan: plan pixels, from the server's placement, or the reason none was found. */
  plan?: { x: number; y: number } | { reason: string } | undefined;
}

export interface LayoutInput {
  kind: LayoutKind;
  nodes: LayoutNode[];
  /** Index pairs, directed: from, to. For a hierarchy, container to contained. */
  edges: [number, number][];
  /** schematic: the stages in chain order, where the property declares them. */
  stageOrder?: string[] | undefined;
  /** timeline: the present, epoch milliseconds. */
  now?: number | undefined;
  /** spatial_map: the Located property's coordinate system (EPSG code). */
  crs?: string | undefined;
}

export interface Region { x0: number; y0: number; x1: number; y1: number; depth: number; index: number }

export interface LayoutOutput {
  /** Per node in input order: x, y, or null when not placed. */
  positions: ([number, number] | null)[];
  /** Per node: the cluster it joins at the lowest zoom (layer, tree, lane or component); null on a map or plan, which cluster by grid. */
  clusters: (number | null)[];
  notPlaced: { index: number; reason: string }[];
  /** Labels for axes or columns: schematic stages, timeline lanes. */
  guides: { x: number; y: number; text: string }[];
  /** Indices into the input edges reversed to break a cycle: drawn distinctly. */
  backEdges: number[];
  /** Hierarchy: each node's container, or -1. */
  parents: number[];
  /** Hierarchy: containers to three levels deep, as regions around what they contain. */
  regions: Region[];
  /** Timeline: the present, as a line. */
  marks: { x0: number; y0: number; x1: number; y1: number; text: string }[];
  /** Timeline: members whose time is still to come, labelled expected. */
  expected: number[];
}

/** The engine's spacing between neighbours, in layout units; the canvas's level of detail is judged by it. */
export const SPACING = 100;
/** The size of the world on a map, in layout units (Web Mercator). */
export const WORLD = 1_000_000;

const empty = (n: number): LayoutOutput => ({
  positions: new Array(n).fill(null), clusters: new Array(n).fill(null), notPlaced: [], guides: [], backEdges: [], parents: [], regions: [], marks: [], expected: [],
});

export function layout(input: LayoutInput): LayoutOutput {
  switch (input.kind) {
    case 'schematic': return schematic(input);
    case 'timeline': return timeline(input);
    case 'spatial_map': return spatial(input);
    case 'spatial_plan': return plan(input);
    case 'hierarchy': return hierarchy(input);
    case 'graph_force':
    case 'graph_layered': return graph(input);
    default: return empty(input.nodes.length);
  }
}

const cluster = (p: readonly [number | null, number | null, number]) => p[2];
const point = (p: readonly [number | null, number | null, number]): [number, number] | null => (p[0] === null || p[1] === null ? null : [p[0], p[1]]);

function graph({ kind, nodes, edges }: LayoutInput): LayoutOutput {
  const laid = engine(kind === 'graph_layered' ? 'graph_layered' : 'graph_force', { n: nodes.length, edges });
  return { ...empty(nodes.length), positions: laid.positions.map(point), clusters: laid.positions.map(cluster), backEdges: laid.backEdges ?? [] };
}

/**
 * Stages as columns in chain order, members stacked within; no stage is invented, so a member
 * without one is not placed. Without a stage property, the chain itself sets the columns: the
 * layered drawing, branches and merges included.
 */
function schematic(input: LayoutInput): LayoutOutput {
  const { nodes, stageOrder, edges } = input;
  if (!nodes.some((n) => n.stage !== undefined)) {
    const laid = engine('schematic', { n: nodes.length, edges });
    return { ...empty(nodes.length), positions: laid.positions.map(point), clusters: laid.positions.map(cluster), backEdges: laid.backEdges ?? [] };
  }
  const seen = [...new Set(nodes.map((n) => n.stage).filter((s): s is string => s !== null && s !== undefined && s !== ''))];
  const order = stageOrder !== undefined && stageOrder.length > 0 ? [...stageOrder, ...seen.filter((s) => !stageOrder.includes(s)).sort()] : seen.sort();
  const rows = new Map<string, number>();
  const out = empty(nodes.length);
  nodes.forEach((n, i) => {
    if (n.stage === null || n.stage === undefined || n.stage === '') { out.notPlaced.push({ index: i, reason: 'it has no stage' }); return; }
    const column = order.indexOf(n.stage);
    const row = rows.get(n.stage) ?? 0;
    rows.set(n.stage, row + 1);
    out.positions[i] = [column * SPACING * 3, row * SPACING];
    out.clusters[i] = column;
  });
  out.guides = order.map((s, i) => ({ x: i * SPACING * 3, y: -SPACING, text: s }));
  return out;
}

/** Time across, lanes down; the present marked, and what is still to come labelled expected. A member without a time is not placed. */
function timeline({ nodes, now }: LayoutInput): LayoutOutput {
  const lanes = [...new Set(nodes.map((n) => n.lane ?? ''))].sort();
  const time = nodes.map((n) => (typeof n.time === 'number' && Number.isFinite(n.time) ? n.time : undefined));
  const lane = nodes.map((n) => lanes.indexOf(n.lane ?? ''));
  // The present rides along as one more point, so the engine's scale places it with the rest.
  const at = now ?? Date.now();
  const laid = engine('timeline', { n: nodes.length + 1, edges: [], time: [...time, at], lane: [...lane, 0] });
  const out = { ...empty(nodes.length), positions: laid.positions.slice(0, nodes.length).map(point), clusters: laid.positions.slice(0, nodes.length).map(cluster) };
  nodes.forEach((_n, i) => {
    if (time[i] === undefined) out.notPlaced.push({ index: i, reason: 'it has no time' });
    else if (time[i]! > at) out.expected.push(i);
  });
  const x = laid.positions[nodes.length]![0]!;
  out.marks = [{ x0: x, y0: -SPACING / 2, x1: x, y1: Math.max(lanes.length - 1, 0) * SPACING + SPACING / 2, text: 'Now' }];
  out.guides = lanes.map((l, i) => ({ x: -SPACING * 1.5, y: i * SPACING, text: l === '' ? 'No lane' : l }));
  return out;
}

/** Web Mercator, in layout units. WGS 84 and British National Grid are read; another coordinate system is named, not guessed. */
function spatial({ nodes, crs }: LayoutInput): LayoutOutput {
  const out = empty(nodes.length);
  const crsCode = crs ?? 'EPSG:4326';
  nodes.forEach((n, i) => {
    if (crsCode !== 'EPSG:4326' && crsCode !== 'EPSG:27700') { out.notPlaced.push({ index: i, reason: `its coordinates are in ${crsCode}, which the canvas does not convert` }); return; }
    const p = crsCode === 'EPSG:27700' ? readGridReference(n.position) : readPoint(n.position);
    if (p === undefined || Math.abs(p.lat) > 85) { out.notPlaced.push({ index: i, reason: 'it has no position Silo can read' }); return; }
    out.positions[i] = mercator(p);
  });
  return out;
}

/** Web Mercator in layout units: x east, y south (the canvas's y runs down). */
export function mercator(p: { lon: number; lat: number }): [number, number] {
  return [(p.lon / 360) * WORLD, -(Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360)) / (2 * Math.PI)) * WORLD];
}

/** Plan pixels, as the server placed them (by anchor, predicate or georeference); the reason where it found none. */
function plan({ nodes }: LayoutInput): LayoutOutput {
  const out = empty(nodes.length);
  nodes.forEach((n, i) => {
    if (n.plan === undefined) out.notPlaced.push({ index: i, reason: 'the plan has not placed it yet' });
    else if ('reason' in n.plan) out.notPlaced.push({ index: i, reason: n.plan.reason });
    else out.positions[i] = [n.plan.x, n.plan.y];
  });
  return out;
}

/**
 * The engine's tree along the containment link (a member whose container is outside the set
 * starts a tree of its own; a loop is ignored), drawn as nested regions to three levels and an
 * indented tree beyond.
 */
function hierarchy({ nodes, edges }: LayoutInput): LayoutOutput {
  const laid = engine('hierarchy', { n: nodes.length, edges });
  const parents = laid.parents ?? new Array(nodes.length).fill(-1);
  const positions = laid.positions.map(point);
  const depth = parents.map((_p, i) => {
    let d = 0;
    for (let up = parents[i]!; up !== -1 && d < 64; up = parents[up]!) d += 1;
    return d;
  });
  const boxes = new Map<number, Region>();
  positions.forEach((p, i) => {
    if (p === null) return;
    for (let up = parents[i]!, hops = 0; up !== -1 && hops < 64; up = parents[up]!, hops += 1) {
      if (depth[up]! >= 3) continue;
      const own = positions[up]!;
      const box = boxes.get(up) ?? { x0: own[0], y0: own[1], x1: own[0], y1: own[1], depth: depth[up]!, index: up };
      box.x1 = Math.max(box.x1, p[0]);
      box.y1 = Math.max(box.y1, p[1]);
      boxes.set(up, box);
    }
  });
  const pad = SPACING * 0.4;
  const regions = [...boxes.values()].map((b) => ({ ...b, x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + SPACING * 1.6, y1: b.y1 + pad })).sort((a, b) => a.depth - b.depth);
  return { ...empty(nodes.length), positions, clusters: laid.positions.map(cluster), parents, regions };
}

/** A WGS 84 value in the forms sources give it: {lat, lon}, {latitude, longitude}, GeoJSON Point, [lon, lat], or "lat,lon". */
export function readPoint(value: unknown): { lon: number; lat: number } | undefined {
  let p: { lon: number; lat: number } | undefined;
  if (typeof value === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
    p = m === null ? undefined : { lat: Number(m[1]), lon: Number(m[2]) };
  } else if (Array.isArray(value)) {
    p = value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number' ? { lon: value[0], lat: value[1] } : undefined;
  } else if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (v['type'] === 'Point' && Array.isArray(v['coordinates'])) return readPoint(v['coordinates']);
    const lat = v['lat'] ?? v['latitude'];
    const lon = v['lon'] ?? v['lng'] ?? v['longitude'];
    p = typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : undefined;
  }
  return p === undefined || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 ? undefined : p;
}

/**
 * A British National Grid value (EPSG:27700) as WGS 84: {easting, northing}, {x, y}, a GeoJSON
 * Point, [easting, northing], or "easting,northing", in metres. Read through OSGB36 and the
 * national Helmert transformation, which holds to about five metres across Great Britain
 * (OSTN15 would hold to centimetres, from a grid file the client does not carry).
 */
export function readGridReference(value: unknown): { lon: number; lat: number } | undefined {
  let e: number | undefined;
  let n: number | undefined;
  if (typeof value === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
    if (m !== null) { e = Number(m[1]); n = Number(m[2]); }
  } else if (Array.isArray(value)) {
    if (typeof value[0] === 'number' && typeof value[1] === 'number') { e = value[0]; n = value[1]; }
  } else if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (v['type'] === 'Point' && Array.isArray(v['coordinates'])) return readGridReference(v['coordinates']);
    const ev = v['easting'] ?? v['x'];
    const nv = v['northing'] ?? v['y'];
    if (typeof ev === 'number' && typeof nv === 'number') { e = ev; n = nv; }
  }
  // The grid's extent: Great Britain and its waters.
  if (e === undefined || n === undefined || !(e >= 0 && e <= 700_000 && n >= 0 && n <= 1_300_000)) return undefined;
  return osgb36ToWgs84(gridToOsgb36(e, n));
}

const RAD = Math.PI / 180;

/** Inverse transverse Mercator on the Airy 1830 ellipsoid (the Ordnance Survey's own formulae). */
function gridToOsgb36(E: number, N: number): { lat: number; lon: number } {
  const a = 6377563.396; const b = 6356256.909; const F0 = 0.9996012717;
  const lat0 = 49 * RAD; const lon0 = -2 * RAD; const N0 = -100_000; const E0 = 400_000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b); const n2 = n * n; const n3 = n2 * n;
  let lat = lat0;
  let M = 0;
  for (let i = 0; i < 20; i += 1) {
    lat = (N - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + (5 / 4) * n2 + (5 / 4) * n3) * (lat - lat0);
    const Mb = (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
    if (Math.abs(N - N0 - M) < 0.00001) break;
  }
  const sin = Math.sin(lat); const cos = Math.cos(lat); const tan = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;
  const t2 = tan * tan; const t4 = t2 * t2; const t6 = t4 * t2;
  const VII = tan / (2 * rho * nu);
  const VIII = (tan / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (tan / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4);
  const sec = 1 / cos;
  const X = sec / nu;
  const XI = (sec / (6 * nu ** 3)) * (nu / rho + 2 * t2);
  const XII = (sec / (120 * nu ** 5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (sec / (5040 * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);
  const dE = E - E0;
  return {
    lat: lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6,
    lon: lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7,
  };
}

/** OSGB36 (radians, on Airy 1830) to WGS 84 (degrees): through Earth-centred coordinates and the Helmert transformation. */
function osgb36ToWgs84({ lat, lon }: { lat: number; lon: number }): { lat: number; lon: number } {
  const a1 = 6377563.396; const b1 = 6356256.909;
  const e21 = 1 - (b1 * b1) / (a1 * a1);
  const nu = a1 / Math.sqrt(1 - e21 * Math.sin(lat) ** 2);
  const x1 = nu * Math.cos(lat) * Math.cos(lon);
  const y1 = nu * Math.cos(lat) * Math.sin(lon);
  const z1 = nu * (1 - e21) * Math.sin(lat);
  // OSGB36 to WGS 84: the inverse of the Ordnance Survey's published WGS 84 to OSGB36 parameters.
  const tx = 446.448; const ty = -125.157; const tz = 542.060;
  const s = 1 + -20.4894e-6;
  const rx = (0.1502 / 3600) * RAD; const ry = (0.2470 / 3600) * RAD; const rz = (0.8421 / 3600) * RAD;
  const x2 = tx + x1 * s - y1 * rz + z1 * ry;
  const y2 = ty + x1 * rz + y1 * s - z1 * rx;
  const z2 = tz - x1 * ry + y1 * rx + z1 * s;
  const a = 6378137; const b = 6356752.314245;
  const f = (a - b) / a;
  const e2 = 2 * f - f * f;
  const eps2 = e2 / (1 - e2);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  const R = Math.sqrt(p * p + z2 * z2);
  const tanB = ((b * z2) / (a * p)) * (1 + (eps2 * b) / R);
  const sinB = tanB / Math.sqrt(1 + tanB * tanB);
  const cosB = sinB / tanB;
  const phi = Math.atan2(z2 + eps2 * b * sinB ** 3, p - e2 * a * cosB ** 3);
  return { lat: phi / RAD, lon: Math.atan2(y2, x2) / RAD };
}
