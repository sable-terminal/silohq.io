// What a result's structure says (spec 31.4): the signals read from the result object alone (row
// count, measure count, one measure from two sources, a time field and whether rows follow it,
// edges between rows, directed or not, a cycle, a single parent, parts of a whole, a deviation
// against a population), the ten archetypes that fit in their deterministic precedence, and each
// archetype's minimum legible size at tile size (37.6). Selection reads structure, never subject.
//
// A picture is drawn only from the whole result: when the answer runs to more than its first page,
// only Table fits (a series or a ranking of a part would mislead), and Data pages through it.

import type { Output } from '../api/client.api.ts';

export type Result = Output<'readResult'>;
export type Column = Result['columns'][number];
export type Measure = Result['measures'][number];

export const ARCHETYPES = ['comparison', 'chain', 'hierarchy', 'network', 'series', 'distribution', 'ranking', 'composition', 'figure', 'table'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** The signals as canvas-layout records them (31.4, 31.9): counts and booleans, never a value. */
export interface Structure {
  rowCount: number;
  measureCount: number;
  measureFromTwoSources: boolean;
  hasTimeField: boolean;
  orderedByTime: boolean;
  hasEdges: boolean;
  edgesDirected: boolean;
  hasCycle: boolean;
  singleParent: boolean;
  sumsToWhole: boolean;
  deviationComputed: boolean;
  located: boolean;
  hasPlan: boolean;
  hasModel: boolean;
  notPlaced: number;
}

/** What the renderers need besides the signals: the columns the picture is drawn from. */
export interface Shape {
  structure: Structure;
  /** The first page is the whole result. */
  whole: boolean;
  /** The time column: a group key, or a selected property of the objects. */
  time: Column | undefined;
  /** For objects: the first number column that is not the time. */
  number: Column | undefined;
  /** The column the systems disagree on, for Comparison. */
  disputed: Column | undefined;
  /** Edges between rows, by object id: from, to. */
  edges: readonly (readonly [string, string])[];
  /** The archetypes that fit, in precedence order; Table is always last. */
  fits: readonly Archetype[];
}

const TIME = new Set(['date', 'timestamp']);
const NUMBER = new Set(['integer', 'decimal', 'money', 'duration']);
const sortable = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
};

/** The connections a column was read from (its lineage), counted once each. */
function sourcesOf(result: Result, node: number, property: string): number {
  const entry = result.lineage.find((l) => l.node === node && l.propertyIdentityId === property);
  return new Set(entry?.sources.map((s) => s.connectionId) ?? []).size;
}

export function shapeOf(result: Result): Shape {
  const whole = result.page.count <= 1;
  const groups = result.kind === 'groups';
  const rows = groups ? result.page.groups.length : result.page.objects.length;
  const rowCount = result.total;
  const keyColumns = groups ? result.columns.filter((c) => result.page.groups[0] === undefined || c.apiName in result.page.groups[0].key) : [];
  const time = (groups ? keyColumns : result.columns).find((c) => TIME.has(c.dataType) && c.effect === 'allow');
  const number = groups ? undefined : result.columns.find((c) => NUMBER.has(c.dataType) && c.effect === 'allow');

  // Time order: the rows' time values never go back.
  const timeValues = time === undefined ? [] : (groups ? result.page.groups.map((g) => g.key[time.apiName]) : result.page.objects.map((o) => o.values[time.apiName])).map(sortable);
  const orderedByTime = timeValues.length > 1 && timeValues.every((v, i) => v !== undefined && (i === 0 || v >= timeValues[i - 1]!));

  // Edges between rows: a linked object that is itself a row (a part and its parent part).
  const ids = new Set(result.page.objects.map((o) => o.id));
  const edges: [string, string][] = [];
  if (!groups) {
    for (const o of result.page.objects) {
      for (const linked of Object.values(o.links ?? {})) for (const l of linked) if (ids.has(l.id) && l.id !== o.id) edges.push([o.id, l.id]);
    }
  }
  const pairs = new Set(edges.map(([a, b]) => `${a}>${b}`));
  const edgesDirected = edges.length > 0 && edges.some(([a, b]) => !pairs.has(`${b}>${a}`));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const [a, b] of edges) {
    incoming.set(b, (incoming.get(b) ?? 0) + 1);
    outgoing.set(a, [...(outgoing.get(a) ?? []), b]);
  }
  const singleParent = [...incoming.values()].every((n) => n <= 1);
  const hasCycle = (() => {
    const state = new Map<string, 1 | 2>();
    const visit = (n: string): boolean => {
      if (state.get(n) === 1) return true;
      if (state.get(n) === 2) return false;
      state.set(n, 1);
      if ((outgoing.get(n) ?? []).some(visit)) return true;
      state.set(n, 2);
      return false;
    };
    return [...outgoing.keys()].some(visit);
  })();
  const nodes = new Set(edges.flat());
  const pathLike = edges.length > 0 && edges.length === nodes.size - 1 && [...outgoing.values()].every((t) => t.length <= 1) && singleParent;

  // One measure from two sources: a number column read from two systems that disagree here.
  const disputed = groups ? undefined : result.columns.find((c) => NUMBER.has(c.dataType) && sourcesOf(result, c.node, c.property) >= 2 && (result.coverage.disputed[c.apiName] ?? 0) > 0);

  // Parts of a whole: one count or sum over one key, every part non-negative, all of them here.
  const measure = result.measures[0];
  const parts = groups ? result.page.groups.map((g) => (measure === undefined ? null : g.measures[measure.as] ?? null)) : [];
  const sumsToWhole = groups && whole && result.measures.length === 1 && (measure!.fn === 'count' || measure!.fn === 'sum') && keyColumns.length === 1
    && parts.length >= 2 && parts.length <= 12 && parts.every((v) => v !== null && v >= 0) && parts.some((v) => v! > 0);

  const structure: Structure = {
    rowCount, measureCount: result.measures.length, measureFromTwoSources: disputed !== undefined,
    hasTimeField: time !== undefined, orderedByTime, hasEdges: edges.length > 0, edgesDirected, hasCycle, singleParent,
    sumsToWhole, deviationComputed: false, located: false, hasPlan: false, hasModel: false, notPlaced: 0,
  };
  const s = structure;
  const fit: Record<Archetype, boolean> = {
    comparison: whole && s.measureFromTwoSources,
    chain: whole && s.hasEdges && s.edgesDirected && !s.hasCycle && pathLike,
    hierarchy: whole && s.hasEdges && s.edgesDirected && !s.hasCycle && s.singleParent,
    network: whole && s.hasEdges,
    series: whole && rows >= 2 && s.hasTimeField && (groups ? s.measureCount >= 1 && keyColumns.length === 1 : number !== undefined),
    distribution: whole && (s.deviationComputed || (!groups && number !== undefined && rows >= 20)),
    ranking: whole && rows >= 2 && (groups ? s.measureCount >= 1 && !(s.hasTimeField && keyColumns.length === 1) : number !== undefined),
    composition: s.sumsToWhole,
    figure: groups && rows === 1 && s.measureCount === 1 && keyColumns.length === 0,
    table: true,
  };
  return { structure, whole, time, number, disputed, edges, fits: ARCHETYPES.filter((a) => fit[a]) };
}

/** The archetype precedence chooses (31.4): the most specific structure that fits. */
export const chosenOf = (shape: Shape): Archetype => shape.fits[0] ?? 'table';

/** Each archetype's minimum legible size at tile size, in dashboard grid cells (columns of twelve, rows of 48px). */
export const MINIMUM: Readonly<Record<Archetype, { w: number; h: number }>> = {
  figure: { w: 2, h: 2 }, table: { w: 3, h: 3 }, ranking: { w: 3, h: 3 }, composition: { w: 3, h: 2 }, series: { w: 4, h: 4 },
  distribution: { w: 4, h: 4 }, comparison: { w: 4, h: 3 }, chain: { w: 6, h: 3 }, hierarchy: { w: 6, h: 5 }, network: { w: 6, h: 6 },
};

/** Beyond this many elements a graph archetype is not legible at tile size, whatever the tile's size. */
const GRAPH_AT_TILE = 40;

/**
 * What a tile draws (37.6): its archetype when the tile is at least that archetype's minimum legible
 * size and the drawing would be meaningful there; otherwise a one-row, one-measure result as Figure and
 * every other as Table, saying which and why.
 */
export function tileArchetype(shape: Shape, chosen: Archetype, tile: { w: number; h: number }):
  { archetype: Archetype; fallback?: { from: Archetype; to: 'figure' | 'table'; reason: 'below_minimum_size' | 'not_meaningful' } } {
  if (chosen === 'figure' || chosen === 'table') return { archetype: chosen };
  const to = shape.structure.rowCount === 1 && shape.structure.measureCount === 1 ? 'figure' : 'table';
  const min = MINIMUM[chosen];
  if (tile.w < min.w || tile.h < min.h) return { archetype: to, fallback: { from: chosen, to, reason: 'below_minimum_size' } };
  if ((chosen === 'chain' || chosen === 'hierarchy' || chosen === 'network') && new Set(shape.edges.flat()).size > GRAPH_AT_TILE) {
    return { archetype: to, fallback: { from: chosen, to, reason: 'not_meaningful' } };
  }
  return { archetype: chosen };
}

/** The default representation (31.2): View for relational, ranked or temporal results; Prose otherwise. */
export const defaultRepresentation = (chosen: Archetype): 'prose' | 'view' => (chosen === 'figure' || chosen === 'table' ? 'prose' : 'view');

export const ARCHETYPE_LABEL: Readonly<Record<Archetype, string>> = {
  comparison: 'Comparison', chain: 'Chain', hierarchy: 'Hierarchy', network: 'Network', series: 'Series', distribution: 'Distribution',
  ranking: 'Ranking', composition: 'Composition', figure: 'Figure', table: 'Table',
};
