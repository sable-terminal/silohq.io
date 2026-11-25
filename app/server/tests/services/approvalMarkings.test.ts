// Marking conditions in approval (spec 44.2 to 44.4): a policy with a marking condition applies
// only when the mutation touches a marked field; a marking_holder approver is cleared for the
// marking touched; a floor with unwaivable markings applies to whatever touches them, and
// nothing configures it away. What a mutation touches is what its receipt inherits (58.6). A
// marking on a source field (its property mapping) counts for every property that maps it, and
// denies the field and the property to a reader not cleared (58.4, 21.15).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion, type VersionDefinitionInput } from '../../src/contracts/actions/actionType.contract.ts';
import { proposeMutation } from '../../src/contracts/actions/mutation.contract.ts';
import { listPropertyMappings } from '../../src/contracts/ontology/mapping.contract.ts';
import { createApprovalPolicy, decideApproval, getChain, listApprovalInbox, setPolicyFloor } from '../../src/contracts/approvals/approval.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let cleared: Signed;
let uncleared: Signed;
let pii = '';
const types: Record<string, string> = {};

const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

async function define(apiName: string, property: 'score' | 'name'): Promise<{ id: string; identity: string }> {
  const type = await gateway.call(proposeActionType, { body: { apiName, displayName: apiName, owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  const def: VersionDefinitionInput = {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: [property],
    rules: [{ kind: 'set_property', property, value: { cel: property === 'score' ? '7' : '"Renamed"' } }], permittedConnections: [wb.restConnection],
  };
  const published = await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: def }, keyed(root));
  return { id: type.id, identity: published.current!.properties[property]! };
}

const propose = (actionTypeId: string, reference: string) =>
  gateway.call(proposeMutation, { body: { actionTypeId, objects: [{ connectionId: wb.restConnection, reference }] } }, keyed(root));
const approve = (chainId: string, diffHash: string, who: Signed) =>
  gateway.call(decideApproval, { params: { chainId }, body: { decision: 'approved', diffHash } }, wb.cell.as(who));

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  cleared = await wb.cell.member('cleared@acme.example', 'Super admin');
  uncleared = await wb.cell.member('uncleared@acme.example', 'Super admin');
  for (const who of [cleared, uncleared]) await wb.grant(who.membershipId, wb.restConnection, 'read');
  await wb.enableWrites(wb.restConnection);

  const score = await define('set_score', 'score');
  const name = await define('set_name', 'name');
  types['score'] = score.id;
  types['name'] = name.id;
  // The score is personal data: marked, and the proposer and one approver are cleared for it.
  pii = (await gateway.call(createMarking, { body: { name: 'PII', kind: 'compartment' } }, wb.cell.as(root))).id;
  await gateway.call(applyMarking, { body: { markingId: pii, resource: { type: 'property', id: score.identity } } }, wb.cell.as(root));
  for (const who of [root, cleared]) await gateway.call(grantClearance, { body: { markingId: pii, holder: { kind: 'membership', id: who.membershipId } } }, wb.cell.as(root));
});

after(async () => {
  await wb?.close();
});

describe('marking conditions (spec 44.3 rule 3)', () => {
  test('a policy conditioned on a marking applies only to a mutation touching it, and its approvers are cleared for it', async () => {
    await assert.rejects(gateway.call(createApprovalPolicy, { body: {
      connectionId: wb.restConnection, approvalsRequired: 2, approverQualification: 'marking_holder', markingCondition: [uuidv7()],
    } }, wb.cell.as(root)), { code: 'approval_policy.marking_unknown' });
    const policy = await gateway.call(createApprovalPolicy, { body: {
      connectionId: wb.restConnection, approvalsRequired: 1, approverQualification: 'marking_holder', markingCondition: [pii],
    } }, wb.cell.as(root));
    assert.deepEqual(policy.markingCondition, [pii]);

    const touching = await propose(types['score']!, 'c1');
    const chain = await gateway.call(getChain, { params: { chainId: touching.chain!.id } }, wb.cell.as(root));
    assert.deepEqual(chain.conditions.map((c) => [c.qualification, c.markingIds]), [['marking_holder', [pii]]]);
    // What waits for a member is what they may decide (Home's "approvals waiting", spec 33.7): the whole inbox lists every pending chain.
    const waiting = async (who: Signed, forMe: 'true' | 'false') =>
      (await gateway.call(listApprovalInbox, { query: { forMe } }, wb.cell.as(who))).chains.map((c) => c.id);
    assert.ok((await waiting(cleared, 'true')).includes(chain.id), 'it waits for an approver cleared for the marking');
    assert.ok(!(await waiting(uncleared, 'true')).includes(chain.id), 'not for one who could not approve it');
    assert.ok((await waiting(uncleared, 'false')).includes(chain.id), 'the whole inbox still lists it');
    await assert.rejects(approve(chain.id, touching.diffHash!, uncleared), { code: 'approval.not_qualified' }, 'an approver not cleared for the marking does not qualify');
    await approve(chain.id, touching.diffHash!, cleared);
    assert.equal((await gateway.call(getChain, { params: { chainId: chain.id } }, wb.cell.as(root))).status, 'approved');

    const untouched = await propose(types['name']!, 'c1');
    const plain = await gateway.call(getChain, { params: { chainId: untouched.chain!.id } }, wb.cell.as(root));
    assert.deepEqual(plain.conditions.map((c) => [c.qualification, c.sources]), [['any_permitted', ['default']]], 'a name change touches no marked field');
    await approve(plain.id, untouched.diffHash!, uncleared);
  });

  test('a floor with unwaivable markings applies to whatever touches them, and only that', async () => {
    const floor = await gateway.call(setPolicyFloor, { body: { connectionId: null, minimumApprovals: 2, unwaivableMarkings: [pii] } }, wb.cell.as(root));
    assert.deepEqual(floor.unwaivableMarkings, [pii]);
    const chainOf = async (actionTypeId: string) =>
      gateway.call(getChain, { params: { chainId: (await propose(actionTypeId, 'c2')).chain!.id } }, wb.cell.as(root));
    const touching = await chainOf(types['score']!);
    assert.deepEqual([touching.approvalsRequired, touching.floorOverrodePolicy], [2, true]);
    const untouched = await chainOf(types['name']!);
    assert.deepEqual([untouched.approvalsRequired, untouched.floorOverrodePolicy], [1, false]);
  });

  test('a marking on a source field counts for the property that maps it, and denies it to a reader not cleared (58.4, 21.15)', async () => {
    const hr = (await gateway.call(createMarking, { body: { name: 'HR', kind: 'compartment' } }, wb.cell.as(root))).id;
    const { mappings } = await gateway.call(listPropertyMappings, { params: { objectTypeId: wb.contactTypeId } }, wb.cell.as(root));
    const nameField = mappings.find((m) => m.connectionId === wb.restConnection && m.fieldPath === 'name')!;
    assert.equal(nameField.apiName, 'name');
    await gateway.call(applyMarking, { body: { markingId: hr, resource: { type: 'property_mapping', id: nameField.id } } }, wb.cell.as(root));
    await gateway.call(grantClearance, { body: { markingId: hr, holder: { kind: 'membership', id: root.membershipId } } }, wb.cell.as(root));
    await gateway.call(createApprovalPolicy, { body: {
      connectionId: wb.restConnection, approvalsRequired: 1, approverQualification: 'marking_holder', markingCondition: [hr],
    } }, wb.cell.as(root));
    const touching = await propose(types['name']!, 'c3');
    const chain = await gateway.call(getChain, { params: { chainId: touching.chain!.id } }, wb.cell.as(root));
    assert.ok(chain.conditions.some((c) => c.qualification === 'marking_holder' && (c.markingIds ?? []).includes(hr)), 'the name field is marked');
    const refused = await gateway.call(proposeMutation, { body: { actionTypeId: types['name']!, objects: [{ connectionId: wb.restConnection, reference: 'c3' }] } },
      keyed(uncleared));
    assert.deepEqual([refused.status, refused.refusedStage], ['refused', 'policy_gate'], 'a reader not cleared for the field cannot write it');
  });
});
