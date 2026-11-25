// Row counts of every table in a database (spec 12.5: "monthly isolated restore of every cell's
// pg-control with row count checks"; D251): read as the migration login, in one snapshot, for the
// manifest a backup is taken with and for the check of a restore against it. Partitions count in
// their parent; system schemas are left out. Counts only.

import type { Queryable } from '../base.repo.ts';

/** A Postgres identifier, quoted. Only ever given names read from pg_catalog. */
const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`not a catalogue identifier: ${name}`);
  return `"${name}"`;
};

export const rowCountsRepo = {
  /** Each ordinary or partitioned table's rows, by schema.table, sorted; with when the snapshot was taken. */
  async countAll(db: Queryable): Promise<{ takenAt: string; tables: Record<string, number> }> {
    // As silo_migrate, which reads every organisation's rows (the tenant purge's role), for this transaction only.
    await db.query(`select set_config('role', 'silo_migrate', true)`);
    const { rows: stamp } = await db.query('select transaction_timestamp() as at');
    const { rows } = await db.query(
      `select n.nspname as schema, c.relname as "table" from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p') and not c.relispartition
         and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname not like 'pg_temp%'
       order by 1, 2`);
    const tables: Record<string, number> = {};
    for (const t of rows as { schema: string; table: string }[]) {
      const { rows: [n] } = await db.query(`select count(*)::bigint as n from ${ident(t.schema)}.${ident(t.table)}`);
      tables[`${t.schema}.${t.table}`] = Number((n as { n: string }).n);
    }
    return { takenAt: new Date((stamp[0] as { at: Date }).at).toISOString(), tables };
  },
};
