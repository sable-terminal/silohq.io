import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { bounds, denial, notFound } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, assertCleared, authorityOf, can } from './authorisation.service';
import { hiddenFields } from './fieldPolicy.service';
import { MAX_IMPORT_FILE_BYTES } from '../config/constants.config';
import { sniff } from '../utils/mimeSniff.util';
import { sanitiseSvg, scopedObjectKey } from '../utils/inputSanitiser.util';
import * as objectStore from '../infra/objectStore.infra';
import * as fileRepo from '../repos/file.repo';
import * as savedViewRepo from '../repos/savedView.repo';
import { flagsOf } from '../engine/render/flags.render';
import * as render from './render.service';
import * as siloRepo from '../repos/silo.repo';
import * as siloImportRepo from '../repos/siloImport.repo';
import * as siloExtractionRepo from '../repos/siloExtraction.repo';
import { couldImportRead } from './siloImport.service';
import * as siloService from './silo.service';
import * as organisationRepo from '../repos/organisation.repo';
import * as conceptQuery from './conceptQuery.service';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

const log = childLogger('files');

/**
 * Files §1 — "An export is a frozen result."
 *
 * ── It is not a cached view and it does not track one ──────────────────────
 *
 * §3 — "Sharing the view more widely does not widen the file. Narrowing the
 * view does not narrow it. The export was a decision someone made, and it
 * stands on its own terms." So the bytes are written once, the permissions that
 * shaped them are snapshotted beside them, and nothing here ever reads the
 * source again except to record where it came from.
 *
 * ── Redacted to the person, not to the view ────────────────────────────────
 *
 * §3 — "An export is redacted to what the exporting person may see, not to what
 * the view contains. A view showing a field they lack clearance for exports
 * without that field, and the file says a field was omitted rather than showing
 * a gap."
 *
 * The redaction is already done by the time the answer arrives: field policies
 * are applied at compile, so a field somebody may not see never enters the
 * query. What this adds is the SAYING — the file names what was left out,
 * because a column that is simply absent reads as a system that had no data.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

export type ExportFormat = 'json' | 'csv';

export type ExportedFile = fileRepo.StoredFile & {
  provenance: fileRepo.Provenance | null;
  omittedFields: string[];
};

/**
 * §3 — produce an export from a saved view.
 *
 * ASKED AS THE EXPORTER, WHICH IS WHERE THE REDACTION COMES FROM. `ask`
 * re-checks their permissions and removes what they may not see before the
 * query runs, so a file cannot contain a field its maker could not read.
 */
export async function exportView(
  actor: Actor,
  input: { viewId: string; format?: ExportFormat; name?: string },
): Promise<ExportedFile> {
  const format = input.format ?? 'json';

  const view = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'file.export');

      const stored = await savedViewRepo.read(db, input.viewId);
      if (!stored) throw notFound({ message: 'That saved view does not exist.', code: 'missing.view' });

      if (stored.ownerMembershipId !== actor.membershipId) {
        throw denial({
          message: 'That saved view belongs to somebody else.',
          code: 'denial.view_not_owned',
        });
      }
      return stored;
    }),
  );

  const answer = await conceptQuery.ask(actor, { conceptId: view.conceptId, query: view.query });

  /*
   * §3's snapshot. The connections are the ones the answer actually drew on,
   * taken from its lineage rather than from the concept's mapping: a concept
   * may name systems this person cannot reach, and the file should record what
   * it was made from, not what it might have been.
   */
  const connections = answer.lineage.map((one) => one.connectionId);

  const { clearances, omitted } = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      const hidden = await hiddenFields(db, actor, connections);

      return {
        clearances: [...authority.clearances],
        omitted: [...new Set([...hidden.values()].flatMap((fields) => [...fields]))].sort(),
      };
    }),
  );

  const body = format === 'csv' ? asCsv(answer, omitted) : asJson(answer, view, omitted);
  const filename = `${(input.name ?? view.name).replace(/[^\w. -]+/g, '')}.${format}`;

  const object = await objectStore.put({
    organisationId: actor.organisationId,
    kind: 'export',
    filename,
    body,
    sniffedContentType: format === 'csv' ? 'text/csv' : 'application/json',
  });

  const file = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const created = await fileRepo.create(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        kind: 'export',
        /* An export has no outcome and is complete the moment it is written. */
        outcome: null,
        receivedAt: new Date(),
        name: filename,
        objectKey: object.key,
        contentType: object.contentType,
        bytes: body.byteLength,
        siloId: null,
        createdBy: actor.membershipId,
        /* §6 — indefinite by default. Retention is per organisation and is not
           a Silo's window; there is no organisation setting for it yet. */
        expiresAt: null,
        permissions: { clearances, omittedFields: omitted, connections },
        provenance: {
          sourceKind: 'view',
          sourceId: view.id,
          sourceName: view.name,
          runReference: null,
        },
      });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'file_exported',
        detail: {
          fileId: created.id,
          sourceKind: 'view',
          viewId: view.id,
          records: answer.entities.length,
          omitted: omitted.length,
        },
      });

      /*
       * Rendering §11 — `view_exported`, beside Files' own `file_exported`.
       *
       * TWO EVENTS FOR ONE ACT, AND THEY ANSWER DIFFERENT QUESTIONS. Files
       * records that a document now exists, which is what somebody auditing
       * stored data reads. Rendering records that a DRAWING left the product,
       * with the archetype it left as — which is what somebody asking whether
       * the precedence is right reads, alongside the override rate. Neither
       * trail is complete without its own row.
       */
      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'view_exported',
        detail: {
          viewId: view.id,
          fileId: created.id,
          archetype: render.describe(answer, { sort: view.query.sort }).archetype.chosen,
          records: answer.entities.length,
        },
      });

      return created;
    }),
  );

  log.info({ fileId: file.id, records: answer.entities.length }, 'Export produced');
  return { ...file, provenance: null, omittedFields: omitted };
}

export async function mine(actor: Actor, kind?: fileRepo.FileKind): Promise<fileRepo.StoredFile[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => fileRepo.listOwnedBy(db, actor.membershipId, kind)),
  );
}

/**
 * §5 — the documents uploaded into one Silo.
 *
 * THEY ARE LISTED WHERE THEY ARE KEPT. Every upload requires a Silo, so a room
 * of its own for them was a second place to look for something that already has
 * an address. Exports have no Silo and stay in Exports.
 *
 * THE FILE DECIDES, NOT THE SILO. §2 — access is a decision on the file, so
 * this shows each person what they may see rather than everything the Silo
 * holds. Reading the Silo is a different permission from reading a document
 * somebody put in it.
 */
export async function documentsOfSilo(actor: Actor, siloId: string): Promise<fileRepo.StoredFile[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => fileRepo.filesOfSilo(db, { siloId, membershipId: actor.membershipId })),
  );
}

export async function read(actor: Actor, id: string): Promise<ExportedFile> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const file = await mustReach(db, actor, id);
      const permissions = await fileRepo.permissionsFor(db, id);

      return {
        ...file,
        provenance: await fileRepo.provenanceFor(db, id),
        omittedFields: permissions?.omittedFields ?? [],
      };
    }),
  );
}

/**
 * §9 — a link to the bytes, and a row saying it was opened.
 *
 * THE URL IS SHORT-LIVED AND THE OPENING IS RECORDED. A download that left no
 * trace would make `file_opened` a thing the trail claims and cannot show.
 */
export async function download(actor: Actor, id: string): Promise<{ url: string; name: string }> {
  const file = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const found = await mustReach(db, actor, id);

      /*
       * §9 — `file_download_refused` "is the evidence the boundary in §4 is
       * working, and a reviewer will ask for it". A refusal that left no row
       * would make the boundary a claim rather than something demonstrable.
       */
      const barred = await siloBar(db, actor, found);
      if (barred) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'file_download_refused',
          detail: { fileId: id, reason: barred, siloId: found.siloId },
        });

        throw denial({
          message: `You have this file but ${barred}. Ask for access to the Silo itself.`,
          code: 'denial.file_silo_access',
        });
      }

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'file_opened',
        detail: { fileId: id },
      });

      return found;
    }),
  );

  return { url: await objectStore.signedUrl(file.objectKey), name: file.name };
}

/* ── §5: uploads ─────────────────────────────────────────────────────────── */



/**
 * §5 — ask to put a document into a Silo.
 *
 * ── Everything judgeable without the bytes is judged now ──────────────────
 *
 * §5 asks for "validation before anything reaches storage", and a signed upload
 * means the bytes go straight to the object store. So the half that can be
 * decided from the request is decided here — the Silo exists and is switched
 * on, the caller may write into it, they are cleared for what it holds, and the
 * size is within the cap — and no URL is issued unless all of it passes. The
 * other half waits for `confirmUpload`, which sees the bytes.
 *
 * ── §1: "A customer with storage off can export and download; they cannot
 * upload" ─────────────────────────────────────────────────────────────────
 *
 * Checked against the organisation rather than the Silo's own flag, because a
 * Silo cannot exist in a switched-off organisation and a second path in would
 * be exactly the "second storage path outside the Silo disclosure" §1 refuses.
 */
export async function requestUpload(
  actor: Actor,
  input: { siloId: string; filename: string; contentType: string; bytes: number },
): Promise<{ fileId: string; upload: objectStore.SignedUpload }> {
  if (input.bytes > MAX_IMPORT_FILE_BYTES) {
    throw bounds({
      message: `A file can be at most ${Math.floor(MAX_IMPORT_FILE_BYTES / (1024 * 1024))}MB.`,
      code: 'bounds.file_too_large',
    });
  }

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);

      /*
       * §7 — "file.upload: Upload into a Silo. Requires silo.import." Both,
       * because the first says they may put documents in Files and the second
       * says they may put data into that Silo. The first alone would be a door
       * labelled Files into storage they have no business writing to.
       */
      assertCan(authority, 'file.upload');
      assertCan(authority, 'silo.import');

      const organisation = await organisationRepo.findById(db, actor.organisationId);
      if (!organisation?.storageEnabled) {
        throw denial({
          message: 'Storage is switched off for this organisation, so there is nowhere to put a file.',
          code: 'denial.storage_disabled',
        });
      }

      const silo = await siloRepo.find(db, input.siloId);
      if (!silo || silo.disabledAt) {
        throw notFound({ message: 'That Silo does not exist.', code: 'missing.silo' });
      }

      /*
       * §5 — "Markings apply at upload. A file uploaded against a Silo holding
       * marked concepts requires clearance on those concepts." The same check
       * the Silo makes about itself, asked through the same helper.
       */
      await assertCleared(db, authority, {
        type: 'silo',
        id: silo.id,
        conceptIds: (await siloRepo.conceptsIn(db, silo.id)).map((one) => one.conceptId),
      });

      const id = generateId();
      const key = scopedObjectKey(actor.organisationId, 'upload', `${id}-${input.filename}`);

      const created = await fileRepo.create(db, {
        id,
        organisationId: actor.organisationId,
        kind: 'upload',
        /* §5 — "Stored is the default. Ingestion is a deliberate act." */
        outcome: 'stored',
        /* The bytes have not arrived. Until they do this is not a file. */
        receivedAt: null,
        name: input.filename,
        objectKey: key,
        contentType: input.contentType,
        bytes: input.bytes,
        siloId: silo.id,
        createdBy: actor.membershipId,
        /*
         * §6 — "Uploads carry the retention of the Silo they belong to."
         * Not an export's indefinite default: this is Silo data and it expires
         * when the Silo says it does.
         */
        expiresAt: new Date(Date.now() + silo.retentionDays * 24 * 60 * 60 * 1000),
        permissions: { clearances: [...authority.clearances], omittedFields: [], connections: [] },
        /*
         * §3's provenance answers "what was this produced FROM", and an upload
         * was produced from a person — which `created_by` already says. A
         * fifth source kind meaning "somebody uploaded it" would be a lineage
         * that explains nothing.
         */
        provenance: null,
      });

      return {
        fileId: created.id,
        upload: await objectStore.signedUploadUrl({ key, contentType: input.contentType }),
      };
    }),
  );
}

/**
 * §5 — the bytes turned up. Now judge them.
 *
 * ── The declared type is not evidence ─────────────────────────────────────
 *
 * §5 — "Content type from the bytes rather than the declared header." A header
 * is whatever the uploader wrote; a `.csv` that is really a workbook and a
 * `.png` that is really a script both declare themselves innocent.
 *
 * ── An unsanitised SVG is a stored cross-site scripting vector ────────────
 *
 * §5 says so outright, "on every page that renders it". So an SVG is rewritten
 * to its sanitised form before it is allowed to stay, and one that cannot be
 * sanitised is removed rather than kept with a warning.
 *
 * ── A failure removes the object, not just the row ────────────────────────
 *
 * Leaving the bytes behind after refusing the file would be storage a customer
 * never agreed to, held under a row nobody can see.
 */
export async function confirmUpload(actor: Actor, fileId: string): Promise<fileRepo.StoredFile> {
  const pending = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const file = await fileRepo.read(db, fileId, { pending: true });
      if (!file) throw notFound({ message: 'That file does not exist.', code: 'missing.file' });

      if (file.createdBy !== actor.membershipId) {
        throw denial({ message: 'That upload is somebody else\u2019s.', code: 'denial.file_not_owned' });
      }
      if (file.receivedAt) return file;
      return file;
    }),
  );

  const stored = await objectStore.head(pending.objectKey);
  if (!stored) {
    throw bounds({ message: 'Nothing was uploaded to that link.', code: 'bounds.upload_missing' });
  }

  if (stored.bytes > MAX_IMPORT_FILE_BYTES) {
    await discardUpload(actor, pending);
    throw bounds({
      message: 'That file is larger than the request said it would be.',
      code: 'bounds.file_too_large',
    });
  }

  const bytes = await objectStore.get(pending.objectKey);
  const sniffed = sniff(bytes);

  if (sniffed === 'image/svg+xml') {
    const cleaned = sanitiseSvg(bytes.toString('utf8'));
    if (!cleaned.ok || !cleaned.svg) {
      await discardUpload(actor, pending);
      throw bounds({
        message: 'That drawing carries script and cannot be stored.',
        code: 'bounds.unsafe_svg',
      });
    }
    /* Rewritten, so what is stored is what was judged safe rather than what
       arrived and happened to pass. */
    await objectStore.putAt({
      key: pending.objectKey,
      body: Buffer.from(cleaned.svg!, 'utf8'),
      sniffedContentType: 'image/svg+xml',
    });
  }

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await fileRepo.markReceived(db, {
        id: pending.id,
        contentType: sniffed,
        bytes: stored.bytes,
      });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'file_uploaded',
        detail: {
          fileId: pending.id,
          siloId: pending.siloId,
          outcome: 'stored',
          bytes: stored.bytes,
          declaredContentType: pending.contentType,
          /* §5 — the two disagreeing is the interesting case, and it is the
             reason the sniffed type is the one kept. */
          mismatch: sniffed !== pending.contentType,
        },
      });

      return (await fileRepo.read(db, pending.id))!;
    }),
  );
}

async function discardUpload(actor: Actor, file: fileRepo.StoredFile): Promise<void> {
  await objectStore.remove(file.objectKey).catch(() => undefined);
  await runWithTenant(tenantOf(actor), () => withTransaction((db) => fileRepo.discard(db, file.id)));
}

/**
 * §5 — "Ingestion is a deliberate act, because it is what turns a document into
 * data the ontology can join."
 *
 * ── A LINK, NOT A SECOND PIPELINE ────────────────────────────────────────
 *
 * The importer already reads files, structures them per a definition, and
 * records where each value came from — "the file, the page or cell, and the raw
 * text it was read from". So ingesting is handing the same bytes to that
 * pipeline under a source, and keeping the two records tied. Writing a second
 * extractor here would be a second answer to what a document says.
 *
 * ── DELIBERATE MEANS SEPARATE, AND IT IS WHY THIS IS NOT A FLAG AT UPLOAD ──
 *
 * §5 makes stored the default. A request that could arrive with
 * `outcome: 'ingested'` would make turning a document into queryable data a
 * field somebody might set without meaning to; a second call is a second
 * decision.
 */
export async function ingest(
  actor: Actor,
  fileId: string,
  input: { sourceId: string },
): Promise<fileRepo.StoredFile> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'file.upload');
      assertCan(authority, 'silo.import');

      const file = await mustReach(db, actor, fileId);

      if (file.kind !== 'upload') {
        throw bounds({
          message: 'An export is already a result; there is nothing to extract from it.',
          code: 'bounds.not_an_upload',
        });
      }
      if (file.outcome === 'ingested') {
        throw bounds({ message: 'That file has already been ingested.', code: 'bounds.already_ingested' });
      }

      /*
       * §5 — REFUSED HERE RATHER THAN HOURS LATER. Silo import refuses a type
       * it cannot read when the upload is requested; Files accepts any document
       * because storing one is the default outcome. So the check import makes
       * at its own door has to be made at this one too, or ingesting a
       * photograph would create a working record that fails quietly in a
       * pipeline nobody is watching.
       */
      if (!couldImportRead(file.contentType)) {
        throw bounds({
          message: `Import reads spreadsheets, CSV files, PDFs and Word documents. This one is ${file.contentType}.`,
          code: 'bounds.not_importable',
        });
      }

      const source = await siloImportRepo.findSource(db, input.sourceId);
      if (!source) throw notFound({ message: 'That source does not exist.', code: 'missing.source' });

      /*
       * THE SOURCE MUST BE IN THE SAME SILO. A file carries the retention and
       * the markings of the Silo it was uploaded against; ingesting it under a
       * source in another would move its data somewhere its disclosure never
       * covered.
       */
      if (source.siloId !== file.siloId) {
        throw bounds({
          message: 'That source belongs to a different Silo from the one this file was uploaded to.',
          code: 'bounds.source_other_silo',
        });
      }

      /*
       * THE SAME BYTES, NOT A COPY. Both records point at one object key, so
       * deleting either cannot leave the other holding a document §6 says
       * should be gone.
       */
      const working = await siloImportRepo.insertFile(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        siloId: file.siloId!,
        sourceId: source.id,
        objectKey: file.objectKey,
        filename: file.name,
        declaredBytes: file.bytes,
        uploadExpiresAt: file.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
        uploadedBy: actor.membershipId,
      });

      await fileRepo.markIngested(db, { id: file.id, siloFileId: working.id });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'file_ingested',
        detail: { fileId: file.id, siloId: file.siloId, sourceId: source.id, outcome: 'ingested' },
      });

      return (await fileRepo.read(db, file.id))!;
    }),
  );
}

/**
 * §6 — "Deleting an uploaded file removes the file, its extractions, and
 * anything derived from them. Leaving the source document behind after a
 * deletion is the failure a reviewer tests for."
 *
 * ── The Silo's own purge does the removing ───────────────────────────────
 *
 * It already removes the rows, the extractions and the confirmations, and
 * already writes a receipt naming the detectors affected — which is §6's "what
 * stopped working as a result". Reimplementing it here would be a second answer
 * to what a deletion reaches, and the copy is what misses something.
 *
 * ── The object goes last, and only after the data ────────────────────────
 *
 * If the purge fails, the document is still there and the deletion can be
 * retried. Removing the bytes first and then failing would leave extractions
 * pointing at a document nobody can produce.
 */
export async function remove(actor: Actor, fileId: string): Promise<fileRepo.DeletionReceipt> {
  const file = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'file.delete');

      const found = await mustReach(db, actor, fileId);

      /*
       * §7 — "Uploads additionally require silo.purge." §6 says why: "Deleting
       * an ingested upload is a purge, not a tidy-up, because it destroys data
       * a detector may depend on." Asked for every upload, not only ingested
       * ones, because a stored document in a Silo is still that Silo's data.
       */
      if (found.kind === 'upload') assertCan(authority, 'silo.purge');

      if (found.createdBy !== actor.membershipId) {
        throw denial({ message: 'That file belongs to somebody else.', code: 'denial.file_not_owned' });
      }
      return found;
    }),
  );

  let purge: { receiptId: string | null; detectors: string[]; rows: number } = {
    receiptId: null,
    detectors: [],
    rows: 0,
  };

  if (file.siloFileId && file.siloId) {
    const outcome = await siloService.purge(actor, {
      siloId: file.siloId,
      scope: 'file',
      fileId: file.siloFileId,
    });

    /*
     * A PURGE THAT NEEDS A SECOND PERSON IS NOT A DELETION YET. The
     * organisation asked for two names on this, and answering as though the
     * file were gone would be a receipt for something that has not happened.
     */
    if (outcome.status === 'pending') {
      throw denial({
        message: 'This organisation requires a second person to approve a purge. The request is waiting.',
        code: 'denial.purge_awaiting_approval',
      });
    }

    purge = {
      receiptId: outcome.receiptId,
      detectors: outcome.detectorsAffected,
      rows: outcome.rowsRemoved,
    };
  } else {
    await objectStore.remove(file.objectKey).catch(() => undefined);
  }

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const extractions = file.siloFileId
        ? await siloExtractionRepo.deleteOfFile(db, file.siloFileId)
        : 0;

      await fileRepo.markDeleted(db, file.id);

      const receipt = await fileRepo.recordDeletion(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        fileId: file.id,
        fileName: file.name,
        fileKind: file.kind,
        scope: file.siloFileId ? 'document_and_data' : 'document',
        purgeReceiptId: purge.receiptId,
        detectorsAffected: purge.detectors,
        rowsRemoved: purge.rows,
        extractionsRemoved: extractions,
        requestedBy: actor.membershipId,
      });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'file_deleted',
        detail: {
          fileId: file.id,
          scope: receipt.scope,
          rowsRemoved: purge.rows,
          detectorsAffected: purge.detectors,
        },
      });

      log.info({ fileId: file.id, scope: receipt.scope }, 'File deleted');
      return receipt;
    }),
  );
}

/** §6 — what this person has deleted, and what it took with it. */
export async function deletions(actor: Actor): Promise<fileRepo.DeletionReceipt[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => fileRepo.deletionsBy(db, actor.membershipId)),
  );
}

/* ── §2: folders ─────────────────────────────────────────────────────────── */

/**
 * §2 — an ordinary tree, and nothing more.
 *
 * NO PERMISSIONS OF ITS OWN. "It is an arrangement, not a boundary. Every
 * access decision is made on the file, because a folder that grants access
 * would let someone widen a file's reach by moving it." So creating one needs
 * `file.manage` and confers nothing on what goes in it.
 */
export async function createFolder(
  actor: Actor,
  input: { name: string; parentId?: string | null },
): Promise<fileRepo.Folder> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'file.manage');

      if (input.parentId && !(await fileRepo.readFolder(db, input.parentId))) {
        throw notFound({ message: 'That folder does not exist.', code: 'missing.folder' });
      }

      return fileRepo.createFolder(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        name: input.name,
        parentId: input.parentId ?? null,
        createdBy: actor.membershipId,
      });
    }),
  );
}

/**
 * §2 — "A folder shows only what the viewer may see."
 *
 * AND IT DOES NOT SAY HOW MANY IT HOLDS. "Two people opening the same folder
 * see different contents, and the folder does not state how many files it
 * holds, since a count is a disclosure." So no total is returned, not even of
 * what was filtered out — that number is the disclosure.
 */
export async function browse(
  actor: Actor,
  folderId: string | null,
  kind?: fileRepo.FileKind,
): Promise<{ folders: fileRepo.Folder[]; files: fileRepo.StoredFile[] }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => ({
      folders: await fileRepo.foldersUnder(db, folderId),
      files: await fileRepo.filesIn(db, { folderId, membershipId: actor.membershipId, kind }),
    })),
  );
}

/** §7 — `file.manage` covers moving one. Moving grants nothing, by §2. */
export async function move(actor: Actor, id: string, folderId: string | null): Promise<{ moved: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'file.manage');

      await mustReach(db, actor, id);

      if (folderId && !(await fileRepo.readFolder(db, folderId))) {
        throw notFound({ message: 'That folder does not exist.', code: 'missing.folder' });
      }

      const moved = await fileRepo.moveFile(db, { id, folderId });

      if (moved) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'file_moved',
          detail: { fileId: id, folderId },
        });
      }
      return { moved };
    }),
  );
}

/* ── §4: sharing ─────────────────────────────────────────────────────────── */

export type Grantee =
  | { membershipId: string; scopeId?: never; organisationWide?: never }
  | { scopeId: string; membershipId?: never; organisationWide?: never }
  | { organisationWide: true; membershipId?: never; scopeId?: never };

/**
 * §4 — share a file, and say plainly if the recipient still cannot open it.
 *
 * THE WARNING IS THE POINT, not a nicety. "The share states that the recipient
 * cannot currently open it rather than failing silently when they try." A
 * person who shares a document and is told nothing assumes it arrived; the
 * recipient discovers otherwise, alone, later.
 */
export async function shareFile(
  actor: Actor,
  id: string,
  input: { grantee: Grantee; access?: 'view' | 'download'; expiresAt?: Date | null },
): Promise<{ shareId: string; openable: boolean; warning: string | null }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'file.share');

      const file = await mustReach(db, actor, id);

      /* THE NARROWEST SETTING WHEN THERE IS NO ROW TO READ, as maps have it:
         private by default means an unreadable organisation shares nothing. */
      const organisation = await organisationRepo.findById(db, actor.organisationId);
      const policy = organisation?.sharingPolicy ?? 'explicit_only';

      const named = 'membershipId' in input.grantee;
      const wide = 'organisationWide' in input.grantee;

      if (policy === 'disabled') {
        throw denial({
          message: 'Sharing is turned off for this organisation.',
          code: 'policy.sharing_disabled',
        });
      }
      if (policy === 'explicit_only' && !named) {
        throw denial({
          message: 'This organisation allows sharing with named people only.',
          code: 'policy.sharing_explicit_only',
        });
      }
      if (policy === 'scope_only' && wide) {
        throw denial({
          message: 'This organisation does not allow sharing with everybody.',
          code: 'policy.sharing_scope_only',
        });
      }

      const shareId = await fileRepo.share(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        fileId: id,
        membershipId: input.grantee.membershipId ?? null,
        scopeId: input.grantee.scopeId ?? null,
        organisationWide: wide,
        access: input.access ?? 'download',
        sharedBy: actor.membershipId,
        expiresAt: input.expiresAt ?? null,
      });

      /*
       * §4 — checked only for a named person, because that is the only grantee
       * whose access can be answered. A scope or the whole organisation is a
       * set whose members' clearances differ, and a warning averaged over them
       * would be wrong for most of them.
       */
      const warning =
        named && input.grantee.membershipId
          ? await siloBar(db, { ...actor, membershipId: input.grantee.membershipId }, file)
          : null;

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'file_shared',
        detail: {
          fileId: id,
          shareId,
          access: input.access ?? 'download',
          granteeType: named ? 'membership' : wide ? 'organisation' : 'scope',
        },
      });

      return {
        shareId,
        openable: warning === null,
        warning: warning ? `They cannot open this yet: ${warning}.` : null,
      };
    }),
  );
}

export async function revokeShare(actor: Actor, id: string, shareId: string): Promise<{ revoked: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustReach(db, actor, id);
      const revoked = await fileRepo.revokeShare(db, { fileId: id, shareId });

      if (revoked) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'file_share_revoked',
          detail: { fileId: id, shareId },
        });
      }
      return { revoked };
    }),
  );
}

/**
 * The file, if the caller may reach it: theirs, or shared with them.
 *
 * §4's SILO RULE IS APPLIED SEPARATELY, in `download`, and not here. Reaching a
 * file's metadata is not opening it: somebody holding a share should be able to
 * see that the document exists and be told they cannot open it, which is
 * exactly what §4 asks for — "the share states that the recipient cannot
 * currently open it rather than failing silently when they try".
 */
async function mustReach(db: PoolClient, actor: Actor, id: string): Promise<fileRepo.StoredFile> {
  const file = await fileRepo.read(db, id);
  if (!file) throw notFound({ message: 'That file does not exist.', code: 'missing.file' });

  if (file.createdBy === actor.membershipId) return file;

  const share = await fileRepo.shareFor(db, { fileId: id, membershipId: actor.membershipId });
  if (!share) {
    throw denial({ message: 'That file belongs to somebody else.', code: 'denial.file_not_owned' });
  }
  return file;
}

/**
 * §4 — "A recipient who lacks access to the underlying Silo cannot open a file
 * from it... This is the rule that keeps Files from becoming a route around
 * Silo permissions."
 *
 * ── The share does not grant it, and never will ───────────────────────────
 *
 * "Access to the Silo must be granted explicitly and beforehand. Sharing the
 * file does not grant it." So this asks the same question the Silo itself
 * would: does this person hold the permission, and are they cleared for what it
 * captures. A file is not a second door into stored data.
 *
 * ── An export has no Silo, and is therefore not subject to this ───────────
 *
 * §1 — an export is a frozen result redacted to its maker. Its governance is
 * the snapshot, not a Silo, and there is no Silo to check.
 *
 * Returns null where the caller may open it, or the reason they may not.
 */
async function siloBar(db: PoolClient, actor: Actor, file: fileRepo.StoredFile): Promise<string | null> {
  if (!file.siloId) return null;

  const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
  if (!can(authority, 'silo.manage')) return 'no access to the Silo this file came from';

  /*
   * AND CLEARED FOR WHAT IT HOLDS. The permission says they may work with
   * Siloes; the clearances say which concepts. A Silo capturing a marked
   * concept is readable only by somebody cleared for that marking, and a file
   * drawn from it inherits that question rather than escaping it.
   */
  /*
   * The same question the Silo itself would ask, through the same helper. A
   * second implementation of "is this person cleared" is a second answer, and
   * the one that drifts is always the copy.
   */
  try {
    await assertCleared(db, authority, {
      type: 'silo',
      id: file.siloId,
      conceptIds: (await siloRepo.conceptsIn(db, file.siloId)).map((one) => one.conceptId),
    });
    return null;
  } catch {
    return 'no clearance for what that Silo holds';
  }
}

/* ── What a file actually contains ───────────────────────────────────────── */

/**
 * §3 — "the file says a field was omitted rather than showing a gap".
 *
 * NAMED AT THE TOP, WHERE IT IS READ FIRST. Somebody opening a spreadsheet and
 * finding no `salary` column concludes the system does not hold one. The
 * difference between that and "you are not cleared for this" is the whole
 * reason the sentence is in the spec.
 */
/**
 * Rendering §9 — "FLAGS SURVIVE EXPORT. A total that was uncertain on screen is
 * uncertain in the spreadsheet, with the count of inferred inputs."
 *
 * ── THE SCREEN IS NOT WHERE A FIGURE STOPS ────────────────────────────────
 *
 * §6 makes the three flags visible in every representation, and a spreadsheet
 * is where a figure goes to be forwarded, pasted into a deck and quoted in a
 * meeting. A total that said "one of these forty-one values was inferred by a
 * model" on screen and says nothing in the file is a total that loses its
 * qualification at exactly the moment it starts travelling.
 *
 * They are read from the same `flagsOf` the screen uses, so the two cannot
 * differ.
 */
function asJson(answer: conceptQuery.ConceptAnswer, view: savedViewRepo.SavedView, omitted: string[]): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        producedAt: new Date().toISOString(),
        source: { kind: 'view', id: view.id, name: view.name },
        concept: answer.concept,
        omittedFields: omitted,
        omittedNote:
          omitted.length > 0
            ? 'Some fields were omitted because the person who produced this export could not see them.'
            : undefined,
        /* §9 — the flags, in the file, in the words the screen used. */
        flags: flagsOf(answer),
        lineage: answer.lineage,
        entities: answer.entities,
        aggregates: answer.aggregates,
      },
      null,
      2,
    ),
    'utf8',
  );
}

function asCsv(answer: conceptQuery.ConceptAnswer, omitted: string[]): Buffer {
  const fields = [...new Set(answer.entities.flatMap((entity) => entity.fields.map((one) => one.fieldPath)))].sort();

  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines: string[] = [];

  /* The note goes above the header, so it survives being opened in a
     spreadsheet and read from the top. */
  if (omitted.length > 0) {
    lines.push(escape(`Omitted, not visible to the person who produced this export: ${omitted.join(', ')}`));
  }

  /*
   * Rendering §9 — "Flags survive export." Above the header for the same
   * reason the omission note is: a caveat below a thousand rows is a caveat
   * nobody scrolls to, and the figure gets forwarded without it.
   */
  for (const flag of flagsOf(answer)) lines.push(escape(flag.summary));

  lines.push(['entity', ...fields].map(escape).join(','));

  for (const entity of answer.entities) {
    const byField = new Map(entity.fields.map((one) => [one.fieldPath, one.value]));
    const reference = entity.members.map((member) => member.ref).join(' | ');
    lines.push([reference, ...fields.map((field) => byField.get(field))].map(escape).join(','));
  }

  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}
