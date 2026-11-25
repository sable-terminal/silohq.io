// The SQL engine's statement generator: the native part of a plan step as one SELECT in the
// connection's dialect. Generated, never written by hand (decision 2026-11-01):
// identifiers come only from the manifest and are quoted by the dialect; every value is a
// bound parameter; operators, directions and aggregates come from the builder's closed
// keyword list. Dialects differ here and only here: row limits and LIKE escaping.

import type { ManifestField, ManifestObject } from '../../../../contracts/connect/manifest.contract.ts';
import type { PushdownSplit, StepFilter } from '../../../../contracts/connect/step.contract.ts';
import { ident, keyword, render, sql, type Dialect, type RenderedSql, type SqlFragment } from '../../../../utils/sqlBuilder.util.ts';
import { AppError } from '../../../../utils/errors.util.ts';

const COMPARISON = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

// LIKE patterns: the value is matched literally. BigQuery escapes with a backslash and has
// no ESCAPE clause; every other grammar here takes ESCAPE '!'.
function likePattern(dialect: Dialect, value: string, kind: 'contains' | 'starts_with'): string {
  const escaped = dialect === 'bigquery' ? value.replace(/[\\%_]/g, (c) => `\\${c}`) : value.replace(/[!%_]/g, (c) => `!${c}`);
  return kind === 'contains' ? `%${escaped}%` : `${escaped}%`;
}

function like(dialect: Dialect, column: SqlFragment, pattern: string): SqlFragment {
  return dialect === 'bigquery' ? sql`${column} like ${pattern}` : sql`${column} like ${pattern} escape '!'`;
}

function condition(dialect: Dialect, column: SqlFragment, filter: StepFilter): SqlFragment {
  switch (filter.op) {
    case 'eq': case 'ne': case 'lt': case 'lte': case 'gt': case 'gte':
      return sql`${column} ${keyword(COMPARISON[filter.op])} ${filter.value}`;
    case 'in':
      return sql`${column} in (${sql.list(filter.value as unknown[])})`;
    case 'contains':
    case 'starts_with':
      return like(dialect, column, likePattern(dialect, String(filter.value), filter.op));
    case 'is_null':
      return sql`${column} is null`;
    case 'is_not_null':
      return sql`${column} is not null`;
  }
}

function withRowLimit(dialect: Dialect, statement: SqlFragment, ordered: boolean, rows: number): SqlFragment {
  switch (dialect) {
    case 'sqlserver':
      // OFFSET ... FETCH needs an ORDER BY; an arbitrary order where the step names none.
      return ordered ? sql`${statement} offset 0 rows fetch next ${rows} rows only`
        : sql`${statement} order by (select null) offset 0 rows fetch next ${rows} rows only`;
    case 'oracle':
      return sql`${statement} fetch first ${rows} rows only`;
    case 'postgres': case 'mysql': case 'snowflake': case 'bigquery': case 'databricks':
      return sql`${statement} limit ${rows}`;
  }
}

/**
 * The native part as a statement. Columns are aliased to field names, so rows come back
 * keyed by field. fetch is the row limit: the step's native limit, or one past the bound so
 * an overflow is seen and refused.
 */
export function selectStatement(dialect: Dialect, object: ManifestObject, native: PushdownSplit['native'], fields: readonly ManifestField[],
  fetch: number): RenderedSql {
  if (object.source.kind !== 'sql') throw new AppError('integrity', 'an SQL object has an SQL source', { code: 'manifest.source_kind' });
  const source = object.source;
  const byName = new Map(object.fields.map((f) => [f.name, f]));
  const column = (name: string): SqlFragment => {
    const field = byName.get(name);
    if (field === undefined) throw new AppError('validation', 'the step names a field the object does not have', { code: 'step.field_unknown', details: { field: name } });
    return sql`${ident(field.column ?? field.name)}`;
  };

  let selected: SqlFragment;
  if (native.aggregate !== null) {
    const groups = native.aggregate.groupBy.map((g) => sql`${column(g)} as ${ident(g)}`);
    const measures = native.aggregate.measures.map((m) => (m.field === undefined
      ? sql`count(*) as ${ident(m.as)}`
      : sql`${keyword(m.fn)}(${column(m.field)}) as ${ident(m.as)}`));
    selected = sql.join([...groups, ...measures], sql`, `);
  } else {
    selected = sql.join(fields.map((f) => sql`${column(f.name)} as ${ident(f.name)}`), sql`, `);
  }
  const table = source.schema === undefined ? ident(source.table) : ident(source.schema, source.table);
  let statement = sql`select ${selected} from ${table}`;
  // A table that refuses an unfiltered scan is read from the start of time on its partition column.
  const conditions = [
    ...(source.partitionColumn === undefined ? [] : [sql`${ident(source.partitionColumn)} >= ${new Date(0)}`]),
    ...native.filters.map((f) => condition(dialect, column(f.field), f)),
  ];
  if (conditions.length > 0) statement = sql`${statement} where ${sql.join(conditions, sql` and `)}`;
  if (native.aggregate !== null && native.aggregate.groupBy.length > 0) {
    statement = sql`${statement} group by ${sql.join(native.aggregate.groupBy.map(column), sql`, `)}`;
  }
  if (native.sort.length > 0) {
    statement = sql`${statement} order by ${sql.join(native.sort.map((s) => sql`${ident(s.field)} ${keyword(s.direction)}`), sql`, `)}`;
  }
  return render(withRowLimit(dialect, statement, native.sort.length > 0, fetch), dialect);
}
