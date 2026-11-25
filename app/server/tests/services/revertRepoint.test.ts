// Deletes are revertible with their links (spec 46.6): a contact reports to a manager; the
// manager is deleted, and the delete's blast radius records the report as an ontology link
// with a writable key. Reverting it recreates the manager, the CRM gives a new identifier,
// and the same revert re-points the report to it after the recreation: shown in its diff,
// approved with it, verified, recorded in id_remappings, the record keeping its identity.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, getReceipt, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { requestRevert } from '../../src/contracts/revert/revert.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { service as revertService } from '../../src/routes/revert/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
let deleteContact = '';
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

before(async () => {
  wb = await createWritebackCell({
    custom: true,
    start: async (cell) => {
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
      await cell.start(revertService, 'revert', 'test_app');
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  approver = await wb.cell.member('approver@acme.example', 'Super admin');
  await wb.grant(approver.membershipId, wb.restConnection, 'read');
  await wb.enableWrites(wb.restConnection);
  const type = await gateway.call(proposeActionType, { body: { apiName: 'delete_contact', displayName: 'Delete contact', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, rules: [{ kind: 'delete_object' }], permittedConnections: [wb.restConnection],
  } }, keyed(root));
  deleteContact = type.id;
});

after(async () => {
  await wb?.close();
});

describe('links re-pointed on revert (spec 46.6)', () => {
  test('a recreated record with a new identifier keeps its identity, and the same revert re-points its dependants', async () => {
    wb.contacts.get('c3')!.properties.manager = 'c2';
    const proposed = await gateway.call(proposeMutation, { body: { actionTypeId: deleteContact, objects: [{ connectionId: wb.restConnection, reference: 'c2' }] } }, keyed(root));
    assert.equal(proposed.preview!.blastRadius.counts!.ontology_link, 1, 'the report is in the blast radius');
    const deleted = await approveAndRun(proposed);
    assert.match(deleted.status, /^completed/);
    assert.equal(wb.contacts.has('c2'), false);

    const revert = await gateway.call(requestRevert, { body: { receiptId: deleted.receiptId! } }, keyed(root));
    const repoint = revert.mutation.preview!.rows.find((r) => r.entityReference === 'c3')!;
    assert.equal(repoint.field, 'manager');
    assert.equal(repoint.prior, 'c2');
    assert.ok(typeof repoint.proposed === 'object' && repoint.proposed !== null && '$newIdentifierOf' in repoint.proposed, 'the diff shows the link following the recreation');
    const done = await approveAndRun(revert.mutation);
    assert.match(done.status, /^completed/);

    const recreated = [...wb.contacts.values()].find((c) => c.properties.email === 'p2@example.com')!;
    assert.notEqual(recreated.id, 'c2', 'the CRM gave the record a new identifier');
    assert.equal(wb.contacts.get('c3')!.properties.manager, recreated.id, 'the report follows its manager');

    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      'select old_reference, new_reference, links_repointed, links_not_repointed from action.id_remappings where organisation_id = $1', [wb.cell.org]));
    assert.deepEqual(rows.map((r) => [r.old_reference, r.new_reference, r.links_repointed, r.links_not_repointed]), [['c2', recreated.id, 1, 0]]);
    const events = async (name: string) => (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'detail' as d from platform.outbox where organisation_id = $1 and payload->>'event' = $2`, [wb.cell.org, name]))).rows;
    assert.equal((await events('id_remapped')).length, 1);
    assert.equal((await events('link_repointed')).length, 1);
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, wb.cell.as(root));
    assert.deepEqual((receipt.document as { linksNotRepointed: unknown[] }).linksNotRepointed, []);
  });
});
