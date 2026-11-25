// Files (spec 41): documents Silo produced (exports) and, once Siloes exist, documents a
// customer uploaded. An export is a frozen result made by a person under their permissions
// at a moment in time: it never tracks its source, and its markings, field policies and
// connection grants are those of the person who made it, frozen at creation.
//
// Folders are an arrangement, never a boundary: every access decision is made on the file,
// and a folder never says how many files it holds. A file is reached by its creator, or
// through a live share (a membership, a scope and its subtree, or the organisation); a share
// never grants a marking, and access is checked at share time and at every open (spec
// 41.3). A recipient who cannot open a file is told so, and the refusal is recorded.
//
// Downloads come back through the gateway as base64 in JSON, bounded (FILES_MAX_EXPORT_BYTES):
// the object store is never exposed to the browser, and access is re-checked on each open.
//
// Uploads (spec 41.4): stored against an enabled Import Silo through siloes-import, which
// owns the bytes (so an upload sits inside the Siloes disclosure and carries the Silo's
// retention and markings); Files keeps the catalogue entry. Stored by default, ingested
// through a source with a definition on request. Opening one checks the Silo again (it is open,
// and the person holds every marking on it now; not silo.import, which is for putting data in:
// decided 2026-11-23), and is refused, and recorded, where it fails. Deleting one is a purge of its Silo file (silo.purge, through the purge approval chain
// where one is configured); the entry goes when the purge completes, with its receipt. Uploads
// are bounded as exports are, so each opens in one reply.

import { z } from 'zod';
import { MAX_EXPORT_BYTES } from '../../config/files.config.ts';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { nodeRef, RELATIONS } from '../lineage/lineage.contract.ts';

const MAX_EXPORT_BASE64 = Math.ceil(MAX_EXPORT_BYTES / 3) * 4;

const name = z.string().trim().min(1).max(200).refine((n) => !/[\u0000-\u001f/\\]/.test(n), 'a name has no control characters or slashes');
const byFile = z.strictObject({ fileId: z.uuid() });
const byFolder = z.strictObject({ folderId: z.uuid() });

export const EXPORT_SOURCE_KINDS = ['view', 'cron_report'] as const;
export const exportSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('view'), savedViewId: z.uuid() }),
  z.strictObject({ kind: z.literal('cron_report'), automationRunId: z.uuid() }),
  /** A Clone Canvas view drawn (spec 29.10). */
  z.strictObject({ kind: z.literal('canvas_view'), canvasViewId: z.uuid() }),
]);
export type ExportSource = z.infer<typeof exportSource>;

/**
 * What Files stores an export from: a rendered answer's source, or a lineage graph a
 * reviewer exported (spec 59.4, 59.7), sourced to the node the walk began at. Only the
 * lineage service sends the second, and it is decided on lineage.read, not file.export.
 */
export const storedExportSource = z.discriminatedUnion('kind', [
  ...exportSource.options,
  z.strictObject({ kind: z.literal('lineage'), lineageNodeId: z.uuid() }),
  /** A Studio app version as a package for another organisation (D231): only from studio. */
  z.strictObject({ kind: z.literal('app_package'), appVersionId: z.uuid() }),
  /** A workbook's computed values (D232): only from workspace. */
  z.strictObject({ kind: z.literal('workbook'), workbookId: z.uuid() }),
  /** A report as a document (D233): only from workspace. */
  z.strictObject({ kind: z.literal('report'), reportId: z.uuid() }),
  /** A process analysis as a document (D234): only from workspace. */
  z.strictObject({ kind: z.literal('process_analysis'), processAnalysisId: z.uuid() }),
  /** A notebook's tables as computed (D239): only from workspace. */
  z.strictObject({ kind: z.literal('notebook'), notebookId: z.uuid() }),
]);

/**
 * What the export was made from: lineage inputs, so its markings are its inputs' (spec 58.6).
 * As many as the lineage writer takes: a lineage export names every node it shows.
 */
export const exportInputs = z.array(z.strictObject({ node: nodeRef, relation: z.enum(RELATIONS) })).min(1).max(2_000);
const EXPORT_INPUTS_BYTES = 1024 * 1024;

export const markingLabel = z.object({ id: z.uuid(), name: z.string() });
/**
 * Markings carried by what is drawn into an export besides its inputs' data (D228): a site plan's
 * or a 3D model's own, held by the maker, which the file carries with those it inherits.
 */
const carriedMarkings = z.array(z.uuid()).max(50).optional();

export const fileView = z.object({
  id: z.uuid(),
  kind: z.enum(['export', 'upload']),
  name: z.string(),
  folderId: z.uuid().nullable(),
  contentType: z.string().nullable(),
  size: z.int().nullable(),
  createdBy: z.uuid(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  markings: z.array(markingLabel),
  provenance: z.object({
    sourceKind: z.string(),
    sourceId: z.uuid(),
    runReference: z.uuid().nullable(),
    producedAt: z.string(),
  }).nullable(),
  /** owner, or the access a live share gives the caller. */
  access: z.enum(['owner', 'view', 'download']),
  /** Whether the caller satisfies every marking now; a file the caller cannot open says so. */
  canOpen: z.boolean(),
});
export type FileView = z.infer<typeof fileView>;

export const folderView = z.object({
  id: z.uuid(),
  name: z.string(),
  parentId: z.uuid().nullable(),
  createdBy: z.uuid(),
  createdAt: z.string(),
});
export type FolderView = z.infer<typeof folderView>;

export const fileShareView = z.object({
  id: z.uuid(),
  fileId: z.uuid(),
  granteeMembershipId: z.uuid().nullable(),
  granteeScopeId: z.uuid().nullable(),
  granteeWholeOrganisation: z.boolean(),
  access: z.enum(['view', 'download']),
  sharedBy: z.uuid(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  /**
   * For a share with one member: whether that member holds every marking on the file now
   * (clearances only: a purpose marking needs a purpose session at open). unknown for a
   * scope or the organisation, whose members are checked at each open.
   */
  recipientCanOpen: z.enum(['yes', 'no', 'unknown']),
});
export type FileShareView = z.infer<typeof fileShareView>;

// ----------------------------------------------------------------------------- render's calls

/** The markings an export of these inputs would carry, with names to print (spec 41.2). Writes nothing. */
export const previewExportMarkings = defineContract({
  service: 'files', name: 'previewExportMarkings', method: 'POST', path: '/v1/files/export-markings', callers: ['render', 'canvas-layout', 'lineage', 'studio', 'workspace'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ inputs: exportInputs, carriedMarkingIds: carriedMarkings }),
  response: z.object({ markings: z.array(markingLabel) }),
  maxBodyBytes: EXPORT_INPUTS_BYTES,
});

/**
 * Stores a rendered export: the bytes in object-files, the file with its frozen permissions,
 * provenance, markings and lineage in one transaction. Refused when the markings differ from
 * those printed (a marking changed in between: render again).
 */
export const createExport = defineContract({
  service: 'files', name: 'createExport', method: 'POST', path: '/v1/files/exports', callers: ['render', 'canvas-layout', 'lineage', 'studio', 'workspace'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    name,
    contentType: z.enum(['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf', 'image/png',
      'application/json']),
    /** The rendered document: record values. */
    content: recordValue(z.base64().max(MAX_EXPORT_BASE64)),
    source: storedExportSource,
    /** The query run the export was rendered from (executor queryId). A lineage export runs none. */
    runReference: z.uuid().optional(),
    folderId: z.uuid().optional(),
    inputs: exportInputs,
    /** The markings printed in the document, as previewExportMarkings returned them. */
    printedMarkingIds: z.array(z.uuid()).max(100),
    carriedMarkingIds: carriedMarkings,
    /** The field-policy effects the export was rendered under, by property identity. */
    fieldPolicies: z.array(z.strictObject({ property: z.uuid(), apiName: z.string(), effect: z.enum(['allow', 'mask', 'redact']) })).max(2000),
    /** The connections it read. */
    connectionIds: z.array(z.uuid()).max(500),
  }),
  response: fileView, status: 201, maxBodyBytes: MAX_EXPORT_BASE64 + EXPORT_INPUTS_BYTES,
});

/** An export render made, for its retry: the file as its maker sees it. */
export const getExport = defineContract({
  service: 'files', name: 'getExport', method: 'GET', path: '/v1/files/exports/:fileId', callers: ['render', 'canvas-layout', 'lineage', 'studio', 'workspace'],
  context: 'organisation', idempotency: 'none', params: byFile, response: fileView,
});

// ----------------------------------------------------------------------------- people's calls

const CALLERS = ['gateway'] as const;

export const listFiles = defineContract({
  service: 'files', name: 'listFiles', method: 'GET', path: '/v1/files', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    /** mine: made by the caller; shared: shared with the caller; both by default. */
    which: z.enum(['all', 'mine', 'shared']).default('all'),
    folderId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  /** Only what the caller may see; never a count of what they may not. */
  response: z.object({ files: z.array(fileView) }),
});

export const getFile = defineContract({
  service: 'files', name: 'getFile', method: 'GET', path: '/v1/files/:fileId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byFile, response: fileView,
});

/** The document itself, after the access and marking checks of spec 41.3. */
export const downloadFile = defineContract({
  service: 'files', name: 'downloadFile', method: 'GET', path: '/v1/files/:fileId/content', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byFile,
  response: z.object({ name: z.string(), contentType: z.string(), size: z.int(), content: recordValue(z.base64()) }),
});

/** An upload into an enabled Import Silo (spec 41.4): file.upload, and silo.import on the Silo. */
export const uploadFile = defineContract({
  service: 'files', name: 'uploadFile', method: 'POST', path: '/v1/files/uploads', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    siloId: z.uuid(),
    name,
    folderId: z.uuid().optional(),
    contentBase64: recordValue(z.base64().min(4).max(MAX_EXPORT_BASE64)),
    /** Ingest: read through this upload source's definition (chapter 68). Absent: stored only. */
    ingest: z.strictObject({ sourceId: z.uuid() }).optional(),
  }),
  response: fileView, status: 201, maxBodyBytes: MAX_EXPORT_BASE64 + 4_096,
});

/**
 * An upload larger than one request (spec 41.4): file.upload, then a signed, resumable,
 * short-lived transfer straight to the Silo's storage, for at most the import bound. The
 * client sends the bytes to the URL as the method and headers say, then completes it.
 */
export const beginFileUpload = defineContract({
  service: 'files', name: 'beginFileUpload', method: 'POST', path: '/v1/files/upload-transfers', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ siloId: z.uuid(), sizeBytes: z.int().min(1), folderId: z.uuid().optional() }),
  response: z.object({
    uploadId: z.uuid(), url: z.string(), method: z.enum(['POST', 'PUT']), headers: z.record(z.string(), z.string()), expiresAt: z.string(), maxBytes: z.int(),
  }),
  status: 201, maxBodyBytes: 1_024,
});

/** The transfer landed: validated, stored or ingested, and catalogued as any upload is. */
export const completeFileUpload = defineContract({
  service: 'files', name: 'completeFileUpload', method: 'POST', path: '/v1/files/upload-transfers/:uploadId/completion', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  params: z.strictObject({ uploadId: z.uuid() }),
  body: z.strictObject({
    siloId: z.uuid(), name, folderId: z.uuid().optional(),
    ingest: z.strictObject({ sourceId: z.uuid() }).optional(),
  }),
  response: fileView, status: 201, maxBodyBytes: 4_096,
});

/** A signed, short-lived link to an upload's bytes, for one too large to open in a reply; checked as opening it is. */
export const getFileDownloadLink = defineContract({
  service: 'files', name: 'getFileDownloadLink', method: 'POST', path: '/v1/files/:fileId/download-links', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ fileId: z.uuid() }),
  response: z.object({ url: z.string(), expiresAt: z.string(), name: z.string(), contentType: z.string(), size: z.int() }),
  status: 201, maxBodyBytes: 256,
});

/**
 * Uploads whose Silo files a purge removed (a file's own deletion, a Silo wiped, its
 * retention): their entries go, with the purge's receipt as theirs.
 */
export const recordUploadsPurged = defineContract({
  service: 'files', name: 'recordUploadsPurged', method: 'POST', path: '/v1/files/upload-purges', callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ siloFileIds: z.array(z.uuid()).min(1).max(10_000), purgeReceiptId: z.uuid(), requestedBy: z.uuid() }),
  response: z.object({ deleted: z.int().min(0) }),
});

export const updateFile = defineContract({
  service: 'files', name: 'updateFile', method: 'PATCH', path: '/v1/files/:fileId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byFile,
  /** A new name, or a new folder (null for the top level). */
  body: z.strictObject({ name: name.optional(), folderId: z.uuid().nullable().optional() })
    .refine((b) => b.name !== undefined || b.folderId !== undefined, 'a rename or a move'),
  response: fileView,
});

/** Deletes the document and keeps the receipt: what was removed, by whom, and what stopped working. */
export const deleteFile = defineContract({
  service: 'files', name: 'deleteFile', method: 'DELETE', path: '/v1/files/:fileId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byFile,
  response: z.union([
    z.object({ fileId: z.uuid(), deletionId: z.uuid(), completedAt: z.string(), counts: z.record(z.string(), z.int()) }),
    /** An upload: its Silo file's purge, requested; the file goes when the purge completes. */
    z.object({ fileId: z.uuid(), purgeId: z.uuid(), purgeStatus: z.string() }),
  ]),
});

export const shareFile = defineContract({
  service: 'files', name: 'shareFile', method: 'POST', path: '/v1/files/:fileId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byFile,
  body: z.strictObject({
    grantee: z.union([
      z.strictObject({ membershipId: z.uuid() }), z.strictObject({ scopeId: z.uuid() }), z.strictObject({ organisation: z.literal(true) }),
    ]),
    access: z.enum(['view', 'download']).default('download'),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  }),
  response: fileShareView, status: 201, maxBodyBytes: 1024,
});

export const revokeFileShare = defineContract({
  service: 'files', name: 'revokeFileShare', method: 'POST', path: '/v1/files/:fileId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ fileId: z.uuid(), shareId: z.uuid() }),
  response: fileShareView,
});

export const listFileShares = defineContract({
  service: 'files', name: 'listFileShares', method: 'GET', path: '/v1/files/:fileId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byFile,
  response: z.object({ shares: z.array(fileShareView) }),
});

export const createFolder = defineContract({
  service: 'files', name: 'createFolder', method: 'POST', path: '/v1/folders', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ name, parentId: z.uuid().optional() }),
  response: folderView, status: 201, maxBodyBytes: 1024,
});

export const listFolders = defineContract({
  service: 'files', name: 'listFolders', method: 'GET', path: '/v1/folders', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ parentId: z.uuid().optional() }),
  response: z.object({ folders: z.array(folderView) }),
});

export const updateFolder = defineContract({
  service: 'files', name: 'updateFolder', method: 'PATCH', path: '/v1/folders/:folderId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: byFolder,
  body: z.strictObject({ name: name.optional(), parentId: z.uuid().nullable().optional() })
    .refine((b) => b.name !== undefined || b.parentId !== undefined, 'a rename or a move'),
  response: folderView,
});
