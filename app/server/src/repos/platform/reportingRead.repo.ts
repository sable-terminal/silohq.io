// Reads for a member of staff's tenant_read session (spec 13.3), on the reporting replica as
// silo_report. What that role may read is decided by its grants, not here: a table it holds
// SELECT on, the columns it holds SELECT on (a partial reader never sees a sealed column), and
// never a bytea column (sealed values). Row-level security still binds it to the session's
// organisation, and every read filters on it too. Identifiers come from the catalogue, never
// from the request: a table is read only if the catalogue lists it.

import type { Queryable } from '../base.repo.ts';

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

export interface ReadableTable { table: string; columns: string[] }

export const reportingReadRepo = {
  /** Tenant tables (with organisation_id) the reporting role may read, and the columns of each it may read. */
  async readableTables(db: Queryable): Promise<ReadableTable[]> {
    const { rows } = await db.query(`
      select n.nspname || '.' || c.relname as "table", array_agg(a.attname::text order by a.attnum) as columns
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where c.relkind in ('r', 'p') and not c.relispartition
         and n.nspname not in ('pg_catalog', 'information_schema')
         and a.atttypid <> 'bytea'::regtype
         and has_column_privilege('silo_report', c.oid, a.attnum, 'SELECT')
         and exists (select 1 from pg_attribute o where o.attrelid = c.oid and o.attname = 'organisation_id' and not o.attisdropped)
       group by 1 order by 1`);
    return rows as ReadableTable[];
  },

  /** A page of the session's organisation's rows of a listed table: its readable columns only. */
  async rows(db: Queryable, table: ReadableTable, limit: number, offset: number): Promise<Record<string, unknown>[]> {
    const [schema, name] = table.table.split('.') as [string, string];
    const columns = table.columns.map(quote).join(', ');
    const order = table.columns.includes('id') ? quote('id') : quote(table.columns[0]!);
    const { rows } = await db.query(
      `select ${columns} from ${quote(schema)}.${quote(name)}
        where organisation_id = current_setting('app.org_id')::uuid order by ${order} limit $1 offset $2`, [limit, offset]);
    return rows as Record<string, unknown>[];
  },
};
