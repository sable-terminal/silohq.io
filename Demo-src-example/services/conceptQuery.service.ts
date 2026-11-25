import { withTransaction } from '../infra/db.infra';
import { connectionCapabilities } from '../engine/read/capabilities.read';
import { runWithTenant } from '../utils/tenantContext.util';
import { bounds, invalid, notFound, refusal } from '../utils/error.util';
import { childLogger } from '../config/logger.config';
import { assertCan, assertCleared, authorityOf } from './authorisation.service';
import { askComplete, readableIds } from './connector.service';
import * as conceptRepo from '../repos/concept.repo';
import * as fieldAliasRepo from '../repos/fieldAlias.repo';
import * as authorityRepo from '../repos/authority.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as conceptService from './concept.service';
import * as mapService from './map.service';
import * as resolutionRepo from '../repos/resolution.repo';
import * as siloRepo from '../repos/silo.repo';
import * as capture from './capture.service';
import { hiddenFields, visibleObjects } from './fieldPolicy.service';
import { env } from '../config/env.config';
import {
  completionQueries,
  planAggregation,
  planConceptQuery,
  planJoin,
  readingsOf,
  vouched,
  type ConceptQuery,
  type Unheld,
} from '../engine/ontology/plan.ontology';
import { resolveEntities } from '../engine/ontology/resolve.ontology';
import { reviewLearned, withLearned } from '../engine/ontology/derive.ontology';
import { writtenAlike, writtenTwoWays, type WrittenTwoWays } from '../engine/ontology/written.ontology';
import { analyse, type AnalysisSpec, type AnalysisTable } from '../engine/ontology/analyse.ontology';
import { log as writeAudit } from './audit.service';
import * as siloKeep from './siloKeep.service';
import * as siloLearned from './siloLearned.service';
import * as siloLearnedRepo from '../repos/siloLearned.repo';
import { stripRows } from '../engine/execution/restrict.execution';
import { matches, type Query } from '../engine/execution/query.execution';
import {
  aggregate,
  certaintyOf,
  coverageOf,
  mergeEntity,
  numeric,
  type Reading,
  orderEntities,
  type Aggregated,
  type Coverage,
  type Merged,
} from '../engine/ontology/merge.ontology';
import { DEFAULT_LIMITS } from '../utils/bounds.util';
import { at, keyOf, refOf } from '../engine/detectors/shared.detector';
import type { Row } from '../engine/detectors/shared.detector';
import type { Actor } from './scope.service';
import type { ContributingObject } from '../models/concept.model';
import { profileOf, type FieldProfile } from '../engine/render/profile.render';

const log = childLogger('concept-query');

/* How many pairs of values written two ways one answer reports. The commonest are what a reader needs. */
const WRITTEN_MOST = 40;
/* How many records of a system without the field are read, by key alone, to count what a filter left unchecked. */
const CENSUS_MOST = 2_000;

/**
 * §7 — asking a question in the words of a concept.
 *
 * ── The thing the ontology was built for and could not do ──────────────────
 *
 * Until now a question named a raw object: rows from the table called
 * `invoices`. The caller had to know each system's table and column names,
 * which is exactly the knowledge concepts exist to make unnecessary — so the
 * whole ontology was reachable through detectors and through nothing anybody
 * queried.
 *
 * This asks for INVOICES. It plans one query per system through the field map,
 * resolves which rows are the same invoice, and merges each field by whatever
 * the organisation has declared about which system is right.
 *
 * ── What comes back is entities, not rows ──────────────────────────────────
 *
 * One per real-world thing, however many systems hold it, with each field
 * saying how it was decided: `declared`, `agreed`, `only`, or `disputed` —
 * and `disputed` carries NO VALUE. That is what makes an answer built on this
 * either correct or absent rather than quietly wrong.
 *
 * ── And it says what it could not account for ──────────────────────────────
 *
 * Every answer carries coverage. A figure computed over two thousand six
 * hundred entities while ninety were disputed is not the answer to the
 * question asked, and the difference has to be visible or somebody will quote
 * the first number.
 */

/** §4.2 — what a figure's `connectionId` resolves to. */
export type SourceLineage = {
  connectionId: string;
  connectionName: string;
  provider: string;
  manifestId: string;
  manifestVersion: number;
};

export type QueriedEntity = {
  /** Which record in which system. Identifiers, never contents. */
  members: Array<{ connectionId: string; ref: string }>;
  fields: Merged[];
  /**
   * Siloes (136) — how this record differs from the earlier copy, where the
   * question asked what changed: the systems it is new in, and each field
   * that is not as it was, with what it held then.
   */
  since?: {
    added: string[];
    fields: Array<{ fieldPath: string; connectionId: string; was: unknown; now: unknown }>;
  };
};

export type ConceptAnswer = {
  concept: { id: string; name: string };
  entities: QueriedEntity[];
  /**
   * §4.2 — the third element of lineage, which every figure was missing.
   *
   * "SOURCE SYSTEM, FIELD PATH, CONNECTOR VERSION." The first two already
   * travelled with every value: a `Reading` names the connection it came from
   * and a `Merged` names the field. The version did not, so a figure could be
   * traced to a system and a field but not to the description of that system
   * the answer was actually read through — which is the one that changes under
   * you when a connector is repaired.
   *
   * ONE ROW PER CONNECTION, NOT A COPY ON EVERY READING. Every reading already
   * carries its `connectionId`, so the version resolves through this without
   * repeating the same two fields across thousands of values.
   */
  lineage: SourceLineage[];
  /** Per field, how many entities it could be decided for. */
  coverage: Record<string, Coverage>;
  /**
   * §7 — totals over ENTITIES, where the question asked for them.
   *
   * Empty unless `aggregate` was named. A figure here is over the entities
   * whose value was decided, and its coverage says what it could not include —
   * because a sum short by ninety disputed invoices looks exactly like one that
   * is not.
   */
  aggregates: Aggregated[];
  /**
   * §7 — where each total was computed, and why.
   *
   * A READER ASKING WHY THIS WAS SLOW, or why it refused, gets the answer here
   * rather than from a support ticket. A concept spanning two systems cannot
   * have its total computed at either and added, because that counts twice
   * every record they both hold — so the rows come back and it is computed
   * after resolution, which is the expensive path and the correct one.
   */
  aggregation: { where: 'source' | 'local'; because?: string };
  /** §2.6 — records with no counterpart, which is a question and not a finding. */
  unmatched: Array<{ connectionId: string; ref: string; missingIn: string }>;
  /**
   * §2.6 — systems whose counterparts could not be checked after a filter.
   *
   * PRESENT ONLY WHEN SOMETHING COULD NOT BE ASKED. A filtered question hides
   * rows that disagree across the threshold, so membership is re-checked by
   * match key — and a source that cannot take an `in` list cannot be
   * re-checked. Nothing is claimed about it, and this says which, because an
   * empty `unmatched` that means "we did not look" must not read like one that
   * means "everything lined up".
   */
  unverified?: {
    /** Systems that could not be asked about a counterpart. */
    connectionIds: string[];
    /**
     * How many entities are missing one of them.
     *
     * THIS IS THE NUMBER THAT MATTERS. Zero means nothing was hidden however
     * many systems could not be asked; anything else is the count of figures
     * whose other side is unknown, and a reader deciding whether to trust the
     * total needs it rather than a list of connection ids.
     */
    entities: number;
  };
  /**
   * Fields the question filtered on, and the systems that do not hold them.
   *
   * PRESENT ONLY WHEN SOME SYSTEM COULD NOT BE ASKED A CONDITION. The answer is
   * the records the systems holding the field vouched for; a record held ONLY
   * in a system named here was never checked, and is not in it. That used to be
   * a refusal — it is a fact about the estate now, stated so the reader knows
   * what "every customer in Farnborough" was counted over.
   *
   * NO COUNT OF WHAT WENT UNCHECKED, because it would take reading every key
   * of every system to learn it — a whole-estate read behind a question that
   * was filtered precisely so as not to need one.
   */
  unheld?: Unheld[];
  /**
   * §2.3 (131) — field matches this answer found no longer hold, and withdrew.
   *
   * THIS ANSWER STILL READ THEM AS ONE FIELD, which is why most of its records
   * show a disagreement there; the next will read two. Said so that the
   * disagreements are understood for what they are — two different things read
   * together — rather than investigated one record at a time.
   */
  unlearned?: Array<{ fieldPath: string; connectionId: string; sourceField: string; compared: number; agreed: number }>;
  /**
   * §2.6 — pairs of values two systems keep giving for one field of the same
   * records, commonest first.
   *
   * `alike` ONES WERE READ AS ONE THING: `UK` and `United Kingdom`, by how they
   * are written. Their records show the fuller spelling and are not disputes.
   *
   * THE REST ARE STILL DISPUTES, on every record — `DE` beside `Germany`. They
   * are here so that a reader, or the model writing the answer up, can say
   * what this cannot: whether it is a code or a fault.
   *
   * WORKED OUT FROM THIS ANSWER AND KEPT NOWHERE.
   */
  written?: Array<
    { fieldPath: string } & WrittenTwoWays & {
        /**
         * Siloes (138) — set where the pair was read as one on the strength of
         * the concept's last copy rather than of this answer alone: how many
         * records of the whole concept held it then.
         */
        known?: number;
      }
  >;
  /**
   * §7 — exact figures over every matched record, one table per thing the
   * question asked to be worked out. Each says what it could not include.
   */
  tables?: AnalysisTable[];
  /**
   * Siloes (135) — present when this was answered from a kept copy: each
   * system, and when its copy was made.
   *
   * "AS OF TWO THIS MORNING" IS PART OF THE FIGURE. A copy is the systems as
   * they were, and a record changed since is not in it. Absent means every
   * system was read live, which is every answer for an organisation that keeps
   * nothing.
   */
  asOf?: Array<{
    connectionId: string;
    syncedAt: string;
    /**
     * Siloes (137) — when the copy was caught up: the records this system
     * marks as added or changed since the copy were read live then and laid
     * over it, `changed` of them, found by the field named in `by`. Absent
     * where it was not: the answer is then as the copy stood.
     */
    freshAt?: string;
    changed?: number;
    by?: string;
  }>;
  /**
   * Siloes (136) — the past moment the question asked about, where it asked
   * about one. `asOf` beside it says when the copies it was read from were
   * actually made, which is never exactly then.
   */
  asAt?: string;
  /**
   * Siloes (136) — what differs between two copies, where the question asked
   * what changed: per system, how many records are new, gone and changed, and
   * which fields changed in how many.
   *
   * COUNTED IN THE STORE, OVER EVERY RECORD OF BOTH COPIES. `entities` are the
   * records that are new or changed and still held; `gone` are the first few
   * of those no longer held, as they last were.
   */
  changes?: {
    /** The fields whose change was asked about. Absent: a change to any field counts, and so does a new record. */
    fields?: string[];
    systems: Array<{
      connectionId: string;
      /** When the two copies compared were made. */
      from: string;
      to: string;
      added: number;
      removed: number;
      changed: number;
      fields: Array<{ fieldPath: string; records: number }>;
    }>;
    gone: Array<{ connectionId: string; ref: string; fields: Array<{ fieldPath: string; value: unknown }> }>;
  };
  /**
   * §4.1 — the other kinds of record this answer was picked by, and how each
   * was reached: how many of them matched, how many of this concept's records
   * they led to, and through which key.
   *
   * A JOIN NOBODY CAN SEE IS A JOIN NOBODY CAN CHECK. "Customers with overdue
   * invoices" rests on which invoices were overdue and how an invoice names
   * its customer; both are here.
   */
  joins?: Array<{
    concept: { id: string; name: string };
    /** True: records that have one. False: records that have none. */
    exists: boolean;
    /** Related records the condition matched. */
    matched: number;
    /** Records of this concept they reached. */
    reached: number;
    /** The key that relates them, in words; null where none of them matched, so nothing was walked. */
    route: string | null;
    /** The field on each record that carries the count or total, where there is one. */
    as?: string;
  }>;
  /**
   * Rows read per system.
   *
   * NO `truncated` FLAG, BECAUSE THERE IS NO TRUNCATED ANSWER. A fetch that
   * hit the ceiling is refused rather than returned with a footnote — see
   * `bounds.util`, whose first line is that a truncated result is the most
   * dangerous thing this system can produce.
   */
  examined: Array<{ connectionId: string; rows: number }>;
  /**
   * How many records the question matched. `entities` is the first `limit` of
   * them; this is all of them, so a reader told "100 contacts" can be told
   * whether that is every contact or the first page of two thousand.
   */
  matched: number;
  /** Each selected field summarised over every matched record, not the page. */
  profile: FieldProfile[];
  /**
   * Whether the fields were read from each system's own field list. Only then
   * is a field that is not here one the system does not have; otherwise it may
   * simply be one the connector does not read.
   */
  fieldsListed: boolean;
};

/**
 * Ask a concept a question.
 *
 * ── The transaction is let go before any system is touched ─────────────────
 *
 * Everything the plan needs is read first — the concept, its field maps, the
 * authorities and the confirmed pairs — and then the database connection is
 * released. Each source query is a real request to somebody's production
 * system, and holding a pooled client across several of them is how a pool of
 * ten runs out under four concurrent questions.
 */
export async function ask(
  actor: Actor,
  input: {
    conceptId: string;
    query: ConceptQuery;
    /**
     * §4.1 — narrow to these records, by the identifier their own system states.
     *
     * WHAT THE SECOND HALF OF A JOIN ASKS BY. A walk ends holding identifiers
     * rather than field values, and a concept can otherwise only be filtered on
     * its own field names.
     */
    refs?: readonly string[];
    /**
     * §4.1 — conditions on WHICH RECORDS, worked out before this is asked.
     *
     * A filter is about a record's own fields. These are about the record
     * itself: whether another kind of record reaches it (`related`), and which
     * systems hold it (`held`). They are applied to resolved entities, once the
     * completion pass has brought each one's counterparts in — so every figure,
     * count and table below is over the records that pass them.
     */
    conditions?: {
      related?: ReadonlyArray<{
        /** The system the walk arrived in: the refs below are that system's identifiers. */
        connectionId: string;
        /** Per record reached: how many related records reached it, and their total where one was asked for. */
        reached: ReadonlyMap<string, { records: number; value: number | null }>;
        exists: boolean;
        /** The name of the field each kept record carries the count or total in. */
        as?: string;
        figure?: 'count' | 'sum';
      }>;
      /** By the names people gave their systems: held there, or not held there. */
      held?: ReadonlyArray<{ system: string; present: boolean }>;
    };
    /** §7 — what to work out over every matched record. */
    analyse?: readonly AnalysisSpec[];
    /**
     * Siloes (136) — as the records stood at a past moment: read from the copy
     * of each system made nearest it, and refused where there is none.
     */
    asAt?: Date;
    /**
     * Siloes (136) — only the records that differ from the copy made nearest a
     * past moment: new or changed, or — where `fields` names some — those in
     * which one of them is not as it was.
     */
    changed?: { since: Date; fields?: readonly string[] };
  },
): Promise<ConceptAnswer> {
  /* Fields Silo works out for each record. They are not the concept's, so the planner is not asked about them. */
  const computedNames = new Set((input.conditions?.related ?? []).flatMap((one) => (one.as ? [one.as] : [])));

  const plan = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'query.run');

        const stored = await conceptRepo.read(db, input.conceptId);
        if (!stored || stored.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        /*
         * FIELD POLICY, BEFORE A PLAN EXISTS. A concept field whose column is
         * hidden from this reader in a system is not mapped there as far as this
         * question knows: it is not selected, cannot be filtered on, and is not
         * a reading. The gate every source query passes would refuse it anyway;
         * leaving it to refuse there would fail every question that selects all.
         */
        const hidden = await hiddenFields(db, actor, stored.objects.map((one) => one.connectionId));

        /*
         * §2.3 (131) — WHAT ANSWERS HAVE TAUGHT, APPLIED TO THE READING. Where
         * one was written up and two systems' fields turned out to hold the
         * same thing, both are read under one name from here on. The stored
         * concept is not touched; this is how this question reads it.
         *
         * BEFORE FIELD POLICY, which works by column: a column hidden from this
         * reader is hidden under every name it is read by.
         */
        const learnedRows = await fieldAliasRepo.learnedFor(db, stored.objects.map((one) => one.connectionId));
        const read = withLearned({ objects: stored.objects, learned: learnedRows });
        const concept = { ...stored, objects: visibleObjects(read.objects, hidden) };

        /* §2.5 — answering a question about a marked concept reveals that its
           records exist, which is what a marking withholds. */
        await assertCleared(db, authority, {
          type: 'concept',
          id: concept.id,
          conceptIds: [concept.id],
        });

        const readable = await readableIds(
          db,
          actor,
          concept.objects.map((object) => object.connectionId),
        );

        /*
         * A CONCEPT SPANNING A SYSTEM SOMEBODY CANNOT REACH IS REFUSED, not
         * quietly answered from the rest. Dropping the system would produce an
         * answer that looks complete and is short by whatever that system
         * holds — and the reader has no way to tell.
         */
        const unreachable = concept.objects.filter((one) => !readable.has(one.connectionId));
        if (unreachable.length > 0) {
          throw refusal({
            message:
              `${concept.name} spans a system you cannot reach, so any answer would be ` +
              'missing part of it without saying so.',
            code: 'refusal.unreachable_source',
            detail: { connectionIds: unreachable.map((one) => one.connectionId) },
          });
        }

        /*
         * §7.3 — WHAT EACH SOURCE COLUMN ACTUALLY HOLDS. A period resolves to
         * instants; a DATE column has no zone, so comparing the two is wrong by
         * up to a day for any organisation not on UTC. The type differs per
         * system for the same concept field, so the plan decides it per source.
         */
        const manifests = await connectorRepo.load(
          db,
          concept.objects.map((one) => one.connectionId),
        );

        const fieldTypes = new Map<string, Map<string, string>>(
          manifests.map((connection) => [
            connection.connectionId,
            new Map(
              connection.manifest.objects.flatMap((object) =>
                object.fields.map((field) => [field.name, field.type] as const),
              ),
            ),
          ]),
        );

        const organisation = await organisationRepo.findById(db, actor.organisationId);

        const planned = planConceptQuery({
          objects: concept.objects,
          request: {
            ...input.query,
            /*
             * A FIELD A TABLE IS KEYED OR MEASURED BY IS A FIELD BEING READ,
             * exactly as one that is totalled or sorted on is. Left out, every
             * group would be "(none)" and every figure nothing — over records
             * that hold both. (An empty select already means every field.)
             */
            select:
              input.query.select.length === 0
                ? []
                : [
                    ...new Set([
                      ...input.query.select,
                      ...(input.analyse ?? []).flatMap((one) => [
                        ...(one.kind === 'breakdown' ? [one.by] : one.kind === 'trend' ? [one.time] : one.by),
                        ...(one.measure.field ? [one.measure.field] : []),
                      ]),
                      /* A field whose change is being asked about is one the answer shows: what it holds, and what it held. */
                      ...(input.changed?.fields ?? []),
                    ]),
                  ].filter((field) => !computedNames.has(field)),
            sort: input.query.sort.filter((one) => !computedNames.has(one.field)),
            ...(input.query.aggregate ? { aggregate: input.query.aggregate.filter((one) => !computedNames.has(one.field)) } : {}),
          },
          maxRows: DEFAULT_LIMITS.maxRows,
          fieldTypes,
          calendar: organisation?.calendar ?? { timeZone: 'UTC' },
          refs: input.refs,
          superseded: Object.keys(read.superseded),
        });

        if (!planned.ok) {
          throw invalid({
            message: planned.refusal.reason,
            code: planned.refusal.code,
            detail: planned.refusal.detail,
          });
        }

        /*
         * §7 — WHERE THE TOTALS CAN HONESTLY BE COMPUTED. The manifest has
         * declared `capabilities.aggregates` since it existed and nothing has
         * ever read it; this is the first thing that does.
         */
        const loaded = manifests;

        const aggregation = planAggregation({
          objects: concept.objects,
          operations: input.query.aggregate ?? [],
          capabilities: new Map(
            loaded.map((one) => [
              one.connectionId,
              { aggregates: connectionCapabilities(one.manifest).aggregates },
            ]),
          ),
        });

        /*
         * WHICH SOURCES CAN BE ASKED ABOUT A COUNTERPART, and how many at a
         * time. A source that does not declare `in` is left OUT of this map
         * rather than given a zero — zero is the manifest's way of saying "no
         * cap", so the two must not be confused.
         */
        const batchSizes = new Map<string, number | null>(
          loaded
            .filter((one) => connectionCapabilities(one.manifest).filters.includes('in'))
            .map((one) => [one.connectionId, connectionCapabilities(one.manifest).maxFilterValues || null]),
        );

        return {
          concept,
          planned,
          aggregation,
          batchSizes,
          /* §4.2 — read here because the manifests are already loaded, and
             loading them twice would let the two copies disagree. */
          lineage: manifests.map((connection) => ({
            connectionId: connection.connectionId,
            connectionName: connection.name,
            provider: connection.provider,
            manifestId: connection.manifestId,
            manifestVersion: connection.manifestVersion,
          })),
          /* Whether every system's own list of fields was read, so "it has no such field" can be said at all. */
          fieldsListed: concept.objects.every(
            (object) =>
              manifests
                .find((connection) => connection.connectionId === object.connectionId)
                ?.manifest.objects.find((one) => one.name === object.objectName)?.fieldList !== undefined,
          ),
          authorities: await authorityRepo.live(db, concept.id),
          aliases: await resolutionRepo.confirmedFor(db, concept.id),
          /*
           * SS10.5 -- WHETHER A SILO WANTS THIS CONCEPT, ASKED ONCE, IN THE
           * TRANSACTION THAT IS ALREADY OPEN. Null in every deployment where
           * storage is off, compiled out, or where nobody nominated this
           * concept -- which is the default and stays the default.
           */
          captured: env.SILOES_AVAILABLE ? await siloRepo.capturedFields(db, concept.id) : null,
          superseded: read.superseded,
          /*
           * Siloes (135) — the copies this question may be answered from: every
           * system the concept spans, kept and finished, or none of them. Null
           * for every organisation that keeps nothing, which is nearly all.
           */
          ...(await copiesFor(db, {
            name: concept.name,
            objects: stored.objects,
            conceptId: stored.id,
            manifests,
            storeable: siloKeep.canFilter(planned.sources.flatMap((one) => one.query.filters)),
            ...(input.asAt ? { asAt: input.asAt } : {}),
            ...(input.changed ? { since: input.changed.since } : {}),
          })),
          /*
           * Siloes (138) — WHICH VALUES THE LAST COPY SHOWED TO BE ONE THING
           * WRITTEN TWO WAYS, where there is one and two systems to differ.
           * Looked for only where the concept is kept, so nothing is looked
           * for by an organisation that keeps nothing.
           */
          known:
            env.SILOES_AVAILABLE && concept.objects.length > 1
              ? ((await siloLearnedRepo.forConcepts(db, [stored.id])).find((one) => one.kind === 'values') ?? null)
              : null,
          hidden,
          /* The learned matches this reading rests on, with the evidence kept beside each, to be looked at again below. */
          applied: read.applied.flatMap((one) => {
            const row = learnedRows.find(
              (alias) => alias.connectionId === one.connectionId && alias.objectName === one.objectName && alias.sourceField === one.sourceField,
            );
            return row ? [{ id: row.id, connectionId: one.connectionId, objectName: one.objectName, sourceField: one.sourceField, fieldPath: one.canonicalField, compared: row.compared, agreed: row.agreed }] : [];
          }),
        };
      }),
  );

  /*
   * ── FROM THE COPY, WHERE THE WHOLE CONCEPT IS KEPT; LIVE OTHERWISE ───────
   *
   * One way to read a system, used by every pass below, so a question is
   * answered entirely from copies or entirely live and never from a mixture
   * of two moments. A copy holds what whoever had it made could see; a field
   * hidden from THIS reader is taken off each row here, as a live read would
   * never have fetched it.
   */
  /* Siloes (137) — what the systems mark as changed since the copies were made, read live below, once. */
  let fresh: Awaited<ReturnType<typeof changedSince>> = null;

  const fetch = async (connectionId: string, query: Query): Promise<Row[]> => {
    const copy = plan.kept?.get(connectionId);
    if (!copy) {
      const answered = await askComplete({ actor, connectionIds: [connectionId], query });
      return answered.flatMap((one) => one.result?.rows ?? []);
    }

    /*
     * A RECORD CHANGED SINCE THE COPY IS READ AS IT IS NOW. Its copied row is
     * left out whatever it says — it may have matched the question then and
     * not now — and its live row is kept if it matches, by the same test a
     * source applies. So a record that moved out of the answer leaves it, and
     * one that moved in joins it.
     *
     * LEFT OUT IN THE STORE, NOT AFTERWARDS. Where only a page is fetched —
     * the ten largest of five million — a stale row dropped from the page
     * afterwards would leave it one short of a record that was never fetched.
     */
    const changed = fresh?.rows.get(connectionId);
    const identifier = plan.concept.objects.find((one) => one.connectionId === connectionId)!.identifierField;
    const overlaid = changed && changed.size > 0;

    let rows = await siloKeep.read(actor.organisationId, copy, {
      filters: (overlaid ? [...query.filters, { field: identifier, op: 'nin', value: [...changed.keys()] }] : query.filters) as never,
      limit: query.limit,
      sort: query.sort,
    });

    if (overlaid) rows = [...rows, ...[...changed.values()].filter((row) => query.filters.every((filter) => matches(row, filter)))];

    return stripRows(rows, plan.hidden.get(connectionId) ?? new Set<string>());
  };

  /*
   * ── WHAT CHANGED, WORKED OUT WHERE THE COPIES ARE (136) ──────────────────
   *
   * The two copies of each system are compared in the store: how many records
   * are new, gone and changed, and which fields changed in how many. That is a
   * row back per system however large the table. The records that are new or
   * changed are then what this question is ABOUT — each system is asked for
   * those and no others, so everything below (resolution, the totals, the
   * tables) is over the records that changed.
   *
   * THE QUESTION'S OWN CONDITIONS ARE APPLIED IN THE COMPARISON, to a record as
   * it is now, or as it last was where it has gone. "Open deals over ten
   * thousand that changed stage" compares only those.
   *
   * ONLY FIELDS THIS READER MAY SEE COUNT. A change in a column hidden from
   * them is not a change they are told of, by a count or by a record being here.
   *
   * MORE THAN CAN BE LISTED IS REFUSED WITH THE COUNTS, not listed in part: a
   * page of what changed would be totalled and read as all of it.
   */
  let changes: ConceptAnswer['changes'];
  const differs = new Map<string, Map<string, boolean>>();

  if (input.changed && plan.before && plan.kept) {
    const watched = [...(input.changed.fields ?? [])];
    const systems: NonNullable<ConceptAnswer['changes']>['systems'] = [];
    const lost: Array<{ connectionId: string; ref: string }> = [];

    for (const source of plan.planned.sources) {
      const object = plan.concept.objects.find((one) => one.connectionId === source.connectionId)!;
      const later = plan.kept.get(source.connectionId)!;
      const earlier = plan.before.get(source.connectionId)!;
      const unseen = plan.hidden.get(source.connectionId) ?? new Set<string>();

      /* This system's column for each of the concept's fields, and back: the names a reader knows a field by. */
      const named = new Map<string, string>();
      for (const [fieldPath, column] of Object.entries(object.fieldMap)) {
        if (!(fieldPath in plan.superseded) && !named.has(column)) named.set(column, fieldPath);
      }

      const watch =
        watched.length > 0
          ? [...new Set(watched.flatMap((fieldPath) => (object.fieldMap[fieldPath] ? [object.fieldMap[fieldPath]!] : [])))].filter((column) => !unseen.has(column))
          : later.fields.map((field) => field.name).filter((column) => !unseen.has(column));

      /* A system that holds none of the fields asked about has no record in which one of them changed. */
      if (watch.length === 0) {
        source.query = { ...source.query, filters: [{ field: object.identifierField, op: 'in', value: [] }] };
        source.asked = true;
        differs.set(source.connectionId, new Map());
        continue;
      }

      const compared = {
        earlier,
        later,
        identifier: object.identifierField,
        watch,
        /* A system not asked the question's conditions holds none of their fields: every record of it is compared. */
        filters: (source.asked ? source.query.filters : []) as never,
      };

      const counted = await siloKeep.difference(actor.organisationId, compared);
      const listed = watched.length > 0 ? counted.changed : counted.added + counted.changed;
      const fields = counted.fields
        .map((one) => ({ fieldPath: named.get(one.field) ?? one.field, records: one.records }))
        .sort((a, b) => b.records - a.records || (a.fieldPath < b.fieldPath ? -1 : 1));

      if (listed > siloKeep.LIMITS.changed) {
        const most = fields.slice(0, 3).map((one) => `${one.fieldPath} (${one.records.toLocaleString('en-GB')})`);
        throw bounds({
          message:
            `${listed.toLocaleString('en-GB')} ${plan.concept.name} records differ between the copy of ${dayOf(earlier.at)} and the copy of ${dayOf(later.at)} — ` +
            `${counted.added.toLocaleString('en-GB')} new, ${counted.changed.toLocaleString('en-GB')} changed, ${counted.removed.toLocaleString('en-GB')} gone — ` +
            'which is more than one answer can list. ' +
            (most.length > 0 ? `The fields that changed in most of them: ${most.join(', ')}. ` : '') +
            'Ask what changed in one field, or narrow the question.',
          code: 'bounds.changed',
          detail: { connectionId: source.connectionId, added: counted.added, changed: counted.changed, removed: counted.removed },
        });
      }

      const held = await siloKeep.differing(actor.organisationId, { ...compared, which: watched.length > 0 ? 'changed' : 'held', limit: siloKeep.LIMITS.changed + 1 });
      if (watched.length === 0 && counted.removed > 0) {
        const gone = await siloKeep.differing(actor.organisationId, { ...compared, which: 'gone', limit: siloKeep.LIMITS.gone });
        lost.push(...gone.map((one) => ({ connectionId: source.connectionId, ref: one.ref })));
      }

      differs.set(source.connectionId, new Map(held.map((one) => [one.ref, one.added])));
      systems.push({
        connectionId: source.connectionId,
        from: earlier.at.toISOString(),
        to: later.at.toISOString(),
        added: counted.added,
        removed: counted.removed,
        changed: counted.changed,
        fields: fields.slice(0, 20),
      });

      /* From here this system is asked for the records that differ, and no others. */
      source.query = {
        ...source.query,
        filters: [...(source.asked ? source.query.filters : []), { field: object.identifierField, op: 'in', value: held.map((one) => one.ref) }],
      };
      source.asked = true;
    }

    /* The records that have gone, as they last were: read from the earlier copy, the only place they still are. */
    const gone: NonNullable<ConceptAnswer['changes']>['gone'] = [];
    for (const source of plan.planned.sources) {
      const refs = lost.filter((one) => one.connectionId === source.connectionId).map((one) => one.ref);
      if (refs.length === 0) continue;

      const object = plan.concept.objects.find((one) => one.connectionId === source.connectionId)!;
      const rows = stripRows(
        await siloKeep.read(actor.organisationId, plan.before.get(source.connectionId)!, {
          filters: [{ field: object.identifierField, op: 'in', value: refs }],
          limit: refs.length + 1,
        }),
        plan.hidden.get(source.connectionId) ?? new Set<string>(),
      );

      for (const row of rows) {
        gone.push({
          connectionId: source.connectionId,
          ref: refOf(at(row, object.identifierField)),
          fields: readingsOf(source, row).filter((one) => one.value !== null && one.value !== undefined && one.value !== ''),
        });
      }
    }

    changes = { ...(watched.length > 0 ? { fields: watched } : {}), systems, gone };
  }

  /*
   * ── A COPY TOO LARGE TO BRING BACK IS ADDED UP WHERE IT IS ───────────────
   *
   * Up to `rowsInMemory` a copy is read and worked on here, exactly as live
   * rows are. Past it — five million invoices — the count, the totals and the
   * tables are worked out IN the store, each a handful of rows back, and only
   * a page of records is fetched to be listed, in the order asked for.
   *
   * ONE SYSTEM, AND NO CONDITIONS BY OTHER RECORDS. A concept two systems hold
   * has to be resolved before anything is counted, and that is not done in the
   * store yet: past the bound such a question is refused, as it always was.
   */
  const lone =
    plan.kept && plan.concept.objects.length === 1 && !input.conditions && !input.refs?.length ? plan.planned.sources[0]! : null;

  /*
   * ── CAUGHT UP WITH WHAT HAS CHANGED SINCE THE COPY (137) ─────────────────
   *
   * Where every system of the concept has shown which field it marks change
   * with, the records marked since each copy are read live — a small read,
   * however large the table — and laid over the copy: by `fetch` for the rows
   * a question works on, and by `figuresInStore` for the figures of a copy too
   * large to bring back. Five million invoices, exact, as of a moment ago.
   *
   * NOT A QUESTION ABOUT THE PAST, which is answered as things stood.
   */
  if (plan.kept && !input.asAt && !input.changed) {
    fresh = await changedSince(actor, plan.kept, plan.concept.objects);
  }

  const loneCopy = lone ? plan.kept!.get(lone.connectionId)! : null;
  const loneObject = plan.concept.objects[0]!;
  /*
   * A TABLE GROUPED BY A DATE AS IT IS WRITTEN CANNOT HAVE LIVE RECORDS ADDED
   * TO IT: a store and a system write the same instant differently, and the
   * record would land in a group of its own beside the one it belongs to.
   * (By month or by year it can: the start of both spellings is the same.)
   * Such a question's figures are worked out as the copy stood, and it says so.
   */
  const addable =
    !loneCopy ||
    (input.analyse ?? []).every((spec) =>
      (spec.kind === 'breakdown' ? [spec.by] : spec.kind === 'crosstab' ? [...spec.by] : []).every((fieldPath) => {
        const type = loneCopy.fields.find((field) => field.name === loneObject.fieldMap[fieldPath])?.type;
        return type !== 'date' && type !== 'datetime' && type !== 'json';
      }),
    );

  const inStore = lone
    ? await figuresInStore({
        organisationId: actor.organisationId,
        copy: loneCopy!,
        fieldMap: loneObject.fieldMap,
        filters: lone.query.filters,
        aggregate: input.query.aggregate ?? [],
        analyse: input.analyse ?? [],
        ...(fresh && addable ? { changed: { identifier: loneObject.identifierField, rows: fresh.rows.get(lone.connectionId) ?? new Map<string, Row>() } } : {}),
      })
    : null;

  /* Too large to bring back, and its tables cannot take live records: as the copy stood, all of it, the page included. */
  if (inStore && fresh && !addable) fresh = null;

  const sources: Array<{ connectionId: string; object: (typeof plan.concept.objects)[number]; rows: Row[] }> = [];
  const examined: ConceptAnswer['examined'] = [];

  for (const source of plan.planned.sources) {
    const object = plan.concept.objects.find((one) => one.connectionId === source.connectionId)!;

    /*
     * A SYSTEM THAT HOLDS NONE OF THE FILTERED FIELDS IS NOT ASKED WHICH RECORDS
     * MATCH. It cannot say, and asking would move its whole table here to be
     * thrown away. It is still a source: the completion pass below fetches its
     * half of every record the others vouched for, by match key.
     */
    if (!source.asked) {
      sources.push({ connectionId: source.connectionId, object, rows: [] });
      examined.push({ connectionId: source.connectionId, rows: 0 });
      continue;
    }

    /*
     * `askComplete`, NOT `ask`. An answer computed from one of two systems is
     * not a smaller answer — every row in the other reads as unmatched, and it
     * looks exactly like a customer whose data genuinely does not line up.
     */
    /* A kept copy has no connector's ceiling over it, so more of it may be read at once — or, past that, a page of it. */
    const query = !plan.kept
      ? source.query
      : inStore
        ? { ...source.query, limit: Math.min(Math.max(input.query.limit, 1), siloKeep.LIMITS.page) }
        : { ...source.query, limit: siloKeep.LIMITS.rowsInMemory };
    const rows = await fetch(source.connectionId, query);

    /*
     * ── A FULL PAGE IS A REFUSAL, NOT A FOOTNOTE ─────────────────────────────
     *
     * `bounds.util` opens by saying a truncated result is the most dangerous
     * thing this system can return: it looks like an answer, somebody acts on
     * the number, and nothing about it says it is wrong. The first version of
     * this returned a `truncated` flag beside a full set of entities and
     * coverage figures computed over a WINDOW — presented exactly like figures
     * computed over a population.
     *
     * It is worse here than in a plain query, because resolution compounds it:
     * the fifty thousandth invoice in one system may be the counterpart of the
     * first in another, so a cut page does not lose the tail of the answer, it
     * loses entities from anywhere in it and turns others into false
     * `unmatched` rows.
     *
     * THE FILTER IS THE MECHANISM. A question this large has an answer once it
     * is narrowed, and the refusal says so.
     */
    /* A page of a copy whose figures were worked out in the store is meant to be full. */
    if (!inStore && rows.length >= query.limit) {
      throw bounds({
        message:
          `That question reads more of ${object.objectName} than one answer may cover. ` +
          'Narrow it with a filter, or ask about a shorter period.',
        code: 'bounds.rows',
        detail: { connectionId: source.connectionId, limit: query.limit },
      });
    }

    sources.push({ connectionId: source.connectionId, object, rows });
    examined.push({ connectionId: source.connectionId, rows: rows.length });

    /*
     * -- SS10.5: capture rides on this answer ------------------------------
     *
     * QUEUED, NEVER INLINE. `observe` appends to an array and returns; it opens
     * no transaction, makes no request and cannot throw for any reason this
     * caller could cause. The writing happens on the drain, long after the
     * answer has gone back, because a query must not wait on a write to storage
     * and a capture failure must never fail somebody's question.
     *
     * ONLY THE NOMINATED FIELDS, AND ONLY THE ONES THIS ANSWER CONTAINED.
     * `reading` is the plan's own field-to-column map, so nothing is re-derived
     * here and nothing can be re-derived differently. A nominated field the
     * question did not select is simply not in it -- which is the sampling
     * property stated on the queue: an entity nobody asks about is never
     * captured.
     */
    /* Never from a copy: capture records what a system held WHEN IT WAS ASKED, and a copy is what it held when it was copied. */
    if (plan.captured && !plan.kept) {
      /*
       * A FIELD NOMINATED UNDER A NAME SINCE SUPERSEDED IS STILL NOMINATED. It
       * is read under the shared name now, and kept under the one somebody
       * nominated — a silo's history must not break off because an answer
       * taught Silo what else the field is called.
       */
      const nominatedAs = new Map(plan.captured.fields.map((field) => [plan.superseded[field] ?? field, field]));

      capture.observe({
        organisationId: actor.organisationId,
        siloId: plan.captured.siloId,
        conceptId: plan.concept.id,
        /*
         * A GENERATOR, NOT AN ARRAY. Built eagerly this was every row of a full
         * page times every nominated field, constructed inside the request
         * before `observe` looked at any of it — for readings a full queue then
         * threw away. `observe` pulls one at a time and stops when it is full.
         */
        readings: (function* () {
          for (const row of rows) {
            const entityRef = refOf(at(row, object.identifierField));
            if (entityRef === '') continue;

            for (const reading of readingsOf(source, row)) {
              const nominated = nominatedAs.get(reading.fieldPath);
              if (nominated === undefined) continue;

              yield {
                connectionId: source.connectionId,
                entityRef,
                fieldPath: nominated,
                /* TEXT, BECAUSE A TRANSITION IS COMPARED AND SHOWN, NEVER
                   SUMMED. Typing the column would make the table a copy of the
                   source's schema, which is the thing it is deliberately not. */
                value:
                  reading.value === null || reading.value === undefined
                    ? null
                    : String(reading.value),
              };
            }
          }
        })(),
      });
    }
  }

  const aliases = plan.aliases.map((alias) => ({
    connectionA: alias.connectionA,
    valueRefA: alias.valueRefA,
    connectionB: alias.connectionB,
    valueRefB: alias.valueRefB,
  }));

  let resolution = resolveEntities({ sources, aliases });

  /*
   * ── ONLY WHAT EVERY CONDITION WAS VOUCHED FOR ────────────────────────────
   *
   * Where some system does not hold a filtered field, the systems were sent
   * different conditions and a returned row has passed only its own system's.
   * `vouched` keeps the records whose systems cover every condition between
   * them; the rows of the rest are dropped HERE, before the completion pass,
   * so nothing goes back to anybody's system for a record that is not in the
   * answer.
   *
   * Nothing happens where every system holds every filtered field: each row
   * returned has passed everything, which is the question this always asked.
   */
  if (plan.planned.unheld.length > 0) {
    const kept = vouched({
      entities: resolution.entities,
      sources: plan.planned.sources,
      filtered: input.query.where.map((one) => one.field),
    });

    if (kept.length !== resolution.entities.length) {
      const keep = new Set(
        kept.flatMap((entity) => entity.members.map((member) => `${member.connectionId}\u0000${member.ref}`)),
      );

      for (const source of sources) {
        source.rows = source.rows.filter((row) =>
          keep.has(`${source.connectionId}\u0000${String(at(row, source.object.identifierField) ?? '').trim()}`),
        );
      }

      resolution = resolveEntities({ sources, aliases });
    }
  }

  /*
   * ── THE SECOND PASS, AND ONLY WHERE A FILTER MADE ONE NECESSARY ──────────
   *
   * A filter is pushed to every system that holds its field, so a row that
   * disagrees ACROSS the threshold never comes back — and the disagreement
   * becomes a decided value,
   * `disputed: 0`, and a false `unmatched` pointing at a record that is sitting
   * there disagreeing. The filter did not narrow the answer, it changed it.
   *
   * So the entities that came back from fewer systems than the concept spans
   * are asked about again BY MATCH KEY, with the filter removed. An unfiltered
   * question pays none of this: it already saw every row.
   */
  let unverified: string[] = [];
  let unverifiedEntities = 0;

  /*
   * NARROWED BY REFS COUNTS AS FILTERED. A join arrives holding identifiers
   * from ONE system, so the others answer nothing for them — which is exactly
   * the shape that turns a disagreement into a decided value, and exactly what
   * the completion pass exists to undo.
   */
  const narrowed = input.query.where.length > 0 || (input.refs?.length ?? 0) > 0 || Boolean(changes);

  if (narrowed && plan.concept.objects.length > 1) {
    const completion = completionQueries({
      objects: plan.concept.objects,
      selected: plan.planned.selected,
      entities: resolution.entities,
      /* A kept copy can always be asked by key, whatever the system it was copied from can do. */
      batchSizes: plan.kept ? new Map(plan.concept.objects.map((object) => [object.connectionId, null])) : plan.batchSizes,
      aliases,
      maxRows: DEFAULT_LIMITS.maxRows,
    });

    unverified = completion.unverified;

    /*
     * ── A COMPLETION IS A FOLLOW-UP, NOT A CRAWL ─────────────────────────────
     *
     * The first pass reads up to `maxRows` from each system in ONE request.
     * Going back for counterparts turns that into one request per batch, and a
     * question matching forty thousand entities against a source declaring a
     * hundred values per `in` becomes eight hundred sequential requests at one
     * production system. Slow for us; indistinguishable from an attack to them.
     */
    if (completion.queries.length > DEFAULT_LIMITS.maxCompletionRequests) {
      throw bounds({
        message:
          'Answering that question needs counterparts checked one batch at a time, and it would ' +
          'take more requests of your systems than one answer may make. Narrow it with another ' +
          'filter, or ask about a shorter period.',
        code: 'bounds.completion_requests',
        detail: {
          requests: completion.queries.length,
          limit: DEFAULT_LIMITS.maxCompletionRequests,
        },
      });
    }

    /*
     * ── ONLY WHAT WAS ACTUALLY ASKED FOR ─────────────────────────────────────
     *
     * A multi-column match key is asked for as a cross-product, because two
     * `in` lists cannot express "these pairs". So a source can return rows that
     * belong to no entity here — (ACME, 2) when the question wanted (ACME, 1)
     * and (BETA, 2) — and appending those would ADD entities the caller's
     * filter excluded, inflating the population every aggregate is computed
     * over. The completion exists to complete entities, never to find new ones.
     *
     * FILTERED ON WHAT WAS ASKED, NOT ON THE ENTITY KEYS. An entity linked by a
     * CONFIRMED ALIAS is keyed by a handle rather than by a match key — the two
     * spellings have nothing in common, which is why a person had to say so —
     * so comparing against entity keys threw away the very counterpart this
     * pass had just gone and fetched.
     */
    for (const request of completion.queries) {
      const found = await fetch(request.connectionId, request.query);

      /* Bounded like the first pass. A completion that fills its page has not
         answered the question either. */
      if (found.length >= request.query.limit) {
        throw bounds({
          message:
            'That question needs more counterpart records than one answer may cover. ' +
            'Narrow it with a filter, or ask about a shorter period.',
          code: 'bounds.rows',
          detail: { connectionId: request.connectionId, limit: request.query.limit },
        });
      }

      const source = sources.find((one) => one.connectionId === request.connectionId);
      if (!source) continue;

      /*
       * DEDUPED BY IDENTIFIER. A counterpart may already be present — another
       * entity's batch can return the same row — and resolution counts a
       * duplicate ref as that system's own duplication finding rather than as
       * two entities, so leaving them in would misreport that system.
       */
      const seen = new Set(source.rows.map((row) => String(row[source.object.identifierField])));

      const added = found.filter((row) => {
        const ref = String(row[source.object.identifierField]);
        const key = keyOf(row, source.object.matchKeys);

        const asked =
          (key !== null && completion.wantedKeys.has(key)) ||
          Boolean(completion.wantedRefs.get(request.connectionId)?.has(ref));

        return asked && !seen.has(ref);
      });

      source.rows.push(...added);

      const count = examined.find((one) => one.connectionId === request.connectionId);
      if (count) count.rows += added.length;
    }

    /* Re-resolved over the completed rows, so a disagreement that the filter
       hid is a disagreement again. */
    if (completion.queries.length > 0) {
      resolution = resolveEntities({ sources, aliases });
    }

    /*
     * ── AND IT SAYS HOW MUCH IT COULD NOT CHECK ──────────────────────────────
     *
     * Suppressing the `unmatched` claim was not enough on its own. An entity
     * still missing a system nobody could ask comes back with a value and a
     * coverage describing only what was SEEN — both true, and together they
     * read as complete.
     *
     * NOT A REFUSAL, DELIBERATELY. A record existing in one system and not
     * another is the ordinary state of an estate, so refusing every filtered
     * question over a source that cannot take an `in` list would refuse most of
     * them, for a dispute that usually is not there. The proportionate answer is
     * to say exactly how many entities it could not check, and let the reader
     * weigh it.
     */
    unverifiedEntities = resolution.entities.filter((entity) => {
      const holders = new Set(entity.members.map((member) => member.connectionId));
      return unverified.some((connectionId) => !holders.has(connectionId));
    }).length;
  }

  /*
   * ── WHICH RECORDS, BY WHAT REACHES THEM AND WHERE THEY ARE HELD ──────────
   *
   * Applied HERE, after the completion pass, because both conditions are about
   * the whole record: an invoice reaches a customer through the ledger's half
   * of it, and "not in the CRM" can only be said of a record whose CRM half
   * was looked for. And before anything is merged or counted, so the figures
   * are over the records that pass.
   */
  if (input.conditions) {
    const held = (input.conditions.held ?? []).map((one) => ({
      present: one.present,
      connectionIds: plan.lineage.filter((source) => source.connectionName === one.system).map((source) => source.connectionId),
    }));

    const kept = resolution.entities.filter((entity) => {
      const systems = new Set(entity.members.map((member) => member.connectionId));
      if (held.some((one) => one.connectionIds.some((id) => systems.has(id)) !== one.present)) return false;

      return (input.conditions!.related ?? []).every(
        (one) => entity.members.some((member) => member.connectionId === one.connectionId && one.reached.has(member.ref)) === one.exists,
      );
    });

    if (kept.length !== resolution.entities.length) {
      const keep = new Set(kept.flatMap((entity) => entity.members.map((member) => `${member.connectionId}\u0000${member.ref}`)));
      for (const source of sources) {
        source.rows = source.rows.filter((row) =>
          keep.has(`${source.connectionId}\u0000${String(at(row, source.object.identifierField) ?? '').trim()}`),
        );
      }
      resolution = resolveEntities({ sources, aliases });
    }
  }

  /*
   * A FIGURE CARRIES ITS OWN DOUBT. `coverage` is the field whose job is to say
   * what the figures beside it could not account for, so an entity whose other
   * side could not be looked at belongs here rather than only at the top of the
   * answer — where it sat next to a sum computed as though nothing were
   * missing, contradicted by that sum's own `disputed: 0`.
   */
  const withDoubt = (of: Coverage): Coverage =>
    unverifiedEntities > 0 ? { ...of, unverified: unverifiedEntities } : of;

  const readingFor = new Map(plan.planned.sources.map((one) => [one.connectionId, one]));
  const authorities = plan.authorities.map((one) => ({
    conceptId: one.conceptId,
    fieldPath: one.fieldPath,
    connectionId: one.connectionId,
  }));

  /*
   * ── MERGED OVER THE POPULATION, SLICED ONLY FOR THE LIST ─────────────────
   *
   * The first version sliced to `limit` BEFORE merging, so every figure below
   * was computed over a page: a sum with the default limit of a hundred, over
   * an estate of two thousand six hundred invoices, returned the total of an
   * arbitrary hundred — and the coverage beside it said `counted: 100,
   * disputed: 0`, which reads as complete.
   *
   * That is the precise failure this whole layer is arranged against, and the
   * limit was doing it quietly. It bounds the ENTITY LIST a caller reads; it
   * has never been a statement about how much of the estate the question
   * covered, and `bounds.util` is what bounds that.
   */
  const read = resolution.entities.map((entity) => {
    /* Every selected field, with one reading per system that holds it. */
    const fields = plan.planned.selected.map((fieldPath) => ({
      fieldPath,
      readings: entity.members
        .map((member) => {
          const source = readingFor.get(member.connectionId);
          if (!source || !(fieldPath in source.reading)) return null;
          const [reading] = readingsOf(source, member.row).filter(
            (one) => one.fieldPath === fieldPath,
          );
          if (!reading) return null;

          /* Import §5 — a value read from a document says so, through the merge
             and into every total computed from it. */
          const certainty = certaintyOf(member.row, source.reading[fieldPath]!);
          return { connectionId: member.connectionId, value: reading.value, ...(certainty ? { certainty } : {}) };
        })
        .filter((one): one is Reading => one !== null),
    }));

    return { entity, fields };
  });

  /*
   * ── ONE THING WRITTEN TWO WAYS IS NOT A DISAGREEMENT ─────────────────────
   *
   * A CRM writes `UK` where the ledger writes `United Kingdom`. Read strictly
   * that is a dispute on every customer, and a disputed field carries no
   * value. So, across the whole answer and for each field, the pairs the two
   * systems keep giving are found, and those that are one thing by how they
   * are written are read as one (`written.ontology`).
   *
   * WORKED OUT FROM THIS ANSWER'S OWN READINGS AND GONE WITH IT. Nothing is
   * remembered: Silo keeps no value from anybody's systems to do this.
   *
   * A PAIR THAT IS NOT A WAY OF WRITING ANYTHING — `DE` and `Germany`, `paid`
   * and `overdue` — stays the disagreement it may be, and is reported, so the
   * reader is told it is one disagreement many times rather than many.
   */
  const written: NonNullable<ConceptAnswer['written']> = [];
  const readsAs = new Map<string, string>();

  if (plan.concept.objects.length > 1) {
    plan.planned.selected.forEach((fieldPath, at) => {
      for (const found of writtenTwoWays(read.map((one) => one.fields[at]!.readings))) {
        written.push({ fieldPath, ...found });
        if (!found.alike) continue;
        readsAs.set(`${fieldPath}\u0000${found.a.connectionId}\u0000${found.a.value}`, found.readsAs);
        readsAs.set(`${fieldPath}\u0000${found.b.connectionId}\u0000${found.b.value}`, found.readsAs);
      }
    });
  }

  /*
   * ── AND WHAT THE LAST COPY SHOWED, WHERE THIS ANSWER IS TOO SMALL TO (138) ─
   *
   * Asked about one customer, `UK` beside `United Kingdom` is seen once: not
   * often enough to be believed a habit from this answer alone, so it would be
   * a disagreement. The concept's last copy saw the pair on four hundred
   * records. Where a concept is kept, the pairs its copy showed to be one
   * thing by how they are written are read as one here too — and the answer
   * says it did so on the copy's evidence, and how much.
   *
   * ONLY PAIRS THIS ANSWER ACTUALLY HOLDS, in fields it actually read: nothing
   * is said about a value the asker did not see.
   */
  if (plan.known && plan.kept && plan.concept.objects.length > 1) {
    let known: siloLearned.KnownPair[] = [];
    try {
      known = await siloLearned.alikePairs(actor.organisationId, plan.known);
    } catch (error) {
      log.warn({ conceptId: plan.concept.id, err: error }, 'What the last copy showed about values could not be read; this answer rests on its own records');
    }

    const said = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : null);

    for (const pair of known) {
      const index = plan.planned.selected.indexOf(pair.fieldPath);
      if (index < 0) continue;

      const same = (one: (typeof written)[number]) =>
        one.fieldPath === pair.fieldPath &&
        ((one.a.connectionId === pair.a.connectionId && one.a.value === pair.a.value && one.b.connectionId === pair.b.connectionId && one.b.value === pair.b.value) ||
          (one.a.connectionId === pair.b.connectionId && one.a.value === pair.b.value && one.b.connectionId === pair.a.connectionId && one.b.value === pair.a.value));
      /* Already believed from this answer's own records. */
      if (written.some((one) => one.alike && same(one))) continue;

      const records = read.filter((one) => {
        const readings = one.fields[index]!.readings;
        return (
          said(readings.find((reading) => reading.connectionId === pair.a.connectionId)?.value) === pair.a.value &&
          said(readings.find((reading) => reading.connectionId === pair.b.connectionId)?.value) === pair.b.value
        );
      }).length;
      if (records === 0) continue;

      readsAs.set(`${pair.fieldPath}\u0000${pair.a.connectionId}\u0000${pair.a.value}`, pair.readsAs);
      readsAs.set(`${pair.fieldPath}\u0000${pair.b.connectionId}\u0000${pair.b.value}`, pair.readsAs);

      /* Said once: as read as one, not also as a disagreement that keeps turning up. */
      const listed = written.findIndex((one) => same(one));
      if (listed >= 0) written.splice(listed, 1);
      written.push({ fieldPath: pair.fieldPath, a: pair.a, b: pair.b, records, readsAs: pair.readsAs, alike: true, known: pair.records });
    }
  }

  /*
   * WHY A RECORD IS HERE, ON THE RECORD. Each one kept because another kind of
   * record reaches it says how many do, or what they come to — "3 overdue
   * invoices", "£12,400 owed" — as a field Silo worked out. It sorts and totals
   * like any other, which is what "the five who owe most" is.
   */
  const worked = (input.conditions?.related ?? []).filter((one) => one.as);
  const computedFor = (entity: (typeof read)[number]['entity']): Merged[] =>
    worked.map((one) => {
      let records = 0;
      let total = 0;
      for (const member of entity.members) {
        if (member.connectionId !== one.connectionId) continue;
        const reached = one.reached.get(member.ref);
        if (!reached) continue;
        records += reached.records;
        total += reached.value ?? 0;
      }
      return { fieldPath: one.as!, value: one.figure === 'sum' ? total : records, basis: 'only' as const, readings: [], computed: true as const };
    });

  /* Every field an entity carries: what was selected, and what was worked out. */
  const shown = [...plan.planned.selected, ...worked.map((one) => one.as!)];

  const merged = read.map(({ entity, fields }) => ({
    /* NO ROW AND NO MATCH KEY. A member carries the whole row because the
       arithmetic needs it; identifiers are what may cross. */
    members: entity.members.map((member) => ({
      connectionId: member.connectionId,
      ref: member.ref,
    })),
    fields: [...computedFor(entity), ...mergeEntity({
      fields,
      authorities,
      ...(readsAs.size > 0
        ? {
            readAs: (fieldPath: string, reading: Reading) =>
              (typeof reading.value === 'string' || typeof reading.value === 'number'
                ? readsAs.get(`${fieldPath}\u0000${reading.connectionId}\u0000${String(reading.value).trim()}`)
                : undefined) ?? reading.value,
          }
        : {}),
    })].sort((a, b) => (a.fieldPath < b.fieldPath ? -1 : a.fieldPath > b.fieldPath ? 1 : 0)),
  }));

  /*
   * COVERAGE PER FIELD, OVER THE POPULATION. It differs per field — `total` may
   * be decided everywhere and `status` disputed on half — and it is computed
   * over every resolved entity rather than over the page, because its whole job
   * is to say what the figures beside it could not account for.
   */
  const coverage: Record<string, Coverage> = {};
  for (const fieldPath of shown) {
    coverage[fieldPath] = withDoubt(
      coverageOf(merged.map((entity) => entity.fields.find((one) => one.fieldPath === fieldPath)!)),
    );
  }

  /*
   * ── ORDERED, THEN BOUNDED, AND IT WAS ONLY BOUNDED ───────────────────────
   *
   * The sort reached every source and every source honoured it. Resolution
   * then re-ordered the population by match key so its grouping would be
   * deterministic, and nothing put the asked-for order back — so this slice
   * took the first N by INVOICE NUMBER and called it "the ten biggest".
   *
   * Ordering happens here because here is where the merged figure exists: the
   * number a person sorts by has to be the number they are shown, not
   * whichever system sorted first.
   */
  const { ordered, unplaceable } = orderEntities(merged, input.query.sort ?? []);

  /* The list a caller reads is bounded; nothing computed from it is. */
  let entities: QueriedEntity[] = ordered.slice(0, input.query.limit);

  /*
   * ── AND WHAT EACH ONE HELD BEFORE (136) ──────────────────────────────────
   *
   * For the records on the page, and only those: the earlier copy is read for
   * them, and each field that is not as it was says what it was. "Stage:
   * Negotiation, was Proposal" is the answer to "what changed"; a list of
   * records that differ somehow is not.
   */
  if (changes && plan.before) {
    const before = new Map<string, Map<string, Row>>();
    const now = new Map(sources.map((source) => [source.connectionId, new Map(source.rows.map((row) => [refOf(at(row, source.object.identifierField)), row]))]));

    for (const source of sources) {
      const refs = entities
        .flatMap((entity) => entity.members)
        .filter((member) => member.connectionId === source.connectionId && differs.get(source.connectionId)?.get(member.ref) === false)
        .map((member) => member.ref);
      if (refs.length === 0) continue;

      const rows = stripRows(
        await siloKeep.read(actor.organisationId, plan.before.get(source.connectionId)!, {
          filters: [{ field: source.object.identifierField, op: 'in', value: refs }],
          limit: refs.length + 1,
        }),
        plan.hidden.get(source.connectionId) ?? new Set<string>(),
      );
      before.set(source.connectionId, new Map(rows.map((row) => [refOf(at(row, source.object.identifierField)), row])));
    }

    /* As the store compares them: by how each value is written. */
    const written = (value: unknown) => (value === null || value === undefined ? null : typeof value === 'object' ? JSON.stringify(value) : String(value));

    entities = entities.map((entity) => {
      const added = entity.members.filter((member) => differs.get(member.connectionId)?.get(member.ref) === true).map((member) => member.connectionId);
      const fields: NonNullable<QueriedEntity['since']>['fields'] = [];

      for (const member of entity.members) {
        const was = before.get(member.connectionId)?.get(member.ref);
        const is = now.get(member.connectionId)?.get(member.ref);
        const source = readingFor.get(member.connectionId);
        if (!was || !is || !source) continue;

        const then = new Map(readingsOf(source, was).map((one) => [one.fieldPath, one.value]));
        for (const reading of readingsOf(source, is)) {
          if (written(then.get(reading.fieldPath)) === written(reading.value)) continue;
          fields.push({ fieldPath: reading.fieldPath, connectionId: member.connectionId, was: then.get(reading.fieldPath) ?? null, now: reading.value ?? null });
        }
      }

      return added.length > 0 || fields.length > 0 ? { ...entity, since: { added, fields } } : entity;
    });
  }

  log.info(
    {
      conceptId: plan.concept.id,
      entities: merged.length,
      returned: entities.length,
      unplaceable,
      unmatched: resolution.unmatched.length,
    },
    'Concept query answered',
  );

  /*
   * ── AGGREGATED OVER ENTITIES, WHICH IS THE ONLY CORRECT PLACE ─────────────
   *
   * A sum in the fan-out double-counts every invoice both systems hold, and a
   * count there reports rows rather than things. Neither error announces
   * itself. Here the population is entities whose identity has been
   * established, and each figure carries what it could not include.
   */
  const aggregates = (input.query.aggregate ?? []).map((request) => {
    const computed = aggregate({
      operation: request.operation,
      fieldPath: request.field,
      /* EVERY RESOLVED ENTITY, not the page. A total of the first hundred is
         not the total, and nothing in the answer would say so. */
      fields: merged.map(
        (entity) => entity.fields.find((one) => one.fieldPath === request.field)!,
      ),
    });

    /* The sum said `disputed: 0` beside a caveat at the top of the answer
       saying some of it could not be checked. The figure carries it now. */
    return { ...computed, coverage: withDoubt(computed.coverage) };
  });

  /*
   * ── WHAT WAS LEARNED IS LOOKED AT AGAIN, FOR NOTHING ─────────────────────
   *
   * This answer read a field two systems were learned to share, so it holds
   * both systems' readings of it for every record — the evidence the match was
   * learned from, already fetched. Where most of them no longer agree the
   * match is withdrawn, and the next question reads two fields again; where
   * the counts have merely moved, they are brought up to date.
   *
   * ONLY AN UNFILTERED ANSWER. A filter on the field itself picks out the
   * records where one system says a thing, which is no sample of how often the
   * two agree.
   *
   * A FAILURE HERE IS NOT A FAILURE TO ANSWER, like every other thing an
   * answer teaches.
   */
  const unlearned: NonNullable<ConceptAnswer['unlearned']> = [];

  if (!narrowed && plan.applied.length > 0) {
    try {
      const comparable = (value: unknown): string | null =>
        typeof value === 'string' || typeof value === 'number' ? String(value).trim() || null : null;

      const reviews = plan.applied
        .filter((one) => plan.planned.selected.includes(one.fieldPath))
        .map((one) => {
          let compared = 0;
          let agreed = 0;

          for (const entity of merged) {
            const readings = entity.fields.find((field) => field.fieldPath === one.fieldPath)?.readings ?? [];
            const mine = comparable(readings.find((reading) => reading.connectionId === one.connectionId)?.value);
            if (mine === null) continue;

            const theirs = readings
              .filter((reading) => reading.connectionId !== one.connectionId)
              .map((reading) => comparable(reading.value))
              .filter((value): value is string => value !== null);
            if (theirs.length === 0) continue;

            compared += 1;
            /* One thing written two ways is the two systems agreeing. */
            if (theirs.some((other) => writtenAlike(mine, other) !== null)) agreed += 1;
          }

          return { ...one, seen: { compared, agreed }, decision: reviewLearned({ seen: { compared, agreed }, kept: one }) };
        })
        .filter((one) => one.decision !== 'leave');

      if (reviews.length > 0) {
        await runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
          withTransaction(async (db) => {
            for (const review of reviews) {
              if (review.decision === 'refresh') {
                await fieldAliasRepo.observe(db, review.id, review.seen);
                continue;
              }

              if (!(await fieldAliasRepo.unlearn(db, review.id))) continue;

              await writeAudit(db, {
                event: 'field_alias_unlearned',
                organisationId: actor.organisationId,
                membershipId: actor.membershipId,
                userId: null,
                detail: {
                  conceptId: plan.concept.id,
                  connectionId: review.connectionId,
                  objectName: review.objectName,
                  sourceField: review.sourceField,
                  canonicalField: review.fieldPath,
                  compared: review.seen.compared,
                  agreed: review.seen.agreed,
                },
              });

              unlearned.push({ fieldPath: review.fieldPath, connectionId: review.connectionId, sourceField: review.sourceField, ...review.seen });
            }
          }),
        );
      }
    } catch (error) {
      log.warn({ conceptId: plan.concept.id, err: error }, 'Learned field matches could not be looked at again');
    }
  }

  return {
    concept: { id: plan.concept.id, name: plan.concept.name },
    entities,
    lineage: plan.lineage,
    aggregation:
      plan.aggregation.where === 'source'
        ? { where: 'source' as const }
        : { where: 'local' as const, because: plan.aggregation.because },
    aggregates: inStore ? inStore.aggregates : aggregates,
    coverage,
    /*
     * ── NOT CLAIMED ABOUT A SOURCE THAT COULD NOT BE ASKED ─────────────────
     *
     * `unmatched` means "this system holds no counterpart", and after a
     * filtered question that is only knowable because the completion pass went
     * back and asked. Where it could not — a source that does not declare `in`
     * — the honest answer is silence, not a claim that would send somebody
     * looking for a record that may be sitting there, excluded by the filter.
     */
    unmatched: resolution.unmatched.filter((one) => !unverified.includes(one.missingIn)),
    /*
     * AND THE SILENCE IS ANNOUNCED. An empty `unmatched` that means "we did not
     * look" must not read like one that means "everything lined up".
     */
    ...(unverified.length > 0
      ? { unverified: { connectionIds: unverified, entities: unverifiedEntities } }
      : {}),
    ...(plan.planned.unheld.length > 0
      ? {
          unheld: input.refs?.length
            ? plan.planned.unheld
            : await counted(fetch, {
                unheld: plan.planned.unheld,
                objects: plan.concept.objects,
                batchSizes: plan.kept ? new Map(plan.concept.objects.map((object) => [object.connectionId, null])) : plan.batchSizes,
                aliases,
              }),
        }
      : {}),
    ...(unlearned.length > 0 ? { unlearned } : {}),
    ...(written.length > 0 ? { written: written.slice(0, WRITTEN_MOST) } : {}),
    ...(plan.kept
      ? {
          asOf: [...plan.kept].map(([connectionId, copy]) => ({
            connectionId,
            syncedAt: copy.at.toISOString(),
            ...(fresh ? { freshAt: fresh.at.toISOString(), changed: fresh.rows.get(connectionId)?.size ?? 0, by: copy.marker! } : {}),
          })),
        }
      : {}),
    ...(input.asAt ? { asAt: input.asAt.toISOString() } : {}),
    ...(changes ? { changes } : {}),
    examined,
    matched: inStore ? inStore.matched : merged.length,
    /* A page of a large copy is not a summary of it: with the figures worked out in the store, no field is profiled. */
    profile: inStore ? [] : profileOf(merged, shown),
    /* Over EVERY resolved record that passed, like the totals — never the page. */
    ...(input.analyse?.length ? { tables: inStore ? inStore.tables : analyse(merged, input.analyse) } : {}),
    fieldsListed: plan.fieldsListed,
  };
}

/**
 * Siloes (137) — the records each system marks as added or changed since its
 * copy was made, read live.
 *
 * ── ALL OF THE CONCEPT'S SYSTEMS, OR NONE ─────────────────────────────────
 *
 * A customer whose CRM half is as of now and whose ledger half is as of two
 * this morning is two moments presented as one. So unless every system has
 * shown the field it marks change with, nothing is caught up and the answer
 * is as the copies stood — which it says.
 *
 * ── NULL IS "ANSWER FROM THE COPY AS IT STANDS", NEVER A FAILURE ──────────
 *
 * A system that does not answer, one that cannot be asked by that field
 * within what a read may bring back, more changed than one answer lays over a
 * copy: each leaves the answer exactly what it was before any of this
 * existed, with the time of the copy on it.
 *
 * READ AS THE PERSON ASKING, like any live read: a field hidden from them is
 * not fetched.
 */
async function changedSince(
  actor: Actor,
  kept: ReadonlyMap<string, siloKeep.Kept>,
  objects: readonly ContributingObject[],
): Promise<{ at: Date; rows: Map<string, Map<string, Row>> } | null> {
  const copies = [...kept.values()];
  if (copies.length === 0 || copies.some((copy) => !copy.marker)) return null;
  /* A copy made moments ago has nothing to catch up on. */
  if (copies.every((copy) => Date.now() - copy.at.getTime() < siloKeep.FRESH.after)) return null;

  const readAt = new Date();
  const rows = new Map<string, Map<string, Row>>();

  try {
    for (const object of objects) {
      const copy = kept.get(object.connectionId);
      if (!copy?.marker) return null;

      const answered = await askComplete({
        actor,
        connectionIds: [object.connectionId],
        query: {
          object: object.objectName,
          filters: [{ field: copy.marker, op: 'gte', value: new Date(copy.at.getTime() - siloKeep.FRESH.margin).toISOString() }],
          sort: [],
          fields: [],
          limit: siloKeep.FRESH.most + 1,
        },
      });

      const changed = answered.flatMap((one) => one.result?.rows ?? []);
      /* More than one answer lays over a copy: the copy is answered as it stands. */
      if (changed.length > siloKeep.FRESH.most) return null;

      rows.set(object.connectionId, new Map(changed.map((row) => [refOf(at(row, object.identifierField)), row])));
    }
  } catch (error) {
    log.warn({ err: error }, 'What changed since a kept copy could not be read live; answered from the copy as it stands');
    return null;
  }

  return { at: readAt, rows };
}

/** A moment as a day, for a sentence. */
const dayOf = (moment: Date) => moment.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * Siloes (135, 136) — the copies a question is answered from.
 *
 * A QUESTION ABOUT NOW reads the latest copies where the whole concept is kept,
 * and the live systems otherwise: `kept` null is "read live", and it is what
 * every organisation that keeps nothing gets, without a row being looked for.
 *
 * A QUESTION ABOUT A PAST MOMENT HAS NO LIVE READING. It is answered from the
 * copy of each system made nearest that moment, or refused in words that say
 * what there is: whether the concept is kept at all, whether its past copies
 * are, and when the earliest one was made.
 */
async function copiesFor(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  input: {
    name: string;
    objects: readonly ContributingObject[];
    conceptId: string;
    manifests: Parameters<typeof siloKeep.servable>[3];
    /** Whether every condition of the question is one a copy can apply. */
    storeable: boolean;
    asAt?: Date;
    since?: Date;
  },
): Promise<{ kept: Map<string, siloKeep.Kept> | null; before: Map<string, siloKeep.Kept> | null }> {
  if (!input.asAt && !input.since) {
    return { kept: input.storeable ? await siloKeep.servable(db, input.objects, input.conceptId, input.manifests) : null, before: null };
  }

  if (!input.storeable) {
    throw refusal({
      message: 'That question compares records in a way a copy of them cannot, so it can only be asked of your systems as they are now.',
      code: 'refusal.no_copy_then',
    });
  }

  const then = async (moment: Date) => {
    const found = await siloKeep.servableAt(db, input.objects, input.conceptId, input.manifests, moment);
    if ('kept' in found) return found.kept;

    throw refusal({
      message:
        found.none === 'not_kept'
          ? `${input.name} is read from your systems as they are now, and nothing of what it held on ${dayOf(moment)} is kept. ` +
            'Keeping it in a Silo, with its past copies, is what lets that be asked — from the day it is switched on.'
          : found.none === 'no_history'
            ? `Only the latest copy of ${input.name} is kept, so nothing says what it held on ${dayOf(moment)}. ` +
              'Keeping its past copies is what lets that be asked — from the day it is switched on.'
            : found.earliest
              ? `No copy of ${input.name} was made near ${dayOf(moment)}. The earliest one kept is from ${dayOf(found.earliest)}.`
              : `No copy of ${input.name} has been made yet.`,
      code: 'refusal.no_copy_then',
      detail: { conceptId: input.conceptId, reason: found.none },
    });
  };

  const before = input.since ? await then(input.since) : null;
  const kept = input.asAt ? await then(input.asAt) : await siloKeep.servable(db, input.objects, input.conceptId, input.manifests);

  if (!kept) {
    throw refusal({
      message: `${input.name} has no finished copy to compare the earlier one with.`,
      code: 'refusal.no_copy_then',
    });
  }

  if (before && [...before].every(([connectionId, copy]) => kept.get(connectionId)?.batchId === copy.batchId)) {
    throw refusal({
      message:
        `The copy of ${input.name} made nearest ${dayOf(input.since!)} is the one being read now, so there is nothing yet to compare it with. ` +
        'Ask again once the next copy has been made.',
      code: 'refusal.same_copy',
    });
  }

  return { kept, before };
}

/**
 * Siloes (135) — which records a related condition reaches, worked out in the
 * store from a kept copy of the related records.
 *
 * ── THE JOIN, AS ONE GROUPED QUERY ────────────────────────────────────────
 *
 * An invoice names its customer in a column. Grouping the kept invoices that
 * match the condition by that column gives, per customer, how many there are
 * and what they come to — which is everything `askPlanned` would have learned
 * by reading every invoice and walking from each. Nothing is followed and no
 * invoice leaves the store.
 *
 * ── ONLY THE PLAIN CASE, AND NULL FOR EVERYTHING ELSE ─────────────────────
 *
 * The related concept is held by ONE system and kept whole; that system
 * declares exactly one key from it to an object of the concept asked about,
 * pointing at the field that object is identified by; and every condition is
 * one the store can apply. Anything else returns null and the caller reads and
 * walks as it always has — including every refusal that path makes, which this
 * must never turn into a silent answer.
 *
 * THE SAME GATES A QUESTION PASSES: the asker may run queries, is cleared for
 * the related concept, and reaches its system; a field hidden from them is not
 * one they may filter or total by.
 */
async function reachedInStore(
  actor: Actor,
  one: RelatedCondition,
  mainConceptId: string,
  /* Siloes (136) — as the related records stood at a past moment: their copy made nearest it, or null. */
  asAt?: Date,
): Promise<{
  concept: { id: string; name: string };
  connectionId: string;
  reached: Map<string, { records: number; value: number | null }>;
  matched: number;
  route: string;
} | null> {
  if (!env.SILOES_AVAILABLE) return null;

  const found = await runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'query.run');

      const related = await conceptRepo.read(db, one.conceptId);
      const main = await conceptRepo.read(db, mainConceptId);
      if (!related || related.retiredAt || !main || main.retiredAt || related.objects.length !== 1) return null;

      const [stored] = related.objects;
      const target = main.objects.find((object) => object.connectionId === stored!.connectionId);
      if (!target) return null;

      await assertCleared(db, authority, { type: 'concept', id: related.id, conceptIds: [related.id] });
      const readable = await readableIds(db, actor, [stored!.connectionId]);
      if (!readable.has(stored!.connectionId)) return null;

      const hidden = await hiddenFields(db, actor, [stored!.connectionId]);
      const [object] = visibleObjects([stored!], hidden);
      if (!object) return null;

      const keys = (await conceptRepo.relationships(db)).filter(
        (link) =>
          link.fromConceptId === related.id &&
          link.toConceptId === main.id &&
          link.connectionId === object.connectionId &&
          link.fromObject === object.objectName &&
          link.toObject === target.objectName,
      );
      /* None, or several: the walk is what refuses a join nothing declares and one that could be made two ways. */
      if (keys.length !== 1 || keys[0]!.toField !== target.identifierField) return null;
      if ((hidden.get(object.connectionId) ?? new Set<string>()).has(keys[0]!.fromField)) return null;

      const filters: Array<{ field: string; op: string; value?: unknown }> = [];
      for (const filter of one.where) {
        const column = object.fieldMap[filter.field];
        if (!column) return null;
        filters.push({ ...filter, field: column });
      }
      if (!siloKeep.canFilter(filters)) return null;

      const totalled = one.total?.operation === 'sum' && one.total.field ? object.fieldMap[one.total.field] : undefined;
      if (one.total?.operation === 'sum' && !totalled) return null;

      const manifests = await connectorRepo.load(db, [object.connectionId]);
      const then = asAt ? await siloKeep.servableAt(db, related.objects, related.id, manifests, asAt) : null;
      const kept = then ? ('kept' in then ? then.kept : null) : await siloKeep.servable(db, related.objects, related.id, manifests);
      const copy = kept?.get(object.connectionId);
      if (!copy) return null;

      return {
        copy,
        filters,
        key: keys[0]!,
        totalled,
        related: { id: related.id, name: related.name },
        mainName: main.name,
        connectionId: object.connectionId,
      };
    }),
  );

  if (!found) return null;

  const grouped = await siloKeep.summarise(actor.organisationId, found.copy, {
    filters: found.filters as never,
    groupBy: [{ field: found.key.fromField }],
    measures: found.totalled ? [{ operation: 'sum', field: found.totalled }] : [{ operation: 'count' }],
    limit: siloKeep.LIMITS.rowsInMemory,
  });
  /* More records reached than can be worked on here: left to the path that says so. */
  if (grouped.length >= siloKeep.LIMITS.rowsInMemory) return null;

  const reached = new Map<string, { records: number; value: number | null }>();
  let matched = 0;

  for (const row of grouped) {
    matched += row.records;
    const to = row.key[0] ?? null;
    /* A related record that names nothing reaches nothing. It still matched the condition. */
    if (to === null || to.trim() === '') continue;
    reached.set(to.trim(), { records: row.records, value: found.totalled ? (row.measures[0] ?? null) : null });
  }

  return {
    concept: found.related,
    connectionId: found.connectionId,
    reached,
    matched,
    route: `${found.mainName} is upstream of ${found.related.name}, through ${found.key.fromObject}.${found.key.fromField}.`,
  };
}

/**
 * Siloes (135) — a large copy's count, totals and tables, worked out in the store.
 *
 * NULL WHEN THE COPY IS SMALL ENOUGH TO BRING BACK, which is decided by asking
 * the store how many records the question matches: one row back. Then the
 * caller works on the rows themselves, as it does for a live read.
 *
 * THE SAME FIGURES `aggregate` AND `analyse` WOULD GIVE, by the same rules: a
 * value that is not a number adds nothing and is counted as unmeasured, a
 * record with no group is "(none)", an average is a sum over what was counted.
 * One system holds this concept, so nothing here can be disputed.
 */
async function figuresInStore(input: {
  organisationId: string;
  copy: siloKeep.Kept;
  fieldMap: Record<string, string>;
  filters: Query['filters'];
  aggregate: NonNullable<ConceptQuery['aggregate']>;
  analyse: readonly AnalysisSpec[];
  /**
   * Siloes (137) — the records this system marks as changed since the copy,
   * read live. Each is left out of what the store adds up, and added here as
   * it now is: so a figure over five million is as current as a figure over
   * fifty.
   */
  changed?: { identifier: string; rows: ReadonlyMap<string, Row> };
}): Promise<{ matched: number; aggregates: Aggregated[]; tables: AnalysisTable[] } | null> {
  const changed = input.changed && input.changed.rows.size > 0 ? input.changed : null;
  /* The live records the question's own conditions keep, by the test a source applies. */
  const live = changed ? [...changed.rows.values()].filter((row) => input.filters.every((filter) => matches(row, filter))) : [];
  const filters = (changed ? [...input.filters, { field: changed.identifier, op: 'nin', value: [...changed.rows.keys()] }] : input.filters) as never;

  const add = (work: Parameters<typeof siloKeep.summarise>[2]) => siloKeep.summarise(input.organisationId, input.copy, work);

  const [all] = await add({ filters, groupBy: [], measures: [{ operation: 'count' }], limit: 1 });
  const matched = (all?.records ?? 0) + live.length;
  if (matched <= siloKeep.LIMITS.rowsInMemory) return null;

  /* An average is a sum over what was counted; everything else is asked for as it is. */
  const measureOf = (operation: string, field?: string) => ({
    operation: (operation === 'average' ? 'sum' : operation) as 'count' | 'sum' | 'minimum' | 'maximum',
    ...(field && operation !== 'count' ? { field: input.fieldMap[field]! } : {}),
  });

  /*
   * ONE FIGURE, IN TWO PARTS THAT ADD. What the store worked out over the
   * records it holds, and the same thing worked out here over the live ones:
   * how many records, what they come to (or the least, or the most), and how
   * many had a number at all. `figure` is only taken once both are in.
   */
  type Tally = { records: number; value: number | null; counted: number };

  const stored = (row: { records: number; measures: Array<number | null>; counted: number[] } | undefined, at: number): Tally => ({
    records: row?.records ?? 0,
    value: row?.measures[at] ?? null,
    counted: row?.counted[at] ?? 0,
  });

  const counted = (operation: string, column: string | undefined, rows: readonly Row[]): Tally => {
    if (operation === 'count' || !column) return { records: rows.length, value: rows.length, counted: rows.length };

    /* A value that is not a number adds nothing and is not counted, as in the store. */
    const numbers = rows.map((row) => numeric(at(row, column))).filter((value): value is number => value !== null);
    const value =
      numbers.length === 0
        ? null
        : operation === 'minimum'
          ? numbers.reduce((least, one) => Math.min(least, one))
          : operation === 'maximum'
            ? numbers.reduce((most, one) => Math.max(most, one))
            : numbers.reduce((sum, one) => sum + one, 0);
    return { records: rows.length, value, counted: numbers.length };
  };

  const both = (operation: string, a: Tally, b: Tally): Tally => ({
    records: a.records + b.records,
    counted: a.counted + b.counted,
    value:
      a.value === null
        ? b.value
        : b.value === null
          ? a.value
          : operation === 'minimum'
            ? Math.min(a.value, b.value)
            : operation === 'maximum'
              ? Math.max(a.value, b.value)
              : a.value + b.value,
  });

  const figure = (operation: string, tally: Tally): number | null => {
    if (operation === 'count') return tally.records;
    if (tally.counted === 0) return null;
    return operation === 'average' ? (tally.value ?? 0) / tally.counted : tally.value;
  };

  const aggregates: Aggregated[] = [];
  if (input.aggregate.length > 0) {
    const [row] = await add({ filters, groupBy: [], measures: input.aggregate.map((one) => measureOf(one.operation, one.field)), limit: 1 });
    input.aggregate.forEach((one, index) => {
      const tally = both(one.operation, stored(row, index), counted(one.operation, input.fieldMap[one.field], live));
      const had = one.operation === 'count' ? matched : tally.counted;
      aggregates.push({
        operation: one.operation,
        fieldPath: one.field,
        value: figure(one.operation, tally),
        coverage: { counted: had, disputed: 0, empty: matched - had, authorityHeldNothing: 0 },
      });
    });
  }

  const typeOf = new Map(input.copy.fields.map((field) => [field.name, field.type]));
  const none = (part: string | null) => (part === null || part.trim() === '' ? '(none)' : part.trim());

  const tables: AnalysisTable[] = [];
  for (const spec of input.analyse) {
    const groupBy =
      spec.kind === 'breakdown'
        ? [{ field: input.fieldMap[spec.by]! }]
        : spec.kind === 'trend'
          ? [{ field: input.fieldMap[spec.time]!, every: spec.every }]
          : spec.by.map((field) => ({ field: input.fieldMap[field]! }));

    const operation = spec.measure.operation;
    const column = spec.measure.field ? input.fieldMap[spec.measure.field] : undefined;
    const grouped = await add({ filters, groupBy, measures: [measureOf(operation, spec.measure.field)], limit: siloKeep.LIMITS.groups * 10 });

    const groups = new Map<string, { key: string[]; tally: Tally }>();
    const into = (key: string[], tally: Tally) => {
      const name = key.join('\u0000');
      const held = groups.get(name);
      groups.set(name, { key, tally: held ? both(operation, held.tally, tally) : tally });
    };

    for (const row of grouped) into(row.key.map(none), stored(row, 0));

    /* The live records, each into the group the store would have put it in. */
    if (live.length > 0) {
      const mine = new Map<string, { key: string[]; rows: Row[] }>();
      for (const row of live) {
        const key = groupBy.map((part) => {
          const written = siloKeep.groupText(at(row, part.field), typeOf.get(part.field));
          if (written === null || !('every' in part) || !part.every) return none(written);
          /* The period a date is in, cut from its spelling exactly as the store cuts it. */
          if (part.every === 'year') return none(written.slice(0, 4));
          if (part.every === 'month') return none(written.slice(0, 7));
          if (part.every === 'day') return none(written.slice(0, 10));
          return none(`${written.slice(0, 4)}-Q${Math.ceil(Number(written.slice(5, 7)) / 3)}`);
        });
        const name = key.join('\u0000');
        const held = mine.get(name) ?? { key, rows: [] };
        held.rows.push(row);
        mine.set(name, held);
      }
      for (const group of mine.values()) into(group.key, counted(operation, column, group.rows));
    }

    let rows = [...groups.values()].map((group) => ({ key: group.key, value: figure(operation, group.tally), records: group.tally.records }));

    const name = (row: { key: string[] }) => row.key.join('\u0000');
    const byName = (a: { key: string[] }, b: { key: string[] }) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0);
    if (spec.kind === 'trend') rows.sort(byName);
    else {
      const ascending = spec.kind === 'breakdown' && spec.order === 'asc';
      rows.sort((a, b) => (ascending ? 1 : -1) * ((a.value ?? -Infinity) - (b.value ?? -Infinity)) || byName(a, b));
    }

    const keep = Math.min(spec.kind === 'breakdown' && spec.top ? spec.top : siloKeep.LIMITS.groups, siloKeep.LIMITS.groups);
    const cut = rows.slice(keep);
    rows = rows.slice(0, keep);

    tables.push({
      kind: spec.kind,
      by: spec.kind === 'breakdown' ? [spec.by] : spec.kind === 'trend' ? [spec.time] : [...spec.by],
      measure: spec.measure,
      ...(spec.kind === 'trend' ? { every: spec.every } : {}),
      rows,
      left: {
        disputed: 0,
        unmeasured: operation === 'count' ? 0 : [...groups.values()].reduce((sum, group) => sum + (group.tally.records - group.tally.counted), 0),
      },
      ...(cut.length > 0 ? { beyond: { groups: cut.length, records: cut.reduce((sum, row) => sum + row.records, 0) } } : {}),
    });
  }

  return { matched, aggregates, tables };
}

/** A condition on records by another kind of record that reaches them — §4.1. */
export type RelatedCondition = {
  conceptId: string;
  where: ConceptQuery['where'];
  /** True: records that have one. False: records that have none. */
  exists: boolean;
  /** The name of the field each kept record carries the count or total in. */
  as?: string;
  /** What that field holds: how many related records, or the sum of one of their fields. */
  total?: { operation: 'count' | 'sum'; field?: string };
  /** A condition on the related records themselves, by a third kind of record. One level, and no deeper. */
  related?: RelatedCondition[];
};

/**
 * §4.1 — a question about one kind of record, picked by others that relate to it.
 *
 * ── WHAT THIS IS, AND WHY IT IS THE POINT ─────────────────────────────────
 *
 * "Which customers have overdue invoices and an open deal?" The invoices are
 * in the ledger, the deals are in the CRM, and "customer" is something neither
 * system would recognise the other's version of. An assistant with a connector
 * to each reads a page of both and guesses. This reads every overdue invoice
 * and every open deal, follows each to its customer through the key the
 * system itself declares, lets resolution say which CRM company is which
 * ledger contact, and keeps the customers both reach.
 *
 * ── A COMPOSITION OF WHAT ALREADY EXISTED ─────────────────────────────────
 *
 *   `ask`    answers the related kind, filters and all — every record of it
 *   `walk`   follows the declared key from those records to this concept's
 *   `ask`    answers this concept, keeping the records the walk reached
 *
 * Each related condition is one hop, and they compose: a customer reached by
 * an invoice AND by a deal is a join across two systems that neither holds a
 * key for. A condition can carry one of its own — open deals of customers
 * with overdue invoices — and no more than one, because past that a question
 * is a report, and wants writing down.
 *
 * ── NEVER A GUESSED JOIN ──────────────────────────────────────────────────
 *
 * `walk` refuses where no declared key relates the two kinds, and where
 * several do and none was chosen. Those refusals are passed on as they are.
 */
export async function askPlanned(
  actor: Actor,
  input: {
    conceptId: string;
    query: ConceptQuery;
    related?: readonly RelatedCondition[];
    held?: ReadonlyArray<{ system: string; present: boolean }>;
    analyse?: readonly AnalysisSpec[];
    /** Siloes (136) — as the records stood at a past moment. */
    asAt?: Date;
    /** Siloes (136) — only what differs from the copy made nearest a past moment. */
    changed?: { since: Date; fields?: readonly string[] };
  },
  depth = 0,
): Promise<ConceptAnswer> {
  const related = input.related ?? [];
  const past = { ...(input.asAt ? { asAt: input.asAt } : {}), ...(input.changed ? { changed: input.changed } : {}) };

  if (related.length === 0 && !input.held?.length) {
    return ask(actor, { conceptId: input.conceptId, query: input.query, ...(input.analyse ? { analyse: input.analyse } : {}), ...past });
  }

  const conditions: Array<NonNullable<NonNullable<Parameters<typeof ask>[1]['conditions']>['related']>[number]> = [];
  const joins: NonNullable<ConceptAnswer['joins']> = [];

  for (const one of related) {
    /*
     * FIRST, WHERE THE RELATED RECORDS ARE KEPT IN A SILO: let the store say
     * which records they reach. "Customers with an overdue invoice" over five
     * million invoices is then one grouped query — a row back per customer —
     * instead of five million invoices read to be followed one at a time.
     */
    const stored = one.related?.length ? null : await reachedInStore(actor, one, input.conceptId, input.asAt);

    /*
     * A PAST MOMENT IS NEVER PIECED TOGETHER FROM NOW. The other way to learn
     * which records the related ones reach is to read them and follow each
     * through the systems as they are today — which would pick last quarter's
     * customers by this morning's invoices and present it as last quarter.
     */
    if (!stored && input.asAt) {
      throw refusal({
        message:
          'A question about a past moment can be picked by another kind of record only where that kind is kept in a Silo too, ' +
          'with its past copies, and one key joins the two. Ask it of the records as they are now, or without that condition.',
        code: 'refusal.no_copy_then',
        detail: { conceptId: one.conceptId },
      });
    }

    if (stored) {
      conditions.push({
        connectionId: stored.connectionId,
        reached: stored.reached,
        exists: one.exists,
        ...(one.exists && one.as ? { as: one.as, figure: one.total?.operation === 'sum' ? ('sum' as const) : ('count' as const) } : {}),
      });
      joins.push({
        concept: stored.concept,
        exists: one.exists,
        matched: stored.matched,
        reached: stored.reached.size,
        route: stored.route,
        ...(one.exists && one.as ? { as: one.as } : {}),
      });
      continue;
    }

    /*
     * EVERY RELATED RECORD THE CONDITION MATCHES, not a page of them: a
     * customer whose only overdue invoice is the two-thousandth is a customer
     * with an overdue invoice. Only the field a total needs is read.
     */
    const from = await askPlanned(
      actor,
      {
        conceptId: one.conceptId,
        query: {
          select: one.total?.field ? [one.total.field] : one.where.length > 0 ? [one.where[0]!.field] : [],
          where: one.where,
          sort: [],
          limit: DEFAULT_LIMITS.maxRows,
        },
        ...(one.related && depth === 0 ? { related: one.related } : {}),
      },
      depth + 1,
    );

    /*
     * EVERY ONE OF THEM, OR NOT AT ALL. A kept copy too large to bring back
     * answers with a page of its records and the figures worked out in the
     * store — which is right for a question about those records and wrong
     * here, where each one has to be followed to the record it belongs to.
     * Following the page would keep some customers and silently drop the rest.
     */
    if (from.entities.length < from.matched) {
      throw bounds({
        message:
          `${from.matched.toLocaleString('en-GB')} ${from.concept.name} records match, which is more than one answer can follow ` +
          'to the records they belong to. Narrow the condition on them, or ask about a shorter period.',
        code: 'bounds.related',
        detail: { conceptId: one.conceptId, matched: from.matched },
      });
    }

    const reached = new Map<string, { records: number; value: number | null }>();
    let connectionId = '';
    let route: string | null = null;

    /* Each related record by every identifier a system gives it, so whichever one the walk starts from finds it. */
    const byRef = new Map<string, { index: number; value: number | null }>();
    from.entities.forEach((entity, index) => {
      const held = one.total?.field ? entity.fields.find((field) => field.fieldPath === one.total!.field) : undefined;
      /* As a total reads it: a decimal a database returned as text is a number. */
      const value = held && held.basis !== 'disputed' ? numeric(held.value) : null;
      for (const member of entity.members) byRef.set(member.ref, { index, value });
    });

    /*
     * WALKED IN AS MANY GOES AS IT TAKES. One walk carries a bounded number of
     * starting records, which is right for a walk somebody asks for and too
     * few for "every invoice": eight thousand of them are two walks, not a
     * refusal. The related read above is what bounds the whole.
     */
    const starts = [...byRef.keys()];
    /* A related record counts once for each record it reaches, however many of its identifiers got there. */
    const counted = new Set<string>();

    for (let at = 0; at < starts.length; at += DEFAULT_LIMITS.maxFrontier) {
      const walked = await conceptService.walk(actor, {
        fromConceptId: one.conceptId,
        toConceptId: input.conceptId,
        entityRefs: starts.slice(at, at + DEFAULT_LIMITS.maxFrontier),
      });

      const taken = walked.routes[walked.taken];
      connectionId = taken?.connectionId ?? '';
      route = taken?.description ?? null;

      for (const path of walked.paths) {
        const source = byRef.get(path.from);
        if (!source || counted.has(`${path.to}\u0000${source.index}`)) continue;
        counted.add(`${path.to}\u0000${source.index}`);

        const held = reached.get(path.to) ?? { records: 0, value: null };
        held.records += 1;
        if (source.value !== null) held.value = (held.value ?? 0) + source.value;
        reached.set(path.to, held);
      }
    }

    conditions.push({
      connectionId,
      reached,
      exists: one.exists,
      ...(one.exists && one.as ? { as: one.as, figure: one.total?.operation === 'sum' ? ('sum' as const) : ('count' as const) } : {}),
    });

    joins.push({
      concept: from.concept,
      exists: one.exists,
      matched: from.matched,
      reached: reached.size,
      route,
      ...(one.exists && one.as ? { as: one.as } : {}),
    });
  }

  const answer = await ask(actor, {
    conceptId: input.conceptId,
    query: input.query,
    conditions: { related: conditions, ...(input.held?.length ? { held: input.held } : {}) },
    ...(input.analyse ? { analyse: input.analyse } : {}),
    ...past,
  });

  return joins.length > 0 ? { ...answer, joins } : answer;
}

/**
 * How many records a filter left unchecked, for each field some system lacks.
 *
 * ── WHAT IS BEING COUNTED ─────────────────────────────────────────────────
 *
 * A record held ONLY in systems that have no such field. Nothing could say
 * whether it matches, so it is not in the answer and not ruled out of it — and
 * "some records were not checked" is a sentence nobody can weigh without the
 * number. Often the number is nought: every record the support desk holds is a
 * customer the CRM holds too, so the CRM answered for all of them and nothing
 * was left out. Saying so is worth as much as saying twelve.
 *
 * ── BY KEY ALONE, AND ONLY AS FAR AS IS CHEAP ─────────────────────────────
 *
 * The keys of each system without the field are read — identifiers and match
 * keys, no other column — and the systems that hold the field are asked which
 * of those keys they have, the same question a counterpart is always asked.
 * What no holder has is the count.
 *
 * NOT COUNTED rather than guessed where that would be more than one answer
 * should ask of somebody's systems: a system with more than `CENSUS_MOST`
 * records, a holder that cannot be asked by key, or more batches than the
 * completion pass itself is allowed. The entry then carries no `unchecked`,
 * and the answer says only what it always could.
 *
 * NEVER ABLE TO FAIL THE ANSWER. It is a number beside one.
 */
async function counted(
  fetch: (connectionId: string, query: Query) => Promise<Row[]>,
  input: {
    unheld: readonly Unheld[];
    objects: readonly ContributingObject[];
    batchSizes: ReadonlyMap<string, number | null>;
    aliases: Array<{ connectionA: string; valueRefA: string; connectionB: string; valueRefB: string }>;
  },
): Promise<Unheld[]> {
  /* One read of a system's keys serves every field it lacks. */
  const keysOf = new Map<string, Row[] | null>();

  const keys = async (object: (typeof input.objects)[number]): Promise<Row[] | null> => {
    if (keysOf.has(object.connectionId)) return keysOf.get(object.connectionId)!;

    const rows = await fetch(object.connectionId, {
      object: object.objectName,
      filters: [],
      sort: [],
      fields: [...new Set([object.identifierField, ...object.matchKeys])],
      limit: CENSUS_MOST,
    });
    /* A full page is a system too large to count this way. */
    const held = rows.length >= CENSUS_MOST ? null : rows;
    keysOf.set(object.connectionId, held);
    return held;
  };

  const out: Unheld[] = [];

  for (const gap of input.unheld) {
    try {
      const without = input.objects.filter((object) => gap.connectionIds.includes(object.connectionId));
      const holders = input.objects.filter((object) => !gap.connectionIds.includes(object.connectionId));

      const sources: Array<{ connectionId: string; object: (typeof input.objects)[number]; rows: Row[] }> = [];
      let countable = holders.length > 0;

      for (const object of without) {
        const rows = countable ? await keys(object) : null;
        if (rows === null) {
          countable = false;
          break;
        }
        sources.push({ connectionId: object.connectionId, object, rows: [...rows] });
      }

      if (!countable) {
        out.push(gap);
        continue;
      }

      for (const object of holders) sources.push({ connectionId: object.connectionId, object, rows: [] });

      const first = resolveEntities({ sources, aliases: input.aliases });

      /* Which of those records does a system that holds the field have? Asked by key, as a counterpart always is. */
      const completion = completionQueries({
        objects: input.objects,
        selected: [],
        entities: first.entities,
        batchSizes: input.batchSizes,
        aliases: input.aliases,
        maxRows: DEFAULT_LIMITS.maxRows,
      });

      const asking = completion.queries.filter((one) => holders.some((object) => object.connectionId === one.connectionId));

      if (
        holders.some((object) => completion.unverified.includes(object.connectionId)) ||
        asking.length > DEFAULT_LIMITS.maxCompletionRequests
      ) {
        out.push(gap);
        continue;
      }

      for (const request of asking) {
        const source = sources.find((one) => one.connectionId === request.connectionId)!;

        for (const row of await fetch(request.connectionId, request.query)) {
          const key = keyOf(row, source.object.matchKeys);
          const ref = String(row[source.object.identifierField]);
          /* Only what was asked for: a two-column key is asked as a cross-product and returns pairs nobody wanted. */
          if ((key !== null && completion.wantedKeys.has(key)) || completion.wantedRefs.get(request.connectionId)?.has(ref)) {
            source.rows.push(row);
          }
        }
      }

      const holding = new Set(holders.map((object) => object.connectionId));
      const unchecked = resolveEntities({ sources, aliases: input.aliases }).entities.filter((entity) =>
        entity.members.every((member) => !holding.has(member.connectionId)),
      ).length;

      out.push({ ...gap, unchecked });
    } catch (error) {
      log.info({ fieldPath: gap.fieldPath, err: error }, 'What a filter left unchecked could not be counted');
      out.push(gap);
    }
  }

  return out;
}

/**
 * §4.1 — one question about two concepts.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 *
 * "Our invoices over ten thousand, with the suppliers they belong to" was two
 * questions and a spreadsheet. The controller refused `join` by NAME, which was
 * the honest thing to do while it could not be answered — an answer about
 * invoices alone, presented as an answer about invoices and suppliers, is the
 * failure this product exists to remove.
 *
 * ── It is a composition, not a new engine ──────────────────────────────────
 *
 * Everything it needs already existed and had never been put together:
 *
 *   `planJoin`   decides which side LEADS and by which route
 *   `ask`        answers the lead side, filters and all
 *   `walk`       crosses the relationship over actual records
 *   `ask`+refs   answers the follow side, narrowed to what the walk reached
 *
 * ── THE SIDE WITH MORE FILTERS LEADS ───────────────────────────────────────
 *
 * `planJoin` decides that, and the reason is the only one available without
 * statistics this product does not keep: a filter is the one thing here that
 * reduces a population before it moves. Leading with the unfiltered side would
 * walk every supplier in the estate to find the few that have a large invoice.
 *
 * ── A pairing is stated, never assumed ─────────────────────────────────────
 *
 * The answer says which records reached which, by identifier. It does not
 * flatten them into rows: one invoice reaching three suppliers is a fact about
 * the data, and a flattened table would silently triple the invoice.
 */
/**
 * Why one side led.
 *
 * STATED IN THE ANSWER, because a plan nobody can see is a plan nobody can
 * check — and this one is a heuristic rather than a fact, so it is exactly the
 * kind of decision a reader should be able to disagree with.
 */
const LED_BY_FILTERS =
  'The side with more filters is queried first, because a filter is the only thing here that ' +
  'reduces a population before it moves.';

export async function askJoined(
  actor: Actor,
  input: {
    conceptId: string;
    query: ConceptQuery;
    join: { conceptId: string; query: ConceptQuery; routeIndex?: number };
  },
): Promise<{
  concept: ConceptAnswer['concept'];
  answer: ConceptAnswer;
  joined: {
    concept: ConceptAnswer['concept'];
    answer: ConceptAnswer;
    /** Which record reached which, by the identifier each system states. */
    pairs: Array<{ from: string; to: string }>;
    /** The routes that exist, and which was taken. */
    routes: Array<{ description: string; connectionId: string; hops: number }>;
    taken: number;
  };
  /** Which side led, and why — a plan nobody can see is a plan nobody can check. */
  lead: { conceptId: string; because: string };
}> {
  const decided = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'query.run');

        const connections = await connectorRepo.load(db, []);

        return planJoin({
          from: { conceptId: input.conceptId, filters: input.query.where.length },
          to: { conceptId: input.join.conceptId, filters: input.join.query.where.length },
          relationships: await conceptRepo.relationships(db),
          batchSizes: new Map(
            connections.map((one) => [
              one.connectionId,
              connectionCapabilities(one.manifest).maxFilterValues,
            ]),
          ),
          maxHops: DEFAULT_LIMITS.maxHops,
          routeIndex: input.join.routeIndex,
        });
      }),
  );

  if (!decided.ok) {
    /* The planner's own words: no route, too many hops, or a source that cannot
       take the `in` the follow side would need. */
    throw refusal({
      message: decided.refusal.reason,
      code: decided.refusal.code,
      detail: decided.refusal.detail,
    });
  }

  const leading = decided.leadConceptId === input.conceptId;
  const lead = leading ? input : { conceptId: input.join.conceptId, query: input.join.query };
  const follow = leading ? { conceptId: input.join.conceptId, query: input.join.query } : input;

  /* The lead side, answered exactly as it would be on its own. */
  const leadAnswer = await ask(actor, { conceptId: lead.conceptId, query: lead.query });

  const from = [
    ...new Set(leadAnswer.entities.flatMap((one) => one.members.map((member) => member.ref))),
  ];

  /*
   * NOTHING TO CROSS FROM IS AN ANSWER. A lead side that matched no records has
   * no counterparts by definition, and walking from an empty list would be a
   * request to somebody's systems that could only return nothing.
   */
  if (from.length === 0) {
    return {
      concept: leadAnswer.concept,
      answer: leadAnswer,
      joined: {
        concept: { id: follow.conceptId, name: '' },
        answer: await ask(actor, { conceptId: follow.conceptId, query: follow.query, refs: [] }),
        pairs: [],
        routes: [],
        taken: 0,
      },
      lead: { conceptId: lead.conceptId, because: LED_BY_FILTERS },
    };
  }

  const walked = await conceptService.walk(actor, {
    fromConceptId: lead.conceptId,
    toConceptId: follow.conceptId,
    entityRefs: from,
    routeIndex: input.join.routeIndex,
  });

  const arrived = [...new Set(walked.paths.map((one) => one.to))];

  /*
   * THE FOLLOW SIDE KEEPS ITS OWN FILTERS. "Invoices over ten thousand, with
   * their ACTIVE suppliers" means both conditions — narrowing to what the walk
   * reached and then answering the question that was asked about that side.
   */
  const followAnswer = await ask(actor, {
    conceptId: follow.conceptId,
    query: follow.query,
    refs: arrived,
  });

  /*
   * ── THE LEARNED LAYER'S FIRST HONEST TRIGGER FOR A LINK ──────────────────
   *
   * `map_links` has had a reader and a copy-on-fork since 036 and no writer,
   * because a plan named ONE concept and nothing could say a question had
   * crossed two. This one did, somebody wanted the answer, and the answer came
   * back.
   *
   * AFTER THE ANSWER, NOT BEFORE, and never on a failure: a join that could not
   * execute says nothing about whether those two concepts belong together.
   *
   * A FAILURE TO LEARN IS NOT A FAILURE TO ANSWER. The reader asked a question
   * and got one; losing the reinforcement costs a little accuracy in what gets
   * suggested next and nothing else.
   */
  try {
    await runWithTenant(
      { organisationId: actor.organisationId, membershipId: actor.membershipId },
      () =>
        withTransaction((db) =>
          mapService.reinforceLink(db, actor, {
            conceptA: lead.conceptId,
            conceptB: follow.conceptId,
          }),
        ),
    );
  } catch {
    /* Deliberately silent — see above. */
  }

  return {
    concept: leadAnswer.concept,
    answer: leadAnswer,
    joined: {
      concept: followAnswer.concept,
      answer: followAnswer,
      pairs: walked.paths.map((one) => ({ from: one.from, to: one.to })),
      routes: walked.routes,
      taken: walked.taken,
    },
    lead: { conceptId: lead.conceptId, because: LED_BY_FILTERS },
  };
}
