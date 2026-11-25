// Processing Import files (spec 68.2 to 68.4, 68.8), in the order the build order sets:
//
// - Tabular files (CSV, TSV) are read column by column: every value certain, no model, no
//   carve-out. A definition object is read when every one of its columns is in the header.
// - Structured documents and prose go to the model gateway's document extraction, which
//   checks the carve-out itself. A labelled field's value is near, a prose field's inferred;
//   each such value is an extraction (sealed, with its location and the model's score) and
//   carries its method and extraction id into the row store.
// - Asset models and site plans are stored only: never extracted, never sent to a model.
// - A file that cannot be read is failed with its stage, never a value; it can be purged.
// Watched locations are polled on their schedule; what is dropped there is taken in as the
// source's creator, then removed from the drop point.

import { createHash } from 'node:crypto';
import { openRecordValues, sealRecordValues } from '../../contracts/credential/recordValue.contract.ts';
import { loadImportRows } from '../../contracts/import-loader/load.contract.ts';
import { extractDocument } from '../../contracts/model-gateway/extraction.contract.ts';
import type { DefinitionDocument } from '../../contracts/siloes/import.contract.ts';
import type { ObjectKey } from '../../infra/objectStorage.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { SiloFile } from '../../models/siloes/index.model.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { siloDefinitionRepo, siloExtractionRepo, siloFileRepo, siloRepo, siloSourceRepo } from '../../repos/siloes/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { measureStore } from '../bigquery-metering/metering.service.ts';
import type { Context } from '../siloes-capture/deps.service.ts';
import { recordEvent } from '../warehouse-schema/warehouse.service.ts';
import { extractionBinding, storeFile, type ImportDeps } from './import.service.ts';
import { cellValue, parseDelimited, sniff } from './tabular.service.ts';
import { fromSerial, parseWorkbook } from './workbook.service.ts';

type Field = DefinitionDocument['objects'][number]['fields'][number];
type Row = { rowRef: string; values: Record<string, unknown>; extraction: Record<string, { method: 'near' | 'inferred' | 'certain'; extractionId: string }> };

const fail = (code: string, message: string, details: Record<string, string | number> = {}) => new AppError('validation', message, { code, details });

/** Rows of a tabular file for each definition object whose columns it holds. */
function tabularRows(bytes: Buffer, contentType: string, doc: DefinitionDocument, filename: string): { object: string; fields: Field[]; rows: Row[] }[] {
  // An Excel workbook's first sheet reads like a CSV; its numbers in date fields are serial dates.
  const workbook = sniff(bytes, filename).kind === 'workbook' ? parseWorkbook(bytes) : undefined;
  const { header, rows } = workbook ?? parseDelimited(bytes, contentType === 'text/tab-separated-values' ? '\t' : ',');
  const typed = (text: string, type: Field['type']) => (workbook !== undefined && (type === 'date' || type === 'timestamp')
    ? fromSerial(text, workbook.dateSystem, type) ?? cellValue(text, type) : cellValue(text, type));
  const out: { object: string; fields: Field[]; rows: Row[] }[] = [];
  for (const o of doc.objects) {
    const fields = o.fields.filter((f) => f.extraction.kind === 'column');
    if (fields.length === 0 || fields.some((f) => !header.includes((f.extraction as { column: string }).column))) continue;
    out.push({
      object: o.name, fields,
      rows: rows.map((r, index) => {
        const values: Record<string, unknown> = {};
        for (const f of fields) {
          const value = typed(r[(f.extraction as { column: string }).column] ?? '', f.type);
          // Named by row and field, never by value.
          if (value === undefined) throw fail('import.cell_type', `row ${index + 1}: ${f.name} is not a ${f.type}`, { row: index + 1, field: f.name });
          values[f.name] = value;
        }
        const identifier = o.identifier === undefined ? undefined : values[o.identifier];
        return { rowRef: identifier === undefined || identifier === null ? `r${index + 1}` : String(identifier), values, extraction: {} };
      }),
    });
  }
  if (out.length === 0) throw fail('import.columns_missing', 'no definition object\'s columns are all in the file\'s header');
  return out;
}

/** The model's answer for a document: rows per object, each field with its value, location and score. */
const OUTPUT = {
  name: 'document_rows',
  schema: {
    type: 'object', required: ['rows'],
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object', required: ['object', 'fields'],
          properties: {
            object: { type: 'string' },
            fields: {
              type: 'object',
              additionalProperties: {
                type: 'object', required: ['value'],
                properties: { value: {}, location: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 } },
              },
            },
          },
        },
      },
    },
  },
};

function instructionsOf(doc: DefinitionDocument): string {
  const lines = ['Read the document and return its rows as JSON. For each field give its value, where in the document it was read '
    + '(page, cell or offset) as location, and your confidence from 0 to 1. Leave out a field the document does not hold.'];
  for (const o of doc.objects) {
    lines.push(`Object "${o.name}":`);
    for (const f of o.fields) {
      const how = f.extraction.kind === 'label' ? `the field labelled "${f.extraction.label}"`
        : f.extraction.kind === 'prose' ? f.extraction.instruction : `the column "${f.extraction.column}"`;
      lines.push(`- ${f.name} (${f.type}): ${how}`);
    }
  }
  return lines.join('\n');
}

export async function documentRows(deps: ImportDeps, ctx: Context, file: SiloFile, bytes: Buffer, doc: DefinitionDocument)
  : Promise<{ rows: { object: string; fields: Field[]; rows: Row[] }[]; extractions: { object: string; row: Row; field: Field; value: unknown; location: string; confidence: number | null; id: string }[] }> {
  const answer = await deps.services.call(extractDocument, {
    body: {
      siloId: file.siloId, fileId: file.id, instructions: instructionsOf(doc), output: OUTPUT,
      document: { mediaType: file.contentType as 'application/pdf', contentBase64: bytes.toString('base64') },
    },
  }, { request: ctx.request, correlationId: ctx.correlationId, timeoutMs: 300_000 });
  const output = answer.output as { rows: { object: string; fields: Record<string, { value: unknown; location?: string; confidence?: number }> }[] };
  const extractions: { object: string; row: Row; field: Field; value: unknown; location: string; confidence: number | null; id: string }[] = [];
  const byObject = new Map<string, { object: string; fields: Field[]; rows: Row[] }>();
  output.rows.forEach((r, index) => {
    const o = doc.objects.find((x) => x.name === r.object);
    if (o === undefined) return;
    const group = byObject.get(o.name) ?? { object: o.name, fields: o.fields, rows: [] };
    byObject.set(o.name, group);
    const row: Row = { rowRef: '', values: {}, extraction: {} };
    for (const f of o.fields) {
      const read = r.fields[f.name];
      if (read === undefined) continue;
      const value = typeof read.value === 'string' ? cellValue(read.value, f.type) : read.value;
      if (value === undefined) continue;
      row.values[f.name] = value;
      const method = f.extraction.kind === 'prose' ? 'inferred' as const : 'near' as const;
      const id = uuidv7();
      row.extraction[f.name] = { method, extractionId: id };
      extractions.push({ object: o.name, row, field: f, value, location: (read.location ?? 'document').slice(0, 500), confidence: read.confidence ?? null, id });
    }
    const identifier = o.identifier === undefined ? undefined : row.values[o.identifier];
    row.rowRef = identifier === undefined || identifier === null ? `p${index + 1}` : String(identifier);
    group.rows.push(row);
  });
  return { rows: [...byObject.values()], extractions };
}

/** A file's rows into its Silo's dataset, in batches named so a retry finds its load. */
async function loadObjects(deps: ImportDeps, ctx: Context, file: SiloFile, definitionVersion: number, objects: { object: string; fields: Field[]; rows: Row[] }[],
  markings: string[], salt = ''): Promise<number> {
  let rows = 0;
  for (const o of objects) {
    for (let i = 0; i < o.rows.length; i += deps.loadRows) {
      const batch = o.rows.slice(i, i + deps.loadRows);
      const key = createHash('sha256').update(`${salt}${file.id}\u0000${definitionVersion}\u0000${o.object}\u0000${i}`).digest('hex').slice(0, 40);
      await deps.services.call(loadImportRows, {
        body: {
          siloId: file.siloId, fileId: file.id, definitionVersion, receivedAt: file.receivedAt, object: o.object,
          fields: o.fields.map((f) => ({ name: f.name, type: f.type, extracted: f.extraction.kind !== 'column' })),
          rows: batch as never, markingIds: markings,
        },
      }, { request: ctx.request, correlationId: ctx.correlationId, idempotencyKey: key });
      rows += batch.length;
    }
  }
  return rows;
}

/**
 * An Import Silo's rows rebuilt in this cell's dataset after the organisation moved here (spec
 * 6.4; D212): its files and extractions came with it, its dataset did not. Each processed file
 * is loaded again: a tabular file read again from its moved bytes; a document's rows from its
 * stored extractions, opened under the organisation's moved keys, so no model is called and
 * nothing is charged again. A person's confirmation stays: a confirmed value is loaded certain.
 */
export async function rebuildImportSilo(deps: ImportDeps, ctx: Context, siloId: string): Promise<{ files: number; rows: number }> {
  const pool = deps.databases.pool('control');
  const loaded = await inTransaction(pool, ctx.request, async (db) => {
    const silo = await siloRepo.findById(db, siloId);
    if (silo === undefined || silo.kind !== 'import') throw new AppError('not_found', 'no such Import Silo', { code: 'siloes.not_found' });
    const files = (await siloFileRepo.listForSilo(db, siloId)).filter((f) => f.status === 'processed' && f.contentClass !== 'asset_model' && f.contentClass !== 'site_plan');
    const definitions = new Map<string, { version: number; document: DefinitionDocument }>();
    for (const f of files) {
      if (definitions.has(f.sourceId)) continue;
      const source = await siloSourceRepo.findById(db, f.sourceId);
      const definition = source?.definitionId == null ? undefined : await siloDefinitionRepo.findById(db, source.definitionId);
      if (definition !== undefined) definitions.set(f.sourceId, { version: definition.version, document: definition.document as DefinitionDocument });
    }
    const markings = (await resourceMarkingRepo.markingsFor(db, 'silo', [siloId])).map((m) => m.markingId);
    return { silo, files, definitions, markings };
  }, { readOnly: true });
  if (loaded.silo.status === 'purging' || loaded.silo.disabledAt !== null) return { files: 0, rows: 0 };
  let files = 0;
  let rows = 0;
  for (const file of loaded.files) {
    const definition = loaded.definitions.get(file.sourceId);
    if (definition === undefined) continue;
    const objects = file.contentClass === 'tabular'
      ? tabularRows(await deps.store.get('siloes', file.objectStoreKey as ObjectKey), file.contentType, definition.document, file.filename)
      : await rowsFromExtractions(deps, ctx, file, definition.document);
    rows += await loadObjects(deps, ctx, file, definition.version, objects, loaded.markings, 'rebuild\u0000');
    files += 1;
  }
  return { files, rows };
}

/** A document's rows from its stored extractions: the latest of each field, opened, by row. */
async function rowsFromExtractions(deps: ImportDeps, ctx: Context, file: SiloFile, doc: DefinitionDocument): Promise<{ object: string; fields: Field[]; rows: Row[] }[]> {
  const all = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => siloExtractionRepo.listForFile(db, file.id), { readOnly: true });
  const latest = new Map<string, (typeof all)[number]>();
  for (const e of all) if (!latest.has(`${e.object}\u0000${e.rowRef}\u0000${e.field}`)) latest.set(`${e.object}\u0000${e.rowRef}\u0000${e.field}`, e);
  const extractions = [...latest.values()];
  const opened: unknown[] = [];
  for (let i = 0; i < extractions.length; i += 5_000) {
    const chunk = extractions.slice(i, i + 5_000);
    const out = await deps.services.call(openRecordValues, {
      body: { items: chunk.map((e) => ({ binding: extractionBinding(e), sealed: e.value.toString('base64') })) },
    }, { request: ctx.request, correlationId: ctx.correlationId });
    opened.push(...out.items.map((v) => JSON.parse(Buffer.from(v, 'base64').toString('utf8')) as unknown));
  }
  const byObject = new Map<string, { object: string; fields: Field[]; rows: Map<string, Row> }>();
  extractions.forEach((e, i) => {
    const o = doc.objects.find((x) => x.name === e.object);
    const field = o?.fields.find((f) => f.name === e.field);
    if (o === undefined || field === undefined) return;
    const group = byObject.get(o.name) ?? { object: o.name, fields: o.fields, rows: new Map<string, Row>() };
    byObject.set(o.name, group);
    const row = group.rows.get(e.rowRef) ?? { rowRef: e.rowRef, values: {}, extraction: {} };
    group.rows.set(e.rowRef, row);
    row.values[e.field] = opened[i];
    row.extraction[e.field] = { method: e.confirmedAt !== null ? 'certain' : e.method, extractionId: e.id };
  });
  return [...byObject.values()].map((g) => ({ object: g.object, fields: g.fields, rows: [...g.rows.values()] }));
}

/** Processes one received file; its outcome is recorded either way. */
export async function processFile(deps: ImportDeps, organisationId: string, fileId: string, correlationId: string): Promise<void> {
  const pool = deps.databases.pool('control');
  const ctx: Context = { request: { organisationId }, correlationId };
  const loaded = await inTransaction(pool, ctx.request, async (db) => {
    const file = await siloFileRepo.findById(db, fileId);
    if (file === undefined || file.status !== 'received') return undefined;
    const silo = await siloRepo.findById(db, file.siloId);
    const source = await siloSourceRepo.findById(db, file.sourceId);
    const definition = source?.definitionId == null ? undefined : await siloDefinitionRepo.findById(db, source.definitionId);
    const markings = (await resourceMarkingRepo.markingsFor(db, 'silo', [file.siloId])).map((m) => m.markingId);
    return { file, silo: silo!, definition, markings };
  }, { readOnly: true });
  if (loaded === undefined || loaded.silo.status === 'purging' || loaded.silo.disabledAt !== null) return;
  const { file, definition, markings } = loaded;
  let stage = 'read';
  try {
    let objects: { object: string; fields: Field[]; rows: Row[] }[] = [];
    let flagged = 0;
    if (file.contentClass !== 'asset_model' && file.contentClass !== 'site_plan') {
      if (definition === undefined) throw fail('import.no_definition', 'the file\'s source has no definition to read it by');
      const doc = definition.document as DefinitionDocument;
      const bytes = await deps.store.get('siloes', file.objectStoreKey as ObjectKey);
      if (file.contentClass === 'tabular') {
        stage = 'tabular';
        objects = tabularRows(bytes, file.contentType, doc, file.filename);
      } else {
        stage = 'extraction';
        if (!definition.requiresModel) throw fail('import.document_needs_fields', 'a document is read by labelled or prose fields, and this definition has none');
        const read = await documentRows(deps, ctx, file, bytes, doc);
        objects = read.rows;
        flagged = read.extractions.length;
        if (read.extractions.length > 0) {
          const sealed = await deps.services.call(sealRecordValues, {
            body: {
              items: read.extractions.map((e) => ({
                binding: extractionBinding({ organisationId, fileId: file.id, object: e.object, rowRef: e.row.rowRef, field: e.field.name }),
                value: Buffer.from(JSON.stringify(e.value ?? null), 'utf8').toString('base64'),
              })),
            },
          }, { request: ctx.request, correlationId });
          await inTransaction(pool, ctx.request, async (db) => {
            for (const [i, e] of read.extractions.entries()) {
              await siloExtractionRepo.insert(db, {
                id: e.id, organisationId, fileId: file.id, object: e.object, rowRef: e.row.rowRef, field: e.field.name,
                value: Buffer.from(sealed.items[i]!, 'base64'), method: e.row.extraction[e.field.name]!.method,
                confidence: e.confidence === null ? null : e.confidence.toFixed(3), rawTextRef: e.location,
              });
            }
            await recordEvent(db, ctx.request, correlationId, {
              event: 'extraction_flagged', resource: { type: 'silo', id: file.siloId }, detail: { file_id: file.id, values: read.extractions.length }, service: 'siloes-import',
            });
          });
        }
      }
      stage = 'load';
      await loadObjects(deps, ctx, file, definition.version, objects, markings);
    }
    await inTransaction(pool, ctx.request, async (db) => {
      await siloFileRepo.update(db, file.id, { status: 'processed', processedAt: new Date(deps.now()).toISOString() });
      await recordEvent(db, ctx.request, correlationId, {
        event: 'file_processed', resource: { type: 'silo', id: file.siloId },
        detail: { file_id: file.id, objects: objects.length, rows: objects.reduce((n, o) => n + o.rows.length, 0), flagged }, service: 'siloes-import',
      });
    });
  } catch (error) {
    const code = isAppError(error) ? error.code : 'import.failed';
    await inTransaction(pool, ctx.request, async (db) => {
      await siloFileRepo.update(db, file.id, { status: 'failed', errorStage: `${stage}:${code}`.slice(0, 200) });
      await recordEvent(db, ctx.request, correlationId, {
        event: 'file_failed', resource: { type: 'silo', id: file.siloId }, detail: { file_id: file.id, stage, code }, service: 'siloes-import',
      });
    });
    deps.logger.failure('an Import file was not processed; it is marked failed', error, { event: 'import.file_failed', organisationId });
  }
}

/** The processing pass: every received file, oldest first. */
export async function processReceived(deps: ImportDeps, correlationId: string): Promise<number> {
  const queued = await inTransaction(deps.databases.pool('control'), {}, (db) => siloFileRepo.toProcess(db, 50), { readOnly: true });
  for (const f of queued) await processFile(deps, f.organisationId, f.id, correlationId);
  return queued.length;
}

/** Watched locations (68.1): what was dropped since the last poll is taken in, as the source's creator. */
export async function pollWatched(deps: ImportDeps, correlationId: string): Promise<number> {
  const pool = deps.databases.pool('control');
  const due = await inTransaction(pool, {}, (db) => siloSourceRepo.watchedDue(db, 50), { readOnly: true });
  let taken = 0;
  for (const d of due) {
    const source = (await inTransaction(pool, { organisationId: d.organisationId }, (db) => siloSourceRepo.findById(db, d.id), { readOnly: true }))!;
    const ctx: Context = { request: { organisationId: d.organisationId, membershipId: source.createdBy }, correlationId };
    try {
      for (const key of await deps.store.list('siloes', source.location as ObjectKey, 100)) {
        const bytes = await deps.store.get('siloes', key);
        // The dropped name is untrusted: shown to people, never used in a key.
        await storeFile(deps, ctx, source, { filename: (key.split('/').at(-1) ?? 'file').slice(0, 255), bytes });
        await deps.store.delete('siloes', key);
        taken += 1;
      }
    } catch (error) {
      deps.logger.failure('a watched location could not be polled', error, { event: 'import.watch_failed', organisationId: d.organisationId });
    }
    await inTransaction(pool, ctx.request, (db) => siloSourceRepo.update(db, source.id, { lastPolledAt: new Date(deps.now()).toISOString() }));
  }
  return taken;
}

/** Import files' metering (68.8, 74.1): bytes held in object storage per Import Silo. */
export async function meterImportFiles(deps: ImportDeps & { intervalSeconds: number; pricePerGibMonth: string }, correlationId: string): Promise<number> {
  const pool = deps.databases.pool('control');
  const siloes = (await inTransaction(pool, {}, (db) => siloRepo.liveAcrossCell(db, 100_000), { readOnly: true })).filter((s) => s.kind === 'import');
  let measured = 0;
  for (const s of siloes) {
    const scope = { organisationId: s.organisationId };
    const silo = (await inTransaction(pool, scope, (db) => siloRepo.findById(db, s.id), { readOnly: true }))!;
    measured += (await measureStore(deps, s.organisationId, {
      silo, store: 'gcs', pricePerGibMonth: deps.pricePerGibMonth, pricePerTib: '0',
      bytesHeld: async () => BigInt(await inTransaction(pool, scope, (db) => siloFileRepo.bytesHeld(db, s.id), { readOnly: true })),
      bytesScanned: async (windows) => windows.map(() => 0n),
    }, correlationId).catch(() => [])).length;
  }
  return measured;
}
