// Custom actions and link rules (spec 42.4, 42.5, 42.8). A custom action is an endpoint the
// manifest declares with the fields it changes: those are read as prior state, and read back
// after it runs. A compensating revert invokes the custom action that undoes it; a custom
// action reverted three-way has its fields restored by the manifest's update. add_link and
// remove_link write the foreign key the target holds.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion, type VersionDefinitionInput } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, getReceipt, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { requestRevert } from '../../src/contracts/revert/revert.contract.ts';
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

async function define(apiName: string, def: Omit<VersionDefinitionInput, 'ontologyVersionId' | 'objectTypeId' | 'permittedConnections'>): Promise<string> {
  const type = await gateway.call(proposeActionType, { body: { apiName, displayName: apiName, owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, permittedConnections: [wb.restConnection], ...def,
  } }, keyed(root));
  return type.id;
}

const propose = (actionTypeId: string, reference: string, parameters: Record<string, string> = {}) =>
  gateway.call(proposeMutation, { body: { actionTypeId, parameters, objects: [{ connectionId: wb.restConnection, reference }] } }, keyed(root));

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
});

after(async () => {
  await wb?.close();
});

describe('custom actions (spec 42.5, 42.8)', () => {
  test('publishing: the action is declared, is the only rule, and a compensating revert names what undoes it', async () => {
    const refused = (def: Parameters<typeof define>[1], code: string) => assert.rejects(define(`t_${uuidv7().slice(-8)}`, def), { code });
    await refused({ rules: [{ kind: 'invoke_custom', customAction: 'merge_contact' }] }, 'action_type.operation_undeclared');
    await refused({
      properties: ['score'], rules: [{ kind: 'invoke_custom', customAction: 'archive_contact' }, { kind: 'set_property', property: 'score', value: { cel: '1' } }],
    }, 'action_type.rules_mixed');
    await refused({ properties: ['score'], rules: [{ kind: 'set_property', property: 'score', value: { cel: '1' } }], revertBehaviour: 'compensating' }, 'action_type.revert_unsupported');
    await refused({ rules: [{ kind: 'invoke_custom', customAction: 'send_survey' }], revertBehaviour: 'compensating' }, 'action_type.compensating_unknown');
    await refused({ rules: [{ kind: 'invoke_custom', customAction: 'archive_contact' }], revertBehaviour: 'compensating', compensatingAction: 'send_survey' }, 'action_type.compensating_mismatch');
    await refused({ rules: [{ kind: 'invoke_custom', customAction: 'send_survey' }], revertBehaviour: 'not_revertible' }, 'action_type.not_revertible_physical_only');
  });

  test('invoked with its inputs, read back by the fields it declares, and undone by its compensating action', async () => {
    const archive = await define('archive_contact', {
      parameters: [{ name: 'reason', type: 'string', required: true }],
      rules: [{ kind: 'invoke_custom', customAction: 'archive_contact', inputs: { reason: { parameter: 'reason' } } }], revertBehaviour: 'compensating',
    });
    const m = await propose(archive, 'c1', { reason: 'left the company' });
    assert.deepEqual(m.preview!.rows.map((r) => [r.operation, r.customAction, r.field, r.prior, r.proposed, r.proposedUnknown ?? false]), [
      ['custom', 'archive_contact', null, null, { reason: 'left the company' }, false],
      ['custom', 'archive_contact', 'status', 'active', null, true],
    ], 'the preview shows the inputs, and the field the action changes with its prior value');
    const done = await approveAndRun(m);
    assert.equal(done.status, 'completed');
    assert.deepEqual([wb.contacts.get('c1')!.properties.status, wb.contacts.get('c1')!.properties.reason], ['archived', 'left the company']);
    assert.ok(wb.crmRequests.includes('POST /v1/contacts/c1/archive'));
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, wb.cell.as(root));
    const verifications = (receipt.document as { verifications: { field: string | null; observed: unknown; outcome: string }[] }).verifications;
    assert.deepEqual(verifications.map((v) => [v.field, v.observed, v.outcome]), [['status', 'archived', 'verified']]);

    const revert = await gateway.call(requestRevert, { body: { receiptId: done.receiptId! } }, keyed(root));
    assert.equal(revert.conflictCount, 0);
    assert.deepEqual(revert.mutation.preview!.rows.map((r) => [r.operation, r.customAction, r.field, r.proposed]), [
      ['custom', 'restore_contact', null, { status: 'active' }],
      ['custom', 'restore_contact', 'status', null],
    ], 'the compensating action is sent the stored prior state');
    const reverted = await approveAndRun(revert.mutation);
    assert.equal(reverted.status, 'completed', 'the compensating action left the prior state it was expected to');
    assert.equal(wb.contacts.get('c1')!.properties.status, 'active');
    assert.ok(wb.crmRequests.includes('POST /v1/contacts/c1/restore'));
  });

  test('a custom action reverted three-way has its fields restored by the update', async () => {
    const survey = await define('send_survey', { rules: [{ kind: 'invoke_custom', customAction: 'send_survey' }] });
    const done = await approveAndRun(await propose(survey, 'c2'));
    assert.equal(done.status, 'completed');
    assert.equal(wb.contacts.get('c2')!.properties.status, 'surveyed');
    const revert = await gateway.call(requestRevert, { body: { receiptId: done.receiptId! } }, keyed(root));
    assert.deepEqual(revert.mutation.preview!.rows.map((r) => `${r.operation}:${r.field}:${JSON.stringify(r.prior)}->${JSON.stringify(r.proposed)}`), [
      'update_partial:status:"surveyed"->"active"',
    ]);
    assert.equal((await approveAndRun(revert.mutation)).status, 'completed');
    assert.equal(wb.contacts.get('c2')!.properties.status, 'active');
  });
});

describe('link rules (spec 42.4)', () => {
  test('add_link sets the foreign key the target holds to the linked record; remove_link clears it', async () => {
    await assert.rejects(define('bad_link', {
      parameters: [{ name: 'manager', type: 'string', required: true }],
      rules: [{ kind: 'add_link', linkType: 'manager', object: { parameter: 'manager' } }],
    }), { code: 'action_type.link_parameter' });
    const link = await define('set_manager', {
      parameters: [{ name: 'manager', type: 'object_reference', objectTypeId: wb.contactTypeId, required: true }],
      rules: [{ kind: 'add_link', linkType: 'manager', object: { parameter: 'manager' } }],
    });
    const unlink = await define('clear_manager', { rules: [{ kind: 'remove_link', linkType: 'manager' }] });

    const m = await propose(link, 'c4', { manager: 'c1' });
    assert.deepEqual(m.preview!.rows.map((r) => `${r.operation}:${r.field}:${JSON.stringify(r.prior)}->${JSON.stringify(r.proposed)}`), ['update_partial:manager:null->"c1"']);
    assert.equal((await approveAndRun(m)).status, 'completed');
    assert.equal(wb.contacts.get('c4')!.properties.manager, 'c1');

    const cleared = await approveAndRun(await propose(unlink, 'c4'));
    assert.equal(cleared.status, 'completed');
    assert.equal(wb.contacts.get('c4')!.properties.manager, null);
  });
});
