// Write-back end to end (spec 42 to 46.2): Action types confirmed against the ontology and
// the connections' manifests; mutations through intent, resolve, the policy gate, prior
// state and the sealed preview; approval chains resolved from policies and floors, decided by
// qualified people; execution through connect-runtime with read-back verification; receipts
// whose hash is in the audit ledger; a commit on every object. Real processes: credential,
// policy, auth, connect-registry, connect-runtime, ontology, actions, approvals.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getActionType, listActionTypes, proposeActionType, publishActionTypeVersion, rejectActionType, retireActionType, type VersionDefinitionInput } from '../../src/contracts/actions/actionType.contract.ts';
import { getActionSettings, setGenericEdit } from '../../src/contracts/actions/settings.contract.ts';
import { getMutation, getReceipt, listObjectCommits, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { createApprovalPolicy, decideApproval, getChain, setPolicyFloor, supersedeApprovalPolicy } from '../../src/contracts/approvals/approval.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { canonicalJsonBytes } from '../../src/utils/canonicalJson.util.ts';
import { sha256 } from '../../src/utils/crypto.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
let second: Signed;

const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

async function until(mutationId: string, done: (m: MutationView) => boolean, who: Signed = root): Promise<MutationView> {
  for (let i = 0; i < 100; i++) {
    const m = await gateway.call(getMutation, { params: { mutationId } }, wb.cell.as(who));
    if (done(m)) return m;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the mutation did not reach the expected state');
}
const terminal = (m: MutationView) => m.completedAt !== null;

async function actionType(apiName: string, def: (wb: WritebackCell) => VersionDefinitionInput): Promise<string> {
  const type = await gateway.call(proposeActionType, { body: { apiName, displayName: apiName, owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  const published = await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: def(wb) }, keyed(root));
  assert.equal(published.status, 'confirmed');
  return type.id;
}

const setScore = (w: WritebackCell): VersionDefinitionInput => ({
  ontologyVersionId: w.ontologyVersionId, objectTypeId: w.contactTypeId, properties: ['score', 'name'],
  parameters: [
    { name: 'new_score', type: 'integer', required: true, validation: 'new_score >= 0 && new_score <= 100', message: 'Score must be between 0 and 100' },
    { name: 'new_name', type: 'string' },
  ],
  rules: [
    { kind: 'set_property', property: 'score', value: { parameter: 'new_score' } },
    { kind: 'set_property', property: 'name', value: { cel: 'params.new_name == null ? current.name : params.new_name' } },
  ],
  permittedConnections: [w.restConnection],
});

let setScoreType: string;

async function approve(m: MutationView, who: Signed): Promise<void> {
  await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(who));
}

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      // actions and approvals call each other: each is told the other's address.
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService(), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  approver = await wb.cell.member('approver@acme.example', 'Super admin');
  second = await wb.cell.member('second@acme.example', 'Super admin');
  // An approver reads every field in the diff (44.2): a grant on the connections.
  for (const who of [approver, second]) {
    for (const connection of [wb.restConnection, wb.sqlConnection]) await wb.grant(who.membershipId, connection, 'read');
  }
});

after(async () => {
  await wb?.close();
});

describe('Action types (spec 42)', () => {
  test('a version is confirmed against its ontology version and the manifests the connections run', async () => {
    setScoreType = await actionType('set_contact_score', setScore);
    const type = await gateway.call(getActionType, { params: { actionTypeId: setScoreType } }, wb.cell.as(root));
    assert.equal(type.current!.version, 1);
    assert.deepEqual(type.current!.permittedOperations[wb.restConnection]!.operations, ['update_partial']);
    assert.equal(type.current!.properties['score']!.length, 36, 'property identities are recorded');
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'action_type_defined' and payload->'resource'->>'id' = $2`,
      [wb.cell.org, setScoreType]));
    assert.deepEqual(rows.map((r) => [r.detail.version, r.detail.object_type_id]), [[1, wb.contactTypeId]], 'defined once, by its first version (21)');
  });

  test('refused: an unknown property, a property not listed, a CEL that does not type check, a connection that does not contribute', async () => {
    const type = await gateway.call(proposeActionType, { body: { apiName: 'broken', displayName: 'Broken', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
    const publish = (patch: Partial<VersionDefinitionInput>) => gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: { ...setScore(wb), ...patch } }, keyed(root));
    await assert.rejects(publish({ properties: ['nickname'] }), { code: 'action_type.property_unknown' });
    await assert.rejects(publish({ properties: ['score'] }), { code: 'action_type.property_not_listed' });
    await assert.rejects(publish({ parameters: [{ name: 'new_score', type: 'integer', validation: 'new_score >>> 1' }] }), { code: 'action_type.expression_invalid' });
    await assert.rejects(publish({ permittedConnections: [wb.restConnection, wb.sqlConnection] }), { code: 'action_type.connection_not_contributing' });
    await assert.rejects(gateway.call(proposeActionType, { body: { apiName: 'silo.mine', displayName: 'x', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root)),
      { code: 'action_type.name_reserved' });
  });

  test('a member without action.define cannot confirm one', async () => {
    const member = await wb.cell.member('no-policy@acme.example', 'Member');
    await assert.rejects(gateway.call(proposeActionType, { body: { apiName: 'mine', displayName: 'x', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(member)),
      { code: 'action_type.not_permitted' });
  });
});

describe('the mutation path (spec 43)', () => {
  test('refused at the policy gate while the connection has not earned writes; nothing is written', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: setScoreType, parameters: { new_score: 55 }, objects: [{ connectionId: wb.restConnection, reference: 'c1' }] } }, keyed(root));
    assert.equal(m.status, 'refused');
    assert.equal(m.refusedStage, 'policy_gate');
    assert.match(m.refusalReason!, /earned writes/);
    assert.equal(wb.contacts.get('c1')!.properties.score, 10);
  });

  test('refused at intent: a parameter failing its validation, with its message', async () => {
    await wb.enableWrites(wb.restConnection);
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: setScoreType, parameters: { new_score: 500 }, objects: [{ connectionId: wb.restConnection, reference: 'c1' }] } }, keyed(root));
    assert.equal(m.refusedStage, 'intent');
    assert.equal(m.refusalReason, 'Score must be between 0 and 100');
  });

  test('strict resolution refuses a record the source does not have; partial excludes it and says so', async () => {
    const strict = await gateway.call(proposeMutation, {
      body: { actionTypeId: setScoreType, parameters: { new_score: 1 }, objects: [{ connectionId: wb.restConnection, reference: 'c1' }, { connectionId: wb.restConnection, reference: 'nobody' }] },
    }, keyed(root));
    assert.equal(strict.refusedStage, 'resolve');
    const partial = await gateway.call(proposeMutation, {
      body: { actionTypeId: setScoreType, parameters: { new_score: 1 }, resolutionPolicy: 'partial', objects: [{ connectionId: wb.restConnection, reference: 'c4' }, { connectionId: wb.restConnection, reference: 'nobody' }] },
    }, keyed(root));
    assert.equal(partial.status, 'awaiting_approval');
    assert.deepEqual(partial.preview!.excluded, [{ connectionId: wb.restConnection, reference: 'nobody', reason: 'record_not_found' }]);
    assert.equal(partial.rowCount, 1);
  });

  let applied: MutationView;

  test('the preview shows prior and proposed values; the proposer cannot approve their own change', async () => {
    const m = await gateway.call(proposeMutation, {
      body: { actionTypeId: setScoreType, parameters: { new_score: 77 }, objects: [{ connectionId: wb.restConnection, reference: 'c2' }], intent: 'raise Person 2' },
    }, keyed(root));
    assert.equal(m.status, 'awaiting_approval');
    assert.equal(m.riskClass, 'data');
    assert.deepEqual(m.preview!.rows.map((r) => `${r.field}:${JSON.stringify(r.prior)}->${JSON.stringify(r.proposed)}`).sort(),
      ['name:"Person 2"->"Person 2"', 'score:20->77']);
    assert.equal(m.diffHash, sha256(canonicalJsonBytes(m.preview)).toString('hex'), 'the hash is of the diff shown');
    assert.equal(m.chain!.approvalsRequired, 1);
    await assert.rejects(approve(m, root), { code: 'approval.not_qualified' });
    await assert.rejects(gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: '0'.repeat(64) } }, wb.cell.as(approver)),
      { code: 'approval.diff_mismatch' });
    // The diff and values are sealed at rest: no plaintext in the row.
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query('select diff, manifest_values, intent from action.mutations where id = $1', [m.id]));
    assert.equal(rows[0].diff.includes(Buffer.from('Person 2')), false);
    assert.equal(rows[0].intent.includes(Buffer.from('raise')), false);
    applied = m;
  });

  test('the approval executes it: written, read back and verified; a receipt and a commit', async () => {
    await approve(applied, approver);
    const done = await until(applied.id, terminal);
    assert.equal(done.status, 'completed');
    assert.equal(wb.contacts.get('c2')!.properties.score, 77);
    assert.deepEqual(done.verification, { verified: 1, diverged: 0, failed: 0 });
    assert.equal(done.executions[0]!.status, 'succeeded');
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, wb.cell.as(root));
    assert.equal(receipt.documentHash, sha256(canonicalJsonBytes(receipt.document)).toString('hex'), 'the document is what was hashed');
    assert.equal((receipt.summary['counts'] as { verified: number }).verified, 1);
    const objectId = applied.preview!.rows[0]!.objectId;
    const commits = await gateway.call(listObjectCommits, { params: { objectId }, query: {} }, wb.cell.as(root));
    assert.equal(commits.commits.length, 1);
    assert.deepEqual(commits.commits[0]!.approverMembershipIds, [approver.membershipId]);
    // The hash is in the audit ledger.
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'detail'->>'document_hash' as hash from platform.outbox where organisation_id = $1 and payload->>'event' = 'receipt_created'`, [wb.cell.org]));
    assert.ok(rows.some((r) => r.hash === receipt.documentHash));
  });

  test('a source that transforms a value is surfaced as divergence, not smoothed (45.6)', async () => {
    const m = await gateway.call(proposeMutation, {
      body: { actionTypeId: setScoreType, parameters: { new_score: 30, new_name: 'A very long name indeed' }, objects: [{ connectionId: wb.restConnection, reference: 'c3' }] },
    }, keyed(root));
    await approve(m, approver);
    const done = await until(m.id, terminal);
    assert.equal(done.status, 'completed_with_divergence');
    assert.deepEqual(done.verification, { verified: 0, diverged: 1, failed: 0 });
  });

  test('a record changed since its prior state was read is stale: refused at execute, nothing written over it', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: setScoreType, parameters: { new_score: 60 }, objects: [{ connectionId: wb.restConnection, reference: 'c1' }] } }, keyed(root));
    wb.contacts.get('c1')!.properties.score = 99; // edited in the CRM meanwhile
    await approve(m, approver);
    const done = await until(m.id, terminal);
    assert.equal(done.status, 'refused');
    assert.equal(done.refusedStage, 'execute');
    assert.equal(wb.contacts.get('c1')!.properties.score, 99);
  });

  test('one rejection rejects the chain and the mutation', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: setScoreType, parameters: { new_score: 5 }, objects: [{ connectionId: wb.restConnection, reference: 'c4' }] } }, keyed(root));
    await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'rejected', diffHash: m.diffHash! } }, wb.cell.as(approver));
    const after = await gateway.call(getMutation, { params: { mutationId: m.id } }, wb.cell.as(root));
    assert.equal(after.status, 'rejected');
    assert.equal(after.chain!.status, 'rejected');
    // The snapshot's conditions are stored in the form the database's step guard reads
    // (self_approval_permitted), or a self-approval the policy permits would be refused.
    const { rows } = await wb.cell.migrate.query(
      `select policy_snapshot -> 'conditions' -> 0 as c from action.approval_chains where id = $1`, [m.chain!.id]);
    assert.equal(typeof rows[0].c.self_approval_permitted, 'boolean');
    assert.equal('selfApprovalPermitted' in rows[0].c, false);
  });
});

describe('the generic governed edit (spec 42.9)', () => {
  const edit = (set: Record<string, number>, reference = 'c5') => gateway.call(proposeMutation, {
    body: { edit: { objectTypeId: wb.contactTypeId, operation: 'update', set }, objects: [{ connectionId: wb.restConnection, reference }], intent: 'a change no type covers' },
  }, keyed(root));
  const events = async (name: string) => (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
    `select payload->'resource'->>'id' as resource, payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by seq`,
    [wb.cell.org, name]))).rows as { resource: string; detail: Record<string, unknown> }[];

  test('a change no Action type covers compiles to its own definition, passes the full path, executes, and is counted', async () => {
    const settings = await gateway.call(getActionSettings, {}, wb.cell.as(root));
    assert.equal(settings.genericEdit.enabled, true);
    const m = await edit({ score: 55 });
    assert.equal(m.status, 'awaiting_approval', JSON.stringify(m).slice(0, 400));
    assert.equal(m.genericEdit, true);
    assert.deepEqual(m.preview!.rows.map((r) => `${r.field}:${JSON.stringify(r.prior)}->${JSON.stringify(r.proposed)}`), ['score:50->55']);
    await assert.rejects(approve(m, root), { code: 'approval.not_qualified' }, 'approved by named people like any Action');
    await approve(m, approver);
    const done = await until(m.id, terminal);
    assert.equal(done.status, 'completed');
    assert.equal(wb.contacts.get('c5')!.properties.score, 55);

    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select m.generic_edit, v.confirmed_by, v.action_type_id, t.api_name, t.is_system, t.status, t.proposed_by_membership_id
       from action.mutations m join action.action_type_versions v on v.id = m.action_type_version_id join action.action_types t on t.id = v.action_type_id
       where m.id = $1`, [m.id]));
    assert.deepEqual(rows[0], {
      generic_edit: true, confirmed_by: null, action_type_id: settings.genericEdit.actionTypeId, api_name: 'silo.edit', is_system: true, status: 'confirmed',
      proposed_by_membership_id: null,
    }, 'Silo\'s own type, no proposer, its version confirmed by no member');
    const compiled = (await events('generic_edit_compiled')).find((e) => e.resource === m.id)!;
    assert.deepEqual([compiled.detail['operation'], compiled.detail['properties'], compiled.detail['row_count']], ['update', 1, 1]);
    assert.deepEqual(Object.keys(compiled.detail).sort(), ['action_type_version_id', 'object_type_id', 'operation', 'properties', 'row_count'],
      'references and counts, never a value');
    const listed = await gateway.call(listActionTypes, { query: {} }, wb.cell.as(root));
    assert.ok(!listed.actionTypes.some((t) => t.isSystem), 'not listed among the confirmed Action types');
  });

  test('refused for what it may not write, and while the organisation disables it, with the offer of an Action type', async () => {
    await assert.rejects(edit({ nope: 1 }), { code: 'action_type.property_unknown' });
    await assert.rejects(gateway.call(proposeMutation, {
      body: { edit: { objectTypeId: wb.contactTypeId, operation: 'update', set: { score: 1 } }, parameters: { score: 1 }, objects: [] },
    }, keyed(root)), { category: 'validation' }, 'its values are in the edit');
    const member = await wb.cell.member('edit-policy@acme.example', 'Member');
    await assert.rejects(gateway.call(setGenericEdit, { body: { enabled: false } }, wb.cell.as(member)), { code: 'action_settings.not_permitted' });
    const off = await gateway.call(setGenericEdit, { body: { enabled: false } }, wb.cell.as(root));
    assert.equal(off.genericEdit.enabled, false);
    await assert.rejects(edit({ score: 56 }), (e: { code?: string; details?: Record<string, unknown> }) =>
      e.code === 'mutation.generic_edit_disabled' && e.details?.['offer'] === 'propose_action_type');
    assert.deepEqual((await events('generic_edit_policy_set')).map((e) => e.detail['enabled']), [false]);
    await gateway.call(setGenericEdit, { body: { enabled: true } }, wb.cell.as(root));
    assert.equal((await edit({ score: 57 })).status, 'awaiting_approval');
  });
});

describe('SQL creates and deletes through Action types', () => {
  test('a create and a delete commit in the customer database and verify', async () => {
    await wb.enableWrites(wb.sqlConnection);
    const createOrder = await actionType('create_order', (w) => ({
      ontologyVersionId: w.ontologyVersionId, objectTypeId: w.orderTypeId, properties: ['order_id', 'customer', 'status', 'amount'],
      parameters: [{ name: 'id', type: 'integer', required: true }, { name: 'customer', type: 'string', required: true }, { name: 'amount', type: 'decimal', required: true }],
      rules: [{ kind: 'create_object', values: { order_id: { parameter: 'id' }, customer: { parameter: 'customer' }, status: { cel: '"open"' }, amount: { parameter: 'amount' } } }],
      permittedConnections: [w.sqlConnection],
    }));
    // The table became a target when the type naming it was confirmed (48.1); a REST connection's never is one.
    const targets = (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'resource'->>'id' as type, payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'warehouse_target_confirmed'`,
      [wb.cell.org]))).rows;
    assert.deepEqual(targets.filter((t) => t.type === createOrder).map((t) => [t.detail.connection_id, t.detail.operations]), [[wb.sqlConnection, 'create']]);
    assert.ok(!targets.some((t) => t.detail.connection_id === wb.restConnection));
    const created = await gateway.call(proposeMutation, { body: { actionTypeId: createOrder, parameters: { id: 50, customer: 'Initech', amount: 12.5 } } }, keyed(root));
    assert.equal(created.status, 'awaiting_approval');
    await approve(created, approver);
    assert.equal((await until(created.id, terminal)).status, 'completed');
    const { rows } = await wb.customer.query('select customer, status, amount from sales.orders where id = 50');
    assert.deepEqual(rows, [{ customer: 'Initech', status: 'open', amount: '12.50' }]);

    const deleteOrder = await actionType('delete_order', (w) => ({
      ontologyVersionId: w.ontologyVersionId, objectTypeId: w.orderTypeId, rules: [{ kind: 'delete_object' }], permittedConnections: [w.sqlConnection],
    }));
    const deleted = await gateway.call(proposeMutation, { body: { actionTypeId: deleteOrder, objects: [{ connectionId: wb.sqlConnection, reference: '3' }] } }, keyed(root));
    assert.equal(deleted.preview!.rows[0]!.proposedAbsent, true);
    assert.deepEqual(deleted.preview!.rows[0]!.prior, { id: 3, customer: 'customer 3', status: 'open', amount: 30 }, 'the full readable record is the prior state');
    await approve(deleted, approver);
    assert.equal((await until(deleted.id, terminal)).status, 'completed');
    assert.equal((await wb.customer.query('select 1 from sales.orders where id = 3')).rowCount, 0);
  });
});

describe('approval policies, floors and the union (spec 44.3)', () => {
  test('a connection policy asking two approvers: both, distinct; a floor raises a weaker policy and records it', async () => {
    const policy = await gateway.call(createApprovalPolicy, { body: { connectionId: wb.restConnection, approvalsRequired: 2 } }, wb.cell.as(root));
    assert.equal(policy.approvalsRequired, 2);
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: setScoreType, parameters: { new_score: 41 }, objects: [{ connectionId: wb.restConnection, reference: 'c4' }] } }, keyed(root));
    assert.equal(m.chain!.approvalsRequired, 2);
    await approve(m, approver);
    await assert.rejects(approve(m, approver), { code: 'approval.already_decided' });
    assert.equal((await gateway.call(getMutation, { params: { mutationId: m.id } }, wb.cell.as(root))).status, 'awaiting_approval');
    await approve(m, second);
    assert.equal((await until(m.id, terminal)).status, 'completed');

    await gateway.call(setPolicyFloor, { body: { connectionId: null, minimumApprovals: 3 } }, wb.cell.as(root));
    const floored = await gateway.call(proposeMutation, { body: { actionTypeId: setScoreType, parameters: { new_score: 42 }, objects: [{ connectionId: wb.restConnection, reference: 'c4' }] } }, keyed(root));
    const chain = await gateway.call(getChain, { params: { chainId: floored.chain!.id } }, wb.cell.as(root));
    assert.equal(chain.approvalsRequired, 3);
    assert.equal(chain.floorOverrodePolicy, true);

    // policy_changed (44.9): created, then superseded by a weaker one, before and after in one row.
    const weaker = await gateway.call(supersedeApprovalPolicy, { params: { policyId: policy.id }, body: { connectionId: wb.restConnection, approvalsRequired: 1 } },
      wb.cell.as(root));
    const changes = (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'resource'->>'id' as resource, payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'policy_changed' order by seq`,
      [wb.cell.org]))).rows.filter((e) => e.detail['connection_id'] === wb.restConnection);
    assert.deepEqual(changes.map((e) => [e.resource, e.detail['from_policy_id'], e.detail['approvals_required_before'], e.detail['approvals_required_after']]),
      [[policy.id, null, null, 2], [weaker.id, policy.id, 2, 1]]);
  });
});

describe('retiring an Action type (42.10)', () => {
  test('a retired type takes no new mutations', async () => {
    const type = await gateway.call(getActionType, { params: { actionTypeId: setScoreType } }, wb.cell.as(root));
    await gateway.call(retireActionType, { params: { actionTypeId: setScoreType }, body: { version: type.version } }, wb.cell.as(root));
    await assert.rejects(gateway.call(proposeMutation, { body: { actionTypeId: setScoreType, parameters: { new_score: 1 }, objects: [{ connectionId: wb.restConnection, reference: 'c1' }] } }, keyed(root)),
      { code: 'mutation.type_not_confirmed' });
  });
});

describe('rejecting and blocking an Action type (42.10, 42.11)', () => {
  test('a proposal is rejected with a reason and never confirmed; a confirmed one is not rejected', async () => {
    const proposed = await gateway.call(proposeActionType, { body: { apiName: 'declined', displayName: 'Declined', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
    const member = await wb.cell.member('reject-member@acme.example', 'Member');
    await assert.rejects(gateway.call(rejectActionType, { params: { actionTypeId: proposed.id }, body: { version: proposed.version, reason: 'not_needed' } }, wb.cell.as(member)),
      { code: 'action_type.not_permitted' });
    const rejected = await gateway.call(rejectActionType, { params: { actionTypeId: proposed.id }, body: { version: proposed.version, reason: 'not_needed' } }, wb.cell.as(root));
    assert.equal(rejected.status, 'rejected');
    const confirmedId = await actionType('kept_for_reject', setScore);
    const confirmed = await gateway.call(getActionType, { params: { actionTypeId: confirmedId } }, wb.cell.as(root));
    await assert.rejects(gateway.call(rejectActionType, { params: { actionTypeId: confirmedId }, body: { version: confirmed.version, reason: 'wrong' } }, wb.cell.as(root)),
      { code: 'action_type.status_move' });
    const { rows } = await wb.cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'action_type_rejected'`, [wb.cell.org]);
    assert.deepEqual(rows.map((r) => r.detail.reason), ['not_needed']);
  });

  test('a type whose operation a source no longer declares is blocked at the next proposal, until a new version is published', async () => {
    const id = await actionType('blocked_by_source', setScore);
    const version = (await gateway.call(getActionType, { params: { actionTypeId: id } }, wb.cell.as(root))).current!;
    // As if the connection's manifest had since dropped the operation: the version now asks for one it does not declare.
    await wb.cell.migrate.query('begin');
    await wb.cell.migrate.query('set local session_replication_role = replica');
    await wb.cell.migrate.query(`update action.action_type_versions set permitted_operations = jsonb_set(permitted_operations, $2::text[], '["upsert"]') where id = $1`,
      [version.id, `{${wb.restConnection},operations}`]);
    await wb.cell.migrate.query('commit');
    const propose = () => gateway.call(proposeMutation, { body: { actionTypeId: id, parameters: { new_score: 5 }, objects: [{ connectionId: wb.restConnection, reference: 'c1' }] } }, keyed(root));
    await assert.rejects(propose(), { code: 'mutation.type_blocked' });
    assert.equal((await gateway.call(getActionType, { params: { actionTypeId: id } }, wb.cell.as(root))).status, 'blocked');
    await assert.rejects(propose(), { code: 'mutation.type_not_confirmed' }, 'blocked, it takes none');
    const { rows } = await wb.cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'action_type_blocked' and payload->'resource'->>'id' = $2`, [wb.cell.org, id]);
    assert.deepEqual(rows.map((r) => [r.detail.connection_id, r.detail.operation]), [[wb.restConnection, 'upsert']]);
    const republished = await gateway.call(publishActionTypeVersion, { params: { actionTypeId: id }, body: setScore(wb) }, keyed(root));
    assert.equal(republished.status, 'confirmed', 'a new version, checked against the manifest as it is, unblocks it');
  });
});
