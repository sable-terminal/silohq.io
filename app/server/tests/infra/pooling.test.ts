// Pooling (spec 8.2): services reach Postgres through PgBouncer in transaction mode, so a
// server connection serves a different client after every transaction. These tests run
// through the pooler and prove that tenant context, the time zone and the timeouts all
// live and die with their transaction, and that row-level security still sees the
// service's own role.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { createPool, inTransaction } from '../../src/infra/postgres.infra.ts';
import { createLocalCell, createOrganisation } from '../db/fixtures.helper.ts';
import { createHarness, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from './services.helper.ts';

let h: Harness;
const pools: pg.Pool[] = [];
let orgA: string;
let orgB: string;

// A service pool whose URL points at the pooler, as PG_CONTROL_URL does in a cell.
function pooled(login: string, statementTimeoutMs = 30_000): pg.Pool {
  const pool = createPool({
    controlUrl: `postgres://${login}:test@${LOCAL.pgbouncerHost}/${h.cell}`,
    poolMax: 8, statementTimeoutMs, idleInTransactionTimeoutMs: 10_000, connectionTimeoutMs: 5_000, ssl: 'disable',
  }, 'control', 'executor');
  pools.push(pool);
  return pool;
}

before(async () => {
  h = await createHarness();
  const app = await h.connect('test_app');
  await createLocalCell(await h.connect('test_migrate'));
  orgA = await createOrganisation(app, 'pooled-a');
  orgB = await createOrganisation(app, 'pooled-b');
});

after(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await h?.close();
});

describe('through the transaction-mode pooler', () => {
  test('a transaction runs in UTC with its timeouts, and none of it outlives the transaction', async () => {
    const pool = pooled('test_app');
    const inside = await inTransaction(pool, { organisationId: orgA }, async (db) => (await db.query(`
      select current_setting('TimeZone') as tz, current_setting('statement_timeout') as st,
             current_setting('idle_in_transaction_session_timeout') as it, now() as now`)).rows[0]);
    assert.deepEqual({ ...inside, now: undefined }, { tz: 'UTC', st: '30s', it: '10s', now: undefined });
    assert.match(inside.now, /\+00:00$/);

    const outside = (await pool.query(`select current_setting('statement_timeout') as st,
      current_setting('TimeZone') as tz`)).rows[0];
    assert.deepEqual(outside, { st: '0', tz: 'UTC' }, 'the database default is UTC; the timeout was transaction-local');
  });

  test('tenant context never reaches the next client of a shared server connection', async () => {
    const pool = pooled('test_app');
    const pidsByOrg = new Map<string, Set<number>>([[orgA, new Set()], [orgB, new Set()]]);
    for (let i = 0; i < 40; i += 1) {
      const org = i % 2 === 0 ? orgA : orgB;
      const seen = await inTransaction(pool, { organisationId: org }, async (db) => (await db.query(`
        select pg_backend_pid() as pid, current_setting('app.org_id') as org,
               (select count(*)::int from iam.organisations) as visible`)).rows[0]);
      assert.equal(seen.org, org);
      assert.equal(seen.visible, 1, 'row-level security sees only the transaction\'s organisation');
      pidsByOrg.get(org)!.add(seen.pid);

      const after = (await pool.query(`select current_setting('app.org_id', true) as org`)).rows[0];
      assert.ok(after.org === null || after.org === '', 'no tenant context outside a transaction');
    }
    const shared = [...pidsByOrg.get(orgA)!].filter((pid) => pidsByOrg.get(orgB)!.has(pid));
    assert.ok(shared.length > 0, 'one server connection served both organisations, so the check above was real');
  });

  test('concurrent transactions for different organisations never see each other', async () => {
    const pool = pooled('test_app');
    const runs = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? orgA : orgB)).map((org) =>
      inTransaction(pool, { organisationId: org }, async (db) => {
        const { rows } = await db.query(`select pg_sleep(0.01), current_setting('app.org_id') as org,
          array(select id::text from iam.organisations) as ids`);
        return { org, seen: rows[0].org as string, ids: rows[0].ids as string[] };
      }));
    for (const { org, seen, ids } of await Promise.all(runs)) {
      assert.equal(seen, org);
      assert.deepEqual(ids, [org]);
    }
  });

  test('a statement over its timeout is cancelled by the server', async () => {
    const pool = pooled('test_app', 200);
    await assert.rejects(inTransaction(pool, { organisationId: orgA }, (db) => db.query('select pg_sleep(1)')),
      { category: 'timeout', code: 'db.57014' });
    assert.deepEqual((await pool.query('select 1 as ok')).rows, [{ ok: 1 }], 'the pool recovers');
  });

  test('services cannot create temporary tables, which outlive a transaction', async () => {
    const pool = pooled('test_app');
    await assert.rejects(inTransaction(pool, { organisationId: orgA }, (db) => db.query('create temp table t (x int)')),
      { category: 'forbidden', code: 'db.42501' });
  });
});
