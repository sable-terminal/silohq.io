import type { TransportV2 } from '../../../schemas/manifest.schema';
import { refusal } from '../../../utils/error.util';
import { applyAuth } from '../../auth/apply.auth';
import type { SqlWire } from '../database.transport';
import { transportFor } from '../index.transport';
import { GRAMMARS, type GrammarName } from './grammar.sql';
import { buildSelect } from './statement.sql';
import { connectionSettings, resolveTls, type ReadContext } from '../../read/context.read';

/**
 * A database's own description of itself: its columns and its foreign keys.
 *
 * THE CATALOGUE, NOT THE MANIFEST. Self-heal has to see the columns a table has
 * rather than the ones it asked for; the mutation preview has to know whether a
 * delete cascades, is refused or leaves a null — and only the database knows.
 * Each is one statement per grammar, run read-only with the connection's own
 * credential. A grammar with no statement here answers null: "not known" is
 * true, and an empty list would be a claim.
 */

type Sql = Extract<TransportV2, { kind: 'sql' }>;

async function run(ctx: ReadContext, text: string, values: unknown[]): Promise<Array<Record<string, unknown>>> {
  const t = ctx.manifest.transport as Sql;
  const settings = await connectionSettings(t, ctx.params);
  const transport = transportFor('sql');
  const wire: SqlWire = {
    kind: 'sql',
    grammar: t.grammar,
    connection: {
      driver: t.driver,
      host: settings.host == null ? null : String(settings.host),
      port: settings.port == null ? null : Number(settings.port),
      database: settings.database == null ? null : String(settings.database),
      serviceName: settings.serviceName == null ? null : String(settings.serviceName),
      sid: settings.sid == null ? null : String(settings.sid),
      connectString: settings.connectString == null ? null : String(settings.connectString),
      options: Object.fromEntries(Object.entries((settings.options as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)])),
    },
    statement: { text, values },
    mode: 'read',
    maxRows: 100_000,
  };
  const socket = { tls: await resolveTls(t, ctx.params) };
  const surface = transport.authSurface(wire, socket);
  if (ctx.strategy) {
    await applyAuth({ strategy: ctx.strategy, credential: ctx.credential, params: ctx.params, kind: 'sql', req: wire, surface, isWrite: false, route: ctx.route, cacheKey: ctx.cacheKey, origin: null, deps: ctx.auth });
  }
  const response = await ctx.dispatch(transport, wire, { socket, timeoutMs: 30_000, maxBytes: ctx.budget.limits.maxBytes, retry: true, mode: 'read', connectionId: ctx.connectionId }, ctx.route);
  if (response.code !== null) {
    throw refusal({ message: `The database would not describe itself: ${response.message ?? response.code}`, code: 'refusal.catalogue_unreadable', detail: { code: response.code } });
  }
  return JSON.parse(response.body.toString('utf8')) as Array<Record<string, unknown>>;
}

const schemaOf = async (ctx: ReadContext): Promise<string> => {
  const settings = await connectionSettings(ctx.manifest.transport, ctx.params);
  return String(settings.schema ?? 'public');
};

/* ── Columns ────────────────────────────────────────────────────────────── */

export interface Column {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
  nullable: boolean;
}

const COLUMNS: Partial<Record<GrammarName, string>> = {
  postgres: `SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
  mysql: `SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
  tsql: `SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = @p1 AND table_name = @p2 ORDER BY ordinal_position`,
  oracle: `SELECT column_name AS "name", data_type AS "type", nullable AS "nullable" FROM all_tab_columns WHERE owner = :1 AND table_name = :2 ORDER BY column_id`,
  db2: `SELECT colname AS name, typename AS type, nulls AS nullable FROM syscat.columns WHERE tabschema = ? AND tabname = ? ORDER BY colno`,
};

function kindOf(type: string): Column['type'] {
  const t = type.toLowerCase();
  if (/int|numeric|decimal|real|double|float|money|number/.test(t)) return 'number';
  if (/bool|bit/.test(t)) return 'boolean';
  if (/timestamp|datetime/.test(t)) return 'datetime';
  if (/^date$/.test(t)) return 'date';
  return 'string';
}

export async function columnsOf(ctx: ReadContext, table: string): Promise<Column[] | null> {
  const t = ctx.manifest.transport as Sql;
  const text = COLUMNS[t.grammar];
  if (!text) return null;
  const rows = await run(ctx, text, [await schemaOf(ctx), table]);
  if (rows.length === 0) {
    throw refusal({ message: `The source no longer has a table called ${table}.`, code: 'refusal.source_object_missing' });
  }
  return rows.map((r) => ({ name: String(r.name), type: kindOf(String(r.type)), nullable: /^(yes|y)$/i.test(String(r.nullable)) }));
}

/* ── Every table ────────────────────────────────────────────────────────── */

export interface Table {
  name: string;
  columns: Array<Column & { primaryKey: boolean }>;
}

/*
 * ONE PASS OVER THE CATALOGUE FOR DERIVATION: every table and view in the
 * schema, its columns in order, and which are its primary key. Structure only —
 * no row is read.
 */
const TABLES: Partial<Record<GrammarName, string>> = {
  postgres: `SELECT c.table_name AS table_name, c.column_name AS name, c.data_type AS type, c.is_nullable AS nullable,
                    EXISTS (SELECT 1 FROM information_schema.table_constraints tc
                              JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name
                             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND k.column_name = c.column_name) AS is_key
               FROM information_schema.columns c
               JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
              WHERE c.table_schema = $1 AND t.table_type IN ('BASE TABLE', 'VIEW')
              ORDER BY c.table_name, c.ordinal_position`,
  mysql: `SELECT table_name AS table_name, column_name AS name, data_type AS type, is_nullable AS nullable, column_key = 'PRI' AS is_key
            FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`,
  tsql: `SELECT c.table_name AS table_name, c.column_name AS name, c.data_type AS type, c.is_nullable AS nullable,
                CASE WHEN EXISTS (SELECT 1 FROM information_schema.table_constraints tc
                                    JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name
                                   WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND k.column_name = c.column_name)
                     THEN 1 ELSE 0 END AS is_key
           FROM information_schema.columns c WHERE c.table_schema = @p1 ORDER BY c.table_name, c.ordinal_position`,
  oracle: `SELECT c.table_name AS "table_name", c.column_name AS "name", c.data_type AS "type", c.nullable AS "nullable",
                  CASE WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
                                     WHERE k.constraint_type = 'P' AND k.owner = c.owner AND k.table_name = c.table_name AND kc.column_name = c.column_name)
                       THEN 1 ELSE 0 END AS "is_key"
             FROM all_tab_columns c WHERE c.owner = :1 ORDER BY c.table_name, c.column_id`,
  db2: `SELECT tabname AS table_name, colname AS name, typename AS type, nulls AS nullable, CASE WHEN keyseq IS NOT NULL THEN 1 ELSE 0 END AS is_key
          FROM syscat.columns WHERE tabschema = ? ORDER BY tabname, colno`,
};

export async function tablesOf(ctx: ReadContext): Promise<Table[] | null> {
  if (ctx.manifest.transport.kind !== 'sql') return null;
  const text = TABLES[ctx.manifest.transport.grammar];
  if (!text) return null;
  const rows = await run(ctx, text, [await schemaOf(ctx)]);
  const tables = new Map<string, Table>();
  for (const r of rows) {
    const name = String(r.table_name);
    const table = tables.get(name) ?? { name, columns: [] };
    table.columns.push({
      name: String(r.name),
      type: kindOf(String(r.type)),
      nullable: /^(yes|y|true|1)$/i.test(String(r.nullable)),
      primaryKey: r.is_key === true || r.is_key === 1 || r.is_key === '1' || r.is_key === 't',
    });
    tables.set(name, table);
  }
  return [...tables.values()];
}

/* ── Foreign keys ───────────────────────────────────────────────────────── */

export type ReferentialAction = 'no_action' | 'restrict' | 'cascade' | 'set_null' | 'set_default';

export interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

const PG_ACTION: Record<string, ReferentialAction> = { a: 'no_action', r: 'restrict', c: 'cascade', n: 'set_null', d: 'set_default' };
const WORDS: Record<string, ReferentialAction> = { 'NO ACTION': 'no_action', RESTRICT: 'restrict', CASCADE: 'cascade', 'SET NULL': 'set_null', 'SET DEFAULT': 'set_default' };

const KEYS: Partial<Record<GrammarName, string>> = {
  /* pg_constraint rather than information_schema, which pairs a composite key's columns as a cross product. */
  postgres: `SELECT src.relname AS from_table, sa.attname AS from_column, tgt.relname AS to_table, ta.attname AS to_column,
                    c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update
               FROM pg_constraint c
               JOIN pg_class src ON src.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = src.relnamespace
               JOIN pg_class tgt ON tgt.oid = c.confrelid JOIN pg_namespace nt ON nt.oid = tgt.relnamespace
              CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(src_att, tgt_att)
               JOIN pg_attribute sa ON sa.attrelid = c.conrelid AND sa.attnum = k.src_att
               JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = k.tgt_att
              WHERE c.contype = 'f' AND ns.nspname = $1 AND nt.nspname = $1`,
  mysql: `SELECT k.table_name AS from_table, k.column_name AS from_column, k.referenced_table_name AS to_table,
                 k.referenced_column_name AS to_column, r.delete_rule AS on_delete, r.update_rule AS on_update
            FROM information_schema.key_column_usage k
            JOIN information_schema.referential_constraints r
              ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
           WHERE k.table_schema = ? AND k.referenced_table_name IS NOT NULL`,
  tsql: `SELECT tp.name AS from_table, cp.name AS from_column, tr.name AS to_table, cr.name AS to_column,
                REPLACE(fk.delete_referential_action_desc, '_', ' ') AS on_delete, REPLACE(fk.update_referential_action_desc, '_', ' ') AS on_update
           FROM sys.foreign_keys fk
           JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
           JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
           JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
           JOIN sys.schemas s ON s.schema_id = tp.schema_id
          WHERE s.name = @p1`,
  oracle: `SELECT a.table_name AS "from_table", a.column_name AS "from_column", b.table_name AS "to_table", b.column_name AS "to_column",
                  c.delete_rule AS "on_delete", 'NO ACTION' AS "on_update"
             FROM all_cons_columns a
             JOIN all_constraints c ON a.owner = c.owner AND a.constraint_name = c.constraint_name
             JOIN all_cons_columns b ON c.r_owner = b.owner AND c.r_constraint_name = b.constraint_name AND a.position = b.position
            WHERE c.constraint_type = 'R' AND a.owner = :1`,
};

export async function foreignKeysOf(ctx: ReadContext): Promise<ForeignKey[] | null> {
  if (ctx.manifest.transport.kind !== 'sql') return null;
  const t = ctx.manifest.transport;
  const text = KEYS[t.grammar];
  if (!text) return null;
  const rows = await run(ctx, text, [await schemaOf(ctx)]);
  const action = (v: unknown): ReferentialAction => PG_ACTION[String(v)] ?? WORDS[String(v).toUpperCase()] ?? 'no_action';
  return rows.map((r) => ({
    fromTable: String(r.from_table),
    fromColumn: String(r.from_column),
    toTable: String(r.to_table),
    toColumn: String(r.to_column),
    onDelete: action(r.on_delete),
    onUpdate: action(r.on_update),
  }));
}

/**
 * A few rows of the columns a table HAS, for judging whether a field's meaning
 * moved. Named from the catalogue, not the connector, so a renamed column is
 * observed rather than failing the read that would have seen it.
 */
export async function sampleRows(ctx: ReadContext, table: string, columns: string[], limit: number): Promise<Array<Record<string, unknown>>> {
  if (ctx.manifest.transport.kind !== 'sql' || columns.length === 0) return [];
  const grammar = GRAMMARS[ctx.manifest.transport.grammar];
  const statement = buildSelect(grammar, { schema: await schemaOf(ctx), table, statement: null, columns, where: [], order: [], limit });
  return run(ctx, statement.text, statement.values);
}
