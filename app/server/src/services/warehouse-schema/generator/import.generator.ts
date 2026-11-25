// The Import row store's statements (design: Import rows in bq-siloes; spec 68.4, 68.6),
// rendered like every Silo BigQuery statement: constant text, quoted identifiers, every
// value bound (see warehouse.generator.ts).
//
// One table per definition object, obj__<object>, in the Silo's dataset imp_<org12>_<silo12>:
//   _row_ref, _file_id, _silo_id, _definition_version, _received_at (the partition column),
//   _loaded_at, _marking_ids, then one typed column per declared field, and for a field read
//   near or inferred, <field>__method and <field>__extraction_id, so the flag travels with
//   the value into every representation (68.4).
// Partitioned by day of _received_at with a partition filter required: every statement
// here names _received_at, which is how a purge and the retention sweep find their rows.

import type { DatasetRef, WarehouseStatement } from '../../../infra/bigquery.infra.ts';
import { ident, sql } from '../../../utils/sqlBuilder.util.ts';
import { columnSql, statement, table, type Column, type ColumnType } from './warehouse.generator.ts';

export const IMPORT_SYSTEM_COLUMNS: readonly Column[] = [
  { name: '_row_ref', type: 'STRING', required: true },
  { name: '_file_id', type: 'STRING', required: true },
  { name: '_silo_id', type: 'STRING', required: true },
  { name: '_definition_version', type: 'INT64', required: true },
  { name: '_received_at', type: 'TIMESTAMP', required: true },
  { name: '_loaded_at', type: 'TIMESTAMP', required: true },
  { name: '_marking_ids', type: 'ARRAY<STRING>' },
];

/** The method and extraction columns of a field that may be read near or inferred. */
export function extractionColumns(field: string): Column[] {
  return [{ name: `${field}__method`, type: 'STRING' }, { name: `${field}__extraction_id`, type: 'STRING' }];
}

/** An Import field type's column type. */
export const IMPORT_COLUMN_TYPE: Record<'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp' | 'json', ColumnType> = {
  string: 'STRING', integer: 'INT64', decimal: 'NUMERIC', boolean: 'BOOL', date: 'DATE', timestamp: 'TIMESTAMP', json: 'JSON',
};

export function createImportTable(ref: DatasetRef, name: string, columns: readonly Column[]): WarehouseStatement {
  return statement(sql`create table if not exists ${table(ref, name)} (${sql.join(columns.map(columnSql), sql`, `)})
    partition by date(${ident('_received_at')}) cluster by ${ident('_file_id')}, ${ident('_row_ref')}
    options (require_partition_filter = true)`);
}

/** A file's rows in one table: before a file is loaded again, and at the file's purge. */
export function deleteFileRows(ref: DatasetRef, name: string, fileId: string, receivedAt: string): WarehouseStatement {
  return statement(sql`delete from ${table(ref, name)} where ${ident('_received_at')} = ${receivedAt} and ${ident('_file_id')} = ${fileId}`,
    ['TIMESTAMP', 'STRING']);
}

/**
 * A file loaded again: its rows under another definition version, and rows with the same
 * row refs, give way to the new load. Other parts of a file loaded in several requests stay.
 */
export function replaceFileRows(ref: DatasetRef, name: string, fileId: string, receivedAt: string, definitionVersion: number, rowRefs: string[])
  : WarehouseStatement {
  return statement(sql`delete from ${table(ref, name)} where ${ident('_received_at')} = ${receivedAt} and ${ident('_file_id')} = ${fileId}
    and (${ident('_definition_version')} <> ${definitionVersion} or ${ident('_row_ref')} in unnest(${rowRefs}))`,
  ['TIMESTAMP', 'STRING', 'INT64', ['STRING']]);
}

/** The retention sweep (70.1): whole days of rows received before the cutoff. */
export function deleteReceivedBefore(ref: DatasetRef, name: string, before: string): WarehouseStatement {
  return statement(sql`delete from ${table(ref, name)} where ${ident('_received_at')} < ${before}`, ['TIMESTAMP']);
}

/** Confirmed values (68.4): their method becomes certain, in step with silo_extractions. */
export function confirmMethod(ref: DatasetRef, name: string, field: string, fileId: string, receivedAt: string, rowRefs: string[])
  : WarehouseStatement {
  return statement(sql`update ${table(ref, name)} set ${ident(`${field}__method`)} = ${'certain'}
    where ${ident('_received_at')} = ${receivedAt} and ${ident('_file_id')} = ${fileId} and ${ident('_row_ref')} in unnest(${rowRefs})`,
  ['STRING', 'TIMESTAMP', 'STRING', ['STRING']]);
}
