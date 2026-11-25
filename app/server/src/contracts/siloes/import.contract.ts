// Import (spec 68; catalogue: siloes-import): files a customer holds, structured by a
// definition into rows that answer as a source.
//
// - An Import Silo is created like any Silo (silo.create). Sources are an upload folder or a
//   watched location (silo.import): both feed the same pipeline, only the trigger differs.
// - A definition (silo.manage) declares objects and fields and, per field, how it is read:
//   a column (certain), a labelled field in a document (near) or a model reading prose
//   (inferred). It is validated and rejected rather than repaired, versioned, and immutable
//   once published. A definition that needs a model is refused until the carve-out has been
//   acknowledged for the Silo (68.7, 70.7), by a holder of silo.enable.
// - Files are stored under a key with no filename in it; their type is sniffed, never taken
//   from the client. Tabular files never reach a model. Every value keeps its method; a near
//   or inferred value is an extraction with its location and the model's score, and a person
//   may confirm it, after which it is certain for good (68.4).

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';
import { importFieldName } from '../import-loader/load.contract.ts';
import { siloView } from './siloes.contract.ts';

const instant = z.string();
const siloParams = z.strictObject({ siloId: z.uuid() });

export const CONTENT_CLASSES = ['tabular', 'structured', 'prose', 'asset_model', 'site_plan', 'media'] as const;

/** How a field is read (68.2, 68.4): the method its values carry follows from it. */
export const fieldExtraction = z.discriminatedUnion('kind', [
  /** A column of a tabular file, by its header: certain. */
  z.strictObject({ kind: z.literal('column'), column: z.string().min(1).max(200) }),
  /** A labelled field of a structured document: near. */
  z.strictObject({ kind: z.literal('label'), label: z.string().min(1).max(200) }),
  /** Read from prose by a model: inferred. */
  z.strictObject({ kind: z.literal('prose'), instruction: z.string().min(1).max(2_000) }),
]);

/** A structuring definition: structure only, never a value or a secret (68.3). */
export const definitionDocument = z.strictObject({
  objects: z.array(z.strictObject({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9 _-]{0,62}$/),
    /** The field whose value identifies a row; the row's position when absent. */
    identifier: importFieldName.optional(),
    fields: z.array(z.strictObject({
      name: importFieldName,
      type: z.enum(['string', 'integer', 'decimal', 'boolean', 'date', 'timestamp', 'json']),
      extraction: fieldExtraction,
    })).min(1).max(500),
  })).min(1).max(50),
}).superRefine((doc, ctx) => {
  const objects = new Set<string>();
  doc.objects.forEach((o, i) => {
    const key = o.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (objects.has(key)) ctx.addIssue({ code: 'custom', path: ['objects', i, 'name'], message: 'two objects would share a table' });
    objects.add(key);
    const fields = new Set(o.fields.map((f) => f.name));
    if (fields.size !== o.fields.length) ctx.addIssue({ code: 'custom', path: ['objects', i, 'fields'], message: 'a field is declared once' });
    if (o.identifier !== undefined && !fields.has(o.identifier)) {
      ctx.addIssue({ code: 'custom', path: ['objects', i, 'identifier'], message: 'the identifier is one of the object\'s fields' });
    }
  });
});
export type DefinitionDocument = z.infer<typeof definitionDocument>;

export const definitionView = z.object({
  id: z.uuid(), siloId: z.uuid(), version: z.int(), route: z.enum(['ai', 'builder', 'prebuilt']), document: definitionDocument,
  requiresModel: z.boolean(), publishedBy: z.uuid(), publishedAt: instant, retiredAt: instant.nullable(),
});

export const sourceView = z.object({
  id: z.uuid(), siloId: z.uuid(), kind: z.enum(['upload', 'watched']), location: z.string(), definitionId: z.uuid().nullable(),
  pollIntervalMinutes: z.int().nullable(), lastPolledAt: instant.nullable(), createdAt: instant, disabledAt: instant.nullable(),
});

export const fileView = z.object({
  id: z.uuid(), siloId: z.uuid(), sourceId: z.uuid(), filename: z.string(), sizeBytes: z.int(), contentType: z.string(),
  contentClass: z.enum(CONTENT_CLASSES), receivedAt: instant, processedAt: instant.nullable(),
  status: z.enum(['received', 'processed', 'failed', 'purged']), errorStage: z.string().nullable(),
});
export type FileView = z.infer<typeof fileView>;

export const createImportSilo = defineContract({
  service: 'siloes-import', name: 'createImportSilo', method: 'POST', path: '/v1/import-siloes',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ name: z.string().trim().min(1).max(200), purpose: z.string().trim().min(1).max(2000), retentionDays: z.int().min(1).max(36_500) }),
  response: siloView, status: 201,
});

export const acknowledgeCarveout = defineContract({
  service: 'siloes-import', name: 'acknowledgeCarveout', method: 'POST', path: '/v1/import-siloes/:siloId/carveout',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  response: z.object({ acknowledgedAt: instant, acknowledgedBy: z.uuid(), disclosure: z.string() }),
});

export const publishDefinition = defineContract({
  service: 'siloes-import', name: 'publishDefinition', method: 'POST', path: '/v1/import-siloes/:siloId/definitions',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  /**
   * ai: a draft the person reviewed (68.3); builder: written in the visual builder; prebuilt: a
   * catalogue format, named by its key, published exactly as the catalogue holds it.
   */
  body: z.strictObject({ route: z.enum(['ai', 'builder', 'prebuilt']), document: definitionDocument, prebuilt: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional() })
    .refine((b) => (b.route === 'prebuilt') === (b.prebuilt !== undefined), 'a prebuilt definition names its catalogue key, and only it does'),
  response: definitionView, status: 201,
});

/**
 * A definition drafted from one of the Silo's own files (68.3: sampled, proposed, probed
 * against the real file), for the person to confirm or correct and publish.
 * - A tabular file never invokes a model (68.7): the draft is inferred from the header and the
 *   values' types.
 * - A document (structured or prose) is read by the model under the carve-out (62.5), which
 *   must be acknowledged for the Silo: it proposes objects and fields, each read by its label
 *   or, in prose, by an instruction; the draft is then probed by extracting from the same file
 *   with it. Charged as a document extraction.
 * Either way it is validated as any definition is, and refused rather than repaired. The answer
 * holds names, types and counts, never a value.
 */
export const draftDefinition = defineContract({
  service: 'siloes-import', name: 'draftDefinition', method: 'POST', path: '/v1/import-siloes/:siloId/definition-drafts',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: z.strictObject({ fileId: z.uuid() }),
  response: z.object({
    document: definitionDocument,
    probe: z.object({
      rows: z.int(),
      /** Per field: values present, and values that would not read as its type (none, for a draft). */
      fields: z.array(z.object({ field: z.string(), present: z.int(), unreadable: z.int() })),
      identifierUnique: z.boolean().nullable(),
    }),
  }),
});

export const listDefinitions = defineContract({
  service: 'siloes-import', name: 'listDefinitions', method: 'GET', path: '/v1/import-siloes/:siloId/definitions',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  response: z.object({ definitions: z.array(definitionView) }),
});

/** An Import Silo's sources (D271): upload points and watched locations, with where to drop files and when each was last read. */
export const listSources = defineContract({
  service: 'siloes-import', name: 'listSources', method: 'GET', path: '/v1/import-siloes/:siloId/sources',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  response: z.object({ sources: z.array(sourceView) }),
});

export const createSource = defineContract({
  service: 'siloes-import', name: 'createSource', method: 'POST', path: '/v1/import-siloes/:siloId/sources',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  body: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('upload'), definitionId: z.uuid().optional() }),
    /** Files dropped under the source's location are picked up on the schedule. */
    z.strictObject({ kind: z.literal('watched'), definitionId: z.uuid(), pollIntervalMinutes: z.int().min(5).max(10_080) }),
  ]),
  response: sourceView, status: 201,
});

export const uploadFile = defineContract({
  service: 'siloes-import', name: 'uploadFile', method: 'POST', path: '/v1/import-siloes/:siloId/sources/:sourceId/files',
  // workspace: a data pipeline's output, as the person running it (D235).
  callers: ['gateway', 'workspace'],
  context: 'organisation', idempotency: 'keyed',
  params: siloParams.extend({ sourceId: z.uuid() }),
  body: z.strictObject({
    /** As received: shown to people, never used in a key. */
    filename: z.string().trim().min(1).max(255),
    /** Asset models and site plans are stored for the Clone Canvas, never extracted (66.4). */
    contentClass: z.enum(['asset_model', 'site_plan']).optional(),
    contentBase64: recordValue(z.base64().min(4)),
  }),
  response: fileView, status: 201,
  maxBodyBytes: 34 * 1024 * 1024,
});

/** What an image, video, audio file or PDF's own bytes say (D237: services/siloes-import/mediaFacts.service.ts). */
export const mediaFactsView = z.object({
  kind: z.enum(['image', 'video', 'audio', 'document']), contentType: z.string(),
  width: z.int().optional(), height: z.int().optional(), durationMs: z.int().optional(), pages: z.int().optional(),
  /** When a photo was taken, as its camera wrote it: local time, no zone. */
  capturedAt: z.string().optional(),
});

/**
 * An upload made through Files (spec 41.4): stored against an Import Silo, in its own Files
 * source (stored: nothing extracted), or ingested through a named source with a definition.
 * Validated before it is stored (the bound, the type from the bytes, an SVG rebuilt from an
 * allowlist). Answers with what Files records: the Silo file, its retention and its markings.
 */
export const storeFilesUpload = defineContract({
  service: 'siloes-import', name: 'storeFilesUpload', method: 'POST', path: '/v1/files-uploads', callers: ['files'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    siloId: z.uuid(),
    filename: z.string().trim().min(1).max(255),
    contentBase64: recordValue(z.base64().min(4)),
    /** Ingest through this upload source (with a definition); absent, stored only. */
    sourceId: z.uuid().optional(),
    /**
     * For a media set (D237): refused, before anything is stored, unless its bytes are an image,
     * video, audio file or PDF; kept as its own type, never read by the import worker. Not ingested.
     */
    media: z.boolean().default(false),
  }).refine((b) => !(b.media && b.sourceId !== undefined), 'media is stored, never ingested'),
  response: z.object({
    siloFileId: z.uuid(), contentType: z.string(), sizeBytes: z.int().min(0), ingested: z.boolean(), retentionDays: z.int().min(1),
    markingIds: z.array(z.uuid()),
    /** What its bytes say, for media; null otherwise. */
    media: mediaFactsView.nullable(),
  }),
  status: 201, maxBodyBytes: 34 * 1024 * 1024,
});

/** Where an upload made through Files is kept: its Silo and state (deleting it is a purge of that Silo's file). */
export const getFilesUpload = defineContract({
  service: 'siloes-import', name: 'getFilesUpload', method: 'GET', path: '/v1/files-uploads/:siloFileId/summary', callers: ['files'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ siloFileId: z.uuid() }),
  response: z.object({ siloId: z.uuid(), status: z.enum(['received', 'processed', 'failed', 'purged']) }),
});

/** An upload's bytes, for the person opening it through Files (which decided they may): the Silo open and every marking on it. */
export const readFilesUpload = defineContract({
  service: 'siloes-import', name: 'readFilesUpload', method: 'GET', path: '/v1/files-uploads/:siloFileId', callers: ['files'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ siloFileId: z.uuid() }),
  response: z.object({ filename: z.string(), contentType: z.string(), content: recordValue(z.string()) }),
});

const storedUpload = z.object({
  siloFileId: z.uuid(), contentType: z.string(), sizeBytes: z.int().min(0), ingested: z.boolean(), retentionDays: z.int().min(1),
  markingIds: z.array(z.uuid()),
  media: mediaFactsView.nullable(),
});
export type StoredUploadView = z.infer<typeof storedUpload>;
const signedTransfer = z.object({
  uploadId: z.uuid(), url: z.string(), method: z.enum(['POST', 'PUT']), headers: z.record(z.string(), z.string()), expiresAt: instant, maxBytes: z.int(),
});

/**
 * A Files upload larger than one reply (spec 41.4): sent straight to storage with a signed,
 * resumable, short-lived URL, issued after the same checks as an upload (silo.import, the Silo
 * open, every marking on it), for at most the import bound.
 */
export const beginFilesUpload = defineContract({
  service: 'siloes-import', name: 'beginFilesUpload', method: 'POST', path: '/v1/files-uploads/transfers', callers: ['files'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ siloId: z.uuid(), sizeBytes: z.int().min(1) }),
  response: signedTransfer, status: 201,
});

/** The transfer landed: validated and stored (or ingested) as an upload is, and the drop object removed. */
export const completeFilesUpload = defineContract({
  service: 'siloes-import', name: 'completeFilesUpload', method: 'POST', path: '/v1/files-uploads/transfers/:uploadId/completion', callers: ['files'],
  context: 'organisation', idempotency: 'keyed',
  params: z.strictObject({ uploadId: z.uuid() }),
  body: z.strictObject({ siloId: z.uuid(), filename: z.string().trim().min(1).max(255), sourceId: z.uuid().optional(), media: z.boolean().default(false) })
    .refine((b) => !(b.media && b.sourceId !== undefined), 'media is stored, never ingested'),
  response: storedUpload, status: 201,
});

/** An Import Silo a person may put Files uploads into now (a media set's, D237): open, silo.import, every marking on it. */
export const checkFilesSilo = defineContract({
  // workspace: a pipeline's output Silo, when its owner schedules it (D241).
  service: 'siloes-import', name: 'checkFilesSilo', method: 'GET', path: '/v1/files-siloes/:siloId', callers: ['files', 'workspace'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ siloId: z.uuid() }),
  response: z.object({ siloId: z.uuid(), markingIds: z.array(z.uuid()) }),
});

/**
 * A media set's item opened (D237), for files, which has decided the person may see it through
 * the set. Checked here: the file is media (nothing else opens this way), its Silo is open, and the
 * person holds every marking on it. Not silo.import, which is for putting data in. In the reply
 * up to the reply bound unless a link is asked for; else a signed, short-lived link (ranges
 * included, so video seeks), where storage signs one.
 */
export const openMediaUpload = defineContract({
  service: 'siloes-import', name: 'openMediaUpload', method: 'POST', path: '/v1/files-uploads/:siloFileId/media-opens', callers: ['files'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ siloFileId: z.uuid() }),
  body: z.strictObject({ link: z.boolean().default(false) }),
  response: z.union([
    z.object({ kind: z.literal('content'), contentType: z.string(), content: recordValue(z.base64()) }),
    z.object({ kind: z.literal('link'), contentType: z.string(), url: z.string(), expiresAt: instant }),
  ]),
  status: 201,
});

/** A signed, short-lived link to read an upload too large to open in one reply, after the same checks as opening it. */
export const signFilesUploadRead = defineContract({
  service: 'siloes-import', name: 'signFilesUploadRead', method: 'POST', path: '/v1/files-uploads/:siloFileId/read-links', callers: ['files'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ siloFileId: z.uuid() }),
  response: z.object({ url: z.string(), expiresAt: instant, filename: z.string(), contentType: z.string(), sizeBytes: z.int().min(0) }),
  status: 201,
});

/**
 * A large file sent straight to storage (design: drop prefix): a signed, resumable URL with a
 * short expiry, issued after the same permission and marking checks as an upload, for at most
 * the import bound. The file is received when the upload is completed.
 */
export const beginUpload = defineContract({
  service: 'siloes-import', name: 'beginUpload', method: 'POST', path: '/v1/import-siloes/:siloId/sources/:sourceId/uploads',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams.extend({ sourceId: z.uuid() }),
  body: z.strictObject({ sizeBytes: z.int().min(1) }),
  response: z.object({
    uploadId: z.uuid(),
    url: z.string(),
    method: z.enum(['POST', 'PUT']),
    headers: z.record(z.string(), z.string()),
    expiresAt: instant,
    maxBytes: z.int(),
  }),
  status: 201,
});

/** The signed upload landed: the file is sniffed, stored and received like any upload, and the drop object removed. */
export const completeUpload = defineContract({
  service: 'siloes-import', name: 'completeUpload', method: 'POST', path: '/v1/import-siloes/:siloId/sources/:sourceId/uploads/:uploadId/completion',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  params: siloParams.extend({ sourceId: z.uuid(), uploadId: z.uuid() }),
  body: z.strictObject({
    filename: z.string().trim().min(1).max(255),
    contentClass: z.enum(['asset_model', 'site_plan']).optional(),
  }),
  response: fileView, status: 201,
});

export const listFiles = defineContract({
  service: 'siloes-import', name: 'listFiles', method: 'GET', path: '/v1/import-siloes/:siloId/files',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  response: z.object({ files: z.array(fileView) }),
});

export const extractionView = z.object({
  id: z.uuid(), fileId: z.uuid(), filename: z.string(), object: z.string(), rowRef: z.string(), field: z.string(),
  /** Record value, for the flag. */
  value: z.json(),
  method: z.enum(['certain', 'near', 'inferred']),
  /** The model's score, shown as such: never a computed figure. */
  modelScore: z.number().nullable(),
  /** Page, cell or offset of the source text. */
  location: z.string(),
  confirmedBy: z.uuid().nullable(),
  confirmedAt: instant.nullable(),
});

/** The flag: a near or inferred value's method, source and location (68.4). */
export const getExtraction = defineContract({
  service: 'siloes-import', name: 'getExtraction', method: 'GET', path: '/v1/import-siloes/:siloId/extractions/:extractionId',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams.extend({ extractionId: z.uuid() }),
  response: extractionView,
});

export const listExtractions = defineContract({
  service: 'siloes-import', name: 'listExtractions', method: 'GET', path: '/v1/import-siloes/:siloId/extractions',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams,
  query: z.strictObject({ fileId: z.uuid().optional(), unconfirmed: z.enum(['true', 'false']).default('true') }),
  response: z.object({ extractions: z.array(extractionView.omit({ value: true })) }),
});

/**
 * The object view's extraction flags (spec 34.3, 68.4): for records read from Import Siloes,
 * each field's latest extraction (method, document, location, the model's score) by the
 * record's row reference. A record of a connection that is no Import Silo's has none.
 * Provenance only, never the extracted value: getExtraction opens that for the lineage control.
 */
export const readRecordExtractions = defineContract({
  service: 'siloes-import', name: 'readRecordExtractions', method: 'POST', path: '/v1/import-siloes/record-extractions',
  callers: ['executor'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    records: z.array(z.strictObject({ connectionId: z.uuid(), sourceObject: z.string().min(1).max(200), rowRef: z.string().min(1).max(500) })).max(50),
  }),
  response: z.object({
    extractions: z.array(z.object({
      connectionId: z.uuid(), sourceObject: z.string(), rowRef: z.string(), field: z.string(),
      siloId: z.uuid(), extractionId: z.uuid(), method: z.enum(['certain', 'near', 'inferred']),
      document: z.string(), location: z.string(), modelScore: z.number().nullable(), confirmed: z.boolean(),
    })),
  }),
  maxBodyBytes: 64 * 1024,
});

/**
 * An Import Silo's rows rebuilt in this cell's dataset after its organisation moved here (spec
 * 6.4; D212): siloes-capture asks it for each Import Silo the organisation brought. No model is
 * called: documents are rebuilt from their stored extractions.
 */
export const rebuildImportSilo = defineContract({
  service: 'siloes-import', name: 'rebuildImportSilo', method: 'POST', path: '/v1/import-siloes/:siloId/rebuild',
  callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ siloId: z.uuid() }),
  response: z.object({ files: z.int().min(0), rows: z.int().min(0) }),
});

export const confirmExtraction = defineContract({
  service: 'siloes-import', name: 'confirmExtraction', method: 'POST', path: '/v1/import-siloes/:siloId/extractions/:extractionId/confirm',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: siloParams.extend({ extractionId: z.uuid() }),
  response: extractionView,
});

/** The prebuilt catalogue (68.3): common export formats as definitions, structure only. */
export const listPrebuiltDefinitions = defineContract({
  service: 'siloes-import', name: 'listPrebuiltDefinitions', method: 'GET', path: '/v1/import-definitions/prebuilt',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    definitions: z.array(z.object({
      key: z.string(), name: z.string(), description: z.string(), reads: z.enum(['tabular', 'structured']), requiresModel: z.boolean(), document: definitionDocument,
    })),
  }),
});
