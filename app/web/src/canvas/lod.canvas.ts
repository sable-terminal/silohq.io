// Level of detail on the canvas (spec 29.3, 29.8): labels only above a zoom threshold and never
// over one another, points at low zoom, and clusters at the lowest, each showing its count per
// state. On a map or a plan, clusters fall by a grid on the screen; elsewhere by the layout's own
// clusters (the layer, the tree, the lane, the connected component). The selection, the pins and
// anything expanded are never folded into a cluster: they stay on screen (29.6).

import { SPACING, type LayoutKind } from './layouts.canvas.ts';

export type State = 'normal' | 'warning' | 'failed' | 'unknown' | 'stale';
/** Most severe first: what a cluster is coloured by, and whose label wins a collision. */
export const SEVERITY: State[] = ['failed', 'warning', 'unknown', 'stale', 'normal'];

export interface Drawn { id: string; position: [number, number]; state: State; text: string; keep: boolean }
export interface Cluster { key: string; position: [number, number]; count: number; states: Record<State, number>; worst: State; members: string[] }
export interface Detail { points: Drawn[]; clusters: Cluster[]; labels: Drawn[] }

/** The grid a map clusters by, in screen pixels. */
const GRID_PX = 44;
/** Below this many pixels between neighbours, a layout folds into its clusters. */
const FOLD_PX = 4;
/** At or above this many pixels between neighbours, labels are drawn. */
const LABEL_PX = 28;
/** The fine grid labels are checked against, in pixels; a label is about 7 pixels a character at 12 pixels. */
const LABEL_GRID = 8;
const CHAR_PX = 7.2;
const MAX_LABELS = 2_000;

const spatial = (kind: LayoutKind) => kind === 'spatial_map' || kind === 'spatial_plan';

export function levelOfDetail(input: { nodes: Drawn[]; clusterOf: (id: string) => number | null; kind: LayoutKind; zoom: number }): Detail {
  const scale = 2 ** input.zoom;
  const groups = new Map<string, Drawn[]>();
  const points: Drawn[] = [];
  for (const n of input.nodes) {
    let key: string | undefined;
    if (!n.keep) {
      if (spatial(input.kind)) key = `g${Math.floor((n.position[0] * scale) / GRID_PX)},${Math.floor((n.position[1] * scale) / GRID_PX)}`;
      else if (SPACING * scale < FOLD_PX) { const c = input.clusterOf(n.id); key = c === null ? undefined : `c${c}`; }
    }
    if (key === undefined) { points.push(n); continue; }
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [n]); else g.push(n);
  }
  const clusters: Cluster[] = [];
  for (const [key, members] of groups) {
    if (members.length === 1) { points.push(members[0]!); continue; }
    const states = { failed: 0, warning: 0, unknown: 0, stale: 0, normal: 0 } as Record<State, number>;
    let x = 0;
    let y = 0;
    for (const m of members) { states[m.state] += 1; x += m.position[0]; y += m.position[1]; }
    clusters.push({
      key, position: [x / members.length, y / members.length], count: members.length, states,
      worst: SEVERITY.find((s) => states[s] > 0)!, members: members.map((m) => m.id),
    });
  }
  const labelled = spatial(input.kind) || SPACING * scale >= LABEL_PX;
  return { points, clusters, labels: labelled ? labels(points, scale) : points.filter((p) => p.keep) };
}

/** Labels placed greedily, the kept and the most severe first, each only where no label already stands. */
function labels(points: Drawn[], scale: number): Drawn[] {
  const order = [...points].sort((a, b) => Number(b.keep) - Number(a.keep) || SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state));
  const taken = new Set<string>();
  const shown: Drawn[] = [];
  for (const p of order) {
    if (shown.length >= MAX_LABELS) break;
    // The label's box on screen: centred over the clone, above it.
    const half = (p.text.length * CHAR_PX) / 2 + 2;
    const sx = p.position[0] * scale;
    const sy = p.position[1] * scale - 14;
    const cells: string[] = [];
    for (let gx = Math.floor((sx - half) / LABEL_GRID); gx <= Math.floor((sx + half) / LABEL_GRID); gx += 1) {
      for (let gy = Math.floor((sy - 7) / LABEL_GRID); gy <= Math.floor((sy + 6) / LABEL_GRID); gy += 1) cells.push(`${gx},${gy}`);
    }
    if (!p.keep && cells.some((c) => taken.has(c))) continue;
    for (const c of cells) taken.add(c);
    shown.push(p);
  }
  return shown;
}

/** A cluster's count per state, the problems named first: "12 · 2 failed, 1 warning", or "12 · all normal". */
export function clusterText(c: Cluster): string {
  const problems = SEVERITY.filter((s) => s !== 'normal' && c.states[s] > 0).map((s) => `${c.states[s]} ${s}`);
  return `${c.count.toLocaleString('en-GB')} · ${problems.length === 0 ? 'all normal' : problems.join(', ')}`;
}

/** A container's count per state, never one colour (29.2): "1 failed, 199 normal". */
export function countsText(states: Record<State, number>): string {
  return SEVERITY.filter((s) => states[s] > 0).map((s) => `${states[s].toLocaleString('en-GB')} ${s}`).join(', ');
}
