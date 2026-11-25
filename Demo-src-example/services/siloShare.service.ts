import { withTransaction } from '../infra/db.infra';
import * as bigquery from '../infra/bigquery.infra';
import { childLogger } from '../config/logger.config';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, assertCleared, authorityOf } from './authorisation.service';
import { assertStorageOn, liveSilo } from './silo.service';
import * as rowStore from './rowStore.service';
import { SHAPES, tableOf } from './siloLearned.service';
import * as conceptRepo from '../repos/concept.repo';
import * as connectorRepo from '../repos/connector.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as siloRepo from '../repos/silo.repo';
import * as holdingRepo from '../repos/siloHolding.repo';
import * as learnedRepo from '../repos/siloLearned.repo';
import * as readerRepo from '../repos/siloReader.repo';
import type { Reader, ReaderKind } from '../repos/siloReader.repo';
import { storageAllowed } from '../models/organisation.model';
import type { Actor } from './scope.service';

const log = childLogger('silo-share');

/**
 * Siloes (139) — a Silo read by other tools.
 *
 * ── WHAT A READER IS GIVEN, AND WHAT THEY ARE NOT ─────────────────────────
 *
 * A Silo that keeps concepts whole is a warehouse, and an organisation wants
 * its reporting tool to read it. A super admin names a Google identity — a
 * person, a group, a service account — and that identity may then read a
 * dataset holding nothing but VIEWS of this one Silo:
 *
 *   <concept>__<system>            the copy of that system's records being served
 *   <concept>__<system>__history   every finished copy, where past copies are kept
 *   <concept>__matches             which record in each system is the same thing
 *   <concept>__fields              which column in each system is which field
 *   <concept>__values              the pairs of values the systems write differently
 *
 * Never the tables. Those hold every batch — the one being written, the past
 * ones nobody asked to be shown — and every other Silo's records beside them.
 *
 * ── A READER SEES EVERYTHING THE COPIES HOLD, AND SILO IS NOT IN THE WAY ──
 *
 * A copy holds the fields whoever had it made could see. A question asked
 * through Silo is then narrowed again to what the asker may see. A tool
 * reading the views is not asking through Silo: it sees every field of every
 * record in them. That is why opening a Silo is a super admin's decision, why
 * they must be cleared for every concept in it, why keeping a further concept
 * in a Silo that is read is a super admin's too, and why it is said on the
 * page and in the disclosure in those words.
 *
 * ── ONLY WHERE THE SILO IS IN BIGQUERY ────────────────────────────────────
 *
 * Other tools read a warehouse, not Silo's own database. Where the copies are
 * held in the Postgres stand-in there is nothing for them to connect to, and
 * this says so rather than pretending.
 */

export type Readers = {
  /** Whether other tools can read a Silo in this deployment at all. */
  available: boolean;
  /** Where a reader points their tool: the project and dataset. Null where nobody is on the list. */
  address: string | null;
  readers: Reader[];
};

const available = () => rowStore.kind() === 'bigquery';

/** Who may read a Silo from outside, and where. For anybody who may manage it. */
export async function readers(actor: Actor, siloId: string): Promise<Readers> {
  const listed = await runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => {
      assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.manage');
      const silo = await siloRepo.find(db, siloId);
      if (!silo) throw notFound({ message: 'No such Silo.', code: 'missing.silo' });
      return readerRepo.forSilo(db, siloId);
    }),
  );

  return { available: available(), address: available() && listed.length > 0 ? bigquery.readAddress(actor.organisationId, siloId) : null, readers: listed };
}

/**
 * Let a Google identity read a Silo's views.
 *
 * `silo.enable`, WHICH IS THE PERMISSION THAT SWITCHES STORAGE ON, because it
 * is the same weight of decision: records leaving Silo's own gates. And
 * cleared for every concept the Silo keeps, since they are about to show every
 * one of them to somebody else.
 *
 * THE LIST FIRST, THEN BIGQUERY, AND THE LIST PUT BACK IF BIGQUERY REFUSES. An
 * address that is not a Google identity is only found out by asking, and a
 * name on the list that was given nothing is worse than no name.
 */
export async function grant(actor: Actor, input: { siloId: string; kind: ReaderKind; email: string }): Promise<Readers> {
  if (!available()) {
    throw refusal({
      message: 'Other tools read a Silo where its copies are held in BigQuery, which this deployment’s are not.',
      code: 'refusal.share_unavailable',
    });
  }

  const email = input.email.trim().toLowerCase();

  const added = await runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'silo.enable');
      await assertStorageOn(db, actor);
      const silo = await liveSilo(db, input.siloId);

      const conceptIds = [...new Set((await holdingRepo.inSilo(db, silo.id)).map((one) => one.conceptId))];
      for (const conceptId of conceptIds) await assertCleared(db, authority, { type: 'concept', id: conceptId, conceptIds: [conceptId] });

      const reader = await readerRepo.add(db, { organisationId: actor.organisationId, siloId: silo.id, kind: input.kind, email, grantedBy: actor.membershipId });
      if (!reader) throw invalid({ message: `${email} can already read this Silo.`, code: 'invalid.reader_exists' });

      await writeAudit(db, {
        event: 'silo_reader_granted',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { siloId: silo.id, kind: input.kind, email },
      });
      return reader;
    }),
  );

  try {
    await publish(actor.organisationId, input.siloId);
  } catch (error) {
    await runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
      withTransaction(async (db) => {
        await readerRepo.remove(db, input.siloId, added.id);
        await writeAudit(db, {
          event: 'silo_reader_revoked',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { siloId: input.siloId, kind: input.kind, email, reason: 'refused' },
        });
      }),
    );
    /* Whoever was on the list before is still to have what they had. */
    await publish(actor.organisationId, input.siloId).catch((again: unknown) => {
      log.warn({ siloId: input.siloId, err: again }, 'A Silo’s readers could not be put back as they were');
    });

    log.warn({ siloId: input.siloId, err: error }, 'BigQuery did not accept a reader');
    throw refusal({
      message: `${email} could not be given access. Check that it is the address of a Google account, group or service account, of the kind chosen.`,
      code: 'refusal.share_failed',
    });
  }

  return readers(actor, input.siloId);
}

/**
 * Stop an identity reading a Silo's views.
 *
 * `silo.manage`: TAKING ACCESS AWAY IS NEVER HARDER THAN IT NEEDS TO BE, and
 * needs nobody to have read anything. The last name off the list removes the
 * dataset of views altogether.
 */
export async function revoke(actor: Actor, input: { siloId: string; readerId: string }): Promise<Readers> {
  await runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(async (db) => {
      assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.manage');

      const gone = await readerRepo.remove(db, input.siloId, input.readerId);
      if (!gone) throw notFound({ message: 'That is not somebody who can read this Silo.', code: 'missing.silo_reader' });

      await writeAudit(db, {
        event: 'silo_reader_revoked',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { siloId: input.siloId, kind: gone.kind, email: gone.email, reason: 'removed' },
      });
    }),
  );

  /* The name is off the list whatever happens next; a failure here is said, not swallowed, because access may still stand. */
  if (available()) await publish(actor.organisationId, input.siloId);

  return readers(actor, input.siloId);
}

/**
 * Bring a Silo's views up to date with what it keeps. After a copy, and after
 * a concept starts or stops being kept.
 *
 * NOTHING HAPPENS FOR A SILO NOBODY READS, which is nearly all of them: the
 * list is looked at and that is the end of it.
 */
export async function refresh(organisationId: string, siloId: string): Promise<void> {
  if (!available()) return;
  await publish(organisationId, siloId);
}

/* A name for a view from what people call things: lower case, digits and underscores, starting with a letter. */
function named(text: string): string {
  const plain = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return /^[a-z]/.test(plain) ? plain : `v_${plain || 'unnamed'}`;
}

/**
 * Make BigQuery match the list and what the Silo keeps.
 *
 * ── ACCESS FIRST, THEN VIEWS ──────────────────────────────────────────────
 *
 * Somebody taken off the list loses access before anything else is done, and
 * somebody added to it finds the views appearing rather than a dataset whose
 * access was changed last.
 *
 * ── ONLY A CONCEPT THAT IS WHOLE ──────────────────────────────────────────
 *
 * The same rule a question follows: every system the concept spans, copied
 * and finished. Half a concept is not shown to a tool any more than it is
 * answered from.
 */
async function publish(organisationId: string, siloId: string): Promise<void> {
  const state = await runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      const listed = await readerRepo.forSilo(db, siloId);
      const silo = await siloRepo.find(db, siloId);
      const organisation = await organisationRepo.findById(db, organisationId);
      const open = Boolean(silo && !silo.disabledAt && organisation && storageAllowed(organisation));

      const holdings = open && listed.length > 0 ? await holdingRepo.inSilo(db, siloId) : [];
      const conceptIds = [...new Set(holdings.map((one) => one.conceptId))];

      return {
        /* A Silo taken out of use, or storage switched off, shows nothing — and shows it again when it is back. */
        readers: open ? listed : [],
        holdings,
        concepts: (await conceptRepo.listLive(db)).filter((one) => conceptIds.includes(one.id)),
        manifests: await connectorRepo.load(db, [...new Set(holdings.map((one) => one.connectionId))]),
        copies: await holdingRepo.copiesOf(db, holdings.map((one) => one.id)),
        learned: await learnedRepo.forConcepts(db, conceptIds),
      };
    }),
  );

  if (state.readers.length === 0) {
    await bigquery.dropReadDataset(organisationId, siloId);
    return;
  }

  await bigquery.ensureReadDataset(organisationId, siloId);
  await bigquery.setReaders(organisationId, siloId, state.readers);

  const taken = new Set<string>();
  const unique = (wanted: string, id: string) => {
    const name = taken.has(wanted) ? `${wanted}_${id.replace(/-/g, '').slice(0, 8)}` : wanted;
    taken.add(name);
    return name;
  };

  for (const concept of state.concepts) {
    const mine = state.holdings.filter((one) => one.conceptId === concept.id);
    /* Whole, or not shown. */
    if (mine.some((one) => !one.batchId || !one.syncedAt)) continue;

    for (const holding of mine) {
      const connection = state.manifests.find((one) => one.connectionId === holding.connectionId);
      const described = connection?.manifest.objects.find((one) => one.name === holding.objectName);
      if (!connection || !described || !holding.batchId || !holding.syncedAt) continue;

      const view = { organisationId, siloId, sourceId: holding.id, objectName: holding.objectName, fields: described.fields.map((field) => field.name) };
      const name = unique(`${named(concept.name)}__${named(connection.name)}`, holding.id);
      await bigquery.replaceView({ ...view, name, batches: [{ id: holding.batchId, at: holding.syncedAt }] });

      if (holding.history) {
        const past = state.copies.filter((one) => one.holdingId === holding.id).map((one) => ({ id: one.id, at: one.copiedAt }));
        if (past.length > 0) await bigquery.replaceView({ ...view, name: unique(`${name}__history`, holding.id), batches: past });
      }
    }

    for (const table of state.learned.filter((one) => one.conceptId === concept.id)) {
      await bigquery.replaceView({
        organisationId,
        siloId,
        name: unique(`${named(concept.name)}__${table.kind}`, table.id),
        sourceId: concept.id,
        objectName: tableOf(table.kind),
        fields: SHAPES[table.kind].map((field) => field.name),
        batches: [{ id: table.batchId, at: table.madeAt }],
      });
    }
  }

  /* A concept no longer kept, or no longer whole, is no longer shown. */
  await bigquery.dropViewsExcept(organisationId, siloId, [...taken]);
}
