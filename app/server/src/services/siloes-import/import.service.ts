// siloes-import (spec 68, 70.7): Import Siloes as people manage them.
//
// - Created like any Silo (silo.create), with its dataset name fixed from its ids.
// - The carve-out (68.7, 70.7): a holder of silo.enable acknowledges, once per Silo, that the
//   text of imported documents goes to a model through a zero-retention endpoint; until then
//   a definition that needs a model is refused, and tabular import never needs one.
// - Definitions (silo.manage): validated, versioned, immutable once published.
// - Sources and uploads (silo.import): a file is stored under a key with no filename in it,
//   its type sniffed from its bytes. The marking check applies at import: the uploader must
//   satisfy every marking on the Silo. A document's extraction is charged when it arrives
//   (6 tokens, spec 68.8), in the uploader's name, before anything is stored.
// - The flag (68.4): a near or inferred value's method, file, location and model score;
//   confirming it makes it certain for good, recorded with the person and audited.

import { PREBUILT, prebuiltOf } from './prebuilt.service.ts';
import { documentRows } from './process.service.ts';
import { extractDocument } from '../../contracts/model-gateway/extraction.contract.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { charge } from '../../contracts/metering/charge.contract.ts';
import { registerSiloSource } from '../../contracts/connect-registry/siloSource.contract.ts';
import { confirmImportValues } from '../../contracts/import-loader/load.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { definitionDocument, type DefinitionDocument, type FileView } from '../../contracts/siloes/import.contract.ts';
import type { SiloView } from '../../contracts/siloes/siloes.contract.ts';
import { idTail } from '../../infra/bigquery.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { objectKey, type ObjectKey, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Silo, SiloDefinition, SiloExtraction, SiloFile, SiloSource } from '../../models/siloes/index.model.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import {
  extractionConfirmationRepo, siloDefinitionRepo, siloExtractionRepo, siloFileRepo, siloRepo, siloSourceRepo,
} from '../../repos/siloes/index.repo.ts';
import { pipelineScheduleRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { openValues } from '../siloes-capture/capture.service.ts';
import { loadSilo, loadSiloView, open, person, requireSiloes, type Context } from '../siloes-capture/deps.service.ts';
import { nameTaken } from '../siloes-capture/siloes.service.ts';
import { demand, recordEvent } from '../warehouse-schema/warehouse.service.ts';
import { siloManifestOf, siloObjectNameOf } from './source.service.ts';
import { cellValue, draftTabular, parseDelimited, sniff } from './tabular.service.ts';
import { fromSerial, parseWorkbook } from './workbook.service.ts';

export interface ImportDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
  store: ObjectStore;
  /** The cell's region: the dataset and the files sit there (66.8). */
  location: string;
  maxFileBytes: number;
  /** Rows one load carries (IMPORT_LOADER_MAX_ROWS). */
  loadRows: number;
  now: () => number;
}

export const NOT_PERMITTED = 'import.not_permitted';

export const CARVEOUT_DISCLOSURE = 'The text of documents you import into this Silo (PDFs, text and images, read with a definition that has '
  + 'labelled or prose fields) is sent to a language model to read it, through a zero-retention endpoint, and is never logged. Tabular files '
  + '(CSV and TSV) are never sent to a model. Asset models and site plans are never sent to a model.';

/** imp_<org12>_<silo12> (design: naming rules). */
export const importDatasetOf = (organisationId: string, siloId: string): string => `imp_${idTail(organisationId, 12)}_${idTail(siloId, 12)}`;

export const requiresModel = (doc: DefinitionDocument): boolean => doc.objects.some((o) => o.fields.some((f) => f.extraction.kind !== 'column'));

export function fileView(f: SiloFile): FileView {
  return {
    id: f.id, siloId: f.siloId, sourceId: f.sourceId, filename: f.filename, sizeBytes: Number(f.sizeBytes), contentType: f.contentType,
    contentClass: f.contentClass, receivedAt: f.receivedAt, processedAt: f.processedAt, status: f.status, errorStage: f.errorStage,
  };
}

export const definitionView = (d: SiloDefinition) => ({
  id: d.id, siloId: d.siloId, version: d.version, route: d.route, document: d.document as DefinitionDocument, requiresModel: d.requiresModel,
  publishedBy: d.publishedBy, publishedAt: d.publishedAt, retiredAt: d.retiredAt,
});

export const sourceView = (s: SiloSource) => ({
  id: s.id, siloId: s.siloId, kind: s.kind, location: s.location, definitionId: s.definitionId, pollIntervalMinutes: s.pollIntervalMinutes,
  lastPolledAt: s.lastPolledAt, createdAt: s.createdAt, disabledAt: s.disabledAt,
});

async function importSilo(deps: ImportDeps, ctx: Context, siloId: string): Promise<Silo> {
  return inTransaction(deps.databases.pool('control'), ctx.request, (db) => loadSilo(db, siloId, 'import'), { readOnly: true });
}

export async function createImportSilo(deps: ImportDeps, ctx: Context, input: { name: string; purpose: string; retentionDays: number }): Promise<SiloView> {
  await requireSiloes(deps, ctx);
  const creator = person(ctx);
  await demand(deps, ctx, 'silo.create', NOT_PERMITTED);
  const organisationId = ctx.request.organisationId!;
  const id = uuidv7();
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    // Provisioning until a Silo source connection lets the federated engine plan against it (66.5).
    await siloRepo.insert(db, {
      id, organisationId, kind: 'import', name: input.name, purpose: input.purpose, retentionDays: input.retentionDays, location: deps.location,
      status: 'provisioning', storeRef: importDatasetOf(organisationId, id), createdBy: creator,
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'silo_created', resource: { type: 'silo', id }, detail: { kind: 'import', retention_days: input.retentionDays }, service: 'siloes-import',
    });
  }).catch(nameTaken);
  return loadSiloView(deps, ctx, id);
}

export async function acknowledgeCarveout(deps: ImportDeps, ctx: Context, siloId: string)
  : Promise<{ acknowledgedAt: string; acknowledgedBy: string; disclosure: string }> {
  await requireSiloes(deps, ctx);
  const who = person(ctx);
  await demand(deps, ctx, 'silo.enable', NOT_PERMITTED);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const silo = open(await loadSilo(db, siloId, 'import'));
    if (silo.carveoutAcknowledgedAt !== null) {
      return { acknowledgedAt: silo.carveoutAcknowledgedAt, acknowledgedBy: silo.carveoutAcknowledgedBy!, disclosure: CARVEOUT_DISCLOSURE };
    }
    const at = new Date(deps.now()).toISOString();
    await siloRepo.update(db, siloId, { carveoutAcknowledgedBy: who, carveoutAcknowledgedAt: at });
    // Read first by a reviewer: who accepted that document contents go to a model, and when.
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'extraction_carveout_acknowledged', resource: { type: 'silo', id: siloId }, detail: { endpoint_class: 'zero_retention' }, service: 'siloes-import',
    });
    return { acknowledgedAt: at, acknowledgedBy: who, disclosure: CARVEOUT_DISCLOSURE };
  });
}

export async function publishDefinition(deps: ImportDeps, ctx: Context, siloId: string,
  input: { route: 'ai' | 'builder' | 'prebuilt'; document: DefinitionDocument; prebuilt?: string | undefined }) {
  await requireSiloes(deps, ctx);
  const publisher = person(ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  if (input.route === 'prebuilt') {
    // Only the catalogue's own document is published as prebuilt; a changed one is the builder's.
    const entry = prebuiltOf(input.prebuilt!);
    if (entry === undefined) throw new AppError('not_found', 'no such prebuilt definition', { code: 'import.prebuilt_unknown' });
    if (canonicalJson(entry.document) !== canonicalJson(definitionDocument.parse(input.document))) {
      throw new AppError('validation', 'a changed definition is published through the builder, not as prebuilt', { code: 'import.prebuilt_changed' });
    }
  }
  const needsModel = requiresModel(input.document);
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const silo = open(await loadSilo(db, siloId, 'import'));
    if (needsModel && silo.carveoutAcknowledgedAt === null) {
      throw new AppError('forbidden', 'a definition that reads documents with a model needs the carve-out acknowledged for this Silo first', {
        code: 'import.carveout_required',
      });
    }
    const version = ((await siloDefinitionRepo.listForSilo(db, siloId))[0]?.version ?? 0) + 1;
    const inserted = await siloDefinitionRepo.insert(db, {
      id: uuidv7(), organisationId: silo.organisationId, siloId, version, route: input.route, document: input.document as never, requiresModel: needsModel,
      publishedBy: publisher,
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'silo_definition_published', resource: { type: 'silo', id: siloId },
      detail: {
        definition_id: inserted.id, version, route: input.route, requires_model: needsModel, objects: input.document.objects.length,
        ...(input.prebuilt === undefined ? {} : { prebuilt: input.prebuilt }),
      }, service: 'siloes-import',
    });
    return inserted;
  });
  await answerAsSource(deps, ctx, siloId);
  return definitionView(row);
}

/**
 * 66.5: the Silo answers as a source through a connection whose manifest is every object its
 * live definitions declare (the latest definition per table), registered for the person who
 * published; with it the Silo leaves provisioning. Derivation maps its objects like any
 * connector's (68.5).
 */
async function answerAsSource(deps: ImportDeps, ctx: Context, siloId: string): Promise<void> {
  const pool = deps.databases.pool('control');
  const { silo, objects, markingIds } = await inTransaction(pool, ctx.request, async (db) => {
    const found = await loadSilo(db, siloId, 'import');
    const byTable = new Map<string, DefinitionDocument['objects'][number]>();
    // Oldest first, so a later definition's object replaces an earlier one of the same table.
    for (const d of [...await siloDefinitionRepo.listForSilo(db, siloId)].reverse().filter((x) => x.retiredAt === null)) {
      for (const o of (d.document as DefinitionDocument).objects) byTable.set(siloObjectNameOf(o.name), o);
    }
    return { silo: found, objects: [...byTable.values()], markingIds: (await resourceMarkingRepo.markingsFor(db, 'silo', [siloId])).map((m) => m.markingId) };
  }, { readOnly: true });
  if (objects.length === 0 || silo.storeRef === null) return;
  const source = await deps.services.call(registerSiloSource, {
    params: { siloId },
    body: { name: silo.name, document: siloManifestOf({ id: silo.id, name: silo.name, storeRef: silo.storeRef }, { objects }) as never, markingIds },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  await inTransaction(pool, ctx.request, async (db) => {
    const fresh = await siloRepo.findById(db, siloId);
    if (fresh === undefined || (fresh.sourceConnectionId === source.connectionId && fresh.status !== 'provisioning')) return;
    await siloRepo.update(db, siloId, {
      sourceConnectionId: source.connectionId, ...(fresh.status === 'provisioning' ? { status: 'active' as const } : {}), version: String(BigInt(fresh.version) + 1n) as never,
    });
  });
}

export async function listDefinitions(deps: ImportDeps, ctx: Context, siloId: string) {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    await loadSilo(db, siloId, 'import');
    return { definitions: (await siloDefinitionRepo.listForSilo(db, siloId)).map(definitionView) };
  }, { readOnly: true });
}

/** The Silo's sources, in the order they were made (D271). */
export async function listSources(deps: ImportDeps, ctx: Context, siloId: string) {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    await loadSilo(db, siloId, 'import');
    return { sources: (await siloSourceRepo.listForSilo(db, siloId)).map(sourceView) };
  }, { readOnly: true });
}

export async function createSource(deps: ImportDeps, ctx: Context, siloId: string, input:
  { kind: 'upload'; definitionId?: string | undefined } | { kind: 'watched'; definitionId: string; pollIntervalMinutes: number }) {
  await requireSiloes(deps, ctx);
  const creator = person(ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const silo = open(await loadSilo(db, siloId, 'import'));
    if (input.definitionId !== undefined) {
      const definition = await siloDefinitionRepo.findById(db, input.definitionId);
      if (definition === undefined || definition.siloId !== siloId || definition.retiredAt !== null) {
        throw new AppError('validation', 'the definition is not a live definition of this Silo', { code: 'import.definition_unknown' });
      }
    }
    const id = uuidv7();
    const inserted = await siloSourceRepo.insert(db, {
      id, organisationId: silo.organisationId, siloId, kind: input.kind,
      location: objectKey.organisation(silo.organisationId, 'silo', siloId, 'drop', id), definitionId: input.definitionId ?? null,
      pollIntervalMinutes: input.kind === 'watched' ? input.pollIntervalMinutes : null, createdBy: creator,
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'silo_source_created', resource: { type: 'silo', id: siloId }, detail: { source_id: id, kind: input.kind }, service: 'siloes-import',
    });
    return inserted;
  });
  return sourceView(row);
}

/** The marking check at import (68.9): the uploader satisfies every marking on the Silo. */
export async function clearedForSilo(deps: ImportDeps, ctx: Context, siloId: string): Promise<void> {
  const markings = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => resourceMarkingRepo.markingsFor(db, 'silo', [siloId]), { readOnly: true });
  if (markings.length === 0) return;
  const access = await deps.services.call(resolveAccess, { body: { markings: markings.map((m) => m.markingId) } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (access.decision !== 'allow' || access.markings.some((m) => !m.satisfied)) {
    throw new AppError('forbidden', 'you lack clearance for a marking on this Silo', { code: 'import.not_cleared' });
  }
}

/** Stores a file the person imported: sniffed, charged where a model will read it, recorded. */
export async function storeFile(deps: ImportDeps, ctx: Context, source: SiloSource, input: {
  filename: string; contentClass?: 'asset_model' | 'site_plan' | 'media' | undefined; bytes: Buffer; fileId?: string;
  /** A type the caller established from the bytes itself (a sanitised SVG), in place of the sniffed one. */
  contentType?: string | undefined;
}): Promise<SiloFile> {
  if (input.bytes.length > deps.maxFileBytes) {
    throw new AppError('bounds', 'the file is larger than one import may be', { code: 'import.file_too_large', details: { bound: 'bytes', limit: deps.maxFileBytes } });
  }
  const pool = deps.databases.pool('control');
  const definition = source.definitionId === null ? undefined
    : await inTransaction(pool, ctx.request, (db) => siloDefinitionRepo.findById(db, source.definitionId!), { readOnly: true });
  const sniffed = sniff(input.bytes, input.filename);
  const doc = definition?.document as DefinitionDocument | undefined;
  const contentClass: SiloFile['contentClass'] = input.contentClass
    ?? (sniffed.kind === 'tabular' || sniffed.kind === 'workbook' ? 'tabular'
      : doc?.objects.some((o) => o.fields.some((f) => f.extraction.kind === 'prose')) === true ? 'prose' : 'structured');
  const fileId = input.fileId ?? uuidv7();
  const key = objectKey.organisation(source.organisationId, 'silo', source.siloId, 'files', fileId);
  const contentType = input.contentType ?? sniffed.contentType;
  await deps.store.put('siloes', key, input.bytes, contentType);
  const file = await inTransaction(pool, ctx.request, async (db) => {
    const file = await siloFileRepo.insert(db, {
      id: fileId, organisationId: source.organisationId, siloId: source.siloId, sourceId: source.id, objectStoreKey: key, filename: input.filename,
      sizeBytes: String(input.bytes.length), contentType, contentClass,
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'file_received', resource: { type: 'silo', id: source.siloId },
      detail: { file_id: fileId, source_id: source.id, content_class: contentClass, bytes: input.bytes.length }, service: 'siloes-import',
    });
    return file;
  });
  // A document a model will read is charged as it arrives (68.8: 6 tokens per document); a
  // refused charge leaves nothing behind: the file is failed and its object removed.
  if ((contentClass === 'structured' || contentClass === 'prose') && definition?.requiresModel === true && ctx.request.membershipId !== undefined) {
    try {
      await deps.services.call(charge, { body: { operation: 'document_extraction', correlationId: fileId, siloFileId: fileId } },
        { request: ctx.request, correlationId: ctx.correlationId, idempotencyKey: `extract-${fileId.replaceAll('-', '')}` });
    } catch (error) {
      await deps.store.purge('siloes', key);
      await inTransaction(pool, ctx.request, (db) => siloFileRepo.update(db, fileId, { status: 'failed', errorStage: 'charge:refused' }));
      throw error;
    }
  }
  return file;
}

export async function uploadFile(deps: ImportDeps, ctx: Context, siloId: string, sourceId: string, input: {
  filename: string; contentClass?: 'asset_model' | 'site_plan' | undefined; contentBase64: string;
}): Promise<FileView> {
  const source = await uploadSource(deps, ctx, siloId, sourceId);
  return fileView(await storeFile(deps, ctx, source, { filename: input.filename, contentClass: input.contentClass, bytes: Buffer.from(input.contentBase64, 'base64') }));
}

/** A file's name as a definition object's: its stem, letters, digits, spaces, _ and - only, starting with a letter. */
export function objectNameOf(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[^A-Za-z]+/, '');
  return (stem.length === 0 ? 'Rows' : stem).slice(0, 63).trim();
}

/** 68.3: a definition drafted from the Silo's own tabular file, probed against every row of it; nothing is saved. */
export async function draftDefinition(deps: ImportDeps, ctx: Context, siloId: string, fileId: string) {
  await requireSiloes(deps, ctx);
  person(ctx);
  await demand(deps, ctx, 'silo.manage', NOT_PERMITTED);
  const file = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    open(await loadSilo(db, siloId, 'import'));
    return siloFileRepo.findById(db, fileId);
  }, { readOnly: true });
  if (file === undefined || file.siloId !== siloId || file.status === 'purged') throw new AppError('not_found', 'no such file in this Silo', { code: 'import.file_not_found' });
  if (file.contentClass === 'structured' || file.contentClass === 'prose') return draftDocument(deps, ctx, siloId, file);
  if (file.contentClass !== 'tabular') {
    throw new AppError('validation', 'an asset model or site plan is stored, never structured', { code: 'import.draft_needs_tabular' });
  }
  await clearedForSilo(deps, ctx, siloId);
  const bytes = await deps.store.get('siloes', file.objectStoreKey as ObjectKey);
  const workbook = sniff(bytes, file.filename).kind === 'workbook' ? parseWorkbook(bytes) : undefined;
  const { header, rows } = workbook ?? parseDelimited(bytes, file.contentType === 'text/tab-separated-values' ? '\t' : ',');
  const typed = (text: string, type: 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp') => (workbook !== undefined && (type === 'date' || type === 'timestamp')
    ? fromSerial(text, workbook.dateSystem, type) ?? cellValue(text, type) : cellValue(text, type));
  const draft = draftTabular(objectNameOf(file.filename), header, rows, typed);
  const parsed = definitionDocument.safeParse({ objects: [draft] });
  if (!parsed.success) throw new AppError('validation', 'the file\'s structure does not make a definition: name its fields in the builder', { code: 'import.draft_invalid' });
  // The probe: the draft read against every row, as processing will read it.
  const object = parsed.data.objects[0]!;
  const fields = object.fields.map((f) => {
    const column = (f.extraction as { column: string }).column;
    const present = rows.filter((r) => (r[column] ?? '').trim().length > 0);
    return { field: f.name, present: present.length, unreadable: present.filter((r) => typed(r[column]!, f.type as never) === undefined).length };
  });
  const id = object.fields.find((f) => f.name === object.identifier);
  const identifierUnique = id === undefined ? null : (() => {
    const values = rows.map((r) => (r[(id.extraction as { column: string }).column] ?? '').trim());
    return values.every((v) => v.length > 0) && new Set(values).size === values.length;
  })();
  return { document: parsed.data, probe: { rows: rows.length, fields, identifierUnique } };
}

/** How long a signed upload URL lives (design: short expiry). */
export const UPLOAD_URL_SECONDS = 15 * 60;

/** The upload source a person may add files to now: the Silo open, the source live, the person cleared for the Silo's markings. */
export async function uploadSource(deps: ImportDeps, ctx: Context, siloId: string, sourceId: string): Promise<SiloSource> {
  await requireSiloes(deps, ctx);
  // A person, or a scheduled pipeline's principal, which its owner bounds (D241); no other principal,
  // whatever role it holds (decided 2026-11-23).
  if (ctx.request.servicePrincipalId === undefined) person(ctx);
  else if (await inTransaction(deps.databases.pool('control'), ctx.request,
    (db) => pipelineScheduleRepo.grantedToPrincipal(db, ctx.request.servicePrincipalId!), { readOnly: true }) === undefined) {
    throw new AppError('forbidden', 'only a person, or a pipeline\'s schedule, puts files into a Silo', { code: 'siloes.person_required' });
  }
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  const source = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    open(await loadSilo(db, siloId, 'import'));
    const found = await siloSourceRepo.findById(db, sourceId);
    if (found === undefined || found.siloId !== siloId || found.disabledAt !== null || found.kind !== 'upload') {
      throw new AppError('not_found', 'no such upload source in this Silo', { code: 'import.source_not_found' });
    }
    return found;
  }, { readOnly: true });
  await clearedForSilo(deps, ctx, siloId);
  return source;
}

const dropKey = (source: SiloSource, uploadId: string) => objectKey.organisation(source.organisationId, 'silo', source.siloId, 'drop', source.id, uploadId);

/** A signed, resumable upload of at most the import bound, into the source's drop prefix, after the upload checks. */
export async function beginUpload(deps: ImportDeps, ctx: Context, siloId: string, sourceId: string, sizeBytes: number) {
  const source = await uploadSource(deps, ctx, siloId, sourceId);
  if (sizeBytes > deps.maxFileBytes) {
    throw new AppError('bounds', 'the file is larger than one import may be', { code: 'import.file_too_large', details: { bound: 'bytes', limit: deps.maxFileBytes } });
  }
  if (deps.store.signUpload === undefined) {
    throw new AppError('unavailable', 'this cell\'s storage does not sign uploads: send the file through the API', { code: 'import.signed_upload_unavailable' });
  }
  const uploadId = uuidv7();
  const signed = await deps.store.signUpload('siloes', dropKey(source, uploadId), {
    contentType: 'application/octet-stream', maxBytes: deps.maxFileBytes, expiresInSeconds: UPLOAD_URL_SECONDS,
  });
  return { uploadId, ...signed, maxBytes: deps.maxFileBytes };
}

/** The signed upload has landed: received like any upload (sniffed from its bytes), and the drop object removed. */
export async function completeUpload(deps: ImportDeps, ctx: Context, siloId: string, sourceId: string, uploadId: string, input: {
  filename: string; contentClass?: 'asset_model' | 'site_plan' | undefined;
}): Promise<FileView> {
  const source = await uploadSource(deps, ctx, siloId, sourceId);
  const key = dropKey(source, uploadId);
  const head = await deps.store.head('siloes', key);
  if (head === undefined) throw new AppError('not_found', 'nothing was uploaded under that upload', { code: 'import.upload_not_found' });
  if (head.bytes > deps.maxFileBytes) {
    await deps.store.purge('siloes', key);
    throw new AppError('bounds', 'the file is larger than one import may be', { code: 'import.file_too_large', details: { bound: 'bytes', limit: deps.maxFileBytes } });
  }
  const file = await storeFile(deps, ctx, source, { filename: input.filename, contentClass: input.contentClass, bytes: await deps.store.get('siloes', key), fileId: uploadId });
  await deps.store.purge('siloes', key);
  return fileView(file);
}

export async function listFiles(deps: ImportDeps, ctx: Context, siloId: string): Promise<{ files: FileView[] }> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  await importSilo(deps, ctx, siloId);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => ({ files: (await siloFileRepo.listForSilo(db, siloId)).map(fileView) }),
    { readOnly: true });
}

// ----------------------------------------------------------------------------- the flag

export const extractionBinding = (e: Pick<SiloExtraction, 'organisationId' | 'fileId' | 'object' | 'rowRef' | 'field'>) => ({
  table: 'siloes.silo_extractions', organisation_id: e.organisationId, file_id: e.fileId, object: e.object, row_ref: e.rowRef, field: e.field,
});

async function loadExtraction(db: Queryable, siloId: string, extractionId: string): Promise<{ extraction: SiloExtraction; file: SiloFile }> {
  const extraction = await siloExtractionRepo.findById(db, extractionId);
  const file = extraction === undefined ? undefined : await siloFileRepo.findById(db, extraction.fileId);
  if (extraction === undefined || file === undefined || file.siloId !== siloId) throw new AppError('not_found', 'no such extracted value', { code: 'import.extraction_not_found' });
  return { extraction, file };
}

function extractionView(e: SiloExtraction, file: SiloFile) {
  return {
    id: e.id, fileId: e.fileId, filename: file.filename, object: e.object, rowRef: e.rowRef, field: e.field, method: e.method,
    modelScore: e.confidence === null ? null : Number(e.confidence), location: e.rawTextRef, confirmedBy: e.confirmedBy, confirmedAt: e.confirmedAt,
  };
}

/**
 * The object view's extraction flags (34.3): each record's fields' latest extractions, where
 * its connection is an Import Silo's. A connection that is no Silo's has none.
 */
export async function readRecordExtractions(deps: ImportDeps, ctx: Context, records: { connectionId: string; sourceObject: string; rowRef: string }[]) {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const extractions: {
      connectionId: string; sourceObject: string; rowRef: string; field: string; siloId: string; extractionId: string;
      method: 'certain' | 'near' | 'inferred'; document: string; location: string; modelScore: number | null; confirmed: boolean;
    }[] = [];
    for (const connectionId of new Set(records.map((r) => r.connectionId))) {
      const silo = await siloRepo.findImportBySourceConnection(db, connectionId);
      if (silo === undefined) continue;
      // Each source object is a definition object's table (source.service.ts), the newest definition naming it.
      const objects = new Map<string, string>();
      for (const d of [...await siloDefinitionRepo.listForSilo(db, silo.id)].reverse().filter((x) => x.retiredAt === null)) {
        for (const o of (d.document as DefinitionDocument).objects) objects.set(siloObjectNameOf(o.name), o.name);
      }
      const mine = records.filter((r) => r.connectionId === connectionId);
      for (const sourceObject of new Set(mine.map((r) => r.sourceObject))) {
        const object = objects.get(sourceObject);
        if (object === undefined) continue;
        const rowRefs = mine.filter((r) => r.sourceObject === sourceObject).map((r) => r.rowRef);
        for (const e of await siloExtractionRepo.latestForRows(db, silo.id, object, rowRefs)) {
          extractions.push({
            connectionId, sourceObject, rowRef: e.rowRef, field: e.field, siloId: silo.id, extractionId: e.id, method: e.method,
            document: e.filename, location: e.rawTextRef, modelScore: e.confidence === null ? null : Number(e.confidence), confirmed: e.confirmedAt !== null,
          });
        }
      }
    }
    return { extractions };
  }, { readOnly: true });
}

export async function getExtraction(deps: ImportDeps, ctx: Context, siloId: string, extractionId: string) {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  await clearedForSilo(deps, ctx, siloId);
  const { extraction, file } = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => loadExtraction(db, siloId, extractionId), { readOnly: true });
  const [value] = await openValues(deps.services, ctx, [{ binding: extractionBinding(extraction), sealed: extraction.value }]);
  return { ...extractionView(extraction, file), value: (value ?? null) as never };
}

export async function listExtractions(deps: ImportDeps, ctx: Context, siloId: string, filter: { fileId?: string | undefined; unconfirmed: boolean }) {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    await loadSilo(db, siloId, 'import');
    const rows = await siloExtractionRepo.listForSilo(db, siloId, filter);
    const files = new Map((await siloFileRepo.listForSilo(db, siloId)).map((f) => [f.id, f]));
    return { extractions: rows.map((e) => extractionView(e, files.get(e.fileId)!)) };
  }, { readOnly: true });
}

/**
 * Confirmation (68.4): the value becomes certain, permanently, in Postgres and in the row
 * store, recorded with the person. Until imported objects are mapped to object types, the
 * permission that covers the value is silo.import on the Silo.
 */
export async function confirmExtraction(deps: ImportDeps, ctx: Context, siloId: string, extractionId: string) {
  await requireSiloes(deps, ctx);
  const confirmer = person(ctx);
  await demand(deps, ctx, 'silo.import', NOT_PERMITTED);
  await clearedForSilo(deps, ctx, siloId);
  const pool = deps.databases.pool('control');
  const { extraction, file } = await inTransaction(pool, ctx.request, (db) => loadExtraction(db, siloId, extractionId), { readOnly: true });
  if (extraction.confirmedAt !== null) return getExtraction(deps, ctx, siloId, extractionId);
  const at = new Date(deps.now()).toISOString();
  await inTransaction(pool, ctx.request, async (db) => {
    await siloExtractionRepo.update(db, extraction.id, { method: 'certain', confirmedBy: confirmer, confirmedAt: at });
    await extractionConfirmationRepo.insert(db, {
      id: uuidv7(), organisationId: extraction.organisationId, extractionId: extraction.id, membershipId: confirmer,
      previousMethod: extraction.method as 'near' | 'inferred',
    });
    await recordEvent(db, ctx.request, ctx.correlationId, {
      event: 'extraction_confirmed', resource: { type: 'silo', id: siloId },
      detail: { extraction_id: extraction.id, file_id: extraction.fileId, previous_method: extraction.method }, service: 'siloes-import',
    });
  });
  await deps.services.call(confirmImportValues, {
    body: { siloId, fileId: file.id, receivedAt: file.receivedAt, object: extraction.object, confirmations: [{ rowRef: extraction.rowRef, field: extraction.field }] },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  return getExtraction(deps, ctx, siloId, extractionId);
}

/** The model's proposal for a document: names, types and how each field is read. Never a value. */
const DRAFT_OUTPUT = {
  name: 'definition_draft',
  schema: {
    type: 'object', required: ['objects'],
    properties: {
      objects: {
        type: 'array', maxItems: 10,
        items: {
          type: 'object', required: ['name', 'fields'],
          properties: {
            name: { type: 'string' },
            identifier: { type: 'string' },
            fields: {
              type: 'array', maxItems: 100,
              items: {
                type: 'object', required: ['name', 'type'],
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['string', 'integer', 'decimal', 'boolean', 'date', 'timestamp'] },
                  label: { type: 'string' },
                  instruction: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
};

const DRAFT_INSTRUCTIONS = [
  'Propose how to structure documents like this one into records. Return objects: each with a short name, the field that identifies',
  'one of its records where there is one, and its fields. Name each field in lower snake case and give its type. Where the document',
  'prints a label next to the value, give that label exactly as printed; where the value is only in prose, give a one-sentence',
  'instruction for finding it. Return structure only: never a value from the document.',
].join(' ');

/**
 * A definition drafted from a document by the model, under the carve-out (62.5), then probed by
 * extracting from the same document with it. Counts only leave this function.
 */
async function draftDocument(deps: ImportDeps, ctx: Context, siloId: string, file: SiloFile) {
  const silo = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => loadSilo(db, siloId, 'import'), { readOnly: true });
  if (silo.carveoutAcknowledgedAt === null) {
    throw new AppError('forbidden', 'drafting from a document sends it to a model: acknowledge the carve-out for this Silo first', { code: 'import.carveout_required' });
  }
  await clearedForSilo(deps, ctx, siloId);
  const bytes = await deps.store.get('siloes', file.objectStoreKey as ObjectKey);
  // Charged as a document extraction (68.8), keyed to this draft.
  await deps.services.call(charge, { body: { operation: 'document_extraction', correlationId: file.id, siloFileId: file.id } },
    { request: ctx.request, correlationId: ctx.correlationId, idempotencyKey: `draft-${uuidv7().replaceAll('-', '')}` });
  const answer = await deps.services.call(extractDocument, {
    body: {
      siloId, fileId: file.id, instructions: DRAFT_INSTRUCTIONS, output: DRAFT_OUTPUT,
      document: { mediaType: file.contentType as 'application/pdf', contentBase64: bytes.toString('base64') },
    },
  }, { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 300_000 });
  const proposed = answer.output as { objects?: { name: string; identifier?: string; fields: { name: string; type: string; label?: string; instruction?: string }[] }[] };
  const document = {
    objects: (proposed.objects ?? []).map((o) => ({
      name: o.name,
      ...(o.identifier === undefined ? {} : { identifier: o.identifier }),
      fields: o.fields.map((f) => ({
        name: f.name, type: f.type,
        extraction: f.label !== undefined && f.label.trim() !== '' ? { kind: 'label', label: f.label }
          : f.instruction !== undefined && f.instruction.trim() !== '' ? { kind: 'prose', instruction: f.instruction } : undefined,
      })),
    })),
  };
  // Validated on the way out of the model, and refused rather than repaired (68.3).
  const parsed = definitionDocument.safeParse(document);
  if (!parsed.success) {
    throw new AppError('validation', 'the model proposed no definition Silo can run: name the document\'s fields in the builder', {
      code: 'import.draft_invalid', details: { issues: parsed.error.issues.length },
    });
  }
  // The probe: the draft read against the document it was drafted from, as processing will read it.
  const read = await documentRows(deps, ctx, file, bytes, parsed.data);
  const all = read.rows.flatMap((g) => g.rows);
  const fields = parsed.data.objects.flatMap((o) => o.fields.map((f) => ({
    field: f.name, present: (read.rows.find((g) => g.object === o.name)?.rows ?? []).filter((r) => r.values[f.name] !== undefined).length, unreadable: 0,
  })));
  const first = parsed.data.objects[0]!;
  const idValues = first.identifier === undefined ? undefined : (read.rows.find((g) => g.object === first.name)?.rows ?? []).map((r) => r.values[first.identifier!]);
  const identifierUnique = idValues === undefined ? null : idValues.every((v) => v !== undefined && v !== null) && new Set(idValues.map(String)).size === idValues.length;
  return { document: parsed.data, probe: { rows: all.length, fields, identifierUnique } };
}

export function listPrebuilt() {
  return { definitions: PREBUILT.map((p) => ({ ...p, requiresModel: requiresModel(p.document) })) };
}
