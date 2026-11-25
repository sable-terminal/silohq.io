// Oracle through the Silo Agent end to end (spec 10.4, 10.7, 14.4): the Go binary in agent/
// reads a customer's Oracle database (23ai Free) for connect-runtime, with a login it holds and
// with one the cell keeps and seals to it for the call; values come back as the cell reads them
// (a DATE holding a date reads as that date, NUMBER(1) as a boolean, RAW as hex); a read is one
// SELECT, in a transaction the server keeps read-only; a write runs only on a grant signed
// for exactly its statements and rolls back whole on a mismatch; Oracle's error numbers come back
// as the SQLSTATEs they stand for. Runs against the Oracle of `npm run sources:up`; skipped where
// it is not running or there is no Go toolchain.

import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createGrantSigner, statementsDigest } from '../../src/services/actions/grants.service.ts';
import { RowCountMismatch, SourceSqlError, tunnelChannel } from '../../src/services/connect-runtime/agent.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { hasGo, ORDERS, ORDERS_STEP, ordersManifest, reachable, run, SERVER_DIR, startAgentSource, type AgentSource } from './agentSource.helper.ts';
import { TEST_GRANT_KEYS } from './connect.helper.ts';

const PORT = 51521;
const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const owner = `agentdb_${suffix}`;
const user = `silo_agent_${suffix}`;
const skip = !hasGo ? 'no Go toolchain here' : !(await reachable(PORT)) ? 'no Oracle here (npm run sources:up)' : false;

/** SQL as Oracle's own SQL*Plus runs it in its container, as SYSTEM in FREEPDB1: the test's view of the customer's database. */
const sqlplus = async (script: string): Promise<string[]> => {
  const child = run('docker', ['compose', 'exec', '-T', 'oracle', 'sqlplus', '-s', '-L', 'system/local@//localhost/FREEPDB1'], { cwd: SERVER_DIR });
  child.child.stdin!.end(`whenever sqlerror exit failure\nset heading off feedback off pagesize 0 verify off\n${script}\nexit\n`);
  const { stdout } = await child;
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
};

let source: AgentSource;

describe('Oracle through the Silo Agent binary (spec 10.4, 10.7)', { skip }, () => {
  before(async () => {
    // The customer's schema, and the login they give the agent: it reads, and changes what grants change. The
    // login is an ordinary Oracle user (its name unquoted): Oracle's clients log on without regard to case.
    await sqlplus(`
      create user "${owner}" identified by "Owner-Secret1" quota unlimited on users;
      create table "${owner}"."orders" ("id" number(10) primary key, "region" varchar2(10) not null, "amount" number(12,2) not null,
        "placed" timestamp(3) not null, "shipped" date, "active" number(1) not null, "code" raw(4));
      insert into "${owner}"."orders" values (1, 'south', 10.50, timestamp '2026-11-01 10:00:00.250', date '2026-11-03', 1, hextoraw('CAFE'));
      insert into "${owner}"."orders" values (2, 'north', 21.00, timestamp '2026-11-01 11:00:00', null, 0, null);
      insert into "${owner}"."orders" values (3, 'south', 31.50, timestamp '2026-11-01 12:00:00', date '2026-11-04', 1, null);
      insert into "${owner}"."orders" values (4, 'north', 42.00, timestamp '2026-11-01 13:00:00', null, 1, null);
      commit;
      create user ${user} identified by "Agent-Oracle-Secret1";
      grant create session to ${user};
      grant select, update on "${owner}"."orders" to ${user};`);
    source = await startAgentSource({
      dialect: 'oracle', manifest: ordersManifest('oracle', owner),
      cellParameters: { host: '127.0.0.1', port: String(PORT), database: 'FREEPDB1', sslmode: 'prefer' },
      login: { username: user, password: 'Agent-Oracle-Secret1' },
      agentDsn: `oracle://${user}:Agent-Oracle-Secret1@127.0.0.1:${PORT}/FREEPDB1`,
    });
  });

  after(async () => {
    await source?.close();
    if (!skip) await sqlplus(`drop user ${user} cascade;\ndrop user "${owner}" cascade;`).catch(() => undefined);
  });

  test('reads, with the agent\'s own login and with the cell\'s: values as the cell reads them', async () => {
    assert.deepEqual((await source.read(source.agentHeld, ORDERS_STEP)).rows, ORDERS);
    assert.deepEqual((await source.read(source.cellHeld, ORDERS_STEP)).rows, ORDERS);
    assert.deepEqual((await source.read(source.cellHeld, { object: 'orders', fields: ['id'], filters: [{ field: 'region', op: 'eq', value: 'north' }],
      sort: [{ field: 'id', direction: 'asc' }] })).rows, [{ id: 2 }, { id: 4 }]);
    await assert.rejects(source.read(source.agentHeld, { object: 'missing' }), { category: 'not_found', code: 'source.not_found' }, 'ORA-00942 as 42S02, classified');
    assert.ok(!source.logs.join('').includes('south') && !source.logs.join('').includes('Agent-Oracle-Secret1'), 'the agent logs no values and no login');
  });

  test('a read cannot write; a granted write applies, and a mismatch rolls it all back', async () => {
    const channel = tunnelChannel(source.tunnels);
    const base = { organisationId: source.cell.org, connectionId: source.agentHeld, agentPoolId: source.poolId, dialect: 'oracle', timeoutMs: 10_000,
      signal: new AbortController().signal };
    await assert.rejects(channel.query({ ...base, maxRows: 10, statement: { text: `update "${owner}"."orders" set "amount" = 0 where "id" = :1`, values: [1] } }),
      (error: unknown) => error instanceof SourceSqlError && error.sqlstate === '42000', 'a read is one SELECT: refused before it runs');
    assert.deepEqual(await sqlplus(`select "amount" from "${owner}"."orders" where "id" = 1;`), ['10.5']);
    const signer = createGrantSigner(createPrivateKey(TEST_GRANT_KEYS.privateKey));
    const grantFor = (statements: { text: string; values: unknown[]; expectRows?: number }[]) => signer.sign({
      organisationId: source.cell.org, actionId: uuidv7(), actionKind: 'mutation', connectionId: source.agentHeld, object: 'orders',
      statements: statements.length, payloadSha256: statementsDigest(statements),
    });
    const update = (amount: number, id: number) => ({ text: `update "${owner}"."orders" set "amount" = :1 where "id" = :2`, values: [amount, id], expectRows: 1 });
    const write = [update(99.5, 1)];
    assert.deepEqual(await channel.transaction!({ ...base, statements: write, grant: grantFor(write) }), { rowCounts: [1] });
    assert.deepEqual(await sqlplus(`select "amount" from "${owner}"."orders" where "id" = 1;`), ['99.5']);
    const plan = [update(1, 2), update(1, 999)];
    await assert.rejects(channel.transaction!({ ...base, statements: plan, grant: grantFor(plan) }),
      (error: unknown) => error instanceof RowCountMismatch && error.index === 1 && error.rows === 0);
    assert.deepEqual(await sqlplus(`select "amount" from "${owner}"."orders" where "id" = 2;`), ['21'], 'the first statement rolled back with the second');
  });

  test('a cell-held login with the wrong password is the source\'s refusal, ORA-01017 as 28000', async () => {
    await source.setPassword(source.cellHeld, 'wrong');
    await assert.rejects(source.read(source.cellHeld, ORDERS_STEP), (error: { details?: Record<string, unknown> }) => String(error.details?.['sqlstate']) === '28000');
  });
});
