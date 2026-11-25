import type { ContributingObject } from '../../models/concept.model';
import { valueFits, type Comparison, type Filter, type Query } from '../execution/query.execution';
import type { ConceptRelationship } from '../../models/concept.model';
import { routesBetween, type Route } from './relate.ontology';
import { keyOf } from '../detectors/shared.detector';

/**
 * §7 — turning a question asked in a concept's words into one query per system.
 *
 * ── What this exists to remove ─────────────────────────────────────────────
 *
 * Until now a question named a raw object: "rows from the table called
 * `invoices`". The caller had to know each system's table and column names,
 * which is exactly the knowledge the ontology exists to make unnecessary — so
 * the concepts were used by detectors and by nothing anybody queried through.
 *
 * A question names the CONCEPT and the concept's own field names now. This
 * translates it, once per contributing system, through the field map that
 * confirmation stored.
 *
 * ── Selecting and filtering are not the same strictness ────────────────────
 *
 * ASKING FOR A FIELD ONLY SOME SYSTEMS HOLD IS FINE. The ones that hold it
 * answer, the ones that do not hold no reading, and `merge` already treats an
 * absent reading as absence rather than as disagreement. Nothing is wrong with
 * an invoice whose status only one of two systems tracks.
 *
 * FILTERING ON ONE IS ANSWERED BY THE SYSTEMS THAT HOLD IT, AND SAYS SO. If
 * Sage holds no `status`, then Sage cannot say which invoices are open — but
 * Netsuite can, and refusing the question throws away an answer anybody with
 * one connector to Netsuite would have got. This was a refusal, and systems
 * almost never hold the same fields, so the more of them a customer connected
 * the more of their simple questions were refused.
 *
 * What made it a refusal is still true and still handled: Sage's rows must
 * neither come back unfiltered nor go quietly missing. So each system is sent
 * the conditions it can apply and VOUCHES for those alone; a record is kept
 * when, between them, the systems that returned it vouch for every condition;
 * a system that can apply none is not asked which records match at all — its
 * half of each kept record is fetched afterwards by match key, like any other
 * counterpart. And the plan names every field some system does not hold, so
 * the answer can say which systems could not be asked. A gap is a fact about
 * the estate to report, not a reason to say nothing.
 *
 * ── It plans; it does not fetch ────────────────────────────────────────────
 *
 * Like the rest of the engine, this is arithmetic over what it is handed. The
 * service runs the queries, and a plan is reproducible from a transcript.
 */

export type ConceptQuery = {
  /** Fields to return, in the concept's own names. Empty means every mapped one. */
  select: string[];
  /** Filters, in the concept's own names. */
  where: Filter[];
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit: number;
  /**
   * §7 — totals to compute over the entities, in the concept's field names.
   *
   * PLANNED LIKE ANY OTHER FIELD, so a total over a field no system maps is
   * refused by name rather than returning null and leaving somebody to work out
   * why. The arithmetic happens after resolution, where it is correct.
   */
  aggregate?: Array<{
    operation: 'count' | 'sum' | 'average' | 'minimum' | 'maximum';
    field: string;
  }>;
};

export type PlannedSource = {
  connectionId: string;
  query: Query;
  /**
   * Concept field name -> this system's column, for every field selected.
   *
   * CARRIED WITH THE PLAN so the caller reading rows back does not have to
   * re-derive it and cannot re-derive it differently.
   */
  reading: Record<string, string>;
  /**
   * The filtered fields this system holds, in the concept's names: the
   * conditions it was sent, and so the ones a row it returns has passed.
   */
  vouchesFor: string[];
  /**
   * Whether it is asked which records match.
   *
   * FALSE WHEN THE QUESTION FILTERS AND THIS SYSTEM HOLDS NONE OF THOSE FIELDS.
   * Asked anyway it would return every record it has, none of them vouched for
   * — a whole table moved to be thrown away. Its query is still planned, for
   * the reading it carries; the caller fetches its rows by match key instead.
   */
  asked: boolean;
};

/**
 * A field the question filters on, and the systems that do not hold it.
 *
 * `unchecked` IS HOW MANY RECORDS THAT LEFT OUT: those held only in systems
 * with no such field, so that nothing could say whether they match. Counted by
 * the caller, from keys alone, and ABSENT WHERE IT COULD NOT BE COUNTED within
 * what one answer may ask of somebody's systems — never guessed. Zero means
 * every record there is also held somewhere that could be asked, and so
 * nothing was left out at all.
 */
export type Unheld = { fieldPath: string; connectionIds: string[]; unchecked?: number };

export type PlanRefusal = {
  reason: string;
  code: string;
  detail: Record<string, unknown>;
};

export type Plan =
  | {
      ok: true;
      sources: PlannedSource[];
      selected: string[];
      /** Empty when every system holds every filtered field, which is the plan this always was. */
      unheld: Unheld[];
    }
  | { ok: false; refusal: PlanRefusal };

/**
 * Plan a question over one concept.
 *
 * THE IDENTIFIER AND MATCH KEYS ARE ALWAYS FETCHED, whether or not they were
 * asked for. Resolution cannot say which rows are the same entity without them,
 * and an answer that skipped them would be rows from several systems with no
 * way to tell which are one thing — which is the shape of answer this replaces.
 */
export function planConceptQuery(input: {
  objects: readonly ContributingObject[];
  /**
   * §7.3 — per connection, the declared type of each source column.
   *
   * NEEDED BECAUSE A DATE IS NOT A MOMENT. A period resolves to instants, and
   * an instant compared against a DATE column is wrong by up to a day for any
   * organisation not on UTC: a New York year begins at `2026-01-01T05:00Z`, a
   * date column holding `2026-01-01` promotes to midnight UTC, and the first
   * day of the year is EXCLUDED — from the source, silently.
   *
   * The type differs per system for the same concept field, so this cannot be
   * decided before the plan reaches each one.
   */
  fieldTypes?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** The calendar those instants were resolved against. */
  calendar?: { timeZone: string };
  /**
   * §4.1 — narrow to these records, by the identifier their own system states.
   *
   * WHAT A JOIN ARRIVES HOLDING. A walk from one concept to another ends with
   * identifiers, not with field values, and a concept can otherwise only be
   * filtered on its OWN field names — so without this the second half of a join
   * has nothing to ask by.
   *
   * PUSHED TO EVERY SOURCE, DELIBERATELY. A ref belongs to the system the walk
   * arrived at; the others return nothing for it, which is absence rather than
   * error, and the completion pass then goes and finds their counterparts by
   * match key.
   */
  refs?: readonly string[];
  /**
   * §2.3 (131) — field names every system now also reads under another.
   *
   * ANSWERED WHEN NAMED, LEFT OUT OF "EVERY FIELD". An answer taught that one
   * system's `town` is the concept's `city`; the column keeps its old name so
   * what was saved against it still works, and is not listed under both.
   */
  superseded?: readonly string[];
  request: ConceptQuery;
  /** Rows one system may return. The caller's bound, from `bounds.util`. */
  maxRows: number;
}): Plan {
  if (input.objects.length === 0) {
    return {
      ok: false,
      refusal: {
        reason: 'That concept has no objects, so there is nothing to ask.',
        code: 'invalid.concept_empty',
        detail: {},
      },
    };
  }

  /*
   * WHAT THE CONCEPT CAN ANSWER AT ALL: every field name any contributing
   * system maps. A name outside this is a question about a field the concept
   * does not have, which is worth saying plainly rather than answering emptily.
   */
  const known = new Set(input.objects.flatMap((object) => Object.keys(object.fieldMap)));

  const unknown = [
    ...input.request.select,
    ...input.request.where.map((one) => one.field),
    ...(input.request.aggregate ?? []).map((one) => one.field),
    /*
     * SORT WAS THE ONE CLAUSE THAT SKIPPED THIS, and the asymmetry was
     * dangerous rather than merely untidy: an unmappable FILTER refused by
     * name, while an unmappable SORT was silently dropped a few lines below —
     * so "the ten biggest by margin", against a concept with no margin, came
     * back as ten arbitrary rows instead of a refusal naming the field.
     */
    ...input.request.sort.map((one) => one.field),
  ]
    .filter((field) => !known.has(field))
    .sort();

  if (unknown.length > 0) {
    return {
      ok: false,
      refusal: {
        reason: `That concept has no field called ${[...new Set(unknown)].join(' or ')}.`,
        code: 'invalid.unknown_field',
        detail: { fields: [...new Set(unknown)] },
      },
    };
  }

  /*
   * ── AND EVERY FILTER HAS TO MEAN SOMETHING ───────────────────────────────
   *
   * CHECKED HERE BECAUSE HERE IS WHERE BOTH PATHS CROSS. `validateCompiled`
   * applies the same rule to what a model returns, but the direct API accepts
   * `value: z.unknown()` and reaches this function without passing through it —
   * so `in` with a bare string arrived at a SQL source as `= ANY($1)` against a
   * non-array, and `eq` with an array matched nothing and came back as a
   * confident empty answer.
   */
  const mismatched = input.request.where
    .map((one) => ({ field: one.field, wrong: valueFits(one.op, one.value) }))
    .filter((one): one is { field: string; wrong: string } => one.wrong !== null);

  if (mismatched.length > 0) {
    return {
      ok: false,
      refusal: {
        reason: mismatched[0]!.wrong,
        code: 'invalid.filter_value',
        detail: { fields: [...new Set(mismatched.map((one) => one.field))] },
      },
    };
  }

  /*
   * ── WHICH SYSTEMS CANNOT BE ASKED WHICH CONDITION ────────────────────────
   *
   * Every filtered field is held somewhere, or it was refused above as a field
   * the concept does not have. Where a system does not hold one, the plan says
   * so by name rather than refusing — see the top of this file.
   */
  const filtered = [...new Set(input.request.where.map((one) => one.field))].sort();

  const unheld: Unheld[] = filtered
    .map((fieldPath) => ({
      fieldPath,
      connectionIds: [
        ...new Set(
          input.objects
            .filter((object) => !(fieldPath in object.fieldMap))
            .map((object) => object.connectionId),
        ),
      ].sort(),
    }))
    .filter((one) => one.connectionIds.length > 0);

  /*
   * ── EMPTY `select` MEANS EVERY FIELD, AND ONLY `select` DECIDES THAT ─────
   *
   * A field being TOTALLED or SORTED ON is also a field being selected: the
   * arithmetic and the ordering both happen after merging, over the merged
   * value, so a field nobody selected has no reading to work from and would
   * silently come back null.
   *
   * BUT THEY MUST NOT DECIDE WHETHER THE SELECT WAS EMPTY. Folding them in
   * first made `select: []` non-empty, so "show me the invoices, biggest first"
   * asked for every field and came back holding ONLY the amount — the rest of
   * each row quietly dropped, in a list that looks like the answer.
   *
   * A fixed order, so two identical questions produce two identical plans.
   */
  const alsoNeeded = [
    ...(input.request.aggregate ?? []).map((one) => one.field),
    ...input.request.sort.map((one) => one.field),
  ];

  const superseded = new Set(input.superseded ?? []);

  const selected =
    input.request.select.length > 0
      ? [...new Set([...input.request.select, ...alsoNeeded])]
      : [...new Set([...[...known].filter((field) => !superseded.has(field)), ...alsoNeeded])].sort();

  const sources = input.objects.map((object) => {
    const reading: Record<string, string> = {};
    for (const field of selected) {
      const column = object.fieldMap[field];
      /* A field this system does not hold is an absent reading, not an error.
         `merge` treats absence as absence rather than as disagreement. */
      if (column) reading[field] = column;
    }

    const columns = new Set<string>([
      /* Resolution needs these whether or not anybody asked. */
      object.identifierField,
      ...object.matchKeys,
      ...Object.values(reading),
    ]);

    const columnTypes = input.fieldTypes?.get(object.connectionId);

    const byRef: Filter[] =
      input.refs && input.refs.length > 0
        ? [{ field: object.identifierField, op: 'in', value: [...input.refs] }]
        : [];

    /* The conditions on fields this system holds, and no others. */
    const filters: Filter[] = input.request.where
      .filter((one) => one.field in object.fieldMap)
      .map((one) => {
        const column = object.fieldMap[one.field]!;

        return {
          ...one,
          field: column,
          value: asColumnMeans(one, columnTypes?.get(column), input.calendar?.timeZone),
        };
      });

    const vouchesFor = filtered.filter((fieldPath) => fieldPath in object.fieldMap);

    const sort = input.request.sort
      .map((one) => ({ field: object.fieldMap[one.field], direction: one.direction }))
      .filter((one): one is { field: string; direction: 'asc' | 'desc' } => Boolean(one.field));

    return {
      connectionId: object.connectionId,
      reading,
      vouchesFor,
      asked: filtered.length === 0 || vouchesFor.length > 0,
      query: {
        object: object.objectName,
        filters: [...filters, ...byRef],
        sort,
        fields: [...columns],
        /*
         * THE BOUND IS PER SYSTEM AND NOT THE QUESTION'S LIMIT. Ten entities
         * can need far more than ten rows from each side — one system may hold
         * several rows that resolve to one entity, and the limit applies to the
         * answer rather than to the fetch.
         */
        limit: input.maxRows,
      },
    };
  });

  return { ok: true, sources, selected, unheld };
}

/**
 * The records every condition was vouched for, where some system could not
 * vouch for all of them.
 *
 * ── What a returned row means once systems are sent different conditions ───
 *
 * A system sent every condition returns only records that pass them all, and
 * that was the whole rule while a filter had to be held everywhere. A system
 * sent SOME returns records that pass those — which says nothing about the
 * rest. "Customers in Farnborough on the gold plan", where the CRM holds the
 * city and the support desk holds the plan, brings back every Farnborough
 * company from one and every gold account from the other; the answer is the
 * customers BOTH returned.
 *
 * So a record is kept when the systems that returned it vouch for every
 * condition between them. One that is short of a condition either fails it or
 * is not held anywhere that could say, and neither belongs in an answer to the
 * question asked.
 *
 * DECIDED BY WHICH SYSTEMS ANSWERED, NEVER BY RE-READING A VALUE HERE. Each
 * source applied its own conditions its own way — its collation, its idea of a
 * date — and a second opinion formed in memory could disagree with the source
 * about a row the source had just returned.
 */
export function vouched<T extends { members: ReadonlyArray<{ connectionId: string }> }>(input: {
  entities: readonly T[];
  sources: ReadonlyArray<Pick<PlannedSource, 'connectionId' | 'vouchesFor'>>;
  /** The filtered fields, in the concept's names. */
  filtered: readonly string[];
}): T[] {
  const bySource = new Map(input.sources.map((one) => [one.connectionId, one.vouchesFor]));
  const needed = [...new Set(input.filtered)];

  return input.entities.filter((entity) => {
    const held = new Set(entity.members.flatMap((member) => bySource.get(member.connectionId) ?? []));
    return needed.every((fieldPath) => held.has(fieldPath));
  });
}

/**
 * Read one system's row back into the concept's own field names.
 *
 * THE PLAN'S OWN MAPPING, NOT A SECOND DERIVATION OF IT. A caller that
 * recomputed which column meant what could recompute it differently, and the
 * difference would show up as a field quietly reading null.
 */
export function readingsOf(
  source: PlannedSource,
  row: Record<string, unknown>,
): Array<{ fieldPath: string; value: unknown }> {
  return Object.entries(source.reading).map(([fieldPath, column]) => ({
    fieldPath,
    value: row[column],
  }));
}

/* ── Aggregation push-down ───────────────────────────────────────────────── */

export type AggregationPlan =
  /** One system holds this concept, so its own total IS the total. */
  | { where: 'source'; connectionId: string; operations: Array<'count' | 'sum'> }
  /** It has to be computed here, after resolution. `because` says why. */
  | { where: 'local'; because: string; connectionIds: string[] };

/**
 * Where an aggregate can honestly be computed.
 *
 * ── The composition model does not survive resolution ──────────────────────
 *
 * The obvious design is a partial step at each source and a final step that
 * combines them: sum of sums, sum of counts, min of minima. It is how every
 * federated query engine does it, and it is WRONG HERE — because those engines
 * are adding up rows and this product is adding up THINGS.
 *
 * Netsuite holds invoices A, B and C; Sage holds B, C and D, and B and C are
 * the same two invoices. Pushed down, the partials are 600 and 900 and their
 * sum is 1500. The true total over four invoices is 1000. It over-counts every
 * entity that more than one system holds, by exactly the amount resolution
 * exists to find — and nothing in the answer would say so.
 *
 * ── So push-down is sound in exactly one case ──────────────────────────────
 *
 * A concept contributed to by ONE connection. There is no overlap to
 * double-count, so the source's own total is the answer and the rows never have
 * to move. That is worth having: it is the difference between asking an ERP for
 * a number and asking it for fifty thousand rows.
 *
 * EVERYTHING ELSE COMES BACK AND IS COUNTED AFTER RESOLUTION, under the row
 * bound — which is the case that refuses most often, and the refusal names the
 * connection whose volume forced it, because the reader's next question is why
 * this worked last week.
 */
export function planAggregation(input: {
  objects: readonly ContributingObject[];
  operations: ReadonlyArray<{ operation: string; field: string }>;
  /** Per connection, what that source declares it can push down. */
  capabilities: ReadonlyMap<string, { aggregates: ReadonlyArray<'count' | 'sum' | 'group_by'> }>;
}): AggregationPlan {
  const connectionIds = [...new Set(input.objects.map((one) => one.connectionId))];

  if (input.operations.length === 0) {
    return { where: 'local', because: 'Nothing was asked for.', connectionIds };
  }

  if (connectionIds.length !== 1) {
    return {
      where: 'local',
      because:
        'More than one system holds this concept, so a total computed at each and added ' +
        'would count twice every record they both hold.',
      connectionIds,
    };
  }

  const only = connectionIds[0]!;
  const declared = input.capabilities.get(only)?.aggregates ?? [];

  /*
   * ONLY WHAT THE CONNECTOR SAYS IT CAN DO. `capabilities.aggregates` has
   * declared `count`, `sum` and `group_by` since the manifest existed and
   * nothing has ever read it. There is no `average`, `minimum` or `maximum` in
   * it, so those are computed here whatever the source could manage — which is
   * honest rather than limiting: a mean is a sum over a count, and both of
   * those push down.
   */
  const pushable = input.operations
    .map((one) => one.operation)
    .filter((one): one is 'count' | 'sum' => one === 'count' || one === 'sum')
    .filter((one) => declared.includes(one));

  if (pushable.length !== input.operations.length) {
    const cannot = input.operations
      .map((one) => one.operation)
      .filter((one) => !pushable.includes(one as 'count' | 'sum'));

    return {
      where: 'local',
      because: `That system does not compute ${[...new Set(cannot)].join(' or ')}.`,
      connectionIds,
    };
  }

  return { where: 'source', connectionId: only, operations: [...new Set(pushable)] };
}

/* ── Joins ───────────────────────────────────────────────────────────────── */

export type JoinPlan =
  | {
      ok: true;
      /** The concept queried first, because its filters reduce most. */
      leadConceptId: string;
      followConceptId: string;
      route: Route;
      /**
       * How many identifiers may go into one `in`, or null where the source
       * declares no limit. A longer list becomes several requests.
       */
      batchSize: number | null;
    }
  | { ok: false; refusal: PlanRefusal };

/**
 * Plan a question that spans two concepts.
 *
 * ── A join is a route, resolved before any data moves ──────────────────────
 *
 * The edges already exist: `concept_relationships`, derived from the foreign
 * keys the customer's own schemas declare, with direction. So the join plan is
 * a path through that graph, and if there is no path there is no join — which
 * is a refusal rather than a slow query, and it costs nothing to discover.
 *
 * SEVERAL PATHS IS AN AMBIGUITY, NOT A CHOICE TO MAKE. An invoice reaches a
 * supplier directly and also through its order, and those can disagree — the
 * order was re-parented after the invoice was raised. Picking one silently
 * answers a question nobody asked.
 *
 * ── It executes as a sequence, which `walk` already does ───────────────────
 *
 * Query the lead concept bounded, take the resolved identifiers, push them
 * down to the other as an `in`, and merge on the relationship field. That is
 * the mechanic `engine/traverse` implements, which is why traversal existing
 * first makes this cheaper than it looks.
 *
 * ── Join order is a cost decision, and the filters decide it ───────────────
 *
 * Start from the side the filters reduce most, because that is what makes the
 * `in` list small enough to push down at all. A filter on the second concept
 * and none on the first means starting from the second and walking backwards,
 * which the edge direction permits — `routesBetween` returns `against` steps
 * for exactly this.
 */
export function planJoin(input: {
  from: { conceptId: string; filters: number };
  to: { conceptId: string; filters: number };
  relationships: readonly ConceptRelationship[];
  /** Per connection, how long an `in` list it will accept. */
  batchSizes: ReadonlyMap<string, number>;
  maxHops: number;
  /**
   * §4.1 — which of the routes to take, where more than one exists.
   *
   * SURFACED, THEN CHOSEN. Two routes are two different CLAIMS — an invoice
   * reaches a supplier directly and through its order, and they can disagree —
   * so one is never picked silently. But the refusal that lists them was the
   * end of the road: `walk` has always let a caller answer it and this could
   * not, which made every join between two systems that declare the same key
   * permanently unanswerable.
   */
  routeIndex?: number;
}): JoinPlan {
  /*
   * THE SIDE WITH MORE FILTERS LEADS. It is a crude estimate and a defensible
   * one: a filter is the only thing here that reduces a population before it
   * moves, and the alternative is statistics this product does not keep.
   * Ties go to the concept the question named first, which is deterministic.
   */
  const leadFirst = input.from.filters >= input.to.filters;
  const lead = leadFirst ? input.from : input.to;
  const follow = leadFirst ? input.to : input.from;

  const routes = routesBetween({
    relationships: input.relationships,
    from: lead.conceptId,
    to: follow.conceptId,
    maxHops: input.maxHops,
  });

  if (routes.length === 0) {
    return {
      ok: false,
      refusal: {
        reason:
          'Nothing in your systems declares a key between those two, so there is no way to ' +
          'relate them.',
        code: 'refusal.no_route',
        detail: { from: lead.conceptId, to: follow.conceptId },
      },
    };
  }

  if (routes.length > 1 && input.routeIndex === undefined) {
    /*
     * SURFACED, NOT CHOSEN. An invoice reaches a supplier directly and through
     * its order, and the two can disagree — which is the interesting part, and
     * picking one hides it. The caller answers with `routeIndex`.
     */
    return {
      ok: false,
      refusal: {
        reason: `There are ${routes.length} ways those two relate, and they can disagree.`,
        code: 'refusal.ambiguous_route',
        detail: {
          routes: routes.map((route) => ({
            hops: route.steps.length,
            through: route.steps.map((step) => `${step.keyObject}.${step.keyField}`),
          })),
        },
      },
    };
  }

  /*
   * THE CHOSEN ONE, OR THE ONLY ONE. An index past the end is a caller naming a
   * route that does not exist, which is refused rather than quietly treated as
   * the first — picking a different claim from the one asked for is exactly the
   * silent substitution the ambiguity refusal exists to prevent.
   */
  const route = routes[input.routeIndex ?? 0];

  if (!route) {
    return {
      ok: false,
      refusal: {
        reason: `There is no route ${input.routeIndex} between those two.`,
        code: 'refusal.no_route',
        detail: { available: routes.length },
      },
    };
  }

  /*
   * THE FOLLOW SIDE HAS TO ACCEPT AN `in`, or the identifiers cannot be pushed
   * down and the whole second concept comes back to be filtered here — which
   * is the fan-out this plan exists to avoid.
   */
  const declared = [...new Set(route.steps.map((step) => step.connectionId))]
    .map((id) => input.batchSizes.get(id) ?? 0)
    .filter((size) => size > 0);

  return {
    ok: true,
    leadConceptId: lead.conceptId,
    followConceptId: follow.conceptId,
    route,
    /* The smallest cap on the path, because every hop has to fit. Zero
       everywhere means nobody declared one, which is SQL's honest answer. */
    batchSize: declared.length > 0 ? Math.min(...declared) : null,
  };
}

/**
 * Split a list of identifiers into requests the source will accept.
 *
 * A LIST LONGER THAN THE CAP IS THE WORST FAILURE THIS PRODUCT HAS, because it
 * usually SUCCEEDS: the parameter is truncated or ignored rather than rejected,
 * so the answer comes back short and confident. Batching is what stops it, and
 * the cap is declared rather than discovered for the same reason.
 *
 * ── ZERO MEANS NO CAP, AND THAT IS THE MANIFEST'S WORD NOT A GUESS ───────
 *
 * `maxFilterValues` in `manifest.schema` says so explicitly: "Zero means the
 * source declares no limit, which SQL transports leave as the default rather
 * than each restating a meaningless one." So zero and `null` agree here, and a
 * reading where zero meant "takes no list" would send NO requests and silently
 * drop a source from the answer.
 *
 * WHETHER A SOURCE CAN BE ASKED AT ALL IS A DIFFERENT QUESTION, answered by
 * `capabilities.filters` containing `in`. Callers check that before they get
 * here; conflating the two is how a capable source gets dropped or an incapable
 * one gets a request it cannot make.
 */
export function batched<T>(values: readonly T[], size: number | null): T[][] {
  if (values.length === 0) return [];
  if (size === null || size <= 0 || values.length <= size) return [[...values]];

  const out: T[][] = [];
  for (let at = 0; at < values.length; at += size) out.push(values.slice(at, at + size));
  return out;
}

/**
 * §2.6 — the second pass that stops a FILTER from hiding a DISAGREEMENT.
 *
 * ── What the filter does to identity ───────────────────────────────────────
 *
 * A question filters `total > 150`. Netsuite says an invoice is 200 and Sage
 * says 90. Sage's row does not match the filter, so Sage never returns it, and
 * resolution sees one row where there are two:
 *
 *   — the value comes back `only`, decided, 200
 *   — `coverage` reports `disputed: 0`
 *   — `unmatched` claims Sage holds no counterpart
 *
 * ALL THREE ARE FALSE, and the third is the worst: it sends somebody to
 * investigate a missing record that is sitting right there, disagreeing. The
 * filter did not narrow the answer, it CHANGED it — and a dispute is exactly
 * what a filter on the disputed field is most likely to hide, because the two
 * systems disagreeing is what puts them on opposite sides of the threshold.
 *
 * ── Asking again, by identity rather than by value ─────────────────────────
 *
 * So every entity that came back from fewer systems than the concept spans is
 * asked about again — by MATCH KEY, with the caller's filter removed. Either
 * the counterpart exists and the disagreement is real, or it does not and
 * `unmatched` was right.
 *
 * ONLY WHEN A FILTER WAS PUSHED. An unfiltered question already saw every row,
 * so there is nothing to go back for and nothing to pay.
 *
 * ── Where it cannot ask, it does not claim ─────────────────────────────────
 *
 * A source that cannot push an `in` list, or that declares it takes none,
 * cannot be asked this question. That is reported as UNVERIFIED rather than
 * answered — the caller suppresses the `unmatched` claim instead of making one
 * it cannot stand behind.
 */
export type Completion = {
  queries: Array<{ connectionId: string; query: Query }>;
  /**
   * The normalised match keys this actually asked about.
   *
   * THE CALLER FILTERS ON THIS, NOT ON THE ENTITY KEYS. A multi-column key is
   * asked for as a cross-product, so a source returns pairs nobody wanted —
   * and an entity linked only by a CONFIRMED ALIAS has no match key at all for
   * its own identity, so filtering on entity keys threw away the very
   * counterpart this pass had just gone and fetched.
   */
  wantedKeys: Set<string>;
  /** Per connection, the identifiers asked about by confirmed alias. */
  wantedRefs: Map<string, Set<string>>;
  /** Connections that could not be asked, so nothing may be claimed about them. */
  unverified: string[];
};

export function completionQueries(input: {
  objects: readonly ContributingObject[];
  /** The concept fields to read back, so the counterpart merges like any row. */
  selected: readonly string[];
  entities: ReadonlyArray<{
    members: ReadonlyArray<{ connectionId: string; ref?: unknown; row: Record<string, unknown> }>;
  }>;
  /**
   * Per connection, how long an `in` list it takes.
   *
   * ABSENT MEANS IT CANNOT BE ASKED AT ALL — the source does not declare `in`
   * among its filters. Present-and-zero means no cap, which is the manifest's
   * own reading of `maxFilterValues`. The two are opposite answers and the
   * caller must not collapse them.
   */
  batchSizes: ReadonlyMap<string, number | null>;
  /**
   * §2.6 — pairs a person confirmed are the same record.
   *
   * ASKED FOR BY IDENTIFIER, NOT BY KEY, because that is the whole point of a
   * confirmed alias: the two spellings have nothing in common, which is why
   * somebody had to say so. Asking by match key can never find the counterpart,
   * so a filter went on hiding a disagreement between records SOMEBODY DID
   * MANUAL WORK TO LINK — worse than hiding one between records that matched by
   * themselves.
   */
  aliases?: ReadonlyArray<{
    connectionA: string;
    valueRefA: string;
    connectionB: string;
    valueRefB: string;
  }>;
  maxRows: number;
}): Completion {
  const byConnection = new Map(input.objects.map((one) => [one.connectionId, one]));

  /* Per connection, the match-key values to ask it about. Positional, because
     that is how resolution pairs them: `matchKeys[i]` against `matchKeys[i]`. */
  const wanted = new Map<string, Array<Set<string>>>();
  const unverified = new Set<string>();
  const wantedKeys = new Set<string>();
  const wantedRefs = new Map<string, Set<string>>();

  /* Confirmed aliases, indexed both ways: the link is symmetric and either
     side may be the one the filter kept. */
  const aliasedTo = new Map<string, Array<{ connectionId: string; ref: string }>>();
  for (const alias of input.aliases ?? []) {
    const a = `${alias.connectionA}\u0000${alias.valueRefA}`;
    const b = `${alias.connectionB}\u0000${alias.valueRefB}`;
    aliasedTo.set(a, [...(aliasedTo.get(a) ?? []), { connectionId: alias.connectionB, ref: alias.valueRefB }]);
    aliasedTo.set(b, [...(aliasedTo.get(b) ?? []), { connectionId: alias.connectionA, ref: alias.valueRefA }]);
  }

  for (const entity of input.entities) {
    const holders = new Set(entity.members.map((member) => member.connectionId));

    for (const object of input.objects) {
      if (holders.has(object.connectionId)) continue;

      if (!input.batchSizes.has(object.connectionId)) {
        /* It cannot be asked. Recorded rather than skipped silently, because
           the caller has to stop claiming things about it. */
        unverified.add(object.connectionId);
        continue;
      }

      /*
       * FIRST, ANYTHING A PERSON CONFIRMED. An alias links two identifiers
       * whose keys have nothing in common — that is why somebody had to say so
       * — and no amount of asking by match key will ever find it.
       */
      for (const member of entity.members) {
        const ref = member.ref === undefined ? null : String(member.ref);
        if (ref === null) continue;

        for (const linked of aliasedTo.get(`${member.connectionId}\u0000${ref}`) ?? []) {
          if (linked.connectionId !== object.connectionId) continue;
          wantedRefs.set(
            object.connectionId,
            (wantedRefs.get(object.connectionId) ?? new Set<string>()).add(linked.ref),
          );
        }
      }

      const slots =
        wanted.get(object.connectionId) ?? object.matchKeys.map(() => new Set<string>());

      for (const member of entity.members) {
        const from = byConnection.get(member.connectionId);
        if (!from || from.matchKeys.length !== object.matchKeys.length) continue;

        for (let at = 0; at < object.matchKeys.length; at++) {
          const value = member.row[from.matchKeys[at]!];
          if (value === null || value === undefined || value === '') continue;

          /*
           * THE EXACT SPELLING AND THE NORMALISED ONE. Resolution matches on
           * `keyOf`, which trims and lowercases, so two systems recording
           * `INV-1` and `inv-1` are one entity. An `in` pushed to a source is
           * compared as the source stores it, so asking only the spelling we
           * happen to hold would report a counterpart that exists as missing —
           * reintroducing the false `unmatched` this whole pass removes.
           */
          const raw = String(value).trim();
          slots[at]!.add(raw);
          slots[at]!.add(raw.toLowerCase());
          slots[at]!.add(raw.toUpperCase());
        }

        /* What the caller may keep: the key as RESOLUTION would read it, which
           is the whole normalised key rather than one column of it. */
        const key = keyOf(member.row, from.matchKeys);
        if (key !== null) wantedKeys.add(key);
      }

      wanted.set(object.connectionId, slots);
    }
  }

  const queries: Completion['queries'] = [];

  for (const [connectionId, slots] of wanted) {
    const object = byConnection.get(connectionId)!;
    const size = input.batchSizes.get(connectionId) ?? null;

    /*
     * ── BATCHED ON THE FIRST KEY, AND THE REST ARE ONLY A NARROWING ─────────
     *
     * A multi-column key cannot be expressed as one `in`, so the source is
     * asked for the CROSS-PRODUCT of the columns. That is deliberately more
     * than was wanted: asking two systems about companies (ACME, BETA) and
     * numbers (1, 2) also matches (ACME, 2) and (BETA, 1), which are not
     * entities this question selected.
     *
     * THE CALLER DROPS WHAT DOES NOT BELONG, by full match key, against the
     * entities that existed before this pass. So these secondary filters are an
     * OPTIMISATION and never a correctness condition — which is why one is
     * omitted rather than truncated when it would exceed the declared cap. A
     * list longer than the cap is the failure this whole mechanism exists to
     * prevent, and over-fetching is merely slower.
     */
    const lead = slots[0];
    if (!lead || lead.size === 0) continue;

    for (const batch of batched([...lead], size)) {
      queries.push({
        connectionId,
        query: {
          object: object.objectName,
          filters: [
            { field: object.matchKeys[0]!, op: 'in', value: batch },
            ...slots
              .slice(1)
              .map((values, at) => ({ field: object.matchKeys[at + 1]!, values: [...values] }))
              .filter((one) => one.values.length > 0)
              /* Omitted rather than truncated when it will not fit. */
              .filter((one) => size === null || size <= 0 || one.values.length <= size)
              .map((one) => ({ field: one.field, op: 'in' as const, value: one.values })),
          ],
          fields: [
            ...new Set([
              object.identifierField,
              ...object.matchKeys,
              ...input.selected.map((field) => object.fieldMap[field]).filter((one): one is string => Boolean(one)),
            ]),
          ],
          sort: [],
          limit: input.maxRows,
        },
      });
    }
  }

  /*
   * ── AND THE ONES A PERSON CONFIRMED, ASKED FOR BY IDENTIFIER ─────────────
   *
   * Separate requests rather than another filter on the same one: an alias and
   * a match key are different questions, and ANDing them would return only
   * records that satisfy both — which is none of them, since an alias exists
   * precisely because the keys do not agree.
   */
  for (const [connectionId, refs] of wantedRefs) {
    const object = byConnection.get(connectionId);
    if (!object || refs.size === 0) continue;

    for (const batch of batched([...refs], input.batchSizes.get(connectionId) ?? null)) {
      queries.push({
        connectionId,
        query: {
          object: object.objectName,
          filters: [{ field: object.identifierField, op: 'in', value: batch }],
          fields: [
            ...new Set([
              object.identifierField,
              ...object.matchKeys,
              ...input.selected
                .map((field) => object.fieldMap[field])
                .filter((one): one is string => Boolean(one)),
            ]),
          ],
          sort: [],
          limit: input.maxRows,
        },
      });
    }
  }

  return { queries, wantedKeys, wantedRefs, unverified: [...unverified].sort() };
}

/**
 * A filter value as that column will actually read it.
 *
 * ── AN INSTANT AGAINST A DATE COLUMN IS WRONG BY UP TO A DAY ───────────────
 *
 * A period resolves to instants, correctly, in the organisation's own zone. A
 * New York year begins at `2026-01-01T05:00:00.000Z`. A DATE column has no
 * zone: `2026-01-01` promotes to midnight UTC, which is five hours EARLIER
 * than the boundary — so the first day of the year fails `>= from` and is
 * dropped at the source, silently, for every organisation not on UTC.
 *
 * Against a date column the boundary is therefore expressed as the CALENDAR
 * DATE it names in that organisation's zone, which is the thing the column is
 * actually recording.
 *
 * ONLY WHERE THE COLUMN SAYS SO. A `datetime` column holds a moment and
 * compares against a moment correctly; truncating for it would throw away the
 * time of day and widen the period by up to a day in the other direction.
 */
function asColumnMeans(
  filter: { op: Comparison; value?: unknown },
  columnType: string | undefined,
  timeZone: string | undefined,
): unknown {
  if (columnType !== 'date' || timeZone === undefined) return filter.value;
  if (typeof filter.value !== 'string') return filter.value;

  const at = Date.parse(filter.value);
  if (Number.isNaN(at) || !filter.value.includes('T')) return filter.value;

  const shown = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const on = (instant: number) => shown.format(new Date(instant));

  if (filter.op === 'gte' || filter.op === 'gt') {
    /* A lower bound names the first day included. */
    return on(at);
  }

  if (filter.op === 'lt' || filter.op === 'lte') {
    /*
     * An upper bound is EXCLUSIVE and lands on local midnight, so the date it
     * names is the first day NOT included and `< that date` is exactly right.
     * A bound part-way through a day — "year to date", which ends now — has to
     * round UP, or today's records fall outside a period that includes today.
     */
    const local = on(at);

    /* `offsetShownAt` returns local-minus-UTC, so the wall clock as an epoch is
       `at + offset`. Getting that sign backwards rounded every exact boundary
       up a day, widening the period by one. */
    const onTheHour = Date.parse(`${local}T00:00:00Z`) === at + offsetShownAt(timeZone, at);

    return onTheHour ? local : on(at + 86_400_000);
  }

  return filter.value;
}

/** How far the zone is from UTC at that instant. */
function offsetShownAt(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));

  const value = (type: string) => Number(parts.find((one) => one.type === type)?.value ?? '0');

  return (
    Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour') === 24 ? 0 : value('hour'),
      value('minute'),
      value('second'),
    ) - at
  );
}
