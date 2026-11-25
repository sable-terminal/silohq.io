// The object view's Actions section (spec 34.5) on the write-back cell: Contacts in a CRM that
// takes writes, and Action types targeting them with and without submission criteria.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion, type VersionDefinitionInput } from '../../src/contracts/actions/actionType.contract.ts';
import { resolveActionTargets } from '../../src/contracts/executor/actionTargets.contract.ts';
import { readObjectView, type ObjectView } from '../../src/contracts/executor/objectView.contract.ts';
import { applyMarking, createMarking } from '../../src/contracts/policy/governance.contract.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { service as executorService } from '../../src/routes/executor/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService(), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
      // The executor reads the object and lists the Action types targeting it.
      await cell.start(executorService, 'executor', 'test_app');
    },
  });
});

after(async () => {
  await wb?.close();
});

const keyed = () => ({ ...wb.cell.as(wb.root), idempotencyKey: uuidv7() });

async function actionType(apiName: string, displayName: string, def: Partial<VersionDefinitionInput>): Promise<string> {
  const type = await wb.gateway.call(proposeActionType, { body: { apiName, displayName, owningScopeId: wb.cell.scopes['engineering']! } }, keyed());
  const published = await wb.gateway.call(publishActionTypeVersion, {
    params: { actionTypeId: type.id },
    body: {
      ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: ['score'],
      parameters: [{ name: 'new_score', type: 'integer', required: true }],
      rules: [{ kind: 'set_property', property: 'score', value: { parameter: 'new_score' } }],
      permittedConnections: [wb.restConnection], ...def,
    } as VersionDefinitionInput,
  }, keyed());
  assert.equal(published.status, 'confirmed');
  return type.id;
}

const view = async (reference: string): Promise<ObjectView> => {
  const out = await wb.gateway.call(readObjectView, {
    body: { objectTypeId: wb.contactTypeId, object: { connectionId: wb.restConnection, reference } },
  }, wb.cell.as(wb.root));
  assert.equal(out.outcome, 'object', JSON.stringify(out));
  return (out as { view: ObjectView }).view;
};

describe('the object view\'s Actions (spec 34.5)', () => {
  const ids: Record<string, string> = {};

  before(async () => {
    ids['rescore'] = await actionType('rescore', 'Rescore', {});
    ids['promote'] = await actionType('promote', 'Promote', { submissionCriteria: 'object.score >= 30' });
    ids['escalate'] = await actionType('escalate', 'Escalate', {
      parameters: [{ name: 'new_score', type: 'integer', required: true }, { name: 'reason', type: 'string' }],
      submissionCriteria: 'params.reason != ""',
    });
    ids['add'] = await actionType('add_contact', 'Add contact', {
      properties: ['email', 'name', 'score'], parameters: [{ name: 'email', type: 'string', required: true }],
      rules: [{ kind: 'create_object', values: { email: { parameter: 'email' }, name: { cel: '"New"' }, score: { cel: '0' } } }],
    });
  });

  test('every Action type targeting the object, its criteria checked against the record as read: failing ones disabled with the criterion', async () => {
    const c1 = await view('c1');
    assert.deepEqual(c1.actions!.map((a) => [a.displayName, a.state, a.criterion]), [
      ['Escalate', 'checked_on_submit', 'params.reason != ""'],
      ['Promote', 'criteria_failed', 'object.score >= 30'],
      ['Rescore', 'available', null],
    ], 'creating a contact acts on the type, not this object');
    const rescore = c1.actions!.find((a) => a.actionTypeId === ids['rescore'])!;
    assert.deepEqual(rescore.target, { connectionId: wb.restConnection, reference: 'c1' });
    assert.deepEqual([rescore.riskClass, rescore.physical, rescore.revertBehaviour, rescore.version], ['data', false, 'three_way', 1]);
    assert.deepEqual(rescore.parameters.map((p) => [p.name, p.type, p.required]), [['new_score', 'integer', true]], 'the parameter form\'s declarations');

    const c4 = await view('c4');
    assert.equal(c4.actions!.find((a) => a.actionTypeId === ids['promote'])!.state, 'available', 'a score of 40 meets the criteria');
  });

  test('a canvas selection\'s targets (29.6): each object\'s record the type writes, by the same rule; the rest excluded with why', async () => {
    const [c1, c4] = [(await view('c1')).id, (await view('c4')).id];
    const gone = uuidv7();
    const out = await wb.gateway.call(resolveActionTargets, { body: { objectTypeId: wb.contactTypeId, actionTypeId: ids['rescore']!, objectIds: [c1, c4, gone] } }, wb.cell.as(wb.root));
    assert.deepEqual(out.targets, [
      { objectId: c1, connectionId: wb.restConnection, reference: 'c1' },
      { objectId: c4, connectionId: wb.restConnection, reference: 'c4' },
    ]);
    assert.deepEqual(out.excluded, [{ objectId: gone, reason: 'it was not read just now: gone, or not yours to see' }]);
    await assert.rejects(wb.gateway.call(resolveActionTargets, { body: { objectTypeId: wb.contactTypeId, actionTypeId: ids['add']!, objectIds: [c1] } }, wb.cell.as(wb.root)),
      { code: 'actions.creates_objects' });
    await assert.rejects(wb.gateway.call(resolveActionTargets, { body: { objectTypeId: wb.contactTypeId, actionTypeId: uuidv7(), objectIds: [c1] } }, wb.cell.as(wb.root)),
      { code: 'actions.action_type_not_found' });
  });

  test('an Action type whose marking the reader does not hold is not listed', async () => {
    const marking = await wb.gateway.call(createMarking, { body: { name: 'Escalations', kind: 'compartment' } }, wb.cell.as(wb.root));
    await wb.gateway.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'action_type', id: ids['escalate']! } } }, wb.cell.as(wb.root));
    assert.deepEqual((await view('c1')).actions!.map((a) => a.displayName), ['Promote', 'Rescore']);
  });
});
