// Postgres: pools for pg-control, its reporting replica and the directory database, and
// the transaction every request runs in (spec 8.2, 64.3).
//
// "app.org_id and app.membership_id are set per transaction with set local, never set,
// so a pooled connection cannot carry tenant context into the next request. Pooling is
// transaction mode; session-scoped features are forbidden in application code" (spec
// 8.2). inTransaction is the only way services open one.
//
// Two pools stand between a service and Postgres: this process's pg.Pool (connections
// to the pooler) and PgBouncer in transaction mode (server connections shared by every
// replica of every service). A server connection serves a different client after each
// transaction, so nothing here depends on a session: no connection-time options (the
// pooler drops them), no SET, no session advisory locks, no LISTEN, no temp tables
// (tests/architecture/layers.test.ts checks). The database defaults to UTC; timeouts
// are set inside each transaction. Migration jobs need a session (SET ROLE, the
// migration lock) and connect to Postgres directly, never through the pooler.
//
// Failures reach callers as AppErrors (utils/errors.util.ts), never as driver errors,
// whose messages can carry row values (spec 13.1):
// - no free connection within PG_CONNECTION_TIMEOUT_MS: a capacity refusal with a retry
//   time (spec 12.4), not an error;
// - the database unreachable or the connection lost: unavailable;
// - a statement over its timeout: timeout;
// - a serialization failure or deadlock: the transaction is retried, then a conflict.

import { readFileSync } from 'node:fs';
import { metrics, type Attributes, type Counter, type ObservableResult } from '@opentelemetry/api';
import pg from 'pg';
import type { PostgresConfig } from '../config/postgres.config.ts';
import { AppError, fromDatabaseError, isAppError } from '../utils/errors.util.ts';
import { retry } from '../utils/retry.util.ts';
import { sleep } from '../utils/time.util.ts';
import type { HealthCheck } from './health.infra.ts';
import type { Logger } from './logger.infra.ts';

export type Queryable = Pick<pg.ClientBase, 'query'>;

// Values arrive exactly as Postgres holds them. A timestamp is an ISO 8601 string with
// microseconds, because a JavaScript Date keeps only milliseconds, and a ledger's key
// includes its timestamp: a Date read back would no longer find its own row. A date
// stays 'YYYY-MM-DD' (a Date would be local midnight, shifting it across time zones),
// an interval stays Postgres text, and bigint and numeric stay text (pg's default).
// Every session runs in UTC (the database default, and set again per transaction), so
// every timestamp ends +00:00.
const TIMESTAMPTZ_OID = 1184;
const DATE_OID = 1082;
const INTERVAL_OID = 1186;
const asText = (value: string): string => value;
const asIsoTimestamp = (value: string): string => value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');

export const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === TIMESTAMPTZ_OID) return asIsoTimestamp;
    if (oid === DATE_OID || oid === INTERVAL_OID) return asText;
    return pg.types.getTypeParser(oid, format);
  }) as typeof pg.types.getTypeParser,
};

// Connection settings every service connection uses. Nothing session-scoped: the time zone
// comes from the database default, which survives a transaction-mode pooler.
export const connectionDefaults = { types: typeParsers } as const;

export type PostgresTarget = 'control' | 'report' | 'directory';

const URL_FIELD: Record<PostgresTarget, 'controlUrl' | 'reportUrl' | 'directoryUrl'> = {
  control: 'controlUrl', report: 'reportUrl', directory: 'directoryUrl',
};

// What withTransaction sets on every transaction it opens.
export interface TransactionSettings {
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  /** BEGIN READ ONLY: every write in the transaction is refused (25006). */
  readOnly?: boolean;
}

interface PoolInfo {
  target: PostgresTarget;
  service: string;
  settings: TransactionSettings;
  logger: Logger | undefined;
  stopMetrics: () => void;
}

const poolInfo = new WeakMap<pg.Pool, PoolInfo>();

const meter = () => metrics.getMeter('silo');

// Created on first use, which comes after telemetry has started.
let counters: { connectionsLost: Counter; transactionRetries: Counter } | undefined;
const counter = () => (counters ??= {
  connectionsLost: meter().createCounter('silo.db_pool.connections_lost'),
  transactionRetries: meter().createCounter('silo.db_transaction_retries'),
});

export interface PoolOptions {
  /** Where a dropped idle connection and a retried transaction are logged. */
  logger?: Logger;
}

// A pool for one database, with the cell's timeouts and TLS. Its URL points at the
// pooler. The application name is the service (PgBouncer passes it through), so
// pg_stat_activity and pgaudit name who ran a statement. Every transaction on the
// report pool is read-only: it is the reporting replica (spec 7.1).
//
// Start telemetry before creating pools: the pool gauges register with the meter
// provider that is current at creation.
export function createPool(config: PostgresConfig, target: PostgresTarget, service: string, options: PoolOptions = {}): pg.Pool {
  const url = config[URL_FIELD[target]];
  if (url === undefined) {
    throw new AppError('configuration', `no ${target} database is configured`, { code: `config.postgres.${target}` });
  }
  const ssl = config.ssl === 'disable' ? undefined
    : config.ssl === 'require' ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true, ...(config.sslCaFile ? { ca: readFileSync(config.sslCaFile, 'utf8') } : {}) };
  const pool = new pg.Pool({
    connectionString: url,
    application_name: service,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    // Client-side backstop for a statement outside inTransaction; the server-side
    // timeout set per transaction fires first.
    query_timeout: config.statementTimeoutMs + 5_000,
    ...(ssl ? { ssl } : {}),
    ...connectionDefaults,
  });

  // An idle connection that drops (a pooler restart, the network) is emitted here. With
  // no listener, Node would end the process. The pool has already discarded the client;
  // the next checkout opens a new connection.
  pool.on('error', (error) => {
    options.logger?.failure('postgres connection dropped while idle', toAppError(error, target), {
      dependency: `postgres.${target}`, event: 'db_pool.idle_connection_lost',
    });
    counter().connectionsLost.add(1, { target, service });
  });

  poolInfo.set(pool, {
    target,
    service,
    settings: {
      statementTimeoutMs: config.statementTimeoutMs,
      idleInTransactionTimeoutMs: config.idleInTransactionTimeoutMs,
      readOnly: target === 'report',
    },
    logger: options.logger,
    stopMetrics: observePool(pool, target, service),
  });
  return pool;
}

// Gauges for the pool: connections by state, and callers waiting for one. Labels are the
// target and the service only (spec 13.1: no values in metric labels).
function observePool(pool: pg.Pool, target: PostgresTarget, service: string): () => void {
  const connections = meter().createObservableGauge('silo.db_pool.connections', {
    description: 'Connections from this process to the database pooler, by state',
  });
  const waiting = meter().createObservableGauge('silo.db_pool.waiting', {
    description: 'Callers waiting for a pooled connection',
  });
  const labels: Attributes = { target, service };
  const observeConnections = (result: ObservableResult): void => {
    result.observe(pool.idleCount, { ...labels, state: 'idle' });
    result.observe(pool.totalCount - pool.idleCount, { ...labels, state: 'busy' });
  };
  const observeWaiting = (result: ObservableResult): void => {
    result.observe(pool.waitingCount, labels);
  };
  connections.addCallback(observeConnections);
  waiting.addCallback(observeWaiting);
  return () => {
    connections.removeCallback(observeConnections);
    waiting.removeCallback(observeWaiting);
  };
}

// Ends a pool: new checkouts are refused, and the returned promise settles once every
// checked-out connection has been released and closed, so in-flight transactions finish.
export async function closePool(pool: pg.Pool): Promise<void> {
  poolInfo.get(pool)?.stopMetrics();
  if (!pool.ending) await pool.end();
}

// Who the request is for. Each value is set with SET LOCAL for the transaction only
// (spec 64.3), which is what row-level security reads. A tenant table refuses every
// statement when the organisation is missing.
export interface RequestContext {
  organisationId?: string;
  userId?: string;
  membershipId?: string;
  servicePrincipalId?: string;
  operatorSessionId?: string;
  /** A member of staff on a staff path (D45): set as app.operator_id, which staff-only writes require. */
  operatorId?: string;
  /** The session the request runs under. Set for row-level security as app.session_id. */
  sessionId?: string;
}

const SETTINGS: Record<keyof RequestContext, string> = {
  organisationId: 'app.org_id',
  userId: 'app.user_id',
  membershipId: 'app.membership_id',
  servicePrincipalId: 'app.service_principal_id',
  operatorSessionId: 'app.operator_session_id',
  operatorId: 'app.operator_id',
  sessionId: 'app.session_id',
};

// Runs work in one transaction on a client already checked out. Rolls back on error and
// rethrows the error as it came. Every setting is transaction-local, set_config(...,
// true), which is SET LOCAL with parameters, and all of them go in one round trip: the
// time zone, the timeouts (when given) and the request context. Services use
// inTransaction, which adds checkout, retries and error mapping.
export async function withTransaction<T>(
  client: pg.ClientBase,
  context: RequestContext,
  work: (db: Queryable) => Promise<T>,
  settings: TransactionSettings = {},
): Promise<T> {
  await client.query(settings.readOnly ? 'begin read only' : 'begin');
  try {
    const values: [string, string][] = [['TimeZone', 'UTC']];
    if (settings.statementTimeoutMs !== undefined) values.push(['statement_timeout', `${settings.statementTimeoutMs}ms`]);
    if (settings.idleInTransactionTimeoutMs !== undefined) {
      values.push(['idle_in_transaction_session_timeout', `${settings.idleInTransactionTimeoutMs}ms`]);
    }
    for (const [key, setting] of Object.entries(SETTINGS) as [keyof RequestContext, string][]) {
      const value = context[key];
      if (value !== undefined) values.push([setting, value]);
    }
    await client.query(
      `select ${values.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`).join(', ')}`,
      values.flat(),
    );
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

export interface InTransactionOptions {
  /** A read-only transaction. Always true on the report pool. */
  readOnly?: boolean;
  /** Total attempts when the transaction meets a serialization failure or deadlock. Default 3. */
  attempts?: number;
}

const DEFAULT_ATTEMPTS = 3;

// Checks out a connection, runs work in one transaction, and releases the connection.
//
// A serialization failure (40001) or deadlock (40P01) rolls the whole transaction back,
// so the work runs again from the start, up to `attempts` times with jittered backoff.
// That is safe only because work touches nothing but this transaction: an event goes
// through the outbox in the same transaction (spec 9.2), and a call to anything outside
// the database belongs after inTransaction returns.
export async function inTransaction<T>(
  pool: pg.Pool,
  context: RequestContext,
  work: (db: Queryable) => Promise<T>,
  options: InTransactionOptions = {},
): Promise<T> {
  const info = poolInfo.get(pool);
  const target = info?.target ?? 'control';
  const settings: TransactionSettings = { ...info?.settings, readOnly: info?.settings.readOnly || options.readOnly === true };

  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw toAcquireError(error, pool, target);
  }

  // While checked out, the pool's own listener is detached. A connection lost between
  // statements is emitted on the client, and with no listener Node would end the process.
  let lost: unknown;
  const onClientError = (error: unknown): void => {
    lost ??= error;
  };
  client.on('error', onClientError);
  try {
    return await retry(() => withTransaction(client, context, work, settings), {
      attempts: options.attempts ?? DEFAULT_ATTEMPTS,
      baseDelayMs: 20,
      maxDelayMs: 200,
      retryable: (error) => lost === undefined && isTransactionConflict(error),
      onRetry: (attempt, delayMs, error) => {
        const sqlstate = sqlstateOf(error);
        counter().transactionRetries.add(1, { target, sqlstate });
        info?.logger?.warn('postgres transaction retried', {
          dependency: `postgres.${target}`, event: 'db_transaction.retried', sqlstate, attempt, durationMs: delayMs,
        });
      },
    });
  } catch (error) {
    if (lost === undefined && isConnectionLost(error)) lost = error;
    throw toAppError(error, target);
  } finally {
    client.removeListener('error', onClientError);
    // A connection that failed is destroyed, never returned to the pool.
    client.release(lost === undefined ? undefined : lost instanceof Error ? lost : new Error('connection lost'));
  }
}

// For health checks: a round trip on a pooled connection.
export async function pingPostgres(pool: pg.Pool): Promise<void> {
  const target = poolInfo.get(pool)?.target ?? 'control';
  try {
    await pool.query('select 1');
  } catch (error) {
    throw toAppError(error, target);
  }
}

// ----------------------------------------------------------------------------- errors

const sqlstateOf = (error: unknown): string => {
  if (isAppError(error)) return typeof error.details['sqlstate'] === 'string' ? error.details['sqlstate'] : '';
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof pg.DatabaseError && typeof code === 'string' ? code : '';
};

function isTransactionConflict(error: unknown): boolean {
  const sqlstate = sqlstateOf(error);
  return sqlstate === '40001' || sqlstate === '40P01';
}

// The driver's own errors when the socket goes, which carry no SQLSTATE.
const CONNECTION_LOST = /^(Connection terminated|Client has encountered a connection error|Client was closed and is not queryable)/;
const SOCKET_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND']);

function isConnectionLost(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (error instanceof pg.DatabaseError) {
    return typeof code === 'string' && (code.startsWith('08') || ['57P01', '57P02', '57P03', '25P03'].includes(code));
  }
  return (typeof code === 'string' && SOCKET_ERRORS.has(code)) || CONNECTION_LOST.test(error.message);
}

// A database or driver error as an AppError. Anything else (the work's own errors) is
// returned unchanged.
function toAppError(error: unknown, target: PostgresTarget): unknown {
  if (isAppError(error)) return error;
  if (error instanceof pg.DatabaseError) {
    const sqlstate = error.code ?? '';
    // A refused login or a missing database is a deployment mistake, not an outage.
    if (sqlstate.startsWith('28') || sqlstate === '3D000') {
      return new AppError('configuration', 'the database refused this service\'s login', {
        code: `db.${sqlstate}`, details: { target, sqlstate }, cause: error,
      });
    }
    return fromDatabaseError(error);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && SOCKET_ERRORS.has(code)) return fromDatabaseError(error);
  if (isConnectionLost(error)) {
    return new AppError('unavailable', 'database connection lost', {
      code: 'postgres.connection_lost', details: { target }, cause: error,
    });
  }
  return error;
}

// pg-pool's checkout failures carry no code, only these messages.
function toAcquireError(error: unknown, pool: pg.Pool, target: PostgresTarget): unknown {
  const message = error instanceof Error ? error.message : '';
  if (message === 'timeout exceeded when trying to connect') {
    // Every connection was busy for the whole wait: shed load (spec 12.4).
    return new AppError('capacity', 'refused: no database connection free; retry after 1 second', {
      code: 'postgres.pool_exhausted', retryAfterSeconds: 1,
      details: { target, limit: pool.options.max ?? 0, waiting: pool.waitingCount },
      cause: error,
    });
  }
  if (message.startsWith('Connection terminated due to connection timeout')) {
    return new AppError('unavailable', 'database did not answer in time', {
      code: 'postgres.connect_timeout', details: { target }, cause: error,
    });
  }
  if (message === 'Cannot use a pool after calling end on the pool') {
    return new AppError('unavailable', 'database pool is closed', { code: 'postgres.pool_closed', details: { target }, cause: error });
  }
  const mapped = toAppError(error, target);
  return mapped === error
    ? new AppError('unavailable', 'database connection failed', { code: 'postgres.connect_failed', details: { target }, cause: error })
    : mapped;
}

// ----------------------------------------------------------------------------- registry

export interface Databases {
  readonly control: pg.Pool | undefined;
  readonly report: pg.Pool | undefined;
  readonly directory: pg.Pool | undefined;
  /** The pool for a target this service opened; a configuration error otherwise. */
  pool(target: PostgresTarget): pg.Pool;
  /** One readiness check per open database, named postgres.<target>. */
  healthChecks(): HealthCheck[];
  /**
   * Refuses new transactions and waits up to timeoutMs for in-flight ones to finish.
   * Resolves true when every pool closed in time.
   */
  close(timeoutMs?: number): Promise<boolean>;
}

// The databases a service uses, opened together at start-up and closed together on
// shutdown (SIGTERM: stop accepting requests, then close). Pools connect lazily, so
// opening never fails on an unreachable database; readiness reports that.
export function openDatabases(config: PostgresConfig, service: string, targets: readonly PostgresTarget[],
  options: PoolOptions = {}): Databases {
  const pools = new Map<PostgresTarget, pg.Pool>();
  try {
    for (const target of new Set(targets)) pools.set(target, createPool(config, target, service, options));
  } catch (error) {
    for (const pool of pools.values()) void closePool(pool);
    throw error;
  }
  return {
    control: pools.get('control'),
    report: pools.get('report'),
    directory: pools.get('directory'),
    pool(target) {
      const pool = pools.get(target);
      if (pool === undefined) {
        throw new AppError('configuration', `${service} did not open the ${target} database`, { code: `config.postgres.${target}` });
      }
      return pool;
    },
    healthChecks() {
      return [...pools].map(([target, pool]) => ({ name: `postgres.${target}`, check: () => pingPostgres(pool) }));
    },
    async close(timeoutMs = 10_000) {
      const deadline = new AbortController();
      const closed = Promise.all([...pools.values()].map(closePool)).then(() => true);
      const expired = sleep(timeoutMs, deadline.signal).then(() => false, () => false);
      const drained = await Promise.race([closed, expired]);
      deadline.abort();
      if (!drained) {
        options.logger?.warn('postgres pools did not drain before shutdown', { event: 'db_pool.close_timeout', durationMs: timeoutMs });
      }
      return drained;
    },
  };
}
