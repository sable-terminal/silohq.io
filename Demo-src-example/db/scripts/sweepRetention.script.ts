/**
 * §8 — delete captured data past its Silo's retention window.
 *
 * ── A WINDOW THAT IS NOT ENFORCED IS WORSE THAN NONE ───────────────────────
 *
 * It appears in a settings table, it is shown to the customer, it goes in the
 * disclosure, and it means nothing. This is the thing that makes the number true
 * — for recorded changes AND for the last value seen per entity, which is also a
 * customer value and which the first version of this never reached.
 *
 * ── Why a script and not a route ───────────────────────────────────────────
 *
 * A sweep is inherently cross-tenant. A cell-wide total on an endpoint lets a
 * member difference two calls into an activity signal for other customers. It
 * connects as the migrator, which is BYPASSRLS: `silo_app` is NOBYPASSRLS by
 * assertion, so a sweeper acting for nobody would match no rows and report
 * success having deleted nothing.
 *
 * ── One transaction ────────────────────────────────────────────────────────
 *
 * THE DELETES AND THEIR AUDIT ROWS COMMIT TOGETHER OR NOT AT ALL. The first
 * version deleted in one implicit transaction and wrote each audit row in its
 * own, so a failure between them left data gone with no record that it went —
 * the one outcome §8's "every deletion audited" rules out.
 *
 * ── The partition boundary ─────────────────────────────────────────────────
 *
 * Every run makes sure dated partitions exist three months ahead, rescuing any
 * rows that landed in the default partition, and drops past months the deletes
 * have emptied. A month still holding a row is never dropped.
 *
 * ── Driven from outside the process ────────────────────────────────────────
 *
 * Cloud Run scales to zero. A scheduler invoking `npm run sweep:retention` runs
 * whether or not anybody is signed in.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as siloRepo from '../../repos/silo.repo';
import * as conversationRepo from '../../repos/conversation.repo';
import * as notificationRepo from '../../repos/notification.repo';
import * as ticketRepo from '../../repos/ticket.repo';
import * as mutationRepo from '../../repos/mutation.repo';
import * as mutationExecutionRepo from '../../repos/mutationExecution.repo';
import * as simulationRunRepo from '../../repos/simulationRun.repo';
import * as connectorBuildRepo from '../../repos/connectorBuild.repo';
import * as fileRepo from '../../repos/file.repo';
import { log as writeAudit } from '../../services/audit.service';
import * as siloImportRepo from '../../repos/siloImport.repo';
import * as siloRowRepo from '../../repos/siloRow.repo';
import * as siloHoldingRepo from '../../repos/siloHolding.repo';
import * as siloLearnedRepo from '../../repos/siloLearned.repo';
import { tableOf as learnedTable } from '../../services/siloLearned.service';
import * as bigquery from '../../infra/bigquery.infra';
import * as siloExtractionRepo from '../../repos/siloExtraction.repo';
import * as rowStore from '../../services/rowStore.service';
import * as objectStore from '../../infra/objectStore.infra';
import { siloDefinition } from '../../schemas/siloDefinition.schema';

/* How far ahead partitions are made. A month of margin a missed run cannot use up. */
const MONTHS_AHEAD = 3;

async function main(): Promise<void> {
  /*
   * THE MIGRATOR URL, AND IT IS NOT INTERCHANGEABLE. `DATABASE_URL` is
   * `silo_app`, which cannot see across organisations and would delete nothing
   * while exiting zero.
   */
  const connectionString = process.env.DATABASE_MIGRATION_URL;

  if (!connectionString) {
    console.error(
      'Set DATABASE_MIGRATION_URL. The sweep is cross-tenant and needs the BYPASSRLS role;\n' +
        'DATABASE_URL is the application role and would silently sweep nothing.',
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    const created = await siloRepo.ensurePartitions(client, MONTHS_AHEAD);
    const swept = await siloRepo.sweepRetention(client);

    /*
     * IMPORT: A FILE PAST ITS WINDOW GOES WITH EVERYTHING READ OUT OF IT. The
     * rows first — in BigQuery by file, or in the stand-in in this transaction —
     * then the file's row. The object itself is deleted after the commit, so a
     * sweep that rolled back never leaves a file row pointing at nothing.
     */
    const expired = await siloImportRepo.expiredFiles(client);
    const importSwept = new Map<string, { organisationId: string; files: number; rows: number }>();
    const objectKeys: string[] = [];

    for (const file of expired) {
      let rows: number;
      if (rowStore.kind() === 'bigquery') {
        const parsed = siloDefinition.safeParse(await siloImportRepo.publishedDocumentOf(client, file.sourceId));
        rows = await rowStore.removeFileRows({
          organisationId: file.organisationId,
          sourceId: file.sourceId,
          fileId: file.fileId,
          objectNames: parsed.success ? parsed.data.objects.map((object) => object.name) : [],
        });
      } else {
        rows = await siloRowRepo.deleteRowsOfFile(client, file.fileId);
      }

      await siloExtractionRepo.deleteOfFile(client, file.fileId);
      await siloImportRepo.deleteFile(client, file.fileId);
      objectKeys.push(file.objectKey);

      const held = importSwept.get(file.siloId) ?? { organisationId: file.organisationId, files: 0, rows: 0 };
      held.files += 1;
      held.rows += rows;
      importSwept.set(file.siloId, held);
    }

    for (const [siloId, held] of importSwept) {
      await writeAudit(client, {
        event: 'retention_swept',
        organisationId: held.organisationId,
        membershipId: null,
        userId: null,
        detail: { siloId, filesRemoved: held.files, rowsRemoved: held.rows },
      });
    }

    /*
     * THE AUDIT ENTRY IS PART OF THE SWEEP, NOT A LOG LINE ABOUT IT. Written
     * through the same service every other event goes through, so its detail
     * keys are checked by the same standing test.
     */
    for (const one of swept) {
      await writeAudit(client, {
        event: 'retention_swept',
        organisationId: one.organisationId,
        membershipId: null,
        userId: null,
        detail: { siloId: one.siloId, swept: one.transitions, baselinesRemoved: one.baselines },
      });
    }

    /*
     * MUTATIONS NOBODY CARRIED THROUGH. A preview holds what every record it
     * reached said before it was changed; past its expiry that is customer data
     * kept for no reason, and the bound on `expires_at` is only true because
     * this enforces it. Targets and prior states go with the row.
     */
    /*
     * CONVERSATIONS NOBODY CAME BACK TO. The CHECK in migration 110 already
     * makes an expired thread unreadable; this is what stops it sitting there.
     * Turns cascade with it.
     */
    const goneThreads = await conversationRepo.discardExpired(client);
    const byOrganisation = new Map<string, number>();
    for (const one of goneThreads) {
      byOrganisation.set(one.organisationId, (byOrganisation.get(one.organisationId) ?? 0) + 1);
    }
    for (const [organisationId, swept] of byOrganisation) {
      await writeAudit(client, {
        event: 'retention_swept',
        organisationId,
        membershipId: null,
        userId: null,
        detail: { scope: 'conversations', swept },
      });
    }

    /*
     * NOTIFICATIONS PAST THEIR THIRTY DAYS. Their words can name a customer's
     * records, which is why they expire at all; the CHECK already makes an old
     * one unreadable and this is what stops it sitting there.
     */
    const goneNotifications = await notificationRepo.discardExpired(client);

    /*
     * TICKETS PAST THEIR NINETY DAYS. The body is free text typed beside a
     * screen of somebody's customers, which is why it expires at all; the
     * correspondence itself lives in the support inbox, so removing this copy
     * loses nothing but the panel's row.
     */
    const goneTickets = await ticketRepo.discardExpired(client);
    const discarded = await mutationRepo.discardExpired(client);
    for (const one of discarded) {
      /* A chain that ran out waiting is §15's `approval_expired`, beside the discard. */
      if (one.status === 'awaiting_approval' || one.status === 'approved') {
        await writeAudit(client, {
          event: 'approval_expired',
          organisationId: one.organisationId,
          membershipId: null,
          userId: null,
          detail: { mutationId: one.id },
        });
      }
      await writeAudit(client, {
        event: 'mutation_discarded',
        organisationId: one.organisationId,
        membershipId: null,
        userId: null,
        detail: { mutationId: one.id, reason: one.status === 'rejected' ? 'rejected' : 'expired' },
      });
    }

    /*
     * RECEIPTS PAST THEIR RETENTION DATE, with the change they record and
     * everything it kept: targets, prior states, the chain, verifications. A
     * receipt is what makes a write reviewable and revertable; past its date it
     * is customer data held for nothing.
     */
    const expiredReceipts = await mutationExecutionRepo.sweepReceipts(client);
    for (const one of expiredReceipts) {
      await writeAudit(client, {
        event: 'mutation_discarded',
        organisationId: one.organisationId,
        membershipId: null,
        userId: null,
        detail: { mutationId: one.id, reason: 'retention' },
      });
    }

    /*
     * Simulation §5 — "Re-running uses the current data and the current graph."
     * A result names the specific records a failure reached on one day; past
     * its window it is a list of a customer's identifiers kept for nothing. The
     * scenario stays, because the question does not go stale.
     *
     * NO AUDIT ROW PER RESULT. The other sweeps here delete things somebody
     * made a decision about — a change, a receipt, a captured value — and the
     * trail has to say they went. A simulation result is a derived answer whose
     * run row survives with its own count, so the number is already recoverable
     * and a row per identifier would be the identifiers again, in the trail.
     */
    const simulationResults = await simulationRunRepo.sweepExpired(client, new Date());

    /*
     * CONNECTOR BUILDS PAST THEIR DAY (127). Reads already ignore them, so this
     * reclaims space; the credential a build held went with the row, or moved
     * onto a connection when the person connected.
     */
    const expiredBuilds = await connectorBuildRepo.sweepExpired(client);

    /*
     * IMPORT §7 — UPLOADS THAT NEVER ARRIVED. The browser writes the object to
     * the bucket with a signed URL and confirms afterwards; where the
     * confirmation never came, `received_at` stayed NULL, and the sweep's
     * `received_at < now() - window` matched nothing. The bytes sat in object
     * storage with no window reaching them. `upload_expires_at` has bounded
     * them since 067 and was read by nothing.
     */
    const abandoned = await siloImportRepo.abandonedUploads(client);
    for (const file of abandoned) {
      await siloImportRepo.deleteFile(client, file.fileId);
      objectKeys.push(file.objectKey);
    }

    /*
     * FILES §6 — "Uploads carry the retention of the Silo they belong to."
     * `requestUpload` computed the expiry and wrote it; nothing ever read it,
     * so a stored upload was never deleted by anything and
     * `file_retention_swept` was an event with no writer.
     */
    const expiredFileRows = await fileRepo.expired(client, new Date());
    const filesBySilo = new Map<string, { organisationId: string; files: number }>();

    for (const file of expiredFileRows) {
      await fileRepo.markDeleted(client, file.id);
      objectKeys.push(file.objectKey);

      const key = file.siloId ?? 'none';
      const held = filesBySilo.get(key) ?? { organisationId: file.organisationId, files: 0 };
      held.files += 1;
      filesBySilo.set(key, held);
    }

    for (const [siloId, held] of filesBySilo) {
      await writeAudit(client, {
        event: 'file_retention_swept',
        organisationId: held.organisationId,
        membershipId: null,
        userId: null,
        detail: { siloId: siloId === 'none' ? null : siloId, filesRemoved: held.files },
      });
    }

    /*
     * Siloes (136) — COPIES OF KEPT CONCEPTS PAST THEIR SILO'S WINDOW. A copy
     * stopped being readable the moment it passed it; this is what stops it
     * sitting there. Where each copy replaces the last there is seldom anything
     * to find — only a concept whose copying has been failing for the whole
     * window. Where past copies are kept, this is what bounds them.
     */
    const expiredCopies = await siloHoldingRepo.expiredCopies(client);
    const copiesBySilo = new Map<string, { organisationId: string; copies: number; rows: number }>();

    for (const copy of expiredCopies) {
      const rows =
        rowStore.kind() === 'bigquery'
          ? await bigquery.deleteRows({ organisationId: copy.organisationId, sourceId: copy.holdingId, objectName: copy.objectName, where: { fileId: copy.id } })
          : 0;
      const removed = await siloHoldingRepo.deleteCopy(client, copy);

      const held = copiesBySilo.get(copy.siloId) ?? { organisationId: copy.organisationId, copies: 0, rows: 0 };
      held.copies += 1;
      held.rows += rows + removed;
      copiesBySilo.set(copy.siloId, held);
    }

    /*
     * Siloes (138) — WHAT WAS WORKED OUT FROM A COPY, PAST THE SAME WINDOW. It
     * is remade at every copy, so there is only ever something here for a
     * concept whose copying has stopped: counted with the copies it described.
     */
    for (const one of await siloLearnedRepo.expired(client)) {
      if (rowStore.kind() === 'bigquery') {
        await bigquery.deleteRows({ organisationId: one.organisationId, sourceId: one.conceptId, objectName: learnedTable(one.kind), where: { fileId: one.batchId } });
      }
      await siloLearnedRepo.forget(client, one.conceptId, [one.kind]);

      const held = copiesBySilo.get(one.siloId) ?? { organisationId: one.organisationId, copies: 0, rows: 0 };
      held.copies += 1;
      copiesBySilo.set(one.siloId, held);
    }

    for (const [siloId, held] of copiesBySilo) {
      await writeAudit(client, {
        event: 'retention_swept',
        organisationId: held.organisationId,
        membershipId: null,
        userId: null,
        detail: { siloId, copiesRemoved: held.copies, rowsRemoved: held.rows },
      });
    }

    const dropped = await siloRepo.dropEmptyPartitions(client);

    await client.query('COMMIT');

    for (const key of objectKeys) await objectStore.remove(key);

    const transitions = swept.reduce((sum, one) => sum + one.transitions, 0);
    const baselines = swept.reduce((sum, one) => sum + one.baselines, 0);
    console.log(
      `  swept ${transitions} change${transitions === 1 ? '' : 's'} and ` +
        `${baselines} last-seen value${baselines === 1 ? '' : 's'} from ${swept.length} ` +
        `Silo${swept.length === 1 ? '' : 'es'}; partitions created ${created}, dropped ${dropped}; ` +
        `imported files past their window ${expired.length}; ` +
        `lapsed mutation${discarded.length === 1 ? '' : 's'} discarded ${discarded.length}; ` +
        `receipts past retention ${expiredReceipts.length}; ` +
        `simulation results past retention ${simulationResults}; ` +
        `connector builds past their day ${expiredBuilds}; ` +
        `conversations past retention ${goneThreads.length}; ` +
        `notifications past retention ${goneNotifications}; ` +
        `tickets past retention ${goneTickets}; ` +
        `uploads never completed ${abandoned.length}; ` +
        `files past their window ${expiredFileRows.length}; ` +
        `copies of kept concepts past their window ${expiredCopies.length}`,
    );
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('Retention sweep failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
