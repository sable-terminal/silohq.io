import type { Archetype } from '../../models/render.model';

/**
 * Rendering §4 — which archetype a result is drawn as.
 *
 * ── §1: "Selection reads structure, never subject" ─────────────────────────
 *
 * "Is there an ordered dependency between rows. Is there a time dimension. Are
 * there two sources for the same measure. All answerable from the result object
 * alone, WHICH IS WHAT MAKES ONE BUILD SERVE EVERY INDUSTRY."
 *
 * So nothing in this file knows what an invoice is. A chain is the same shape
 * whether it is a supply chain, a case through a court or a deal through
 * stages, and the moment selection consults a concept name the generic claim is
 * gone and the next customer needs their own branch.
 *
 * ── WHY THIS IS IN THE ENGINE AND NOT IN THE CLIENT ───────────────────────
 *
 * It used to be a client concern, argued on the grounds that a fixed precedence
 * makes the same result always draw the same way. That reasoning is about
 * DETERMINISM, which this keeps, and not about location — and three things need
 * the answer server-side. §9 exports rendered output, redacted to the exporter.
 * §8 renders a tile and falls back where the archetype cannot be read small.
 * §11 audits `archetype_selected`.
 *
 * And there are two clients. §3's "the set is closed… adding an archetype per
 * customer converts one product into several" applies just as much to two
 * implementations of the precedence: they would diverge, and the divergence
 * would show up as the same result drawing differently on a phone.
 *
 * ── NOTHING HERE READS A VALUE ────────────────────────────────────────────
 *
 * The input is a shape: counts, flags and edges between row references. No
 * figure, no field contents. §10 — "The render layer stores decisions about
 * presentation and never results" — and the same discipline applies to what it
 * computes over.
 */

/** One measure in the result, and what is known about it structurally. */
export interface Measure {
  fieldPath: string;
  /**
   * §4.1 — "whether one measure appears from two sources".
   *
   * This is `basis === 'disputed'` on the merged field: two systems hold
   * different values and neither was taken. §4.2 makes it the FIRST thing
   * precedence looks for.
   */
  contested: boolean;
  /** A measure that can be summed is a candidate for Composition. */
  numeric: boolean;
}

/** An asserted relationship between two rows, by reference. */
export interface Edge {
  from: string;
  to: string;
}

/**
 * What the render layer is given. Deliberately not a `ConceptAnswer`: that type
 * belongs to the query service, and an engine that imported it would be reading
 * the shape of a query rather than the shape of a result.
 */
export interface ResultShape {
  rowCount: number;
  measures: Measure[];
  /** §4.1 — "presence of a time field, and whether values are ordered by it". */
  timeField: string | null;
  orderedByTime: boolean;
  /**
   * §3's Ranking — "entities ordered by magnitude".
   *
   * §4.1's list does not name this one, and it is the same KIND of signal as
   * the ones it does: an ordering the result carries, read from structure
   * rather than from what the question was about. Without it a ranking is
   * indistinguishable from any other set of rows and §12's fourth step could
   * not be built at all.
   */
  orderedByMeasure: boolean;
  /**
   * WHICH FIELDS, not only whether. The precedence decides from the booleans;
   * the renderer needs the names — a series is drawn against a time AXIS, a
   * ranking by a particular measure, a composition as parts of a particular
   * sum. Leaving the client to work those out would regrow, in the browser, the
   * parallel selection engine this layer replaced.
   */
  orderedField?: string | null;
  summedField?: string | null;
  /** §4.1 — "presence of relationship edges between rows". */
  edges: Edge[];
  /** Whether the edges assert a direction, or merely an association. */
  directedEdges: boolean;
  /** §4.1 — "whether the measures sum to a meaningful whole". */
  summable: boolean;
  /** §4.1 — "whether a deviation was computed against a population". */
  deviationComputed: boolean;
}

/** §4.1's nine signals, derived once so every matcher reads the same answer. */
export interface Signals {
  rowCount: number;
  singleRow: boolean;
  measureCount: number;
  /** Measures held differently by two sources. */
  contested: string[];
  hasTime: boolean;
  orderedByTime: boolean;
  orderedByMeasure: boolean;
  hasEdges: boolean;
  directed: boolean;
  /** §4.1 — "whether they form a cycle". */
  cyclic: boolean;
  /** §4.1 — "whether each row has at most one parent". */
  singleParent: boolean;
  /**
   * The other half of the same question, which §3 needs to tell a Chain from a
   * Hierarchy: "ordered dependency, EACH STEP ON THE LAST" is a line, and
   * "parent to child" is a tree. One parent each makes it a tree; one child
   * each as well makes it a line.
   */
  singleChild: boolean;
  summable: boolean;
  deviationComputed: boolean;
}

/**
 * Does a directed edge set contain a cycle?
 *
 * IT MATTERS BECAUSE A CHAIN CANNOT HAVE ONE. §3 calls a chain "ordered
 * dependency, each step on the last", and drawing a cycle as a chain either
 * loops forever or silently drops the edge that closes it — which is the edge a
 * reader most needs to see. A cyclic directed graph is a Network.
 *
 * Iterative, with an explicit stack: a result is bounded but not small, and a
 * recursive walk over a wide graph is a stack overflow in the render layer.
 */
function hasCycle(edges: readonly Edge[]): boolean {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const at = out.get(edge.from);
    if (at) at.push(edge.to);
    else out.set(edge.from, [edge.to]);
  }

  const state = new Map<string, 'open' | 'done'>();

  for (const start of out.keys()) {
    if (state.get(start) === 'done') continue;

    const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    state.set(start, 'open');

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = out.get(frame.node) ?? [];

      if (frame.next >= children.length) {
        state.set(frame.node, 'done');
        stack.pop();
        continue;
      }

      const child = children[frame.next]!;
      frame.next += 1;

      /* Still on the stack: we have come back to where we started. */
      if (state.get(child) === 'open') return true;
      if (state.get(child) === 'done') continue;

      state.set(child, 'open');
      stack.push({ node: child, next: 0 });
    }
  }

  return false;
}

export function signalsOf(shape: ResultShape): Signals {
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const edge of shape.edges) {
    const up = parents.get(edge.to);
    if (up) up.add(edge.from);
    else parents.set(edge.to, new Set([edge.from]));

    const down = children.get(edge.from);
    if (down) down.add(edge.to);
    else children.set(edge.from, new Set([edge.to]));
  }

  return {
    rowCount: shape.rowCount,
    singleRow: shape.rowCount === 1,
    measureCount: shape.measures.length,
    contested: shape.measures.filter((measure) => measure.contested).map((measure) => measure.fieldPath),
    hasTime: shape.timeField !== null,
    orderedByTime: shape.orderedByTime,
    orderedByMeasure: shape.orderedByMeasure,
    hasEdges: shape.edges.length > 0,
    directed: shape.directedEdges,
    cyclic: shape.directedEdges && hasCycle(shape.edges),
    singleParent: [...parents.values()].every((from) => from.size <= 1),
    singleChild: [...children.values()].every((to) => to.size <= 1),
    summable: shape.summable,
    deviationComputed: shape.deviationComputed,
  };
}

/**
 * §4.2 — "Precedence runs from most specific structure to least."
 *
 * Comparison → Chain → Hierarchy → Network → Series
 * → Distribution → Ranking → Composition → Figure → Table
 *
 * THE ORDER IS THE SPEC'S, VERBATIM, and it is an array rather than a chain of
 * conditionals so that it can be read against §4.2 by somebody holding the
 * document. "Results frequently fit several archetypes: a chain is also a
 * hierarchy, a ranking is also a distribution" — which is why this is an
 * ordered list and not a set of independent tests.
 */
export const PRECEDENCE: readonly Archetype[] = [
  'comparison',
  'chain',
  'hierarchy',
  'network',
  'series',
  'distribution',
  'ranking',
  'composition',
  'figure',
  'table',
];

/**
 * Which archetypes a given shape fits.
 *
 * ── BUILT IN §12'S ORDER, AND THE GAPS ARE VISIBLE ────────────────────────
 *
 * §12 builds Table first — "the floor, and it unblocks the client on its own" —
 * then Comparison, then Figure/Ranking/Series, then Distribution/Composition,
 * then the three that need relationship walking. An archetype not yet built
 * matches nothing, so it is never chosen and never offered.
 *
 * That is honest rather than incomplete: §4.4 says "coverage is achieved by the
 * floor, not by the archetypes", so a result whose best archetype is unbuilt
 * renders as rows today and as its archetype later, and never fails either way.
 */
const MATCHES: Record<Archetype, (signals: Signals) => boolean> = {
  /**
   * §3 — "The same measure from two sources that should agree."
   *
   * ── §4.2 PUTS THIS FIRST, AND SAYS WHY ───────────────────────────────────
   *
   * "Comparison is first because two sources disagreeing about one measure is
   * THE MOST SPECIFIC STRUCTURE IN THE PRODUCT and the one nothing else
   * surfaces. IT MUST NEVER BE RENDERED AS A TABLE WITH TWO COLUMNS."
   *
   * A table with two columns is what a disagreement looks like when nobody
   * decided it was one: the reader sees two numbers beside each other and has
   * to notice. Being first in precedence is what stops that — a result that is
   * also a ranking and also a series is a comparison before it is either,
   * because the disagreement is the thing nothing else would show.
   *
   * THE SIGNAL IS THE MERGE LAYER'S OWN. `basis: 'disputed'` means two systems
   * held different values and it took NEITHER, which is a decision already made
   * about what is true. This reads it; it does not re-derive it.
   */
  comparison: (signals) => signals.contested.length > 0,
  /**
   * §3 — "Ordered dependency, each step on the last."
   *
   * A LINE, WHICH IS A TREE THAT NEVER BRANCHES. One parent each and one child
   * each, directed, and no cycle — §3's "each step on the last" has nowhere to
   * go if a step has two nexts, and a cycle has no last.
   *
   * ABOVE HIERARCHY IN §4.2 BECAUSE EVERY CHAIN IS ALSO ONE. That is the
   * spec's own example of why precedence is an order rather than a set of
   * independent tests.
   */
  chain: (signals) =>
    signals.hasEdges &&
    signals.directed &&
    !signals.cyclic &&
    signals.singleParent &&
    signals.singleChild,
  /**
   * §3 — "Parent to child."
   *
   * DIRECTED, ACYCLIC, AND AT MOST ONE PARENT EACH — §4.1's own signal. A row
   * with two parents is not in a tree, whatever it looks like from the top, and
   * drawing it as one means picking a parent to hang it under and hiding the
   * other edge.
   */
  hierarchy: (signals) =>
    signals.hasEdges && signals.directed && !signals.cyclic && signals.singleParent,
  /**
   * §3 — "Many to many, undirected."
   *
   * THE CATCH-ALL FOR ANYTHING WITH EDGES, and that is what it is for. Below
   * Chain and Hierarchy, so a result that is really a line or a tree is drawn
   * as one; above everything else, so a result with relationships between its
   * rows is never quietly drawn as a series or a ranking that leaves them out.
   *
   * A CYCLE ARRIVES HERE, and it should: §3 calls a chain "each step on the
   * last", which a loop has no answer for. Drawing it as a chain either runs
   * forever or drops the edge that closes it — the edge a reader most needs.
   */
  network: (signals) => signals.hasEdges,
  /**
   * §3 — "A measure over time."
   *
   * BOTH HALVES, because §4.1 asks for both: "presence of a time field, AND
   * whether values are ordered by it". A date column in a result nobody ordered
   * by is a field that happens to be a date — drawing it as a series would put
   * the points in whatever order the rows arrived, which is a line that means
   * nothing and looks like it means something.
   */
  series: (signals) => signals.hasTime && signals.orderedByTime,
  /**
   * §3 — "One measure across a population, outliers marked."
   *
   * THE DEVIATION IS THE SIGNAL, NOT THE SPREAD. §4.1 asks "whether a deviation
   * was computed AGAINST A POPULATION", which is a different question from
   * whether the numbers happen to vary. Any column of numbers has a spread;
   * what makes it a distribution worth drawing is that something worked out
   * what normal was and which of them are not.
   *
   * ABOVE RANKING IN PRECEDENCE, and §4.2 gives the reason directly — "a
   * ranking is also a distribution". Ordering by magnitude puts the outlier at
   * the top and says nothing about how far from the others it is; the
   * distribution is the more specific structure, so it wins.
   */
  distribution: (signals) => signals.deviationComputed && signals.rowCount > 1,
  /**
   * §3 — "Entities ordered by magnitude."
   *
   * ORDERED, AND BY SOMETHING WITH A MAGNITUDE. Sorting by name is an ordering
   * and not a ranking: a ranking says the top one is the most, and the reader
   * of a bar chart will believe that whether or not it is true.
   */
  ranking: (signals) => signals.orderedByMeasure && signals.rowCount > 1,
  /**
   * §3 — "Parts of a whole."
   *
   * A TOTAL IS NOT ENOUGH ON ITS OWN. What makes rows parts of a whole is that
   * adding them up means something — a sum over a measure they all carry. A
   * count, an average or a maximum has no parts: the rows behind an average are
   * not slices of it, and drawing them as a pie would be a picture asserting
   * arithmetic nobody did.
   *
   * AND MORE THAN ONE PART, because one part of a whole is the whole, which is
   * a Figure.
   */
  composition: (signals) => signals.summable && signals.rowCount > 1,
  /**
   * §3 — "A single number with its lineage."
   *
   * ONE ROW AND ONE MEASURE. Anything else has something to compare against and
   * is a table at worst. Near the end of the precedence because almost nothing
   * is only this — and when a result IS only this, a table of one row and one
   * column is a worse way to show it than the number itself.
   */
  figure: (signals) => signals.singleRow && signals.measureCount === 1,

  /**
   * §4.4 — "Table renders any result. An unmatched result renders as rows
   * rather than failing."
   *
   * IT TAKES NO ARGUMENT AND RETURNS TRUE, which is the whole guarantee. A
   * predicate here — even `rowCount >= 0` — would be a condition somebody could
   * later make stricter, and the floor stops being a floor the first time it
   * does not match.
   */
  table: () => true,
};

/**
 * The fields an archetype is drawn over.
 *
 * NAMES, NOT VALUES. The same discipline as the rest of this file — the render
 * layer carries field paths and never what is in them. A renderer given
 * `invoice.issued_at` as the axis reads the values itself, from the answer it
 * already holds.
 */
export interface DrawnOver {
  /** A series' axis. */
  time: string | null;
  /** The measure a ranking is ordered by. */
  ordered: string | null;
  /** The measure a composition is parts of. */
  summed: string | null;
}

export interface Selection {
  chosen: Archetype;
  /** §4.3 — "Every archetype that also fits is offered, not only the one chosen." */
  alternatives: Archetype[];
  signals: Signals;
  fields: DrawnOver;
}

/**
 * §4 — the archetype, the alternatives, and the structure both were read from.
 *
 * DETERMINISTIC: the same shape always returns the same answer, with no
 * reference to who is asking or what has been chosen before. §4.3's override
 * rate is only meaningful against a selection that does not move.
 */
export function select(shape: ResultShape): Selection {
  const signals = signalsOf(shape);
  const fits = PRECEDENCE.filter((archetype) => MATCHES[archetype](signals));

  /*
   * `table` always matches, so `fits` is never empty and `chosen` is never
   * undefined. Asserted rather than assumed: if somebody makes the floor
   * conditional, this is where it should stop rather than three layers up.
   */
  const [chosen, ...alternatives] = fits;
  if (!chosen) throw new Error('No archetype matched, which means the table floor is broken.');

  return {
    chosen,
    alternatives,
    signals,
    fields: {
      time: shape.timeField,
      ordered: shape.orderedField ?? null,
      summed: shape.summedField ?? null,
    },
  };
}

/**
 * §8 — what a view is drawn as on a dashboard tile.
 *
 * "Each tile is the view's chosen archetype, rendered smaller. A TILE THAT
 * CANNOT RENDER MEANINGFULLY AT TILE SIZE FALLS BACK TO FIGURE OR TABLE rather
 * than rendering an illegible version of its archetype."
 *
 * ── WHICH ONES CANNOT, AND WHY IT IS ABOUT LABELS ─────────────────────────
 *
 * The three that came from relationship walking. A chain, a hierarchy and a
 * network are legible because their nodes are NAMED — the whole point is
 * seeing which thing depends on which — and at tile size the names go first.
 * What is left is a shape: some dots and some lines, which reads as
 * information and carries none. §7 is explicit that "a dashboard that impresses
 * and takes ten seconds to read loses to a plain one that takes two", and an
 * unreadable graph is the ten-second kind.
 *
 * The other six survive shrinking. A series is a line, a ranking is a few bars,
 * a distribution is a shape with its outliers marked, a comparison is two
 * numbers that differ, a composition is parts of a whole, a figure is a number.
 * None of them needs to be read word by word.
 *
 * ── AND THE FALLBACK IS NOT ALWAYS TABLE ──────────────────────────────────
 *
 * §8 offers both, and a table at tile size is barely better than a graph: four
 * rows of a hundred, with no way to see there are ninety-six more. Where the
 * result is one number, the number is the honest small version of it.
 */
const ILLEGIBLE_SMALL: ReadonlySet<Archetype> = new Set(['chain', 'hierarchy', 'network']);

export function tileArchetype(chosen: Archetype, signals: Signals): Archetype {
  if (!ILLEGIBLE_SMALL.has(chosen)) return chosen;
  return MATCHES.figure(signals) ? 'figure' : 'table';
}
