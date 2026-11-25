import { withTransaction } from '../infra/db.infra';
import * as bigquery from '../infra/bigquery.infra';
import { env } from '../config/env.config';
import { childLogger } from '../config/logger.config';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { isAppError, notFound, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, assertCleared, authorityOf, can } from './authorisation.service';
import { askComplete, readableIds } from './connector.service';
import { assertStorageOn, liveSilo } from './silo.service';
import * as rowStore from './rowStore.service';
import * as conceptRepo from '../repos/concept.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as holdingRepo from '../repos/siloHolding.repo';
import * as learnedRepo from '../repos/siloLearned.repo';
import * as readerRepo from '../repos/siloReader.repo';
import type { Copy, Difference, Holding, GroupKey, GroupMeasure, GroupRow, MarkerEvidence, StoreFilter } from '../repos/siloHolding.repo';
import type { StoredField, StoredFieldType } from '../models/rowStore.model';
import type { ContributingObject } from '../models/concept.model';
import type { Actor } from './scope.service';

const log = childLogger('silo-keep');

/**
 * Siloes (135) — a concept KEPT in a Silo: copied there, and read from there.
 *
 * ── WHY ANYTHING IS COPIED AT ALL ─────────────────────────────────────────
 *
 * Silo reads live, and a live read has a ceiling: a connector returns a few
 * thousand records at a time, and a question that would need more is refused
 * rather than answered from a part. An organisation with five million
 * invoices has questions about all of them. Keeping a concept in a Silo copies
 * every system's records of it into the organisation's own storage — BigQuery
 * in production — where the whole of it can be read and added up.
 *
 * ── OPTIONAL, AND SMALLER THAN IT SOUNDS ──────────────────────────────────
 *
 * Storage has to be switched on by a super admin, a Silo has to exist, and
 * somebody with `silo.manage` has to say "keep this concept". Nothing follows
 * from anything else: no concept is kept because a related one is, and an
 * organisation that keeps nothing never has a question touch the warehouse.
 *
 * ── A QUESTION READS THE COPY ONLY WHEN THE COPY IS WHOLE ─────────────────
 *
 * Every system the concept spans, copied and finished (`servable`). Otherwise
 * it reads live, as it always did. Half a customer list from a copy and half
 * live would be two different moments presented as one.
 *
 * ── AND IT SAYS IT DID ────────────────────────────────────────────────────
 *
 * A copy is as the systems were when it was made. The answer carries that
 * time, because "as of two this morning" is part of the figure.
 *
 * ── PAST COPIES, WHERE SOMEBODY ASKED FOR THEM (136) ──────────────────────
 *
 * A concept kept with `history` does not have each copy replace the last: every
 * finished one stays until it is older than the Silo's window. That is what
 * lets a question be asked of the copy made nearest a date, and of what
 * differs between two — neither of which most systems can answer of
 * themselves, because they hold what is true now and nothing of what was.
 *
 * ── AND BETWEEN COPIES, WHAT HAS CHANGED IS READ LIVE (137) ───────────────
 *
 * Each copy that finishes is compared with the one before, and the date field
 * every changed record carries a later value in is the field that system marks
 * change with — found from its own records, never from a name. A question can
 * then read live just the records marked since the copy and lay them over it:
 * an answer over a million records that is minutes old rather than a day.
 */

/* How many records are asked of a system at a time. At or under what a connector returns in one read. */
const SYNC_CHUNK = 5_000;
/* How many records one concept's copy of one system may hold. Past this the sync stops and says so. */
const SYNC_MOST = 5_000_000;
/* How old a copy may be before a scheduled run makes another. */
const SYNC_EVERY_HOURS = 24;
/*
 * How far from a moment a copy may have been made and still be the copy "of"
 * it. Copies are a day apart, so the nearest to any moment since they began is
 * within half of one; half as much again allows for a copy that ran late.
 */
const NEAR_HOURS = SYNC_EVERY_HOURS * 1.5;
/* How many changed records must bear a date field out before it is trusted to mark change. */
const MARKER_NEEDS = 5;
/* A field more than this share of records are recent in marks nothing worth asking by. */
const MARKER_MOST = 0.5;

/**
 * Catching a copy up with what has changed since it was made.
 *
 * `margin` IS HOW FAR BEFORE THE COPY A CHANGE IS STILL ASKED FOR: a system's
 * clock is not ours, and a record changed in the minutes around the copy must
 * be asked for twice rather than missed. `after` is how old a copy is before
 * catching it up is worth a read of the system; `most` how many changed
 * records one answer lays over a copy — past it the copy is answered as it
 * stands, and says so. An object so a test can lower them.
 */
export const FRESH = { margin: 10 * 60 * 1000, after: 5 * 60 * 1000, most: 2_000 };

/**
 * Which date field a system marks change with, from what two copies show.
 *
 * ── THE TEST IS THE QUESTION IT WILL BE USED TO ASK ───────────────────────
 *
 * "Would asking for records with this field after the earlier copy have found
 * every record that is new or different in the later one?" Every one, on at
 * least `MARKER_NEEDS` of them, or the field is not it: a single change it did
 * not mark is a change a caught-up answer would silently lack.
 *
 * A FIELD ALREADY HELD KEEPS ITS PLACE WHILE NOTHING CONTRADICTS IT, and its
 * evidence grows; one contradiction withdraws it. Where several fields pass,
 * the one fewest records are recent in — the tightest mark — is taken.
 */
export function markerOf(evidence: readonly MarkerEvidence[], held: { field: string; evidence: number } | null): { field: string; evidence: number } | null {
  const standing = held ? evidence.find((one) => one.field === held.field) : undefined;
  if (held && standing && standing.marked === standing.differ) return { field: held.field, evidence: held.evidence + standing.differ };

  const [proved] = evidence
    .filter((one) => one.differ >= MARKER_NEEDS && one.marked === one.differ && one.recent <= one.rows * MARKER_MOST)
    .sort((a, b) => a.recent - b.recent || (a.field < b.field ? -1 : 1));

  return proved ? { field: proved.field, evidence: proved.differ } : null;
}

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

/** The fields a copy holds, typed as the store types them. */
function fieldsOf(manifestFields: ReadonlyArray<{ name: string; type: string }>): StoredField[] {
  return manifestFields.map((field) => ({ name: field.name, type: rowStore.storedType(field.type as never) }));
}

/**
 * Keep a concept in a Silo: every system it spans, from the next copy on.
 *
 * `silo.manage`, STORAGE ON, AND CLEARED FOR THE CONCEPT — the same three
 * things nominating a field for capture needs, for the same reasons. Somebody
 * who cannot see a concept must not be able to make a copy of it.
 */
export async function keep(actor: Actor, input: { siloId: string; conceptId: string; history?: boolean }): Promise<Holding[]> {
  const { holdings, dropped } = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'silo.manage');
      await assertStorageOn(db, actor);
      const silo = await liveSilo(db, input.siloId);

      const concept = await conceptRepo.read(db, input.conceptId);
      if (!concept || concept.retiredAt) throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
      await assertCleared(db, authority, { type: 'concept', id: concept.id, conceptIds: [concept.id] });

      const readable = await readableIds(db, actor, concept.objects.map((object) => object.connectionId));
      if (concept.objects.some((object) => !readable.has(object.connectionId))) {
        throw refusal({
          message: `${concept.name} spans a system you cannot reach, so you cannot have a copy of it made.`,
          code: 'refusal.unreachable_source',
        });
      }

      /*
       * Siloes (139) — A SILO OTHER TOOLS READ SHOWS THEM WHATEVER IS KEPT IN
       * IT. Somebody reading its views is not asking through Silo, and sees
       * every field of every record a copy holds. So putting a further concept
       * where they will see it is the decision opening the Silo was, and is
       * made by who made that one.
       */
      const already = (await holdingRepo.forConcept(db, concept.id)).some((one) => one.siloId === silo.id);
      if (!already && (await readerRepo.forSilo(db, silo.id)).length > 0 && !can(authority, 'silo.enable')) {
        throw refusal({
          message: 'Other tools read this Silo, so a concept kept here is shown to them. A super admin keeps one here.',
          code: 'refusal.silo_read_by_others',
        });
      }

      for (const object of concept.objects) {
        await holdingRepo.keep(db, {
          organisationId: actor.organisationId,
          siloId: silo.id,
          conceptId: concept.id,
          connectionId: object.connectionId,
          objectName: object.objectName,
          keptBy: actor.membershipId,
          history: input.history ?? null,
        });
      }

      const holdings = await holdingRepo.forConcept(db, concept.id);

      /*
       * PAST COPIES TURNED OFF ARE PAST COPIES REMOVED, now and not at the next
       * sync: somebody who stops keeping them has said they no longer want
       * them held. The copy being served stays.
       */
      const dropped: Array<{ holding: Holding; batches: string[] }> = [];
      if (input.history === false) {
        for (const holding of holdings) {
          if (holding.batchId) dropped.push({ holding, batches: await holdingRepo.dropOtherBatches(db, holding.id, holding.batchId) });
        }
      }

      await writeAudit(db, {
        event: 'silo_concept_kept',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: {
          siloId: silo.id,
          conceptId: concept.id,
          connections: concept.objects.map((object) => object.connectionId),
          history: holdings.some((one) => one.history),
        },
      });

      return { holdings, dropped };
    }),
  );

  /* The Postgres stand-in's rows went in the transaction. BigQuery's are removed here, outside it. */
  if (rowStore.kind() === 'bigquery') {
    for (const { holding, batches } of dropped) {
      for (const fileId of batches) {
        await bigquery.deleteRows({ organisationId: actor.organisationId, sourceId: holding.id, objectName: holding.objectName, where: { fileId } });
      }
    }
  }

  return holdings;
}

/** Stop keeping a concept, and remove its copies. Its questions read live again from the next one. */
export async function release(actor: Actor, conceptId: string): Promise<void> {
  const held = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.manage');
      const released = await holdingRepo.release(db, conceptId);

      if (released.length > 0) {
        await writeAudit(db, {
          event: 'silo_concept_released',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { conceptId, connections: released.map((one) => one.connectionId) },
        });
      }
      return released;
    }),
  );

  /* The Postgres stand-in's rows went with the holdings. BigQuery's are removed here, outside the transaction. */
  if (rowStore.kind() === 'bigquery') {
    for (const one of held) {
      await bigquery.deleteRows({ organisationId: actor.organisationId, sourceId: one.id, objectName: one.objectName, where: 'all' });
    }
  }
}

/** What is kept of a concept, and how each system's copy stands. Readable by anybody who can reach the concept's systems. */
export async function status(actor: Actor, conceptId: string): Promise<Holding[]> {
  return runWithTenant(tenantOf(actor), () => withTransaction((db) => holdingRepo.forConcept(db, conceptId)));
}

/**
 * Copy a kept concept across now.
 *
 * ── EVERY RECORD, A CHUNK AT A TIME ───────────────────────────────────────
 *
 * A question may read a few thousand records of a system; a copy needs all of
 * them. So each system is read in order of its identifier, a chunk at a time,
 * each starting after the last record of the one before — which is a read any
 * source that can sort and compare can serve, however large the table.
 *
 * READ AS THE PERSON WHO ASKED FOR IT TO BE KEPT (or who pressed sync). A copy
 * holds what they may see and no more: a field hidden from them is never
 * fetched, so it is never stored.
 *
 * ── THE COPY BEING SERVED IS NOT TOUCHED UNTIL THE NEW ONE IS WHOLE ───────
 *
 * Each sync writes a new batch beside the old. Only when the last chunk has
 * landed is the holding pointed at it and the old batch removed. A sync that
 * fails halfway leaves yesterday's copy being served and says why.
 */
export async function sync(actor: Actor, conceptId: string): Promise<Holding[]> {
  const { concept, holdings, manifests } = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.manage');
      await assertStorageOn(db, actor);

      const concept = await conceptRepo.read(db, conceptId);
      if (!concept || concept.retiredAt) throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });

      const holdings = await holdingRepo.forConcept(db, conceptId);

      /*
       * ONE COPY AT A TIME. Two made at once would each finish and each claim
       * to be the one served; the second press, and a scheduled run that finds
       * one already going, wait for it instead.
       */
      if (holdings.some((one) => holdingRepo.beingCopied(one))) {
        throw refusal({ message: `A copy of ${concept.name} is already being made.`, code: 'refusal.copy_in_progress' });
      }

      /* Every system is spoken for from the start, so nothing else takes the concept up while the first is being read. */
      for (const holding of holdings) await holdingRepo.markSyncing(db, holding.id);

      return { concept, holdings, manifests: await connectorRepo.load(db, holdings.map((one) => one.connectionId)) };
    }),
  );

  for (const holding of holdings) {
    const object = concept.objects.find((one) => one.connectionId === holding.connectionId && one.objectName === holding.objectName);
    const described = manifests.find((one) => one.connectionId === holding.connectionId)?.manifest.objects.find((one) => one.name === holding.objectName);

    const tenant = <T,>(work: Parameters<typeof withTransaction<T>>[0]) => runWithTenant(tenantOf(actor), () => withTransaction(work));

    if (!object || !described) {
      await tenant((db) => holdingRepo.markFailed(db, holding.id, 'The concept no longer reads this object.'));
      continue;
    }

    await tenant((db) => holdingRepo.markSyncing(db, holding.id));

    const batchId = generateId();
    const at = new Date();
    const fields = fieldsOf(described.fields);

    try {
      await rowStore.ensureObjects({
        organisationId: actor.organisationId,
        sourceId: holding.id,
        objects: [{ name: holding.objectName, fields }],
        retentionDays: holding.retentionDays,
      });

      let copied = 0;
      let after: unknown;

      for (;;) {
        const answered = await askComplete({
          actor,
          connectionIds: [holding.connectionId],
          query: {
            object: holding.objectName,
            filters: after === undefined ? [] : [{ field: object.identifierField, op: 'gt', value: after }],
            sort: [{ field: object.identifierField, direction: 'asc' }],
            fields: [],
            limit: SYNC_CHUNK,
          },
        });
        const rows = answered.flatMap((one) => one.result?.rows ?? []);
        if (rows.length === 0) break;

        await write(actor.organisationId, holding, batchId, at, fields, rows);
        copied += rows.length;
        /* Still at it: a long copy says so as it goes, or it would be taken for an abandoned one. */
        if (copied % (SYNC_CHUNK * 20) === 0) await tenant((db) => holdingRepo.markSyncing(db, holding.id));

        const last = rows.at(-1)![object.identifierField];
        /* A chunk that did not move forward would be read again for ever. */
        if (rows.length < SYNC_CHUNK || last === undefined || last === null || last === after) break;
        after = last;

        if (copied >= SYNC_MOST) {
          throw refusal({
            message: `${holding.objectName} holds more than ${SYNC_MOST.toLocaleString('en-GB')} records, which is more than one copy may.`,
            code: 'bounds.silo_copy',
          });
        }
      }

      /*
       * WHICH FIELD THIS SYSTEM MARKS CHANGE WITH, weighed while both copies
       * are here. Undefined where it could not be weighed — no copy before, or
       * the comparison failed — and then whatever stood is left standing: not
       * being able to look is not evidence against.
       */
      let marker: { field: string; evidence: number } | null | undefined;
      if (holding.batchId && holding.syncedAt) {
        try {
          marker = markerOf(
            await weigh(actor.organisationId, {
              holding,
              fields,
              earlier: { id: holding.batchId, at: holding.syncedAt },
              later: { id: batchId, at },
              identifier: object.identifierField,
              candidates: fields.filter((field) => (field.type === 'date' || field.type === 'datetime') && field.name !== object.identifierField).map((field) => field.name),
              since: new Date(holding.syncedAt.getTime() - FRESH.margin),
            }),
            holding.changedField ? { field: holding.changedField, evidence: holding.changedEvidence } : null,
          );
        } catch (error) {
          log.warn({ holdingId: holding.id, err: error }, 'Two copies could not be compared for the field that marks change');
        }
      }

      /* With history the copy before stays, a dated copy of its own; without, this one replaces it. */
      const replaced = await tenant(async (db) => {
        await holdingRepo.markSynced(db, holding.id, { organisationId: actor.organisationId, batchId, rows: copied, at });
        if (marker !== undefined) await holdingRepo.setMarker(db, holding.id, marker);
        return holding.history ? [] : holdingRepo.dropOtherBatches(db, holding.id, batchId);
      });
      if (rowStore.kind() === 'bigquery') {
        for (const fileId of replaced) {
          await bigquery.deleteRows({ organisationId: actor.organisationId, sourceId: holding.id, objectName: holding.objectName, where: { fileId } });
        }
      }

      log.info({ holdingId: holding.id, rows: copied }, 'A kept concept was copied into its Silo');
    } catch (error) {
      /* What was being served before still is. The reason is kept in words, never a record's value. */
      const why = isAppError(error) ? error.message : 'The copy could not be made.';
      await tenant((db) => holdingRepo.markFailed(db, holding.id, why));
      log.warn({ holdingId: holding.id, err: error }, 'A kept concept could not be copied');

      /*
       * WHAT WAS WRITTEN OF THE COPY THAT DID NOT FINISH GOES NOW. It was never
       * served and is on no list of copies, so nothing would ever find it to
       * remove it — and where past copies are kept, the next copy does not
       * clear the others away either.
       */
      try {
        await tenant((db) => holdingRepo.dropBatch(db, holding.id, batchId));
        if (rowStore.kind() === 'bigquery') {
          await bigquery.deleteRows({ organisationId: actor.organisationId, sourceId: holding.id, objectName: holding.objectName, where: { fileId: batchId } });
        }
      } catch (cleanup) {
        log.warn({ holdingId: holding.id, err: cleanup }, 'What was written of a copy that failed could not be removed');
      }
    }
  }

  return status(actor, conceptId);
}

/** How old a copy may be before a scheduled run makes another. */
export const SYNC_EVERY = SYNC_EVERY_HOURS;

/**
 * What a Silo keeps whole, by concept, and how each system's copy stands.
 *
 * READABLE BY ANYBODY WHO CAN SEE THE SILO. That a copy exists, how many
 * records it holds and when it was made are facts about storage, like the
 * Silo's own usage; the records are not here.
 */
export async function keptIn(
  actor: Actor,
  siloId: string,
): Promise<
  Array<{
    conceptId: string;
    name: string;
    systems: Holding[];
    history: boolean;
    copies: number;
    since: Date | null;
    /** What was worked out from the last copy (138), as counts: records matched across systems, and pairs of values. */
    learned: Partial<Record<learnedRepo.LearnedKind, Record<string, unknown>>>;
  }>
> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const concepts = await conceptRepo.listLive(db);
      const held = (await holdingRepo.forConcepts(db, concepts.map((one) => one.id))).filter((one) => one.siloId === siloId);
      const copies = await holdingRepo.copiesOf(db, held.map((one) => one.id));
      const learned = await learnedRepo.forConcepts(db, [...new Set(held.map((one) => one.conceptId))]);

      return concepts
        .map((concept) => {
          const systems = held.filter((one) => one.conceptId === concept.id);
          const dated = datesOf(systems, copies);
          return {
            conceptId: concept.id,
            name: concept.name,
            systems,
            history: systems.some((one) => one.history),
            /* The dates every system has a copy of: what a question about the past can be asked of. */
            copies: dated.length,
            since: dated.at(-1) ?? null,
            learned: Object.fromEntries(learned.filter((one) => one.conceptId === concept.id).map((one) => [one.kind, one.summary])),
          };
        })
        .filter((one) => one.systems.length > 0);
    }),
  );
}

/**
 * The moments a kept concept can be asked about, newest first: one per copy of
 * its first system that every other system has a copy near.
 */
function datesOf(holdings: readonly Holding[], copies: readonly Copy[]): Date[] {
  const [first, ...rest] = holdings;
  if (!first) return [];

  return copies
    .filter((copy) => copy.holdingId === first.id)
    .filter((copy) => rest.every((other) => nearest(copies.filter((one) => one.holdingId === other.id), copy.copiedAt) !== null))
    .map((copy) => copy.copiedAt);
}

/** The copy made nearest a moment, if one was made near enough to be the copy of it. */
function nearest(copies: readonly Copy[], at: Date): Copy | null {
  let best: Copy | null = null;
  for (const copy of copies) {
    if (!best || Math.abs(copy.copiedAt.getTime() - at.getTime()) < Math.abs(best.copiedAt.getTime() - at.getTime())) best = copy;
  }
  return best && Math.abs(best.copiedAt.getTime() - at.getTime()) <= NEAR_HOURS * 60 * 60 * 1000 ? best : null;
}

/* ── The copy, as a question reads it ────────────────────────────────────── */

/**
 * One system's copy of a concept's records, ready to be read: which batch, and
 * the moment it is a picture of. `marker` is the field that system marks a
 * changed record with, where its copies have shown one — what the copy being
 * served can be caught up by.
 */
export type Kept = { holding: Holding; fields: StoredField[]; batchId: string; at: Date; marker: string | null };

/**
 * The copies a question about this concept may be answered from — or null.
 *
 * ALL OR NOTHING, AND NOT STALE. Every object the concept spans has a copy
 * that finished, inside the Silo's own retention window. Anything less and the
 * question reads live: a missing or lapsed copy is never a reason to answer
 * from part of one.
 *
 * NULL WHEREVER STORAGE IS OFF OR COMPILED OUT, before a single row is looked
 * for — which is every organisation that keeps nothing.
 */
export async function servable(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  objects: readonly ContributingObject[],
  conceptId: string,
  manifests: ReadonlyArray<{ connectionId: string; manifest: { objects: ReadonlyArray<{ name: string; fields: ReadonlyArray<{ name: string; type: string }> }> } }>,
): Promise<Map<string, Kept> | null> {
  if (!env.SILOES_AVAILABLE || rowStore.kind() === null) return null;

  const holdings = await holdingRepo.forConcept(db, conceptId);
  if (holdings.length === 0) return null;
  /* A Silo taken out of use, or storage switched off: nothing will copy this again, so it is read live. */
  if (holdings.some((one) => !one.live)) return null;

  const kept = new Map<string, Kept>();

  for (const object of objects) {
    const holding = holdings.find((one) => one.connectionId === object.connectionId && one.objectName === object.objectName);
    const described = manifests.find((one) => one.connectionId === object.connectionId)?.manifest.objects.find((one) => one.name === object.objectName);

    if (!holding || !described || holding.batchId === null || holding.syncedAt === null) return null;
    /* Past the Silo's window a copy can no longer be read, even before it is deleted. */
    if (holding.syncedAt.getTime() < Date.now() - holding.retentionDays * 24 * 60 * 60 * 1000) return null;

    kept.set(object.connectionId, {
      holding,
      fields: fieldsOf(described.fields),
      batchId: holding.batchId,
      at: holding.syncedAt,
      /* Only a field the system still has: one dropped from its description cannot be asked by. */
      marker: holding.changedField && described.fields.some((field) => field.name === holding.changedField) ? holding.changedField : null,
    });
  }

  return kept;
}

/**
 * The copies of a concept as it was at a moment (136) — or why there are none.
 *
 * ── NEVER ANSWERED FROM ANYTHING ELSE ─────────────────────────────────────
 *
 * `servable` returning null means "read live". There is no live reading of
 * last quarter: a question about a past moment that has no copy is refused,
 * and the caller is told what there is — whether the concept is kept at all,
 * whether its past copies are, and when the earliest one was made.
 *
 * THE COPY NEAREST THE MOMENT, for each system, and only if it is near. A copy
 * made twenty days later is not what the systems held then, and passing it off
 * as that is the thing this exists not to do. The answer says when the copy it
 * read was actually made.
 */
export async function servableAt(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  objects: readonly ContributingObject[],
  conceptId: string,
  manifests: ReadonlyArray<{ connectionId: string; manifest: { objects: ReadonlyArray<{ name: string; fields: ReadonlyArray<{ name: string; type: string }> }> } }>,
  at: Date,
): Promise<{ kept: Map<string, Kept> } | { none: 'not_kept' | 'no_history' | 'none_near'; earliest: Date | null }> {
  if (!env.SILOES_AVAILABLE || rowStore.kind() === null) return { none: 'not_kept', earliest: null };

  const holdings = await holdingRepo.forConcept(db, conceptId);
  if (holdings.length === 0 || holdings.some((one) => !one.live)) return { none: 'not_kept', earliest: null };

  const copies = await holdingRepo.copiesOf(db, holdings.map((one) => one.id));
  const earliest = datesOf(holdings, copies).at(-1) ?? null;
  const kept = new Map<string, Kept>();

  for (const object of objects) {
    const holding = holdings.find((one) => one.connectionId === object.connectionId && one.objectName === object.objectName);
    const described = manifests.find((one) => one.connectionId === object.connectionId)?.manifest.objects.find((one) => one.name === object.objectName);
    const copy = holding ? nearest(copies.filter((one) => one.holdingId === holding.id), at) : null;

    if (!holding || !described || !copy) {
      return { none: holdings.some((one) => one.history) ? 'none_near' : 'no_history', earliest };
    }

    /* A past copy is a picture of then: it is never caught up with now. */
    kept.set(object.connectionId, { holding, fields: fieldsOf(described.fields), batchId: copy.id, at: copy.copiedAt, marker: null });
  }

  return { kept };
}

/**
 * How much of a copy a question may bring back to work on.
 *
 * `rowsInMemory` IS WHERE THE WAREHOUSE TAKES OVER. Up to it, a copy is read
 * and resolved, merged and totalled exactly as live rows are. Past it, the
 * figures are worked out IN the store and only a page of records comes back —
 * which is what lets "invoices by month" be asked of five million of them.
 * An object so a test can lower it rather than make a quarter of a million rows.
 */
export const LIMITS = {
  rowsInMemory: 250_000,
  page: 1_000,
  groups: 500,
  /* How many records that differ between two copies one answer lists, per system. Past it the answer is the counts, as a refusal. */
  changed: 5_000,
  /* How many records that have gone since the earlier copy are named. Every one of them is counted. */
  gone: 50,
};

/**
 * A value as the store writes it when it names a group by it.
 *
 * FOR ADDING LIVE RECORDS TO GROUPS THE STORE COUNTED. A record read live has
 * to land in the group the store would have put it in, so its value is written
 * the way the store writes one: as it is, except that BigQuery writes a number
 * without the trailing zeros a system may have sent it with.
 */
export function groupText(value: unknown, type: StoredFieldType | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (type === 'number' && rowStore.kind() === 'bigquery' && Number.isFinite(Number(value))) return String(Number(value));
  return String(value);
}

/* The comparisons a copy can apply. A question using any other reads live. */
const STORE_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null']);

export const canFilter = (filters: ReadonlyArray<{ op: string }>) => filters.every((filter) => STORE_OPERATORS.has(filter.op));

async function write(
  organisationId: string,
  holding: Holding,
  batchId: string,
  at: Date,
  fields: StoredField[],
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  if (rowStore.kind() === 'bigquery') {
    await bigquery.load({
      organisationId,
      sourceId: holding.id,
      objectName: holding.objectName,
      fileId: batchId,
      receivedAt: at,
      fields,
      rows: rows.map((values, index) => ({ rowRef: String(index), values, methods: {} })),
    });
    return;
  }

  await runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) => holdingRepo.insertRows(db, { organisationId, holdingId: holding.id, batchId, at, rows })),
  );
}

/** Rows of a copy, with the question's own conditions applied in the store. */
export async function read(
  organisationId: string,
  kept: Kept,
  input: { filters: readonly StoreFilter[]; limit: number; sort?: ReadonlyArray<{ field: string; direction: 'asc' | 'desc' }> },
): Promise<Array<Record<string, unknown>>> {
  const { holding, fields } = kept;

  if (rowStore.kind() === 'bigquery') {
    const result = await bigquery.read({
      organisationId,
      sourceId: holding.id,
      object: { name: holding.objectName, fields },
      filters: [...input.filters] as never,
      sort: [...(input.sort ?? [])],
      fields: [],
      limit: input.limit,
      sinceReceived: kept.at,
      /* Only this copy: one being written beside it, or kept from another day, is not it. */
      batch: { id: kept.batchId, at: kept.at },
    });
    return result.rows.map((row) => row.values);
  }

  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) =>
      holdingRepo.readRows(db, {
        holdingId: holding.id,
        batchId: kept.batchId,
        fields,
        filters: input.filters,
        ...(input.sort ? { sort: input.sort } : {}),
        limit: input.limit,
      }),
    ),
  );
}

/** A copy added up by group, in the store. The reason a copy is worth keeping. */
export async function summarise(
  organisationId: string,
  kept: Kept,
  input: { filters: readonly StoreFilter[]; groupBy: readonly GroupKey[]; measures: readonly GroupMeasure[]; limit: number },
): Promise<GroupRow[]> {
  const { holding, fields } = kept;

  if (rowStore.kind() === 'bigquery') {
    const result = await bigquery.summarise({
      organisationId,
      sourceId: holding.id,
      batch: { id: kept.batchId, at: kept.at },
      object: { name: holding.objectName, fields },
      filters: [...input.filters] as never,
      groupBy: [...input.groupBy],
      measures: [...input.measures],
      limit: input.limit,
    });
    return result.rows;
  }

  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) =>
      holdingRepo.summarise(db, {
        holdingId: holding.id,
        batchId: kept.batchId,
        fields,
        filters: input.filters,
        groupBy: input.groupBy,
        measures: input.measures,
        limit: input.limit,
      }),
    ),
  );
}

/** Weigh each date field of two copies as the system's mark of change, in whichever store holds them. */
async function weigh(
  organisationId: string,
  input: {
    holding: Holding;
    fields: StoredField[];
    earlier: { id: string; at: Date };
    later: { id: string; at: Date };
    identifier: string;
    candidates: string[];
    since: Date;
  },
): Promise<MarkerEvidence[]> {
  if (input.candidates.length === 0) return [];

  if (rowStore.kind() === 'bigquery') {
    return bigquery.markerEvidence({
      organisationId,
      sourceId: input.holding.id,
      object: { name: input.holding.objectName, fields: input.fields },
      earlier: input.earlier,
      later: input.later,
      identifier: input.identifier,
      candidates: input.candidates,
      since: input.since,
    });
  }

  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) =>
      holdingRepo.markerEvidence(db, {
        holdingId: input.holding.id,
        earlier: input.earlier.id,
        later: input.later.id,
        identifier: input.identifier,
        candidates: input.candidates,
        since: input.since,
      }),
    ),
  );
}

/* ── What differs between two copies (136) ───────────────────────────────── */

/** What a comparison of two copies is asked: which field says a record is the same record, and whose change counts. */
type Compared = {
  earlier: Kept;
  later: Kept;
  identifier: string;
  /** The fields whose change makes a record "changed": named by the caller, who knows which the asker may see. */
  watch: readonly string[];
  /** The question's own conditions, on a record as it is now — or as it last was, where it has gone. */
  filters: readonly StoreFilter[];
};

/**
 * How many records were added, removed and changed between two copies of one
 * system's records, and which fields changed in how many — counted in the store.
 */
export async function difference(organisationId: string, input: Compared): Promise<Difference> {
  const { holding, fields } = input.later;
  const watch = [...input.watch];

  if (rowStore.kind() === 'bigquery') {
    return bigquery.difference({
      organisationId,
      sourceId: holding.id,
      object: { name: holding.objectName, fields },
      earlier: { id: input.earlier.batchId, at: input.earlier.at },
      later: { id: input.later.batchId, at: input.later.at },
      identifier: input.identifier,
      watch,
      filters: [...input.filters] as never,
    });
  }

  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) =>
      holdingRepo.difference(db, {
        holdingId: holding.id,
        earlier: input.earlier.batchId,
        later: input.later.batchId,
        identifier: input.identifier,
        fields,
        watch,
        filters: input.filters,
      }),
    ),
  );
}

/** Which records differ between two copies: those still held (new, or changed), or those gone. */
export async function differing(
  organisationId: string,
  input: Compared & { which: holdingRepo.Differing; limit: number },
): Promise<Array<{ ref: string; added: boolean }>> {
  const { holding, fields } = input.later;
  const watch = [...input.watch];

  if (rowStore.kind() === 'bigquery') {
    return bigquery.differing({
      organisationId,
      sourceId: holding.id,
      object: { name: holding.objectName, fields },
      earlier: { id: input.earlier.batchId, at: input.earlier.at },
      later: { id: input.later.batchId, at: input.later.at },
      identifier: input.identifier,
      watch,
      filters: [...input.filters] as never,
      which: input.which,
      limit: input.limit,
    });
  }

  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) =>
      holdingRepo.differing(db, {
        holdingId: holding.id,
        earlier: input.earlier.batchId,
        later: input.later.batchId,
        identifier: input.identifier,
        fields,
        watch,
        filters: input.filters,
        which: input.which,
        limit: input.limit,
      }),
    ),
  );
}
