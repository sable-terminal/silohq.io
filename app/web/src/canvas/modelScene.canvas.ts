// The 3D asset view's pure parts (spec 29.5; D228): which clones stand on which named node of the
// model, what each node shows (one clone's glyph, or the worst state with the count per state
// where several share a node), how far the camera stands to frame what is chosen, and which
// labels fit on screen without colliding (the selection and pins first, then the most severe).

import { SEVERITY, type State } from './lod.canvas.ts';

export interface NodeGroup { node: string; ids: string[]; states: Record<State, number>; worst: State }

/** Clones by the node they are anchored to, in the model's node order where it is known. */
export function nodeGroups(members: readonly { id: string; state: State }[], placements: ReadonlyMap<string, string>): NodeGroup[] {
  const groups = new Map<string, NodeGroup>();
  for (const m of members) {
    const node = placements.get(m.id);
    if (node === undefined) continue;
    let g = groups.get(node);
    if (g === undefined) {
      g = { node, ids: [], states: { normal: 0, warning: 0, failed: 0, unknown: 0, stale: 0 }, worst: 'normal' };
      groups.set(node, g);
    }
    g.ids.push(m.id);
    g.states[m.state] += 1;
  }
  for (const g of groups.values()) g.worst = SEVERITY.find((s) => g.states[s] > 0) ?? 'normal';
  return [...groups.values()];
}

/** The distance at which a sphere of this radius fills the view, with a margin, for a vertical field of view in degrees. */
export function frameDistance(radius: number, fovDegrees: number, aspect: number): number {
  const vertical = (fovDegrees * Math.PI) / 360;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(aspect, 0.1));
  return (Math.max(radius, 1e-6) / Math.sin(Math.min(vertical, horizontal))) * 1.15;
}

export interface LabelBox { id: string; x: number; y: number; width: number; height: number; keep: boolean; rank: number }

/** Labels that fit: those kept first, then by rank (lower first), each placed only where it overlaps none already placed. */
export function fittingLabels(boxes: readonly LabelBox[]): Set<string> {
  const placed: LabelBox[] = [];
  const shown = new Set<string>();
  const ordered = [...boxes].sort((a, b) => Number(b.keep) - Number(a.keep) || a.rank - b.rank);
  for (const b of ordered) {
    const clear = placed.every((p) => b.x + b.width <= p.x || p.x + p.width <= b.x || b.y + b.height <= p.y || p.y + p.height <= b.y);
    if (clear || b.keep) { placed.push(b); shown.add(b.id); }
  }
  return shown;
}
