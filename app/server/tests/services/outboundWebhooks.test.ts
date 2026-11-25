// Outbound webhooks as Action side effects (spec 20.4, 42.6): a target registered on a
// connection with a secret shown once; an Action type naming it is at least external, and
// physical when the target is; an executed Action queues one delivery, which notify posts
// signed with HMAC-SHA256 over timestamp and body, the execution identifier as idempotency
// key, references and never values; retried with backoff for 24 hours, then failed. A revoked
// target signs nothing more. A type may shape the body with JSONata over the executed Action,
// its parameters included; the queued payload is sealed. The endpoint is a fake egress.
// A physical target (47.1, 47.4) names its action: an Action posting to it is checked against
// the connection's signed allow-list at intent, queued under its entry and logged as a
// physical write, checked again before each attempt (and by the agent, for a private target,
// whose refusal is final), and reverted by the inverse target its entry names.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { getActionType, proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { decideAllowlistRequest, removeAllowlistEntry, requestAllowlistEntry } from '../../src/contracts/actions/allowlist.contract.ts';
import { declareWritablePoint } from '../../src/contracts/connect-registry/writablePoint.contract.ts';
import { grantRole } from '../../src/contracts/policy/admin.contract.ts';
import { requestRevert } from '../../src/contracts/revert/revert.contract.ts';
import { service as revertService } from '../../src/routes/revert/index.route.ts';
import { PHYSICAL_STATEMENT } from '../../src/services/actions/physical.service.ts';
import { getMutation, getReceipt, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { listOutboundWebhooks, registerOutboundWebhook, revokeOutboundWebhook } from '../../src/contracts/connect-registry/outboundWebhook.contract.ts';
import { listWebhookDeliveries } from '../../src/contracts/actions/webhookDelivery.contract.ts';
import type { EgressRequest, EgressResult } from '../../src/infra/egress.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import type { WebhookDelivery } from '../../src/services/notify/webhooks.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
/** Holds actuation.approve (the Physical operations role): the second of a physical Action's two approvers. */
let ops: Signed;
let delivery: WebhookDelivery;
const sent: EgressRequest[] = [];
const replies: number[] = [];
/** What a status endpoint answers next (a GET), as JSON text. */
const statusBodies: string[] = [];
const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

const egress = {
  async send(request: EgressRequest): Promise<EgressResult> {
    sent.push(request);
    const body = request.method === 'GET' ? Buffer.from(statusBodies.shift() ?? '{"state":"pending"}') : Buffer.alloc(0);
    return { status: replies.shift() ?? 200, headers: {}, setCookies: [], body };
  },
};

async function executed(actionTypeId: string, score: number, reference: string): Promise<MutationView> {
  const m = await gateway.call(proposeMutation, { body: { actionTypeId, parameters: { score }, objects: [{ connectionId: wb.restConnection, reference }] } }, keyed(root));
  await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(approver));
  for (let i = 0; i < 100; i++) {
    const done = await gateway.call(getMutation, { params: { mutationId: m.id } }, wb.cell.as(root));
    if (done.completedAt !== null) return done;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the mutation did not finish');
}

const propose = (actionTypeId: string, score: number, reference: string, connectionId = wb.restConnection) => gateway.call(proposeMutation, {
  body: { actionTypeId, parameters: { score }, objects: [{ connectionId, reference }] },
}, keyed(root));

/** A physical Action: approved by two people, one holding actuation.approve (47.2), then run to its end. */
async function approvedByTwo(m: MutationView): Promise<MutationView> {
  for (const who of [approver, ops]) {
    await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(who));
  }
  for (let i = 0; i < 100; i++) {
    const done = await gateway.call(getMutation, { params: { mutationId: m.id } }, wb.cell.as(root));
    if (done.completedAt !== null) return done;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the mutation did not finish');
}

/** A physical webhook action's writable point and its signed allow-list entry, decided by a second person. */
async function allowlisted(connectionId: string, action: string, entry: Record<string, unknown> = {}, valueCheck = 'true'): Promise<string> {
  await gateway.call(declareWritablePoint, {
    params: { connectionId }, body: { address: action, riskClass: 'physical', valueCheck: { cel: valueCheck }, settleSeconds: 0, testSafe: false },
  }, wb.cell.as(root));
  const asked = await gateway.call(requestAllowlistEntry, {
    params: { connectionId }, body: { nodeAddress: action, kind: 'command', dataType: 'Json', objectId: uuidv7(), minIntervalSeconds: 0, ...entry } as never,
  }, wb.cell.as(root));
  return (await gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision: 'approve' } }, wb.cell.as(ops))).entry!.id;
}

const events = async (name: string) => (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
  `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at`, [wb.cell.org, name]))).rows
  .map((r) => r.detail as Record<string, unknown>);

const actionType = async (apiName: string, endpointId: string, riskClass: 'external' | 'physical', payload?: string) => {
  const type = await gateway.call(proposeActionType, { body: { apiName, displayName: apiName, owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: ['score'],
    parameters: [{ name: 'score', type: 'integer', required: true }], rules: [{ kind: 'set_property', property: 'score', value: { parameter: 'score' } }],
    permittedConnections: [wb.restConnection], sideEffects: [{ kind: 'webhook', endpointId, ...(payload === undefined ? {} : { payload: { jsonata: payload } }) }], riskClass,
  } as never }, keyed(root));
  return type.id;
};

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      // notify asks actions for each grant through the agent: it learns actions' address first.
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createNotifyService({ egress, sweep: false, onWebhooks: (d) => { delivery = d; } }), 'notify', 'test_app',
        { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://app.test/', SERVICE_URL_ACTIONS: `http://127.0.0.1:${actionsPort}` });
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

describe('outbound webhooks (spec 20.4, 42.6)', () => {
  let secret = '';
  let endpointId = '';
  let typeId = '';

  test('a target is HTTPS, registered with a secret shown once; an Action type naming it must be external', async () => {
    await assert.rejects(gateway.call(registerOutboundWebhook, { params: { connectionId: wb.restConnection }, body: { targetUrl: 'http://hooks.example/silo' } },
      wb.cell.as(root)), { code: 'contract.request_invalid' });
    const registered = await gateway.call(registerOutboundWebhook, {
      params: { connectionId: wb.restConnection }, body: { targetUrl: 'https://hooks.example/silo' },
    }, wb.cell.as(root));
    ({ secret } = registered);
    endpointId = registered.endpoint.id;
    assert.ok(secret.length >= 40);
    assert.deepEqual((await gateway.call(listOutboundWebhooks, { params: { connectionId: wb.restConnection } }, wb.cell.as(root))).endpoints.map((e) => e.id), [endpointId]);
    await assert.rejects(actionType('notify_crm_data', endpointId, 'data' as never), { code: 'action_type.risk_class_low' });
    typeId = await actionType('notify_crm', endpointId, 'external');
    assert.equal((await gateway.call(getActionType, { params: { actionTypeId: typeId } }, wb.cell.as(root))).current!.riskClass, 'external');
  });

  test('an executed Action queues one delivery; notify posts it signed, references only, the execution id its idempotency key', async () => {
    const done = await executed(typeId, 33, 'c1');
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, wb.cell.as(root));
    assert.deepEqual((receipt.document as { sideEffects: unknown }).sideEffects, [{ kind: 'webhook', outcome: 'queued', recipients: 0, reason: 'delivery_recorded_not_effect' }],
      'the receipt records delivery, not effect');
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 1, retried: 0, failed: 0 });
    const request = sent.at(-1)!;
    assert.equal(request.url.toString(), 'https://hooks.example/silo');
    assert.equal(request.headers!['idempotency-key'], `${done.id}:${endpointId}`);
    const body = String(request.body);
    const expected = `v1=${createHmac('sha256', secret).update(`${request.headers!['silo-timestamp']}.${body}`).digest('hex')}`;
    assert.equal(request.headers!['silo-signature'], expected, 'the receiver verifies it with the secret it was shown');
    const payload = JSON.parse(body);
    assert.deepEqual([payload.mutationId, payload.receiptId, payload.actionTypeId], [done.id, done.receiptId, typeId]);
    assert.deepEqual(Object.keys(payload).sort(), ['actionTypeId', 'actionTypeVersionId', 'mutationId', 'objectIds', 'objectTypeId', 'origin', 'receiptId'],
      'references only, never a value');
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->>'event' as event from platform.outbox where organisation_id = $1 and payload->>'event' like 'outbound_webhook_%' order by created_at`, [wb.cell.org]));
    assert.deepEqual(rows.map((r) => r.event), ['outbound_webhook_registered', 'outbound_webhook_delivered']);
  });

  test('a refusal is retried with backoff and fails after 24 hours; a revoked target fails what is pending', async () => {
    await executed(typeId, 44, 'c2');
    replies.push(503);
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 0, retried: 1, failed: 0 });
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 0, retried: 0, failed: 0 }, 'not due again until the backoff passes');
    replies.push(500);
    assert.deepEqual(await delivery.deliverDue(uuidv7(), new Date(Date.now() + 25 * 3_600_000)), { delivered: 0, retried: 0, failed: 1 });
    const revoked = await gateway.call(revokeOutboundWebhook, { params: { endpointId } }, wb.cell.as(root));
    assert.equal(revoked.status, 'revoked');
    await executed(typeId, 55, 'c3');
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 0, retried: 0, failed: 1 }, 'a revoked target sends nothing more');
  });

  test('a type may shape the body with JSONata over the executed Action, its parameters included; the queued payload is sealed', async () => {
    const target = await gateway.call(registerOutboundWebhook, {
      params: { connectionId: wb.restConnection }, body: { targetUrl: 'https://crm-sync.example/scores' },
    }, wb.cell.as(root));
    await assert.rejects(actionType('shaped_bad', target.endpoint.id, 'external', '{"a": '), { code: 'action_type.expression_invalid' });
    const shaped = await actionType('shaped_score', target.endpoint.id, 'external', '{"contact": objects[0].reference, "score": parameters.score, "mutation": mutationId}');
    const done = await executed(shaped, 61, 'c4');
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      'select payload from action.webhook_deliveries where mutation_id = $1', [done.id]));
    assert.ok(!rows[0]!.payload.toString('latin1').includes('61'), 'sealed at rest');
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 1, retried: 0, failed: 0 });
    assert.deepEqual(JSON.parse(String(sent.at(-1)!.body)), { contact: 'c4', score: 61, mutation: done.id });
    const { rows: [cleared] } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      'select payload, payload_cleared_at from action.webhook_deliveries where mutation_id = $1', [done.id]));
    assert.equal(cleared!.payload, null, 'delivered, its values are not kept (65.3)');
    assert.ok(cleared!.payload_cleared_at);
  });

  test('a target declared physical names its action and makes the type physical; its Action is refused until the action is allow-listed', async () => {
    const register = (body: Record<string, unknown> = {}) => gateway.call(registerOutboundWebhook, {
      params: { connectionId: wb.restConnection }, body: { targetUrl: 'https://plant.example/valve', riskClass: 'physical', actionName: 'open_valve', ...body } as never,
    }, wb.cell.as(root));
    await assert.rejects(register({ actionName: undefined }), { code: 'contract.request_invalid' }, 'a physical target is allow-listed by its action\'s name');
    // Nobody can approve a physical Action yet: not even a super admin holds actuation.approve by default (20.8, 47.8).
    await assert.rejects(register(), { code: 'connection.physical_operations_unstaffed' });
    const { rows } = await wb.cell.migrate.query(
      `select r.name, array_agg(rp.permission_id order by rp.permission_id) filter (where rp.permission_id = 'actuation.approve') as approve
       from iam.roles r left join iam.role_permissions rp on rp.organisation_id = r.organisation_id and rp.role_id = r.id
       where r.organisation_id = $1 and r.name in ('Super admin', 'Physical operations') group by r.name order by r.name`, [wb.cell.org]);
    assert.deepEqual(rows.map((r) => [r.name, r.approve]), [['Physical operations', ['actuation.approve']], ['Super admin', null]]);
    ops = await wb.cell.member('plant-ops@acme.example', 'Super admin');
    await gateway.call(grantRole, { body: { membershipId: ops.membershipId, roleId: wb.cell.roles['Physical operations']! } }, wb.cell.as(root));
    await wb.grant(ops.membershipId, wb.restConnection, 'read');
    const physical = await register();
    valveTarget = physical.endpoint.id;
    assert.deepEqual([physical.endpoint.riskClass, physical.endpoint.actionName], ['physical', 'open_valve']);
    await assert.rejects(register({ targetUrl: 'https://plant.example/other' }), { code: 'webhook.action_taken' }, 'one live target per action');
    await assert.rejects(actionType('open_valve_ext', valveTarget, 'external'), { code: 'action_type.risk_class_low' });
    valveType = await actionType('open_valve', valveTarget, 'physical');
    const m = await propose(valveType, 1, 'c4');
    assert.deepEqual([m.status, m.riskClass, m.refusedStage], ['refused', 'physical', 'policy_gate']);
    assert.match(m.refusalReason!, /webhook open_valve is not in the connection's actuation allow-list/);
  });

  let valveTarget = '';
  let closeTarget = '';
  let valveType = '';
  let valveReceipt = '';
  let pending: MutationView;

  test('a physical webhook is listed as a command by its action; its point checks the parameters; the preview names it, two people approve', async () => {
    await gateway.call(declareWritablePoint, {
      params: { connectionId: wb.restConnection }, body: { address: 'open_valve', riskClass: 'physical', valueCheck: { cel: 'values.score <= 50' }, settleSeconds: 0, testSafe: false },
    }, wb.cell.as(root));
    const ask = (entry: Record<string, unknown>) => gateway.call(requestAllowlistEntry, {
      params: { connectionId: wb.restConnection },
      body: { nodeAddress: 'open_valve', kind: 'command', dataType: 'Json', objectId: uuidv7(), minIntervalSeconds: 3600, ...entry } as never,
    }, wb.cell.as(root));
    await assert.rejects(ask({ kind: 'setpoint' }), { code: 'actuation.webhook_not_command' });
    await assert.rejects(ask({ simulatorAddress: 'sim_valve' }), { code: 'actuation.webhook_no_simulator' });
    await assert.rejects(ask({ inverseCommand: 'close_valve' }), { code: 'actuation.webhook_inverse_missing' });
    closeTarget = (await gateway.call(registerOutboundWebhook, {
      params: { connectionId: wb.restConnection }, body: { targetUrl: 'https://plant.example/valve/close', riskClass: 'physical', actionName: 'close_valve' },
    }, wb.cell.as(root))).endpoint.id;
    const asked = await ask({ inverseCommand: 'close_valve' });
    await gateway.call(decideAllowlistRequest, { params: { requestId: asked.id }, body: { decision: 'approve' } }, wb.cell.as(ops));

    const over = await propose(valveType, 99, 'c4');
    assert.deepEqual([over.status, over.refusedStage], ['refused', 'intent'], 'the point\'s value check reads the parameters');
    pending = await propose(valveType, 5, 'c4');
    assert.equal(pending.status, 'awaiting_approval', pending.refusalReason ?? '');
    assert.ok(pending.chain!.approvalsRequired >= 2);
    const preview = pending.preview!;
    assert.deepEqual(preview.sideEffects, [{ kind: 'webhook', physical: true, records: 'delivery' }]);
    assert.equal(preview.physical!.statement, PHYSICAL_STATEMENT);
    assert.deepEqual(preview.physical!.nodes.map((n) => [n.nodeAddress, n.command, n.endpointId, n.proposed, n.minIntervalSeconds, n.lastWrittenAt]),
      [['open_valve', 'open_valve', valveTarget, { score: 5 }, 3600, null]]);
  });

  test('executed, it is queued under its entry and logged as a physical write; another inside the interval is refused', async () => {
    const done = await approvedByTwo(pending);
    assert.equal(done.status, 'completed', done.refusalReason ?? '');
    valveReceipt = done.receiptId!;
    const receipt = await gateway.call(getReceipt, { params: { receiptId: valveReceipt } }, wb.cell.as(root));
    assert.deepEqual((receipt.document as { sideEffects: unknown }).sideEffects, [{ kind: 'webhook', outcome: 'queued', recipients: 0, reason: 'delivery_recorded_not_effect' }]);
    const { rows: queued } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      'select d.allowlist_entry_id, w.node_address, w.outcome from action.webhook_deliveries d join action.physical_writes w on w.mutation_id = d.mutation_id where d.mutation_id = $1', [done.id]));
    assert.equal(queued.length, 1);
    assert.ok(queued[0]!.allowlist_entry_id);
    assert.deepEqual([queued[0]!.node_address, queued[0]!.outcome], ['open_valve', 'unknown'], 'its effect is the target\'s: unknown to Silo');
    const [executedEvent] = await events('physical_action_executed');
    assert.deepEqual([executedEvent!['entries'], executedEvent!['node']], [[queued[0]!.allowlist_entry_id], 'open_valve']);

    const again = await propose(valveType, 6, 'c5');
    assert.deepEqual([again.status, again.refusedStage], ['refused', 'plan']);
    assert.match(again.refusalReason!, /sent less than 3600 seconds ago/);
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 1, retried: 0, failed: 0 });
    assert.equal(sent.at(-1)!.url.toString(), 'https://plant.example/valve');
  });

  test('a revert sends the inverse its entry names under two approvers, never the original again; an inverse not listed refuses it', async () => {
    await assert.rejects(gateway.call(requestRevert, { body: { receiptId: valveReceipt, scope: 'full' } }, keyed(root)), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, 'revert.physical_refused');
      assert.match(error.message!, /webhook close_valve is not in the connection's actuation allow-list/);
      return true;
    });
    await allowlisted(wb.restConnection, 'close_valve');
    const revert = await gateway.call(requestRevert, { body: { receiptId: valveReceipt, scope: 'full' } }, keyed(root));
    const m = await gateway.call(getMutation, { params: { mutationId: revert.newMutationId } }, wb.cell.as(root));
    assert.deepEqual([m.status, m.origin, m.riskClass], ['awaiting_approval', 'revert', 'physical'], m.refusalReason ?? '');
    assert.ok(m.chain!.approvalsRequired >= 2);
    assert.deepEqual(m.preview!.physical!.nodes.map((n) => [n.command, n.endpointId]), [['close_valve', closeTarget]]);
    const reverted = await approvedByTwo(m);
    assert.equal(reverted.status, 'completed', reverted.refusalReason ?? '');
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      'select endpoint_id from action.webhook_deliveries where mutation_id = $1', [reverted.id]));
    assert.deepEqual(rows.map((r) => r.endpoint_id), [closeTarget], 'the inverse only: the valve is not opened again');
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 1, retried: 0, failed: 0 });
    assert.equal(sent.at(-1)!.url.toString(), 'https://plant.example/valve/close');
  });

  test('an entry removed after its Action is queued: the delivery fails, never sent and never retried', async () => {
    const entry = (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select id from action.actuation_allowlists where node_address = 'close_valve' and removed_at is null`))).rows[0]!.id as string;
    const closeType = await actionType('close_valve', closeTarget, 'physical');
    const done = await approvedByTwo(await propose(closeType, 3, 'c5'));
    assert.equal(done.status, 'completed', done.refusalReason ?? '');
    await gateway.call(removeAllowlistEntry, { params: { entryId: entry } }, wb.cell.as(ops));
    const before = sent.length;
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 0, retried: 0, failed: 1 });
    assert.equal(sent.length, before, 'nothing is sent');
    assert.equal((await events('outbound_webhook_failed')).at(-1)!['reason'], 'actuation.not_listed');
  });
});

describe('a webhook\'s effect, and private targets through the agent (spec 20.4)', () => {
  const deliveries = async (mutationId: string) => (await gateway.call(listWebhookDeliveries, { params: { mutationId } }, wb.cell.as(root))).deliveries;
  const later = (ms: number) => new Date(Date.now() + ms);

  test('a target declaring a status endpoint: the receipt records effect; after delivery its effect is asked, signed, until it says', async () => {
    const target = await gateway.call(registerOutboundWebhook, {
      params: { connectionId: wb.restConnection }, body: { targetUrl: 'https://erp-sync.example/orders', statusUrl: 'https://erp-sync.example/orders/status' },
    }, wb.cell.as(root));
    assert.deepEqual([target.endpoint.statusUrl, target.endpoint.sentFrom], ['https://erp-sync.example/orders/status', 'cell']);
    const typeId = await actionType('sync_erp', target.endpoint.id, 'external');
    const proposed = await gateway.call(proposeMutation, { body: { actionTypeId: typeId, parameters: { score: 71 }, objects: [{ connectionId: wb.restConnection, reference: 'c5' }] } }, keyed(root));
    assert.deepEqual(proposed.preview!.sideEffects, [{ kind: 'webhook', physical: false, records: 'effect' }], 'the preview says the effect is read');
    const done = await executed(typeId, 72, 'c5');
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, wb.cell.as(root));
    assert.equal((receipt.document as { sideEffects: { reason: string }[] }).sideEffects[0]!.reason, 'effect_read_from_status_endpoint');
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 1, retried: 0, failed: 0 });
    const [queued] = await deliveries(done.id);
    assert.deepEqual([queued!.status, queued!.records, queued!.effect], ['delivered', 'effect', 'pending']);

    assert.deepEqual(await delivery.checkEffectsDue(uuidv7()), { applied: 0, failed: 0, pending: 0, unconfirmed: 0 }, 'not asked at once');
    statusBodies.push('{"state":"pending"}');
    assert.deepEqual(await delivery.checkEffectsDue(uuidv7(), later(60_000)), { applied: 0, failed: 0, pending: 1, unconfirmed: 0 });
    const asked = sent.at(-1)!;
    assert.equal(asked.method, 'GET');
    assert.equal(asked.url.toString(), `https://erp-sync.example/orders/status?delivery=${queued!.id}`);
    assert.equal(asked.headers!['silo-signature'], `v1=${createHmac('sha256', target.secret).update(`${asked.headers!['silo-timestamp']}.${queued!.id}`).digest('hex')}`,
      'signed as a delivery is, over the timestamp and the delivery id');
    statusBodies.push('{"state":"applied","note":"not kept"}');
    assert.deepEqual(await delivery.checkEffectsDue(uuidv7(), later(3_600_000)), { applied: 1, failed: 0, pending: 0, unconfirmed: 0 });
    const [applied] = await deliveries(done.id);
    assert.deepEqual([applied!.effect, applied!.effectCheckedAt !== null], ['applied', true]);
  });

  test('an effect reported failed is an outbound_webhook_failed; one never confirmed within 24 hours is unconfirmed', async () => {
    const target = await gateway.call(registerOutboundWebhook, {
      params: { connectionId: wb.restConnection }, body: { targetUrl: 'https://billing.example/hook', statusUrl: 'https://billing.example/hook/status' },
    }, wb.cell.as(root));
    const typeId = await actionType('bill', target.endpoint.id, 'external');
    const failed = await executed(typeId, 81, 'c1');
    const silent = await executed(typeId, 82, 'c2');
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 2, retried: 0, failed: 0 });
    statusBodies.push('{"state":"failed"}', '{"state":"pending"}');
    const first = await delivery.checkEffectsDue(uuidv7(), later(3_600_000));
    assert.deepEqual([first.failed, first.pending], [1, 1]);
    const outcome = async (m: MutationView) => (await deliveries(m.id))[0]!.effect;
    const [failedEffect, silentEffect] = [await outcome(failed), await outcome(silent)];
    assert.deepEqual([failedEffect, silentEffect].sort(), ['failed', 'pending']);
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'detail'->>'reason' as reason from platform.outbox where payload->>'event' = 'outbound_webhook_failed' order by created_at desc limit 1`));
    assert.equal(rows[0]!.reason, 'effect_failed');
    replies.push(503);
    assert.deepEqual(await delivery.checkEffectsDue(uuidv7(), later(25 * 3_600_000)), { applied: 0, failed: 0, pending: 0, unconfirmed: 1 });
    assert.equal(silentEffect === 'pending' ? await outcome(silent) : await outcome(failed), 'unconfirmed');
  });

  test('a target on a connection reached through the Silo Agent is posted by the agent, on a grant per attempt; its effect is asked the same way', async () => {
    const target = await gateway.call(registerOutboundWebhook, {
      params: { connectionId: wb.sqlConnection }, body: { targetUrl: 'https://erp.internal/hooks/orders', statusUrl: 'https://erp.internal/hooks/status' },
    }, wb.cell.as(root));
    assert.equal(target.endpoint.sentFrom, 'agent');
    const typeId = await actionType('erp_internal', target.endpoint.id, 'external');
    const done = await executed(typeId, 91, 'c3');
    const viaCell = sent.length;
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 1, retried: 0, failed: 0 });
    assert.equal(sent.length, viaCell, 'nothing left the cell for a private address');
    const posted = wb.agentHttp.sent.at(-1)!;
    assert.deepEqual([posted.method, posted.url, posted.granted], ['POST', 'https://erp.internal/hooks/orders', true], 'the agent posted it, on a grant connect-runtime checked');
    assert.equal(posted.headers['idempotency-key'], `${done.id}:${target.endpoint.id}`);
    assert.equal(posted.headers['silo-signature'], `v1=${createHmac('sha256', target.secret).update(`${posted.headers['silo-timestamp']}.${posted.body}`).digest('hex')}`);

    wb.agentHttp.replies.push({ status: 200, state: 'applied' });
    assert.deepEqual(await delivery.checkEffectsDue(uuidv7(), later(3_600_000)), { applied: 1, failed: 0, pending: 0, unconfirmed: 0 });
    const read = wb.agentHttp.sent.at(-1)!;
    assert.deepEqual([read.method, read.granted, read.body], ['GET', false, '']);
    assert.ok(read.url.startsWith('https://erp.internal/hooks/status?delivery='));
    assert.equal((await deliveries(done.id))[0]!.effect, 'applied');

    // A refusal through the agent is retried with backoff, as from the cell.
    await executed(typeId, 92, 'c4');
    wb.agentHttp.replies.push({ status: 500, state: null });
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 0, retried: 1, failed: 0 });
    assert.equal(wb.agentHttp.sent.at(-1)!.physical, undefined, 'a target not physical is not marked so');
  });

  test('a physical private target names its action for the agent\'s own signed allow-list; the agent\'s refusal fails it for good', async () => {
    const target = await gateway.call(registerOutboundWebhook, {
      params: { connectionId: wb.sqlConnection }, body: { targetUrl: 'https://plc-gateway.internal/vent', riskClass: 'physical', actionName: 'vent' },
    }, wb.cell.as(root));
    await allowlisted(wb.sqlConnection, 'vent');
    const typeId = await actionType('vent', target.endpoint.id, 'physical');
    // The private target's statements are retried by notify; pending ones from earlier tests go first.
    await delivery.deliverDue(uuidv7(), later(25 * 3_600_000));
    const first = await approvedByTwo(await propose(typeId, 7, 'c1'));
    assert.equal(first.status, 'completed', first.refusalReason ?? '');
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 1, retried: 0, failed: 0 });
    const posted = wb.agentHttp.sent.at(-1)!;
    assert.deepEqual([posted.url, posted.granted, posted.physical], ['https://plc-gateway.internal/vent', true, { action: 'vent', maxPerMinute: 0 }]);

    const second = await approvedByTwo(await propose(typeId, 8, 'c2'));
    assert.equal(second.status, 'completed', second.refusalReason ?? '');
    wb.agentHttp.replies.push({ refused: 'not_listed' });
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 0, retried: 0, failed: 1 }, 'never retried');
    assert.equal((await events('outbound_webhook_failed')).at(-1)!['reason'], 'actuation.refused_by_agent');
    const [refused] = await events('physical_write_refused_by_agent');
    assert.deepEqual([refused!['reason'], refused!['endpoint_id']], ['not_listed', target.endpoint.id]);
  });
});
