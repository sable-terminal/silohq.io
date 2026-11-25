// Files as people use them (spec 41.1, 41.3, 41.5, 41.6): listing what they may see,
// opening, sharing, arranging into folders, and deleting.
//
// Who may do what:
// - see a file: its creator, or a member a live share reaches (the membership, a scope
//   whose subtree holds one of theirs, or the organisation);
// - open it (download): its creator, or a share giving download access; and in every case
//   the caller must satisfy every marking on it now. A refusal is answered plainly and
//   recorded (file_download_refused), the evidence that the boundary holds;
// - share it: its creator, holding file.share; a share never grants a marking, and a share
//   with the whole organisation needs the organisation to permit organisation-wide sharing;
// - rename or move it: its creator, or a holder of file.manage; folders likewise;
// - delete it: its creator, or a holder of file.delete. The document goes first, then the
//   file is marked deleted with its receipt: what was removed, by whom, what stopped.

import type { FileShareView, FileView, FolderView } from '../../contracts/files/file.contract.ts';
import { objectKey, type ObjectKey } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { File, FileShare, Folder } from '../../models/files/index.model.ts';
import {
  fileDeletionRepo, fileMarkingRepo, fileProvenanceRepo, fileRepo, fileShareRepo, folderRepo,
} from '../../repos/files/index.repo.ts';
import { membershipRepo, organisationRepo, scopeMembershipRepo, scopeRepo } from '../../repos/iam/index.repo.ts';
import { outboxRepo } from '../../repos/platform/outbox.repo.ts';
import type { StoredLedgerEntry } from '../../contracts/platform/purgeLedger.contract.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  allowed, demand, fileNotFound, memberOf, recordEvent, satisfiesAll, type Actor, type Context, type FilesDeps,
} from './deps.service.ts';
import { deleteUpload, openUpload, uploadLink } from './uploads.service.ts';

type Access = 'owner' | 'view' | 'download';

export async function fileViewOf(db: Queryable, row: File, access: Access, canOpen: boolean): Promise<FileView> {
  const markings = (await fileMarkingRepo.labelsFor(db, [row.id])).map((m) => ({ id: m.id, name: m.name }));
  const provenance = await fileProvenanceRepo.findByKey(db, { organisationId: row.organisationId, fileId: row.id });
  return {
    id: row.id, kind: row.kind, name: row.name, folderId: row.folderId, contentType: row.contentType,
    size: row.size === null ? null : Number(row.size), createdBy: row.createdBy, createdAt: row.createdAt, expiresAt: row.expiresAt,
    markings,
    provenance: provenance === undefined ? null : {
      sourceKind: provenance.sourceKind,
      sourceId: (provenance.sourceSavedViewId ?? provenance.sourceAutomationRunId ?? provenance.sourceFindingId ?? provenance.sourceDetectorRunId
        ?? provenance.sourceReceiptId ?? provenance.sourceSimulationRunId ?? provenance.sourceCanvasViewId ?? provenance.sourceLineageNodeId ?? provenance.sourceAppVersionId ?? provenance.sourceWorkbookId ?? provenance.sourceReportId ?? provenance.sourceProcessAnalysisId ?? provenance.sourceNotebookId)!,
      runReference: provenance.runReference, producedAt: provenance.producedAt,
    },
    access, canOpen,
  };
}

const folderViewOf = (row: Folder): FolderView => ({ id: row.id, name: row.name, parentId: row.parentId, createdBy: row.createdBy, createdAt: row.createdAt });

async function visible(deps: FilesDeps, actor: Actor, filter: { which: 'all' | 'mine' | 'shared'; folderId?: string | undefined; fileId?: string | undefined; limit: number }) {
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const scopePaths = await scopeMembershipRepo.activeScopePaths(db, actor.membershipId);
    return fileRepo.listVisible(db, { membershipId: actor.membershipId, scopePaths, ...filter });
  }, { readOnly: true });
}

/** The file, if the caller may see it, with the access it gives them. */
async function reachable(deps: FilesDeps, actor: Actor, fileId: string): Promise<File & { access: Access }> {
  const [row] = await visible(deps, actor, { which: 'all', fileId, limit: 1 });
  if (row === undefined) throw fileNotFound();
  return row;
}

export async function listFiles(deps: FilesDeps, ctx: Context, query: { which: 'all' | 'mine' | 'shared'; folderId?: string | undefined; limit: number }) {
  const actor = await memberOf(deps, ctx);
  const rows = await visible(deps, actor, query);
  const labels = await inTransaction(deps.databases.pool('control'), actor.request, (db) => fileMarkingRepo.labelsFor(db, rows.map((r) => r.id)), { readOnly: true });
  // One marking decision for the page: whether the caller holds each marking any file carries.
  const all = [...new Set(labels.map((l) => l.id))];
  const held = new Map<string, boolean>();
  for (const id of all) held.set(id, await satisfiesAll(deps, ctx, [id]));
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => ({
    files: await Promise.all(rows.map((row) => fileViewOf(db, row, row.access,
      labels.filter((l) => l.fileId === row.id).every((l) => held.get(l.id) === true)))),
  }), { readOnly: true });
}

export async function getFile(deps: FilesDeps, ctx: Context, fileId: string): Promise<FileView> {
  const actor = await memberOf(deps, ctx);
  const row = await reachable(deps, actor, fileId);
  const markings = await inTransaction(deps.databases.pool('control'), actor.request, (db) => fileMarkingRepo.labelsFor(db, [fileId]), { readOnly: true });
  const canOpen = await satisfiesAll(deps, ctx, markings.map((m) => m.id));
  return inTransaction(deps.databases.pool('control'), actor.request, (db) => fileViewOf(db, row, row.access, canOpen), { readOnly: true });
}

/** A signed download link for an upload too large to open in a reply (41.4): checked as opening it is, and recorded as opened. */
export async function downloadLink(deps: FilesDeps, ctx: Context, fileId: string) {
  const actor = await memberOf(deps, ctx);
  const row = await reachable(deps, actor, fileId);
  const control = deps.databases.pool('control');
  const markings = await inTransaction(control, actor.request, (db) => fileMarkingRepo.labelsFor(db, [fileId]), { readOnly: true });
  const refuse = async (reason: string): Promise<never> => {
    await inTransaction(control, actor.request, (db) => recordEvent(db, actor, ctx.correlationId, {
      event: 'file_download_refused', resource: { type: 'file', id: fileId }, subjectMembershipId: row.createdBy, detail: { reason },
    }));
    throw new AppError('forbidden', 'you cannot open this file', { code: 'files.cannot_open', details: { reason } });
  };
  if (row.access === 'view') return refuse('view_only');
  if (!await satisfiesAll(deps, ctx, markings.map((m) => m.id))) return refuse('marking_unsatisfied');
  if (row.kind !== 'upload') throw new AppError('validation', 'an export opens in one reply', { code: 'files.link_for_uploads' });
  const link = await uploadLink(deps, ctx, actor, row, refuse);
  await inTransaction(control, actor.request, (db) => recordEvent(db, actor, ctx.correlationId, {
    event: 'file_opened', resource: { type: 'file', id: fileId }, subjectMembershipId: row.createdBy, detail: { bytes: link.size, link: true },
  }));
  return link;
}

export async function downloadFile(deps: FilesDeps, ctx: Context, fileId: string) {
  const actor = await memberOf(deps, ctx);
  const row = await reachable(deps, actor, fileId);
  const control = deps.databases.pool('control');
  const markings = await inTransaction(control, actor.request, (db) => fileMarkingRepo.labelsFor(db, [fileId]), { readOnly: true });
  const refuse = async (reason: string): Promise<never> => {
    await inTransaction(control, actor.request, (db) => recordEvent(db, actor, ctx.correlationId, {
      event: 'file_download_refused', resource: { type: 'file', id: fileId }, subjectMembershipId: row.createdBy, detail: { reason },
    }));
    throw new AppError('forbidden', 'you cannot open this file', { code: 'files.cannot_open', details: { reason } });
  };
  if (row.access === 'view') return refuse('view_only');
  if (!await satisfiesAll(deps, ctx, markings.map((m) => m.id))) return refuse('marking_unsatisfied');
  if (row.kind === 'upload') {
    let opened;
    try {
      opened = await openUpload(deps, ctx, actor, row, refuse);
    } catch (error) {
      // Larger than a reply: the person is pointed at the download link, not refused.
      if (isAppError(error) && error.code === 'import.read_too_large') {
        throw new AppError('bounds', 'the file is too large to open in one reply: ask for a download link', {
          code: 'files.download_link_needed', details: error.details,
        });
      }
      throw error;
    }
    await inTransaction(control, actor.request, (db) => recordEvent(db, actor, ctx.correlationId, {
      event: 'file_opened', resource: { type: 'file', id: fileId }, subjectMembershipId: row.createdBy, detail: { bytes: opened.size },
    }));
    return opened;
  }
  if (row.objectStoreKey === null) return refuse('document_missing');
  const bytes = await deps.store.get('files', row.objectStoreKey as ObjectKey);
  await inTransaction(control, actor.request, (db) => recordEvent(db, actor, ctx.correlationId, {
    event: 'file_opened', resource: { type: 'file', id: fileId }, subjectMembershipId: row.createdBy, detail: { bytes: bytes.length },
  }));
  return { name: row.name, contentType: row.contentType!, size: bytes.length, content: bytes.toString('base64') };
}

async function mayManage(deps: FilesDeps, ctx: Context, actor: Actor, createdBy: string, permission: 'file.manage' | 'file.delete'): Promise<void> {
  if (createdBy === actor.membershipId) return;
  if (!await allowed(deps, ctx, permission)) throw fileNotFound();
}

export async function updateFile(deps: FilesDeps, ctx: Context, fileId: string, input: { name?: string | undefined; folderId?: string | null | undefined }) {
  const actor = await memberOf(deps, ctx);
  const row = await reachable(deps, actor, fileId);
  await mayManage(deps, ctx, actor, row.createdBy, 'file.manage');
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    if (input.folderId !== undefined && input.folderId !== null && !await folderRepo.findById(db, input.folderId)) {
      throw new AppError('not_found', 'no such folder', { code: 'files.folder_not_found' });
    }
    const updated = (await fileRepo.update(db, fileId, {
      ...(input.name !== undefined ? { name: input.name } : {}), ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    }))!;
    await recordEvent(db, actor, ctx.correlationId, {
      event: input.folderId !== undefined ? 'file_moved' : 'file_renamed', resource: { type: 'file', id: fileId }, subjectMembershipId: row.createdBy,
    });
    return fileViewOf(db, updated, row.access, true);
  });
}

/** Removes the document, then records the deletion and its receipt (spec 41.5). */
export async function deleteFileAs(deps: FilesDeps, actor: Actor, correlationId: string, fileId: string, reason: 'requested' | 'retention') {
  const control = deps.databases.pool('control');
  const row = await inTransaction(control, actor.request, (db) => fileRepo.findById(db, fileId), { readOnly: true });
  if (!row || row.status === 'deleted') throw fileNotFound();
  // The document first: a source document left behind after deletion is what a reviewer tests for.
  if (row.objectStoreKey !== null) await deps.store.delete('files', row.objectStoreKey as ObjectKey);
  return inTransaction(control, actor.request, async (db) => {
    const locked = (await fileRepo.findForUpdate(db, fileId))!;
    if (locked.status === 'deleted') throw fileNotFound();
    const at = new Date(deps.now()).toISOString();
    await fileRepo.update(db, fileId, { status: 'deleted', deletedAt: at });
    const shares = await fileShareRepo.revokeAllFor(db, fileId, actor.membershipId);
    const counts = { files: 1, documents: row.objectStoreKey === null ? 0 : 1, sharesRevoked: shares, extractions: 0 };
    const deletionId = uuidv7();
    await fileDeletionRepo.insert(db, {
      id: deletionId, organisationId: actor.organisationId, fileId, requestedBy: actor.membershipId, completedAt: at, purgeReceiptId: null,
      // What stopped working: an export has no extractions and feeds no detector.
      scopeOfRemoval: { reason, file: fileId, kind: row.kind, document: row.objectStoreKey !== null, derived: [], detectorsLosingInput: [] },
      counts,
    });
    await recordEvent(db, actor, correlationId, {
      event: reason === 'retention' ? 'file_retention_swept' : 'file_deleted', resource: { type: 'file', id: fileId }, subjectMembershipId: row.createdBy,
      detail: { shares_revoked: shares },
    });
    // The purge ledger (8.2; D251): a requested deletion is replayed after a restore; retention sweeps again by itself.
    if (reason === 'requested') await outboxRepo.recordPurge(db, { organisationId: actor.organisationId, correlationId, entry: { kind: 'files', fileIds: [fileId] } });
    return { fileId, deletionId, completedAt: at, counts };
  });
}

export async function deleteFile(deps: FilesDeps, ctx: Context, fileId: string) {
  const actor = await memberOf(deps, ctx);
  const row = await reachable(deps, actor, fileId);
  await mayManage(deps, ctx, actor, row.createdBy, 'file.delete');
  // An upload is Silo data: deleting it is a purge of its Silo file (41.6), decided by siloes-capture.
  if (row.kind === 'upload') return deleteUpload(deps, ctx, actor, row);
  return deleteFileAs(deps, actor, ctx.correlationId, fileId, 'requested');
}

// ----------------------------------------------------------------------------- sharing

function shareViewOf(row: FileShare, fileHasMarkings: boolean): FileShareView {
  return {
    id: row.id, fileId: row.fileId, granteeMembershipId: row.granteeMembershipId, granteeScopeId: row.granteeScopeId,
    granteeWholeOrganisation: row.granteeWholeOrganisation === true, access: row.access, sharedBy: row.sharedBy, expiresAt: row.expiresAt,
    revokedAt: row.revokedAt, createdAt: row.createdAt,
    // Clearances are policy's to decide, for a member with a session: checked at every open.
    recipientCanOpen: fileHasMarkings ? 'unknown' : 'yes',
  };
}

async function ownFile(deps: FilesDeps, ctx: Context, actor: Actor, fileId: string): Promise<File & { access: Access }> {
  const row = await reachable(deps, actor, fileId);
  if (row.createdBy !== actor.membershipId) throw new AppError('forbidden', 'only the file\'s creator shares it', { code: 'files.not_owner' });
  return row;
}

export async function shareFile(deps: FilesDeps, ctx: Context, fileId: string, input: {
  grantee: { membershipId: string } | { scopeId: string } | { organisation: true }; access: 'view' | 'download'; expiresAt?: string | undefined;
}): Promise<FileShareView> {
  const actor = await memberOf(deps, ctx);
  await ownFile(deps, ctx, actor, fileId);
  await demand(deps, ctx, 'file.share');
  const grantee = input.grantee;
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    if ('membershipId' in grantee && (await membershipRepo.findById(db, grantee.membershipId))?.status !== 'active') {
      throw new AppError('not_found', 'no such member', { code: 'files.grantee_unknown' });
    }
    if ('scopeId' in grantee && !await scopeRepo.findById(db, grantee.scopeId)) {
      throw new AppError('not_found', 'no such scope', { code: 'files.grantee_unknown' });
    }
    if ('organisation' in grantee && !(await organisationRepo.findById(db, actor.organisationId))?.orgWideSharingPermitted) {
      throw new AppError('forbidden', 'this organisation does not permit sharing with everyone', { code: 'files.org_wide_sharing_off' });
    }
    const live = (await fileShareRepo.listForFile(db, fileId)).find((s) => s.revokedAt === null
      && ('membershipId' in grantee ? s.granteeMembershipId === grantee.membershipId
        : 'scopeId' in grantee ? s.granteeScopeId === grantee.scopeId : s.granteeWholeOrganisation === true));
    let row: FileShare;
    try {
      row = live !== undefined
        ? (await fileShareRepo.update(db, live.id, { access: input.access, expiresAt: input.expiresAt ?? null }))!
        : await fileShareRepo.insert(db, {
          id: uuidv7(), organisationId: actor.organisationId, fileId, access: input.access, sharedBy: actor.membershipId,
          expiresAt: input.expiresAt ?? null,
          granteeMembershipId: 'membershipId' in grantee ? grantee.membershipId : null,
          granteeScopeId: 'scopeId' in grantee ? grantee.scopeId : null,
          granteeWholeOrganisation: 'organisation' in grantee ? true : null,
        });
    } catch (error) {
      throw fromDatabaseError(error);
    }
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'file_shared', resource: { type: 'file', id: fileId },
      subjectMembershipId: 'membershipId' in grantee ? grantee.membershipId : null,
      detail: { access: input.access, grantee: 'membershipId' in grantee ? 'membership' : 'scopeId' in grantee ? 'scope' : 'organisation' },
    });
    const markings = await fileMarkingRepo.labelsFor(db, [fileId]);
    return shareViewOf(row, markings.length > 0);
  });
}

export async function revokeFileShare(deps: FilesDeps, ctx: Context, fileId: string, shareId: string): Promise<FileShareView> {
  const actor = await memberOf(deps, ctx);
  const row = await reachable(deps, actor, fileId);
  await mayManage(deps, ctx, actor, row.createdBy, 'file.manage');
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const share = await fileShareRepo.findById(db, shareId);
    if (!share || share.fileId !== fileId) throw new AppError('not_found', 'no such share', { code: 'files.share_not_found' });
    const updated = share.revokedAt !== null ? share
      : (await fileShareRepo.update(db, shareId, { revokedAt: new Date(deps.now()).toISOString(), revokedBy: actor.membershipId }))!;
    if (share.revokedAt === null) {
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'file_share_revoked', resource: { type: 'file', id: fileId }, subjectMembershipId: share.granteeMembershipId,
      });
    }
    return shareViewOf(updated, (await fileMarkingRepo.labelsFor(db, [fileId])).length > 0);
  });
}

export async function listFileShares(deps: FilesDeps, ctx: Context, fileId: string): Promise<FileShareView[]> {
  const actor = await memberOf(deps, ctx);
  await ownFile(deps, ctx, actor, fileId);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const marked = (await fileMarkingRepo.labelsFor(db, [fileId])).length > 0;
    return (await fileShareRepo.listForFile(db, fileId)).map((s) => shareViewOf(s, marked));
  }, { readOnly: true });
}

// ----------------------------------------------------------------------------- folders

export async function createFolder(deps: FilesDeps, ctx: Context, input: { name: string; parentId?: string | undefined }): Promise<FolderView> {
  const actor = await memberOf(deps, ctx);
  try {
    return await inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
      if (input.parentId !== undefined && !await folderRepo.findById(db, input.parentId)) {
        throw new AppError('not_found', 'no such folder', { code: 'files.folder_not_found' });
      }
      const row = await folderRepo.insert(db, {
        id: uuidv7(), organisationId: actor.organisationId, name: input.name, parentId: input.parentId ?? null, path: 'x', createdBy: actor.membershipId,
      });
      await recordEvent(db, actor, ctx.correlationId, { event: 'folder_created', resource: { type: 'folder', id: row.id } });
      return folderViewOf(row);
    });
  } catch (error) {
    const mapped = fromDatabaseError(error);
    if (mapped.category === 'conflict') throw new AppError('conflict', 'a folder of that name is already there', { code: 'files.folder_name_taken' });
    throw mapped;
  }
}

export async function listFolders(deps: FilesDeps, ctx: Context, parentId: string | undefined): Promise<FolderView[]> {
  const actor = await memberOf(deps, ctx);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => (await folderRepo.listChildren(db, parentId ?? null)).map(folderViewOf),
    { readOnly: true });
}

export async function updateFolder(deps: FilesDeps, ctx: Context, folderId: string, input: { name?: string | undefined; parentId?: string | null | undefined }) {
  const actor = await memberOf(deps, ctx);
  const control = deps.databases.pool('control');
  const row = await inTransaction(control, actor.request, (db) => folderRepo.findById(db, folderId), { readOnly: true });
  if (!row) throw new AppError('not_found', 'no such folder', { code: 'files.folder_not_found' });
  await mayManage(deps, ctx, actor, row.createdBy, 'file.manage');
  try {
    return await inTransaction(control, actor.request, async (db) => {
      const updated = (await folderRepo.update(db, folderId, {
        ...(input.name !== undefined ? { name: input.name } : {}), ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      }))!;
      if (input.parentId !== undefined) await recordEvent(db, actor, ctx.correlationId, { event: 'folder_moved', resource: { type: 'folder', id: folderId } });
      return folderViewOf(updated);
    });
  } catch (error) {
    const mapped = fromDatabaseError(error);
    if (mapped.category === 'conflict') throw new AppError('conflict', 'a folder of that name is already there', { code: 'files.folder_name_taken' });
    if (mapped.details['sqlstate'] === '23514') throw new AppError('validation', 'a folder cannot move under its own descendant', { code: 'files.folder_cycle' });
    throw mapped;
  }
}

export { objectKey };

/**
 * Replays Files deletions from the purge ledger after a restore (spec 8.2, 12.5; D251): each entry
 * deleted again, its shares revoked and its document removed from the store where it is still
 * there; an entry the restore does not hold, or holds deleted, is skipped. The deletion receipt
 * stays in the ledger itself.
 */
export async function replayFileDeletions(deps: FilesDeps, entries: readonly StoredLedgerEntry[]): Promise<{ replayed: number; skipped: number }> {
  const control = deps.databases.pool('control');
  let replayed = 0;
  let skipped = 0;
  for (const stored of entries) {
    if (stored.entry.kind !== 'files') { skipped += 1; continue; }
    for (const fileId of stored.entry.fileIds) {
      const row = await inTransaction(control, { organisationId: stored.organisationId }, (db) => fileRepo.findById(db, fileId), { readOnly: true });
      if (row === undefined || row.status === 'deleted') { skipped += 1; continue; }
      if (row.objectStoreKey !== null) await deps.store.delete('files', row.objectStoreKey as ObjectKey).catch(() => undefined);
      await inTransaction(control, { organisationId: stored.organisationId }, async (db) => {
        await fileRepo.update(db, fileId, { status: 'deleted', deletedAt: stored.occurredAt });
        await fileShareRepo.revokeAllFor(db, fileId, row.createdBy);
      });
      replayed += 1;
    }
  }
  return { replayed, skipped };
}
