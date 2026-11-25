// The Postgres adapter under failure (spec 8.2, 12): a dropped connection never ends the
// process, a deadlock is retried, a full pool sheds load with a retry time, failures
// arrive as AppErrors, the reporting replica is read-only, the pools report gauges, and
// shutdown waits for in-flight transactions.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { metrics } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import pg from 'pg';
import type { PostgresConfig } from '../../src/config/postgres.config.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import {
  closePool, createPool, inTransaction, openDatabases, pingPostgres, type PoolOptions,
} from '../../src/infra/postgres.infra.ts';
import { DEFAULT_ADMIN_URL } from '../../src/db/scripts/bootstrapLocal.script.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { createLocalCell, createOrganisation } from '../db/fixtures.helper.ts';
import { createHarness, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from './services.helper.ts';

class TestReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}
const reader = new TestReader();
// Before any pool exists: gauges register with the provider current at creation.
metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));

async function collected(name: string): Promise<{ attributes: Record<string, unknown>; value: number }[]> {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric) => metric.dataPoints.map((point) => ({ attributes: point.attributes, value: point.value as number })));
}

const ADMIN_URL = process.env['TEST_PG_ADMIN_URL'] ?? DEFAULT_ADMIN_URL;
const DIRECT_HOST = new URL(ADMIN_URL).host;

let h: Harness;
let admin: pg.Client;
let orgA: string;
const lines: string[] = [];
const logger = createLogger({ service: 'executor', cell: 'uk-lon-1', release: 'test', level: 'debug', write: (line) => lines.push(line) });
const open: pg.Pool[] = [];

const config = (overrides: Partial<PostgresConfig> = {}): PostgresConfig => ({
  controlUrl: `postgres://test_app:test@${LOCAL.pgbouncerHost}/${h.cell}`,
  poolMax: 4, statementTimeoutMs: 30_000, idleInTransactionTimeoutMs: 10_000, connectionTimeoutMs: 5_000, ssl: 'disable',
  ...overrides,
});

function pool(overrides: Partial<PostgresConfig> = {}, service = 'executor', target: 'control' | 'report' = 'control',
  options: PoolOptions = { logger }): pg.Pool {
  const created = createPool(config(overrides), target, service, options);
  open.push(created);
  return created;
}

// Straight to Postgres, not the pooler, so the test can end this pool's own backends.
const direct = (service: string): pg.Pool => pool({ controlUrl: `postgres://test_app:test@${DIRECT_HOST}/${h.cell}` }, service);

before(async () => {
  h = await createHarness();
  await createLocalCell(await h.connect('test_migrate'));
  orgA = await createOrganisation(await h.connect('test_app'), 'pg-adapter');
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
});

after(async () => {
  await Promise.all(open.map((p) => closePool(p).catch(() => undefined)));
  await admin?.end();
  await h?.close();
});

const logged = (event: string) => lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l['event'] === event);

describe('a lost connection', () => {
  test('an idle connection that drops does not end the process; the next checkout reconnects', async () => {
    const service = `idle-${randomBytes(4).toString('hex')}`;
    const p = direct(service);
    await pingPostgres(p);
    assert.equal(p.idleCount, 1);
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [service]);
    for (let i = 0; i < 40 && logged('db_pool.idle_connection_lost').length === 0; i += 1) await sleep(50);

    const [entry] = logged('db_pool.idle_connection_lost');
    assert.ok(entry, 'the drop was logged');
    assert.equal(entry['errorCategory'], 'unavailable');
    assert.equal(entry['dependency'], 'postgres.control');
    assert.ok(!lines.join('\n').includes('terminating connection'), 'the driver message is never logged');
    assert.equal(p.totalCount, 0, 'the pool discarded the client');
    await pingPostgres(p);
  });

  test('a connection lost mid-transaction fails that transaction only, and is never reused', async () => {
    const p = direct(`midtx-${randomBytes(4).toString('hex')}`);
    await assert.rejects(inTransaction(p, { organisationId: orgA }, async (db) => {
      const { rows } = await db.query('select pg_backend_pid() as pid');
      await admin.query('select pg_terminate_backend($1)', [rows[0].pid]);
      await sleep(200); // the loss arrives between statements, as an event on the client
      return db.query('select 1');
    }), { category: 'unavailable' });
    assert.equal(p.totalCount, 0, 'the broken client was destroyed, not returned');
    const seen = await inTransaction(p, { organisationId: orgA }, async (db) => (await db.query('select count(*)::int as n from iam.organisations')).rows[0].n);
    assert.equal(seen, 1);
  });
});

describe('retries', () => {
  // Two transactions take two transaction-scoped locks in opposite orders. Postgres
  // aborts one with deadlock_detected (40P01) after deadlock_timeout (1 second).
  const deadlock = async (attempts?: number) => {
    const p = pool();
    const [first, second] = [Number(randomBytes(4).readUInt32BE()), Number(randomBytes(4).readUInt32BE())];
    let arrived = 0;
    let both!: () => void;
    const barrier = new Promise<void>((resolve) => { both = resolve; });
    const counts = [0, 0];
    const run = (index: number, a: number, b: number) => inTransaction(p, {}, async (db) => {
      counts[index]! += 1;
      await db.query('select pg_advisory_xact_lock($1)', [a]);
      if (counts[index] === 1) {
        arrived += 1;
        if (arrived === 2) both();
        await barrier;
      }
      await db.query('select pg_advisory_xact_lock($1)', [b]);
      return counts[index];
    }, attempts === undefined ? {} : { attempts });
    return { results: await Promise.allSettled([run(0, first, second), run(1, second, first)]), counts };
  };

  test('a deadlocked transaction runs again from the start and succeeds', async () => {
    const { results, counts } = await deadlock();
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual([...counts].sort(), [1, 2], 'the loser ran twice, the winner once');
    const retried = logged('db_transaction.retried');
    assert.equal(retried.at(-1)?.['sqlstate'], '40P01');
    const counted = await collected('silo.db_transaction_retries');
    assert.ok(counted.some((point) => point.attributes['sqlstate'] === '40P01' && point.value >= 1));
  });

  test('with retries exhausted, the conflict reaches the caller as a retryable AppError', async () => {
    const { results } = await deadlock(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason.category, 'conflict');
    assert.equal(rejected[0]!.reason.code, 'db.40P01');
    assert.equal(rejected[0]!.reason.retryable, true);
  });

  test('the work\'s own errors are neither retried nor rewritten', async () => {
    const p = pool();
    let runs = 0;
    const mine = new TypeError('a bug in the work');
    await assert.rejects(inTransaction(p, {}, async () => {
      runs += 1;
      throw mine;
    }), (error) => error === mine);
    assert.equal(runs, 1);
  });
});

describe('failures as AppErrors', () => {
  test('a full pool sheds load with a retry time instead of queueing forever (spec 12.4)', async () => {
    const p = pool({ poolMax: 1, connectionTimeoutMs: 200 });
    const holding = inTransaction(p, {}, (db) => db.query('select pg_sleep(0.6)'));
    await sleep(50);
    await assert.rejects(inTransaction(p, {}, (db) => db.query('select 1')), (error: Record<string, unknown> & { refusal?: boolean }) => {
      assert.equal(error['category'], 'capacity');
      assert.equal(error['code'], 'postgres.pool_exhausted');
      assert.equal(error['retryAfterSeconds'], 1);
      assert.equal(error.refusal, true);
      return true;
    });
    await holding;
  });

  test('an unreachable database is unavailable; a refused login is a configuration error', async () => {
    const unreachable = pool({ controlUrl: 'postgres://test_app:test@127.0.0.1:9/nowhere', connectionTimeoutMs: 1_000 });
    await assert.rejects(inTransaction(unreachable, {}, (db) => db.query('select 1')), { category: 'unavailable' });
    await assert.rejects(pingPostgres(unreachable), { category: 'unavailable' });
    const refused = pool({ controlUrl: `postgres://test_app:wrong@${DIRECT_HOST}/${h.cell}` });
    await assert.rejects(inTransaction(refused, {}, (db) => db.query('select 1')), { category: 'configuration', code: 'db.28P01' });
  });

  test('a constraint violation is mapped, keeping the constraint name and dropping the values', async () => {
    const p = pool();
    await assert.rejects(inTransaction(p, { organisationId: orgA }, (db) => db.query(
      `update iam.organisations set financial_year_start_month = 13 where id = $1`, [orgA])), (error: Record<string, unknown>) => {
      assert.equal(error['category'], 'validation');
      assert.equal(error['code'], 'db.23514');
      assert.ok(!String(error['message']).includes('13'));
      return true;
    });
  });
});

describe('read-only transactions', () => {
  test('every transaction on the report pool is read-only', async () => {
    const report = pool({ reportUrl: `postgres://test_app:test@${LOCAL.pgbouncerHost}/${h.cell}` }, 'admin-portal', 'report');
    const mode = await inTransaction(report, { organisationId: orgA }, async (db) =>
      (await db.query(`select current_setting('transaction_read_only') as ro`)).rows[0].ro);
    assert.equal(mode, 'on');
    await assert.rejects(inTransaction(report, { organisationId: orgA }, (db) => db.query(
      `update iam.organisations set name = 'x' where id = $1`, [orgA])), { code: 'db.25006' });
  });

  test('a control transaction is read-write unless asked otherwise', async () => {
    const control = pool();
    const read = (readOnly?: boolean) => inTransaction(control, { organisationId: orgA }, async (db) =>
      (await db.query(`select current_setting('transaction_read_only') as ro`)).rows[0].ro, readOnly === undefined ? {} : { readOnly });
    assert.equal(await read(), 'off');
    assert.equal(await read(true), 'on');
  });
});

describe('metrics', () => {
  test('the pool reports its connections by state and its waiting callers', async () => {
    const service = `gauge-${randomBytes(4).toString('hex')}`;
    const p = pool({}, service);
    await pingPostgres(p);
    const connections = (await collected('silo.db_pool.connections')).filter((point) => point.attributes['service'] === service);
    assert.deepEqual(connections.map((point) => [point.attributes['state'], point.value]).sort(), [['busy', 0], ['idle', 1]]);
    const waiting = (await collected('silo.db_pool.waiting')).filter((point) => point.attributes['service'] === service);
    assert.deepEqual(waiting.map((point) => [point.attributes['target'], point.value]), [['control', 0]]);
  });
});

describe('the database registry', () => {
  const both = () => config({ reportUrl: `postgres://test_app:test@${LOCAL.pgbouncerHost}/${h.cell}` });

  test('opens the databases a service names, checks each, and refuses one it did not open', async () => {
    const dbs = openDatabases(both(), 'admin-portal', ['control', 'report'], { logger });
    try {
      assert.ok(dbs.control && dbs.report);
      assert.equal(dbs.directory, undefined);
      assert.throws(() => dbs.pool('directory'), { category: 'configuration' });
      const checks = dbs.healthChecks();
      assert.deepEqual(checks.map((c) => c.name), ['postgres.control', 'postgres.report']);
      await Promise.all(checks.map((c) => c.check(new AbortController().signal)));
    } finally {
      await dbs.close();
    }
    assert.throws(() => openDatabases(config(), 'directory', ['directory']), { category: 'configuration', code: 'config.postgres.directory' });
  });

  test('close waits for in-flight transactions, then refuses new ones', async () => {
    const dbs = openDatabases(both(), 'executor', ['control']);
    const id = uuidv7();
    const inFlight = inTransaction(dbs.pool('control'), { organisationId: orgA }, async (db) => {
      await db.query('select pg_sleep(0.3)');
      return id;
    });
    await sleep(50);
    assert.equal(await dbs.close(), true);
    assert.equal(await inFlight, id, 'the transaction finished before the pool closed');
    await assert.rejects(inTransaction(dbs.pool('control'), {}, (db) => db.query('select 1')),
      { category: 'unavailable', code: 'postgres.pool_closed' });
  });

  test('close gives up after its timeout rather than hang a shutdown', async () => {
    const dbs = openDatabases(both(), 'executor', ['control'], { logger });
    const slow = inTransaction(dbs.pool('control'), {}, (db) => db.query('select pg_sleep(0.8)'));
    await sleep(50);
    assert.equal(await dbs.close(100), false);
    assert.equal(logged('db_pool.close_timeout').length >= 1, true);
    await slow;
  });
});
