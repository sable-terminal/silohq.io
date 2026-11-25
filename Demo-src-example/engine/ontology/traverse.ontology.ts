import { DEFAULT_LIMITS, checkFrontier, checkHops, type BoundsExceeded, type Limits } from '../../utils/bounds.util';
import type { Query } from '../execution/query.execution';
import type { Route, RouteStep } from './relate.ontology';

/**
 * §4.1 — walking a route over actual instances.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * `ontology/relate` answers "can an invoice reach a supplier, and how" from the
 * SCHEMAS. That is a statement about types and it is true of every invoice
 * there has ever been. This answers the instance question: invoice INV-1088
 * names order ORD-77, which names supplier ACME. The two are different kinds of
 * fact and conflating them is how a system ends up asserting that a particular
 * invoice reaches a particular supplier because some invoice could.
 *
 * ── It resolves nothing, and that is the point ─────────────────────────────
 *
 * Values are carried EXACTLY AS THE SOURCE STATED THEM, hop to hop, untrimmed
 * and unfolded. The matching happens at the source, inside the `in` filter,
 * because that is where the customer's own collation lives: if their database
 * treats `ACME` and `acme ` as one supplier, the join it performs is their
 * answer and not our guess at it.
 *
 * Turning a reached key into a concept ENTITY is `resolve`'s act and happens
 * above this, at read time, for the reason §4 gives everywhere else: a
 * resolution corrected in September has to be able to repair a walk recorded in
 * March, which it cannot if the walk stored the answer instead of the value.
 *
 * ── It reaches nothing either ──────────────────────────────────────────────
 *
 * Like the rest of the engine, this is arithmetic over what it is handed. It
 * emits the query for the next hop and consumes the rows that come back; the
 * fetching is the service's, through the connector layer, with its bounds and
 * its permissions. That is what makes a walk reproducible from a transcript.
 */

/** Where a walk is standing: values of one field, on one object, raw. */
export type Frontier = {
  object: string;
  field: string;
  /** Exactly as stated. Order is the source's; duplicates are collapsed. */
  values: string[];
};

/**
 * One instance-level edge, actually crossed.
 *
 * BOTH ENDS RAW. This is the evidence a reader is shown when they ask why a
 * finding on one concept was put beside a finding on another.
 */
export type Crossing = {
  relationshipId: string;
  connectionId: string;
  direction: 'along' | 'against';
  keyObject: string;
  keyField: string;
  fromValue: string;
  toValue: string;
};

export type Walk = {
  route: Route;
  /** Which step runs next. Equal to `route.steps.length` once finished. */
  at: number;
  frontier: Frontier;
  crossed: Crossing[];
  /** Nothing was reached at some hop. A real answer, and not a failure. */
  exhausted: boolean;
  /**
   * What each object along the route calls itself by, keyed `connection object`.
   *
   * WALKING BACK UP A KEY NEEDS THIS AND WALKING ALONG ONE DOES NOT, which is
   * the asymmetry that made the first version of this file wrong. Going from an
   * invoice to its order, the order's identifier is written ON the invoice —
   * it is the foreign key. Going from an order to the invoices that name it,
   * the thing reached is an INVOICE, and nothing in a relationship says what an
   * invoice calls itself. The caller knows, from the manifest; this carries it.
   */
  identifiers: ReadonlyMap<string, string>;
};

export type Refusal = {
  reason: string;
  /** Present when a ceiling in `bounds.util` is what refused it. */
  bound?: BoundsExceeded;
};

export type Outcome<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = (reason: string, bound?: BoundsExceeded): Outcome<never> => ({
  ok: false,
  refusal: bound ? { reason, bound } : { reason },
});

/**
 * Start a walk from instances of the route's first concept.
 *
 * THE HOP CEILING IS CHECKED BEFORE ANY SOURCE IS TOUCHED, because a route is
 * known in full in advance — it came from the concept graph. An over-long walk
 * costs nothing to refuse and refusing it early means the customer's systems
 * never see the first query of a walk that was always going to be stopped.
 */
export function beginWalk(input: {
  route: Route;
  /** The identifiers a walk starts from, as the source states them. */
  from: { object: string; field: string; values: readonly string[] };
  /**
   * What each object calls itself by, keyed `connectionId object`. Required for
   * every object a route walks BACK into; see `Walk.identifiers`.
   */
  identifiers?: ReadonlyMap<string, string>;
  limits?: Limits;
}): Outcome<Walk> {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const identifiers = input.identifiers ?? new Map<string, string>();

  const hops = checkHops(input.route.steps.length, limits);
  if (hops) return no('That walk crosses more relationships than a path can be read at.', hops);

  if (input.route.steps.length === 0) {
    return no('There is no route between those two concepts.');
  }

  /*
   * REFUSED BEFORE THE FIRST QUERY, NOT DISCOVERED AT THE HOP THAT NEEDS IT. A
   * walk that runs three hops and then cannot name the fourth object has
   * already made three requests to somebody's production system for an answer
   * it was never going to be able to give.
   */
  for (const step of input.route.steps) {
    if (step.direction !== 'against') continue;
    if (identifiers.has(objectKey(step.connectionId, step.keyObject))) continue;
    return no(
      `Nothing says what ${step.keyObject} calls itself by, so a walk cannot come back through it.`,
    );
  }

  const values = distinct(input.from.values);

  const width = checkFrontier(values.length, limits);
  if (width) return no('That walk starts from more instances than one path can carry.', width);

  return ok({
    route: input.route,
    at: 0,
    frontier: { object: input.from.object, field: input.from.field, values },
    crossed: [],
    exhausted: values.length === 0,
    identifiers,
  });
}

/** How `Walk.identifiers` is keyed. Exported so a caller builds it correctly. */
export const objectKey = (connectionId: string, object: string) => `${connectionId} ${object}`;

/**
 * Which object a hop stands ON, and which field it reads off it.
 *
 * ── The asymmetry, in one place ────────────────────────────────────────────
 *
 * ALONG a key: standing on the key object, holding whatever the last hop
 * produced, reading the foreign key. `invoices.supplier_code` gives the
 * supplier's own identifier, because that is what a foreign key IS.
 *
 * AGAINST a key: standing on the TARGET object holding its identifier, and the
 * rows to fetch are the key object's — filtered on the FOREIGN KEY, not on the
 * frontier's field name, which belongs to a different object entirely. What is
 * reached is the key object, so what identifies it has to come from the
 * manifest.
 *
 * The first version of this filtered on the frontier's field either way, which
 * emitted `SELECT id FROM invoices WHERE id IN ('ORD-77')` — an order's
 * identifier matched against invoice identifiers. It reached nothing, and
 * "nothing" is a legitimate answer, so it looked like data rather than a bug.
 */
function hopShape(
  walk: Walk,
  step: RouteStep,
): {
  standingOn: string;
  filterField: string;
  /** The column ON `standingOn` the value is read out of. */
  readField: string;
  reachedObject: string;
  /**
   * What that same value is called on the object it names.
   *
   * NOT THE SAME AS `readField`, AND CONFLATING THEM IS A BUG THE TESTS CAUGHT.
   * `invoices.order_id` holds an order's identifier: the column is called
   * `order_id` on the invoice and `id` on the order. The next hop stands on the
   * order and must filter on the order's name for it.
   */
  reachedField: string;
} | null {
  if (step.direction === 'along') {
    return {
      standingOn: step.keyObject,
      filterField: walk.frontier.field,
      readField: step.keyField,
      reachedObject: step.targetObject,
      reachedField: step.targetField,
    };
  }

  const identifier = walk.identifiers.get(objectKey(step.connectionId, step.keyObject));
  if (!identifier) return null;

  /* Coming back up a key, the thing reached is the key object itself, so the
     column read and the name it goes by are one and the same. */
  return {
    standingOn: step.keyObject,
    filterField: step.keyField,
    readField: identifier,
    reachedObject: step.keyObject,
    reachedField: identifier,
  };
}

/**
 * The query for the hop about to run, and the system to run it against.
 *
 * `null` WHEN THERE IS NOTHING LEFT TO ASK — the walk finished, or a hop
 * reached nothing and there is no frontier to carry into the next one.
 */
/**
 * Is there anything left of this walk?
 *
 * ONE DEFINITION OF DONE. `nextQuery` spelled the same condition out inline —
 * no step left, or the walk exhausted — so there were two statements of when a
 * walk is over and only one of them was named. A reader changing what
 * "exhausted" means would have found one of them.
 */
export const finished = (walk: Walk) => walk.exhausted || walk.at >= walk.route.steps.length;

export function nextQuery(
  walk: Walk,
  limits: Limits = DEFAULT_LIMITS,
): { connectionId: string; query: Query; step: RouteStep } | null {
  const step = walk.route.steps[walk.at];
  /* `!step` is what `finished` already checks; it stays so the type narrows. */
  if (finished(walk) || !step || walk.frontier.values.length === 0) return null;

  /*
   * BOTH ENDS ARE SELECTED EITHER WAY, so the crossing can be recorded. A walk
   * that returned only its destination could not show a reader which invoice of
   * the forty reached the order they are looking at.
   */
  const shape = hopShape(walk, step);
  if (!shape) return null;

  return {
    connectionId: step.connectionId,
    step,
    query: {
      object: shape.standingOn,
      filters: [{ field: shape.filterField, op: 'in', value: walk.frontier.values }],
      sort: [],
      /* Only the two key columns. Every other column on those rows is a
         business value and §3.2 does not permit reading one to walk a graph. */
      fields: distinct([shape.filterField, shape.readField]),
      /*
       * ONE PAST THE CEILING, SO TRUNCATION IS DETECTABLE. A source asked for
       * exactly the limit and returning exactly the limit cannot say whether
       * there was more; asked for one more, a full page means there was.
       */
      limit: limits.maxFrontier + 1,
    },
  };
}

/**
 * Take the rows a hop returned and stand on what they reached.
 *
 * ── The bound fires here, on the hop that widened it ───────────────────────
 *
 * A walk fans out multiplicatively and the hop that does it is the one worth
 * naming. Checking only at the end would report "too wide" about a walk whose
 * second hop was the problem, and the reader would narrow the wrong thing.
 *
 * REFUSES RATHER THAN TRUNCATING, like everything else behind `bounds.util`. A
 * walk cut at five thousand invoices reaches a set of orders that is not the
 * set of orders that supplier touched, and it prints a path that looks exactly
 * as complete as one that is.
 */
export function absorb(
  walk: Walk,
  rows: ReadonlyArray<Record<string, unknown>>,
  limits: Limits = DEFAULT_LIMITS,
): Outcome<Walk> {
  const step = walk.route.steps[walk.at];
  if (!step) return no('That walk has already finished.');

  const shape = hopShape(walk, step);
  if (!shape) {
    return no(`Nothing says what ${step.keyObject} calls itself by, so that hop cannot be read.`);
  }

  /*
   * TRUNCATION IS A REFUSAL, NOT A SMALLER ANSWER — the guarantee at the top of
   * `bounds.util`. The query asked for one past the ceiling precisely so a full
   * page means the source had more to give; taking it would print a path that
   * looks exactly as complete as one that is.
   */
  if (rows.length > limits.maxFrontier) {
    return no(
      `Hop ${walk.at + 1} of that walk returned more rows than a path can carry.`,
      checkFrontier(rows.length, limits) ?? undefined,
    );
  }

  const crossed: Crossing[] = [];
  const reached: string[] = [];

  for (const row of rows) {
    const from = stated(row[shape.filterField]);
    const to = stated(row[shape.readField]);

    /* A row whose key is null points at nothing. That is the absence
       detector's business, not a dead end to report as one. */
    if (from === null || to === null) continue;

    crossed.push({
      relationshipId: step.relationshipId,
      connectionId: step.connectionId,
      direction: step.direction,
      keyObject: step.keyObject,
      keyField: step.keyField,
      fromValue: from,
      toValue: to,
    });
    reached.push(to);
  }

  const values = distinct(reached);

  const width = checkFrontier(values.length, limits);
  if (width) {
    return no(
      `Hop ${walk.at + 1} of that walk reached more instances than a path can carry.`,
      width,
    );
  }

  /*
   * WHAT THE NEXT HOP IS STANDING ON, and it is the field that was actually
   * READ rather than the one that was filtered on. Along a key that is the
   * target's own identifier, because a foreign key holds exactly that. Against
   * it, it is the key object's identifier, which came from the manifest.
   */
  const frontier: Frontier = {
    object: shape.reachedObject,
    field: shape.reachedField,
    values,
  };

  return ok({
    route: walk.route,
    at: walk.at + 1,
    frontier,
    crossed: [...walk.crossed, ...crossed],
    exhausted: values.length === 0,
    identifiers: walk.identifiers,
  });
}

/** Has the walk run every step it had? */

/**
 * Which start reached which end, through the crossings recorded on the way.
 *
 * ── Raw at both ends ───────────────────────────────────────────────────────
 *
 * The pairs come back as the sources stated them. Turning either end into a
 * concept entity is the caller's, at read time, and this deliberately cannot do
 * it: nothing here has ever seen a confirmed resolution.
 *
 * ── Every path, not a representative one ───────────────────────────────────
 *
 * An invoice reaching a supplier twice — directly and through its order — is
 * two paths that can disagree, and collapsing them to one hides the
 * disagreement that was the interesting part.
 */
export function pathsThrough(walk: Walk): Array<{ from: string; to: string; via: Crossing[] }> {
  const byHop: Crossing[][] = walk.route.steps.map(() => []);

  /* Crossings arrive hop by hop and in order, so they group by which step they
     belong to — which is the relationship they name, on the route. */
  for (const crossing of walk.crossed) {
    const hop = walk.route.steps.findIndex(
      (step) =>
        step.relationshipId === crossing.relationshipId && step.direction === crossing.direction,
    );
    if (hop >= 0) byHop[hop]!.push(crossing);
  }

  let paths: Array<{ from: string; to: string; via: Crossing[] }> = (byHop[0] ?? []).map(
    (crossing) => ({ from: crossing.fromValue, to: crossing.toValue, via: [crossing] }),
  );

  for (let hop = 1; hop < byHop.length; hop += 1) {
    const next: Array<{ from: string; to: string; via: Crossing[] }> = [];

    for (const path of paths) {
      for (const crossing of byHop[hop] ?? []) {
        if (crossing.fromValue !== path.to) continue;
        next.push({ from: path.from, to: crossing.toValue, via: [...path.via, crossing] });
      }
    }

    paths = next;
  }

  return paths;
}

/** The value as stated, or null where the source had none. */
const stated = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value);
  /* The column that stores a link bounds it at 512; a longer one is not an
     identifier, and carrying it would put a business value in a key. */
  return text === '' || text.length > 512 ? null : text;
};

const distinct = (values: readonly string[]): string[] => [...new Set(values)];
