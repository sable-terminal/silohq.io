// Uploads in Files (spec 41.4 to 41.6): the catalogue entry of a document stored against an
// Import Silo. siloes-import holds the bytes and decides the Silo's own rules (silo.import, its
// markings, the type from the bytes, an SVG made safe); this keeps the entry: its name and
// folder, the Silo's retention as its own, and the Silo's markings as the file's.
//
// - Upload: file.upload, within the export bound in one request; stored, or ingested through a
//   source with a definition. Audited file_uploaded, and file_ingested when ingested. Larger,
//   up to the import bound: a signed transfer straight to the Silo's storage, then completed
//   into the same storage and entry (41.4); opened through a signed download link.
// - Open: as any file (the entry's access and markings), then the Silo checks again (open, and its
//   markings now; not silo.import); a person a share reaches who is not cleared is refused, and that
//   is recorded.
// - Delete: a purge of its Silo file, requested in the person's name (silo.purge, and the
//   purge approval chain where one is configured). The entry goes when the purge completes,
//   with the purge's receipt as its own (recordUploadsPurged), as it does when a Silo is wiped.

import {
  beginFilesUpload, completeFilesUpload, getFilesUpload, readFilesUpload, signFilesUploadRead, storeFilesUpload,
} from '../../contracts/siloes/import.contract.ts';
import { requestPurge } from '../../contracts/siloes/siloes.contract.ts';
import type { FileView } from '../../contracts/files/file.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { File } from '../../models/files/index.model.ts';
import { fileDeletionRepo, fileMarkingRepo, fileRepo, fileShareRepo, folderRepo } from '../../repos/files/index.repo.ts';
import { outboxRepo } from '../../repos/platform/outbox.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { derivedKey } from '../visual-builder/versions.service.ts';
import { demand, memberOf, recordEvent, type Actor, type Context, type FilesDeps } from './deps.service.ts';
import { fileViewOf } from './files.service.ts';

const call = (actor: Actor, ctx: Context) => ({ request: actor.request, correlationId: ctx.correlationId });

export async function uploadFile(deps: FilesDeps, ctx: Context & { idempotencyKey?: string | undefined }, input: {
  siloId: string; name: string; folderId?: string | undefined; contentBase64: string; ingest?: { sourceId: string } | undefined;
}): Promise<FileView> {
  const actor = await memberOf(deps, ctx);
  await demand(deps, ctx, 'file.upload');
  const size = Buffer.byteLength(input.contentBase64, 'base64');
  if (size > deps.config.maxExportBytes) {
    throw new AppError('bounds', 'the file is larger than an upload may be', { code: 'files.upload_too_large', details: { bound: 'bytes', limit: deps.config.maxExportBytes } });
  }
  if (input.folderId !== undefined) {
    const folder = await inTransaction(deps.databases.pool('control'), actor.request, (db) => folderRepo.findById(db, input.folderId!), { readOnly: true });
    if (folder === undefined) throw new AppError('not_found', 'no such folder', { code: 'files.folder_not_found' });
  }
  const fileId = uuidv7();
  const stored = await deps.services.call(storeFilesUpload, {
    body: { siloId: input.siloId, filename: input.name, contentBase64: input.contentBase64, ...(input.ingest ? { sourceId: input.ingest.sourceId } : {}) },
  }, { ...call(actor, ctx), idempotencyKey: derivedKey(ctx.idempotencyKey ?? fileId, 'silo') });
  return catalogue(deps, ctx, actor, fileId, input, stored);
}

type Stored = { siloFileId: string; sizeBytes: number; ingested: boolean; retentionDays: number; markingIds: string[] };

async function folderExists(deps: FilesDeps, actor: Actor, folderId: string | undefined): Promise<void> {
  if (folderId === undefined) return;
  const folder = await inTransaction(deps.databases.pool('control'), actor.request, (db) => folderRepo.findById(db, folderId), { readOnly: true });
  if (folder === undefined) throw new AppError('not_found', 'no such folder', { code: 'files.folder_not_found' });
}

/** A signed transfer for an upload larger than one request (41.4). */
export async function beginLargeUpload(deps: FilesDeps, ctx: Context, input: { siloId: string; sizeBytes: number; folderId?: string | undefined }) {
  const actor = await memberOf(deps, ctx);
  await demand(deps, ctx, 'file.upload');
  await folderExists(deps, actor, input.folderId);
  return deps.services.call(beginFilesUpload, { body: { siloId: input.siloId, sizeBytes: input.sizeBytes } }, call(actor, ctx));
}

/** The transfer landed: stored by the Silo, then catalogued as any upload is. */
export async function completeLargeUpload(deps: FilesDeps, ctx: Context & { idempotencyKey?: string | undefined }, uploadId: string, input: {
  siloId: string; name: string; folderId?: string | undefined; ingest?: { sourceId: string } | undefined;
}): Promise<FileView> {
  const actor = await memberOf(deps, ctx);
  await demand(deps, ctx, 'file.upload');
  await folderExists(deps, actor, input.folderId);
  const fileId = uuidv7();
  const stored = await deps.services.call(completeFilesUpload, {
    params: { uploadId }, body: { siloId: input.siloId, filename: input.name, ...(input.ingest ? { sourceId: input.ingest.sourceId } : {}) },
  }, { ...call(actor, ctx), idempotencyKey: derivedKey(ctx.idempotencyKey ?? uploadId, 'silo') });
  return catalogue(deps, ctx, actor, fileId, input, stored);
}

/** A signed link to an upload's bytes, after the entry's own checks; the Silo decides whether this person may open it now. */
export async function uploadLink(deps: FilesDeps, ctx: Context, actor: Actor, row: File, refuse: (reason: string) => Promise<never>) {
  let link;
  try {
    link = await deps.services.call(signFilesUploadRead, { params: { siloFileId: row.siloFileId! } }, call(actor, ctx));
  } catch (error) {
    if (isAppError(error) && (error.category === 'forbidden' || error.category === 'not_found')) return refuse('silo_access');
    throw error;
  }
  return { url: link.url, expiresAt: link.expiresAt, name: row.name, contentType: link.contentType, size: link.sizeBytes };
}

/** The entry of a stored upload: its folder, the Silo's retention and markings as its own. */
export async function catalogue(deps: FilesDeps, ctx: Context, actor: Actor, fileId: string,
  input: { siloId: string; name: string; folderId?: string | undefined }, stored: Stored): Promise<FileView> {
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const now = deps.now();
    const row = await fileRepo.insert(db, {
      id: fileId, organisationId: actor.organisationId, folderId: input.folderId ?? null, kind: 'upload', name: input.name, objectStoreKey: null,
      contentType: null, size: null, siloFileId: stored.siloFileId, ingestionState: stored.ingested ? 'ingested' : 'stored', status: 'available',
      // The Silo's window is the file's: the Silo's retention removes it, and Files with it.
      retention: `${stored.retentionDays} days`, expiresAt: new Date(now + stored.retentionDays * 86_400_000).toISOString(), createdBy: actor.membershipId,
    });
    for (const markingId of stored.markingIds) await fileMarkingRepo.insert(db, { organisationId: actor.organisationId, fileId, markingId });
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'file_uploaded', resource: { type: 'file', id: fileId }, subjectMembershipId: actor.membershipId,
      detail: { silo_id: input.siloId, bytes: stored.sizeBytes, ingested: stored.ingested },
    });
    if (stored.ingested) {
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'file_ingested', resource: { type: 'file', id: fileId }, subjectMembershipId: actor.membershipId, detail: { silo_id: input.siloId },
      });
    }
    return fileViewOf(db, row, 'owner', true);
  });
}

/** An upload's bytes, after the entry's own checks: the Silo decides whether this person may open it now. */
export async function openUpload(deps: FilesDeps, ctx: Context, actor: Actor, row: File, refuse: (reason: string) => Promise<never>) {
  let read;
  try {
    read = await deps.services.call(readFilesUpload, { params: { siloFileId: row.siloFileId! } }, call(actor, ctx));
  } catch (error) {
    if (isAppError(error) && (error.category === 'forbidden' || error.category === 'not_found')) return refuse('silo_access');
    throw error;
  }
  return { name: row.name, contentType: read.contentType, size: Buffer.byteLength(read.content, 'base64'), content: read.content };
}

/** Deleting an upload: a purge of its Silo file, requested in the person's name. */
export async function deleteUpload(deps: FilesDeps, ctx: Context, actor: Actor, row: File) {
  const upload = await deps.services.call(getFilesUpload, { params: { siloFileId: row.siloFileId! } }, call(actor, ctx));
  const purge = await deps.services.call(requestPurge, { params: { siloId: upload.siloId }, body: { scope: 'file', fileId: row.siloFileId! } }, call(actor, ctx));
  return { fileId: row.id, purgeId: purge.id, purgeStatus: purge.status };
}

/** The entries of uploads a purge removed: deleted, with the purge's receipt as theirs (spec 41.5). */
export async function recordUploadsPurged(deps: FilesDeps, ctx: Context, input: { siloFileIds: string[]; purgeReceiptId: string; requestedBy: string }) {
  const organisationId = ctx.request.organisationId!;
  const actor: Pick<Actor, 'organisationId' | 'audit'> = { organisationId, audit: { kind: 'service', service: 'files' } };
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    let deleted = 0;
    const removed: string[] = [];
    for (const row of await fileRepo.listForSiloFiles(db, input.siloFileIds)) {
      if (row.status === 'deleted') continue;
      const at = new Date(deps.now()).toISOString();
      await fileRepo.update(db, row.id, { status: 'deleted', deletedAt: at });
      const shares = await fileShareRepo.revokeAllFor(db, row.id, input.requestedBy);
      await fileDeletionRepo.insert(db, {
        id: uuidv7(), organisationId, fileId: row.id, requestedBy: input.requestedBy, completedAt: at, purgeReceiptId: input.purgeReceiptId,
        // What stopped working is the purge's to say: its receipt names it.
        scopeOfRemoval: { reason: 'purge', file: row.id, kind: 'upload', document: true, derived: row.ingestionState === 'ingested' ? ['extractions'] : [],
          detectorsLosingInput: [] },
        counts: { files: 1, documents: 1, sharesRevoked: shares },
      });
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'file_deleted', resource: { type: 'file', id: row.id }, subjectMembershipId: row.createdBy, detail: { shares_revoked: shares, purge_receipt_id: input.purgeReceiptId },
      });
      deleted += 1;
      removed.push(row.id);
    }
    // The purge ledger (8.2; D251): the entries go again after a restore, as the Silo file does.
    if (removed.length > 0) await outboxRepo.recordPurge(db, { organisationId, correlationId: ctx.correlationId, entry: { kind: 'files', fileIds: removed } });
    return { deleted };
  });
}
