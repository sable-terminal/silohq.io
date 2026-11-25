// The four statements every repo builds from its table spec. Plain parameterised SQL
// through pg; no ORM. Column names come only from the generated specs, never from
// callers.
//
// Each table has one repo file, src/repos/<schema>/<name>.repo.ts, scaffolded by
// npm run db:models and then owned by its authors: a table's own queries go there.

import type { TableSpec } from '../models/table.model.ts';
import type { Queryable } from '../infra/postgres.infra.ts';

// The pool, the type parsers and the request transaction live in infra/postgres.infra.ts.
export type { Queryable } from '../infra/postgres.infra.ts';

type Values<Row> = { readonly [K in keyof Row]?: Row[K] };

interface Bound {
  columns: string[];
  params: unknown[];
}

function bind<Row>(spec: TableSpec<Row>, values: Values<Row>): Bound {
  const bound: Bound = { columns: [], params: [] };
  for (const [property, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const column = spec.columns[property as keyof Row];
    if (column === undefined) throw new Error(`${spec.table} has no column for ${property}`);
    bound.columns.push(column);
    bound.params.push(value !== null && spec.json.includes(property) ? JSON.stringify(value) : value);
  }
  return bound;
}

// A key or unique key as a where clause. A null matches with "is null", which a unique
// key declared nulls not distinct needs.
function where<Row>(spec: TableSpec<Row>, key: Values<Row>, offset: number): { sql: string; params: unknown[] } {
  const { columns, params } = bind(spec, key);
  if (columns.length === 0) throw new Error(`${spec.table}: a key is required`);
  const terms: string[] = [];
  const kept: unknown[] = [];
  columns.forEach((column, i) => {
    if (params[i] === null) {
      terms.push(`${column} is null`);
    } else {
      kept.push(params[i]);
      terms.push(`${column} = $${offset + kept.length}`);
    }
  });
  return { sql: terms.join(' and '), params: kept };
}

export async function insertRow<Row>(db: Queryable, spec: TableSpec<Row>, values: Values<Row>): Promise<Row> {
  const { columns, params } = bind(spec, values);
  const sql = columns.length === 0
    ? `insert into ${spec.sql} default values returning ${spec.select}`
    : `insert into ${spec.sql} (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) `
      + `returning ${spec.select}`;
  const { rows } = await db.query(sql, params);
  return rows[0] as Row;
}

// The row with this key or unique key, if this request may see it.
export async function findRow<Row>(db: Queryable, spec: TableSpec<Row>, key: Values<Row>): Promise<Row | undefined> {
  const condition = where(spec, key, 0);
  const { rows } = await db.query(`select ${spec.select} from ${spec.sql} where ${condition.sql} limit 2`,
    condition.params);
  if (rows.length > 1) throw new Error(`${spec.table}: the key matched more than one row`);
  return rows[0] as Row | undefined;
}

// Changes the given columns of the row with this key. Undefined values are left alone;
// null sets null. Returns the row as it now is, or undefined if no row matched.
export async function updateRow<Row>(
  db: Queryable,
  spec: TableSpec<Row>,
  key: Values<Row>,
  changes: Values<Row>,
): Promise<Row | undefined> {
  const set = bind(spec, changes);
  if (set.columns.length === 0) return findRow(db, spec, key);
  const condition = where(spec, key, set.params.length);
  const assignments = set.columns.map((column, i) => `${column} = $${i + 1}`).join(', ');
  const { rows } = await db.query(
    `update ${spec.sql} set ${assignments} where ${condition.sql} returning ${spec.select}`,
    [...set.params, ...condition.params]);
  if (rows.length > 1) throw new Error(`${spec.table}: the key matched more than one row`);
  return rows[0] as Row | undefined;
}

export async function deleteRow<Row>(db: Queryable, spec: TableSpec<Row>, key: Values<Row>): Promise<boolean> {
  const condition = where(spec, key, 0);
  const { rowCount } = await db.query(`delete from ${spec.sql} where ${condition.sql}`, condition.params);
  if ((rowCount ?? 0) > 1) throw new Error(`${spec.table}: the key matched more than one row`);
  return rowCount === 1;
}
