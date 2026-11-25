// Uploads through Files (spec 41.4): a document a person keeps in Files is stored against an
// Import Silo, so it carries the Silo's retention and markings, sits inside the Siloes
// disclosure, and is purged with it. Files owns the catalogue entry; this owns the bytes.
//
// - Stored (the default): kept and downloadable, nothing extracted. It goes into the Silo's
//   own Files source (an upload source with no definition, made on first use) and is marked
//   processed at once, so the import worker never reads it.
// - Ingested: into a named upload source with a definition, read as any import is (68), and
//   metered as document extraction where a model reads it.
// Validation precedes storage: the import bound, the type from the bytes (never the header),
// and an SVG rebuilt from an allowlist (a stored script on every page that renders it
// otherwise). The uploader holds silo.import and every marking on the Silo, and the file
// inherits those markings.
// Reading one back for a download (decided 2026-11-23): Files has decided the person may open the
// entry (its creator, or a share to download); here the Silo open and every marking on it, now.
// Not silo.import, which is for putting data into a Silo.
// A file larger than one reply travels straight to and from storage (41.4): a signed,
// resumable upload into the Silo's drop prefix, completed into the same validation and
// storage; and a signed, short-lived read link. Opening one in a reply is refused above the
// reply bound, with the link offered.
// - Media (D237): for a media set, only an image, video, audio file or PDF is stored, as its own
//   type and content class media, with the facts its bytes give (mediaFacts.service.ts). A media
//   file is opened for a media set's viewer without silo.import (the set decided they may see it):
//   the Silo open and every marking on it, as always.

import type { ObjectKey } from '../../infra/objectStorage.infra.ts';
import type { SiloFile } from '../../models/siloes/index.model.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { siloFileRepo, siloSourceRepo } from '../../repos/siloes/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { looksLikeSvg, sanitiseSvg, SvgRefused } from '../../utils/svg.util.ts';
import { loadSilo, open, person, requireSiloes, type Context } from '../siloes-capture/deps.service.ts';
import { demand, recordEvent } from '../warehouse-schema/warehouse.service.ts';
import { clearedForSilo, NOT_PERMITTED, storeFile, uploadSource, type ImportDeps } from './import.service.ts';
import { MEDIA_HEAD_BYTES, MEDIA_TAIL_BYTES, mediaFacts, type MediaFacts } from './mediaFacts.service.ts';

/** The location of a Silo's own Files source. */
export const FILES_SOURCE = 'files';

export interface StoredUpload {
  siloFileId: string; contentType: string; sizeBytes: number; ingested: boolean; retentionDays: number; markingIds: string[]; media: MediaFacts | null;
}

export async function storeFilesUpload(deps: ImportDeps, ctx: Context, input: {
  siloId: string; filename: string; contentBase64: string; sourceId?: string | undefined; media?: boolean | undefined;
}): Promise<StoredUpload> {
  return storeFilesBytes(deps, ctx, {
    siloId: input.siloId, filename: input.filename, bytes: Buffer.from(input.contentBase64, 'base64'), sourceId: input.sourceId, media: input.media === true,
  });
}

/** The facts of a whole file's bytes: read from its two ends, as from storage. */
const factsOf = (bytes: Buffer): MediaFacts | undefined =>
  mediaFacts(bytes.subarray(0, MEDIA_HEAD_BYTES), bytes.length > MEDIA_HEAD_BYTES ? bytes.subarray(bytes.length - MEDIA_TAIL_BYTES) : bytes, bytes.length);

/** A stored media file's facts, read again from its two ends in storage (a retried store's answer). */
async function storedFacts(deps: ImportDeps, file: SiloFile): Promise<MediaFacts | null> {
  if (file.contentClass !== 'media') return null;
  const size = Number(file.sizeBytes);
  if (size === 0) return null;
  const key = file.objectStoreKey as ObjectKey;
  const head = await deps.store.getRange('siloes', key, 0, Math.min(size, MEDIA_HEAD_BYTES) - 1);
  const tail = size > MEDIA_HEAD_BYTES ? await deps.store.getRange('siloes', key, Math.max(0, size - MEDIA_TAIL_BYTES), size - 1) : head;
  return mediaFacts(head, tail, size) ?? null;
}

/** An Import Silo the person may put Files uploads into now (a media set's, D237). */
export async function checkFilesSilo(deps: ImportDeps, ctx: Context, siloId: string): Promise<{ siloId: string; markingIds: string[] }> {
  await requireSiloes(deps, ctx);
  person(ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  const markingIds = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    open(await loadSilo(db, siloId, 'import'));
    return (await resourceMarkingRepo.markingsFor(db, 'silo', [siloId])).map((m) => m.markingId);
  }, { readOnly: true });
  await clearedForSilo(deps, ctx, siloId);
  return { siloId, markingIds };
}

/**
 * A media set's item opened for a person Files has let see it (D237): only a media file, its Silo
 * open, every marking on it held. In the reply up to the reply bound unless a link is asked for.
 */
export async function openMediaUpload(deps: ImportDeps, ctx: Context, siloFileId: string, link: boolean) {
  await requireSiloes(deps, ctx);
  person(ctx);
  const file = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const found = await siloFileRepo.findById(db, siloFileId);
    if (found === undefined || found.status === 'purged' || found.contentClass !== 'media') return undefined;
    open(await loadSilo(db, found.siloId, 'import'));
    return found;
  }, { readOnly: true });
  if (file === undefined) throw new AppError('not_found', 'no such media file in a Silo', { code: 'import.file_not_found' });
  await clearedForSilo(deps, ctx, file.siloId);
  const size = Number(file.sizeBytes);
  const key = file.objectStoreKey as ObjectKey;
  if ((link || size > INLINE_READ_BYTES) && deps.store.signRead !== undefined) {
    const signed = await deps.store.signRead('siloes', key, TRANSFER_SECONDS);
    return { kind: 'link' as const, contentType: file.contentType, url: signed.url, expiresAt: signed.expiresAt };
  }
  if (size > INLINE_READ_BYTES) {
    throw new AppError('unavailable', 'this cell\'s storage does not sign reads, and the file is too large for one reply', { code: 'import.signed_read_unavailable' });
  }
  return { kind: 'content' as const, contentType: file.contentType, content: (await deps.store.get('siloes', key)).toString('base64') };
}

/** How long a signed transfer's URL stays good. */
const TRANSFER_SECONDS = 15 * 60;
/** Above this an upload is opened through a signed link, not in a reply (the reply's own bound). */
export const INLINE_READ_BYTES = 25 * 1024 * 1024;

const filesDropKey = (organisationId: string, siloId: string, uploadId: string): ObjectKey =>
  `org/${organisationId}/silo/${siloId}/drop/${FILES_SOURCE}/${uploadId}` as ObjectKey;

/** A signed transfer for a Files upload larger than one reply (41.4), after the upload's own checks. */
export async function beginFilesUpload(deps: ImportDeps, ctx: Context, input: { siloId: string; sizeBytes: number }) {
  await requireSiloes(deps, ctx);
  person(ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => open(await loadSilo(db, input.siloId, 'import')), { readOnly: true });
  await clearedForSilo(deps, ctx, input.siloId);
  if (input.sizeBytes > deps.maxFileBytes) {
    throw new AppError('bounds', 'the file is larger than one upload may be', { code: 'import.file_too_large', details: { bound: 'bytes', limit: deps.maxFileBytes } });
  }
  if (deps.store.signUpload === undefined) {
    throw new AppError('unavailable', 'this cell\'s storage does not sign uploads: send the file in one request', { code: 'import.signed_upload_unavailable' });
  }
  const uploadId = uuidv7();
  const signed = await deps.store.signUpload('siloes', filesDropKey(ctx.request.organisationId!, input.siloId, uploadId), {
    contentType: 'application/octet-stream', maxBytes: deps.maxFileBytes, expiresInSeconds: TRANSFER_SECONDS,
  });
  return { uploadId, ...signed, maxBytes: deps.maxFileBytes };
}

/** The transfer landed: validated and stored as an upload is, then the drop object removed. */
export async function completeFilesUpload(deps: ImportDeps, ctx: Context, uploadId: string, input: {
  siloId: string; filename: string; sourceId?: string | undefined; media?: boolean | undefined;
}): Promise<StoredUpload> {
  await requireSiloes(deps, ctx);
  person(ctx);
  const key = filesDropKey(ctx.request.organisationId!, input.siloId, uploadId);
  const head = await deps.store.head('siloes', key);
  if (head === undefined) throw new AppError('not_found', 'nothing was uploaded under that transfer', { code: 'import.upload_not_found' });
  if (head.bytes > deps.maxFileBytes) {
    await deps.store.purge('siloes', key);
    throw new AppError('bounds', 'the file is larger than one upload may be', { code: 'import.file_too_large', details: { bound: 'bytes', limit: deps.maxFileBytes } });
  }
  const stored = await storeFilesBytes(deps, ctx, {
    siloId: input.siloId, filename: input.filename, bytes: await deps.store.get('siloes', key), sourceId: input.sourceId, media: input.media === true,
  });
  await deps.store.purge('siloes', key);
  return stored;
}

/** A signed, short-lived read link for an upload, after the same checks as opening it. */
export async function signFilesUploadRead(deps: ImportDeps, ctx: Context, siloFileId: string) {
  const file = await checkedUpload(deps, ctx, siloFileId);
  if (deps.store.signRead === undefined) {
    throw new AppError('unavailable', 'this cell\'s storage does not sign reads', { code: 'import.signed_read_unavailable' });
  }
  const signed = await deps.store.signRead('siloes', file.objectStoreKey as ObjectKey, TRANSFER_SECONDS);
  return { ...signed, filename: file.filename, contentType: file.contentType, sizeBytes: Number(file.sizeBytes) };
}

/** An upload the person may open now, Files having decided they may open its entry: the Silo open, every marking on it. */
async function checkedUpload(deps: ImportDeps, ctx: Context, siloFileId: string): Promise<SiloFile> {
  await requireSiloes(deps, ctx);
  person(ctx);
  const file = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const found = await siloFileRepo.findById(db, siloFileId);
    if (found === undefined || found.status === 'purged') return undefined;
    open(await loadSilo(db, found.siloId, 'import'));
    return found;
  }, { readOnly: true });
  if (file === undefined) throw new AppError('not_found', 'no such file in a Silo', { code: 'import.file_not_found' });
  await clearedForSilo(deps, ctx, file.siloId);
  return file;
}

async function storeFilesBytes(deps: ImportDeps, ctx: Context, input: {
  siloId: string; filename: string; bytes: Buffer; sourceId?: string | undefined; media?: boolean | undefined;
}): Promise<StoredUpload> {
  await requireSiloes(deps, ctx);
  const uploader = person(ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  const pool = deps.databases.pool('control');
  let bytes: Buffer = input.bytes;
  if (bytes.length > deps.maxFileBytes) {
    throw new AppError('bounds', 'the file is larger than one upload may be', { code: 'import.file_too_large', details: { bound: 'bytes', limit: deps.maxFileBytes } });
  }
  let contentType: string | undefined;
  // For a media set (D237): only what its bytes say is media, before anything is stored. An SVG can carry script: never media.
  const facts = input.media === true && !looksLikeSvg(bytes) ? factsOf(bytes) : undefined;
  if (input.media === true && facts === undefined) {
    throw new AppError('validation', 'that is not an image, video, audio file or PDF a media set keeps', { code: 'import.not_media' });
  }
  if (facts !== undefined) contentType = facts.contentType;
  else if (looksLikeSvg(bytes)) {
    try {
      bytes = sanitiseSvg(bytes);
    } catch (error) {
      if (error instanceof SvgRefused) throw new AppError('validation', 'the SVG cannot be stored safely', { code: 'files.svg_refused', details: { reason: error.reason } });
      throw error;
    }
    contentType = 'image/svg+xml';
  }

  const ingested = input.sourceId !== undefined;
  // The marking check first (an ingest's source checks it itself): nothing is made for someone not cleared.
  if (!ingested) {
    await inTransaction(pool, ctx.request, async (db) => open(await loadSilo(db, input.siloId, 'import')), { readOnly: true });
    await clearedForSilo(deps, ctx, input.siloId);
  }
  const source = ingested ? await uploadSource(deps, ctx, input.siloId, input.sourceId!) : await inTransaction(pool, ctx.request, async (db) => {
    open(await loadSilo(db, input.siloId, 'import'));
    const existing = (await siloSourceRepo.listForSilo(db, input.siloId))
      .find((s) => s.kind === 'upload' && s.location === FILES_SOURCE && s.definitionId === null && s.disabledAt === null);
    if (existing !== undefined) return existing;
    const created = await siloSourceRepo.insert(db, {
      id: uuidv7(), organisationId: ctx.request.organisationId!, siloId: input.siloId, kind: 'upload', location: FILES_SOURCE, definitionId: null,
      pollIntervalMinutes: null, createdBy: uploader,
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'silo_source_created', resource: { type: 'silo', id: input.siloId }, detail: { source_id: created.id, kind: 'upload' }, service: 'siloes-import',
    });
    return created;
  });
  const file = await storeFile(deps, ctx, source, { filename: input.filename, bytes, contentType, ...(facts === undefined ? {} : { contentClass: 'media' as const }) });
  return inTransaction(pool, ctx.request, async (db) => {
    // Stored only: nothing to read, so it is done; the worker reads only what is received.
    if (!ingested) await siloFileRepo.update(db, file.id, { status: 'processed', processedAt: new Date(deps.now()).toISOString() });
    const silo = await loadSilo(db, input.siloId, 'import');
    const markingIds = (await resourceMarkingRepo.markingsFor(db, 'silo', [input.siloId])).map((m) => m.markingId);
    return {
      siloFileId: file.id, contentType: file.contentType, sizeBytes: Number(file.sizeBytes), ingested, retentionDays: silo.retentionDays, markingIds,
      media: facts ?? null,
    };
  });
}

/** An upload's bytes, for the person opening it through Files, checked as an import is. */
export async function readFilesUpload(deps: ImportDeps, ctx: Context, siloFileId: string): Promise<{ filename: string; contentType: string; content: string }> {
  const file = await checkedUpload(deps, ctx, siloFileId);
  if (Number(file.sizeBytes) > INLINE_READ_BYTES) {
    throw new AppError('bounds', 'the file is too large to open in one reply: open it through a download link', {
      code: 'import.read_too_large', details: { bound: 'bytes', limit: INLINE_READ_BYTES },
    });
  }
  const bytes = await deps.store.get('siloes', file.objectStoreKey as ObjectKey);
  return { filename: file.filename, contentType: file.contentType, content: bytes.toString('base64') };
}

/** The stored upload as first answered, for a retried store (nothing is stored twice). */
export async function storedUploadOf(deps: ImportDeps, ctx: Context, siloFileId: string): Promise<StoredUpload> {
  const stored = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const file = await siloFileRepo.findById(db, siloFileId);
    if (file === undefined) throw new AppError('not_found', 'no such file in a Silo', { code: 'import.file_not_found' });
    const silo = await loadSilo(db, file.siloId, 'import');
    const source = await siloSourceRepo.findById(db, file.sourceId);
    return {
      siloFileId: file.id, contentType: file.contentType, sizeBytes: Number(file.sizeBytes), ingested: source?.definitionId != null,
      retentionDays: silo.retentionDays, markingIds: (await resourceMarkingRepo.markingsFor(db, 'silo', [file.siloId])).map((m) => m.markingId), file,
    };
  }, { readOnly: true });
  const { file, ...rest } = stored;
  return { ...rest, media: await storedFacts(deps, file) };
}

/** Where an upload is kept, for Files deleting it (the purge it requests is decided by siloes-capture). */
export async function getFilesUpload(deps: ImportDeps, ctx: Context, siloFileId: string): Promise<{ siloId: string; status: SiloFile['status'] }> {
  const file = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => siloFileRepo.findById(db, siloFileId), { readOnly: true });
  if (file === undefined) throw new AppError('not_found', 'no such file in a Silo', { code: 'import.file_not_found' });
  return { siloId: file.siloId, status: file.status };
}
