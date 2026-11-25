// import-loader (catalogue: Siloes Import storage; spec 68.6, 68.4; design: Import rows in
// bq-siloes): the rows siloes-import extracted from a file, loaded into the Import Silo's
// BigQuery dataset, one table per definition object.
//
// - Rows arrive with every value's extraction method where it is not certain: a near or
//   inferred value keeps its method and the extraction row it came from (68.4), so the
//   flag travels with the value into every representation.
// - Loads are batch load jobs, never streaming inserts: a purge must be able to delete at
//   once, and rows in the streaming buffer cannot be deleted by DML for a while (design).
// - Idempotent: a retried load replays its job; a file loaded again (a new definition
//   version, a re-extraction) replaces that file's rows in the object's table.
// - Purging a file deletes its rows from every table of the Silo (catalogue: import-loader).
//
// Values are record values in flight: never logged, never on bus-durable, never in an
// error. Errors name fields and rows by their position, never a value.

import { z } from 'zod';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';

export const IMPORT_FIELD_TYPES = ['string', 'integer', 'decimal', 'boolean', 'date', 'timestamp', 'json'] as const;
export type ImportFieldType = (typeof IMPORT_FIELD_TYPES)[number];

/** A column name: BigQuery's rule, and never the leading underscore system columns use. */
/** obj__<object>: lower-cased, anything else an underscore, at most 64 characters (design: Import rows in bq-siloes). */
export function importTableOf(object: string): string {
  const name = object.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `obj__${name.length === 0 ? 'object' : name}`.slice(0, 64);
}

export const importFieldName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'must be lower-case letters, digits and underscores, starting with a letter')
  .refine((n) => !n.includes('__'), 'a double underscore is reserved for the method and extraction columns');

const siloRef = z.strictObject({ siloId: z.uuid() });
const receivedAt = z.iso.datetime({ offset: true });

export const loadImportRows = defineContract({
  service: 'import-loader', name: 'loadImportRows', method: 'POST', path: '/v1/loads',
  callers: ['siloes-import'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    siloId: z.uuid(),
    fileId: z.uuid(),
    /** siloes.silo_definitions.version the rows were extracted under. */
    definitionVersion: z.int().min(1),
    /** siloes.silo_files.received_at: the partition the rows land in, and how a purge finds them. */
    receivedAt,
    /** The definition object the rows belong to: one table per object. */
    object: z.string().min(1).max(128),
    fields: z.array(z.strictObject({
      name: importFieldName,
      type: z.enum(IMPORT_FIELD_TYPES),
      /** True when any value of the field may be near or inferred: the table carries its method columns. */
      extracted: z.boolean().default(false),
    })).min(1).max(500),
    rows: recordValue(z.array(z.strictObject({
      /** Key of the row; equals siloes.silo_extractions.row_ref for provenance. */
      rowRef: z.string().min(1).max(256),
      values: z.record(importFieldName, z.json()),
      /** Fields of this row read as near or inferred, with the extraction that holds the flag. */
      // certain: an extraction a person confirmed, as a Silo rebuilt after a move reloads it (D212).
      extraction: z.record(importFieldName, z.strictObject({ method: z.enum(['near', 'inferred', 'certain']), extractionId: z.uuid() })).default({}),
    })).min(1).max(100_000)),
    /** Markings propagated from the file and object type (66.10); the engine applies them at read. */
    markingIds: z.array(z.uuid()).max(64).default([]),
  }),
  response: z.object({
    dataset: z.string(),
    table: z.string(),
    jobId: z.string(),
    rowsLoaded: z.int().min(0),
    /** A retry of a load that already ran: nothing was written again. */
    replayed: z.boolean(),
    /** Columns added to the table for fields it did not yet have. */
    addedColumns: z.array(z.string()),
  }),
  status: 201,
  maxBodyBytes: 16 * 1024 * 1024,
});

export const purgeImportFile = defineContract({
  service: 'import-loader', name: 'purgeImportFile', method: 'POST', path: '/v1/files/:fileId/purge',
  callers: ['siloes-import', 'siloes-capture'],
  // Deleting what is already gone deletes nothing: a retry is harmless.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ fileId: z.uuid() }),
  body: siloRef.extend({ receivedAt }),
  response: z.object({ tables: z.int().min(0), rowsDeleted: z.int().min(0) }),
});

/** A person confirmed extracted values (68.4): their method becomes certain, in step with silo_extractions. */
export const confirmImportValues = defineContract({
  service: 'import-loader', name: 'confirmImportValues', method: 'POST', path: '/v1/confirmations',
  callers: ['siloes-import'],
  context: 'organisation', idempotency: 'none',
  body: siloRef.extend({
    fileId: z.uuid(),
    receivedAt,
    object: z.string().min(1).max(128),
    confirmations: z.array(z.strictObject({ rowRef: z.string().min(1).max(256), field: importFieldName })).min(1).max(1_000),
  }),
  response: z.object({ rowsUpdated: z.int().min(0) }),
});

/** The retention sweep (70.1): rows received before the cutoff leave every table of the Silo. */
export const dropExpiredImportRows = defineContract({
  service: 'import-loader', name: 'dropExpiredImportRows', method: 'POST', path: '/v1/retention',
  callers: ['siloes-import', 'siloes-capture'],
  context: 'organisation', idempotency: 'none',
  body: siloRef.extend({ receivedBefore: receivedAt }),
  response: z.object({ tables: z.int().min(0), rowsDeleted: z.int().min(0) }),
});

/** Purge object (70.2): an imported object's rows within the Silo; its table goes. */
export const purgeImportObject = defineContract({
  service: 'import-loader', name: 'purgeImportObject', method: 'POST', path: '/v1/objects/purge',
  callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  body: siloRef.extend({ object: z.string().min(1).max(128) }),
  response: z.object({ table: z.string(), rowsDeleted: z.int().min(0), dropped: z.boolean() }),
});

/** Purging the Silo: its dataset goes, every table with it. */
export const dropImportDataset = defineContract({
  service: 'import-loader', name: 'dropImportDataset', method: 'POST', path: '/v1/datasets/purge',
  callers: ['siloes-import', 'siloes-capture'],
  context: 'organisation', idempotency: 'none',
  body: siloRef,
  response: z.object({ dataset: z.string(), dropped: z.boolean() }),
});
