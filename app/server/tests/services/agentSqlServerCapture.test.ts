// SQL Server change data capture end to end (spec 10.3, 10.4, 18.1, 18.2): the Go agent built
// from agent/ reads a customer's SQL Server change tracking with the login only it holds,
// polling each second in a snapshot transaction. Only the tables the manifest streams by
// capture are read; committed rows become deltas on bus-live (their values as reads give
// them), acknowledged once taken in; the agent stopping gives up its lease and the next reader
// resumes from the acknowledged version, losing and repeating nothing. Tracking restarted on a
// table past the acknowledged version loses the capture; tracking turned off stops the reader
// with the reason; dropping a capture has nothing to drop on the server. Runs against the SQL
// Server of `npm run sources:up`; skipped where it is not running or there is no Go toolchain.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dropChangeCapture, setChangeCapture } from '../../src/contracts/change-stream/capture.contract.ts';
import { capturedOrdersManifest, startCaptureSource, type CaptureSource } from './agentCaptureSource.helper.ts';
import { hasGo, reachable, run, SERVER_DIR } from './agentSource.helper.ts';

const PORT = 51433;
const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const database = `capturedb_${suffix}`;
const login = `silo_repl_${suffix}`;
const slotName = `silo_${suffix}`;
const skip = !hasGo ? 'no Go toolchain here' : !(await reachable(PORT)) ? 'no SQL Server here (npm run sources:up)' : false;

/** T-SQL as SQL Server's own client runs it in its container: the test's view of the customer's database. */
const tsql = async (batch: string, inDatabase = 'master'): Promise<string[][]> => {
  const { stdout } = await run('docker', ['compose', 'exec', '-T', 'mssql', '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa',
    '-P', 'Local-Passw0rd!', '-d', inDatabase, '-b', '-h', '-1', '-W', '-s', '|', '-Q', /^\s*create schema/i.test(batch) ? batch : `set nocount on; ${batch}`],
    { cwd: SERVER_DIR });
  return stdout.trim() === '' ? [] : stdout.trim().split('\n').map((line) => line.split('|'));
};
const inDb = (batch: string) => tsql(batch, database);

const FIELDS = [{ name: 'id', type: 'integer' }, { name: 'region', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'placed', type: 'date-time' },
  { name: 'ref', type: 'string' }, { name: 'active', type: 'boolean' }];

let source: CaptureSource;

describe('SQL Server change data capture through the Silo Agent (spec 10.3, 10.4, 18)', { skip }, () => {
  before(async () => {
    // The customer's database: change tracking on, snapshot isolation allowed, the captured table tracked, a table no
    // manifest streams tracked too, and a login that reads the captured table's changes only.
    await tsql(`create database [${database}];
      alter database [${database}] set allow_snapshot_isolation on;
      alter database [${database}] set change_tracking = on (change_retention = 2 days, auto_cleanup = on);
      create login [${login}] with password = 'Agent-Repl-Secret1!', check_policy = off;`);
    await inDb('create schema sales;');
    await inDb(`
      create table sales.orders (id int primary key, region nvarchar(20) not null, amount decimal(12,2) not null, placed datetime2(3) not null,
        ref uniqueidentifier null, active bit not null);
      alter table sales.orders enable change_tracking;
      create table sales.payroll (id int primary key, note nvarchar(40) not null);
      alter table sales.payroll enable change_tracking;
      insert into sales.orders values (1, N'north', 10.50, '2026-11-01T09:00:00', null, 1);
      create user [${login}] for login [${login}];
      grant select, view change tracking on sales.orders to [${login}];`);
    const dsn = `sqlserver://${login}:${encodeURIComponent('Agent-Repl-Secret1!')}@127.0.0.1:${PORT}?database=${database}&encrypt=true&TrustServerCertificate=true`;
    source = await startCaptureSource({
      name: 'ct',
      manifests: [capturedOrdersManifest('sqlserver', 'change_tracking', 'sales', FIELDS), capturedOrdersManifest('sqlserver', 'change_tracking', undefined, FIELDS)],
      logins: [{ dsn, replicationDsn: dsn }, undefined],
    });
    source.startAgent();
  });

  after(async () => {
    await source?.close();
    if (!skip) {
      await tsql(`alter database [${database}] set single_user with rollback immediate; drop database [${database}]; drop login [${login}];`)
        .catch(() => undefined);
    }
  });

  test('the owner confirms the capture; a publication and an unqualified table are refused; the stream is live', async () => {
    const gateway = source.cell.client('gateway');
    const [connectionId, unqualified] = source.connections as [string, string];
    await assert.rejects(gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName, publication: 'silo_orders', confirmed: true } }, source.cell.as(source.root)),
      { code: 'stream.publication_not_used' }, 'change tracking has no publication');
    await assert.rejects(gateway.call(setChangeCapture, { params: { connectionId: unqualified }, body: { slotName, confirmed: true } }, source.cell.as(source.root)),
      { code: 'stream.cdc_schema_required' }, 'a captured table names its schema');
    const set = await gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName, confirmed: true } }, source.cell.as(source.root));
    assert.equal(set.capture?.method, 'change_tracking');
    const view = await source.waitFor('the capture is read and the stream live', () => source.status(), (v) =>
      v.capture?.reading === true && v.objects[0]?.inUse === 'cdc' && v.objects[0]?.status === 'live', 60_000);
    assert.equal(view.capture?.status, 'active');
  });

  test('committed rows become deltas, as reads read them; rows of tables no manifest streams stay on the host', async () => {
    await inDb(`begin transaction;
      insert into sales.orders values (101, N'south', 99.95, '2026-11-02T10:30:00.250', '6f9619ff-8b86-d011-b42d-00c04fc964ff', 1),
        (102, N'east', 5.00, '2026-11-02T11:00:00', null, 0);
      insert into sales.payroll values (1, N'confidential-salary');
      commit;`);
    await source.waitFor('two inserts', () => source.deltas().length, (n) => n >= 2, 60_000);
    await inDb('update sales.orders set amount = 120.00 where id = 101;');
    await source.waitFor('the update', () => source.deltas().length, (n) => n >= 3, 60_000);
    await inDb('delete from sales.orders where id = 102;');
    await source.waitFor('the delete', () => source.deltas().length, (n) => n >= 4, 60_000);
    const [inserted, second, updated, deleted] = source.deltas();
    assert.deepEqual({ ...inserted, observedAt: undefined, sourceAt: undefined, sourceSeq: undefined }, {
      organisationId: source.cell.org, connectionId: source.connections[0], manifestVersion: '1.0.0', object: 'orders', entityRef: '101', operation: 'insert',
      changed: { id: 101, region: 'south', amount: 99.95, placed: '2026-11-02T10:30:00.250Z', ref: '6f9619ff-8b86-d011-b42d-00c04fc964ff', active: true },
      observedAt: undefined, sourceAt: undefined, sourceSeq: undefined, ordering: 'source_sequence', source: 'cdc', markings: [],
    }, 'only declared fields, read as reads read them');
    assert.equal(second?.entityRef, '102');
    assert.deepEqual({ op: updated?.operation, amount: updated?.changed['amount'] }, { op: 'update', amount: 120 });
    assert.deepEqual({ op: deleted?.operation, ref: deleted?.entityRef, changed: deleted?.changed }, { op: 'delete', ref: '102', changed: {} });
    const sequences = source.deltas().map((d) => d.sourceSeq!);
    assert.deepEqual([...sequences].sort(), sequences, 'their places sort as text, in version order');
    assert.ok(Date.parse(inserted!.sourceAt!) > Date.now() - 120_000, 'the time it was read stands for the commit time');

    const acknowledged = await source.waitFor('the version acknowledged', () => source.status(), (v) => v.capture?.acknowledgedPosition !== null);
    assert.match(acknowledged.capture!.acknowledgedPosition!, /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/);
    const text = source.logs.join('');
    assert.ok(!text.includes('south') && !text.includes('confidential-salary') && !text.includes('Agent-Repl-Secret1'), 'the agent logs no values and no login');
    assert.equal((await source.events('stream.cdc_unmatched')).length, 0, 'the other table\'s rows never reached the cell');
  });

  test('the agent stopping gives up its lease; the next reader resumes from the acknowledged version, losing and repeating nothing', async () => {
    const before = source.deltas().length;
    await source.stopAgent();
    await source.waitFor('the lease given up', () => source.status(), (v) => v.capture?.reading === false);
    await inDb(`insert into sales.orders values (200, N'west', 1.00, '2026-11-03T08:00:00', null, 1);`);
    source.startAgent();
    await source.waitFor('the change made while no agent read', () => source.deltas('200').length, (n) => n === 1, 60_000);
    await source.waitFor('live again', () => source.status(), (v) => v.capture?.reading === true && v.objects[0]?.status === 'live');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(source.deltas().length, before + 1, 'what was acknowledged is not published again');
  });

  test('tracking restarted past the acknowledged version loses the capture', async () => {
    await source.stopAgent();
    await source.waitFor('the lease given up', () => source.status(), (v) => v.capture?.reading === false);
    await inDb(`insert into sales.orders values (300, N'north', 3.00, '2026-11-04T08:00:00', null, 1);
      alter table sales.orders disable change_tracking;
      alter table sales.orders enable change_tracking;`);
    source.startAgent();
    const lost = await source.waitFor('the capture lost', () => source.status(), (v) => v.capture?.status === 'lost', 60_000);
    assert.equal(lost.objects[0]?.status, 'stale');
    assert.equal((await source.events('cdc_slot_lost'))[0]?.detail['slot_name'], slotName);
    assert.equal(source.deltas('300').length, 0, 'nothing read past what was lost');
  });

  test('tracking turned off stops the reader, saying why; dropping a capture has nothing to drop on the server', async () => {
    const gateway = source.cell.client('gateway');
    const connectionId = source.connections[0]!;
    await gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName: `${slotName}_b`, confirmed: true } }, source.cell.as(source.root));
    await source.waitFor('the new capture reads', () => source.status(), (v) => v.capture?.slotName === `${slotName}_b` && v.capture.reading, 60_000);
    await inDb(`insert into sales.orders values (400, N'south', 4.00, '2026-11-05T08:00:00', null, 0);`);
    await source.waitFor('read from where the database stood', () => source.deltas('400').length, (n) => n === 1, 60_000);

    await inDb(`alter table sales.orders disable change_tracking; insert into sales.payroll values (2, N'moves the version on');`);
    const stopped = await source.waitFor('the reason shown', () => source.status(), (v) =>
      v.objects[0]?.status === 'stale' && (v.objects[0]?.reason ?? '').includes('does not log what change capture needs'), 60_000);
    assert.equal(stopped.capture?.status, 'active', 'not lost: tracking turned on again is read from where the capture stood');
    assert.ok(source.logs.join('').includes('agent.cdc_not_configured'), 'the agent\'s log names the setting');

    await gateway.call(dropChangeCapture, { params: { connectionId } }, source.cell.as(source.root));
    await source.waitFor('the capture lost earlier is current again', () => source.status(), (v) => v.capture?.slotName === slotName);
    await gateway.call(dropChangeCapture, { params: { connectionId } }, source.cell.as(source.root));
    await source.waitFor('every capture dropped', () => source.status(), (v) => v.capture === null);
    const dropped = await source.events('cdc_slot_dropped');
    assert.equal(dropped.length, 2);
    assert.ok(dropped.every((e) => e.actor.membershipId === source.root.membershipId), 'naming who asked');
  });
});
