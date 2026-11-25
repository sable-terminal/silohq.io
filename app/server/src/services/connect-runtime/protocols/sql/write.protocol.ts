// The SQL engine's writes (spec 45.2): a connection's plan as generated statements run by the
// Silo Agent in one transaction of the customer's database, so the plan commits or rolls back
// as a unit. Generated, never written by hand (decision 2026-11-01): the table and columns
// come only from the manifest and are quoted by the dialect; every value is a bound
// parameter. Each update and delete must change exactly one row (the record named by its
// identifier), or the agent rolls the whole plan back.
//
// A create needs the identifier among its values: generated keys differ by dialect and
// come back only through dialect-specific clauses, which this release does not generate.
// A full update is an UPDATE of every column but the identifier. An upsert (48.1) is
// INSERT ... ON CONFLICT on Postgres, INSERT ... ON DUPLICATE KEY UPDATE on MySQL, and MERGE
// on the others, keyed on the identifier; the rows it reports differ by dialect, so it is
// checked by the read-back, not a row count.
//
// An update or delete carries its prior state as a guard (48.1): the row must still hold the
// values Silo read and recorded, compared null-safely in the same statement, so the prior
// state and the write see one snapshot. A row changed since matches nothing, the row count
// is wrong, and the whole plan rolls back as a conflict. Dialects without a null-safe
// comparison Silo generates (SQL Server, Oracle) and JSON fields, which have no equality,
// go unguarded; the stale re-read before the plan still covers them.

import type { WriteOperation } from '../../../../contracts/connect-runtime/write.contract.ts';
import type { ManifestObject } from '../../../../contracts/connect/manifest.contract.ts';
import { ident, render, sql, type Dialect, type RenderedSql, type SqlFragment } from '../../../../utils/sqlBuilder.util.ts';
import { AppError } from '../../../../utils/errors.util.ts';

export interface SqlWrite {
  operation: WriteOperation;
  identifier: string | undefined;
  values: Record<string, unknown>;
  /** The values Silo read and recorded as prior state: the guard of an update or delete. */
  prior?: Record<string, unknown> | null | undefined;
}

function columnOf(object: ManifestObject, field: string): SqlFragment {
  const declared = object.fields.find((f) => f.name === field);
  if (declared === undefined) {
    throw new AppError('validation', 'the write names a field the object does not have', { code: 'write.field_unknown', details: { field } });
  }
  return sql`${ident(declared.column ?? declared.name)}`;
}

function tableOf(object: ManifestObject): SqlFragment {
  if (object.source.kind !== 'sql') throw new AppError('integrity', 'an SQL object has an SQL source', { code: 'manifest.source_kind' });
  const source = object.source;
  return sql`${source.schema === undefined ? ident(source.table) : ident(source.schema, source.table)}`;
}

/** A JSON value is bound as text; scalars as themselves. */
const bound = (value: unknown): unknown => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);

type Statement = RenderedSql & { expectRows?: number; guarded?: boolean };

/** The row still holds its prior state, field by field, null-safely; none where the dialect has no such comparison. */
function priorGuard(dialect: Dialect, object: ManifestObject, prior: SqlWrite['prior']): SqlFragment[] {
  if (prior === null || prior === undefined || dialect === 'sqlserver' || dialect === 'oracle') return [];
  const idField = object.identifier[0]!;
  return Object.entries(prior).flatMap(([field, value]) => {
    const declared = object.fields.find((f) => f.name === field);
    if (declared === undefined || field === idField || declared.type === 'json') return [];
    return [dialect === 'mysql' ? sql`${columnOf(object, field)} <=> ${bound(value)}` : sql`${columnOf(object, field)} is not distinct from ${bound(value)}`];
  });
}

/** The record by its identifier, and its prior state where guarded. */
function rowOf(dialect: Dialect, object: ManifestObject, write: SqlWrite): { where: SqlFragment; guarded: boolean } {
  const guard = priorGuard(dialect, object, write.prior);
  const key = sql`${columnOf(object, object.identifier[0]!)} = ${write.identifier!}`;
  return { where: guard.length === 0 ? key : sql`${key} and ${sql.join(guard, sql` and `)}`, guarded: guard.length > 0 };
}

function update(dialect: Dialect, object: ManifestObject, write: SqlWrite): Statement {
  const idField = object.identifier[0]!;
  const fields = Object.keys(write.values);
  if (fields.length === 0) throw new AppError('validation', 'an update changes at least one field', { code: 'write.no_fields' });
  if (fields.includes(idField)) throw new AppError('validation', 'an update never changes the identifier', { code: 'write.identifier_changed' });
  const assignments = sql.join(fields.map((f) => sql`${columnOf(object, f)} = ${bound(write.values[f])}`), sql`, `);
  const row = rowOf(dialect, object, write);
  return { ...render(sql`update ${tableOf(object)} set ${assignments} where ${row.where}`, dialect), expectRows: 1, guarded: row.guarded };
}

function upsert(dialect: Dialect, object: ManifestObject, write: SqlWrite): Statement {
  const idField = object.identifier[0]!;
  if (write.identifier === undefined) {
    throw new AppError('validation', 'an upsert names its record', { code: 'write.identifier_required', details: { field: idField } });
  }
  // The identifier field's own value where given (typed as the column), else the identifier.
  const values: Record<string, unknown> = { [idField]: write.values[idField] ?? write.identifier };
  for (const [field, value] of Object.entries(write.values)) if (field !== idField) values[field] = value;
  const fields = Object.keys(values);
  const others = fields.filter((f) => f !== idField);
  if (others.length === 0) throw new AppError('validation', 'an upsert writes at least one field besides the identifier', { code: 'write.no_fields' });
  const table = tableOf(object);
  const key = columnOf(object, idField);
  const columns = sql.join(fields.map((f) => columnOf(object, f)), sql`, `);
  if (dialect === 'postgres') {
    const set = sql.join(others.map((f) => sql`${columnOf(object, f)} = excluded.${columnOf(object, f)}`), sql`, `);
    return render(sql`insert into ${table} (${columns}) values (${sql.list(fields.map((f) => bound(values[f])))}) on conflict (${key}) do update set ${set}`, dialect);
  }
  if (dialect === 'mysql') {
    const set = sql.join(others.map((f) => sql`${columnOf(object, f)} = values(${columnOf(object, f)})`), sql`, `);
    return render(sql`insert into ${table} (${columns}) values (${sql.list(fields.map((f) => bound(values[f])))}) on duplicate key update ${set}`, dialect);
  }
  const selected = sql.join(fields.map((f) => sql`${bound(values[f])} as ${columnOf(object, f)}`), sql`, `);
  const source = dialect === 'oracle' ? sql`select ${selected} from dual` : sql`select ${selected}`;
  const set = sql.join(others.map((f) => sql`${columnOf(object, f)} = s.${columnOf(object, f)}`), sql`, `);
  const inserted = sql.join(fields.map((f) => sql`s.${columnOf(object, f)}`), sql`, `);
  const merge = sql`merge into ${table} t using (${source}) s on (t.${key} = s.${key}) when matched then update set ${set} when not matched then insert (${columns}) values (${inserted})`;
  // SQL Server ends a MERGE with a semicolon; Oracle's drivers refuse one.
  return render(dialect === 'sqlserver' ? sql`${merge};` : merge, dialect);
}

// By operation (keys, not strings: an operation name is never SQL text).
const STATEMENTS: Readonly<Record<Exclude<WriteOperation, 'custom'>, (dialect: Dialect, object: ManifestObject, write: SqlWrite) => Statement>> = {
  create(dialect, object, write) {
    const idField = object.identifier[0]!;
    if (write.values[idField] === undefined || write.values[idField] === null) {
      throw new AppError('validation', 'an SQL create names the new record\'s identifier', { code: 'write.identifier_required', details: { field: idField } });
    }
    const fields = Object.keys(write.values);
    const columns = sql.join(fields.map((f) => columnOf(object, f)), sql`, `);
    const params = sql.list(fields.map((f) => bound(write.values[f])));
    return render(sql`insert into ${tableOf(object)} (${columns}) values (${params})`, dialect);
  },
  update_partial: update,
  update_full: update,
  upsert,
  delete(dialect, object, write) {
    const row = rowOf(dialect, object, write);
    return { ...render(sql`delete from ${tableOf(object)} where ${row.where}`, dialect), expectRows: 1, guarded: row.guarded };
  },
};

/** One write as a statement, and the rows it must change (none checked for a create). */
export function writeStatement(dialect: Dialect, object: ManifestObject, write: SqlWrite): Statement {
  // A custom action is a REST endpoint; the write service refuses one on SQL before this.
  if (write.operation === 'custom') throw new AppError('validation', 'an SQL connector has no custom actions', { code: 'write.operation_undeclared' });
  return STATEMENTS[write.operation](dialect, object, write);
}
