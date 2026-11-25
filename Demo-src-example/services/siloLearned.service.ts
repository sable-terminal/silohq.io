import { createHash } from 'node:crypto';
import { withTransaction } from '../infra/db.infra';
import * as bigquery from '../infra/bigquery.infra';
import { childLogger } from '../config/logger.config';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import * as rowStore from './rowStore.service';
import * as siloKeep from './siloKeep.service';
import * as conceptRepo from '../repos/concept.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as fieldAliasRepo from '../repos/fieldAlias.repo';
import * as resolutionRepo from '../repos/resolution.repo';
import * as learnedRepo from '../repos/siloLearned.repo';
import type { Learned, LearnedKind } from '../repos/siloLearned.repo';
import { withLearned } from '../engine/ontology/derive.ontology';
import { resolveEntities } from '../engine/ontology/resolve.ontology';
import { writtenTwoWays } from '../engine/ontology/written.ontology';
import { at } from '../engine/detectors/shared.detector';
import type { StoredField } from '../models/rowStore.model';
import type { Actor } from './scope.service';

const log = childLogger('silo-learned');

/**
 * Siloes (138) — what Silo has worked out about a kept concept, kept as tables.
 *
 * ── WORKED OUT ANYWAY, AND UNTIL NOW THROWN AWAY ──────────────────────────
 *
 * Every question about a concept two systems hold works out which record in
 * one is which record in the other, and which values the two write
 * differently. It was right each time and gone the moment the answer was
 * given: nothing could look at it, nothing else could use it, and a question
 * about one record could not draw on what ten thousand would have shown.
 *
 * For a concept somebody has chosen to keep, the same working is done once at
 * each copy, over the whole of it, and kept beside the copies:
 *
 *   matches   which record in each system is the same thing
 *   fields    which column in each system is each of the concept's fields
 *   values    the pairs of values two systems give for one field of the same
 *             records — and which of those are one thing written two ways
 *
 * ── FROM THE COPIES, BY THE SAME ENGINE A QUESTION USES ───────────────────
 *
 * `resolveEntities` and `writtenTwoWays`, over the rows already in the Silo.
 * Nothing is fetched from anybody's systems for this, and no second opinion
 * about what matches is formed here that a question would not form itself.
 *
 * ── A FAILURE HERE IS NOT A FAILURE TO COPY ───────────────────────────────
 *
 * The caller copies first. Whatever goes wrong here leaves the copy served
 * and the last tables standing.
 */

/* What each table holds. All of it names and identifiers but the values of a pair. */
const text = (name: string): StoredField => ({ name, type: 'string' });

export const SHAPES: Record<LearnedKind, StoredField[]> = {
  matches: [text('entity'), text('system'), text('connection_id'), text('object'), text('record')],
  fields: [text('field'), text('system'), text('connection_id'), text('object'), text('column'), text('origin')],
  values: [
    text('field'),
    text('system_a'),
    text('connection_a'),
    text('value_a'),
    text('system_b'),
    text('connection_b'),
    text('value_b'),
    { name: 'records', type: 'number' },
    { name: 'alike', type: 'boolean' },
    text('reads_as'),
  ],
};

/** The table a kind of working is kept in, beside the copies. */
export const tableOf = (kind: LearnedKind) => `silo_${kind}`;

/* How many pairs of values are kept for one field: the commonest. Past this a field is free text, not a vocabulary. */
const PAIRS_MOST = 500;
/* How many pairs read as one a question is handed. */
const ALIKE_MOST = 5_000;
/* How many rows go to the store at a time. */
const CHUNK = 20_000;

/**
 * An entity's name in the table: the same for the same record from one copy to
 * the next, and never the match key itself, which is a value from a record.
 */
const entityId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);

/**
 * Work out, from a kept concept's copies, what the tables hold — and keep it.
 *
 * AFTER A COPY, BY WHOEVER MADE IT. Where the concept's copies are not all
 * whole there is nothing to work from, and what was kept before is removed
 * rather than left to describe copies that are no longer served.
 */
export async function learn(actor: Actor, conceptId: string): Promise<Learned[]> {
  const tenant = { organisationId: actor.organisationId, membershipId: actor.membershipId };

  const found = await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      const concept = await conceptRepo.read(db, conceptId);
      if (!concept || concept.retiredAt) return null;

      const connectionIds = concept.objects.map((object) => object.connectionId);
      const manifests = await connectorRepo.load(db, connectionIds);
      /* As a question reads it: a field two systems were learned to share is one field here too. */
      const reading = withLearned({ objects: concept.objects, learned: await fieldAliasRepo.learnedFor(db, connectionIds) });

      return {
        reading,
        kept: await siloKeep.servable(db, concept.objects, concept.id, manifests),
        aliases: await resolutionRepo.confirmedFor(db, concept.id),
        names: new Map(manifests.map((one) => [one.connectionId, one.name])),
      };
    }),
  );

  if (!found?.kept) {
    await forget(actor.organisationId, conceptId);
    return [];
  }

  const { reading, kept } = found;
  const [first] = [...kept.values()];
  const home = { organisationId: actor.organisationId, siloId: first!.holding.siloId, conceptId, retentionDays: first!.holding.retentionDays };
  const system = (connectionId: string) => found.names.get(connectionId) ?? 'Unknown system';

  /* ── Which column is which field ───────────────────────────────────────── */

  const fields = reading.objects.flatMap((object) =>
    Object.entries(object.fieldMap)
      /* One name per column: the shared one, where an answer taught that two systems' fields are one. */
      .filter(([fieldPath]) => !(fieldPath in reading.superseded))
      .map(([fieldPath, column]) => ({
        field: fieldPath,
        system: system(object.connectionId),
        connection_id: object.connectionId,
        object: object.objectName,
        column,
        origin: reading.applied.some(
          (one) => one.connectionId === object.connectionId && one.objectName === object.objectName && one.sourceField === column && one.canonicalField === fieldPath,
        )
          ? 'learned'
          : 'mapped',
      })),
  );
  await write(home, 'fields', fields, { fields: new Set(fields.map((one) => one.field)).size });

  /* ── Which record is which, and which values are written two ways ──────── */

  if (reading.objects.length < 2) {
    /* One system holds it: there is nothing to match, and nothing two systems could write differently. */
    await forget(actor.organisationId, conceptId, ['matches', 'values']);
    return served(actor, conceptId);
  }

  const sources: Parameters<typeof resolveEntities>[0]['sources'] = [];
  for (const object of reading.objects) {
    const rows = await siloKeep.read(actor.organisationId, kept.get(object.connectionId)!, { filters: [], limit: siloKeep.LIMITS.rowsInMemory + 1 });

    if (rows.length > siloKeep.LIMITS.rowsInMemory) {
      /* More than can be matched here. Nothing is kept rather than a matching of part of it. */
      log.info({ conceptId, connectionId: object.connectionId }, 'A kept concept is too large to match in memory; its matches are not kept');
      await forget(actor.organisationId, conceptId, ['matches', 'values']);
      return served(actor, conceptId);
    }
    sources.push({ connectionId: object.connectionId, object, rows });
  }

  const resolution = resolveEntities({
    sources,
    aliases: found.aliases.map((alias) => ({ connectionA: alias.connectionA, valueRefA: alias.valueRefA, connectionB: alias.connectionB, valueRefB: alias.valueRefB })),
  });

  const objectOf = new Map(reading.objects.map((object) => [object.connectionId, object]));
  const alone: Record<string, number> = {};
  let shared = 0;

  const matches = resolution.entities.flatMap((entity) => {
    const held = new Set(entity.members.map((member) => member.connectionId));
    if (held.size > 1) shared += 1;
    else for (const connectionId of held) alone[connectionId] = (alone[connectionId] ?? 0) + 1;

    const entityRef = entityId(entity.key);
    return entity.members.map((member) => ({
      entity: entityRef,
      system: system(member.connectionId),
      connection_id: member.connectionId,
      object: objectOf.get(member.connectionId)?.objectName ?? '',
      record: member.ref,
    }));
  });
  await write(home, 'matches', matches, { entities: resolution.entities.length, shared, alone });

  /* A field only one system holds cannot be written two ways. */
  const both = [...new Set(fields.map((one) => one.field))].filter(
    (fieldPath) => reading.objects.filter((object) => fieldPath in object.fieldMap).length > 1,
  );

  const values = both.flatMap((fieldPath) =>
    writtenTwoWays(
      resolution.entities.map((entity) =>
        entity.members.flatMap((member) => {
          const column = objectOf.get(member.connectionId)?.fieldMap[fieldPath];
          return column ? [{ connectionId: member.connectionId, value: at(member.row, column) }] : [];
        }),
      ),
    )
      .slice(0, PAIRS_MOST)
      .map((pair) => ({
        field: fieldPath,
        system_a: system(pair.a.connectionId),
        connection_a: pair.a.connectionId,
        value_a: pair.a.value,
        system_b: system(pair.b.connectionId),
        connection_b: pair.b.connectionId,
        value_b: pair.b.value,
        records: pair.records,
        alike: pair.alike,
        reads_as: pair.readsAs,
      })),
  );
  await write(home, 'values', values, { pairs: values.length, alike: values.filter((one) => one.alike).length });

  return served(actor, conceptId);
}

/** What is being served of a concept's working. */
async function served(actor: Actor, conceptId: string): Promise<Learned[]> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction((db) => learnedRepo.forConcepts(db, [conceptId])),
  );
}

/**
 * Put one table in the store and serve it.
 *
 * THE NEW ONE IS WHOLE BEFORE THE OLD ONE GOES, as a copy is: the rows are
 * written under a batch of their own, and only then is that batch the one
 * served and the one before it removed.
 */
async function write(
  home: { organisationId: string; siloId: string; conceptId: string; retentionDays: number },
  kind: LearnedKind,
  rows: ReadonlyArray<Record<string, unknown>>,
  summary: Record<string, unknown>,
): Promise<void> {
  const batchId = generateId();
  const madeAt = new Date();
  const pointer = { organisationId: home.organisationId, siloId: home.siloId, conceptId: home.conceptId, kind, batchId, madeAt, rows: rows.length, summary };
  const tenant = { organisationId: home.organisationId, membershipId: null };

  if (rowStore.kind() === 'bigquery') {
    await rowStore.ensureObjects({
      organisationId: home.organisationId,
      sourceId: home.conceptId,
      objects: [{ name: tableOf(kind), fields: SHAPES[kind] }],
      retentionDays: home.retentionDays,
    });

    for (let from = 0; from < rows.length; from += CHUNK) {
      await bigquery.load({
        organisationId: home.organisationId,
        sourceId: home.conceptId,
        objectName: tableOf(kind),
        fileId: batchId,
        receivedAt: madeAt,
        fields: SHAPES[kind],
        rows: rows.slice(from, from + CHUNK).map((values, index) => ({ rowRef: String(from + index), values, methods: {} })),
      });
    }

    const replaced = await runWithTenant(tenant, () => withTransaction((db) => learnedRepo.serve(db, pointer)));
    if (replaced) {
      await bigquery.deleteRows({ organisationId: home.organisationId, sourceId: home.conceptId, objectName: tableOf(kind), where: { fileId: replaced } });
    }
    return;
  }

  await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      for (let from = 0; from < rows.length; from += CHUNK) {
        await learnedRepo.insertRows(db, { organisationId: home.organisationId, conceptId: home.conceptId, kind, batchId, at: madeAt, rows: rows.slice(from, from + CHUNK) });
      }
      await learnedRepo.serve(db, pointer);
    }),
  );
}

/**
 * Remove what was worked out about a concept: all of it, or some kinds.
 *
 * WHEN A CONCEPT STOPS BEING KEPT, and when its copies are no longer whole.
 * What is here describes the copies; without them it describes nothing.
 */
export async function forget(organisationId: string, conceptId: string, kinds?: readonly LearnedKind[]): Promise<void> {
  const gone = await runWithTenant({ organisationId, membershipId: null }, () => withTransaction((db) => learnedRepo.forget(db, conceptId, kinds)));

  if (rowStore.kind() === 'bigquery') {
    for (const one of gone) {
      await bigquery.deleteRows({ organisationId, sourceId: conceptId, objectName: tableOf(one.kind), where: 'all' });
    }
  }
}

/** A pair of values two systems write for one field of the same records, read as one thing. */
export type KnownPair = {
  fieldPath: string;
  a: { connectionId: string; value: string };
  b: { connectionId: string; value: string };
  /** How many records of the whole concept held the one where the other system held the other, at the last copy. */
  records: number;
  readsAs: string;
};

/**
 * The pairs of values read as one thing, for a question about this concept.
 *
 * ── WHY A QUESTION WANTS THEM ─────────────────────────────────────────────
 *
 * A question works out which values are one thing written two ways from its
 * own records, and believes a pair it has seen repeat. Asked about ONE
 * customer, it sees `UK` beside `United Kingdom` once, cannot tell a habit
 * from a slip, and reports a disagreement. The last copy saw that pair on four
 * hundred records. This is what the copy saw.
 *
 * ONLY THE PAIRS THAT ARE ONE THING BY HOW THEY ARE WRITTEN. A pair that
 * merely keeps turning up — `DE` beside `Germany`, `paid` beside `overdue` —
 * is kept in the table and is never read as agreement by this.
 */
export async function alikePairs(organisationId: string, values: Learned): Promise<KnownPair[]> {
  const rows =
    rowStore.kind() === 'bigquery'
      ? (
          await bigquery.read({
            organisationId,
            sourceId: values.conceptId,
            object: { name: tableOf('values'), fields: SHAPES.values },
            filters: [{ field: 'alike', op: 'eq', value: true }],
            sort: [],
            fields: [],
            limit: ALIKE_MOST,
            sinceReceived: values.madeAt,
            batch: { id: values.batchId, at: values.madeAt },
          })
        ).rows.map((row) => row.values)
      : await runWithTenant({ organisationId, membershipId: null }, () =>
          withTransaction((db) =>
            learnedRepo.readRows(db, { conceptId: values.conceptId, kind: 'values', batchId: values.batchId, where: { field: 'alike', equals: 'true' }, limit: ALIKE_MOST }),
          ),
        );

  return rows.map((row) => ({
    fieldPath: String(row.field),
    a: { connectionId: String(row.connection_a), value: String(row.value_a) },
    b: { connectionId: String(row.connection_b), value: String(row.value_b) },
    records: Number(row.records ?? 0),
    readsAs: String(row.reads_as),
  }));
}
