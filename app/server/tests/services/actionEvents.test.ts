// Outbound Action events (spec 48.3): one event per executed Action, with identifiers and
// outcomes but never values, delivered to each active subscription whose filter admits it,
// signed with HMAC-SHA256 under a secret only the credential service holds; retried with
// backoff, dead-lettered after 24 hours with the owner told; a paused subscription waits.
// The endpoint is a fake egress, so the test sees exactly what would be sent.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import {
  createActionEventSubscription, listActionEventSubscriptions, setActionEventSubscriptionStatus,
} from '../../src/contracts/actions/actionEvent.contract.ts';
import { getMutation, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import type { EgressRequest, EgressResult } from '../../src/infra/egress.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import type { ActionEventDelivery } from '../../src/services/notify/actionEvents.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
let delivery: ActionEventDelivery;
let setScore = '';
const sent: EgressRequest[] = [];
const replies: number[] = [];
const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

const egress = {
  async send(request: EgressRequest): Promise<EgressResult> {
    sent.push(request);
    return { status: replies.shift() ?? 200, headers: {}, setCookies: [], body: Buffer.alloc(0) };
  },
};

async function executed(score: number, reference: string): Promise<MutationView> {
  const m = await gateway.call(proposeMutation, { body: { actionTypeId: setScore, parameters: { score }, objects: [{ connectionId: wb.restConnection, reference }] } }, keyed(root));
  await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(approver));
  for (let i = 0; i < 100; i++) {
    const done = await gateway.call(getMutation, { params: { mutationId: m.id } }, wb.cell.as(root));
    if (done.completedAt !== null) return done;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the mutation did not finish');
}

/** The bus message the relay would publish for a mutation's event, as notify receives it. */
async function busMessage(mutationId: string) {
  const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
    `select id, organisation_id, correlation_id, created_at, payload from platform.outbox where event = 'action_executed' and payload->>'mutationId' = $1`,
    [mutationId]));
  assert.equal(rows.length, 1, 'one event per executed Action, written with its receipt');
  const row = rows[0]!;
  const envelope = { organisationId: row.organisation_id, occurredAt: new Date(row.created_at).toISOString(), correlationId: row.correlation_id, payload: row.payload };
  return { eventId: row.id as string, name: 'action_executed', version: 1, data: Buffer.from(JSON.stringify(envelope)), payload: row.payload };
}

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      await cell.start(createNotifyService({ egress, sweep: false, onActionEvents: (d) => { delivery = d; } }), 'notify', 'test_app',
        { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://app.test/' });
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  approver = await wb.cell.member('approver@acme.example', 'Super admin');
  await wb.grant(approver.membershipId, wb.restConnection, 'read');
  await wb.enableWrites(wb.restConnection);
  const type = await gateway.call(proposeActionType, { body: { apiName: 'set_score', displayName: 'Set score', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: ['score'],
    parameters: [{ name: 'score', type: 'integer', required: true }], rules: [{ kind: 'set_property', property: 'score', value: { parameter: 'score' } }],
    permittedConnections: [wb.restConnection],
  } }, keyed(root));
  setScore = type.id;
});

after(async () => {
  await wb?.close();
});

describe('outbound Action events (spec 48.3)', () => {
  let secret = '';
  let subscriptionId = '';

  test('a subscription is HTTPS, filtered, and its secret is shown once', async () => {
    await assert.rejects(gateway.call(createActionEventSubscription, { body: { endpointUrl: 'http://hooks.example/silo' } }, keyed(root)),
      { code: 'contract.request_invalid' });
    const created = await gateway.call(createActionEventSubscription, {
      body: { endpointUrl: 'https://hooks.example/silo', filter: { actionTypeIds: [setScore] } },
    }, keyed(root));
    assert.ok(created.secret !== null && created.secret.length >= 40);
    secret = created.secret!;
    subscriptionId = created.subscription.id;
    // Another that admits only failures: it never sees a completed Action.
    await gateway.call(createActionEventSubscription, { body: { endpointUrl: 'https://other.example/silo', filter: { outcomes: ['failed'] } } }, keyed(root));
    const listed = await gateway.call(listActionEventSubscriptions, { query: {} }, wb.cell.as(root));
    assert.equal(listed.subscriptions.length, 2);
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      'select purpose, connection_id from connect.connection_credentials_safe where id = (select secret_ref from action.action_event_subscriptions where id = $1)', [subscriptionId]));
    assert.deepEqual([rows[0]!.purpose, rows[0]!.connection_id], ['action_event_secret', null], 'the secret is the credential service\'s, sealed');
  });

  test('an executed Action is delivered once to the subscription that admits it, signed, with identifiers and no values', async () => {
    const done = await executed(77, 'c1');
    const message = await busMessage(done.id);
    assert.equal(await delivery.intake(message), 1, 'the failures-only subscription is not offered it');
    assert.equal(await delivery.intake(message), 0, 'a redelivered event adds nothing');
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 1, retried: 0, deadLettered: 0 });

    const request = sent.at(-1)!;
    assert.equal(request.url.toString(), 'https://hooks.example/silo');
    assert.equal(request.headers['idempotency-key'], message.eventId);
    const body = String(request.body);
    const expected = `v1=${createHmac('sha256', secret).update(`${request.headers['silo-timestamp']}.${body}`).digest('hex')}`;
    assert.equal(request.headers['silo-signature'], expected, 'the subscriber verifies it with the secret it was shown');
    const event = JSON.parse(body);
    assert.equal(event.id, message.eventId);
    assert.deepEqual([event.type, event.mutationId, event.receiptId, event.outcome, event.objectCount], ['action.executed', done.id, done.receiptId, 'completed', 1]);
    assert.deepEqual(event.fields, ['score']);
    assert.equal(event.approvers[0], approver.membershipId);
    assert.ok(!/[:,[]77[,}\]]/.test(body), 'never a value: 77 appears nowhere as a JSON value');
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select count(*)::int as n from platform.outbox where payload->>'event' = 'action_event_delivered' and payload->'resource'->>'id' = $1`, [subscriptionId]));
    assert.equal(rows[0]!.n, 1);
  });

  test('a failing endpoint is retried with backoff, then dead-lettered after 24 hours and its owner told; resumed, it takes new events', async () => {
    const done = await executed(55, 'c2');
    await delivery.intake(await busMessage(done.id));
    replies.push(500);
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 0, retried: 1, deadLettered: 0 });
    assert.deepEqual(await delivery.deliverDue(uuidv7()), { delivered: 0, retried: 0, deadLettered: 0 }, 'not due again until the backoff passes');
    replies.push(503);
    const later = new Date(Date.now() + 25 * 60 * 60_000);
    assert.deepEqual(await delivery.deliverDue(uuidv7(), later), { delivered: 0, retried: 0, deadLettered: 1 });

    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select s.status, s.version, (select count(*)::int from workspace.notifications n where n.kind = 'action_event_dead_lettered'
         and n.action_event_subscription_id = s.id and n.recipient_membership_id = $2) as told
       from action.action_event_subscriptions s where s.id = $1`, [subscriptionId, root.membershipId]));
    assert.deepEqual([rows[0]!.status, rows[0]!.told], ['dead_lettered', 1]);

    const resumed = await gateway.call(setActionEventSubscriptionStatus, { params: { subscriptionId }, body: { status: 'active', version: rows[0]!.version } }, wb.cell.as(root));
    assert.equal(resumed.status, 'active');
    const paused = await gateway.call(setActionEventSubscriptionStatus, { params: { subscriptionId }, body: { status: 'paused', version: resumed.version } }, wb.cell.as(root));
    const next = await executed(66, 'c3');
    assert.equal(await delivery.intake(await busMessage(next.id)), 0, 'a paused subscription is offered nothing');
    await gateway.call(setActionEventSubscriptionStatus, { params: { subscriptionId }, body: { status: 'active', version: paused.version } }, wb.cell.as(root));
  });
});
