// MySQL change data capture end to end (spec 10.3, 10.4, 18.1, 18.2): the Go agent built from
// agent/ reads a customer's MySQL binary log, as a replica registered under the slot name the
// owner confirmed, with the replication login only it holds. The binary log carries every
// table of the server: only the tables the manifest streams by capture leave the customer's
// network. Committed rows become deltas on bus-live in log order (enumerations and sets as
// their labels, unsigned integers whole), acknowledged once taken in; the agent stopping gives
// up its lease and the next reader resumes from the acknowledged position, losing and repeating
// nothing. A binary log the server let go of before it was read is lost; dropping a capture
// has nothing to drop on the server. Runs against the MySQL of `npm run sources:up`; skipped
// where it is not running or there is no Go toolchain.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { dropChangeCapture, setChangeCapture } from '../../src/contracts/change-stream/capture.contract.ts';
import { capturedOrdersManifest, startCaptureSource, type CaptureSource } from './agentCaptureSource.helper.ts';
import { hasGo, reachable, run, SERVER_DIR } from './agentSource.helper.ts';

const PORT = 53306;
const suffix = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const database = `capturedb_${suffix}`;
const replUser = `silo_repl_${suffix}`;
const slotName = `silo_${suffix}`;
const skip = !hasGo ? 'no Go toolchain here' : !(await reachable(PORT)) ? 'no MySQL here (npm run sources:up)' : false;

/** SQL as MySQL's own client runs it in its container: the test's view of the customer's server. */
const mysql = async (statements: string): Promise<string[][]> => {
  const { stdout } = await run('docker', ['compose', 'exec', '-T', 'mysql', 'mysql', '-uroot', '-plocal', '-N', '-B', '-e', statements], { cwd: SERVER_DIR });
  return stdout.trim() === '' ? [] : stdout.trim().split('\n').map((line) => line.split('\t'));
};
const replicas = async (): Promise<string[]> => (await mysql('show replicas')).map((row) => row[1]!);

const FIELDS = [{ name: 'id', type: 'integer' }, { name: 'region', type: 'string' }, { name: 'amount', type: 'number' }, { name: 'placed', type: 'date-time' },
  { name: 'state', type: 'string' }, { name: 'tags', type: 'string' }, { name: 'qty', type: 'integer' }];

let source: CaptureSource;

describe('MySQL change data capture through the Silo Agent (spec 10.3, 10.4, 18)', { skip }, () => {
  before(async () => {
    // The customer's server: the captured table, a table no manifest streams, and a replication login (spec 10.4).
    const metadata = (await mysql('select @@binlog_row_metadata'))[0]?.[0];
    assert.equal(metadata, 'FULL', 'the dev MySQL logs full row metadata (docker-compose.yml)');
    await mysql(`
      create database ${database};
      create table ${database}.orders (id int primary key, region varchar(20) not null, amount decimal(12,2) not null, placed datetime(3) not null,
        state enum('new','paid','shipped') not null, tags set('a','b','c') not null, qty int unsigned not null);
      create table ${database}.payroll (id int primary key, note varchar(40) not null);
      insert into ${database}.orders values (1, 'north', 10.50, '2026-11-01 09:00:00', 'new', '', 1);
      create user '${replUser}'@'%' identified by 'agent-repl-secret';
      grant replication slave, replication client on *.* to '${replUser}'@'%';
      grant select on ${database}.* to '${replUser}'@'%';`);
    const login = `mysql://${replUser}:agent-repl-secret@127.0.0.1:${PORT}/${database}?sslmode=prefer`;
    source = await startCaptureSource({
      name: 'binlog',
      manifests: [capturedOrdersManifest('mysql', 'binlog', database, FIELDS), capturedOrdersManifest('mysql', 'binlog', undefined, FIELDS)],
      logins: [{ dsn: login, replicationDsn: login }, undefined],
    });
    source.startAgent();
  });

  after(async () => {
    await source?.close();
    if (!skip) await mysql(`drop database if exists ${database}; drop user if exists '${replUser}'@'%';`).catch(() => undefined);
  });

  test('the owner confirms the slot name; the agent reads the binary log as a replica of that name', async () => {
    const gateway = source.cell.client('gateway');
    const [connectionId, unqualified] = source.connections as [string, string];
    await assert.rejects(gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName, publication: 'silo_orders', confirmed: true } }, source.cell.as(source.root)),
      { code: 'stream.publication_not_used' }, 'a binary log has no publication');
    await assert.rejects(gateway.call(setChangeCapture, { params: { connectionId: unqualified }, body: { slotName, confirmed: true } }, source.cell.as(source.root)),
      { code: 'stream.cdc_schema_required' }, 'the binary log carries every database: a captured table names its own');
    const set = await gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName, confirmed: true } }, source.cell.as(source.root));
    assert.equal(set.capture?.method, 'binlog');
    assert.equal(set.capture?.publication, null);
    const view = await source.waitFor('the capture is read and the stream live', () => source.status(), (v) =>
      v.capture?.reading === true && v.objects[0]?.inUse === 'cdc' && v.objects[0]?.status === 'live');
    assert.equal(view.capture?.status, 'active');
    assert.ok((await replicas()).includes(slotName), 'the customer sees the reader in SHOW REPLICAS, by the slot name');
  });

  test('committed rows become deltas in log order; rows of tables no manifest streams stay on the host', async () => {
    await mysql(`
      start transaction;
      insert into ${database}.orders values (101, 'south', 99.95, '2026-11-02 10:30:00.250', 'paid', 'a,c', 4294967295),
        (102, 'east', 5.00, '2026-11-02 11:00:00', 'new', '', 0);
      insert into ${database}.payroll values (1, 'confidential-salary');
      commit;
      update ${database}.orders set amount = 120.00, state = 'shipped' where id = 101;
      delete from ${database}.orders where id = 102;`);
    await source.waitFor('four deltas', () => source.deltas().length, (n) => n >= 4);
    const [inserted, second, updated, deleted] = source.deltas();
    assert.deepEqual({ ...inserted, observedAt: undefined, sourceAt: undefined, sourceSeq: undefined }, {
      organisationId: source.cell.org, connectionId: source.connections[0], manifestVersion: '1.0.0', object: 'orders', entityRef: '101', operation: 'insert',
      changed: { id: 101, region: 'south', amount: 99.95, placed: '2026-11-02T10:30:00.250Z', state: 'paid', tags: 'a,c', qty: 4294967295 },
      observedAt: undefined, sourceAt: undefined, sourceSeq: undefined, ordering: 'source_sequence', source: 'cdc', markings: [],
    }, 'only declared fields, read as reads read them: labels for enumerations and sets, unsigned integers whole');
    assert.equal(second?.entityRef, '102');
    assert.deepEqual({ op: updated?.operation, amount: updated?.changed['amount'], state: updated?.changed['state'] }, { op: 'update', amount: 120, state: 'shipped' });
    assert.deepEqual({ op: deleted?.operation, ref: deleted?.entityRef, changed: deleted?.changed }, { op: 'delete', ref: '102', changed: {} });
    const sequences = source.deltas().map((d) => d.sourceSeq!);
    assert.deepEqual([...sequences].sort(), sequences, 'their places in the log sort as text, in commit order');
    assert.ok(inserted!.sourceAt !== null && Date.parse(inserted!.sourceAt) > Date.now() - 60_000, 'the commit time is the source time');

    const acknowledged = await source.waitFor('the position acknowledged', () => source.status(), (v) => v.capture?.acknowledgedPosition !== null);
    assert.match(acknowledged.capture!.acknowledgedPosition!, /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/, 'the binary log\'s file number and offset');
    const text = source.logs.join('');
    assert.ok(!text.includes('south') && !text.includes('confidential-salary') && !text.includes('agent-repl-secret'), 'the agent logs no values and no login');
    assert.equal((await source.events('stream.cdc_unmatched')).length, 0, 'the other table\'s rows never reached the cell');
  });

  test('the agent stopping gives up its lease; the next reader resumes from the acknowledged position, losing and repeating nothing', async () => {
    const before = source.deltas().length;
    await source.stopAgent();
    await source.waitFor('the lease given up', () => source.status(), (v) => v.capture?.reading === false);
    await mysql(`insert into ${database}.orders values (200, 'west', 1.00, '2026-11-03 08:00:00', 'new', 'b', 2)`);
    source.startAgent();
    await source.waitFor('the change made while no agent read', () => source.deltas('200').length, (n) => n === 1);
    await source.waitFor('live again', () => source.status(), (v) => v.capture?.reading === true && v.objects[0]?.status === 'live');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(source.deltas().length, before + 1, 'what was acknowledged is not published again');
  });

  test('a binary log the server let go of before it was read is lost', async () => {
    await source.stopAgent();
    await source.waitFor('the lease given up', () => source.status(), (v) => v.capture?.reading === false);
    // The server moves to a new file and purges the one the acknowledged position is in, unread past it.
    await mysql(`flush binary logs; insert into ${database}.orders values (300, 'north', 3.00, '2026-11-04 08:00:00', 'new', '', 3)`);
    const current = (await mysql('show binary log status'))[0]?.[0];
    await mysql(`purge binary logs to '${current}'`);
    source.startAgent();
    const lost = await source.waitFor('the capture lost', () => source.status(), (v) => v.capture?.status === 'lost');
    assert.equal(lost.objects[0]?.status, 'stale');
    assert.equal((await source.events('cdc_slot_lost'))[0]?.detail['slot_name'], slotName);
    assert.equal(source.deltas('300').length, 0, 'nothing read past what was lost');
  });

  test('dropping a capture has nothing to drop on the server: the reader stops and the replica is gone', async () => {
    const gateway = source.cell.client('gateway');
    const connectionId = source.connections[0]!;
    await gateway.call(setChangeCapture, { params: { connectionId }, body: { slotName: `${slotName}_b`, confirmed: true } }, source.cell.as(source.root));
    await source.waitFor('the new capture reads', () => source.status(), (v) => v.capture?.slotName === `${slotName}_b` && v.capture.reading);
    await source.waitFor('the replica listed', () => replicas(), (names) => names.includes(`${slotName}_b`));
    await mysql(`insert into ${database}.orders values (400, 'south', 4.00, '2026-11-05 08:00:00', 'paid', 'c', 4)`);
    await source.waitFor('read from where the server stood', () => source.deltas('400').length, (n) => n === 1);
    await gateway.call(dropChangeCapture, { params: { connectionId } }, source.cell.as(source.root));
    await source.waitFor('the capture lost earlier is current again', () => source.status(), (v) => v.capture?.slotName === slotName);
    await source.waitFor('the replica gone', () => replicas(), (names) => !names.includes(`${slotName}_b`));
    await gateway.call(dropChangeCapture, { params: { connectionId } }, source.cell.as(source.root));
    await source.waitFor('every capture dropped', () => source.status(), (v) => v.capture === null);
    const dropped = await source.events('cdc_slot_dropped');
    assert.equal(dropped.length, 2);
    assert.ok(dropped.every((e) => e.actor.membershipId === source.root.membershipId), 'naming who asked');
  });
});
