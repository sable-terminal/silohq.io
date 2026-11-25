// Revert end to end (spec 46.3 to 46.6): three-way at the time of asking, from what the
// receipt holds; clean reverts, already-reverted records, per-field conflicts decided by a
// person before approval, created records deleted, deleted records recreated; a revert is a
// mutation with its own approval, receipt (linked to the one it reverts) and commits (each
// pointing at the commit it reverts).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion, type VersionDefinitionInput } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, getReceipt, listObjectCommits, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { decideRevertConflicts, requestRevert } from '../../src/contracts/revert/revert.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { service as revertService } from '../../src/routes/revert/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
const types: Record<string, string> = {};

const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

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
  return until(m.id);
}

async function define(apiName: string, def: VersionDefinitionInput): Promise<string> {
  const type = await gateway.call(proposeActionType, { body: { apiName, displayName: apiName, owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: def }, keyed(root));
  return type.id;
}

async function applied(actionTypeId: string, body: Record<string, unknown>): Promise<MutationView> {
  const m = await gateway.call(proposeMutation, { body: { actionTypeId, ...body } as never }, keyed(root));
  const done = await approveAndRun(m);
  assert.match(done.status, /^completed/);
  return done;
}

before(async () => {
  wb = await createWritebackCell({
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
  types['score'] = await define('set_score', {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: ['score'],
    parameters: [{ name: 'score', type: 'integer', required: true }], rules: [{ kind: 'set_property', property: 'score', value: { parameter: 'score' } }],
    permittedConnections: [wb.restConnection],
  });
  types['create'] = await define('create_order', {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.orderTypeId, properties: ['order_id', 'customer', 'status', 'amount'],
    parameters: [{ name: 'id', type: 'integer', required: true }],
    rules: [{ kind: 'create_object', values: { order_id: { parameter: 'id' }, customer: { cel: '"Globex"' }, status: { cel: '"open"' }, amount: { cel: '5' } } }],
    permittedConnections: [wb.sqlConnection],
  });
  types['delete'] = await define('delete_order', {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.orderTypeId, rules: [{ kind: 'delete_object' }], permittedConnections: [wb.sqlConnection],
  });
});

after(async () => {
  await wb?.close();
});

describe('three-way revert (spec 46.3)', () => {
  let original: MutationView;

  test('a clean revert restores the prior value under its own approval, receipt and commit', async () => {
    original = await applied(types['score']!, { parameters: { score: 77 }, objects: [{ connectionId: wb.restConnection, reference: 'c2' }] });
    assert.equal(wb.contacts.get('c2')!.properties.score, 77);
    const revert = await gateway.call(requestRevert, { body: { receiptId: original.receiptId! } }, keyed(root));
    assert.equal(revert.conflictCount, 0);
    assert.equal(revert.mutation.origin, 'revert');
    assert.equal(revert.mutation.status, 'awaiting_approval');
    assert.deepEqual(revert.mutation.preview!.rows.map((r) => `${r.field}:${JSON.stringify(r.prior)}->${JSON.stringify(r.proposed)}`), ['score:77->20']);
    const done = await approveAndRun(revert.mutation);
    assert.equal(done.status, 'completed');
    assert.equal(wb.contacts.get('c2')!.properties.score, 20);
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, wb.cell.as(root));
    assert.equal(receipt.revertsReceiptId, original.receiptId);
    const log = await gateway.call(listObjectCommits, { params: { objectId: original.preview!.rows[0]!.objectId }, query: {} }, wb.cell.as(root));
    assert.equal(log.commits.length, 2);
    const [revertCommit, first] = log.commits;
    assert.equal(revertCommit!.revertsCommitId, first!.id);
    assert.equal(revertCommit!.parentCommitId, first!.id, 'history is never rewritten: the revert is a new commit on top');
  });

  test('a record already in its prior state is reported, and nothing is written', async () => {
    await assert.rejects(gateway.call(requestRevert, { body: { receiptId: original.receiptId! } }, keyed(root)), { code: 'revert.nothing_to_revert' });
  });

  test('a field changed outside Silo since is a conflict a person decides before approval', async () => {
    const m = await applied(types['score']!, { parameters: { score: 30 }, objects: [{ connectionId: wb.restConnection, reference: 'c3' }] });
    wb.contacts.get('c3')!.properties.score = 45; // changed in the CRM after the Action
    const revert = await gateway.call(requestRevert, { body: { receiptId: m.receiptId! } }, keyed(root));
    assert.equal(revert.conflictCount, 1);
    assert.deepEqual(revert.conflicts.map((c) => `${c.kind}:${c.field}:${JSON.stringify(c.postWriteValue)}:${JSON.stringify(c.currentValue)}`), ['field_changed:score:30:45']);
    assert.equal(revert.mutation.status, 'previewed', 'approval waits for the decision');
    assert.equal(revert.mutation.chain, null);
    const decided = await gateway.call(decideRevertConflicts, { params: { revertId: revert.id }, body: { decisions: [{ conflictId: revert.conflicts[0]!.id, decision: 'keep_current' }] } }, wb.cell.as(root));
    assert.equal(decided.mutation.status, 'awaiting_approval');
    const done = await approveAndRun(decided.mutation);
    assert.equal(done.status, 'completed');
    assert.equal(wb.contacts.get('c3')!.properties.score, 45, 'the later change was kept, as decided');
  });
});

describe('creates and deletes are revertible (spec 46.6)', () => {
  test('reverting a create deletes the record, capturing its full record', async () => {
    const m = await applied(types['create']!, { parameters: { id: 60 } });
    assert.equal((await wb.customer.query('select 1 from sales.orders where id = 60')).rowCount, 1);
    const revert = await gateway.call(requestRevert, { body: { receiptId: m.receiptId! } }, keyed(root));
    assert.equal(revert.mutation.preview!.rows[0]!.operation, 'delete');
    assert.deepEqual(revert.mutation.preview!.rows[0]!.prior, { id: 60, customer: 'Globex', status: 'open', amount: 5 });
    assert.equal((await approveAndRun(revert.mutation)).status, 'completed');
    assert.equal((await wb.customer.query('select 1 from sales.orders where id = 60')).rowCount, 0);
  });

  test('reverting a delete recreates the record from its full prior record, under its identifier', async () => {
    const m = await applied(types['delete']!, { objects: [{ connectionId: wb.sqlConnection, reference: '4' }] });
    assert.equal((await wb.customer.query('select 1 from sales.orders where id = 4')).rowCount, 0);
    const revert = await gateway.call(requestRevert, { body: { receiptId: m.receiptId! } }, keyed(root));
    assert.equal((await approveAndRun(revert.mutation)).status, 'completed');
    const { rows } = await wb.customer.query('select id, customer, status, amount from sales.orders where id = 4');
    assert.deepEqual(rows, [{ id: 4, customer: 'customer 4', status: 'open', amount: '40.00' }]);
  });
});
