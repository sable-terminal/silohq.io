// Full updates and upserts (spec 42.4, 42.5, 48.1). A source that takes only a full update
// is sent the whole record, every field its prior state, and a revert sends the whole record
// back; a create on a source that takes only an upsert names its record, which is read first:
// absent, it is created and a revert deletes it; present, it is updated with its prior state
// and a revert restores it. On SQL an upsert is INSERT ... ON CONFLICT on Postgres and MERGE
// elsewhere, run on the customer's database. A warehouse update or delete carries its prior
// state as a guard in the same statement, so a change made since rolls it back (48.1).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getActionType, proposeActionType, publishActionTypeVersion, type VersionDefinitionInput } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import type { ManifestObject } from '../../src/contracts/connect/manifest.contract.ts';
import { requestRevert } from '../../src/contracts/revert/revert.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { service as revertService } from '../../src/routes/revert/index.route.ts';
import { writeStatement } from '../../src/services/connect-runtime/protocols/sql/write.protocol.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });
const rows = (m: MutationView) => m.preview!.rows.map((r) => `${r.field}:${JSON.stringify(r.prior)}->${JSON.stringify(r.proposed)}`);

async function until(mutationId: string): Promise<MutationView> {
  for (let i = 0; i < 100; i++) {
    const m = await gateway.call(getMutation, { params: { mutationId } }, wb.cell.as(root));
    if (m.completedAt !== null) return m;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the mutation did not finish');
}

async function approveAndRun(m: MutationView): Promise<MutationView> {
  await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(approver));
  const done = await until(m.id);
  assert.match(done.status, /^completed/);
  return done;
}

async function define(apiName: string, def: VersionDefinitionInput): Promise<string> {
  const type = await gateway.call(proposeActionType, { body: { apiName, displayName: apiName, owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: def }, keyed(root));
  return type.id;
}

const propose = (actionTypeId: string, body: Record<string, unknown>) =>
  gateway.call(proposeMutation, { body: { actionTypeId, ...body } as never }, keyed(root));

before(async () => {
  wb = await createWritebackCell({
    replace: true,
    start: async (cell) => {
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService(), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
      await cell.start(revertService, 'revert', 'test_app');
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  approver = await wb.cell.member('approver@acme.example', 'Super admin');
  for (const connection of [wb.restConnection, wb.sqlConnection]) {
    await wb.grant(approver.membershipId, connection, 'read');
    await wb.enableWrites(connection);
  }
});

after(async () => {
  await wb?.close();
});

describe('full updates (spec 42.5)', () => {
  test('a source taking only a full update is sent the whole record, every field its prior state; a revert sends it back', async () => {
    const type = await define('set_score_full', {
      ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: ['score'],
      parameters: [{ name: 'score', type: 'integer', required: true }], rules: [{ kind: 'set_property', property: 'score', value: { parameter: 'score' } }],
      permittedConnections: [wb.restConnection],
    });
    const view = await gateway.call(getActionType, { params: { actionTypeId: type } }, wb.cell.as(root));
    assert.deepEqual(view.current!.permittedOperations[wb.restConnection]!.operations, ['update_full']);
    const proposed = await propose(type, { parameters: { score: 77 }, objects: [{ connectionId: wb.restConnection, reference: 'c2' }] });
    assert.deepEqual(rows(proposed), ['email:"p2@example.com"->"p2@example.com"', 'name:"Person 2"->"Person 2"', 'score:20->77']);
    const done = await approveAndRun(proposed);
    assert.ok(wb.crmRequests.includes('PUT /v1/contacts/c2'));
    assert.deepEqual(wb.contacts.get('c2')!.properties, { email: 'p2@example.com', name: 'Person 2', score: 77 }, 'nothing cleared');
    const revert = await gateway.call(requestRevert, { body: { receiptId: done.receiptId! } }, keyed(root));
    assert.deepEqual(rows(revert.mutation), ['email:"p2@example.com"->"p2@example.com"', 'name:"Person 2"->"Person 2"', 'score:77->20']);
    assert.equal((await gateway.call(getMutation, { params: { mutationId: revert.mutation.id } }, wb.cell.as(root))).revertId, revert.id, 'the revert\'s change names its revert (D265)');
    assert.equal((await gateway.call(getMutation, { params: { mutationId: proposed.id } }, wb.cell.as(root))).revertId, null);
    await approveAndRun(revert.mutation);
    assert.deepEqual(wb.contacts.get('c2')!.properties, { email: 'p2@example.com', name: 'Person 2', score: 20 });
  });
});

describe('upserts (spec 42.4, 48.1)', () => {
  let upsertContact = '';

  test('a create on a source taking only an upsert gives the identifier a value', async () => {
    await assert.rejects(define('upsert_no_id', {
      ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: ['email'],
      parameters: [{ name: 'email', type: 'string', required: true }], rules: [{ kind: 'create_object', values: { email: { parameter: 'email' } } }],
      permittedConnections: [wb.restConnection],
    }), { code: 'action_type.upsert_identifier' });
    upsertContact = await define('upsert_contact', {
      ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: ['contact_id', 'email', 'name', 'score'],
      parameters: [{ name: 'id', type: 'string', required: true }, { name: 'email', type: 'string', required: true }],
      rules: [{ kind: 'create_object', values: { contact_id: { parameter: 'id' }, email: { parameter: 'email' }, name: { cel: '"New"' }, score: { cel: '1' } } }],
      permittedConnections: [wb.restConnection],
    });
    const view = await gateway.call(getActionType, { params: { actionTypeId: upsertContact } }, wb.cell.as(root));
    assert.deepEqual(view.current!.permittedOperations[wb.restConnection]!.operations, ['upsert']);
  });

  test('absent, the record is created, and a revert deletes it', async () => {
    const proposed = await propose(upsertContact, { parameters: { id: 'c9', email: 'n@example.com' } });
    assert.deepEqual(rows(proposed).sort(), ['email:null->"n@example.com"', 'id:null->"c9"', 'name:null->"New"', 'score:null->1']);
    const done = await approveAndRun(proposed);
    assert.deepEqual(wb.contacts.get('c9')!.properties, { email: 'n@example.com', name: 'New', score: 1 });
    const revert = await gateway.call(requestRevert, { body: { receiptId: done.receiptId! } }, keyed(root));
    await approveAndRun(revert.mutation);
    assert.equal(wb.contacts.has('c9'), false);
  });

  test('present, the record is updated with its prior state, and a revert restores it', async () => {
    const proposed = await propose(upsertContact, { parameters: { id: 'c3', email: 'x@example.com' } });
    assert.deepEqual(rows(proposed).sort(), ['email:"p3@example.com"->"x@example.com"', 'id:"c3"->"c3"', 'name:"Person 3"->"New"', 'score:30->1']);
    const done = await approveAndRun(proposed);
    assert.deepEqual(wb.contacts.get('c3')!.properties, { email: 'x@example.com', name: 'New', score: 1 });
    const revert = await gateway.call(requestRevert, { body: { receiptId: done.receiptId! } }, keyed(root));
    await approveAndRun(revert.mutation);
    assert.deepEqual(wb.contacts.get('c3')!.properties, { email: 'p3@example.com', name: 'Person 3', score: 30 });
  });

  test('on SQL an upsert is INSERT ... ON CONFLICT on Postgres and MERGE elsewhere, and runs on the customer\'s database', async () => {
    const orders = {
      name: 'orders', identifier: ['id'], fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'customer', type: 'string' }],
      source: { kind: 'sql', schema: 'sales', table: 'orders' },
    } as unknown as ManifestObject;
    const upsert = (dialect: Parameters<typeof writeStatement>[0]) => writeStatement(dialect, orders, { operation: 'upsert', identifier: '42', values: { id: 42, customer: 'A' } });
    assert.deepEqual(upsert('postgres'), {
      text: 'insert into "sales"."orders" ("id", "customer") values ($1, $2) on conflict ("id") do update set "customer" = excluded."customer"', values: [42, 'A'],
    });
    assert.equal(upsert('snowflake').text, 'merge into "sales"."orders" t using (select ? as "id", ? as "customer") s on (t."id" = s."id") '
      + 'when matched then update set "customer" = s."customer" when not matched then insert ("id", "customer") values (s."id", s."customer")');
    assert.equal(upsert('mysql').text, 'insert into `sales`.`orders` (`id`, `customer`) values (?, ?) on duplicate key update `customer` = values(`customer`)');
    assert.ok(upsert('oracle').text.includes('from dual) s on'), 'Oracle selects from dual');
    assert.ok(upsert('sqlserver').text.endsWith(';'), 'SQL Server ends a MERGE');
    assert.throws(() => writeStatement('postgres', orders, { operation: 'upsert', identifier: '42', values: { id: 42 } }), { code: 'write.no_fields' } as never);

    const type = await define('upsert_order', {
      ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.orderTypeId, properties: ['order_id', 'customer', 'status', 'amount'],
      parameters: [{ name: 'id', type: 'integer', required: true }],
      rules: [{ kind: 'create_object', values: { order_id: { parameter: 'id' }, customer: { cel: '"Globex"' }, status: { cel: '"open"' }, amount: { cel: '5' } } }],
      permittedConnections: [wb.sqlConnection],
    });
    await approveAndRun(await propose(type, { parameters: { id: 11 } }));
    await approveAndRun(await propose(type, { parameters: { id: 3 } }));
    const { rows: stored } = await wb.customer.query('select id, customer, amount::text as amount from sales.orders where id in (3, 11) order by id');
    assert.deepEqual(stored, [{ id: 3, customer: 'Globex', amount: '5.00' }, { id: 11, customer: 'Globex', amount: '5.00' }]);
  });
});

describe('prior state in the write\'s transaction (spec 48.1)', () => {
  test('an update or delete is guarded by its prior state; a change since rolls the write back as a conflict', async () => {
    const orders = {
      name: 'orders', identifier: ['id'], fields: [{ name: 'id', type: 'integer', nullable: false }, { name: 'customer', type: 'string' }, { name: 'meta', type: 'json' }],
      source: { kind: 'sql', schema: 'sales', table: 'orders' },
    } as unknown as ManifestObject;
    const guarded = writeStatement('postgres', orders, { operation: 'update_partial', identifier: '4', values: { customer: 'B' }, prior: { customer: 'A', meta: { x: 1 } } });
    assert.equal(guarded.text, 'update "sales"."orders" set "customer" = $1 where "id" = $2 and "customer" is not distinct from $3', 'JSON has no equality: unguarded');
    assert.equal(writeStatement('mysql', orders, { operation: 'delete', identifier: '4', values: {}, prior: { customer: 'A' } }).text,
      'delete from `sales`.`orders` where `id` = ? and `customer` <=> ?');
    assert.equal(writeStatement('oracle', orders, { operation: 'delete', identifier: '4', values: {}, prior: { customer: 'A' } }).text,
      'delete from "sales"."orders" where "id" = :1', 'no null-safe comparison generated for Oracle');

    const type = await define('set_order_status', {
      ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.orderTypeId, properties: ['status'],
      parameters: [{ name: 'status', type: 'string', required: true }], rules: [{ kind: 'set_property', property: 'status', value: { parameter: 'status' } }],
      permittedConnections: [wb.sqlConnection],
    });
    const proposed = await propose(type, { parameters: { status: 'shipped' }, objects: [{ connectionId: wb.sqlConnection, reference: '4' }] });
    wb.hooks.beforeTransaction = async () => {
      await wb.customer.query(`update sales.orders set status = 'held' where id = 4`);
    };
    await gateway.call(decideApproval, { params: { chainId: proposed.chain!.id }, body: { decision: 'approved', diffHash: proposed.diffHash! } }, wb.cell.as(approver));
    const done = await until(proposed.id);
    assert.equal(done.status, 'failed');
    const { rows: stored } = await wb.customer.query('select status from sales.orders where id = 4');
    assert.equal(stored[0]!.status, 'held', 'the write rolled back; the edit made outside Silo stands');
    const ok = await approveAndRun(await propose(type, { parameters: { status: 'shipped' }, objects: [{ connectionId: wb.sqlConnection, reference: '4' }] }));
    assert.equal(ok.status, 'completed', 'proposed again from the current state, it applies');
  });
});
