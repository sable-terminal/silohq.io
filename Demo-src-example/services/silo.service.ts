import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { denial, invalid, notFound, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, assertCleared, authorityOf, can } from './authorisation.service';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { env } from '../config/env.config';
import { checkMarkings } from '../utils/markingCheck.util';
import * as siloRepo from '../repos/silo.repo';
import * as conceptRepo from '../repos/concept.repo';
import * as authzRepo from '../repos/authz.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as capture from './capture.service';
import { storageAllowed } from '../models/organisation.model';
import type { Actor } from './scope.service';
import { createHash } from 'node:crypto';
import { STORAGE_DISCLOSURE } from '../models/storageDisclosure.model';
import * as approvalRepo from '../repos/approval.repo';
import { APPROVAL_TTL_HOURS } from '../config/constants.config';
import * as objectStore from '../infra/objectStore.infra';
import * as siloImportRepo from '../repos/siloImport.repo';
import * as siloRowRepo from '../repos/siloRow.repo';
import * as siloExtractionRepo from '../repos/siloExtraction.repo';
import * as connectionRepo from '../repos/connection.repo';
import * as rowStore from './rowStore.service';
import { siloDefinition } from '../schemas/siloDefinition.schema';

const log = childLogger('silo');

type Db = Parameters<Parameters<typeof withTransaction>[0]>[0];

/**
 * §10 — Siloes. Capture.
 *
 * ── Zero persistence is the default ────────────────────────────────────────
 *
 * A Silo is storage the customer switches on DELIBERATELY, for a stated
 * purpose, over concepts they nominate one at a time. Compiled out of the
 * sovereign build entirely: off means unreachable, not idle.
 *
 * ── Why it exists at all ───────────────────────────────────────────────────
 *
 * A federated query sees the current state of a source and discards it. Where a
 * source overwrites rather than appends, the change is gone — a value said one
 * thing yesterday and says another today, and nothing recorded the transition.
 * Three detectors need that record; the other seven run federated and always
 * will.
 *
 * IT STORES TRANSITIONS, NOT RECORDS. An entity reference, a field, the value
 * before and after, when and from where. Nothing else from the row.
 */

/* ── §3 Enabling, in three explicit steps ────────────────────────────────── */

/**
 * Step one: the organisation-level switch.
 *
 * `silo.enable` IS SUPER ADMIN ONLY AND NOT DELEGABLE. This changes the
 * deployment's security posture — it is the difference between a product that
 * holds none of your values and one that holds some — and that belongs with
 * clearance rather than with ordinary administration.
 */
/**
 * §11 — the version of the disclosure, so an acknowledgement names what was read.
 *
 * A HASH OF THE WORDS, NOT A NUMBER SOMEBODY BUMPS. Editing a sentence changes it
 * whether or not anybody remembers to, so an organisation that acknowledged the
 * old text is asked again rather than being held to words it never saw.
 */
const DISCLOSURE_VERSION = createHash('sha256')
  .update(STORAGE_DISCLOSURE.join('\n\n'))
  .digest('hex');

/**
 * §11 — whether storage is on, and exactly what switching it on means.
 *
 * NO PERMISSION BEYOND BELONGING TO THE ORGANISATION. The same words are on the
 * public security page, and whether an organisation stores anything is something
 * every member of it is entitled to know.
 */
export async function storage(actor: Actor): Promise<{
  enabled: boolean;
  region: string;
  disclosure: { paragraphs: readonly string[]; version: string };
}> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const organisation = await organisationRepo.findById(db, actor.organisationId);
        return {
          enabled: organisation ? storageAllowed(organisation) : false,
          region: env.CELL_REGION,
          disclosure: { paragraphs: STORAGE_DISCLOSURE, version: DISCLOSURE_VERSION },
        };
      }),
  );
}

/**
 * §3 — the organisation's switch. `silo.enable`, super admin only.
 *
 * ── §11: SHOWN ONCE AT ENABLE, AND PROVABLY ────────────────────────────────
 *
 * Switching on requires the version of the disclosure the person was shown. A
 * screen that displays the text is a design; a switch that refuses without an
 * acknowledgement of the current text is a guarantee — and the audit row records
 * which words were agreed to, so "what were we told" has an answer years later.
 *
 * SWITCHING OFF NEEDS NO ACKNOWLEDGEMENT. Nobody has to read anything to stop
 * storing data.
 */
export async function setStorageEnabled(
  actor: Actor,
  input: { enabled: boolean; acknowledgedDisclosure?: string },
): Promise<void> {
  if (!env.SILOES_AVAILABLE) {
    throw refusal({
      message: 'This deployment is built without storage. There is nothing to enable.',
      code: 'refusal.siloes_compiled_out',
    });
  }

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.enable');

        if (input.enabled && input.acknowledgedDisclosure !== DISCLOSURE_VERSION) {
          throw invalid({
            message:
              'Read what storage keeps before switching it on. The disclosure has to be ' +
              'acknowledged, and it may have changed since it was last shown.',
            code: 'invalid.disclosure_not_acknowledged',
            detail: { version: DISCLOSURE_VERSION },
          });
        }

        await organisationRepo.setStorageEnabled(db, actor.organisationId, input.enabled);

        await writeAudit(db, {
          event: input.enabled ? 'silo_enabled' : 'silo_disabled',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            enabled: input.enabled,
            disclosureVersion: input.enabled ? DISCLOSURE_VERSION : null,
          },
        });
      }),
  );
}

/**
 * Step two: a Silo, with a purpose and a retention window.
 *
 * RETENTION IS REQUIRED AND NEVER DEFAULTED SILENTLY. A window nobody chose is
 * a window nobody agreed to, and how long data is kept is the first question
 * anybody asks about storing it.
 */
export async function create(
  actor: Actor,
  input: { name: string; purpose: string; retentionDays: number },
): Promise<siloRepo.Silo> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.create');

        await assertStorageOn(db, actor);

        const silo = await siloRepo.create(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          name: input.name.trim(),
          purpose: input.purpose.trim(),
          retentionDays: input.retentionDays,
          createdBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'silo_created',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { siloId: silo.id, retentionDays: silo.retentionDays },
        });

        return silo;
      }),
  );
}

/**
 * Step three: one concept, with the fields to capture named.
 *
 * ── NOTHING CASCADES ───────────────────────────────────────────────────────
 *
 * The relationship graph is connected, so transitive enabling would reach most
 * of the estate in two hops. A customer who enabled capture on one thing must
 * not discover they are storing twenty. Related concepts are PROPOSED, with the
 * relationship shown, and each needs its own confirmation.
 *
 * ── THE MARKING CHECK IS AT ADD TIME ───────────────────────────────────────
 *
 * Somebody holding `silo.manage` who lacks clearance on a concept cannot add
 * it. Doing so would create a store of data they cannot see — and the person
 * who can see it never agreed to it being kept.
 */
export async function addConcept(
  actor: Actor,
  input: { siloId: string; conceptId: string; fields: string[] },
): Promise<siloRepo.SiloConcept> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.manage');

        await assertStorageOn(db, actor);
        const silo = await liveSilo(db, input.siloId);
        const concept = await capturableConcept(db, authority, input.conceptId, input.fields);

        /*
         * ONE LIVE SILO PER CONCEPT. Two Siloes nominating one concept made which
         * of them captured it an accident of row order, and split its history
         * between them. Moving a concept is a remove and an add, both audited.
         */
        const holder = await siloRepo.nominatedBy(db, input.conceptId);
        if (holder) {
          throw invalid({
            message:
              holder.siloId === silo.id
                ? `${concept.name} is already captured by this Silo.`
                : `${concept.name} is already captured by ${holder.name}. A concept is captured into one Silo; remove it there first.`,
            code: 'invalid.concept_already_captured',
            detail: { siloId: holder.siloId },
          });
        }

        const added = await siloRepo.addConcept(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          siloId: silo.id,
          conceptId: input.conceptId,
          nominatedFields: [...new Set(input.fields)],
          addedBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'silo_concept_added',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { siloId: silo.id, conceptId: input.conceptId, fields: added.nominatedFields },
        });

        return added;
      }),
  );
}

/**
 * §4 — change which fields of a nominated concept are captured.
 *
 * THE SAME GATES AS NOMINATING IT. Widening the list creates more stored data,
 * so the marking check and the field check apply exactly as they did at add
 * time. Narrowing deletes nothing: what was captured for a dropped field stays
 * until the window or a purge takes it, and the disclosure keeps saying so.
 */
export async function setFields(
  actor: Actor,
  input: { siloId: string; conceptId: string; fields: string[] },
): Promise<{ conceptId: string; nominatedFields: string[]; previousFields: string[] }> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.manage');

        await assertStorageOn(db, actor);
        const silo = await liveSilo(db, input.siloId);
        await capturableConcept(db, authority, input.conceptId, input.fields);

        const fields = [...new Set(input.fields)];
        const previous = await siloRepo.setNominatedFields(db, silo.id, input.conceptId, fields);

        if (!previous) {
          throw notFound({
            message: 'That concept is not being captured by this Silo.',
            code: 'missing.silo_concept',
          });
        }

        await writeAudit(db, {
          event: 'silo_fields_changed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            siloId: silo.id,
            conceptId: input.conceptId,
            fields,
            previousFields: previous,
          },
        });

        return { conceptId: input.conceptId, nominatedFields: fields, previousFields: previous };
      }),
  );
}

/**
 * The checks that make a concept's fields capturable by this person.
 *
 * MARKING CHECK AT ADD TIME, and at every widening after it. A person holding
 * `silo.manage` who lacks clearance on a concept cannot nominate it: doing so
 * would create a store of data they cannot see.
 */
async function capturableConcept(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  authority: Awaited<ReturnType<typeof authorityOf>>,
  conceptId: string,
  fields: string[],
) {
  const concept = await conceptRepo.read(db, conceptId);
  if (!concept || concept.retiredAt) {
    throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
  }

  const required = await authzRepo.markingsOnResource(db, 'concept', conceptId);
  if (!checkMarkings({ required }, { held: authority.clearances }).permitted) {
    throw denial({
      message:
        'You cannot capture a concept you are not cleared to see. Doing so would create a ' +
        'store of data you have no access to.',
      code: 'denial.clearance',
    });
  }

  /* A field no system maps can never produce a transition, and the failure
     would appear much later as a Silo that captured nothing. */
  const known = new Set(concept.objects.flatMap((one) => Object.keys(one.fieldMap)));
  const unknown = fields.filter((one) => !known.has(one));

  if (unknown.length > 0) {
    throw invalid({
      message: `${concept.name} has no field called ${unknown.join(' or ')}.`,
      code: 'invalid.unknown_field',
      detail: { fields: unknown },
    });
  }

  return concept;
}

/**
 * §3 — what ELSE could be captured, offered rather than taken.
 *
 * The relationship is shown so the choice is informed: "invoices relate to
 * suppliers" is the reason somebody would want both, and it is also the reason
 * enabling both without asking would be indefensible.
 *
 * A CONCEPT THE PERSON IS NOT CLEARED FOR IS NOT OFFERED. Dropped, not refused:
 * proposing it would tell them a compartmented concept exists and is related to
 * something they can see, and the add would refuse them anyway.
 */
export async function candidates(
  actor: Actor,
  siloId: string,
): Promise<Array<{ conceptId: string; name: string; relatedTo: string; via: string }>> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.manage');

        await liveSilo(db, siloId);

        const captured = new Set(
          (await siloRepo.conceptsIn(db, siloId)).map((one) => one.conceptId),
        );
        if (captured.size === 0) return [];

        const relationships = await conceptRepo.relationships(db);
        const concepts = await conceptRepo.listLive(db);
        const names = new Map(concepts.map((one) => [one.id, one.name]));

        const seen = new Set<string>();
        const out: Array<{ conceptId: string; name: string; relatedTo: string; via: string }> = [];

        for (const link of relationships) {
          const [from, to] = [link.fromConceptId, link.toConceptId];

          for (const [near, far] of [[from, to], [to, from]] as const) {
            if (!captured.has(near) || captured.has(far) || seen.has(far)) continue;
            if (!names.has(far)) continue;
            seen.add(far);

            const required = await authzRepo.markingsOnResource(db, 'concept', far);
            if (!checkMarkings({ required }, { held: authority.clearances }).permitted) continue;

            out.push({
              conceptId: far,
              name: names.get(far)!,
              relatedTo: names.get(near) ?? near,
              via: `${link.fromObject}.${link.fromField}`,
            });
          }
        }

        return out;
      }),
  );
}

/* ── §4 Retention, which is a purge in disguise ──────────────────────────── */

/**
 * `silo.purge` RATHER THAN `silo.manage` TO SHORTEN, AND THAT IS THE WHOLE POINT.
 *
 * Shortening a window destroys data at the next sweep. If manage could do it,
 * purge would be bypassed by setting retention to a day and waiting.
 *
 * ONE OF THE TWO IS REQUIRED BEFORE THE SILO IS READ, so somebody holding
 * neither cannot tell a real Silo id from an invented one by which error comes
 * back.
 */
export async function setRetention(
  actor: Actor,
  input: { siloId: string; retentionDays: number },
): Promise<void> {
  const imports = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        if (!can(authority, 'silo.purge')) assertCan(authority, 'silo.manage');

        const silo = await liveSilo(db, input.siloId);

        /* Lengthening keeps more and destroys nothing, so it is management.
           Shortening is a deletion with a delay on it. */
        assertCan(authority, input.retentionDays < silo.retentionDays ? 'silo.purge' : 'silo.manage');

        const previous = await siloRepo.setRetention(db, input.siloId, input.retentionDays);

        await writeAudit(db, {
          event: 'retention_changed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          /* BOTH WINDOWS. Shortening one destroys data, and that is the change
             a reviewer asks about. */
          detail: { siloId: input.siloId, from: previous, to: input.retentionDays },
        });

        return importShapes(db, input.siloId);
      }),
  );

  /*
   * IMPORT §7 — THE ROW STORE'S OWN EXPIRY FOLLOWS THE WINDOW. BigQuery tables
   * carry a partition expiry one day past it as a backstop, so a changed window
   * is written to every imported object's table. Nothing to do in Postgres.
   */
  if (rowStore.kind() !== 'bigquery') return;
  for (const source of imports) {
    await rowStore.ensureObjects({
      organisationId: actor.organisationId,
      sourceId: source.sourceId,
      objects: source.objects,
      retentionDays: input.retentionDays,
    });
  }
}

export async function assertStorageOn(db: Parameters<Parameters<typeof withTransaction>[0]>[0], actor: Actor) {
  if (!env.SILOES_AVAILABLE) {
    throw refusal({
      message: 'This deployment is built without storage.',
      code: 'refusal.siloes_compiled_out',
    });
  }

  const organisation = await organisationRepo.findById(db, actor.organisationId);
  if (!organisation || !storageAllowed(organisation)) {
    throw refusal({
      message: 'Storage is switched off for this organisation. A super admin turns it on.',
      code: 'refusal.storage_disabled',
    });
  }
}

export async function liveSilo(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  id: string,
): Promise<siloRepo.Silo> {
  const silo = await siloRepo.find(db, id);
  if (!silo || silo.disabledAt) {
    throw notFound({ message: 'No such Silo.', code: 'missing.silo' });
  }
  return silo;
}

/** Any Silo, live or disabled: what it holds is still readable and still purgeable. */
async function anySilo(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  id: string,
): Promise<siloRepo.Silo> {
  const silo = await siloRepo.find(db, id);
  if (!silo) throw notFound({ message: 'No such Silo.', code: 'missing.silo' });
  return silo;
}

/* ── §9 Wipe: three distinct actions, never one button ───────────────────── */

/**
 * The three detectors that stop working when captured history goes.
 *
 * SAID AT THE TIME, NOT DISCOVERED AFTERWARDS. A purge that quietly returned
 * fewer findings next week would leave somebody concluding their estate had
 * improved. And not said at all when nothing was removed: a receipt claiming
 * three detectors were affected by a purge that matched no rows is a false
 * statement on the one document meant to be proof.
 */
const NEEDS_CAPTURE = ['timing_deviation', 'drift', 'recurrence'];

export type PurgeRequest = siloRepo.PurgeTarget;

export type PurgeReceiptSummary = {
  receiptId: string;
  scope: PurgeRequest['scope'];
  transitionsRemoved: number;
  baselinesRemoved: number;
  /** Import §11 — files removed from object storage, and rows read out of files. */
  filesRemoved: number;
  rowsRemoved: number;
  siloDisabled: boolean;
  detectorsAffected: string[];
  /** Transitions this Silo's queued readings produced on the drain before the delete. */
  drained: number;
  /** The second person, where the organisation requires one. */
  approvedBy: string | null;
};

export type PurgeOutcome =
  | { status: 'pending'; approvalRequestId: string; approvalsRequired: number; expiresAt: Date }
  | ({ status: 'completed' } & PurgeReceiptSummary);

/** What a target names, flat, for the audit row and the approval request. */
function namedBy(target: PurgeRequest) {
  return {
    conceptId: target.scope === 'concept' || target.scope === 'entity' ? target.conceptId : null,
    entityRef: target.scope === 'entity' ? target.entityRef : null,
    fileId: target.scope === 'file' ? target.fileId : null,
    sourceId: target.scope === 'object' ? target.sourceId : null,
    objectName: target.scope === 'object' ? target.objectName : null,
  };
}

/**
 * Ask to delete data a Silo holds.
 *
 * ── Through the approval chain where there is one ──────────────────────────
 *
 * §4: a purge "routes through the approval chain where the organisation has
 * configured one". With a policy for `silo.purge` this records a request and
 * returns it pending; nothing is drained or deleted until the last approval
 * arrives, and then it runs as the person who asked. Without one it runs now.
 *
 * `purge_requested` is written either way, before anything else, so a request
 * that goes nowhere still leaves a row.
 *
 * ── Clearance on what is named ──────────────────────────────────────────────
 *
 * A purge of a concept or an entity within it names a concept, and naming one
 * the person is not cleared for confirms it exists. Refused the same way the
 * add was.
 */
export async function purge(
  actor: Actor,
  input: { siloId: string } & PurgeRequest,
): Promise<PurgeOutcome> {
  const target = targetOf(input);
  const named = namedBy(target);

  const pending = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.purge');
        await anySilo(db, input.siloId);
        if (named.conceptId) await assertCleared(db, authority, { type: 'concept', id: named.conceptId });

        /* A file or an object that is not in this Silo is refused now, not
           after somebody has approved deleting nothing. */
        await importReach(db, input.siloId, target);

        const policy = await approvalRepo.policyFor(db, 'silo.purge');
        const approvalRequestId = policy ? generateId() : null;
        const expiresAt = policy ? new Date(Date.now() + APPROVAL_TTL_HOURS * 60 * 60 * 1000) : null;

        if (policy && approvalRequestId && expiresAt) {
          await approvalRepo.createRequest(db, {
            id: approvalRequestId,
            organisationId: actor.organisationId,
            action: 'silo.purge',
            subject: { siloId: input.siloId, scope: target.scope, ...named },
            approvalsRequired: policy.approvalsRequired,
            requestedBy: actor.membershipId,
            expiresAt,
          });
        }

        await writeAudit(db, {
          event: 'purge_requested',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            siloId: input.siloId,
            scope: target.scope,
            conceptId: named.conceptId,
            entityRef: named.entityRef,
            fileId: named.fileId,
            sourceId: named.sourceId,
            objectName: named.objectName,
            approvalRequestId,
          },
        });

        return policy && approvalRequestId && expiresAt
          ? { approvalRequestId, approvalsRequired: policy.approvalsRequired, expiresAt }
          : null;
      }),
  );

  if (pending) return { status: 'pending', ...pending };

  return {
    status: 'completed',
    ...(await executePurge(actor, { siloId: input.siloId, target, approvedBy: null })),
  };
}

/** What a purge reaches in imports: files to remove whole, and objects to empty. */
type ImportReach = {
  files: siloImportRepo.SiloFile[];
  objects: Array<{ sourceId: string; objectName: string }>;
  /** Every published object of each source, for removing one file's rows. */
  objectsOfSource: Map<string, string[]>;
  sources: siloImportRepo.SiloSource[];
};

async function importReach(db: Db, siloId: string, target: PurgeRequest): Promise<ImportReach> {
  const sources = await siloImportRepo.sourcesIn(db, siloId);
  const shapes = await importShapes(db, siloId);
  const objectsOfSource = new Map(shapes.map((one) => [one.sourceId, one.objects.map((object) => object.name)]));
  const none = { files: [], objects: [], objectsOfSource, sources };

  switch (target.scope) {
    case 'entity':
      return none;

    case 'file': {
      const file = await siloImportRepo.findFile(db, target.fileId);
      if (!file || file.siloId !== siloId) {
        throw notFound({ message: 'No such file in this Silo.', code: 'missing.silo_file' });
      }
      return { ...none, files: [file] };
    }

    case 'object': {
      const names = objectsOfSource.get(target.sourceId) ?? [];
      if (!names.includes(target.objectName)) {
        throw notFound({ message: 'No such imported object in this Silo.', code: 'missing.silo_object' });
      }
      return { ...none, objects: [{ sourceId: target.sourceId, objectName: target.objectName }] };
    }

    case 'concept': {
      /* "Purge concept: all import and capture for a concept." The rows of every
         imported object mapped to it. The files stay: one file can feed objects
         no concept names, and deleting it would reach past the scope. */
      const sourceOf = new Map(
        sources.filter((one) => one.connectionId).map((one) => [one.connectionId!, one.id]),
      );
      const objects = (await conceptRepo.liveContributions(db))
        .filter((one) => one.conceptId === target.conceptId && sourceOf.has(one.connectionId))
        .map((one) => ({ sourceId: sourceOf.get(one.connectionId)!, objectName: one.objectName }));
      return { ...none, objects };
    }

    case 'silo':
      /* "Disable and purge: the whole Silo, files included." */
      return {
        ...none,
        files: await siloImportRepo.filesOfSilo(db, siloId),
        objects: shapes.flatMap((one) =>
          one.objects.map((object) => ({ sourceId: one.sourceId, objectName: object.name })),
        ),
      };
  }
}

/**
 * Delete data a Silo holds, and prove it. The purge itself, however it was reached.
 *
 * ── The scope IS the delete ────────────────────────────────────────────────
 *
 * Purge entity, file, object or concept; disable and purge. A whole-Silo wipe
 * disables the Silo, retires its imports and revokes the connections they
 * answered through, and the receipt says so.
 *
 * ── Outside first, then the receipt ────────────────────────────────────────
 *
 * Rows in BigQuery and files in object storage cannot join a database
 * transaction. They are deleted first and the receipt is written after, so a
 * failure part-way leaves data partly deleted and NO receipt — never a receipt
 * for data that is still there. Running the purge again finishes it. Import
 * §11: leaving the source document behind after a wipe is the failure a
 * reviewer will test, so the file object is deleted, not only its rows.
 *
 * ── Drains the queue first, and nothing gets written back behind it ────────
 *
 * The whole purge runs inside `afterDraining`, so no drain in this process can
 * start between the queue being written and the rows being deleted. Other
 * instances' queues are not reachable from here, which is why the receipt is
 * also a fence: `captureBatch` refuses any reading observed before a receipt
 * that covers it.
 *
 * ── Checked again, as the requester ────────────────────────────────────────
 *
 * Where a request waited for approval, the person who asked may have lost the
 * permission or the clearance since. It runs only if they still hold both —
 * checked before anything is deleted, and again inside the receipt's
 * transaction.
 */
export async function executePurge(
  requester: Actor,
  input: { siloId: string; target: PurgeRequest; approvedBy: string | null },
): Promise<PurgeReceiptSummary> {
  const { target } = input;
  const named = namedBy(target);
  const tenant = { organisationId: requester.organisationId, membershipId: requester.membershipId };

  const assertStillAllowed = async (db: Db) => {
    const authority = await authorityOf(db, requester.membershipId, requester.organisationId);
    assertCan(authority, 'silo.purge');
    const silo = await anySilo(db, input.siloId);
    if (named.conceptId) await assertCleared(db, authority, { type: 'concept', id: named.conceptId });
    return silo;
  };

  return capture.afterDraining(async (drained) => {
    const reach = await runWithTenant(tenant, () =>
      withTransaction(async (db) => {
        await assertStillAllowed(db);

        /* A whole-Silo wipe retires the imports before anything is deleted, so a
           file still in the queue is not structured back into a store that is
           being emptied. */
        if (target.scope === 'silo') {
          await siloImportRepo.retireSourcesOf(db, input.siloId);
          /* A watched location's credential goes with the Silo, not after it. */
          await siloImportRepo.deleteCredentialsOf(db, input.siloId);
        }

        return importReach(db, input.siloId, target);
      }),
    );

    let rowsRemoved = 0;

    if (target.scope === 'file') {
      for (const file of reach.files) {
        rowsRemoved += await rowStore.removeFileRows({
          organisationId: requester.organisationId,
          sourceId: file.sourceId,
          fileId: file.id,
          objectNames: reach.objectsOfSource.get(file.sourceId) ?? [],
        });
      }
    } else {
      for (const object of reach.objects) {
        rowsRemoved += await rowStore.removeObjectRows({
          organisationId: requester.organisationId,
          sourceId: object.sourceId,
          objectName: object.objectName,
        });
      }
    }

    for (const file of reach.files) await objectStore.remove(file.objectKey);

    return runWithTenant(tenant, () =>
      withTransaction(async (db) => {
        const silo = await assertStillAllowed(db);

        const drainedHere = drained.bySilo[input.siloId] ?? 0;

        await writeAudit(db, {
          event: 'capture_queue_drained',
          organisationId: requester.organisationId,
          membershipId: requester.membershipId,
          userId: null,
          detail: { siloId: input.siloId, captured: drainedHere },
        });

        const removed = await siloRepo.purge(db, input.siloId, target);

        /* The stand-in's rows reference their file, so any written after the
           delete above go before the file row does. */
        for (const file of reach.files) {
          rowsRemoved += await siloRowRepo.deleteRowsOfFile(db, file.id);
          await siloExtractionRepo.deleteOfFile(db, file.id);
          await siloImportRepo.deleteFile(db, file.id);
        }

        /* Where an emptied object's values were read goes with them. */
        for (const object of reach.objects) {
          await siloExtractionRepo.deleteOfObject(db, object);
        }

        let siloDisabled = false;
        if (target.scope === 'silo') {
          siloDisabled = (await siloRepo.disable(db, input.siloId)) || silo.disabledAt !== null;
          for (const source of reach.sources) {
            if (source.connectionId) await connectionRepo.revoke(db, source.connectionId);
          }
        }

        const importTouched = reach.files.length + rowsRemoved > 0;
        const detectorsAffected = [
          ...(removed.transitions + removed.baselines > 0 ? NEEDS_CAPTURE : []),
          ...(importTouched ? await importImpact(db, reach) : []),
        ];

        const receiptId = generateId();

        await siloRepo.recordReceipt(db, {
          id: receiptId,
          organisationId: requester.organisationId,
          siloId: input.siloId,
          target,
          transitionsRemoved: removed.transitions,
          baselinesRemoved: removed.baselines,
          filesRemoved: reach.files.length,
          rowsRemoved,
          detectorsAffected,
          siloDisabled,
          requestedBy: requester.membershipId,
          approvedBy: input.approvedBy,
        });

        await writeAudit(db, {
          event: 'purge_completed',
          organisationId: requester.organisationId,
          membershipId: requester.membershipId,
          userId: null,
          detail: {
            siloId: input.siloId,
            receiptId,
            scope: target.scope,
            conceptId: named.conceptId,
            entityRef: named.entityRef,
            transitionsRemoved: removed.transitions,
            baselinesRemoved: removed.baselines,
            detectorsAffected,
            siloDisabled,
          },
        });

        if (importTouched) {
          await writeAudit(db, {
            event: 'silo_import_purged',
            organisationId: requester.organisationId,
            membershipId: requester.membershipId,
            userId: null,
            detail: {
              siloId: input.siloId,
              receiptId,
              scope: target.scope,
              fileId: named.fileId,
              sourceId: named.sourceId,
              objectName: named.objectName,
              filesRemoved: reach.files.length,
              rowsRemoved,
            },
          });
        }

        log.info(
          { siloId: input.siloId, scope: target.scope, removed: removed.transitions, rowsRemoved, siloDisabled },
          'Silo purged',
        );

        return {
          receiptId,
          scope: target.scope,
          transitionsRemoved: removed.transitions,
          baselinesRemoved: removed.baselines,
          filesRemoved: reach.files.length,
          rowsRemoved,
          siloDisabled,
          detectorsAffected,
          drained: drainedHere,
          approvedBy: input.approvedBy,
        };
      }),
    );
  });
}

/**
 * Import §11 — which detectors stop seeing what was purged.
 *
 * AN IMPORTED OBJECT IS A SOURCE LIKE ANY OTHER, so every detector reading a
 * concept it contributes to loses those rows. Said per concept, because "the
 * detectors over Invoice" is something a person can check.
 */
async function importImpact(db: Db, reach: ImportReach): Promise<string[]> {
  const touched = new Set([
    ...reach.files.map((file) => file.sourceId),
    ...reach.objects.map((object) => object.sourceId),
  ]);
  const connections = new Set(
    reach.sources.filter((one) => touched.has(one.id) && one.connectionId).map((one) => one.connectionId!),
  );

  const concepts = new Set(
    (await conceptRepo.liveContributions(db))
      .filter((one) => connections.has(one.connectionId))
      .map((one) => one.conceptId),
  );

  const names: string[] = [];
  for (const conceptId of concepts) {
    const concept = await conceptRepo.read(db, conceptId);
    if (concept) names.push(`detectors over ${concept.name}`);
  }
  return names.sort();
}

/** Each import source's published objects, in the shape the row store needs. */
async function importShapes(
  db: Db,
  siloId: string,
): Promise<Array<{ sourceId: string; objects: rowStore.ObjectShape[] }>> {
  const out: Array<{ sourceId: string; objects: rowStore.ObjectShape[] }> = [];

  for (const source of await siloImportRepo.sourcesIn(db, siloId)) {
    if (!source.definitionId) continue;
    const parsed = siloDefinition.safeParse(await siloImportRepo.publishedDocumentOf(db, source.id));
    if (!parsed.success) continue;
    out.push({
      sourceId: source.id,
      objects: parsed.data.objects.map((object) => ({
        name: object.name,
        fields: object.fields.map((field) => ({ name: field.name, type: field.type })),
      })),
    });
  }

  return out;
}

/** Exactly the target the scope names, whatever else arrived beside it. */
function targetOf(input: { siloId: string } & PurgeRequest): PurgeRequest {
  switch (input.scope) {
    case 'silo':
      return { scope: 'silo' };
    case 'concept':
      if (!input.conceptId) {
        throw invalid({ message: 'Name the concept to purge.', code: 'invalid.purge_target' });
      }
      return { scope: 'concept', conceptId: input.conceptId };
    case 'entity':
      if (!input.conceptId || !input.entityRef) {
        throw invalid({
          message: 'Name the concept and the entity within it to purge.',
          code: 'invalid.purge_target',
        });
      }
      return { scope: 'entity', conceptId: input.conceptId, entityRef: input.entityRef };
    case 'file':
      if (!input.fileId) {
        throw invalid({ message: 'Name the file to purge.', code: 'invalid.purge_target' });
      }
      return { scope: 'file', fileId: input.fileId };
    case 'object':
      if (!input.sourceId || !input.objectName) {
        throw invalid({
          message: 'Name the import and the object within it to purge.',
          code: 'invalid.purge_target',
        });
      }
      return { scope: 'object', sourceId: input.sourceId, objectName: input.objectName };
  }
}

/**
 * §12 — what a Silo holds for a concept, for the history resolver.
 *
 * NO ACTOR, AND NO PERMISSION, deliberately: the caller is the detector run,
 * which has already asserted clearance on the concept, and what comes back is a
 * count, an instant, the nominated field names and the window — never a value.
 */
export async function coverage(
  organisationId: string,
  conceptId: string,
): Promise<{
  siloId: string;
  transitions: number;
  since: Date | null;
  fields: string[];
  retentionDays: number;
} | null> {
  if (!env.SILOES_AVAILABLE) return null;

  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      const captured = await siloRepo.capturedFields(db, conceptId);
      if (!captured) return null;

      const held = await siloRepo.coverageOf(db, captured.siloId, conceptId);
      return {
        siloId: captured.siloId,
        ...held,
        fields: captured.fields,
        retentionDays: captured.retentionDays,
      };
    }),
  );
}

/**
 * §10 and Import §9 — bytes held and bytes scanned, per Silo, and what is waiting.
 *
 * HELD MEANS EVERYWHERE IT IS HELD: captured changes and last-seen values, the
 * imported files in object storage, and the rows read out of them in the row
 * store. BigQuery bills per byte scanned, so scanned is counted whichever store
 * answered.
 *
 * THE QUEUE FIGURE IS THIS SILO'S. It was the whole process's queue, which
 * counted every other organisation's pending readings — an activity signal about
 * other customers on an endpoint any Silo manager could poll.
 */
export async function usage(
  actor: Actor,
  siloId: string,
): Promise<{
  bytesStored: { transitions: number; baselines: number; files: number; importedRows: number; total: number };
  bytesScanned: number;
  extractionOperations: number;
  queued: number;
}> {
  const held = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.manage');

        return {
          silo: await anySilo(db, siloId),
          stored: await siloRepo.bytesStored(db, siloId),
          files: await siloImportRepo.bytesOfFiles(db, siloId),
          shapes: await importShapes(db, siloId),
        };
      }),
  );

  const importedRows =
    held.shapes.length === 0
      ? 0
      : await rowStore.bytesHeld({
          organisationId: actor.organisationId,
          siloId,
          sources: held.shapes.map((one) => ({
            sourceId: one.sourceId,
            objectNames: one.objects.map((object) => object.name),
          })),
        });

  return {
    bytesStored: {
      transitions: held.stored.transitions,
      baselines: held.stored.baselines,
      files: held.files,
      importedRows,
      total: held.stored.transitions + held.stored.baselines + held.files + importedRows,
    },
    bytesScanned: held.silo.bytesScanned,
    extractionOperations: held.silo.extractionOperations,
    queued: capture.queuedFor(siloId),
  };
}

export async function list(actor: Actor): Promise<siloRepo.Silo[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.manage');
        return siloRepo.list(db);
      }),
  );
}

/**
 * §4 — stop capturing a concept.
 *
 * `silo.manage`, NOT `silo.purge`, AND THE DIFFERENCE IS THAT NOTHING IS
 * DELETED. Removing a concept stops future capture; the transitions already
 * held stay until retention or a purge takes them.
 *
 * SAYS WHAT IS STILL HELD, because the obvious assumption is that it went.
 */
export async function removeConcept(
  actor: Actor,
  input: { siloId: string; conceptId: string },
): Promise<{ removed: boolean; transitionsRetained: number }> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.manage');

        await liveSilo(db, input.siloId);

        const removed = await siloRepo.removeConcept(db, input.siloId, input.conceptId);
        if (!removed) {
          throw notFound({
            message: 'That concept is not being captured by this Silo.',
            code: 'missing.silo_concept',
          });
        }

        const held = await siloRepo.coverageOf(db, input.siloId, input.conceptId);

        await writeAudit(db, {
          event: 'silo_concept_removed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { siloId: input.siloId, conceptId: input.conceptId },
        });

        return { removed: true, transitionsRetained: held.transitions };
      }),
  );
}

/**
 * §9 — the receipts for a Silo.
 *
 * READABLE WITH `silo.manage` RATHER THAN `silo.purge`. Whoever has to answer
 * "prove you deleted it" is often not the person who pressed the button, and a
 * proof only its author can read is not a proof.
 */
export async function receipts(actor: Actor, siloId: string): Promise<siloRepo.PurgeReceipt[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.manage');
        await anySilo(db, siloId);
        return siloRepo.receiptsFor(db, siloId);
      }),
  );
}

/**
 * §11 — the disclosure, assembled from what the Silo actually holds.
 *
 * ── Exactly what is kept, where, for how long, and that it can go ───────────
 *
 * §11 names those four and this states all four. The first version named
 * "the value before and after" and left out the baseline — the last value seen
 * for every observed entity and field, which is a customer value too, and which
 * nothing was deleting. It also counted only the concepts nominated today, so a
 * Silo whose concepts had been removed could say it stored nothing while holding
 * a year of changes. And its "oldest" date came from whichever concept happened
 * to be listed first.
 *
 * ── Generated from state, never written by hand ────────────────────────────
 *
 * A disclosure typed into a settings page is a claim that was true when somebody
 * wrote it. This one is read from the rows, so a customer forwarding it into a
 * subject access response is forwarding a fact.
 *
 * IT NAMES NO VALUES. It names concepts and fields — reading the values is a
 * query, under clearance, like everything else.
 */
export async function disclosure(
  actor: Actor,
  siloId: string,
): Promise<{
  name: string;
  purpose: string;
  retentionDays: number;
  region: string;
  disabled: boolean;
  concepts: Array<{
    conceptId: string;
    name: string;
    capturing: boolean;
    fields: string[] | null;
    transitions: number;
    baselines: number;
  }>;
  transitions: number;
  baselines: number;
  bytesStored: number;
  /** Import — each source, and how many files it has received. */
  imports: Array<{ sourceId: string; name: string; files: number }>;
  oldest: Date | null;
  statement: string;
}> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.manage');

        const silo = await anySilo(db, siloId);

        /* SEQUENTIAL, ON PURPOSE. One transaction is one connection, and
           concurrent queries on one pg client are deprecated and removed in
           pg 9 — the first version ran them under Promise.all. */
        const held = await siloRepo.holdings(db, siloId);
        const stored = await siloRepo.bytesStored(db, siloId);
        const importedFiles = await siloImportRepo.filesOfSilo(db, siloId);
        const imports = (await siloImportRepo.sourcesIn(db, siloId)).map((source) => ({
          sourceId: source.id,
          name: source.name,
          /* A file refused at receipt had its object deleted there and then, so
             it is not something this Silo holds. */
          files: importedFiles.filter(
            (file) =>
              file.sourceId === source.id &&
              file.receivedAt &&
              !(file.status === 'failed' && file.failureCode?.startsWith('file.')),
          ).length,
        }));

        const concepts = held.map((one) => ({
          conceptId: one.conceptId,
          name: one.conceptName ?? 'a concept that has since been deleted',
          capturing: one.nominatedFields !== null && silo.disabledAt === null,
          fields: one.nominatedFields,
          transitions: one.transitions,
          baselines: one.baselines,
        }));

        const transitions = held.reduce((sum, one) => sum + one.transitions, 0);
        const baselines = held.reduce((sum, one) => sum + one.baselines, 0);
        const earliest = held
          .map((one) => one.earliest)
          .filter((one): one is Date => one !== null)
          .sort((a, b) => a.getTime() - b.getTime());

        return {
          name: silo.name,
          purpose: silo.purpose,
          retentionDays: silo.retentionDays,
          region: env.CELL_REGION,
          disabled: silo.disabledAt !== null,
          concepts,
          transitions,
          baselines,
          bytesStored: stored.transitions + stored.baselines,
          imports,
          oldest: earliest[0] ?? null,
          statement: statementFor({
            imports,
            name: silo.name,
            purpose: silo.purpose,
            retentionDays: silo.retentionDays,
            region: env.CELL_REGION,
            disabled: silo.disabledAt !== null,
            concepts,
            transitions,
            baselines,
          }),
        };
      }),
  );
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The sentence, or as few as it honestly takes.
 *
 * FIELDS ARE NAMED PER CONCEPT. Merging them across concepts turned "invoice
 * total" and "order total" into one field called total, which understated what
 * was kept and named neither.
 */
function statementFor(input: {
  name: string;
  purpose: string;
  retentionDays: number;
  region: string;
  disabled: boolean;
  concepts: Array<{ name: string; capturing: boolean; fields: string[] | null; transitions: number; baselines: number }>;
  transitions: number;
  baselines: number;
  imports: Array<{ name: string; files: number }>;
}): string {
  const capturing = input.concepts.filter((one) => one.capturing && one.fields);
  const retainedOnly = input.concepts.filter(
    (one) => !one.capturing && one.transitions + one.baselines > 0,
  );
  const imported = input.imports.filter((one) => one.files > 0);
  const captured = capturing.length > 0 || input.transitions + input.baselines > 0;

  const purpose = input.purpose.replace(/\s+/g, ' ').trim();
  const purposeSentence = `Stated purpose: ${purpose}${/[.!?]$/.test(purpose) ? '' : '.'}`;

  if (!captured && imported.length === 0) {
    return [
      input.disabled
        ? `${input.name} is disabled and stores nothing.`
        : `${input.name} stores nothing. No concept is nominated for capture and no file has been imported.`,
      purposeSentence,
    ].join(' ');
  }

  const sentences: string[] = [];

  if (input.disabled) sentences.push(`${input.name} is disabled and captures nothing new.`);

  if (capturing.length > 0) {
    const named = capturing.map((one) => `${one.name} (${one.fields!.join(', ')})`).join('; ');
    sentences.push(
      `${input.name} keeps, for ${named}, each change to those fields: the value before, the ` +
        'value after, when it was seen and which system it came from. So that a change can be ' +
        'recognised, it also keeps the last value seen for each of those fields. Nothing else ' +
        'from the record is kept.',
    );
  }

  if (retainedOnly.length > 0) {
    sentences.push(
      `It still holds what was captured for ${retainedOnly.map((one) => one.name).join(', ')}, ` +
        'which is no longer being captured.',
    );
  }

  if (captured) {
    sentences.push(
      `It holds ${plural(input.transitions, 'recorded change', 'recorded changes')} and ` +
        `${plural(input.baselines, 'last-seen value', 'last-seen values')}, stored in this ` +
        `deployment's database in ${input.region} and separated from every other organisation ` +
        'by row level security.',
      `Each is deleted ${plural(input.retentionDays, 'day', 'days')} after it was last seen, and ` +
        'any of it can be deleted sooner, at any time.',
    );
  }

  /* IMPORT: THE FILES THEMSELVES, NOT ONLY THE RECORDS. Saying "records read
     from files" and leaving out that the files are kept would understate it. */
  if (imported.length > 0) {
    const files = imported.reduce((sum, one) => sum + one.files, 0);
    sentences.push(
      `It holds ${plural(files, 'imported file', 'imported files')}, received through ` +
        `${imported.map((one) => one.name).join(', ')}, together with the records read out of ` +
        'them under a structure your organisation defined and tested against those files.',
      `Each file is deleted with everything read out of it ${plural(input.retentionDays, 'day', 'days')} ` +
        'after it was received, and any of them can be deleted sooner, at any time.',
    );
  }

  sentences.push(purposeSentence);

  return sentences.join(' ');
}
