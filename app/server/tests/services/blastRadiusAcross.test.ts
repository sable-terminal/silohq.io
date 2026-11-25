// The blast radius across systems with no shared key (spec 43.7): a contact lives in the CRM
// and, as a customer, in the database, matched by email; its tickets reference the customer's
// key, which the CRM never holds. Deleting the contact in the CRM reports the tickets, found
// through the counterpart the match key names; and the complaints, whose key names the CRM's own
// id through a route into another system (D248); references and counts only.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { proposeMutation } from '../../src/contracts/actions/mutation.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let deleteContact = '';
const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

before(async () => {
  wb = await createWritebackCell({
    across: true,
    start: async (cell) => {
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
    },
  });
  gateway = wb.gateway;
  root = wb.root;
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

describe('the blast radius across systems (spec 43.7)', () => {
  test('a link held only in another system is followed through the counterpart the match key finds', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: deleteContact, objects: [{ connectionId: wb.restConnection, reference: 'c1' }] } }, keyed(root));
    const radius = m.preview!.blastRadius;
    assert.equal(radius.boundedAtHop, null, 'the walk ran to its end');
    assert.equal(radius.counts!.ontology_link, 5);
    assert.deepEqual(radius.relationships!.map((r) => `${r.via}:${r.kind}:${r.connectionId === wb.sqlConnection}:${r.sourceObject}:${r.count}`).sort(),
      ['complained:ontology_link:true:complaints:3', 'raised:ontology_link:true:tickets:2']);
  });

  test('a record with no counterpart there has nothing across; its relationship is still checked', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: deleteContact, objects: [{ connectionId: wb.restConnection, reference: 'c3' }] } }, keyed(root));
    const radius = m.preview!.blastRadius;
    assert.equal(radius.boundedAtHop, null);
    assert.equal(radius.counts!.ontology_link, 0);
    assert.deepEqual(radius.relationships!.map((r) => `${r.via}:${r.count}`).sort(), ['complained:0', 'raised:0']);
  });
});
