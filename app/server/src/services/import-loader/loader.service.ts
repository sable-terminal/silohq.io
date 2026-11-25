// import-loader (catalogue: Siloes Import storage; spec 68.4, 68.6; design: Import rows in
// bq-siloes): the rows siloes-import extracted from a file, held in the Import Silo's
// BigQuery dataset, one table per definition object.
//
// - The dataset is the Silo's store_ref (imp_<org12>_<silo12>), in the cell's siloes
//   project and region, with the 48-hour time travel window (design: purge fail-safe). The
//   loader makes it on the first load and drops it when the Silo is purged.
// - Rows are written by a batch load job, never a streaming insert, so a purge deletes them
//   at once. The job is named from the request's idempotency key: a retry finds its job.
// - A file loaded again replaces its rows: under a new definition version every earlier row
//   of the file in that table goes; under the same version, rows with the same row refs are
//   replaced, so a file loaded in several parts keeps its other parts.
// - A field read near or inferred carries its method and extraction id beside the value
//   (68.4); confirming sets the method to certain in step with silo_extractions.
// Values are record values in flight: never logged, never in an error. Errors name fields
// and rows by position only.

import { createHash } from 'node:crypto';
import { importTableOf, type ImportFieldType } from '../../contracts/import-loader/load.contract.ts';
import type { BigQueryAdapter, DatasetRef, QueryOptions } from '../../infra/bigquery.infra.ts';
import { labelValue } from '../../infra/bigquery.infra.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { Silo } from '../../models/siloes/index.model.ts';
import { siloFileRepo, siloRepo } from '../../repos/siloes/index.repo.ts';
import { canonicalTimestamp } from '../../utils/time.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import {
  confirmMethod, createImportTable, deleteFileRows, deleteReceivedBefore, extractionColumns, IMPORT_COLUMN_TYPE, IMPORT_SYSTEM_COLUMNS,
  replaceFileRows,
} from '../warehouse-schema/generator/import.generator.ts';
import { dropTable } from '../warehouse-schema/generator/index.generator.ts';
import { addColumns, type Column, type ColumnType } from '../warehouse-schema/generator/warehouse.generator.ts';
import { existingColumns } from '../warehouse-schema/warehouse.service.ts';

export interface LoaderDeps {
  databases: Databases;
  logger: Logger;
  bigQuery: BigQueryAdapter;
  /** The cell's siloes project: Import datasets live here. */
  projectId: string;
  /** Rows one load may carry (IMPORT_LOADER_MAX_ROWS). */
  maxRows: number;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'idempotencyKey'>;

const TABLE_PREFIX = 'obj__';
const TIME_TRAVEL_HOURS = 48;

export { importTableOf };

const options = (silo: Pick<Silo, 'id' | 'organisationId'>): QueryOptions => ({
  labels: { organisation: silo.organisationId, service: 'import-loader', purpose: 'import_load', silo: silo.id },
});

/** The Import Silo and its dataset. A Silo of another kind, or one without a dataset name, is refused. */
async function importSilo(deps: LoaderDeps, ctx: Context, siloId: string): Promise<{ silo: Silo; ref: DatasetRef }> {
  const silo = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => siloRepo.findById(db, siloId), { readOnly: true });
  if (silo === undefined) throw new AppError('not_found', 'no such Silo', { code: 'import.silo_not_found' });
  if (silo.kind !== 'import') throw new AppError('validation', 'rows load into an Import Silo only', { code: 'import.not_import' });
  if (silo.storeRef === null) throw new AppError('integrity', 'the Silo has no dataset name', { code: 'import.no_dataset' });
  return { silo, ref: { projectId: deps.projectId, dataset: silo.storeRef } };
}

// ----------------------------------------------------------------------------- values

const INTEGER = /^-?\d{1,19}$/;
const DECIMAL = /^-?\d{1,29}(\.\d{1,9})?$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** A value as its column loads it, or undefined when it is not of the field's type. */
function loadable(value: unknown, type: ImportFieldType): unknown {
  if (value === null) return null;
  switch (type) {
    case 'string': return typeof value === 'string' ? value : undefined;
    case 'integer':
      if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
      return typeof value === 'string' && INTEGER.test(value) ? value : undefined;
    case 'decimal':
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
      return typeof value === 'string' && DECIMAL.test(value) ? value : undefined;
    case 'boolean': return typeof value === 'boolean' ? value : undefined;
    case 'date': return typeof value === 'string' && DATE.test(value) ? value : undefined;
    case 'timestamp': {
      if (typeof value !== 'string') return undefined;
      try {
        return canonicalTimestamp(value);
      } catch {
        return undefined;
      }
    }
    case 'json': return value;
  }
}

export interface LoadInput {
  siloId: string;
  fileId: string;
  definitionVersion: number;
  receivedAt: string;
  object: string;
  fields: { name: string; type: ImportFieldType; extracted: boolean }[];
  rows: { rowRef: string; values: Record<string, unknown>; extraction: Record<string, { method: 'near' | 'inferred' | 'certain'; extractionId: string }> }[];
  markingIds: string[];
}

export interface LoadOutcome {
  dataset: string;
  table: string;
  jobId: string;
  rowsLoaded: number;
  replayed: boolean;
  addedColumns: string[];
}

export async function loadRows(deps: LoaderDeps, ctx: Context, input: LoadInput): Promise<LoadOutcome> {
  if (input.rows.length > deps.maxRows) {
    throw new AppError('bounds', 'a load carries more rows than one request may', {
      code: 'import.too_many_rows', details: { bound: 'IMPORT_LOADER_MAX_ROWS', limit: deps.maxRows },
    });
  }
  const { silo, ref } = await importSilo(deps, ctx, input.siloId);
  if (silo.status === 'purging' || silo.status === 'disabled') {
    throw new AppError('conflict', 'the Silo no longer takes rows', { code: 'import.silo_closed' });
  }
  const receivedAt = canonicalTimestamp(input.receivedAt);
  const file = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => siloFileRepo.findById(db, input.fileId), { readOnly: true });
  if (file === undefined || file.siloId !== silo.id || file.status === 'purged' || canonicalTimestamp(file.receivedAt) !== receivedAt) {
    throw new AppError('validation', 'the rows name no live file of this Silo', { code: 'import.file_unknown' });
  }
  const names = new Set<string>();
  for (const f of input.fields) {
    if (names.has(f.name)) throw new AppError('validation', `the field ${f.name} is declared twice`, { code: 'import.field_repeated', details: { field: f.name } });
    names.add(f.name);
  }

  // The rows, checked field by field; an error names the row and field, never the value.
  const loadedAt = new Date().toISOString();
  const byName = new Map(input.fields.map((f) => [f.name, f]));
  const rows = input.rows.map((row, index) => {
    const out: Record<string, unknown> = {
      _row_ref: row.rowRef, _file_id: input.fileId, _silo_id: silo.id, _definition_version: input.definitionVersion,
      _received_at: receivedAt, _loaded_at: loadedAt, _marking_ids: input.markingIds,
    };
    for (const [name, value] of Object.entries(row.values)) {
      const field = byName.get(name);
      if (field === undefined) throw new AppError('validation', `row ${index} has a value for an undeclared field`, { code: 'import.field_unknown', details: { row: index, field: name } });
      const bound = loadable(value, field.type);
      if (bound === undefined) {
        throw new AppError('validation', `row ${index}: ${name} is not a ${field.type}`, { code: 'import.value_type', details: { row: index, field: name, type: field.type } });
      }
      out[name] = bound;
    }
    for (const [name, flag] of Object.entries(row.extraction)) {
      if (byName.get(name)?.extracted !== true) {
        throw new AppError('validation', `row ${index}: ${name} is flagged but not declared as extracted`, { code: 'import.extraction_undeclared', details: { row: index, field: name } });
      }
      out[`${name}__method`] = flag.method;
      out[`${name}__extraction_id`] = flag.extractionId;
    }
    for (const f of input.fields) {
      if (f.extracted && out[`${f.name}__method`] === undefined) out[`${f.name}__method`] = 'certain';
    }
    return out;
  });

  // The dataset and the table, brought level with the declared fields.
  await deps.bigQuery.ensureDataset(ref, {
    maxTimeTravelHours: TIME_TRAVEL_HOURS, labels: { organisation: labelValue(silo.organisationId), service: 'import-loader', silo: labelValue(silo.id) },
  });
  const tableName = importTableOf(input.object);
  const wanted: Column[] = [
    ...IMPORT_SYSTEM_COLUMNS,
    ...input.fields.flatMap((f): Column[] => [{ name: f.name, type: IMPORT_COLUMN_TYPE[f.type] }, ...(f.extracted ? extractionColumns(f.name) : [])]),
  ];
  const info = await deps.bigQuery.getTable({ ...ref, table: tableName });
  let addedColumns: string[] = [];
  if (info === undefined) {
    await deps.bigQuery.run(ref, createImportTable(ref, tableName, wanted), options(silo));
  } else {
    const existing = existingColumns(info);
    for (const c of wanted) {
      const had = existing.get(c.name);
      if (existing.has(c.name) && had !== (c.type as ColumnType)) {
        throw new AppError('validation', `the field ${c.name} changed type; declare it under a new name`, { code: 'import.field_type_changed', details: { field: c.name } });
      }
    }
    const missing = wanted.filter((c) => !existing.has(c.name));
    if (missing.length > 0) {
      await deps.bigQuery.run(ref, addColumns(ref, tableName, missing), options(silo));
      addedColumns = missing.map((c) => c.name);
    }
  }

  // The file's earlier rows this load replaces, then the load.
  await deps.bigQuery.run(ref, replaceFileRows(ref, tableName, input.fileId, receivedAt, input.definitionVersion, input.rows.map((r) => r.rowRef)), options(silo));
  const key = ctx.idempotencyKey ?? `${input.fileId}:${input.definitionVersion}:${loadedAt}`;
  const jobId = `silo_import_${createHash('sha256').update(`${silo.organisationId}\u0000${key}\u0000${tableName}`).digest('hex').slice(0, 40)}`;
  const loaded = await deps.bigQuery.loadRows({ ...ref, table: tableName }, { jobId, rows });
  return { dataset: ref.dataset, table: tableName, jobId: loaded.jobId, rowsLoaded: loaded.rowsLoaded, replayed: loaded.replayed, addedColumns };
}

/** The result reference kept with the idempotency key: names and a count, never a value. */
export const loadRef = (out: LoadOutcome): string => [out.dataset, out.table, out.jobId, String(out.rowsLoaded)].join('.');

export function replayLoad(ref: string | undefined): LoadOutcome {
  const [dataset, table, jobId, rows] = (ref ?? '').split('.');
  if (dataset === undefined || table === undefined || jobId === undefined || rows === undefined) {
    throw new AppError('integrity', 'the earlier load left no reference', { code: 'import.replay_missing' });
  }
  return { dataset, table, jobId, rowsLoaded: Number(rows), replayed: true, addedColumns: [] };
}

async function importTables(deps: LoaderDeps, ref: DatasetRef): Promise<string[]> {
  if (await deps.bigQuery.getDataset(ref) === undefined) return [];
  return (await deps.bigQuery.listTables(ref)).filter((t) => t.startsWith(TABLE_PREFIX));
}

/** Purging a file deletes its rows from every table of the Silo (catalogue). */
export async function purgeFile(deps: LoaderDeps, ctx: Context, input: { siloId: string; fileId: string; receivedAt: string })
  : Promise<{ tables: number; rowsDeleted: number }> {
  const { silo, ref } = await importSilo(deps, ctx, input.siloId);
  const receivedAt = canonicalTimestamp(input.receivedAt);
  let rowsDeleted = 0;
  const tables = await importTables(deps, ref);
  for (const t of tables) {
    rowsDeleted += (await deps.bigQuery.run(ref, deleteFileRows(ref, t, input.fileId, receivedAt), options(silo))).affectedRows ?? 0;
  }
  return { tables: tables.length, rowsDeleted };
}

/** The retention sweep (70.1): rows received before the cutoff leave every table. */
export async function dropExpired(deps: LoaderDeps, ctx: Context, input: { siloId: string; receivedBefore: string })
  : Promise<{ tables: number; rowsDeleted: number }> {
  const { silo, ref } = await importSilo(deps, ctx, input.siloId);
  const before = canonicalTimestamp(input.receivedBefore);
  let rowsDeleted = 0;
  const tables = await importTables(deps, ref);
  for (const t of tables) rowsDeleted += (await deps.bigQuery.run(ref, deleteReceivedBefore(ref, t, before), options(silo))).affectedRows ?? 0;
  return { tables: tables.length, rowsDeleted };
}

/** Confirmed values (68.4): their method becomes certain. A field without a method column is refused. */
export async function confirmValues(deps: LoaderDeps, ctx: Context, input: {
  siloId: string; fileId: string; receivedAt: string; object: string; confirmations: { rowRef: string; field: string }[];
}): Promise<{ rowsUpdated: number }> {
  const { silo, ref } = await importSilo(deps, ctx, input.siloId);
  const tableName = importTableOf(input.object);
  const columns = existingColumns(await deps.bigQuery.getTable({ ...ref, table: tableName }));
  const byField = new Map<string, string[]>();
  for (const c of input.confirmations) byField.set(c.field, [...(byField.get(c.field) ?? []), c.rowRef]);
  for (const field of byField.keys()) {
    if (!columns.has(`${field}__method`)) {
      throw new AppError('validation', `${field} carries no extraction method to confirm`, { code: 'import.not_extracted', details: { field } });
    }
  }
  const receivedAt = canonicalTimestamp(input.receivedAt);
  let rowsUpdated = 0;
  for (const [field, rowRefs] of byField) {
    rowsUpdated += (await deps.bigQuery.run(ref, confirmMethod(ref, tableName, field, input.fileId, receivedAt, [...new Set(rowRefs)]), options(silo)))
      .affectedRows ?? 0;
  }
  return { rowsUpdated };
}

/** Purge object (70.2): every row of an imported object within the Silo; its table goes. */
export async function purgeObject(deps: LoaderDeps, ctx: Context, siloId: string, object: string): Promise<{ table: string; rowsDeleted: number; dropped: boolean }> {
  const { silo, ref } = await importSilo(deps, ctx, siloId);
  const table = importTableOf(object);
  if (await deps.bigQuery.getDataset(ref) === undefined) return { table, rowsDeleted: 0, dropped: false };
  const info = await deps.bigQuery.getTable({ ...ref, table });
  if (info === undefined) return { table, rowsDeleted: 0, dropped: false };
  await deps.bigQuery.run(ref, dropTable(ref, table), options(silo));
  return { table, rowsDeleted: info.rows, dropped: true };
}

/** Purging the Silo: its dataset goes, every table with it. */
export async function dropDataset(deps: LoaderDeps, ctx: Context, siloId: string): Promise<{ dataset: string; dropped: boolean }> {
  const { ref } = await importSilo(deps, ctx, siloId);
  const out = await deps.bigQuery.deleteDataset(ref);
  return { dataset: ref.dataset, dropped: out.deleted };
}
