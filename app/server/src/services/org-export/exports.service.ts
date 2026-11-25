// The organisation export (spec 2.6): asked for by a super admin (org.export, checked at
// the gateway), run by the worker as that super admin, and never withheld: no billing
// status stops it, the status it ran under is recorded.
//
// A run: every family's artefacts are collected with their markings; the requester's
// clearances were resolved when they asked, in their own session (a policy decision for a
// member needs a live session, and the run has none); an artefact carrying a marking they
// did not satisfy is recorded as omitted, naming the marking, and has no file; the rest are
// written into one gzipped tar with the manifest, under org/<organisation>/exports/<id>/,
// beside the manifest and the receipt. The receipt is issued when the export completes.
//
// The bundle is uploaded as it is written, one artefact at a time, with the manifest last:
// an artefact is built in memory (at most ORG_EXPORT_MAX_BYTES), the bundle never is.

import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import {
  EXPORT_FORMAT_VERSION, type OrgExportView,
} from '../../contracts/org-export/export.contract.ts';
import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import { objectKey, type ObjectKey } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { OrgExport, OrgExportItem } from '../../models/platform/index.model.ts';
import { markingRepo } from '../../repos/gov/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { orgExportItemRepo, orgExportRepo, outboxRepo } from '../../repos/platform/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { createTarGzipWriter } from '../../utils/tar.util.ts';
import {
  collectArtefacts, createReader, loadMarkings, tableSchemas, type Context, type Missing, type OrgExportDeps,
} from './families.service.ts';

const STALE_MINUTES = 60;
const hex = (b: Buffer | null): string | null => (b === null ? null : b.toString('hex'));
const keyOf = (organisationId: string, exportId: string, file: string): ObjectKey => objectKey.organisation(organisationId, 'exports', exportId, file);
const PARTS = {
  bundle: { file: 'bundle.tar.gz', contentType: 'application/gzip' },
  manifest: { file: 'manifest.json', contentType: 'application/json' },
  receipt: { file: 'receipt.json', contentType: 'application/json' },
} as const;

export function exportView(e: OrgExport): OrgExportView {
  return {
    id: e.id, status: e.status, requestedByMembershipId: e.requestedByMembershipId, billingStatusAtRequest: e.billingStatusAtRequest,
    formatVersion: e.formatVersion, requestedAt: e.requestedAt, startedAt: e.startedAt, completedAt: e.completedAt, failedAt: e.failedAt,
    failureCategory: e.failureCategory, itemCount: e.itemCount, omittedItemCount: e.omittedItemCount, bundleBytes: e.bundleBytes,
    bundleSha256: hex(e.bundleSha256), manifestSha256: hex(e.manifestSha256), receiptSha256: hex(e.receiptSha256), receiptIssuedAt: e.receiptIssuedAt,
  };
}

const itemView = (i: OrgExportItem) => ({
  family: i.family, artefact: i.artefactName, format: i.format, status: i.status, omittedMarkingId: i.omittedMarkingId,
  path: i.bundlePath, sha256: hex(i.sha256), bytes: i.bytes, rows: i.rowCount,
});

async function recordEvent(db: Queryable, e: {
  organisationId: string; correlationId: string; event: 'org_export_requested' | 'org_export_completed'; exportId: string;
  membershipId?: string; detail: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const actor: AuditActor = e.membershipId !== undefined ? { kind: 'membership', membershipId: e.membershipId } : { kind: 'service', service: 'org-export' };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor, subjectMembershipId: null, scopeId: null, resource: { type: 'org_export', id: e.exportId },
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: e.organisationId, topic: auditEventMessage.topic, orderingKey: e.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: e.correlationId,
  });
}

export function createExports(deps: OrgExportDeps) {
  const pool = deps.databases.pool('control');
  const now = () => deps.now?.() ?? new Date();

  async function find(db: Queryable, exportId: string): Promise<OrgExport> {
    const found = await orgExportRepo.findById(db, exportId);
    if (found === undefined) throw new AppError('not_found', 'no such export', { code: 'org_export.not_found' });
    return found;
  }

  /** One export, start to finish, as the super admin who asked. */
  async function run(organisationId: string, exportId: string): Promise<OrgExport> {
    const started = await inTransaction(pool, { organisationId }, async (db) => {
      const row = await find(db, exportId);
      if (row.status !== 'requested') return undefined;
      return orgExportRepo.update(db, exportId, { status: 'running', startedAt: now().toISOString() });
    });
    if (started === undefined) return inTransaction(pool, { organisationId }, (db) => find(db, exportId), { readOnly: true });
    const ctx: Context = { request: { organisationId, membershipId: started.requestedByMembershipId }, correlationId: exportId };
    try {
      return await produce(started, ctx);
    } catch (error) {
      // A category only, never a message: the code's last part (too_large), else the error's kind.
      const tail = isAppError(error) ? error.code?.split('.').at(-1) : undefined;
      const category = tail !== undefined && /^[a-z][a-z0-9_]*$/.test(tail) ? tail : isAppError(error) ? error.category : 'internal';
      deps.logger.failure('an organisation export failed', error, { event: 'org_export.failed', organisationId, resourceId: exportId, outcome: category });
      return inTransaction(pool, { organisationId }, async (db) =>
        (await orgExportRepo.update(db, exportId, { status: 'failed', failedAt: now().toISOString(), failureCategory: category }))!);
    }
  }

  async function produce(row: OrgExport, ctx: Context): Promise<OrgExport> {
    const organisationId = row.organisationId;
    const read = await createReader(deps, organisationId);
    const markings = await loadMarkings(read);
    // The governance tables read for markings are not artefacts of the export.
    read.used.clear();
    const missing: Missing[] = [];
    const artefacts = await collectArtefacts(deps, ctx, read, markings, missing);
    artefacts.push(...await tableSchemas(read));

    // The requester's clearances as they stood when they asked (cleared_marking_ids).
    const satisfied = new Set(row.clearedMarkingIds);

    const bundleKey = keyOf(organisationId, row.id, PARTS.bundle.file);
    const items: Parameters<typeof orgExportItemRepo.insert>[1][] = [];
    const upload = await deps.objects.openUpload('files', bundleKey, PARTS.bundle.contentType);
    let manifest: Buffer;
    let generatedAt: Date;
    let bundle: { bytes: number; sha256: Buffer };
    try {
      const tar = createTarGzipWriter(upload, now());
      for (const a of artefacts) {
        const unmet = a.markings.find((m) => !satisfied.has(m));
        if (unmet !== undefined) {
          items.push({ id: uuidv7(), organisationId, exportId: row.id, family: a.family, artefactName: a.name, format: a.format,
            status: 'omitted_marking', omittedMarkingId: unmet });
          continue;
        }
        const body = await a.body();
        if (body.length > deps.maxArtefactBytes) {
          throw new AppError('bounds', `${a.path} is larger than one artefact may be (ORG_EXPORT_MAX_BYTES)`, { code: 'org_export.too_large' });
        }
        await tar.add(a.path, body);
        items.push({ id: uuidv7(), organisationId, exportId: row.id, family: a.family, artefactName: a.name, format: a.format, status: 'included',
          bundlePath: a.path, objectKey: bundleKey, sha256: sha256(body), bytes: String(body.length), rowCount: String(a.rows) });
      }
      generatedAt = now();
      manifest = canonicalJsonBytes({
        format: 'silo.org_export_manifest.v1', format_version: row.formatVersion, export_id: row.id, organisation_id: organisationId,
        generated_at: generatedAt.toISOString(),
        files: items.filter((i) => i.status === 'included').map((i) => ({ family: i.family, artefact: i.artefactName, format: i.format, path: i.bundlePath,
          sha256: i.sha256!.toString('hex'), bytes: Number(i.bytes), rows: Number(i.rowCount) })),
        omitted: items.filter((i) => i.status === 'omitted_marking').map((i) => ({ family: i.family, artefact: i.artefactName, marking_id: i.omittedMarkingId })),
        missing,
      });
      await tar.add('manifest.json', manifest);
      bundle = await tar.finish();
      await upload.finish();
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }
    const included = items.filter((i) => i.status === 'included');
    const omitted = items.filter((i) => i.status === 'omitted_marking');
    const organisation = await inTransaction(pool, { organisationId }, (db) => organisationRepo.findById(db, organisationId), { readOnly: true });
    const receipt = canonicalJsonBytes({
      format: 'silo.org_export_receipt.v1', format_version: row.formatVersion, export_id: row.id, organisation_id: organisationId,
      organisation_slug: organisation?.slug ?? null, requested_by_membership_id: row.requestedByMembershipId, requested_at: row.requestedAt,
      billing_status_at_request: row.billingStatusAtRequest, clearances_resolved_at: row.clearanceSnapshotAt, completed_at: generatedAt.toISOString(),
      item_count: included.length, omitted_item_count: omitted.length,
      manifest_sha256: sha256(manifest).toString('hex'), bundle_sha256: bundle.sha256.toString('hex'), bundle_bytes: bundle.bytes,
      omitted: omitted.map((i) => ({ family: i.family, artefact: i.artefactName, marking_id: i.omittedMarkingId })),
      missing,
    });
    for (const [part, body] of [['manifest', manifest], ['receipt', receipt]] as const) {
      await deps.objects.put('files', keyOf(organisationId, row.id, PARTS[part].file), body, PARTS[part].contentType);
    }
    return inTransaction(pool, { organisationId }, async (db) => {
      for (const item of items) await orgExportItemRepo.insert(db, item);
      const done = (await orgExportRepo.update(db, row.id, {
        status: 'completed', completedAt: generatedAt.toISOString(), itemCount: included.length, omittedItemCount: omitted.length,
        manifestObjectKey: keyOf(organisationId, row.id, PARTS.manifest.file), manifestSha256: sha256(manifest),
        bundleObjectKey: bundleKey, bundleBytes: String(bundle.bytes), bundleSha256: bundle.sha256,
        receiptObjectKey: keyOf(organisationId, row.id, PARTS.receipt.file), receiptSha256: sha256(receipt), receiptIssuedAt: generatedAt.toISOString(),
      }))!;
      await recordEvent(db, { organisationId, correlationId: ctx.correlationId, event: 'org_export_completed', exportId: row.id, detail: {
        requested_by_membership_id: row.requestedByMembershipId, items: included.length, omitted: omitted.length,
        bundle_sha256: bundle.sha256.toString('hex'), receipt_sha256: sha256(receipt).toString('hex'), billing_status: row.billingStatusAtRequest,
      } });
      return done;
    });
  }

  return {
    run,

    async request(ctx: Context): Promise<OrgExportView> {
      const organisationId = ctx.request.organisationId!;
      const membershipId = ctx.request.membershipId!;
      return inTransaction(pool, ctx.request, async (db) => {
        const organisation = await organisationRepo.findById(db, organisationId);
        if (organisation === undefined) throw new AppError('not_found', 'no such organisation', { code: 'org_export.organisation_unknown' });
        // The requester's clearances, resolved now, in their own session: the run happens
        // later in the background, where no session stands behind it.
        const cleared: string[] = [];
        const markings = await markingRepo.listIds(db, organisationId);
        for (let i = 0; i < markings.length; i += 500) {
          const access = await deps.services.call(resolveAccess, { body: { markings: markings.slice(i, i + 500) } },
            { request: ctx.request, correlationId: ctx.correlationId });
          if (access.decision === 'allow') cleared.push(...access.markings.filter((m) => m.satisfied).map((m) => m.id));
        }
        const at = now().toISOString();
        let row: OrgExport;
        try {
          // Never withheld: the billing status is recorded, not checked.
          row = await orgExportRepo.insert(db, {
            id: uuidv7(), organisationId, requestedByMembershipId: membershipId, billingStatusAtRequest: organisation.billingStatus,
            formatVersion: EXPORT_FORMAT_VERSION, clearanceSnapshotAt: at, clearedMarkingIds: cleared, requestedAt: at,
          });
        } catch (error) {
          if (fromDatabaseError(error).category === 'conflict') {
            throw new AppError('conflict', 'an export is already running for the organisation', { code: 'org_export.already_running' });
          }
          throw error;
        }
        await recordEvent(db, { organisationId, correlationId: ctx.correlationId, event: 'org_export_requested', exportId: row.id, membershipId,
          detail: { billing_status: organisation.billingStatus, format_version: EXPORT_FORMAT_VERSION } });
        return exportView(row);
      });
    },

    async list(ctx: Context) {
      const organisationId = ctx.request.organisationId!;
      return { exports: (await inTransaction(pool, ctx.request, (db) => orgExportRepo.listForOrganisation(db, organisationId), { readOnly: true })).map(exportView) };
    },

    async get(ctx: Context, exportId: string) {
      return inTransaction(pool, ctx.request, async (db) => {
        const row = await find(db, exportId);
        return { ...exportView(row), items: (await orgExportItemRepo.listForExport(db, exportId)).map(itemView) };
      }, { readOnly: true });
    },

    async download(ctx: Context, exportId: string, input: { part: keyof typeof PARTS; offset: number; length: number }) {
      const row = await inTransaction(pool, ctx.request, (db) => find(db, exportId), { readOnly: true });
      if (row.status !== 'completed') throw new AppError('conflict', 'the export has not completed', { code: 'org_export.not_completed' });
      const { key, sha, bytes } = input.part === 'bundle' ? { key: row.bundleObjectKey!, sha: row.bundleSha256!, bytes: Number(row.bundleBytes) }
        : input.part === 'manifest' ? { key: row.manifestObjectKey!, sha: row.manifestSha256!, bytes: undefined }
          : { key: row.receiptObjectKey!, sha: row.receiptSha256!, bytes: undefined };
      const total = bytes ?? (await deps.objects.head('files', key as ObjectKey))?.bytes ?? 0;
      if (input.offset > total || (input.offset === total && total > 0)) {
        throw new AppError('validation', 'the offset is past the end', { code: 'org_export.offset' });
      }
      const end = Math.min(total, input.offset + input.length) - 1;
      const content = total === 0 ? Buffer.alloc(0) : await deps.objects.getRange('files', key as ObjectKey, input.offset, end);
      return {
        name: `silo-export-${exportId}-${PARTS[input.part].file}`, contentType: PARTS[input.part].contentType, totalBytes: total,
        sha256: sha.toString('hex'), offset: input.offset, content: content.toString('base64'),
      };
    },

    /** The worker's sweep: requested exports run; a run a stopped process left behind is failed, to be asked again. */
    async sweep(limit = 5): Promise<number> {
      const due = await inTransaction(pool, {}, (db) => orgExportRepo.due(db, limit, STALE_MINUTES), { readOnly: true });
      let ran = 0;
      for (const d of due) {
        if (d.stale) {
          await inTransaction(pool, { organisationId: d.organisationId }, (db) =>
            orgExportRepo.update(db, d.id, { status: 'failed', failedAt: now().toISOString(), failureCategory: 'interrupted' }));
          continue;
        }
        await run(d.organisationId, d.id);
        ran += 1;
      }
      return ran;
    },
  };
}

export type Exports = ReturnType<typeof createExports>;
