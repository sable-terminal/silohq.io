import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { notFound, policy } from '../utils/error.util';
import { childLogger } from '../config/logger.config';
import * as renderRepo from '../repos/render.repo';
import { log as writeAudit } from './audit.service';
import * as savedViewRepo from '../repos/savedView.repo';
import type { Archetype } from '../models/render.model';
import * as renderEngine from '../engine/render/select.render';
import * as proseEngine from '../engine/render/prose.render';
import * as flagEngine from '../engine/render/flags.render';
import { nameOf } from '../utils/words.util';
import type { Actor } from './scope.service';

const log = childLogger('render');

/**
 * Rendering §4 — choosing an archetype, and recording when somebody disagrees.
 *
 * ── THE PRECEDENCE MOVED HERE, AND THE OLD REASON STILL HOLDS ─────────────
 *
 * This file used to say the precedence lived in the client and must stay there,
 * because "the same result always draws the same way" and a selection that
 * consulted history would make the drawing depend on who had been looking at
 * it. That argument is about DETERMINISM, which `select` keeps exactly — it
 * reads a shape and nothing else — and not about which side of the wire it runs
 * on. §8's tiles, §9's exports and §11's `archetype_selected` all need the
 * answer here, and two clients implementing one precedence would diverge.
 *
 * ── WHY THE RECORDING IS STILL WORTH HAVING ───────────────────────────────
 *
 * §4.3 — "The rate at which a given shape is overridden is the only measure of
 * whether precedence is right." A fixed precedence that is wrong is wrong the
 * same way every time, and the only evidence is people reaching for the
 * alternatives. Without this, "everyone keeps switching chains to hierarchies"
 * is an anecdote; with it, it is a number somebody can act on by changing the
 * precedence — deliberately, in code, for everybody.
 */

/* The ten of §3 live in the model, because the repo maps rows into them and a
   repo may not reach into a service to find out what they are. */
export type { Archetype };

/**
 * §1 — "It receives a result that has already been computed, resolved, scored
 * and ranked, and decides how to show it."
 *
 * THE MAPPING IS THE WHOLE OF WHAT THIS LAYER KNOWS ABOUT A RESULT, and it is
 * deliberately narrow: counts, flags and edges. No figure and no field contents
 * cross into `select`, so §10's "stores decisions about presentation and never
 * results" holds for what is computed as well as for what is written.
 *
 * ── `disputed` IS §4.1'S "ONE MEASURE FROM TWO SOURCES" ───────────────────
 *
 * The merge layer already decides this and says so: a field whose systems hold
 * different values comes back with `basis: 'disputed'` and NO value, because
 * §6 says both are shown and never averaged. That is exactly the signal §4.2
 * puts first in precedence, and it is read rather than recomputed.
 */
/**
 * Does this field hold moments in time?
 *
 * READ FROM THE VALUES AND PASSED ON AS A BOOLEAN, which is exactly where the
 * boundary sits. §1 — "selection reads structure, never subject" — and whether
 * a column holds dates is structure. The `ResultShape` the precedence sees has
 * nowhere to put the dates themselves, so no value reaches the decision.
 *
 * EVERY DECIDED VALUE, NOT THE FIRST. One parseable string in a column of
 * references would otherwise make a reference column a time dimension, and the
 * result would be drawn as a line.
 */
function looksTemporal(values: readonly unknown[]): boolean {
  if (values.length === 0) return false;
  return values.every(
    (value) =>
      value instanceof Date ||
      (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(value)),
  );
}

export function shapeOf(
  answer: {
    entities: Array<{ fields: Array<{ fieldPath: string; value?: unknown; basis: string }> }>;
    aggregates: Array<unknown>;
  },
  /**
   * §4.1's ordering signals, which the ANSWER does not carry.
   *
   * A result is a set of entities; that it was asked for in order is a fact
   * about the question. §3 needs it for two archetypes — a series is "a measure
   * over time" and a ranking is "entities ordered by MAGNITUDE" — and without
   * it both are indistinguishable from rows.
   */
  sort: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }> = [],
  /**
   * §4.1 — "whether a deviation was computed against a population".
   *
   * NOT SOMETHING A CONCEPT ANSWER CARRIES. A deviation is the detectors' work
   * — `observed`, `expected` and `deviation` live on a finding — so a caller
   * drawing findings passes it and a caller drawing a plain query does not.
   * Defaulting it false means a query is never drawn as a distribution, which
   * is correct: nothing worked out what normal was.
   */
  deviationComputed = false,
  /**
   * §12 — "Chain, Hierarchy, Network. THESE NEED RELATIONSHIP WALKING, which
   * gates them."
   *
   * The walking is the ontology's, and a joined answer already carries its
   * output: `joined.pairs` is which record reached which, by the identifier
   * each system states. That is an edge between two rows, which is exactly
   * §4.1's "presence of relationship edges between rows".
   *
   * DIRECTED, BECAUSE A WALK IS. The pairs come from following a relationship
   * one way — an invoice to its supplier — and the direction is the
   * information. §3's Network is the undirected case and is reached by a
   * caller that has associations rather than a walk.
   */
  edges: ReadonlyArray<{ from: string; to: string }> = [],
  directedEdges = false,
): renderEngine.ResultShape {
  const byPath = new Map<string, { contested: boolean; numeric: boolean }>();

  for (const entity of answer.entities) {
    for (const field of entity.fields) {
      const held = byPath.get(field.fieldPath) ?? { contested: false, numeric: false };
      /* One disputed reading anywhere makes the measure contested: §6 shows
         both values, so the disagreement belongs to the measure rather than to
         the one row that happened to have it. */
      held.contested = held.contested || field.basis === 'disputed';
      held.numeric = held.numeric || typeof field.value === 'number';
      byPath.set(field.fieldPath, held);
    }
  }

  const valuesByPath = new Map<string, unknown[]>();
  for (const entity of answer.entities) {
    for (const field of entity.fields) {
      if (field.value === undefined) continue;
      const held = valuesByPath.get(field.fieldPath) ?? [];
      held.push(field.value);
      valuesByPath.set(field.fieldPath, held);
    }
  }

  const timeField =
    [...valuesByPath].find(([, values]) => looksTemporal(values))?.[0] ?? null;

  const [leading] = sort;
  const numeric = new Set(
    [...byPath].filter(([, held]) => held.numeric).map(([fieldPath]) => fieldPath),
  );

  return {
    rowCount: answer.entities.length,
    measures: [...byPath].map(([fieldPath, held]) => ({ fieldPath, ...held })),
    timeField,
    /* §4.1 — "and whether values are ORDERED BY IT". A date column nobody
       sorted by is a field that happens to hold dates. */
    orderedByTime: leading !== undefined && leading.field === timeField,
    /* §3 — "ordered by MAGNITUDE". Sorting by name is an ordering and not a
       ranking, and a reader of a bar chart will believe the top one is the
       most whether or not it is. */
    orderedByMeasure: leading !== undefined && numeric.has(leading.field),
    orderedField: leading !== undefined && numeric.has(leading.field) ? leading.field : null,
    summedField:
      (
        answer.aggregates.find(
          (aggregate) =>
            typeof aggregate === 'object' &&
            aggregate !== null &&
            (aggregate as { operation?: unknown }).operation === 'sum',
        ) as { fieldPath?: string } | undefined
      )?.fieldPath ?? null,
    edges: [...edges],
    directedEdges,
    /*
     * §3 — "Parts of a whole", and a total alone does not make one. Adding up
     * an average's inputs means nothing, and drawing them as slices would be a
     * picture asserting arithmetic nobody did. Only a sum has parts.
     */
    summable: answer.aggregates.some(
      (aggregate) =>
        typeof aggregate === 'object' &&
        aggregate !== null &&
        (aggregate as { operation?: unknown }).operation === 'sum',
    ),
    deviationComputed,
  };
}

/**
 * The result this layer is handed, named by what it needs rather than by where
 * it came from.
 *
 * §1 — the render layer "receives a result that has already been computed,
 * resolved, scored and ranked". Structurally this is a `ConceptAnswer`, and it
 * is not typed as one on purpose: the query service owns that type, and a
 * render layer that imported it would be coupled to the shape of a QUESTION
 * rather than to the shape of a RESULT. Anything that can produce these fields
 * can be drawn.
 */
export type Answer = Parameters<typeof shapeOf>[0] &
  flagEngine.FlaggableResult & {
    concept: { name: string };
    /** Every record matched, when the answer carries it. */
    matched?: number;
    aggregates: proseEngine.ProseAggregate[];
    lineage: Array<proseEngine.ProseInput['lineage'][number] & { connectionId?: string }>;
    /** Siloes (136) — what differs between two copies, per system, where the question asked what changed. */
    changes?: {
      fields?: string[];
      systems: Array<Omit<NonNullable<proseEngine.ProseInput['changes']>['systems'][number], 'name'> & { connectionId: string }>;
    };
  };

/** What a caller needs to draw a result any of §2's three ways. */
export interface Rendered {
  /** §4 — the archetype, and the others that also fit. */
  archetype: renderEngine.Selection;
  /** §2 — the answer in sentences, assembled from the result and nothing else. */
  prose: proseEngine.Prose;
  /** §6 — the three flags, in every representation because they are here. */
  flags: flagEngine.Flag[];
  /** §2 — prose unless this person has said otherwise for this view. */
  representation: renderRepo.Representation;
  /**
   * The structure the archetype was chosen from, handed back so the caller can
   * record what it drew (§11 `archetype_selected`).
   *
   * SAFE TO ROUND-TRIP because it holds no values — counts, booleans, field
   * paths and edges between row references. And the server does not take the
   * caller's word for the archetype when it comes back: `record` selects again
   * from this shape, deterministically, so what is recorded is what the
   * precedence chose. The worst a client can do by sending a different shape is
   * mis-record its own selection row, which changes no figure anywhere.
   */
  shape: renderEngine.ResultShape;
}

/**
 * §1 — "It receives a result that has already been computed, resolved, scored
 * and ranked, and decides how to show it."
 *
 * ── ALL THREE AT ONCE, WHICH IS WHAT §2 PROMISES ──────────────────────────
 *
 * "All three from one result object. Switching between them costs nothing and
 * NEVER RECOMPUTES, because no fetch happens. The numbers cannot differ between
 * representations because THERE IS ONLY ONE SET OF NUMBERS."
 *
 * A function that returned the chosen representation and made the caller come
 * back for the others would break both halves of that: the second one would be
 * a fetch, and the two could be computed from different results. So this
 * returns everything, and switching is a client concern with no server in it.
 *
 * NOT ASYNC AND TOUCHING NOTHING. §1 — "Nothing here queries, and nothing here
 * can change a figure."
 */
export function describe(
  answer: Answer,
  options: {
    representation?: renderRepo.Representation;
    /** §4.1's ordering signals, which live on the question rather than the answer. */
    sort?: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }>;
    /** §4.1's population deviation, which the detectors compute and a query does not. */
    deviationComputed?: boolean;
    /** §4.1's edges between rows, which relationship walking produces. */
    edges?: ReadonlyArray<{ from: string; to: string }>;
    directedEdges?: boolean;
  } = {},
): Rendered {
  const flags = flagEngine.flagsOf(answer);
  const shape = shapeOf(
    answer,
    options.sort,
    options.deviationComputed,
    options.edges,
    options.directedEdges,
  );
  const archetype = renderEngine.select(shape);
  const representation = options.representation ?? defaultRepresentation(archetype.chosen);

  return {
    shape,
    archetype,
    prose: proseEngine.proseOf({
      conceptName: answer.concept.name,
      /* Every record matched, where the answer says; the list is only the first page. */
      rowCount: answer.matched ?? answer.entities.length,
      names: answer.entities
        .slice(0, 5)
        .map((entity) => nameOf(entity.fields, (entity as { members?: Array<{ ref: string }> }).members?.[0]?.ref ?? '')),
      aggregates: answer.aggregates,
      flags,
      lineage: answer.lineage,
      ...(answer.changes
        ? {
            changes: {
              ...(answer.changes.fields ? { fields: answer.changes.fields } : {}),
              systems: answer.changes.systems.map((one) => ({
                ...one,
                name: answer.lineage.find((source) => source.connectionId === one.connectionId)?.connectionName ?? 'one system',
              })),
            },
          }
        : {}),
    }),
    flags,
    representation,
  };
}

/**
 * §11 — `archetype_selected`.
 *
 * THE CALLER SAYS WHICH RESULT, AND THIS SAYS WHAT IT IS. The archetype is not
 * taken from the request: `select` decides it from the shape, so what is
 * recorded is what the precedence actually chose. A client that sent its own
 * choice would be recording its agreement with itself, and §4.3's override rate
 * would be measuring the client rather than the precedence.
 */
export async function record(
  actor: Actor,
  input: { resultRef: string; shape: renderEngine.ResultShape },
): Promise<{ id: string; chosen: Archetype; alternatives: Archetype[] }> {
  const selection = renderEngine.select(input.shape);

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const id = await renderRepo.record(db, {
          organisationId: actor.organisationId,
          resultRef: input.resultRef.trim(),
          chosen: selection.chosen,
          alternatives: selection.alternatives,
          signals: selection.signals,
          membershipId: actor.membershipId,
        });

        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'archetype_selected',
          detail: {
            resultRef: input.resultRef.trim(),
            archetype: selection.chosen,
            alternatives: selection.alternatives,
          },
        });

        return { id, chosen: selection.chosen, alternatives: selection.alternatives };
      }),
  );
}

/**
 * Somebody chose something else.
 *
 * THE ONE EVENT WORTH WAITING FOR. Everything else in this table is the
 * precedence agreeing with itself.
 */
export async function override(
  actor: Actor,
  input: { resultRef: string; to: Archetype },
): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const selection = await renderRepo.forResult(db, {
          membershipId: actor.membershipId,
          resultRef: input.resultRef.trim(),
        });

        if (!selection) {
          throw notFound({
            message: 'Nothing was recorded as drawn for that result.',
            code: 'missing.render_selection',
          });
        }

        if (selection.chosen === input.to) {
          /* The constraint would refuse it; saying why is better than a 500
             about a check nobody can read from the outside. */
          throw policy({
            message: 'That is already how it is drawn.',
            code: 'policy.render_not_an_override',
          });
        }

        await renderRepo.markOverridden(db, { id: selection.id, to: input.to });

        /*
         * §11 — "archetype_overridden carries the RESULT STRUCTURE and both
         * archetypes. It is the feedback that tells you precedence is wrong,
         * and THERE IS NO OTHER SOURCE FOR IT."
         *
         * The structure comes off the row rather than from the request. By the
         * time somebody overrides, the result is gone — §1 receives one and §10
         * never stores one — so the signals the choice was made from were kept
         * at selection time, which is the only way this row can be true.
         */
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'archetype_overridden',
          detail: {
            resultRef: input.resultRef.trim(),
            archetype: selection.chosen,
            overriddenTo: input.to,
            signals: await renderRepo.signalsOf(db, selection.id),
          },
        });

        log.info(
          { from: selection.chosen, to: input.to },
          'Archetype overridden — the precedence may be misordered here',
        );
      }),
  );
}

/**
 * How often each archetype is being argued with.
 *
 * THE ONLY REASON THE TABLE EXISTS, so it is worth being able to read without
 * writing SQL by hand. A row with a high override rate is §7.3's precedence
 * being wrong for a shape that keeps coming up.
 */
export async function overrideRates(
  actor: Actor,
): Promise<Array<{ chosen: string; drawn: number; overridden: number; mostlyTo: string | null }>> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () => withTransaction((db) => renderRepo.overrideRates(db)),
  );
}

/* ── §2: the three representations ───────────────────────────────────────── */

/**
 * §2 — "The user's choice persists per view, not globally."
 *
 * §11 AUDITS THE SWITCH, and it is worth asking why. Nothing here is
 * consequential: somebody preferred rows to a picture. But §4.3 makes the
 * override rate the only evidence that the precedence is wrong, and a person
 * who leaves the view entirely and reads the data instead is making the same
 * complaint in a way `render_selections` never sees. The two together are the
 * whole of the feedback.
 */
export async function preferRepresentation(
  actor: Actor,
  input: { viewId: string; representation: renderRepo.Representation },
): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const view = await savedViewRepo.read(db, input.viewId);
        if (!view) {
          throw notFound({ message: 'That view does not exist.', code: 'missing.view' });
        }

        await renderRepo.preferRepresentation(db, {
          organisationId: actor.organisationId,
          viewId: input.viewId,
          membershipId: actor.membershipId,
          representation: input.representation,
        });

        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'representation_switched',
          detail: { viewId: input.viewId, representation: input.representation },
        });
      }),
  );
}

/**
 * §2 — "Prose … Default for: Everything."
 *
 * THE DEFAULT IS APPLIED HERE AND NOT IN THE REPO, so "never chose" and "chose
 * prose" stay different facts. How many people actually switch is the first
 * thing anybody will want to know about this table.
 */
/**
 * §2's "Default for" column, applied where nobody has chosen.
 *
 * "Prose — Everything. View — Relational, ranked or temporal results." So a
 * chain, a hierarchy, a network, a ranking or a series opens as its picture,
 * and everything else as its sentences. The answer window opens where this
 * says; the person's own choice for a saved view overrides it.
 */
export function defaultRepresentation(archetype: string): renderRepo.Representation {
  return ['chain', 'hierarchy', 'network', 'ranking', 'series'].includes(archetype) ? 'view' : 'prose';
}

/**
 * The representation this person chose for a view, or nothing if they never
 * chose — so `describe` can apply §2's default rather than a blanket prose.
 */
export async function preferenceOf(actor: Actor, viewId: string): Promise<renderRepo.Representation | undefined> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => (await renderRepo.preferenceFor(db, { viewId, membershipId: actor.membershipId })) ?? undefined),
  );
}

export async function representationFor(actor: Actor, viewId: string): Promise<renderRepo.Representation> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) =>
        (await renderRepo.preferenceFor(db, { viewId, membershipId: actor.membershipId })) ?? 'prose',
      ),
  );
}

/**
 * §8 — what a view is drawn as on a dashboard tile.
 *
 * Takes the whole selection rather than the archetype alone, because the
 * fallback depends on the shape: §8 offers "Figure or Table", and a result
 * that is one number is better shown as the number than as a one-cell table.
 */
export function tileArchetype(selection: renderEngine.Selection): Archetype {
  return renderEngine.tileArchetype(selection.chosen, selection.signals);
}

/* ── §5 and §6: the interactions worth recording ─────────────────────────── */

/**
 * §5 — "Drill in to the records behind it."
 *
 * ── THIS RECORDS, IT DOES NOT FETCH ───────────────────────────────────────
 *
 * The records behind a figure are reached by asking the query layer for them,
 * with the reader's own permissions, exactly as any other question. §1 — "
 * nothing here queries". What this adds is the trail: §5 makes drilling one of
 * the three moves every archetype supports, and a product that cannot say
 * whether anybody uses it is guessing about its own shape.
 */
export async function recordDrill(
  actor: Actor,
  input: { resultRef: string; fieldPath: string; records: number },
): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction((db) =>
        writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'element_drilled',
          detail: {
            resultRef: input.resultRef.trim(),
            fieldPath: input.fieldPath,
            records: input.records,
          },
        }),
      ),
  );
}

/**
 * §6 — somebody opened a flag.
 *
 * THE RATE IS THE QUESTION. §6 puts three flags on every representation on the
 * grounds that a reader must be able to see them; whether any reader ever does
 * is a different claim, and this is the only thing that could answer it. A
 * disagreement flag nobody opens is either a product working perfectly or a
 * flag nobody notices, and those need opposite responses.
 */
export async function recordFlagOpened(
  actor: Actor,
  input: { resultRef: string; flagKind: flagEngine.FlagKind; subject: string },
): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction((db) =>
        writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'flag_opened',
          detail: {
            resultRef: input.resultRef.trim(),
            flagKind: input.flagKind,
            subject: input.subject,
          },
        }),
      ),
  );
}
