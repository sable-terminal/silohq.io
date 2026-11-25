// SQL Server through the Silo Agent end to end (spec 10.4, 10.7, 14.4): the Go binary in agent/
// reads a customer's SQL Server database for connect-runtime, with a login it holds and with one
// the cell keeps and seals to it for the call; values come back as the cell reads them; SQL
// Server has no read-only transaction, so a read is one SELECT, always rolled back, and anything
// else sent as a read is refused before it runs; a write runs only on a grant signed for exactly
// its statements and rolls back whole on a mismatch; SQL Server's error numbers come back as the
// SQLSTATEs they stand for. Runs against the SQL Server of `npm run sources:up`; skipped where it
// is not running or there is no Go toolchain.

import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createGrantSigner, statementsDigest } from '../../src/services/actions/grants.service.ts';
import { RowCountMismatch, SourceSqlError, tunnelChannel } from '../../src/services/connect-runtime/agent.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { hasGo, ORDERS, ORDERS_STEP, ordersManifest, reachable, run, SERVER_DIR, startAgentSource, type AgentSource } from './agentSource.helper.ts';
import { TEST_GRANT_KEYS } from './connect.helper.ts';

const PORT = 51433;
const database = `agentdb_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const skip = !hasGo ? 'no Go toolchain here' : !(await reachable(PORT)) ? 'no SQL Server here (npm run sources:up)' : false;

/** T-SQL as SQL Server's own client runs it in its container: the test's view of the customer's database. */
const tsql = async (batch: string, inDatabase = 'master'): Promise<string[][]> => {
  const { stdout } = await run('docker', ['compose', 'exec', '-T', 'mssql', '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa',
    // CREATE SCHEMA must open its batch; anything else runs without row counts in the output.
    '-P', 'Local-Passw0rd!', '-d', inDatabase, '-b', '-h', '-1', '-W', '-s', '|', '-Q', /^\s*create schema/i.test(batch) ? batch : `set nocount on; ${batch}`],
    { cwd: SERVER_DIR });
  return stdout.trim() === '' ? [] : stdout.trim().split('\n').map((line) => line.split('|'));
};

let source: AgentSource;

describe('SQL Server through the Silo Agent binary (spec 10.4, 10.7)', { skip }, () => {
  before(async () => {
    // The customer's database, and the login they give the agent: it reads, and changes what grants change.
    await tsql(`create database [${database}]; create login silo_agent with password = 'Agent-Mssql-Secret1!', check_policy = off;`);
    await tsql('create schema sales;', database);
    await tsql(`
      create table sales.orders (id int primary key, region nvarchar(10) not null, amount decimal(12,2) not null, placed datetime2(3) not null,
        shipped date null, active bit not null, code varbinary(4) null);
      insert into sales.orders values
        (1, N'south', 10.50, '2026-11-01T10:00:00.250', '2026-11-03', 1, 0xcafe),
        (2, N'north', 21.00, '2026-11-01T11:00:00.000', null, 0, null),
        (3, N'south', 31.50, '2026-11-01T12:00:00.000', '2026-11-04', 1, null),
        (4, N'north', 42.00, '2026-11-01T13:00:00.000', null, 1, null);
      create user silo_agent for login silo_agent;
      grant select, update on schema::sales to silo_agent;`, database);
    source = await startAgentSource({
      dialect: 'sqlserver', manifest: ordersManifest('sqlserver', 'sales'),
      cellParameters: { host: '127.0.0.1', port: String(PORT), database, sslmode: 'require' },
      login: { username: 'silo_agent', password: 'Agent-Mssql-Secret1!' },
      agentDsn: `sqlserver://silo_agent:${encodeURIComponent('Agent-Mssql-Secret1!')}@127.0.0.1:${PORT}?database=${database}&encrypt=true&TrustServerCertificate=true`,
    });
  });

  after(async () => {
    await source?.close();
    if (!skip) await tsql(`alter database [${database}] set single_user with rollback immediate; drop database [${database}]; drop login silo_agent;`).catch(() => undefined);
  });

  test('reads, with the agent\'s own login and with the cell\'s: values as the cell reads them', async () => {
    assert.deepEqual((await source.read(source.agentHeld, ORDERS_STEP)).rows, ORDERS);
    assert.deepEqual((await source.read(source.cellHeld, ORDERS_STEP)).rows, ORDERS);
    assert.deepEqual((await source.read(source.cellHeld, { object: 'orders', fields: ['id'], filters: [{ field: 'region', op: 'eq', value: 'north' }],
      sort: [{ field: 'id', direction: 'asc' }] })).rows, [{ id: 2 }, { id: 4 }]);
    await assert.rejects(source.read(source.agentHeld, { object: 'missing' }), { category: 'not_found', code: 'source.not_found' }, 'error 208 as 42S02, classified');
    assert.ok(!source.logs.join('').includes('south') && !source.logs.join('').includes('Agent-Mssql-Secret1'), 'the agent logs no values and no login');
  });

  test('a read is one SELECT, always rolled back; a granted write applies, and a mismatch rolls it all back', async () => {
    const channel = tunnelChannel(source.tunnels);
    const base = { organisationId: source.cell.org, connectionId: source.agentHeld, agentPoolId: source.poolId, dialect: 'sqlserver', timeoutMs: 10_000,
      signal: new AbortController().signal };
    await assert.rejects(channel.query({ ...base, maxRows: 10, statement: { text: 'update [sales].[orders] set amount = 0 where id = @p1', values: [1] } }),
      (error: unknown) => error instanceof SourceSqlError && error.sqlstate === '42000', 'refused before it runs');
    await assert.rejects(channel.query({ ...base, maxRows: 10, statement: { text: 'select 1 as x; update [sales].[orders] set amount = 0', values: [] } }),
      (error: unknown) => error instanceof SourceSqlError, 'no second statement rides on a read');
    assert.deepEqual(await tsql('select amount from sales.orders where id = 1', database), [['10.50']]);

    const signer = createGrantSigner(createPrivateKey(TEST_GRANT_KEYS.privateKey));
    const grantFor = (statements: { text: string; values: unknown[]; expectRows?: number }[]) => signer.sign({
      organisationId: source.cell.org, actionId: uuidv7(), actionKind: 'mutation', connectionId: source.agentHeld, object: 'orders',
      statements: statements.length, payloadSha256: statementsDigest(statements),
    });
    const update = (amount: number, id: number) => ({ text: 'update [sales].[orders] set [amount] = @p1 where [id] = @p2', values: [amount, id], expectRows: 1 });
    const write = [update(99.5, 1)];
    assert.deepEqual(await channel.transaction!({ ...base, statements: write, grant: grantFor(write) }), { rowCounts: [1] });
    assert.deepEqual(await tsql('select amount from sales.orders where id = 1', database), [['99.50']]);
    const plan = [update(1, 2), update(1, 999)];
    await assert.rejects(channel.transaction!({ ...base, statements: plan, grant: grantFor(plan) }),
      (error: unknown) => error instanceof RowCountMismatch && error.index === 1 && error.rows === 0);
    assert.deepEqual(await tsql('select amount from sales.orders where id = 2', database), [['21.00']], 'the first statement rolled back with the second');
  });

  test('a cell-held login with the wrong password is the source\'s refusal, 18456 as 28000', async () => {
    await source.setPassword(source.cellHeld, 'wrong');
    await assert.rejects(source.read(source.cellHeld, ORDERS_STEP), (error: { details?: Record<string, unknown> }) => String(error.details?.['sqlstate']) === '28000');
  });
});
