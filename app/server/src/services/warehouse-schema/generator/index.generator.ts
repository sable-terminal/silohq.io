// The Object Index's statements (spec 69.2 to 69.6; design: Object Index documents, the
// BigQuery baseline), rendered like every Silo BigQuery statement: constant text, quoted
// identifiers, every value bound (see warehouse.generator.ts).
//
// One table per live index definition, ix__<object type api name>, in the Silo's dataset
// idx_<org12>_<silo12>:
//   _object_ref, _object_type_id, _index_definition_id;
//   per nominated property its value, <property>__marking_ids (the markings of that
//   property, so a match filters on them without a JSON path) and <property>__state (the
//   value's state as the engine decided it: declared, agreed, only, disputed, empty or
//   unchecked; a disputed value is null, and a filter on it leaves the object out, counted);
//   _marking_ids (the object's markings), _row_hash (values and markings, so an unchanged
//   entry is only re-stamped), _refreshed_at (the partition column, and the freshness every
//   result states), and the lineage columns of the Warehouse.
// It never holds a property that was not nominated, nor a whole source row (69.2).

import type { DatasetRef, WarehouseParameterType, WarehouseStatement } from '../../../infra/bigquery.infra.ts';
import { ident, sql, type SqlFragment } from '../../../utils/sqlBuilder.util.ts';
import { columnSql, LINEAGE_COLUMNS, PARAMETER_TYPE, statement, structType, table, type Column, type ColumnType } from './warehouse.generator.ts';

export const INDEX_KEY: Column = { name: '_object_ref', type: 'STRING', required: true };

export const INDEX_HEAD_COLUMNS: readonly Column[] = [
  INDEX_KEY,
  { name: '_object_type_id', type: 'STRING', required: true },
  { name: '_index_definition_id', type: 'STRING', required: true },
];

export const INDEX_TAIL_COLUMNS: readonly Column[] = [
  { name: '_marking_ids', type: 'ARRAY<STRING>' },
  { name: '_row_hash', type: 'STRING' },
  { name: '_refreshed_at', type: 'TIMESTAMP', required: true },
  ...LINEAGE_COLUMNS,
];

export const markingColumnOf = (column: string): string => `${column}__marking_ids`;
export const stateColumnOf = (column: string): string => `${column}__state`;

/** The columns a nominated property brings: its value, its markings and its state. */
export function indexPropertyColumns(column: string, type: ColumnType): Column[] {
  return [{ name: column, type }, { name: markingColumnOf(column), type: 'ARRAY<STRING>' }, { name: stateColumnOf(column), type: 'STRING' }];
}

export function createIndexTable(ref: DatasetRef, name: string, columns: readonly Column[]): WarehouseStatement {
  return statement(sql`create table if not exists ${table(ref, name)} (${sql.join(columns.map(columnSql), sql`, `)})
    partition by date(${ident('_refreshed_at')}) cluster by ${ident(INDEX_KEY.name)}`);
}

/** A property taken out of the nomination: its column goes, and its values with it (design). */
export function dropColumns(ref: DatasetRef, name: string, columns: readonly string[]): WarehouseStatement {
  const drops = columns.map((c) => sql`drop column if exists ${ident(c)}`);
  return statement(sql`alter table ${table(ref, name)} ${sql.join(drops, sql`, `)}`);
}

export function dropTable(ref: DatasetRef, name: string): WarehouseStatement {
  return statement(sql`drop table if exists ${table(ref, name)}`);
}

/** The stored hash of each entry asked about. */
export function readHashes(ref: DatasetRef, name: string, refs: string[]): WarehouseStatement {
  return statement(sql`select ${ident(INDEX_KEY.name)}, ${ident('_row_hash')} from ${table(ref, name)}
    where ${ident(INDEX_KEY.name)} in unnest(${refs})`, [['STRING']]);
}

/**
 * Writes a refreshed batch: an unchanged entry (same hash) is only re-stamped with this
 * refresh's time, a changed one is rewritten, a new one inserted. The rows are one bound
 * array of structs, typed field by field.
 */
export function mergeEntries(ref: DatasetRef, name: string, columns: readonly Column[], rows: Record<string, unknown>[]): WarehouseStatement {
  const key = ident(INDEX_KEY.name);
  const hash = ident('_row_hash');
  const stamp = ident('_refreshed_at');
  const others = columns.filter((c) => c.name !== INDEX_KEY.name);
  const assignments = others.map((c) => sql`${ident(c.name)} = s.${ident(c.name)}`);
  const names = columns.map((c) => sql`${ident(c.name)}`);
  const sourced = columns.map((c) => sql`s.${ident(c.name)}`);
  return statement(sql`merge ${table(ref, name)} t using unnest(${rows}) s on t.${key} = s.${key}
    when matched and t.${hash} = s.${hash} then update set ${stamp} = s.${stamp}
    when matched then update set ${sql.join(assignments, sql`, `)}
    when not matched then insert (${sql.join(names, sql`, `)}) values (${sql.join(sourced, sql`, `)})`,
  [[structType(columns)]]);
}

/**
 * A change stream's values for existing entries (69.4): one property's value set, the row
 * hash cleared so the next refresh rewrites the entry in full; markings and refresh time stand.
 */
export function updateEntryValues(ref: DatasetRef, name: string, column: Column, rows: { key: string; value: unknown }[]): WarehouseStatement {
  const key = ident(INDEX_KEY.name);
  return statement(sql`merge ${table(ref, name)} t using unnest(${rows}) s on t.${key} = s.${ident('key')}
    when matched then update set ${ident(column.name)} = s.${ident('value')}, ${ident('_row_hash')} = null`,
  [[{ key: 'STRING', value: PARAMETER_TYPE[column.type] }]]);
}

/** A full refresh's last step: entries it did not observe were removed at the source (69.4). */
export function removeUnobserved(ref: DatasetRef, name: string, refreshStartedAt: string): WarehouseStatement {
  return statement(sql`delete from ${table(ref, name)} where ${ident('_refreshed_at')} < ${refreshStartedAt}`, ['TIMESTAMP']);
}

/** A page of an index table's entries, whole, in key order after a key: the organisation export (spec 2.6). */
export function readIndexPage(ref: DatasetRef, name: string, after: string, limit: number): WarehouseStatement {
  return statement(sql`select to_json_string(t) as ${ident('row')}, t.${ident(INDEX_KEY.name)} as ${ident('key')}
    from ${table(ref, name)} t
    where t.${ident(INDEX_KEY.name)} > ${after}
    order by t.${ident(INDEX_KEY.name)} limit ${limit}`,
  ['STRING', 'INT64']);
}

export type EntryOp = 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'is_null' | 'not_null';
export interface EntryFilter { column: string; type: ColumnType; op: EntryOp; value?: unknown }

/**
 * The planner's read of an Object Index (spec 69.6; decision 2026-11-14): the selected
 * columns of the entries matching every filter, among the given keys where a split plan
 * names them, and only entries whose every marking (the object's and each column read's)
 * the reader satisfies. Disputes as the engine treats them, for the columns that record states
 * (`stated`), each returned with its state: an entry whose first unmet filter is disputed comes back flagged
 * `_excluded`, to be counted and left out; a disputed value is never empty. Values bind as
 * parameters typed by their column; the order of the types follows the order the values
 * appear in.
 */
export function selectEntries(ref: DatasetRef, name: string, input: {
  select: readonly string[]; filters: readonly EntryFilter[]; keys: readonly string[] | null; satisfied: readonly string[]; limit: number;
  stated?: readonly string[] | undefined;
}): WarehouseStatement {
  const types: (WarehouseParameterType | undefined)[] = [];
  const disputable = new Set(input.stated ?? []);
  const read = [...new Set([...input.select, ...input.filters.map((f) => f.column)])];
  const markings = sql`array_concat(${ident('_marking_ids')}${sql.join(read.map((c) => sql`, ${ident(markingColumnOf(c))}`), sql``)})`;
  const disputed = (c: string) => (disputable.has(c) ? sql`coalesce(${ident(stateColumnOf(c))} = 'disputed', false)` : sql`false`);
  const tests = input.filters.map((f, i) => {
    const column = ident(f.column);
    let test: SqlFragment;
    if (f.op === 'is_null') test = disputable.has(f.column) ? sql`${column} is null and not ${disputed(f.column)}` : sql`${column} is null`;
    else if (f.op === 'not_null') test = sql`${column} is not null`;
    else if (f.op === 'in') {
      types.push([PARAMETER_TYPE[f.type] as 'STRING']);
      test = sql`${column} in unnest(${f.value as unknown[]})`;
    } else {
      types.push(PARAMETER_TYPE[f.type]);
      const op = { eq: sql`=`, neq: sql`!=`, lt: sql`<`, lte: sql`<=`, gt: sql`>`, gte: sql`>=` }[f.op];
      test = sql`${column} ${op} ${f.value as never}`;
    }
    return sql`, coalesce((${test}), false) as ${ident(`_f${i}`)}, ${disputed(f.column)} as ${ident(`_d${i}`)}`;
  });
  const where: SqlFragment[] = [];
  if (input.keys !== null) {
    types.push(['STRING']);
    where.push(sql`${ident(INDEX_KEY.name)} in unnest(${[...input.keys]})`);
  }
  types.push(['STRING'], 'INT64');
  const met = (i: number) => ident(`_f${i}`);
  const passes = input.filters.length === 0 ? sql`true` : sql.join(input.filters.map((_, i) => sql`${met(i)}`), sql` and `);
  const excluded = input.filters.length === 0 ? sql`false`
    : sql.join(input.filters.map((_, i) => sql`(${ident(`_d${i}`)}${sql.join(input.filters.slice(0, i).map((__, j) => sql` and ${met(j)}`), sql``)})`), sql` or `);
  const selected = input.select.map((c) => (disputable.has(c)
    ? sql`, to_json_string(${ident(c)}) as ${ident(c)}, ${ident(stateColumnOf(c))} as ${ident(stateColumnOf(c))}`
    : sql`, to_json_string(${ident(c)}) as ${ident(c)}`));
  return statement(sql`with f as (select *${sql.join(tests, sql``)} from ${table(ref, name)}
      where ${where.length === 0 ? sql`true` : sql.join(where, sql` and `)}
      and not exists (select 1 from unnest(${markings}) m where m not in unnest(${[...input.satisfied]})))
    select ${ident(INDEX_KEY.name)}${sql.join(selected, sql``)}, (${excluded}) as ${ident('_excluded')},
    format_timestamp('%Y-%m-%dT%H:%M:%E6SZ', ${ident('_refreshed_at')}) as ${ident('refreshed_at')}
    from f where (${passes}) or (${excluded})
    order by ${ident(INDEX_KEY.name)} limit ${input.limit}`, types);
}

/**
 * Entries whose property contains the text (case-insensitive), whose markings (the object's
 * and the property's) are all among those the reader satisfies (69.5: a value a person may
 * not see is never matched, so no hit count reveals it). Each with its value as JSON text and
 * its refresh time.
 */
export function searchEntries(ref: DatasetRef, name: string, column: string, text: string, satisfied: string[], limit: number)
  : WarehouseStatement {
  const value = ident(column);
  const markings = sql`array_concat(${ident('_marking_ids')}, ${ident(markingColumnOf(column))})`;
  return statement(sql`select ${ident(INDEX_KEY.name)}, to_json_string(${value}) as ${ident('value')},
    format_timestamp('%Y-%m-%dT%H:%M:%E6SZ', ${ident('_refreshed_at')}) as ${ident('refreshed_at')}
    from ${table(ref, name)}
    where contains_substr(${value}, ${text})
    and not exists (select 1 from unnest(${markings}) m where m not in unnest(${satisfied}))
    order by ${ident(INDEX_KEY.name)} limit ${limit}`,
  ['STRING', ['STRING'], 'INT64']);
}
