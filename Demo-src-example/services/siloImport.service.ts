import { MAX_IMPORT_FILE_BYTES as MAX_FILE_BYTES } from '../config/constants.config';
import { createHash } from 'node:crypto';
import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound, policy, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, assertCleared, authorityOf } from './authorisation.service';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { env } from '../config/env.config';
import * as objectStore from '../infra/objectStore.infra';
import * as siloImportRepo from '../repos/siloImport.repo';
import * as notifications from './notification.service';
import * as siloRepo from '../repos/silo.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as conceptRepo from '../repos/concept.repo';
import * as connectionRepo from '../repos/connection.repo';
import * as grantRepo from '../repos/connectionGrant.repo';
import * as lifecycle from '../repos/connectorVerify.repo';
import * as rowStore from './rowStore.service';
import { storageAllowed } from '../models/organisation.model';
import { manifest as manifestSchema } from '../schemas/manifest.schema';
import {
  siloDefinition,
  type DefinitionObject,
  type SiloDefinition,
} from '../schemas/siloDefinition.schema';
import { atHeader, extractTable } from '../engine/extraction/tabular.extraction';
import {
  extractDocumentTable,
  extractLabelled,
  labelsOf,
  linesOf,
  type DocumentOutcome,
} from '../engine/extraction/document.extraction';
import * as siloExtractionRepo from '../repos/siloExtraction.repo';
import { readPdf } from '../utils/pdfText.util';
import { readDocx } from '../utils/documentText.util';
import { acceptProse, proseQuestions, textOfPages } from '../engine/extraction/prose.extraction';
import { proseAnswer, type ProseAnswer } from '../schemas/proseAnswer.schema';
import * as model from '../infra/model.infra';
import * as tokens from './tokens.service';
import * as carveoutRepo from '../repos/extractionCarveout.repo';
import { DOCUMENT_MODEL_DISCLOSURE } from '../models/storageDisclosure.model';
import type { TextSpan, ValueLocation } from '../models/document.model';
import { readableIds } from './connector.service';
import { inferDefinition, inferDocumentDefinition, manifestFor, nameFor } from '../engine/extraction/definition.extraction';
import { detectDelimiter, parseCsvRecords } from '../utils/fileParser.util';
import { readWorkbook, type Workbook } from '../utils/spreadsheet.util';
import { sniff } from '../utils/mimeSniff.util';
import { importObjectKey } from '../utils/inputSanitiser.util';
import type { ExtractedRow, StoredField } from '../models/rowStore.model';
import type { Actor } from './scope.service';

const log = childLogger('silo-import');

/**
 * Siloes — Import.
 *
 * ── A Silo is a source ─────────────────────────────────────────────────────
 *
 * Files arrive, a structuring definition says what objects and fields they
 * hold, and publishing that definition makes the source a CONNECTION with a
 * manifest. From then on the query layer, grants, clearance and concept
 * derivation treat it exactly as they treat any connector — which is the whole
 * value of import: a decade of exports joining live systems through the
 * ontology, with no special case anywhere downstream.
 *
 * ── Files never pass through this process on the way in ──────────────────
 *
 * An upload is requested, the browser writes the object straight to storage
 * with a signed URL, and receipt is confirmed. Only then does this process read
 * the bytes — to check what they really are, and to structure them.
 *
 * ── Queued, never inline ────────────────────────────────────────────────────
 *
 * Structuring a file happens after receipt is confirmed, not during it. A
 * recovery sweep picks up anything a dying instance left behind.
 */

/** Import §7 — the schema's cap, restated so a request past it is refused before a row is written. */

/** What an upload may declare itself as. What it really is is decided from its bytes. */
const DECLARABLE = new Set([
  'text/csv',
  'text/tab-separated-values',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
]);

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type Db = Parameters<Parameters<typeof withTransaction>[0]>[0];

const keyOfSource = (sourceId: string) => `source-${sourceId}`;

/* ── Guards ──────────────────────────────────────────────────────────────── */

async function assertStorageOn(db: Db, organisationId: string): Promise<void> {
  if (!env.SILOES_AVAILABLE) {
    throw refusal({ message: 'This deployment is built without storage.', code: 'refusal.siloes_compiled_out' });
  }
  const organisation = await organisationRepo.findById(db, organisationId);
  if (!organisation || !storageAllowed(organisation)) {
    throw refusal({
      message: 'Storage is switched off for this organisation. A super admin turns it on.',
      code: 'refusal.storage_disabled',
    });
  }
}

/**
 * PAST THE WINDOW A FILE CANNOT BE READ, EVEN BEFORE THE SWEEP DELETES IT. The
 * disclosure says so of everything a Silo holds, and a probe or a draft reading
 * an expired file would be reading exactly what it promised was gone.
 */
function assertWithinWindow(file: siloImportRepo.SiloFile, silo: siloRepo.Silo): void {
  if (file.receivedAt && file.receivedAt.getTime() < Date.now() - silo.retentionDays * 24 * 60 * 60 * 1000) {
    throw notFound({ message: 'That file is past its Silo\'s retention window.', code: 'missing.silo_file' });
  }
}

async function liveSource(db: Db, sourceId: string): Promise<{ source: siloImportRepo.SiloSource; silo: siloRepo.Silo }> {
  const source = await siloImportRepo.findSource(db, sourceId);
  const silo = source ? await siloRepo.find(db, source.siloId) : null;
  if (!source || !silo || source.retiredAt || silo.disabledAt) {
    throw notFound({ message: 'No such import source.', code: 'missing.silo_source' });
  }
  return { source, silo };
}

/**
 * §10 — MARKING CHECK AT IMPORT TIME. A file feeding an object mapped to a
 * marked concept requires clearance on that concept, for the same reason adding
 * a marked concept to a Silo does: importing it would create a store of data the
 * person cannot see.
 */
async function assertImportCleared(
  db: Db,
  authority: Awaited<ReturnType<typeof authorityOf>>,
  source: siloImportRepo.SiloSource,
): Promise<void> {
  if (!source.connectionId) return;

  const concepts = new Set(
    (await conceptRepo.liveContributions(db))
      .filter((one) => one.connectionId === source.connectionId)
      .map((one) => one.conceptId),
  );

  for (const conceptId of concepts) {
    await assertCleared(db, authority, { type: 'concept', id: conceptId });
  }
}

/* ── Sources ─────────────────────────────────────────────────────────────── */

/** What a failure code means, in the words the person who uploaded it would use. */
const FAILURE_REASON: Record<string, string> = {
  'file.size_mismatch': 'The file that arrived was not the size that was declared.',
  'file.unsupported_type': 'That kind of file cannot be read.',
  'extract.unreadable': 'The file could not be read.',
  'extract.no_object': 'Nothing in it matched the definition.',
  'extract.missing_columns': 'Columns the definition needs are missing.',
};

export async function createSource(
  actor: Actor,
  input: { siloId: string; name: string },
): Promise<siloImportRepo.SiloSource> {
  rowStore.assertAvailable();

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.import');
        await assertStorageOn(db, actor.organisationId);

        const silo = await siloRepo.find(db, input.siloId);
        if (!silo || silo.disabledAt) throw notFound({ message: 'No such Silo.', code: 'missing.silo' });

        const source = await siloImportRepo
          .insertSource(db, {
            id: generateId(),
            organisationId: actor.organisationId,
            siloId: silo.id,
            kind: 'upload',
            name: input.name.trim(),
            location: null,
            createdBy: actor.membershipId,
          })
          .catch((error: unknown) => {
            if ((error as { code?: string }).code === '23505') {
              throw policy({
                message: `${silo.name} already has an import called ${input.name.trim()}.`,
                code: 'policy.silo_source_name_taken',
              });
            }
            throw error;
          });

        await writeAudit(db, {
          event: 'silo_source_created',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { siloId: silo.id, sourceId: source.id, kind: source.kind },
        });

        return source;
      }),
  );
}

export async function sources(actor: Actor, siloId: string): Promise<siloImportRepo.SiloSource[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.import');
        const silo = await siloRepo.find(db, siloId);
        if (!silo) throw notFound({ message: 'No such Silo.', code: 'missing.silo' });
        return siloImportRepo.sourcesIn(db, siloId);
      }),
  );
}

/* ── Files ───────────────────────────────────────────────────────────────── */

/**
 * Ask for somewhere to put a file.
 *
 * THE ROW COMES FIRST, WITH THE KEY, THE DECLARED SIZE AND THE EXPIRY. The
 * signed URL is bound to that key and content type, so the only object it can
 * write is the one this row accounts for.
 */
export async function requestUpload(
  actor: Actor,
  input: { sourceId: string; filename: string; contentType: string; bytes: number },
): Promise<{ file: siloImportRepo.SiloFile; upload: objectStore.SignedUpload }> {
  rowStore.assertAvailable();

  const contentType = input.contentType.split(';')[0]!.trim().toLowerCase();
  if (!DECLARABLE.has(contentType)) {
    throw invalid({
      message: 'Import reads spreadsheets, CSV files, PDFs and Word documents. That file type is not one of them yet.',
      code: 'invalid.file_type',
    });
  }
  if (input.bytes > MAX_FILE_BYTES) {
    throw invalid({ message: 'That file is larger than 64 MB, which is the most one import reads.', code: 'invalid.file_too_large' });
  }

  const file = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.import');
        await assertStorageOn(db, actor.organisationId);

        const { source, silo } = await liveSource(db, input.sourceId);
        await assertImportCleared(db, authority, source);

        const id = generateId();
        return siloImportRepo.insertFile(db, {
          id,
          organisationId: actor.organisationId,
          siloId: silo.id,
          sourceId: source.id,
          objectKey: importObjectKey(actor.organisationId, source.id, id, input.filename),
          filename: input.filename.slice(0, 255),
          declaredBytes: input.bytes,
          uploadExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
          uploadedBy: actor.membershipId,
        });
      }),
  );

  const upload = await objectStore.signedUploadUrl({ key: file.objectKey, contentType });
  return { file, upload };
}

/**
 * Confirm a file arrived, and find out what it really is.
 *
 * ── The size is the store's, the type is the bytes' ────────────────────────
 *
 * The object's actual size is compared with what was declared, and its type is
 * sniffed from its contents — a `.csv` that is really a workbook, or an
 * executable renamed, is refused here and its object deleted rather than kept
 * as a file nobody can read.
 */
export async function markReceived(actor: Actor, fileId: string): Promise<siloImportRepo.SiloFile> {
  const waiting = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'silo.import');
        await assertStorageOn(db, actor.organisationId);

        const file = await siloImportRepo.findFile(db, fileId);
        if (!file) throw notFound({ message: 'No such file.', code: 'missing.silo_file' });

        const { source } = await liveSource(db, file.sourceId);
        await assertImportCleared(db, authority, source);

        if (file.status !== 'awaiting_upload') {
          throw invalid({ message: 'That file has already been received.', code: 'invalid.file_already_received' });
        }
        return { file, source };
      }),
  );

  const stored = await objectStore.head(waiting.file.objectKey);
  if (!stored) {
    throw invalid({ message: 'The file has not arrived yet. Upload it, then confirm.', code: 'invalid.upload_missing' });
  }

  const refuse = async (failureCode: string, message: string) => {
    await objectStore.remove(waiting.file.objectKey);
    await tenant(actor, async (db) => {
      await siloImportRepo.markReceived(db, { id: fileId, sizeBytes: stored.bytes, contentType: 'unknown' });
      await siloImportRepo.markFailed(db, { id: fileId, failureCode });
      await writeAudit(db, {
        event: 'file_failed',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { siloId: waiting.file.siloId, sourceId: waiting.file.sourceId, fileId, failureCode },
      });
    });
    throw invalid({ message, code: `invalid.${failureCode.split('.').pop()}` });
  };

  if (stored.bytes > MAX_FILE_BYTES || stored.bytes !== waiting.file.declaredBytes) {
    return refuse('file.size_mismatch', 'The file that arrived is not the size that was declared.');
  }

  const bytes = await objectStore.get(waiting.file.objectKey);
  const contentType = classify(bytes, waiting.file.filename);
  if (!contentType) {
    return refuse('file.unsupported_type', 'That file is not a spreadsheet, a CSV file, a PDF or a Word document.');
  }

  const received = await tenant(actor, async (db) => {
    await siloImportRepo.markReceived(db, { id: fileId, sizeBytes: stored.bytes, contentType });
    await writeAudit(db, {
      event: 'file_received',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { siloId: waiting.file.siloId, sourceId: waiting.file.sourceId, fileId, bytes: stored.bytes },
    });
    return (await siloImportRepo.findFile(db, fileId))!;
  });

  if (waiting.source.definitionId) enqueue(actor.organisationId, fileId);
  return received;
}

/**
 * A source's files, each saying how much of it was uncertain.
 *
 * THE COUNTS TRAVEL WITH THE LIST, because a review somebody has to open a file
 * to discover is a review nobody opens. They come from the extraction repo
 * rather than a join: one file names that table in SQL, and a standing check
 * keeps it that way.
 */
export async function files(
  actor: Actor,
  sourceId: string,
): Promise<Array<siloImportRepo.SiloFile & { flagged: number; unconfirmed: number }>> {
  return tenant(actor, async (db) => {
    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'silo.import');
    await liveSource(db, sourceId);

    const found = await siloImportRepo.filesOf(db, sourceId);
    const counts = await siloExtractionRepo.countsOfFiles(db, found.map((file) => file.id));

    return found.map((file) => ({
      ...file,
      flagged: counts.get(file.id)?.flagged ?? 0,
      unconfirmed: counts.get(file.id)?.unconfirmed ?? 0,
    }));
  });
}

/**
 * Files §5 — could import read a document of this kind at all.
 *
 * COARSER THAN `classify` ON PURPOSE, AND THAT IS THE POINT OF IT BEING
 * SEPARATE. `classify` decides for certain, from the bytes, at the moment a
 * file is processed. This answers the earlier and weaker question — is this
 * obviously not something the importer reads — so that ingesting a photograph
 * is refused when somebody asks for it rather than failing hours later in a
 * pipeline they are not watching.
 *
 * A file that passes here may still be refused by `classify`. That is the right
 * way round: a pre-flight that could ACCEPT something the real check rejects is
 * a nuisance, while one that REJECTS something the real check would have taken
 * is a bug nobody can work around.
 */
export function couldImportRead(sniffedContentType: string): boolean {
  return (
    sniffedContentType === PDF ||
    sniffedContentType === XLSX ||
    sniffedContentType === DOCX ||
    sniffedContentType === 'application/zip' ||
    sniffedContentType === 'unknown' ||
    sniffedContentType.startsWith('text/')
  );
}

/** What the bytes are, as far as import is concerned. Null for anything it does not read. */
function classify(bytes: Buffer, filename: string): string | null {
  const sniffed = sniff(bytes);
  if (sniffed === 'application/pdf') return PDF;
  if (sniffed === 'application/zip' && /\.xlsx$/i.test(filename)) return XLSX;
  if (sniffed === 'application/zip' && /\.docx$/i.test(filename)) return DOCX;
  if (sniffed === 'unknown' && !bytes.toString('utf8').includes('�')) return 'text/csv';
  return null;
}

/* ── Reading a file under a definition ──────────────────────────────────── */

type ObjectOutcome = {
  object: DefinitionObject;
  outcome: DocumentOutcome;
  problem: string | null;
  /** The failure code a file is given when this problem stops it. */
  problemCode?: string;
};

const readsByLabel = (object: DefinitionObject) => object.fields.some((f) => f.extraction.method === 'labelled');
const readsProse = (object: DefinitionObject) => object.fields.some((f) => f.extraction.method === 'prose');

/**
 * Billing §4 — how many document extractions a file is, at six tokens each.
 *
 * ONE PER OBJECT THAT READS PROSE AND CLAIMS THIS FILE. A definition whose four
 * objects all read the same contract puts it to the model four times, and each
 * is an extraction somebody pays for.
 */
const documentsIn = (definition: SiloDefinition, filename: string): number =>
  definition.objects.filter((object) => matchesPattern(object.files.pattern, filename) && readsProse(object)).length;

/** §8 — whether a definition sends any document to a model. */
const usesModel = (definition: SiloDefinition) => definition.objects.some(readsProse);

const EMPTY: DocumentOutcome = { rows: [], rejected: [], missingColumns: [], rowsRead: 0, located: [] };

/*
 * PAST THIS, A DOCUMENT IS REFUSED RATHER THAN CUT SHORT. A model answering from
 * the first half of a contract answers as if it had read all of it.
 */
const MAX_MODEL_CHARACTERS = 400_000;

/**
 * Put a definition's questions to the model, and keep only a proper answer.
 *
 * VALIDATED ON THE WAY OUT AND REJECTED RATHER THAN REPAIRED: malformed JSON, the
 * wrong shape, or an answer naming a field nobody asked about, and nothing from
 * this document is used.
 */
async function askTheDocument(
  object: DefinitionObject,
  text: string,
): Promise<{ answer: ProseAnswer } | { problem: string; problemCode: string }> {
  if (text.length > MAX_MODEL_CHARACTERS) {
    return { problem: 'The document is too long to be read by the model in one go.', problemCode: 'extract.document_too_long' };
  }

  const questions = proseQuestions(object);
  const result = await model.readDocument({ text, fields: questions });
  const rejected = { problem: 'The model’s answer was not what was asked for, and was not used.', problemCode: 'extract.model_output_rejected' };

  if (!result.ok || !result.raw) {
    return { problem: 'The model did not answer for this document.', problemCode: 'extract.model_declined' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.raw);
  } catch {
    return rejected;
  }

  const checked = proseAnswer.safeParse(parsed);
  const asked = new Set(questions.map((question) => question.name));
  if (!checked.success || Object.keys(checked.data.fields).some((name) => !asked.has(name))) return rejected;

  return { answer: checked.data };
}

/**
 * Every object of a definition that this file feeds, extracted.
 *
 * WHICH OBJECTS IS DECIDED BY THE FILE PATTERN, and a file no object claims is
 * not an error in the file — it is a definition that does not describe it, and
 * the probe says so.
 *
 * A PDF IS READ BY POSITION OR BY QUESTION: labelled fields as one record per
 * document, columns as a table found by its headings, questions by the model. A
 * Word document has no positions and is read by question only. Everything read
 * from a document is `near` or `inferred`, and `document` says so for metering.
 */
async function extractFile(
  definition: SiloDefinition,
  file: { filename: string; contentType: string | null },
  bytes: Buffer,
): Promise<{ readable: boolean; document: boolean; objects: ObjectOutcome[] }> {
  const contentType = file.contentType && file.contentType !== 'unknown' ? file.contentType : classify(bytes, file.filename);
  if (!contentType) return { readable: false, document: false, objects: [] };

  const claimed = definition.objects.filter((object) => matchesPattern(object.files.pattern, file.filename));
  const objects: ObjectOutcome[] = [];

  if (contentType === PDF) {
    let pages: Awaited<ReturnType<typeof readPdf>>;
    try {
      pages = await readPdf(bytes);
    } catch {
      return { readable: false, document: true, objects: [] };
    }

    for (const object of claimed) {
      if (readsProse(object)) {
        const layout = textOfPages(pages);
        const asked = await askTheDocument(object, layout.text);
        objects.push(
          'answer' in asked
            ? { object, outcome: acceptProse({ object, answer: asked.answer, text: layout.text, pages }), problem: null }
            : { object, outcome: EMPTY, ...asked },
        );
        continue;
      }

      const outcome = readsByLabel(object) ? extractLabelled({ object, pages }) : extractDocumentTable({ object, pages });
      objects.push({
        object,
        outcome,
        problem: outcome.missingColumns.length
          ? `The document has no table headed ${outcome.missingColumns.join(', ')}.`
          : null,
      });
    }

    return { readable: true, document: true, objects };
  }

  if (contentType === DOCX) {
    let text: string;
    try {
      text = await readDocx(bytes);
    } catch {
      return { readable: false, document: true, objects: [] };
    }

    for (const object of claimed) {
      if (!readsProse(object)) {
        objects.push({
          object,
          outcome: EMPTY,
          problem: 'A Word document has no pages to find labels or columns on. Its fields are questions for the model.',
        });
        continue;
      }

      const asked = await askTheDocument(object, text);
      objects.push(
        'answer' in asked
          ? { object, outcome: acceptProse({ object, answer: asked.answer, text }), problem: null }
          : { object, outcome: EMPTY, ...asked },
      );
    }

    return { readable: true, document: true, objects };
  }

  let workbook: Workbook | null = null;
  const text = contentType === XLSX ? null : bytes.toString('utf8');
  if (contentType === XLSX) {
    try {
      workbook = await readWorkbook(bytes);
    } catch {
      return { readable: false, document: false, objects: [] };
    }
  }

  for (const object of claimed) {
    if (readsByLabel(object) || readsProse(object)) {
      objects.push({
        object,
        outcome: EMPTY,
        problem: 'Labels and questions are read from documents, not from spreadsheets or CSV files.',
      });
      continue;
    }

    let records: string[][] | null;
    let prefix: string;

    if (workbook) {
      const sheet = object.files.sheet ?? workbook.sheets[0];
      records = workbook.records(sheet);
      prefix = `${sheet} row `;
      if (!records) {
        objects.push({ object, outcome: EMPTY, problem: `The workbook has no sheet called ${sheet}.` });
        continue;
      }
    } else {
      const delimiter = object.files.delimiter ?? detectDelimiter(text!);
      records = parseCsvRecords(text!, delimiter).records;
      prefix = 'row ';
    }

    const { headers, data, firstDataRow } = atHeader(records, object.files.headerRow);
    const outcome = { ...extractTable({ object, headers, data, firstDataRow, rowRefPrefix: prefix }), located: [] };
    objects.push({
      object,
      outcome,
      problem: outcome.missingColumns.length
        ? `The header row has no column called ${outcome.missingColumns.join(', ')}.`
        : null,
    });
  }

  return { readable: true, document: false, objects };
}

function matchesPattern(pattern: string, filename: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(filename);
}

const shapeOf = (object: DefinitionObject): rowStore.ObjectShape => ({
  name: object.name,
  fields: object.fields.map((f): StoredField => ({ name: f.name, type: f.type })),
});

/* ── Definitions ─────────────────────────────────────────────────────────── */

export type DefinitionView = siloImportRepo.SiloDefinitionRecord & {
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
};

function view(record: siloImportRepo.SiloDefinitionRecord): DefinitionView {
  const parsed = siloDefinition.safeParse(record.document);
  return {
    ...record,
    valid: parsed.success,
    issues: parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  };
}

/** The document's fingerprint, over its parsed form so formatting cannot move it. */
function hashOf(definition: SiloDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

/**
 * §4 — a first definition, drafted from a file the source already received.
 *
 * NO MODEL. A spreadsheet's structure is its header and its cells, so the draft
 * is inference over those, and it is a DRAFT: nothing is published until a
 * person has looked at it, corrected it if they need to, and probed it.
 */
export async function draftFromFile(
  actor: Actor,
  input: { sourceId: string; fileId: string; name?: string },
): Promise<DefinitionView> {
  const { source, file } = await tenant(actor, async (db) => {
    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'silo.import');
    const found = await liveSource(db, input.sourceId);
    const one = await siloImportRepo.findFile(db, input.fileId);
    if (!one || one.sourceId !== found.source.id || !one.receivedAt || one.status === 'failed') {
      throw notFound({ message: 'No such received file in this import.', code: 'missing.silo_file' });
    }
    assertWithinWindow(one, found.silo);
    return { source: found.source, file: one };
  });

  const bytes = await objectStore.get(file.objectKey);
  const contentType = file.contentType ?? classify(bytes, file.filename);

  /* A Word document has no layout to propose fields from: its fields are questions, drafted by the model. */
  if (contentType === DOCX) {
    throw invalid({
      message: 'A Word document is read by asking questions of it. Draft its definition with the model, or write the questions.',
      code: 'invalid.draft_with_model',
    });
  }

  if (contentType === PDF) {
    const labels = labelsOf(await readPdf(bytes).catch(() => []));
    if (labels.length === 0) {
      throw invalid({
        message: 'No labelled fields were found on the first page of that document. Add them in the builder.',
        code: 'invalid.no_labels',
      });
    }

    const drafted = inferDocumentDefinition({ name: input.name?.trim() || source.name, objectName: source.name, labels });
    return tenant(actor, async (db) =>
      view(
        await siloImportRepo.insertDefinition(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          definitionKey: keyOfSource(source.id),
          name: drafted.identity.name,
          sourceRoute: 'builder',
          document: drafted,
          createdBy: actor.membershipId,
        }),
      ),
    );
  }

  let records: string[][] = [];
  let sheet: string | undefined;
  let delimiter: ',' | ';' | '\t' | '|' | undefined;

  if (contentType === XLSX) {
    const workbook = await readWorkbook(bytes);
    sheet = workbook.sheets[0];
    records = workbook.records(sheet) ?? [];
  } else {
    const text = bytes.toString('utf8');
    delimiter = detectDelimiter(text);
    records = parseCsvRecords(text, delimiter).records;
  }

  const { headers, data } = atHeader(records, 1);
  if (headers.every((header) => header === '')) {
    throw invalid({ message: 'The first row of that file has no column names to start from.', code: 'invalid.no_header' });
  }

  const drafted = inferDefinition({
    name: input.name?.trim() || source.name,
    objectName: source.name,
    headers,
    sample: data.slice(0, 200),
    sheet,
    delimiter,
  });

  return tenant(actor, async (db) =>
    view(
      await siloImportRepo.insertDefinition(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        definitionKey: keyOfSource(source.id),
        name: drafted.identity.name,
        sourceRoute: 'builder',
        document: drafted,
        createdBy: actor.membershipId,
      }),
    ),
  );
}

/** §4 — a prebuilt definition, copied into a draft the organisation can change. */
export async function adoptPrebuilt(
  actor: Actor,
  input: { sourceId: string; definitionId: string },
): Promise<DefinitionView> {
  return tenant(actor, async (db) => {
    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'silo.import');
    const { source } = await liveSource(db, input.sourceId);

    const prebuilt = await siloImportRepo.findDefinition(db, input.definitionId);
    if (!prebuilt || prebuilt.organisationId !== null || prebuilt.status !== 'published') {
      throw notFound({ message: 'No such prebuilt definition.', code: 'missing.silo_definition' });
    }

    return view(
      await siloImportRepo.insertDefinition(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        definitionKey: keyOfSource(source.id),
        name: prebuilt.name,
        sourceRoute: 'prebuilt',
        document: prebuilt.document,
        createdBy: actor.membershipId,
      }),
    );
  });
}

export async function prebuilt(actor: Actor): Promise<DefinitionView[]> {
  return tenant(actor, async (db) => {
    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'silo.import');
    return (await siloImportRepo.prebuiltDefinitions(db)).map(view);
  });
}

export async function definitions(actor: Actor, sourceId: string): Promise<DefinitionView[]> {
  return tenant(actor, async (db) => {
    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'silo.import');
    await liveSource(db, sourceId);
    return (await siloImportRepo.definitionsFor(db, keyOfSource(sourceId))).map(view);
  });
}

/**
 * The visual builder's save.
 *
 * AN INVALID DRAFT IS SAVED, AND SAYS WHY. A form half filled in is a draft; it
 * is publishing that refuses an incomplete definition, not saving one.
 */
export async function saveDraft(
  actor: Actor,
  input: { definitionId: string; name?: string; document: Record<string, unknown> },
): Promise<DefinitionView> {
  return tenant(actor, async (db) => {
    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'silo.import');

    const found = await siloImportRepo.findDefinition(db, input.definitionId);
    if (!found || found.organisationId === null) {
      throw notFound({ message: 'No such definition.', code: 'missing.silo_definition' });
    }
    if (found.status !== 'draft') {
      throw invalid({ message: 'A published definition cannot change. Draft a new version.', code: 'invalid.definition_published' });
    }

    await siloImportRepo.updateDraft(db, {
      id: found.id,
      name: input.name?.trim() || found.name,
      document: input.document,
    });
    return view((await siloImportRepo.findDefinition(db, found.id))!);
  });
}

export interface ProbeOutcome {
  passed: boolean;
  objects: Array<{
    object: string;
    rowsRead: number;
    rowsExtracted: number;
    /** Values that would carry a flag: read from a document rather than a column. */
    flagged: number;
    /** The first twenty, with the reason. Shown to the person who uploaded the file. */
    rejected: Array<{ rowRef: string; field: string; reason: string }>;
    missingColumns: string[];
    problem: string | null;
    /** The first ten rows, as they would be stored. */
    sample: Array<Record<string, unknown>>;
  }>;
  /** Set when no object of the definition reads this file. */
  unmatched: boolean;
}

/**
 * §4 — run a definition against one of the source's own files.
 *
 * "A definition that cannot extract from the files it was built for fails at
 * authoring rather than at query time." The result is recorded on the draft,
 * with a hash of the document it ran over, and publishing requires it.
 *
 * PASSING MEANS SOMETHING WAS EXTRACTED AND NOTHING WAS MISSING. A probe that
 * read every row and rejected every one has not shown the definition works.
 */
export async function probe(
  actor: Actor,
  input: { definitionId: string; fileId: string },
): Promise<ProbeOutcome> {
  const { definition, file } = await tenant(actor, async (db) => {
    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'silo.import');

    const found = await siloImportRepo.findDefinition(db, input.definitionId);
    if (!found || found.organisationId === null) {
      throw notFound({ message: 'No such definition.', code: 'missing.silo_definition' });
    }

    const one = await siloImportRepo.findFile(db, input.fileId);
    if (!one || keyOfSource(one.sourceId) !== found.definitionKey || !one.receivedAt || one.contentType === 'unknown') {
      throw notFound({ message: 'No such received file in this import.', code: 'missing.silo_file' });
    }
    const { silo } = await liveSource(db, one.sourceId);
    assertWithinWindow(one, silo);
    return { definition: found, file: one };
  });

  const parsed = siloDefinition.safeParse(definition.document);
  if (!parsed.success) {
    throw invalid({
      message: 'This definition is not complete enough to test yet.',
      code: 'invalid.definition_incomplete',
      detail: { issues: view(definition).issues },
    });
  }

  if (usesModel(parsed.data)) await tenant(actor, assertDocumentModelOn);

  /* Billing §4 — refused before the model reads anything, charged per document below. */
  const documents = documentsIn(parsed.data, file.filename);
  if (documents > 0) await tokens.afford(actor, 'document_extraction');

  const bytes = await objectStore.get(file.objectKey);
  const extracted = await extractFile(parsed.data, file, bytes).catch((error: unknown) => {
    if (error instanceof model.ModelUnavailable) throw modelUnavailable();
    throw error;
  });

  if (documents > 0) await tokens.spend(actor, 'document_extraction', { times: documents });

  const objects = extracted.objects.map(({ object, outcome, problem }) => ({
    object: object.name,
    rowsRead: outcome.rowsRead,
    rowsExtracted: outcome.rows.length,
    flagged: outcome.located.length,
    rejected: outcome.rejected.slice(0, 20),
    missingColumns: outcome.missingColumns,
    problem,
    sample: outcome.rows.slice(0, 10).map((row) => row.values),
  }));

  const passed =
    extracted.readable &&
    objects.length > 0 &&
    objects.every((one) => one.problem === null) &&
    objects.some((one) => one.rowsExtracted > 0);

  if (definition.status === 'draft') {
    await tenant(actor, (db) =>
      siloImportRepo.recordProbe(db, {
        id: definition.id,
        fileId: file.id,
        documentHash: hashOf(parsed.data),
        passed,
      }),
    );
  }

  return { passed, objects, unmatched: extracted.readable && objects.length === 0 };
}

/**
 * Publish a definition: the source becomes a connection.
 *
 * ── Only a probed document ─────────────────────────────────────────────────
 *
 * The draft must have passed a probe against one of the source's files, and the
 * document must be the one that was probed. An edit after the probe does not
 * ride on its result.
 *
 * ── A version, a manifest, and one connection for the life of the source ──
 *
 * The first publish creates the connection, grants it to the organisation as
 * any shared connector is, and activates it. Later versions publish a new
 * manifest and point the same connection at it — so a concept already mapped to
 * the source keeps its mapping, and grants keep their meaning.
 *
 * ── A field's type does not change ──────────────────────────────────────────
 *
 * Rows already stored were read under the old type. A new version may add
 * fields; a changed type is refused, with the field named.
 */
export async function publish(
  actor: Actor,
  definitionId: string,
): Promise<{ definitionId: string; version: number; connectionId: string; manifestId: string }> {
  rowStore.assertAvailable();

  const published = await tenant(actor, async (db) => {
    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'silo.import');
    await assertStorageOn(db, actor.organisationId);

    const found = await siloImportRepo.findDefinition(db, definitionId);
    if (!found || found.organisationId === null) {
      throw notFound({ message: 'No such definition.', code: 'missing.silo_definition' });
    }
    if (found.status !== 'draft') {
      throw invalid({ message: 'That definition is already published.', code: 'invalid.definition_published' });
    }

    const parsed = siloDefinition.safeParse(found.document);
    if (!parsed.success) {
      throw invalid({
        message: 'This definition is not finished yet.',
        code: 'invalid.definition_incomplete',
        detail: { issues: view(found).issues },
      });
    }

    if (usesModel(parsed.data)) await assertDocumentModelOn(db);

    if (!found.probePassed || found.probedDocumentHash !== hashOf(parsed.data)) {
      throw invalid({
        message: 'Test this definition against one of the files it is for, and publish the version that passed.',
        code: 'invalid.definition_unprobed',
      });
    }

    const sourceId = found.definitionKey.replace(/^source-/, '');
    const { source, silo } = await liveSource(db, sourceId);

    await lifecycle.lockLineage(db, `silo-definition:${actor.organisationId}:${found.definitionKey}`);

    const previous = await siloImportRepo.latestPublished(db, found.definitionKey);
    if (previous) assertNoTypeChange(siloDefinition.parse(previous.document), parsed.data);

    const version = await siloImportRepo.nextDefinitionVersion(db, {
      organisationId: actor.organisationId,
      definitionKey: found.definitionKey,
    });

    /* Built by the engine, checked by the manifest schema: a manifest this
       service produced that the schema refused would be a bug here, not input. */
    const document = manifestSchema.parse(
      manifestFor(parsed.data, { sourceId, version, retentionDays: silo.retentionDays }),
    );

    const connectorKey = `silo-import-${sourceId}`;
    const manifestVersion = await lifecycle.nextVersion(db, { organisationId: actor.organisationId, connectorKey });
    const manifestId = await lifecycle.insertVersion(db, {
      organisationId: actor.organisationId,
      connectorKey,
      version: manifestVersion,
      document: { ...document, identity: { ...document.identity, version: manifestVersion } },
      schemaVersion: document.schemaVersion,
      sourceRoute: found.sourceRoute === 'builder' ? 'visual' : found.sourceRoute,
      createdBy: actor.membershipId,
    });

    await writeAudit(db, {
      event: 'connector_manifest_versioned',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { manifestId, connectorKey, version: manifestVersion, sourceRoute: found.sourceRoute },
    });

    let connectionId = source.connectionId;

    if (!connectionId) {
      const name = `${silo.name}: ${source.name}`.slice(0, 128);
      connectionId = await connectionRepo
        .insert(db, {
          organisationId: actor.organisationId,
          manifestId,
          name,
          provider: document.identity.provider,
          owningScopeId: null,
          createdBy: actor.membershipId,
        })
        .catch((error: unknown) => {
          if ((error as { code?: string }).code === '23505') {
            throw policy({ message: `There is already a connection called ${name}.`, code: 'policy.connection_name_taken' });
          }
          throw error;
        });

      /* Shared with the organisation, as a shared connector is; who sees what is
         then the grants' and the markings' business, exactly as for Sage. */
      await grantRepo.insert(db, {
        connectionId,
        organisationWide: true,
        scopeId: null,
        membershipId: null,
        principalId: null,
        canRead: true,
        canWrite: false,
        includeDescendants: false,
        grantedBy: actor.membershipId,
        /* A Silo's own source, granted by the system at publication. */
        grantedAtScopeId: null,
        expiresAt: null,
      });
      await lifecycle.activate(db, connectionId);

      await writeAudit(db, {
        event: 'connector_created',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { connectionId, manifestId, name },
      });
      await writeAudit(db, {
        event: 'connection_granted',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { connectionId, granteeType: 'organisation', granteeId: null, grantedAtScopePath: null },
      });
    } else {
      if (previous?.manifestId) await lifecycle.supersede(db, { manifestId: previous.manifestId, byManifestId: manifestId });
      await lifecycle.pointAtManifest(db, connectionId, manifestId);
    }

    await siloImportRepo.markPublished(db, { id: found.id, version, manifestId });
    await siloImportRepo.attachDefinition(db, { sourceId, definitionId: found.id, connectionId });

    await writeAudit(db, {
      event: 'silo_definition_published',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { siloId: silo.id, sourceId, definitionId: found.id, version },
    });

    return {
      sourceId,
      connectionId,
      manifestId,
      version,
      retentionDays: silo.retentionDays,
      objects: parsed.data.objects.map(shapeOf),
      waiting: (await siloImportRepo.waitingFiles(db, sourceId)).map((one) => one.id),
    };
  });

  await rowStore.ensureObjects({
    organisationId: actor.organisationId,
    sourceId: published.sourceId,
    objects: published.objects,
    retentionDays: published.retentionDays,
  });

  for (const fileId of published.waiting) enqueue(actor.organisationId, fileId);

  return {
    definitionId,
    version: published.version,
    connectionId: published.connectionId,
    manifestId: published.manifestId,
  };
}

function assertNoTypeChange(previous: SiloDefinition, next: SiloDefinition): void {
  for (const object of next.objects) {
    const before = previous.objects.find((one) => one.name === object.name);
    if (!before) continue;
    for (const f of object.fields) {
      const held = before.fields.find((one) => one.name === f.name);
      if (held && held.type !== f.type) {
        throw invalid({
          message:
            `${object.name}.${f.name} was ${held.type} and cannot become ${f.type}: rows already ` +
            'stored were read as the old type. Give the new reading a new field name.',
          code: 'invalid.definition_type_change',
        });
      }
    }
  }
}

/* ── Processing ──────────────────────────────────────────────────────────── */

const queue: Array<{ organisationId: string; fileId: string }> = [];
let running: Promise<void> | null = null;

/** Structure a received file after the request that confirmed it has returned. */
export function enqueue(organisationId: string, fileId: string): void {
  queue.push({ organisationId, fileId });
  if (!running) {
    running = drainQueue().finally(() => {
      running = null;
    });
  }
}

async function drainQueue(): Promise<void> {
  while (queue.length > 0) {
    const next = queue.shift()!;
    try {
      await processFile(next.organisationId, next.fileId);
    } catch (error: unknown) {
      log.warn({ fileId: next.fileId, err: error }, 'Import processing failed');
    }
  }
}

/**
 * Wait until nothing is being structured. For shutdown, so an instance does not
 * leave a file half-loaded, and for tests.
 */
export async function settled(): Promise<void> {
  while (running) await running;
}

/**
 * Structure one received file into its source's row store.
 *
 * ── Idempotent, because a claim can be abandoned ───────────────────────────
 *
 * Rows the file produced before are removed before its rows are written, so a
 * file reprocessed after an instance died part-way cannot be counted twice.
 *
 * ── All or nothing per file ────────────────────────────────────────────────
 *
 * If any object the file feeds cannot find its columns, the file fails and
 * nothing from it is stored. A file that half-imported would look imported.
 *
 * ── Waiting is not failing ─────────────────────────────────────────────────
 *
 * A file whose source has no published definition yet, or whose organisation
 * has switched storage off, is handed back to wait rather than marked failed.
 */
export async function processFile(
  organisationId: string,
  fileId: string,
): Promise<'processed' | 'failed' | 'waiting' | 'skipped'> {
  const system = { organisationId, membershipId: null };

  const claimed = await runWithTenant(system, () =>
    withTransaction(async (db) => {
      const file = await siloImportRepo.claimForProcessing(db, fileId);
      if (!file) return { state: 'skipped' as const };

      const source = await siloImportRepo.findSource(db, file.sourceId);
      const silo = source ? await siloRepo.find(db, source.siloId) : null;
      const organisation = await organisationRepo.findById(db, organisationId);
      const definition = source?.definitionId ? await siloImportRepo.findDefinition(db, source.definitionId) : null;

      const document = definition?.status === 'published' ? siloDefinition.parse(definition.document) : null;

      /* §8 — a definition that asks a model waits, not fails, while the organisation's choice is not in force. */
      const modelAllowed = !document || !usesModel(document) || documentModelOn(await carveoutRepo.find(db));

      const ready =
        env.SILOES_AVAILABLE &&
        rowStore.kind() !== null &&
        source && !source.retiredAt &&
        silo && !silo.disabledAt &&
        organisation && storageAllowed(organisation) &&
        document !== null &&
        modelAllowed;

      if (!ready) {
        await siloImportRepo.releaseClaim(db, fileId);
        return { state: 'waiting' as const };
      }

      return {
        state: 'claimed' as const,
        file,
        silo: silo!,
        definition: document!,
        sourceCreatedBy: source?.createdBy ?? null,
      };
    }),
  );

  if (claimed.state !== 'claimed') return claimed.state;
  const { file, silo, definition } = claimed;

  const fail = async (failureCode: string) => {
    await runWithTenant(system, () =>
      withTransaction(async (db) => {
        await siloImportRepo.markFailed(db, { id: fileId, failureCode });
        await writeAudit(db, {
          event: 'file_failed',
          organisationId,
          membershipId: null,
          userId: null,
          detail: { siloId: silo.id, sourceId: file.sourceId, fileId, failureCode },
        });

        /*
         * THE PERSON WHO SENT IT IS THE ONE WHO CAN DO ANYTHING ABOUT IT, and
         * this happened in the background, minutes or hours after they walked
         * away from the upload. Nothing else would ever tell them.
         */
        if (file.uploadedBy) {
          await notifications.tell(db, {
            organisationId,
            membershipId: file.uploadedBy,
            kind: 'import',
            title: `${file.filename} could not be read`,
            body: FAILURE_REASON[failureCode] ?? 'It arrived but nothing could be read from it.',
            href: `/siloes/${silo.id}/sources/${file.sourceId}`,
          });
        }
      }),
    );
    return 'failed' as const;
  };

  /*
   * Billing §4 — CHARGED TO A PERSON, because an allowance belongs to one. The
   * person who uploaded the file, or where a watched location dropped it with
   * nobody attached, whoever set that location up. A file nobody can be charged
   * for is still read: refusing it would strand a watched location silently.
   */
  const documents = documentsIn(definition, file.filename);
  const payer = file.uploadedBy ?? claimed.sourceCreatedBy;
  const billing = payer ? { organisationId, membershipId: payer } : null;

  if (documents > 0 && billing) await tokens.afford(billing, 'document_extraction');

  let extracted: Awaited<ReturnType<typeof extractFile>>;
  try {
    extracted = await extractFile(definition, file, await objectStore.get(file.objectKey));
  } catch (error) {
    /* The model not being there is a reason to wait, not a verdict on the file. */
    if (error instanceof model.ModelUnavailable) {
      await runWithTenant(system, () => withTransaction((db) => siloImportRepo.releaseClaim(db, fileId)));
      return 'waiting';
    }
    return fail('extract.unreadable');
  }

  if (!extracted.readable) return fail('extract.unreadable');
  if (extracted.objects.length === 0) return fail('extract.no_object');
  if (documents > 0 && billing) await tokens.spend(billing, 'document_extraction', { times: documents });

  const stopped = extracted.objects.find((one) => one.problem !== null);
  if (stopped) return fail(stopped.problemCode ?? 'extract.missing_columns');

  const receivedAt = file.receivedAt ?? new Date();

  /* A person's confirmation outlives the file being read again. */
  const confirmed = await runWithTenant(system, () =>
    withTransaction((db) => siloExtractionRepo.confirmedKeysOf(db, fileId)),
  );
  const unconfirmed = (objectName: string, row: ExtractedRow): ExtractedRow => ({
    ...row,
    methods: Object.fromEntries(
      Object.entries(row.methods).filter(([field]) => !confirmed.has(`${objectName}\u0000${row.rowRef}\u0000${field}`)),
    ),
  });
  let rowsExtracted = 0;
  let rowsRejected = 0;

  try {
    await rowStore.ensureObjects({
      organisationId,
      sourceId: file.sourceId,
      objects: extracted.objects.map((one) => shapeOf(one.object)),
      retentionDays: silo.retentionDays,
    });

    await rowStore.removeFileRows({
      organisationId,
      sourceId: file.sourceId,
      fileId,
      objectNames: extracted.objects.map((one) => one.object.name),
    });

    for (const { object, outcome } of extracted.objects) {
      rowsExtracted += await rowStore.insertRows({
        organisationId,
        siloId: silo.id,
        sourceId: file.sourceId,
        fileId,
        object: shapeOf(object),
        receivedAt,
        rows: outcome.rows.map((row) => unconfirmed(object.name, row)),
      });
      rowsRejected += outcome.rejected.length;
    }
  } catch (error: unknown) {
    log.warn({ fileId, err: error }, 'Import rows could not be stored');
    return fail('store.failed');
  }

  const kept = await runWithTenant(system, () =>
    withTransaction(async (db) => {
      if (!(await siloImportRepo.markProcessed(db, { id: fileId, rowsExtracted, rowsRejected }))) return false;

      /*
       * WHERE EACH UNCERTAIN VALUE WAS READ, REPLACED WITH THE ROWS. A file
       * processed twice has one set of references, as it has one set of rows.
       */
      await siloExtractionRepo.deleteUnconfirmedOfFile(db, fileId);
      const flagged = await siloExtractionRepo.insertForFile(db, {
        organisationId,
        siloId: silo.id,
        sourceId: file.sourceId,
        fileId,
        extractions: extracted.objects.flatMap(({ object, outcome }) =>
          outcome.located.map((one) => ({
            objectName: object.name,
            rowRef: one.rowRef,
            field: one.field,
            method: one.method ?? 'near',
            confidence: one.confidence ?? null,
            location: one.location ?? null,
            span: one.span ?? null,
          })),
        ),
      });

      /* §9 — metered per document read, whatever it yielded. */
      if (extracted.document) await siloImportRepo.recordExtractionOperations(db, silo.id, 1);

      await writeAudit(db, {
        event: 'file_processed',
        organisationId,
        membershipId: null,
        userId: null,
        detail: { siloId: silo.id, sourceId: file.sourceId, fileId, rowsExtracted, rowsRejected },
      });

      if (flagged > 0) {
        await writeAudit(db, {
          event: 'extraction_flagged',
          organisationId,
          membershipId: null,
          userId: null,
          detail: { siloId: silo.id, sourceId: file.sourceId, fileId, flagged },
        });
      }
      return true;
    }),
  );

  /*
   * PURGED WHILE ITS ROWS WERE BEING WRITTEN. The purge deleted what was there
   * and then the file row; rows that landed after it would belong to nothing
   * and outlive the receipt. They go now, rather than at the partition expiry.
   */
  if (!kept) {
    await rowStore.removeFileRows({
      organisationId,
      sourceId: file.sourceId,
      fileId,
      objectNames: extracted.objects.map((one) => one.object.name),
    });
    return 'skipped';
  }

  return 'processed';
}

function tenant<T>(actor: Actor, work: (db: Db) => Promise<T>): Promise<T> {
  return runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
    withTransaction(work),
  );
}

/* ── The local stand-in for a signed upload ──────────────────────────────── */

/**
 * Write an upload the local object store's token authorises.
 *
 * EXISTS ONLY WHERE THE OBJECT STORE IS LOCAL — outside production, with no
 * bucket. The token carries the key and the content type it was signed for, as
 * a signed URL does, and a body sent with any other type is refused rather than
 * stored under a type nobody declared.
 */
export async function acceptLocalUpload(input: {
  token: string;
  contentType: string | undefined;
  body: Buffer;
}): Promise<void> {
  const opened = objectStore.openLocalUpload(input.token);
  if (!opened) {
    throw refusal({ message: 'That upload link is not valid, or has expired.', code: 'refusal.upload_link' });
  }
  if ((input.contentType ?? '').split(';')[0]!.trim().toLowerCase() !== opened.contentType) {
    throw invalid({ message: 'Upload the file with the content type it was requested with.', code: 'invalid.upload_type' });
  }
  if (input.body.byteLength > MAX_FILE_BYTES) {
    throw invalid({ message: 'That file is larger than 64 MB.', code: 'invalid.file_too_large' });
  }

  await objectStore.putAt({ key: opened.key, body: input.body, sniffedContentType: opened.contentType });
}

/* ── A watched location's delivery ───────────────────────────────────────── */

/**
 * A file a watched location delivered.
 *
 * ── The trigger differs, the treatment does not ────────────────────────────
 *
 * §2: "Both produce the same result. The difference is trigger, not treatment."
 * So this is the upload path with the signed URL taken out: a row, the object,
 * the check of what the bytes really are, receipt, and the same queue.
 *
 * ── Whose act it is ─────────────────────────────────────────────────────────
 *
 * Nobody pressed anything, but somebody configured the location, and every file
 * it delivers is data they chose to put in. Their permission and their clearance
 * are checked for each file — so a person who loses `silo.import`, or clearance
 * on a concept the import now feeds, stops the pickups, rather than leaving a
 * standing arrangement that outlives their authority.
 */
export async function receiveWatched(input: {
  organisationId: string;
  sourceId: string;
  filename: string;
  body: Buffer;
}): Promise<siloImportRepo.SiloFile> {
  rowStore.assertAvailable();
  if (input.body.byteLength === 0 || input.body.byteLength > MAX_FILE_BYTES) {
    throw invalid({ message: 'A delivered file must be between one byte and 64 MB.', code: 'invalid.file_too_large' });
  }

  const within = <T>(work: (db: Db) => Promise<T>) =>
    runWithTenant({ organisationId: input.organisationId, membershipId: null }, () => withTransaction(work));

  const { file, source } = await within(async (db) => {
    await assertStorageOn(db, input.organisationId);
    const found = await liveSource(db, input.sourceId);
    if (found.source.kind !== 'watched') {
      throw invalid({ message: 'Only a watched location delivers files.', code: 'invalid.not_watched' });
    }

    const authority = await authorityOf(db, found.source.createdBy, input.organisationId);
    assertCan(authority, 'silo.import');
    await assertImportCleared(db, authority, found.source);

    const id = generateId();
    return {
      source: found.source,
      file: await siloImportRepo.insertFile(db, {
        id,
        organisationId: input.organisationId,
        siloId: found.silo.id,
        sourceId: found.source.id,
        objectKey: importObjectKey(input.organisationId, found.source.id, id, input.filename),
        filename: input.filename.slice(0, 255),
        declaredBytes: input.body.byteLength,
        uploadExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
        uploadedBy: null,
      }),
    };
  });

  const contentType = classify(input.body, file.filename);

  if (!contentType) {
    return within(async (db) => {
      await siloImportRepo.markReceived(db, { id: file.id, sizeBytes: input.body.byteLength, contentType: 'unknown' });
      await siloImportRepo.markFailed(db, { id: file.id, failureCode: 'file.unsupported_type' });
      await writeAudit(db, {
        event: 'file_failed',
        organisationId: input.organisationId,
        membershipId: source.createdBy,
        userId: null,
        detail: { siloId: file.siloId, sourceId: file.sourceId, fileId: file.id, failureCode: 'file.unsupported_type' },
      });
      return (await siloImportRepo.findFile(db, file.id))!;
    });
  }

  await objectStore.putAt({ key: file.objectKey, body: input.body, sniffedContentType: contentType });

  const received = await within(async (db) => {
    await siloImportRepo.markReceived(db, { id: file.id, sizeBytes: input.body.byteLength, contentType });
    await writeAudit(db, {
      event: 'file_received',
      organisationId: input.organisationId,
      membershipId: source.createdBy,
      userId: null,
      detail: { siloId: file.siloId, sourceId: file.sourceId, fileId: file.id, bytes: input.body.byteLength },
    });
    return (await siloImportRepo.findFile(db, file.id))!;
  });

  if (source.definitionId) enqueue(input.organisationId, file.id);
  return received;
}

/* ── A flag, explained ───────────────────────────────────────────────────── */

export interface FlagExplanation {
  method: 'near' | 'inferred';
  /** A model's score, called one. Null for a value located on the page, which has none. */
  confidence: { score: number; kind: 'model score' } | null;
  document: { fileId: string; filename: string };
  location: ValueLocation | null;
  /** Where in the text, for a document with no pages. */
  span: TextSpan | null;
  /** The text inside the box the value was read from, read back out of the file now. */
  rawText: string;
  confirmed: { by: string; at: Date } | null;
}

/**
 * §5 — every flagged value in one file, as a queue to work through.
 *
 * ── THE PIECE THAT WAS MISSING ────────────────────────────────────────────
 *
 * A flag could be explained and confirmed only by somebody who already knew
 * its object, row and field, and nothing in the product could tell them: both
 * endpoints existed and neither was reachable. This is what makes them a
 * review.
 *
 * ── THE SAME CONDITIONS AS THE VALUE ──────────────────────────────────────
 *
 * The import's connection is one the person can read, they hold clearance on
 * any concept it feeds, and the file is inside its window — exactly as
 * `explain` requires, because a list of what is uncertain in a file is a claim
 * about the file.
 */
export async function flagged(
  actor: Actor,
  fileId: string,
): Promise<{
  file: { fileId: string; filename: string };
  flags: Array<{
    object: string;
    row: string;
    field: string;
    method: 'near' | 'inferred';
    confidence: number | null;
    page: number | null;
    confirmed: { by: string; at: Date } | null;
  }>;
}> {
  return tenant(actor, async (db) => {
    const missing = () => notFound({ message: 'No such file.', code: 'missing.silo_file' });

    const file = await siloImportRepo.findFile(db, fileId);
    const source = file ? await siloImportRepo.findSource(db, file.sourceId) : null;
    const silo = source ? await siloRepo.find(db, source.siloId) : null;
    if (!file || !source || !silo || !source.connectionId) throw missing();

    if (!(await readableIds(db, actor, [source.connectionId])).has(source.connectionId)) throw missing();
    await assertImportCleared(db, await authorityOf(db, actor.membershipId, actor.organisationId), source);
    assertWithinWindow(file, silo);

    const extractions = await siloExtractionRepo.flaggedOfFile(db, file.id);

    return {
      file: { fileId: file.id, filename: file.filename },
      flags: extractions.map((one) => ({
        object: one.objectName,
        row: one.rowRef,
        field: one.fieldName,
        method: one.method,
        confidence: one.confidence,
        page: one.location?.page ?? null,
        confirmed: one.confirmedAt && one.confirmedBy ? { by: one.confirmedBy, at: one.confirmedAt } : null,
      })),
    };
  });
}

/**
 * §5 — what clicking a flag shows.
 *
 * ── Whoever may see the value may see where it came from ───────────────────
 *
 * The same conditions as the value: the import's connection is one the person
 * can read, they hold clearance on any concept it feeds, and the file is inside
 * its window. Anything else is not found, so a flag cannot confirm a file
 * exists to somebody who could not see its rows.
 *
 * ── The raw text is read back, not recalled ────────────────────────────────
 *
 * Nothing stored the text; the page and the box were stored. So it is read out
 * of the file at the moment it is asked for, and it is exactly what the file
 * says there now.
 */
export async function explain(
  actor: Actor,
  input: { fileId: string; object: string; rowRef: string; field: string },
): Promise<FlagExplanation> {
  const found = await tenant(actor, async (db) => {
    const missing = () => notFound({ message: 'No such flagged value.', code: 'missing.silo_extraction' });

    const file = await siloImportRepo.findFile(db, input.fileId);
    const source = file ? await siloImportRepo.findSource(db, file.sourceId) : null;
    const silo = source ? await siloRepo.find(db, source.siloId) : null;
    if (!file || !source || !silo || !source.connectionId) throw missing();

    if (!(await readableIds(db, actor, [source.connectionId])).has(source.connectionId)) throw missing();
    await assertImportCleared(db, await authorityOf(db, actor.membershipId, actor.organisationId), source);
    assertWithinWindow(file, silo);

    const extraction = await siloExtractionRepo.find(db, {
      fileId: file.id,
      objectName: input.object,
      rowRef: input.rowRef,
      field: input.field,
    });
    if (!extraction) throw missing();

    return { file, extraction };
  });

  const { location, span } = found.extraction;
  const bytes = await objectStore.get(found.file.objectKey);
  let rawText = '';

  if (location) {
    const page = (await readPdf(bytes)).find((one) => one.page === location.page);
    const within = (page?.items ?? []).filter(
      (item) =>
        item.x + item.width > location.x - 1 &&
        item.x < location.x + location.width + 1 &&
        item.y + item.height > location.y - 1 &&
        item.y < location.y + location.height + 1,
    );
    rawText = linesOf({ page: location.page, items: within })
      .map((line) => line.items.map((item) => item.text).join(' '))
      .join('\n');
  } else if (span) {
    /* Exactly the text the model was given, so the offset means what it meant. */
    const text = found.file.contentType === DOCX ? await readDocx(bytes) : textOfPages(await readPdf(bytes)).text;
    rawText = text.slice(span.offset, span.offset + span.length);
  }

  return {
    method: found.extraction.method,
    confidence:
      found.extraction.confidence === null ? null : { score: found.extraction.confidence, kind: 'model score' },
    document: { fileId: found.file.id, filename: found.file.filename },
    location,
    span,
    rawText,
    confirmed:
      found.extraction.confirmedBy && found.extraction.confirmedAt
        ? { by: found.extraction.confirmedBy, at: found.extraction.confirmedAt }
        : null,
  };
}

/* ── The carve-out ───────────────────────────────────────────────────────── */

const DOCUMENT_MODEL_VERSION = createHash('sha256').update(DOCUMENT_MODEL_DISCLOSURE.join('\n\n')).digest('hex');

/** In force: chosen against the words shown now, and retention confirmed by the operator. */
function documentModelOn(consent: carveoutRepo.ExtractionCarveout | null): boolean {
  return consent?.disclosureVersion === DOCUMENT_MODEL_VERSION && env.VERTEX_ZERO_RETENTION_CONFIRMED;
}

async function assertDocumentModelOn(db: Db): Promise<void> {
  const consent = await carveoutRepo.find(db);
  if (consent?.disclosureVersion !== DOCUMENT_MODEL_VERSION) {
    throw refusal({
      message:
        'Reading documents with a model is switched off for this organisation. A super admin switches it on, ' +
        'having read what it sends and where.',
      code: 'refusal.document_model_off',
    });
  }
  if (!env.VERTEX_ZERO_RETENTION_CONFIRMED) {
    throw refusal({
      message: 'This deployment has not confirmed zero data retention with the model, so no document is sent to it.',
      code: 'refusal.document_model_retention_unconfirmed',
    });
  }
}

const modelUnavailable = () =>
  refusal({ message: 'The model is not available to read documents in this deployment.', code: 'refusal.document_model_unavailable' });

/** §8 — whether documents may be read by a model here, and the words to read before choosing it. */
export async function documentModel(actor: Actor): Promise<{
  enabled: boolean;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  retentionConfirmed: boolean;
  disclosure: { paragraphs: readonly string[]; version: string };
}> {
  return tenant(actor, async (db) => {
    const consent = await carveoutRepo.find(db);
    const current = consent !== null && consent.disclosureVersion === DOCUMENT_MODEL_VERSION;
    return {
      enabled: current,
      acknowledgedAt: current ? consent.acknowledgedAt : null,
      acknowledgedBy: current ? consent.acknowledgedBy : null,
      retentionConfirmed: env.VERTEX_ZERO_RETENTION_CONFIRMED,
      disclosure: { paragraphs: DOCUMENT_MODEL_DISCLOSURE, version: DOCUMENT_MODEL_VERSION },
    };
  });
}

/**
 * §8 — choose, or stop, having documents read by a model.
 *
 * ── `silo.enable`, because it is the same kind of decision ─────────────────
 *
 * Super admin only and never delegable: it changes what leaves the deployment.
 *
 * ── Chosen against the words, provably ─────────────────────────────────────
 *
 * As switching storage on is: the version of the disclosure the person was
 * shown, or a refusal. §13 — `extraction_carveout_acknowledged` "records who
 * accepted that document contents go to a model, and when. That is the row a
 * security reviewer asks for."
 */
export async function setDocumentModel(
  actor: Actor,
  input: { enabled: boolean; acknowledgedDisclosure?: string },
): Promise<void> {
  if (!env.SILOES_AVAILABLE) {
    throw refusal({ message: 'This deployment is built without storage. There is nothing to enable.', code: 'refusal.siloes_compiled_out' });
  }

  await tenant(actor, async (db) => {
    assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.enable');

    if (!input.enabled) {
      if (await carveoutRepo.withdraw(db)) {
        await writeAudit(db, {
          event: 'extraction_carveout_withdrawn',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {},
        });
      }
      return;
    }

    if (input.acknowledgedDisclosure !== DOCUMENT_MODEL_VERSION) {
      throw invalid({
        message:
          'Read what reading documents with a model sends, and where, before switching it on. The words have to ' +
          'be acknowledged, and they may have changed since they were last shown.',
        code: 'invalid.disclosure_not_acknowledged',
        detail: { version: DOCUMENT_MODEL_VERSION },
      });
    }

    await carveoutRepo.acknowledge(db, {
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      disclosureVersion: DOCUMENT_MODEL_VERSION,
    });

    await writeAudit(db, {
      event: 'extraction_carveout_acknowledged',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { disclosureVersion: DOCUMENT_MODEL_VERSION },
    });
  });
}

/**
 * §4 — "AI drafted. Files are sampled, a definition is proposed, probed against
 * the real files, and the user confirms or corrects."
 *
 * UNDER THE CARVE-OUT, because sampling a document for the model is sending it.
 * And REJECTED RATHER THAN REPAIRED: a proposal that fails the definition schema
 * is refused with what was wrong, and nothing is saved.
 */
export async function draftFromDocuments(
  actor: Actor,
  input: { sourceId: string; fileIds: string[]; name?: string },
): Promise<DefinitionView> {
  const { source, files } = await tenant(actor, async (db) => {
    assertCan(await authorityOf(db, actor.membershipId, actor.organisationId), 'silo.import');
    const found = await liveSource(db, input.sourceId);
    await assertDocumentModelOn(db);

    const chosen: siloImportRepo.SiloFile[] = [];
    for (const fileId of input.fileIds) {
      const one = await siloImportRepo.findFile(db, fileId);
      if (!one || one.sourceId !== found.source.id || !one.receivedAt || one.status === 'failed') {
        throw notFound({ message: 'No such received file in this import.', code: 'missing.silo_file' });
      }
      assertWithinWindow(one, found.silo);
      chosen.push(one);
    }
    return { source: found.source, files: chosen };
  });

  const samples: string[] = [];
  for (const file of files) {
    const bytes = await objectStore.get(file.objectKey);
    const text =
      file.contentType === PDF ? textOfPages(await readPdf(bytes)).text : file.contentType === DOCX ? await readDocx(bytes) : null;
    if (text === null) {
      throw invalid({ message: 'A definition is drafted from documents: PDFs or Word documents.', code: 'invalid.not_a_document' });
    }
    /* A sample, for proposing questions. Extraction itself never cuts a document short. */
    samples.push(text.slice(0, 50_000));
  }

  const name = input.name?.trim() || source.name;

  /* Billing §4 — drafting a definition is a generation, like drafting a connector. */
  await tokens.afford(actor, 'connector_generation');

  const result = await model
    .draftDocumentDefinition({ samples, name, objectName: nameFor(source.name) })
    .catch((error: unknown) => {
      if (error instanceof model.ModelUnavailable) throw modelUnavailable();
      throw error;
    });

  if (!result.ok || !result.raw) {
    /* A model that declined produced nothing: §4 never bills a refusal. */
    throw refusal({ message: result.refusal ?? 'The model did not propose a definition.', code: 'refusal.model_declined' });
  }

  await tokens.spend(actor, 'connector_generation');

  let proposed: unknown;
  try {
    proposed = JSON.parse(result.raw);
  } catch {
    proposed = null;
  }

  const checked = siloDefinition.safeParse(proposed);
  if (!checked.success) {
    throw invalid({
      message: 'The model proposed a definition that is not valid, and it was not used.',
      code: 'invalid.model_definition_rejected',
      detail: { issues: checked.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    });
  }

  return tenant(actor, async (db) =>
    view(
      await siloImportRepo.insertDefinition(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        definitionKey: keyOfSource(source.id),
        name: checked.data.identity.name,
        sourceRoute: 'ai',
        document: checked.data,
        createdBy: actor.membershipId,
      }),
    ),
  );
}

/* ── Confirmation ────────────────────────────────────────────────────────── */

/**
 * §5 — a person says a value read from a document is right.
 *
 * ── Certain from then on, for that value ───────────────────────────────────
 *
 * The flag records who and when, the row store stops marking the field, and
 * every total built on it afterwards counts it as certain. Reading the file
 * again keeps the decision. "The machine proposes, a person decides, and the
 * decision is exact thereafter."
 *
 * ── Asserting a fact about a concept ───────────────────────────────────────
 *
 * §10: "Extraction confirmation requires whatever permission covers the concept
 * the value maps to, since confirming a value is asserting a fact about that
 * concept." So `concept.confirm`, clearance on every concept the value's object
 * feeds, and the import's connection readable — somebody who could not see the
 * value cannot vouch for it.
 *
 * ── The record first, then the rows ────────────────────────────────────────
 *
 * The confirmation is committed before the row store is changed, so a failure
 * between them leaves a confirmed value still marked, never an unmarked value
 * nobody confirmed. Confirming again finishes it.
 */
export async function confirmExtraction(
  actor: Actor,
  input: { fileId: string; object: string; rowRef: string; field: string },
): Promise<{ confirmedAt: Date; confirmedBy: string }> {
  const confirmed = await tenant(actor, async (db) => {
    const missing = () => notFound({ message: 'No such flagged value.', code: 'missing.silo_extraction' });

    const file = await siloImportRepo.findFile(db, input.fileId);
    const source = file ? await siloImportRepo.findSource(db, file.sourceId) : null;
    const silo = source ? await siloRepo.find(db, source.siloId) : null;
    if (!file || !source || !silo || !source.connectionId) throw missing();
    if (!(await readableIds(db, actor, [source.connectionId])).has(source.connectionId)) throw missing();

    const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
    assertCan(authority, 'concept.confirm');

    const concepts = new Set(
      (await conceptRepo.liveContributions(db))
        .filter((one) => one.connectionId === source.connectionId && one.objectName === input.object)
        .map((one) => one.conceptId),
    );
    for (const conceptId of concepts) await assertCleared(db, authority, { type: 'concept', id: conceptId });

    assertWithinWindow(file, silo);

    const extraction = await siloExtractionRepo.find(db, {
      fileId: file.id,
      objectName: input.object,
      rowRef: input.rowRef,
      field: input.field,
    });
    if (!extraction) throw missing();

    /* Confirmed once. Asked again, it says who did, and finishes the rows. */
    if (extraction.confirmedAt && extraction.confirmedBy) {
      return { sourceId: source.id, confirmedAt: extraction.confirmedAt, confirmedBy: extraction.confirmedBy };
    }

    const confirmedAt = await siloExtractionRepo.confirm(db, { id: extraction.id, membershipId: actor.membershipId });
    if (!confirmedAt) throw missing();

    await siloExtractionRepo.recordConfirmation(db, {
      id: generateId(),
      organisationId: actor.organisationId,
      extractionId: extraction.id,
      fileId: file.id,
      membershipId: actor.membershipId,
      previousMethod: extraction.method,
    });

    await writeAudit(db, {
      event: 'extraction_confirmed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { siloId: silo.id, sourceId: source.id, fileId: file.id, previousMethod: extraction.method },
    });

    return { sourceId: source.id, confirmedAt, confirmedBy: actor.membershipId };
  });

  await rowStore.certifyField({
    organisationId: actor.organisationId,
    sourceId: confirmed.sourceId,
    objectName: input.object,
    fileId: input.fileId,
    rowRef: input.rowRef,
    field: input.field,
  });

  return { confirmedAt: confirmed.confirmedAt, confirmedBy: confirmed.confirmedBy };
}

