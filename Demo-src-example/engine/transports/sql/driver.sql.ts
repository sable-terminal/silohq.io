import { createHash } from 'node:crypto';
import { Pool as PgPool, types as pgTypes, type PoolConfig } from 'pg';
import { BlockedAddress, privateSourcesAllowed, resolveGuarded } from '../../../infra/network.infra';
import { refusal } from '../../../utils/error.util';
import type { ResolvedTls } from '../contract.transport';
import type { Grammar } from './grammar.sql';
import type { Statement } from './statement.sql';

/**
 * Opening a database connection and running one statement on it.
 *
 * ── ONE FUNCTION PER DRIVER, AND NOTHING ABOVE IT KNOWS WHICH ─────────────
 *
 * `pg`, `mysql2`, `mssql` and `oracledb` are pure JavaScript and run on Silo
 * and in the agent alike. ODBC needs native drivers the customer installs, so
 * it runs only inside the agent (MANIFEST-V2 §9.5).
 *
 * ── A READ CANNOT WRITE ───────────────────────────────────────────────────
 *
 * Every read runs inside the grammar's read-only transaction — or, where the
 * database has none, inside one that is always rolled back — so a view
 * statement that calls a function with side effects fails rather than acting.
 *
 * ── THE ADDRESS CHECKED IS THE ADDRESS CONNECTED TO ───────────────────────
 *
 * From Silo, the host is resolved and every address checked against the
 * private and metadata ranges before a socket opens; `pg` and `mysql2` then
 * connect to the checked address with the name kept for TLS verification.
 * Inside the agent the target is private by design and the agent's own
 * allow-list is the guard.
 */

export interface SqlConnection {
  driver: 'pg' | 'mysql2' | 'mssql' | 'oracledb' | 'odbc';
  host: string | null;
  port: number | null;
  database: string | null;
  serviceName: string | null;
  sid: string | null;
  connectString: string | null;
  options: Record<string, string>;
  username: string | null;
  password: string | null;
  tls: ResolvedTls;
}

export interface RunOptions {
  mode: 'read' | 'write';
  grammar: Grammar;
  timeoutMs: number;
  /** Rows beyond this are not read from the cursor; the caller refuses at the ceiling. */
  maxRows: number;
  /** True only inside a customer's agent. */
  inAgent: boolean;
  connectionId: string | null;
}

export interface DriverResult {
  rows: Array<Record<string, unknown>>;
  /** Rows a write touched, where the driver says; null when it cannot. */
  affected: number | null;
}

export interface Driver {
  run(connection: SqlConnection, statement: Statement, options: RunOptions): Promise<DriverResult>;
  /** SQLSTATE or the vendor's code, whichever the error carries. */
  codeOf(error: unknown): string | null;
}

/* ── Shared ─────────────────────────────────────────────────────────────── */

/**
 * A pool per connection, credential AND route. A rotated password never reuses
 * a socket opened with the old one, and a pool opened inside the customer's
 * network — unguarded, perhaps without TLS — never serves a request from Silo.
 */
const keyOf = (connectionId: string | null, connection: SqlConnection, inAgent: boolean) =>
  `${inAgent ? 'agent' : 'silo'}:${connectionId ?? 'anon'}:${createHash('sha256').update(JSON.stringify(connection)).digest('hex').slice(0, 24)}`;

async function addressFor(connection: SqlConnection, inAgent: boolean): Promise<string> {
  if (!connection.host) throw refusal({ message: 'This database connection has no host.', code: 'refusal.request_unbuildable' });
  if (inAgent) return connection.host;
  try {
    const [first] = await resolveGuarded(connection.host);
    return first!.address;
  } catch (error) {
    if (error instanceof BlockedAddress) {
      throw refusal({
        message: `${connection.host} is a private address, which Silo does not connect to directly. Reach it through the Silo agent.`,
        code: 'refusal.blocked_host',
        detail: { host: connection.host },
      });
    }
    throw error;
  }
}

/**
 * TLS for a database. From Silo it is required — a database password never
 * crosses the internet in the clear. Inside the agent it is used when the
 * connector declares a CA or client certificate, and otherwise left to the
 * database, which is on the customer's own network.
 */
function tlsFor(connection: SqlConnection, inAgent: boolean): Record<string, unknown> | false {
  const t = connection.tls;
  const declared = Boolean(t.ca || t.cert || t.fingerprint);
  /* Inside the customer's network — or a laptop's, in development — TLS is the database's choice. */
  if ((inAgent || privateSourcesAllowed()) && !declared) return false;
  return {
    rejectUnauthorized: true,
    minVersion: t.minVersion,
    ...(t.ca ? { ca: t.ca } : {}),
    ...(t.cert ? { cert: t.cert, key: t.key } : {}),
    servername: t.servername ?? connection.host ?? undefined,
  };
}

/** Values as JSON will carry them: dates as ISO 8601, bytes as base64, big integers as text. */
export function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) out[name] = plainValue(value);
  return out;
}

/*
 * ── A DATE IS A DAY, AND A TIMESTAMP WITHOUT A ZONE IS READ AS UTC ────────
 *
 * Every driver's default turns a `DATE` into midnight in the reading process's
 * own time zone, so `2026-09-01` read in London in summer came out as
 * `2026-08-31T23:00:00.000Z` — and the same connection read by an agent in
 * another zone answered differently again. A date is returned as the day it
 * is; a timestamp that carries no zone is read as UTC wherever it is read, so
 * Silo and every agent agree on it.
 */
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/** A zoneless timestamp's text as ISO 8601 in UTC; anything else — `infinity` — unchanged. */
function wallClockAsUtc(text: string): string {
  const m = WALL_CLOCK.exec(text);
  return m ? `${m[1]}T${m[2]}Z` : text;
}

/** A `Date` a driver built from local wall-clock fields, read back as those fields in UTC. */
function localFieldsAsUtc(value: Date): Date {
  return new Date(
    Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
      value.getMilliseconds(),
    ),
  );
}

const PG_DATE = 1082;
const PG_TIMESTAMP = 1114;
const PG_DATE_ARRAY = 1182;
const PG_TIMESTAMP_ARRAY = 1115;
const PG_TEXT_ARRAY = 1009;

/** An array's elements as text, by the parser `text[]` already uses. */
const textArray = (text: string): Array<string | null> =>
  (pgTypes.getTypeParser(PG_TEXT_ARRAY as never) as (t: string) => Array<string | null>)(text);

const pgTypeParsers: NonNullable<PoolConfig['types']> = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (format !== 'binary') {
      if (oid === PG_DATE) return (text: string) => text;
      if (oid === PG_TIMESTAMP) return wallClockAsUtc;
      if (oid === PG_DATE_ARRAY || oid === PG_TIMESTAMP_ARRAY) {
        const each = oid === PG_DATE_ARRAY ? (t: string) => t : wallClockAsUtc;
        return (text: string) => textArray(text).map((t) => (t === null ? null : each(t)));
      }
    }
    return pgTypes.getTypeParser(oid, format as 'text');
  }) as NonNullable<PoolConfig['types']>['getTypeParser'],
};

function plainValue(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(plainValue);
  return value;
}

/* ── Postgres ───────────────────────────────────────────────────────────── */

const pgPools = new Map<string, PgPool>();

const pg: Driver = {
  async run(connection, statement, options) {
    const key = keyOf(options.connectionId, connection, options.inAgent);
    let pool = pgPools.get(key);
    if (!pool) {
      const config: PoolConfig = {
        host: await addressFor(connection, options.inAgent),
        port: connection.port ?? 5432,
        database: connection.database ?? undefined,
        user: connection.username ?? undefined,
        password: connection.password ?? undefined,
        ssl: tlsFor(connection, options.inAgent) as PoolConfig['ssl'],
        max: 4,
        connectionTimeoutMillis: Number(connection.options.connectTimeoutSeconds ?? 10) * 1_000,
        application_name: connection.options.applicationName ?? 'silo',
        types: pgTypeParsers,
      };
      pool = new PgPool(config);
      pool.on('error', () => pgPools.delete(key));
      pgPools.set(key, pool);
    }
    const client = await pool.connect();
    try {
      const begin = options.mode === 'read' ? options.grammar.readOnly.begin : ['BEGIN'];
      for (const one of begin) await client.query(one);
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(options.timeoutMs)}`);
      const result = await client.query(statement.text, statement.values);
      await client.query(options.mode === 'read' ? options.grammar.readOnly.end : 'COMMIT');
      return { rows: result.rows.slice(0, options.maxRows + 1).map(plainRow), affected: result.rowCount ?? null };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
  codeOf: (error) => ((error as { code?: unknown }).code ? String((error as { code: unknown }).code) : null),
};

/* ── MySQL and MariaDB ──────────────────────────────────────────────────── */

const mysqlPools = new Map<string, import('mysql2/promise').Pool>();

const mysql: Driver = {
  async run(connection, statement, options) {
    const { createPool } = await import('mysql2/promise');
    const key = keyOf(options.connectionId, connection, options.inAgent);
    let pool = mysqlPools.get(key);
    if (!pool) {
      const ssl = tlsFor(connection, options.inAgent);
      pool = createPool({
        host: await addressFor(connection, options.inAgent),
        port: connection.port ?? 3306,
        database: connection.database ?? undefined,
        user: connection.username ?? undefined,
        password: connection.password ?? undefined,
        ...(ssl ? { ssl: ssl as never } : {}),
        connectionLimit: 4,
        connectTimeout: Number(connection.options.connectTimeoutSeconds ?? 10) * 1_000,
        /* Never LOAD DATA LOCAL: a server could ask for any file on the reader's disk. */
        infileStreamFactory: undefined,
        multipleStatements: false,
        /* A DATE as its day; DATETIME and TIMESTAMP read as UTC, not as the reader's zone. */
        dateStrings: ['DATE'],
        timezone: 'Z',
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
      mysqlPools.set(key, pool);
    }
    const conn = await pool.getConnection();
    try {
      await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.floor(options.timeoutMs)}`).catch(() => {});
      const begin = options.mode === 'read' ? options.grammar.readOnly.begin : ['START TRANSACTION'];
      for (const one of begin) await conn.query(one);
      const [rows] = await conn.query({ sql: statement.text, values: statement.values, timeout: options.timeoutMs });
      await conn.query(options.mode === 'read' ? options.grammar.readOnly.end : 'COMMIT');
      if (!Array.isArray(rows)) return { rows: [], affected: (rows as { affectedRows?: number }).affectedRows ?? null };
      return { rows: (rows as Array<Record<string, unknown>>).slice(0, options.maxRows + 1).map(plainRow), affected: null };
    } catch (error) {
      await conn.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  },
  codeOf: (error) => {
    const e = error as { code?: unknown; sqlState?: unknown };
    return e.code ? String(e.code) : e.sqlState ? String(e.sqlState) : null;
  },
};

/* ── SQL Server ─────────────────────────────────────────────────────────── */

const mssqlPools = new Map<string, import('mssql').ConnectionPool>();

const mssql: Driver = {
  async run(connection, statement, options) {
    const sql = await import('mssql');
    const key = keyOf(options.connectionId, connection, options.inAgent);
    let pool = mssqlPools.get(key);
    if (!pool) {
      if (!options.inAgent) await addressFor(connection, false);
      const tls = connection.tls;
      pool = new sql.ConnectionPool({
        server: connection.host ?? '',
        port: connection.port ?? 1433,
        database: connection.database ?? undefined,
        user: connection.username ?? undefined,
        password: connection.password ?? undefined,
        requestTimeout: options.timeoutMs,
        connectionTimeout: Number(connection.options.connectTimeoutSeconds ?? 10) * 1_000,
        pool: { max: 4 },
        options: {
          encrypt: options.inAgent ? connection.options.encrypt !== 'false' : true,
          /* Zoneless DATETIMEs read as UTC — tedious's default, pinned so it cannot drift. */
          useUTC: true,
          trustServerCertificate: false,
          ...(connection.options.instanceName ? { instanceName: connection.options.instanceName } : {}),
          appName: connection.options.applicationName ?? 'silo',
          ...(tls.ca ? { cryptoCredentialsDetails: { ca: tls.ca, minVersion: tls.minVersion } } : { cryptoCredentialsDetails: { minVersion: tls.minVersion } }),
        },
      });
      await pool.connect();
      mssqlPools.set(key, pool);
    }
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const request = new sql.Request(transaction);
      statement.values.forEach((value, i) => request.input(`p${i + 1}`, value as never));
      const result = await request.query(statement.text);
      if (options.mode === 'read') await transaction.rollback();
      else await transaction.commit();
      /* A DATE column arrives as UTC midnight; it is a day, so it leaves as one. */
      const columns = (result.recordset as unknown as { columns?: Record<string, { type?: unknown }> } | undefined)?.columns ?? {};
      const days = Object.entries(columns)
        .filter(([, column]) => column.type === sql.Date)
        .map(([name]) => name);
      return {
        rows: (result.recordset ?? []).slice(0, options.maxRows + 1).map((row) => {
          const plain = plainRow(row as Record<string, unknown>);
          for (const name of days) if (typeof plain[name] === 'string') plain[name] = (plain[name] as string).slice(0, 10);
          return plain;
        }),
        affected: result.rowsAffected?.[0] ?? null,
      };
    } catch (error) {
      await transaction.rollback().catch(() => {});
      throw error;
    }
  },
  codeOf: (error) => {
    const e = error as { number?: unknown; code?: unknown; originalError?: { info?: { number?: unknown } } };
    const n = e.number ?? e.originalError?.info?.number;
    return n !== undefined ? String(n) : e.code ? String(e.code) : null;
  },
};

/* ── Oracle ─────────────────────────────────────────────────────────────── */

const oraclePools = new Map<string, import('oracledb').Pool>();

const oracle: Driver = {
  async run(connection, statement, options) {
    const oracledb = (await import('oracledb')).default;
    const key = keyOf(options.connectionId, connection, options.inAgent);
    let pool = oraclePools.get(key);
    if (!pool) {
      if (!options.inAgent && connection.host) await addressFor(connection, false);
      const connectString =
        connection.connectString ??
        (connection.serviceName
          ? `${connection.host}:${connection.port ?? 1521}/${connection.serviceName}`
          : connection.sid
            ? `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${connection.host})(PORT=${connection.port ?? 1521}))(CONNECT_DATA=(SID=${connection.sid})))`
            : `${connection.host}:${connection.port ?? 1521}/${connection.database ?? ''}`);
      pool = await oracledb.createPool({
        user: connection.username ?? undefined,
        password: connection.password ?? undefined,
        connectString,
        poolMax: 4,
        poolMin: 0,
        connectTimeout: Number(connection.options.connectTimeoutSeconds ?? 10),
      });
      oraclePools.set(key, pool);
    }
    const conn = await pool.getConnection();
    try {
      conn.callTimeout = options.timeoutMs;
      if (options.mode === 'read') for (const one of options.grammar.readOnly.begin) await conn.execute(one);
      const result = await conn.execute<Record<string, unknown>>(statement.text, statement.values as never[], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        maxRows: options.maxRows + 1,
        /*
         * A CLOB arrives as text rather than as a stream nobody reads. A DATE or
         * zoneless TIMESTAMP is built from the reading process's zone; its fields
         * are read back as UTC so Silo and every agent agree on it.
         */
        fetchTypeHandler: (meta) =>
          meta.dbType === oracledb.DB_TYPE_CLOB || meta.dbType === oracledb.DB_TYPE_NCLOB
            ? { type: oracledb.STRING }
            : meta.dbType === oracledb.DB_TYPE_DATE || meta.dbType === oracledb.DB_TYPE_TIMESTAMP
              ? { converter: (value: unknown) => (value instanceof Date ? localFieldsAsUtc(value) : value) }
              : undefined,
      });
      await conn.commit();
      return { rows: ((result.rows ?? []) as Array<Record<string, unknown>>).map(plainRow), affected: result.rowsAffected ?? null };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      await conn.close().catch(() => {});
    }
  },
  codeOf: (error) => {
    const e = error as { code?: unknown; message?: unknown };
    if (e.code) return String(e.code);
    const m = /^(ORA-\d{5}|NJS-\d{3})/.exec(String(e.message ?? ''));
    return m ? m[1]! : null;
  },
};

/* ── ODBC: the agent's ──────────────────────────────────────────────────── */

const odbcOnSilo: Driver = {
  async run() {
    throw refusal({
      message: 'ODBC runs inside your network, through the Silo agent, where the database drivers are installed.',
      code: 'refusal.agent_only',
    });
  },
  codeOf: () => null,
};

const DRIVERS: Record<SqlConnection['driver'], Driver> = { pg, mysql2: mysql, mssql, oracledb: oracle, odbc: odbcOnSilo };

/** The agent registers its ODBC driver here; Silo never does. */
export function registerOdbc(driver: Driver): void {
  DRIVERS.odbc = driver;
}

export const driverFor = (name: SqlConnection['driver']): Driver => DRIVERS[name];

export async function closeDatabasePools(): Promise<void> {
  await Promise.allSettled([
    ...[...pgPools.values()].map((p) => p.end()),
    ...[...mysqlPools.values()].map((p) => p.end()),
    ...[...mssqlPools.values()].map((p) => p.close()),
    ...[...oraclePools.values()].map((p) => p.close(0)),
  ]);
  pgPools.clear();
  mysqlPools.clear();
  mssqlPools.clear();
  oraclePools.clear();
}
