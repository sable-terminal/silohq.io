// The warehouse generator (spec 69.14; tests/architecture/sql.test.ts): every statement the
// Warehouse runs is rendered here, and beside it every statement of the Import row store
// and the Object Index (import.generator.ts, index.generator.ts), through
// utils/sqlBuilder.util.ts in the bigquery dialect. Text is constant, identifiers are quoted
// by the dialect, every value is bound (@p1...), so Cloud Audit Logs, which record query
// text, never hold a record value. The adapter (infra/bigquery.infra.ts) runs what it is
// given and writes no SQL.
//
// Table shapes (spec 69.14):
//   <type>            silo_object_id, then per nominated property its column, a dispute flag
//                     (<col>__disputed) and the count of sources mapping it (<col>__sources),
//                     then the lineage columns.
//   <type>__history   one row per observed change: object, property, previous and new value
//                     (JSON text), observed at, the connections and the ontology version.
//   <link_type>       one row per link between two nominated objects, with lineage.
// Lineage columns on every row: _connection_ids, _connector_versions, _ontology_version,
// _observed_at. A merged object comes from several systems, so the connections and
// connector versions are lists.

import type { DataType } from '../../../contracts/ontology/manifest.contract.ts';
import type { DatasetRef, WarehouseParameterType, WarehouseStatement } from '../../../infra/bigquery.infra.ts';
import { ident, render, sql, type SqlFragment } from '../../../utils/sqlBuilder.util.ts';

/** The BigQuery column types the Warehouse uses, by name. */
export type ColumnType = 'STRING' | 'INT64' | 'NUMERIC' | 'BOOL' | 'DATE' | 'TIMESTAMP' | 'JSON' | 'ARRAY<STRING>';

// Constant text for each column type: a type is never assembled from a value.
const TYPE_SQL: Record<ColumnType, SqlFragment> = {
  'STRING': sql`STRING`, 'INT64': sql`INT64`, 'NUMERIC': sql`NUMERIC`, 'BOOL': sql`BOOL`, 'DATE': sql`DATE`,
  'TIMESTAMP': sql`TIMESTAMP`, 'JSON': sql`JSON`, 'ARRAY<STRING>': sql`ARRAY<STRING>`,
};

/** The parameter type each column type binds as. */
export const PARAMETER_TYPE: Record<ColumnType, WarehouseParameterType> = {
  'STRING': 'STRING', 'INT64': 'INT64', 'NUMERIC': 'NUMERIC', 'BOOL': 'BOOL', 'DATE': 'DATE', 'TIMESTAMP': 'TIMESTAMP',
  'JSON': 'JSON', 'ARRAY<STRING>': ['STRING'],
};

/** An ontology data type's column type. Composite values are kept as JSON. */
export const COLUMN_TYPE: Record<DataType, ColumnType> = {
  string: 'STRING', integer: 'INT64', decimal: 'NUMERIC', boolean: 'BOOL', date: 'DATE', timestamp: 'TIMESTAMP',
  duration: 'STRING', money: 'JSON', enum: 'STRING', geopoint: 'JSON', geoshape: 'JSON', struct: 'JSON', array: 'JSON',
};

export interface Column {
  name: string;
  type: ColumnType;
  required?: boolean;
}

/** The lineage columns of every row (spec 69.14). */
export const LINEAGE_COLUMNS: readonly Column[] = [
  { name: '_connection_ids', type: 'ARRAY<STRING>' },
  { name: '_connector_versions', type: 'ARRAY<STRING>' },
  { name: '_ontology_version', type: 'STRING' },
  { name: '_observed_at', type: 'TIMESTAMP' },
];

export const ID_COLUMN: Column = { name: 'silo_object_id', type: 'STRING', required: true };

/**
 * When the Warehouse first observed the object (69.6; decision 2026-11-14): written on insert,
 * never updated, so an as-of answer leaves out objects not yet seen at its instant.
 */
export const FIRST_OBSERVED_COLUMN: Column = { name: '_first_observed_at', type: 'TIMESTAMP' };

/**
 * Silo's own bookkeeping on a current row: the hash of each property's value as last
 * written (by API name), so a change is found by comparing Silo's canonical values, never
 * BigQuery's rendering of them, and the history row is written only for a real change.
 */
export const HASHES_COLUMN: Column = { name: '_hashes', type: 'JSON' };

/** The columns a nominated property brings: its value, its dispute flag, its source count. */
export function propertyColumns(column: string, type: ColumnType): Column[] {
  return [{ name: column, type }, { name: `${column}__disputed`, type: 'BOOL' }, { name: `${column}__sources`, type: 'INT64' }];
}

export const HISTORY_COLUMNS: readonly Column[] = [
  ID_COLUMN,
  { name: 'property', type: 'STRING', required: true },
  { name: 'previous_value', type: 'JSON' },
  { name: 'new_value', type: 'JSON' },
  { name: 'observed_at', type: 'TIMESTAMP', required: true },
  { name: 'connection_ids', type: 'ARRAY<STRING>' },
  { name: '_ontology_version', type: 'STRING' },
];

export const LINK_COLUMNS: readonly Column[] = [
  { name: 'from_object_id', type: 'STRING', required: true },
  { name: 'to_object_id', type: 'STRING', required: true },
  ...LINEAGE_COLUMNS,
];

/**
 * The Action ledger (spec 48.2): one row per object per executed Action, written after its
 * receipt; a queryable copy, the receipt remaining the record. prior_values and new_values
 * are null unless the ledger was enabled with values. _marking_ids carries the markings the
 * receipt inherits (58.6), so a reader must satisfy them as for any marked row.
 */
export const LEDGER_TABLE = 'action_ledger';
export const LEDGER_COLUMNS: readonly Column[] = [
  { name: 'ledger_id', type: 'STRING', required: true },
  { name: 'organisation_id', type: 'STRING', required: true },
  { name: 'mutation_id', type: 'STRING', required: true },
  { name: 'receipt_id', type: 'STRING', required: true },
  { name: 'commit_id', type: 'STRING' },
  { name: 'action_type', type: 'STRING', required: true },
  { name: 'generic_edit', type: 'BOOL', required: true },
  { name: 'risk_class', type: 'STRING', required: true },
  { name: 'object_type', type: 'STRING', required: true },
  { name: 'object_id', type: 'STRING', required: true },
  { name: 'connection_id', type: 'STRING' },
  { name: 'operation', type: 'STRING', required: true },
  { name: 'fields', type: 'ARRAY<STRING>' },
  { name: 'prior_values', type: 'JSON' },
  { name: 'new_values', type: 'JSON' },
  { name: 'proposer', type: 'STRING' },
  { name: 'approvers', type: 'ARRAY<STRING>' },
  { name: 'self_approved', type: 'BOOL', required: true },
  { name: 'origin', type: 'STRING', required: true },
  { name: 'outcome', type: 'STRING', required: true },
  { name: 'reverts_mutation_id', type: 'STRING' },
  { name: 'proposed_at', type: 'TIMESTAMP' },
  { name: 'executed_at', type: 'TIMESTAMP', required: true },
  { name: '_marking_ids', type: 'ARRAY<STRING>' },
];

// Shared with the Import and Object Index generators beside this one.
export const table = (ref: DatasetRef, name: string) => ident(ref.projectId, ref.dataset, name);
export const columnSql = (c: Column) => (c.required === true ? sql`${ident(c.name)} ${TYPE_SQL[c.type]} NOT NULL` : sql`${ident(c.name)} ${TYPE_SQL[c.type]}`);
export const statement = (fragment: SqlFragment, types?: (WarehouseParameterType | undefined)[]): WarehouseStatement => {
  const rendered = render(fragment, 'bigquery');
  return { text: rendered.text, values: rendered.values, ...(types === undefined ? {} : { types }) };
};
export const structType = (columns: readonly Column[]): Record<string, WarehouseParameterType> =>
  Object.fromEntries(columns.map((c) => [c.name, PARAMETER_TYPE[c.type]]));

export function createTable(ref: DatasetRef, name: string, columns: readonly Column[]): WarehouseStatement {
  return statement(sql`create table if not exists ${table(ref, name)} (${sql.join(columns.map(columnSql), sql`, `)})`);
}

/** Added columns are nullable: rows written before the column existed hold null (spec 69.14). */
export function addColumns(ref: DatasetRef, name: string, columns: readonly Column[]): WarehouseStatement {
  const adds = columns.map((c) => sql`add column if not exists ${ident(c.name)} ${TYPE_SQL[c.type]}`);
  return statement(sql`alter table ${table(ref, name)} ${sql.join(adds, sql`, `)}`);
}

/**
 * Upserts current rows by object id. The rows are one bound array of structs, typed field
 * by field, so a null is typed and no value reaches the text.
 */
export function mergeCurrent(ref: DatasetRef, name: string, columns: readonly Column[], rows: Record<string, unknown>[]): WarehouseStatement {
  // The first observation is inserted once and never updated.
  const others = columns.filter((c) => c.name !== ID_COLUMN.name && c.name !== FIRST_OBSERVED_COLUMN.name);
  const assignments = others.map((c) => sql`${ident(c.name)} = s.${ident(c.name)}`);
  const names = columns.map((c) => sql`${ident(c.name)}`);
  const sourced = columns.map((c) => sql`s.${ident(c.name)}`);
  const id = ident(ID_COLUMN.name);
  const matched = sql`when matched then update set ${sql.join(assignments, sql`, `)}`;
  const unmatched = sql`when not matched then insert (${sql.join(names, sql`, `)}) values (${sql.join(sourced, sql`, `)})`;
  return statement(sql`merge ${table(ref, name)} t using unnest(${rows}) s on t.${id} = s.${id} ${matched} ${unmatched}`,
    [[structType(columns)]]);
}

/**
 * An as-of read's current rows (69.6; decision 2026-11-14): the objects first observed by the
 * instant (a row from before the first-observed column says nothing, and is kept), with the
 * columns asked and their dispute flags, bounded.
 */
export function readAsOfCurrent(ref: DatasetRef, name: string, columns: readonly string[], asOf: string, limit: number): WarehouseStatement {
  const id = ident(ID_COLUMN.name);
  const values = columns.map((c) => sql`, to_json_string(${ident(c)}) as ${ident(c)}, ${ident(`${c}__disputed`)}`);
  return statement(sql`select ${id}${sql.join(values, sql``)} from ${table(ref, name)}
    where (${ident(FIRST_OBSERVED_COLUMN.name)} is null or ${ident(FIRST_OBSERVED_COLUMN.name)} <= ${asOf})
    order by ${id} limit ${limit}`, ['TIMESTAMP', 'INT64']);
}

/**
 * The first change after an instant to each of these properties of these objects: its
 * previous value is the value the property held at the instant (69.6).
 */
export function changesAfter(ref: DatasetRef, historyName: string, properties: readonly string[], asOf: string, ids: readonly string[]): WarehouseStatement {
  const id = ident(ID_COLUMN.name);
  return statement(sql`select ${id}, ${ident('property')}, to_json_string(${ident('previous_value')}) as ${ident('previous_value')}
    from ${table(ref, historyName)}
    where ${ident('observed_at')} > ${asOf} and ${ident('property')} in unnest(${[...properties]}) and ${id} in unnest(${[...ids]})
    qualify row_number() over (partition by ${id}, ${ident('property')} order by ${ident('observed_at')}) = 1`,
  ['TIMESTAMP', ['STRING'], ['STRING']]);
}

/** Every change in a half-open period to these properties of these objects, oldest first (69.16); at most limit. */
export function changesBetween(ref: DatasetRef, historyName: string, properties: readonly string[], from: string, to: string, ids: readonly string[],
  limit: number): WarehouseStatement {
  const id = ident(ID_COLUMN.name);
  return statement(sql`select ${id}, ${ident('property')}, ${ident('observed_at')}, to_json_string(${ident('previous_value')}) as ${ident('previous_value')},
    to_json_string(${ident('new_value')}) as ${ident('new_value')}
    from ${table(ref, historyName)}
    where ${ident('observed_at')} >= ${from} and ${ident('observed_at')} < ${to} and ${ident('property')} in unnest(${[...properties]}) and ${id} in unnest(${[...ids]})
    order by ${id}, ${ident('property')}, ${ident('observed_at')} limit ${limit}`,
  ['TIMESTAMP', 'TIMESTAMP', ['STRING'], ['STRING'], 'INT64']);
}

export type AggregateOp = 'eq' | 'neq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'is_null' | 'not_null';
export type AggregateFn = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';

/**
 * An aggregate over the current table (69.6; decision 2026-11-14), with the engine's rules
 * for disputes (a disputed value is null with its flag):
 * - filters in order: an object whose first filter not met is disputed is left out and
 *   counted (state 'filter'); one meeting every filter is kept;
 * - a kept object with a disputed group key is left out of the groups and counted (state
 *   'key'); the rest are grouped (state 'ok');
 * - each measure over its non-null values, with their count; min and max as JSON text.
 * Per column counted, its non-null and disputed values, for the answer's coverage. Values
 * bind as parameters typed by their column, in the order they appear.
 */
export function aggregateCurrent(ref: DatasetRef, name: string, input: {
  groupBy: readonly string[];
  measures: readonly { fn: AggregateFn; column: string | null }[];
  filters: readonly { column: string; type: ColumnType; op: AggregateOp; value?: unknown }[];
  counted: readonly string[];
  limit: number;
}, across?: AcrossLink): WarehouseStatement {
  const types: (WarehouseParameterType | undefined)[] = [];
  const disputed = (c: string) => sql`coalesce(${ident(`${c}__disputed`)}, false)`;
  const tests = input.filters.map((f, i) => {
    const column = ident(f.column);
    let test: SqlFragment;
    if (f.op === 'is_null') test = sql`${column} is null and not ${disputed(f.column)}`;
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
  const met = (i: number) => ident(`_f${i}`);
  const passes = input.filters.length === 0 ? sql`true` : sql.join(input.filters.map((_, i) => sql`${met(i)}`), sql` and `);
  // Left out on a dispute: the first filter not met is a disputed one.
  const filterDisputed = input.filters.length === 0 ? sql`false`
    : sql.join(input.filters.map((_, i) => sql`(${ident(`_d${i}`)}${sql.join(input.filters.slice(0, i).map((__, j) => sql` and ${met(j)}`), sql``)})`), sql` or `);
  const keyDisputed = input.groupBy.length === 0 ? sql`false` : sql.join(input.groupBy.map((c) => disputed(c)), sql` or `);
  const keys = input.groupBy.map((c, i) => sql`, to_json_string(if(${ident('_state')} = 'ok', ${ident(c)}, null)) as ${ident(`_k${i}`)}`);
  const measures = input.measures.map((m, i) => {
    if (m.column === null) return sql``;
    const column = ident(m.column);
    const n = sql`, countif(${column} is not null) as ${ident(`_m${i}_n`)}`;
    const value = {
      count: sql``,
      count_distinct: sql`, count(distinct ${column}) as ${ident(`_m${i}`)}`,
      sum: sql`, to_json_string(sum(${column})) as ${ident(`_m${i}`)}`,
      avg: sql`, to_json_string(sum(${column})) as ${ident(`_m${i}`)}`,
      min: sql`, to_json_string(min(${column})) as ${ident(`_m${i}`)}`,
      max: sql`, to_json_string(max(${column})) as ${ident(`_m${i}`)}`,
    }[m.fn];
    return sql`${n}${value}`;
  });
  const counted = input.counted.map((c, i) => sql`, countif(${ident(c)} is not null) as ${ident(`_v${i}`)}, countif(${disputed(c)}) as ${ident(`_w${i}`)}`);
  const groupKeys = input.groupBy.map((_, i) => sql`, ${ident(`_k${i}`)}`);
  types.push('INT64');
  const filtered = sql`with f as (select *${sql.join(tests, sql``)} from ${table(ref, name)}),
    r as (select *, case when ${filterDisputed} then 'filter' when ${keyDisputed} then 'key' else 'ok' end as ${ident('_state')}
      from f where (${passes}) or (${filterDisputed}))`;
  if (across === undefined) {
    return statement(sql`${filtered}
    select ${ident('_state')}${sql.join(keys, sql``)}, count(*) as ${ident('_rows')}${sql.join(measures, sql``)}${sql.join(counted, sql``)}
    from r group by ${ident('_state')}${sql.join(groupKeys, sql``)}
    order by ${ident('_state')}${sql.join(groupKeys, sql``)} limit ${input.limit}`, types);
  }
  // Across one link (69.6; D116): the root's groups as above (a), and the linked objects' measures
  // over each group's distinct linked objects (d, then b): a linked object counts once per group,
  // however many of the group's objects it is linked to (26.11).
  const near = ident(across.reverse ? 'to_object_id' : 'from_object_id');
  const far = ident(across.reverse ? 'from_object_id' : 'to_object_id');
  const linkedValues = across.measures.map((m, i) => (m.column === null ? sql`` : sql`, t.${ident(m.column)} as ${ident(`_c${i}`)}`));
  const linkedMeasures = across.measures.map((m, i) => {
    if (m.column === null) return sql`, count(${ident('_linked')}) as ${ident(`_l${i}`)}`;
    const column = ident(`_c${i}`);
    const value = {
      count: sql``,
      count_distinct: sql`, count(distinct ${column}) as ${ident(`_l${i}`)}`,
      sum: sql`, to_json_string(sum(${column})) as ${ident(`_l${i}`)}`,
      avg: sql`, to_json_string(sum(${column})) as ${ident(`_l${i}`)}`,
      min: sql`, to_json_string(min(${column})) as ${ident(`_l${i}`)}`,
      max: sql`, to_json_string(max(${column})) as ${ident(`_l${i}`)}`,
    }[m.fn];
    return sql`, count(${ident('_linked')}) as ${ident(`_l${i}_all`)}, countif(${column} is not null) as ${ident(`_l${i}_n`)}${value}`;
  });
  const keyNames = input.groupBy.map((_, i) => ident(`_k${i}`));
  const keyed = sql.join([ident('_state'), ...keyNames].map((k) => sql`${k}`), sql`, `);
  const keyedR = input.groupBy.map((c, i) => sql`, to_json_string(if(r.${ident('_state')} = 'ok', r.${ident(c)}, null)) as ${ident(`_k${i}`)}`);
  const linkedOut = across.measures.map((m, i) => (m.column === null ? sql`, b.${ident(`_l${i}`)}`
    : sql`, b.${ident(`_l${i}_all`)}, b.${ident(`_l${i}_n`)}${m.fn === 'count' ? sql`` : sql`, b.${ident(`_l${i}`)}`}`));
  return statement(sql`${filtered},
    a as (select ${ident('_state')}${sql.join(keys, sql``)}, count(*) as ${ident('_rows')}${sql.join(measures, sql``)}${sql.join(counted, sql``)}
      from r group by ${ident('_state')}${sql.join(groupKeys, sql``)}),
    d as (select distinct r.${ident('_state')}${sql.join(keyedR, sql``)}, t.${ident(ID_COLUMN.name)} as ${ident('_linked')}${sql.join(linkedValues, sql``)}
      from r join ${table(ref, across.linkTable)} l on l.${near} = r.${ident(ID_COLUMN.name)}
      join ${table(ref, across.targetTable)} t on t.${ident(ID_COLUMN.name)} = l.${far}),
    b as (select ${keyed}${sql.join(linkedMeasures, sql``)} from d group by ${keyed})
    select a.*${sql.join(linkedOut, sql``)} from a left join b using (${keyed})
    order by a.${ident('_state')}${sql.join(keyNames.map((k) => sql`, a.${k}`), sql``)} limit ${input.limit}`, types);
}

/** The link a joined aggregate crosses (D116): its table, the far type's table, and the far side's measures. */
export interface AcrossLink {
  linkTable: string;
  targetTable: string;
  /** The root is the link's to side. */
  reverse: boolean;
  measures: readonly { fn: AggregateFn; column: string | null }[];
}

/** Ledger rows by ledger id, inserted once: a repeated write of the same Action adds nothing. */
export function mergeLedger(ref: DatasetRef, rows: Record<string, unknown>[]): WarehouseStatement {
  const names = LEDGER_COLUMNS.map((c) => sql`${ident(c.name)}`);
  const sourced = LEDGER_COLUMNS.map((c) => sql`s.${ident(c.name)}`);
  const id = ident('ledger_id');
  const unmatched = sql`when not matched then insert (${sql.join(names, sql`, `)}) values (${sql.join(sourced, sql`, `)})`;
  return statement(sql`merge ${table(ref, LEDGER_TABLE)} t using unnest(${rows}) s on t.${id} = s.${id} ${unmatched}`, [[structType(LEDGER_COLUMNS)]]);
}

/** Receipt purge (48.2): one value column of the ledger cleared on the rows of these receipts. */
export function clearLedgerValues(ref: DatasetRef, column: 'prior_values' | 'new_values', receiptIds: string[]): WarehouseStatement {
  return statement(sql`update ${table(ref, LEDGER_TABLE)} set ${ident(column)} = null where ${ident('receipt_id')} in unnest(${receiptIds}) and ${ident(column)} is not null`,
    [['STRING']]);
}

export function insertHistory(ref: DatasetRef, name: string, rows: Record<string, unknown>[]): WarehouseStatement {
  const names = HISTORY_COLUMNS.map((c) => sql`${ident(c.name)}`);
  return statement(sql`insert into ${table(ref, name)} (${sql.join(names, sql`, `)}) select ${sql.join(names, sql`, `)} from unnest(${rows})`,
    [[structType(HISTORY_COLUMNS)]]);
}

/** Current rows by id: the id, the stored hashes, and each value column as JSON text (the previous value of a change). */
export function readCurrent(ref: DatasetRef, name: string, valueColumns: readonly string[], ids: string[]): WarehouseStatement {
  const values = valueColumns.map((c) => sql`to_json_string(${ident(c)}) as ${ident(c)}`);
  const selected = [sql`${ident(ID_COLUMN.name)}`, sql`to_json_string(${ident(HASHES_COLUMN.name)}) as ${ident(HASHES_COLUMN.name)}`, ...values];
  return statement(sql`select ${sql.join(selected, sql`, `)} from ${table(ref, name)} where ${ident(ID_COLUMN.name)} in unnest(${ids})`,
    [['STRING']]);
}

export function countRows(ref: DatasetRef, name: string): WarehouseStatement {
  return statement(sql`select count(*) as n from ${table(ref, name)}`);
}

export function presentKeys(ref: DatasetRef, name: string, ids: string[]): WarehouseStatement {
  return statement(sql`select ${ident(ID_COLUMN.name)} from ${table(ref, name)} where ${ident(ID_COLUMN.name)} in unnest(${ids})`,
    [['STRING']]);
}

/** Purge concept (70.2): every row of a table, the table kept. */
/** History observed before the cutoff (70.1). */
export function deleteHistoryBefore(ref: DatasetRef, name: string, before: string): WarehouseStatement {
  return statement(sql`delete from ${table(ref, name)} where ${ident('observed_at')} < ${before}`, ['TIMESTAMP']);
}

/** A link table's rows, written whole after its from-type's sync (the table was emptied first). */
export function insertLinks(ref: DatasetRef, name: string, rows: Record<string, unknown>[]): WarehouseStatement {
  const names = LINK_COLUMNS.map((c) => sql`${ident(c.name)}`);
  return statement(sql`insert into ${table(ref, name)} (${sql.join(names, sql`, `)}) select ${sql.join(names, sql`, `)} from unnest(${rows})`,
    [[structType(LINK_COLUMNS)]]);
}

export function truncateTable(ref: DatasetRef, name: string): WarehouseStatement {
  return statement(sql`truncate table ${table(ref, name)}`);
}
