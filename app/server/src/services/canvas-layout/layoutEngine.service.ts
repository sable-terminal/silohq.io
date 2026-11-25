// Layout algorithms for sets above the client threshold (spec 29.2, 29.8). Pure and
// deterministic: the same graph gives the same positions, so a precomputation can be
// reused and checked. Positions are integer layout units; the client scales them.
//
// - graph_layered and schematic: Sugiyama-style. Cycles are broken by reversing the back
//   edges a depth-first walk finds (drawn distinctly by the client), layers are longest
//   paths from the sources, and order within a layer is improved by barycentre sweeps.
//   Schematic is the same drawing with stages as columns; no stage is invented.
// - hierarchy: one parent per member along the edges (parent to child); roots in order;
//   depth across, depth-first order down.
// - timeline: time across (scaled to the span), lanes down; a member with no time is not
//   placed and counted.
// - graph_force: force-directed on a grid, so repulsion only acts between nearby nodes and
//   the cost grows with nodes and edges, not their square; iterations fall as the graph
//   grows. Settled here, shown when settled.
// Every layout also gives each node the cluster it falls in at the lowest zoom: the layer,
// the root of its tree, its lane, or its connected component.

export type LayoutKind = 'graph_force' | 'graph_layered' | 'hierarchy' | 'schematic' | 'timeline';

export interface LayoutGraph {
  /** Node count; nodes are 0..n-1 in the caller's order. */
  n: number;
  /** Directed edges by index. */
  edges: readonly (readonly [number, number])[];
  time?: readonly (number | undefined)[];
  lane?: readonly (number | undefined)[];
}

export type Position = [number | null, number | null, number];

export interface LaidOut {
  /** [x, y, cluster] per node; null coordinates mark a node not placed. */
  positions: Position[];
  notPlaced: number;
  /** Layered and schematic: indices into the given edges that were reversed to break cycles, drawn distinctly. */
  backEdges?: number[];
  /** Hierarchy: each node's parent along the containment edges, or -1 for a root. */
  parents?: number[];
}

const SPACING = 100;

function adjacency(n: number, edges: LayoutGraph['edges']): { out: number[][]; inc: number[][] } {
  const out: number[][] = Array.from({ length: n }, () => []);
  const inc: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    if (a === b || a >= n || b >= n) continue;
    out[a]!.push(b);
    inc[b]!.push(a);
  }
  return { out, inc };
}

/** Edges with the back edges of a depth-first walk reversed: an acyclic graph, and which given edges were reversed. Iterative, so depth is never a stack risk. */
function acyclic(n: number, edges: LayoutGraph['edges']): { edges: [number, number][]; reversed: number[] } {
  const { out } = adjacency(n, edges);
  const state = new Uint8Array(n); // 0 new, 1 on the path, 2 done
  const back = new Set<string>();
  for (let root = 0; root < n; root++) {
    if (state[root] !== 0) continue;
    const stack: [number, number][] = [[root, 0]];
    state[root] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const [node, next] = top;
      const targets = out[node]!;
      if (next < targets.length) {
        top[1] = next + 1;
        const target = targets[next]!;
        if (state[target] === 1) back.add(`${node}>${target}`);
        else if (state[target] === 0) {
          state[target] = 1;
          stack.push([target, 0]);
        }
      } else {
        state[node] = 2;
        stack.pop();
      }
    }
  }
  const reversed: number[] = [];
  const kept: [number, number][] = [];
  edges.forEach(([a, b], i) => {
    if (a === b || a >= n || b >= n) return;
    if (back.has(`${a}>${b}`)) { reversed.push(i); kept.push([b, a]); } else kept.push([a, b]);
  });
  return { edges: kept, reversed };
}

function layered(graph: LayoutGraph): LaidOut {
  const { n } = graph;
  const { edges, reversed } = acyclic(n, graph.edges);
  const { out, inc } = adjacency(n, edges);
  // Longest path from the sources, in topological order (Kahn).
  const layer = new Int32Array(n);
  const indegree = Int32Array.from(inc.map((i) => i.length));
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indegree[i] === 0) queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    for (const target of out[node]!) {
      layer[target] = Math.max(layer[target]!, layer[node]! + 1);
      indegree[target] = indegree[target]! - 1;
      if (indegree[target] === 0) queue.push(target);
    }
  }
  const layers: number[][] = [];
  for (let i = 0; i < n; i++) (layers[layer[i]!] ??= []).push(i);
  // Barycentre sweeps: down by predecessors, then up by successors.
  const order = new Float64Array(n);
  for (const nodes of layers) nodes.forEach((node, i) => { order[node] = i; });
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const sequence = down ? layers : [...layers].reverse();
    for (const nodes of sequence) {
      const key = (node: number): number => {
        const neighbours = down ? inc[node]! : out[node]!;
        if (neighbours.length === 0) return order[node]!;
        let sum = 0;
        for (const m of neighbours) sum += order[m]!;
        return sum / neighbours.length;
      };
      nodes.sort((a, b) => key(a) - key(b) || a - b);
      nodes.forEach((node, i) => { order[node] = i; });
    }
  }
  const positions: Position[] = new Array(n);
  layers.forEach((nodes, l) => nodes.forEach((node, i) => { positions[node] = [l * SPACING * 2, i * SPACING, l]; }));
  return { positions, notPlaced: 0, backEdges: reversed };
}

function hierarchy(graph: LayoutGraph): LaidOut {
  const { n } = graph;
  const parent = new Int32Array(n).fill(-1);
  const children: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of graph.edges) {
    // One parent per member: the first edge wins, and an edge that would close a loop is ignored.
    if (a === b || a >= n || b >= n || parent[b] !== -1) continue;
    let up = a;
    let loops = false;
    while (up !== -1) {
      if (up === b) { loops = true; break; }
      up = parent[up]!;
    }
    if (loops) continue;
    parent[b] = a;
    children[a]!.push(b);
  }
  const positions: Position[] = new Array(n);
  let row = 0;
  for (let root = 0; root < n; root++) {
    if (parent[root] !== -1) continue;
    const stack: [number, number][] = [[root, 0]];
    while (stack.length > 0) {
      const [node, depth] = stack.pop()!;
      positions[node] = [depth * SPACING * 2, row * SPACING, root];
      row += 1;
      const kids = children[node]!;
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, depth + 1]);
    }
  }
  return { positions, notPlaced: 0, parents: Array.from(parent) };
}

function timeline(graph: LayoutGraph): LaidOut {
  const { n } = graph;
  const times = graph.time ?? [];
  let min = Infinity;
  let max = -Infinity;
  for (const t of times) if (t !== undefined && Number.isFinite(t)) { min = Math.min(min, t); max = Math.max(max, t); }
  const span = max > min ? max - min : 1;
  const width = Math.max(1, n) * SPACING / 4;
  const positions: Position[] = new Array(n);
  let notPlaced = 0;
  for (let i = 0; i < n; i++) {
    const t = times[i];
    const lane = graph.lane?.[i] ?? 0;
    if (t === undefined || !Number.isFinite(t)) {
      positions[i] = [null, null, lane];
      notPlaced += 1;
    } else {
      positions[i] = [Math.round(((t - min) / span) * width), lane * SPACING, lane];
    }
  }
  return { positions, notPlaced };
}

/** Connected components, ignoring direction: the force layout's clusters. */
function components(n: number, edges: LayoutGraph['edges']): Int32Array {
  const root = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (root[x] !== x) {
      root[x] = root[root[x]!]!;
      x = root[x]!;
    }
    return x;
  };
  for (const [a, b] of edges) {
    if (a >= n || b >= n) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) root[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  return Int32Array.from({ length: n }, (_, i) => find(i));
}

function force(graph: LayoutGraph): LaidOut {
  const { n } = graph;
  const edges = graph.edges.filter(([a, b]) => a !== b && a < n && b < n);
  const k = SPACING;
  // Deterministic start: a spiral, so nothing depends on randomness.
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const angle = i * 2.399963229728653; // the golden angle
    const radius = k * Math.sqrt(i + 1);
    x[i] = radius * Math.cos(angle);
    y[i] = radius * Math.sin(angle);
  }
  const iterations = n <= 2_000 ? 120 : n <= 20_000 ? 40 : 15;
  let temperature = k * Math.sqrt(n) / 4;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let iteration = 0; iteration < iterations; iteration++) {
    dx.fill(0);
    dy.fill(0);
    // Repulsion between nodes in the same or a neighbouring grid cell.
    const cell = 2 * k;
    const grid = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(x[i]! / cell)},${Math.floor(y[i]! / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i]! / cell);
      const cy = Math.floor(y[i]! / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const j of grid.get(`${gx},${gy}`) ?? []) {
            if (j === i) continue;
            let ddx = x[i]! - x[j]!;
            let ddy = y[i]! - y[j]!;
            let d2 = ddx * ddx + ddy * ddy;
            if (d2 < 0.01) { ddx = (i - j) * 0.1; ddy = 0.1; d2 = ddx * ddx + ddy * ddy; }
            const f = (k * k) / d2;
            dx[i] = dx[i]! + ddx * f;
            dy[i] = dy[i]! + ddy * f;
          }
        }
      }
    }
    // Attraction along edges.
    for (const [a, b] of edges) {
      const ddx = x[a]! - x[b]!;
      const ddy = y[a]! - y[b]!;
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.1;
      const f = d / k;
      dx[a] = dx[a]! - ddx * f;
      dy[a] = dy[a]! - ddy * f;
      dx[b] = dx[b]! + ddx * f;
      dy[b] = dy[b]! + ddy * f;
    }
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!) || 1;
      const step = Math.min(d, temperature);
      x[i] = x[i]! + (dx[i]! / d) * step;
      y[i] = y[i]! + (dy[i]! / d) * step;
    }
    temperature *= 0.92;
  }
  const cluster = components(n, edges);
  const positions: Position[] = new Array(n);
  for (let i = 0; i < n; i++) positions[i] = [Math.round(x[i]!), Math.round(y[i]!), cluster[i]!];
  return { positions, notPlaced: 0 };
}

export function layout(kind: LayoutKind, graph: LayoutGraph): LaidOut {
  switch (kind) {
    case 'graph_layered':
    case 'schematic':
      return layered(graph);
    case 'hierarchy':
      return hierarchy(graph);
    case 'timeline':
      return timeline(graph);
    case 'graph_force':
      return force(graph);
  }
}
