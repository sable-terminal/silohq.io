// Moving about the canvas by keyboard (spec 29.9) and the neighbourhoods focus mode keeps (29.6).
// The arrows move the selection to the nearest clone in that direction, following links in a
// graph or schematic and containment in a hierarchy first; where no linked clone lies that way,
// the nearest of all.

export type Direction = 'up' | 'down' | 'left' | 'right';
const VECTOR: Record<Direction, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/**
 * The nearest candidate in a direction: ahead of the start by more than it is aside (within 60
 * degrees either way), the distance weighted against straying sideways. Undefined when none lies
 * that way.
 */
export function nearest(from: [number, number], direction: Direction, candidates: readonly { id: string; position: [number, number] }[]): string | undefined {
  const [vx, vy] = VECTOR[direction];
  let best: string | undefined;
  let bestCost = Infinity;
  for (const c of candidates) {
    const dx = c.position[0] - from[0];
    const dy = c.position[1] - from[1];
    const ahead = dx * vx + dy * vy;
    const aside = Math.abs(dx * vy - dy * vx);
    if (ahead <= 0 || aside > ahead * Math.tan(Math.PI / 3)) continue;
    const cost = ahead + 2 * aside;
    if (cost < bestCost || (cost === bestCost && best !== undefined && c.id < best)) { best = c.id; bestCost = cost; }
  }
  return best;
}

/** Everything within so many links of the start, either way along them: focus mode's neighbourhood, depth 1 to 3. */
export function within(start: string, edges: readonly (readonly [string, string])[], depth: number): Set<string> {
  const next = new Map<string, string[]>();
  for (const [a, b] of edges) {
    (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    (next.get(b) ?? next.set(b, []).get(b)!).push(a);
  }
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth && frontier.length > 0; d += 1) {
    const reached: string[] = [];
    for (const id of frontier) for (const n of next.get(id) ?? []) if (!seen.has(n)) { seen.add(n); reached.push(n); }
    frontier = reached;
  }
  return seen;
}

/** Which points a box or lasso drawn on the screen encloses, the polygon in screen pixels. */
export function enclosed(polygon: readonly [number, number][], points: readonly { id: string; screen: [number, number] }[]): string[] {
  if (polygon.length < 3) return [];
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return points.filter(({ screen: [x, y] }) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
      const [xi, yi] = polygon[i]!;
      const [xj, yj] = polygon[j]!;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }).map((p) => p.id);
}
