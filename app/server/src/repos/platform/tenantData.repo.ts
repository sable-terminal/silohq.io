// An organisation's rows, table by table, for a tenant migration (spec 6.4) and the
// organisation export (spec 2.6). Hand-written, not scaffolded: these statements run over
// every tenant table, named from pg_catalog and quoted here, never from caller input.
//
// - A row travels as the text of to_jsonb(row), less its identity columns (an identity is
//   the cell's own sequence; the destination assigns its own, and nothing references one).
//   jsonb text is canonical, so equal rows give equal text at both ends, and a table's
//   checksum is SHA-256 over its rows' text, sorted (tenantMigrationTable.source_checksum).
// - Reads in the source run as the application role with app.org_id set, so row-level
//   security bounds them to the tenant ("The export runs under the application role with
//   app.org_id set by set local", spec 6.4). Every read also names the organisation, since
//   the migration role in the destination bypasses row-level security.
// - Loads and the purge run as silo_migrate with session_replication_role = replica for
//   the transaction (bootstrap grants it), so rows go in and out as they are: triggers that
//   guard live writes do not re-judge history, and foreign keys are not re-checked against
//   a half-loaded tenant. The checksums prove the load.

import type { Queryable } from '../base.repo.ts';

export interface TenantTable {
  schema: string;
  table: string;
  /** Columns inserted on load: every column but identity and generated ones. */
  insertable: string[];
  /** Identity columns, left out of the row text and assigned again on load. */
  identity: string[];
  /** Whether the application role may read it (the export reads as that role). */
  readable: boolean;
}

/** A Postgres identifier, quoted. Only ever given names read from pg_catalog. */
const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`not a catalogue identifier: ${name}`);
  return `"${name}"`;
};
const qualified = (t: { schema: string; table: string }): string => `${ident(t.schema)}.${ident(t.table)}`;
/** Rows per insert statement on load, so no single statement carries a whole large table. */
const LOAD_BATCH = 5_000;

/** Exported tables are listed with their organisation column; these hold an organisation differently. */
export const ORGANISATION_ROW = { schema: 'iam', table: 'organisations' } as const;
export const MEMBER_USERS = { schema: 'iam', table: 'users' } as const;

export const tenantDataRepo = {
  /** Acts as silo_migrate until the transaction ends (SET LOCAL ROLE); the login is a member. */
  async actAsMigrate(db: Queryable): Promise<void> {
    await db.query(`select set_config('role', 'silo_migrate', true)`);
  },

  /** Triggers and foreign key checks off for this transaction (silo_migrate only). */
  async bulkMode(db: Queryable): Promise<void> {
    await db.query(`select set_config('session_replication_role', 'replica', true)`);
  },

  /**
   * Every tenant table: an organisation_id column and forced row-level security, the
   * partitioned parent rather than its partitions. Sorted by name.
   */
  async tenantTables(db: Queryable): Promise<TenantTable[]> {
    const { rows } = await db.query(
      `select n.nspname as schema, c.relname as "table",
              array(select a.attname::text from pg_attribute a
                    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                      and a.attidentity = '' and a.attgenerated = '' order by a.attnum) as insertable,
              array(select a.attname::text from pg_attribute a
                    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attidentity <> ''
                    order by a.attnum) as identity,
              has_table_privilege('silo_app', c.oid, 'select') as readable
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p') and not c.relispartition and c.relforcerowsecurity
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organisation_id' and not a.attisdropped)
       order by 1, 2`);
    return rows as TenantTable[];
  },

  /** The two tables that hold an organisation without an organisation_id column. */
  async columnsOf(db: Queryable, table: { schema: string; table: string }): Promise<TenantTable> {
    const { rows } = await db.query(
      `select $1::text as schema, $2::text as "table",
              array(select a.attname::text from pg_attribute a
                    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                      and a.attidentity = '' and a.attgenerated = '' order by a.attnum) as insertable,
              array[]::text[] as identity,
              has_table_privilege('silo_app', c.oid, 'select') as readable
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2`, [table.schema, table.table]);
    return rows[0] as TenantTable;
  },

  /** The organisation's rows of one tenant table, each as jsonb text without identity columns. */
  async rows(db: Queryable, table: TenantTable, organisationId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select (to_jsonb(t) - $2::text[])::text as row from ${qualified(table)} t where t.organisation_id = $1`,
      [organisationId, table.identity]);
    return (rows as { row: string }[]).map((r) => r.row);
  },

  /**
   * The organisation's rows of one tenant table, as rows() gives them, in byte order of their
   * text (collate "C"), batch at a time through a cursor in the caller's transaction. Both ends
   * of a migration read a table this way, so its checksum is worked out without holding it.
   */
  async *rowBatches(db: Queryable, table: TenantTable, organisationId: string, batch: number): AsyncGenerator<string[]> {
    if (!Number.isInteger(batch) || batch < 1) throw new Error('a cursor batch is a positive integer');
    await db.query(
      `declare tenant_rows no scroll cursor for
       select (to_jsonb(t) - $2::text[])::text as row from ${qualified(table)} t where t.organisation_id = $1
       order by (to_jsonb(t) - $2::text[])::text collate "C"`,
      [organisationId, table.identity]);
    try {
      for (;;) {
        const { rows } = await db.query(`fetch forward ${batch} from tenant_rows`);
        if (rows.length > 0) yield (rows as { row: string }[]).map((r) => r.row);
        if (rows.length < batch) return;
      }
    } finally {
      await db.query('close tenant_rows').catch(() => undefined);
    }
  },

  /** For a transaction that waits on object storage between statements: how long it may sit idle. */
  async allowIdle(db: Queryable, ms: number): Promise<void> {
    await db.query(`select set_config('idle_in_transaction_session_timeout', $1, true)`, [`${ms}ms`]);
  },

  /** The organisation's rows of a tenant table, whole (identity columns too), as jsonb text: the export reads these. */
  async fullRows(db: Queryable, table: TenantTable, organisationId: string): Promise<string[]> {
    const { rows } = await db.query(`select to_jsonb(t)::text as row from ${qualified(table)} t where t.organisation_id = $1`, [organisationId]);
    return (rows as { row: string }[]).map((r) => r.row);
  },

  /** Rows of a catalogue table by id, the shared catalogue's included (row-level security decides what is visible). */
  async rowsById(db: Queryable, table: TenantTable, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(`select to_jsonb(t)::text as row from ${qualified(table)} t where t.id = any($1::uuid[])`, [ids]);
    return (rows as { row: string }[]).map((r) => r.row);
  },

  /** A table's columns and their types, for the export's published JSON Schemas. */
  async columnTypes(db: Queryable, table: { schema: string; table: string }): Promise<{ name: string; type: string; nullable: boolean }[]> {
    const { rows } = await db.query(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [table.schema, table.table]);
    return rows as { name: string; type: string; nullable: boolean }[];
  },

  /** The organisation's own row, without the cell it lives in (which the destination sets). */
  async organisationRow(db: Queryable, organisationId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select (to_jsonb(o) - 'cell_id')::text as row from iam.organisations o where o.id = $1`, [organisationId]);
    return (rows as { row: string }[]).map((r) => r.row);
  },

  /** The users who hold a membership of the organisation (silo_migrate: users are the cell's, not a tenant's). */
  async memberUserRows(db: Queryable, organisationId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select to_jsonb(u)::text as row from iam.users u
       where u.id in (select m.user_id from iam.memberships m where m.organisation_id = $1)`, [organisationId]);
    return (rows as { row: string }[]).map((r) => r.row);
  },

  /** Rows of a tenant table loaded as they were exported (silo_migrate, bulk mode), LOAD_BATCH at a time. */
  async load(db: Queryable, table: TenantTable, rows: readonly string[]): Promise<number> {
    const columns = table.insertable.map(ident).join(', ');
    let loaded = 0;
    for (let i = 0; i < rows.length; i += LOAD_BATCH) {
      const { rowCount } = await db.query(
        `insert into ${qualified(table)} (${columns})
         select ${columns} from jsonb_populate_recordset(null::${qualified(table)}, $1::jsonb)`,
        [`[${rows.slice(i, i + LOAD_BATCH).join(',')}]`]);
      loaded += rowCount ?? 0;
    }
    return loaded;
  },

  /** The organisation's row, placed in this cell. */
  async loadOrganisation(db: Queryable, table: TenantTable, rows: readonly string[], cellId: string): Promise<number> {
    const columns = table.insertable.filter((c) => c !== 'cell_id').map(ident).join(', ');
    const { rowCount } = await db.query(
      `insert into iam.organisations (${columns}, cell_id)
       select ${columns}, $2 from jsonb_populate_recordset(null::iam.organisations, $1::jsonb)`,
      [`[${rows.join(',')}]`, cellId]);
    return rowCount ?? 0;
  },

  /** Member users not already in this cell, by id. A different user with the same address fails on its unique key. */
  async loadUsers(db: Queryable, table: TenantTable, rows: readonly string[]): Promise<number> {
    const columns = table.insertable.map(ident).join(', ');
    let loaded = 0;
    for (let i = 0; i < rows.length; i += LOAD_BATCH) {
      const { rowCount } = await db.query(
        `insert into iam.users (${columns})
         select ${columns} from jsonb_populate_recordset(null::iam.users, $1::jsonb) r
         where not exists (select 1 from iam.users u where u.id = r.id)`,
        [`[${rows.slice(i, i + LOAD_BATCH).join(',')}]`]);
      loaded += rowCount ?? 0;
    }
    return loaded;
  },

  /** Operators an organisation's rows name, copied into this cell's registry when absent. */
  async operatorRows(db: Queryable, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query(`select to_jsonb(o)::text as row from platform.operators o where o.id = any($1::uuid[])`, [ids]);
    return (rows as { row: string }[]).map((r) => r.row);
  },

  async loadOperators(db: Queryable, rows: readonly string[]): Promise<number> {
    if (rows.length === 0) return 0;
    const { rowCount } = await db.query(
      `insert into platform.operators select * from jsonb_populate_recordset(null::platform.operators, $1::jsonb)
       on conflict (id) do nothing`, [`[${rows.join(',')}]`]);
    return rowCount ?? 0;
  },

  /** Columns of tenant tables that reference platform.operators: an organisation's rows may name operators. */
  async operatorReferences(db: Queryable): Promise<{ schema: string; table: string; column: string }[]> {
    const { rows } = await db.query(
      `select n.nspname as schema, c.relname as "table", a.attname as "column"
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
       where k.contype = 'f' and k.confrelid = 'platform.operators'::regclass and array_length(k.conkey, 1) = 1
         and not c.relispartition and c.relforcerowsecurity
       order by 1, 2, 3`);
    return rows as { schema: string; table: string; column: string }[];
  },

  async operatorIds(db: Queryable, reference: { schema: string; table: string; column: string }, organisationId: string): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct t.${ident(reference.column)}::text as id from ${qualified(reference)} t
       where t.organisation_id = $1 and t.${ident(reference.column)} is not null`, [organisationId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  /** Whether this cell holds the organisation at all. */
  async organisationExists(db: Queryable, organisationId: string): Promise<boolean> {
    const { rows } = await db.query('select exists (select 1 from iam.organisations where id = $1) as found', [organisationId]);
    return (rows[0] as { found: boolean }).found;
  },

  /**
   * Connections left without their credentials: an active one is halted until someone
   * re-authorises it (halted goes back to active); a probe under way starts again from draft.
   */
  async haltForReauthorisation(db: Queryable, organisationId: string, reason: string): Promise<number> {
    const { rowCount } = await db.query(
      `update connect.connections set status = 'halted', halted_reason = $2, halted_at = now()
       where organisation_id = $1 and status = 'active'`, [organisationId, reason]);
    await db.query(`update connect.connections set status = 'draft' where organisation_id = $1 and status = 'probing'`, [organisationId]);
    return rowCount ?? 0;
  },

  async countHalted(db: Queryable, organisationId: string, reason: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from connect.connections where organisation_id = $1 and status = 'halted' and halted_reason = $2`,
      [organisationId, reason]);
    return (rows[0] as { n: number }).n;
  },

  // ----------------------------------------------------------------------------- purge

  /** Deletes the organisation's rows of one tenant table (silo_migrate, bulk mode). */
  async purge(db: Queryable, table: { schema: string; table: string }, organisationId: string): Promise<number> {
    const { rowCount } = await db.query(`delete from ${qualified(table)} where organisation_id = $1`, [organisationId]);
    return rowCount ?? 0;
  },

  /** Users whose only memberships were the organisation's, once those are gone; and their MFA factors and reset links. */
  async purgeUsers(db: Queryable, userIds: readonly string[]): Promise<{ users: number; factors: number; resets: number }> {
    if (userIds.length === 0) return { users: 0, factors: 0, resets: 0 };
    const lone = `select u.id from iam.users u where u.id = any($1::uuid[])
                  and not exists (select 1 from iam.memberships m where m.user_id = u.id)`;
    const factors = await db.query(`delete from iam.mfa_factors where user_id in (${lone})`, [userIds]);
    const resets = await db.query(`delete from iam.password_resets where user_id in (${lone})`, [userIds]);
    const users = await db.query(`delete from iam.users where id in (${lone})`, [userIds]);
    return { users: users.rowCount ?? 0, factors: factors.rowCount ?? 0, resets: resets.rowCount ?? 0 };
  },

  async memberUserIds(db: Queryable, organisationId: string): Promise<string[]> {
    const { rows } = await db.query('select distinct user_id::text as id from iam.memberships where organisation_id = $1', [organisationId]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  async purgeOrganisation(db: Queryable, organisationId: string): Promise<number> {
    const { rowCount } = await db.query('delete from iam.organisations where id = $1', [organisationId]);
    return rowCount ?? 0;
  },
};
