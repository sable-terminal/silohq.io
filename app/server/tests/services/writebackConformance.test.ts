// The write-verify-undo class (spec 17.1, 43.4 check 5): a connection earns writes by passing a
// sandboxed create, verify, update, verify, delete and verify-absence cycle through
// connect-runtime, recorded as a conformance run; connector.enable_writes then switches
// writes on, and only on a passed run of the connection's current manifest version.

import { createActionsService } from '../../src/routes/actions/index.route.ts';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getWriteClassStatus, runWriteClass, setConnectionWrites } from '../../src/contracts/conformance/writeClass.contract.ts';
import { service as conformanceService } from '../../src/routes/conformance/index.route.ts';
import { inTx } from '../db/harness.helper.ts';
import { createWritebackCell, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;

const writesEnabled = async (connectionId: string): Promise<boolean> => {
  const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query('select writes_enabled from connect.connections where id = $1', [connectionId]));
  return rows[0].writes_enabled as boolean;
};

const status = (connectionId: string) => wb.gateway.call(getWriteClassStatus, { params: { connectionId } }, wb.cell.as(wb.root));

before(async () => {
  // The write class asks actions for the grant a write through the agent runs on (spec 10.4).
  wb = await createWritebackCell({
    start: async (cell) => {
      await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app');
      await cell.start(conformanceService, 'conformance', 'test_app');
    },
  });
});

after(async () => {
  await wb?.close();
});

describe('earning writes (spec 17.1)', () => {
  test('writes stay off until the class has passed on the current version', async () => {
    await assert.rejects(wb.gateway.call(setConnectionWrites, { params: { connectionId: wb.restConnection }, body: { enabled: true } }, wb.cell.as(wb.root)),
      { code: 'connection.write_class_not_passed' });
    assert.equal(await writesEnabled(wb.restConnection), false);
    assert.equal((await status(wb.restConnection)).run, null, 'no test record has been nominated');
  });

  test('a failing cycle does not earn writes: the manifest\'s value check refuses the test record', async () => {
    const out = await wb.gateway.call(runWriteClass, {
      params: { connectionId: wb.restConnection }, body: { object: 'contacts', create: { email: 'sandbox@example.com', name: 'Sandbox', score: 500 } },
    }, wb.cell.as(wb.root));
    assert.equal(out.passed, false);
    assert.deepEqual(out.tests.map((t) => `${t.id}:${t.outcome}:${t.reason}`), ['write_verify_undo.create.contacts:failed:write.value_check']);
    assert.deepEqual((({ run }) => run && [run.id, run.passed, run.failedCount])(await status(wb.restConnection)), [out.runId, false, 1]);
    await assert.rejects(wb.gateway.call(setConnectionWrites, { params: { connectionId: wb.restConnection }, body: { enabled: true } }, wb.cell.as(wb.root)),
      { code: 'connection.write_class_not_passed' });
  });

  test('REST: create, verify, update, verify, delete, verify absence; the test record is gone; then writes are enabled', async () => {
    const before = wb.contacts.size;
    const out = await wb.gateway.call(runWriteClass, {
      params: { connectionId: wb.restConnection }, body: { object: 'contacts', create: { email: 'sandbox@example.com', name: 'Sandbox', score: 1 }, update: { score: 2 } },
    }, wb.cell.as(wb.root));
    assert.equal(out.passed, true);
    assert.deepEqual(out.tests.map((t) => `${t.id}:${t.outcome}`), [
      'write_verify_undo.create.contacts:passed', 'write_verify_undo.update.contacts:passed', 'write_verify_undo.undo.contacts:passed',
    ]);
    assert.equal(wb.contacts.size, before, 'the undo removed the test record');
    const passed = await status(wb.restConnection);
    assert.deepEqual([passed.run?.id, passed.run?.passed, passed.run?.passedCount, passed.writesEnabled], [out.runId, true, 3, false]);
    const enabled = await wb.gateway.call(setConnectionWrites, { params: { connectionId: wb.restConnection }, body: { enabled: true } }, wb.cell.as(wb.root));
    assert.deepEqual(enabled, { connectionId: wb.restConnection, writesEnabled: true, runId: out.runId });
    assert.equal(await writesEnabled(wb.restConnection), true);
  });

  test('SQL: the same cycle through the agent, in the customer database', async () => {
    const out = await wb.gateway.call(runWriteClass, {
      params: { connectionId: wb.sqlConnection }, body: { object: 'orders', create: { id: 900, customer: 'Sandbox', status: 'open', amount: 1 }, update: { status: 'closed' } },
    }, wb.cell.as(wb.root));
    assert.equal(out.passed, true);
    assert.equal((await wb.customer.query('select 1 from sales.orders where id = 900')).rowCount, 0);
  });

  test('an update-only cycle restores the record it changed', async () => {
    const out = await wb.gateway.call(runWriteClass, {
      params: { connectionId: wb.sqlConnection }, body: { object: 'orders', identifier: '5', update: { status: 'held' } },
    }, wb.cell.as(wb.root));
    assert.equal(out.passed, true);
    const { rows } = await wb.customer.query('select status from sales.orders where id = 5');
    assert.equal(rows[0].status, 'open');
  });

  test('writes are switched off again by the same authority', async () => {
    await wb.gateway.call(setConnectionWrites, { params: { connectionId: wb.restConnection }, body: { enabled: false } }, wb.cell.as(wb.root));
    assert.equal(await writesEnabled(wb.restConnection), false);
  });

  test('a member without connector.enable_writes cannot switch writes on', async () => {
    const member = await wb.cell.member('member@acme.example', 'Member');
    await assert.rejects(wb.gateway.call(setConnectionWrites, { params: { connectionId: wb.sqlConnection }, body: { enabled: true } }, wb.cell.as(member)),
      { code: 'connect.not_permitted' });
  });
});
