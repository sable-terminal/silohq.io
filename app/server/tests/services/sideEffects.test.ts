// Side effects (spec 42.6): after verification of every connection, once, a notification to
// the people the Action type names, in the product and by email, with the receipt as its only
// content (the email says what it is about and links to it); the receipt and
// the audit log say what fired. A webhook side effect makes the type external and waits for
// chapter 48's signed delivery, recorded as not fired.

import { registerOutboundWebhook } from '../../src/contracts/connect-registry/outboundWebhook.contract.ts';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getActionType, proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, getReceipt, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import type { MailMessage } from '../../src/services/notify/mailer.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
const mails: MailMessage[] = [];
const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

async function until(mutationId: string): Promise<MutationView> {
  for (let i = 0; i < 100; i++) {
    const m = await gateway.call(getMutation, { params: { mutationId } }, wb.cell.as(root));
    if (m.completedAt !== null) return m;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the mutation did not finish');
}

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      await cell.start(createNotifyService({ mailer: { async send(m) { mails.push(m); }, close() {} } }), 'notify', 'test_app', { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://app.test/' });
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService({ sweep: false }), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  approver = await wb.cell.member('approver@acme.example', 'Super admin');
  await wb.grant(approver.membershipId, wb.sqlConnection, 'read');
  await wb.enableWrites(wb.sqlConnection);
});

after(async () => {
  await wb?.close();
});

describe('side effects (spec 42.6)', () => {
  test('after verification, the named people are notified with the receipt; the receipt and the audit log say what fired', async () => {
    const target = await gateway.call(registerOutboundWebhook, {
      params: { connectionId: wb.sqlConnection }, body: { targetUrl: 'https://hooks.example/orders' },
    }, wb.cell.as(root));
    const type = await gateway.call(proposeActionType, { body: { apiName: 'close_order', displayName: 'Close order', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
    await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
      ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.orderTypeId, properties: ['status'],
      rules: [{ kind: 'set_property', property: 'status', value: { cel: '"closed"' } }], permittedConnections: [wb.sqlConnection],
      sideEffects: [{ kind: 'notification', recipients: ['proposer', 'approvers'], channels: ['home', 'email'] }, { kind: 'webhook', endpointId: target.endpoint.id }],
      riskClass: 'external',
    } }, keyed(root));
    const published = await gateway.call(getActionType, { params: { actionTypeId: type.id } }, wb.cell.as(root));
    assert.equal(published.current!.riskClass, 'external', 'a webhook side effect needs the type declared external');

    const m = await gateway.call(proposeMutation, { body: { actionTypeId: type.id, objects: [{ connectionId: wb.sqlConnection, reference: '4' }] } }, keyed(root));
    assert.deepEqual(m.preview!.sideEffects.map((e) => e.kind), ['notification', 'webhook'], 'the preview says what will fire');
    await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(approver));
    const done = await until(m.id);
    assert.equal(done.status, 'completed');

    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select recipient_membership_id, channel, delivered_at is not null as delivered from workspace.notifications
        where kind = 'action_completed' and receipt_id = $1 order by recipient_membership_id, channel`,
      [done.receiptId]));
    assert.deepEqual(rows.map((r) => `${r.recipient_membership_id}:${r.channel}:${r.delivered}`).sort(),
      [approver.membershipId, root.membershipId].flatMap((m) => [`${m}:email:true`, `${m}:in_app:true`]).sort());
    assert.deepEqual(mails.map((m) => m.to).sort(), ['approver@acme.example', 'root@acme.example']);
    assert.match(mails[0]!.subject, /^An Action has completed in /);
    assert.match(mails[0]!.text, /http:\/\/app\.test\/notifications\/\?organisation=[a-z0-9-]+&id=[0-9a-f-]{36}/);
    assert.ok(!mails[0]!.text.includes('closed'), 'never a value');
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, wb.cell.as(root));
    assert.deepEqual((receipt.document as { sideEffects: unknown }).sideEffects, [
      { kind: 'notification', outcome: 'fired', recipients: 2, reason: null },
      { kind: 'webhook', outcome: 'queued', recipients: 0, reason: 'delivery_recorded_not_effect' },
    ]);
    const { rows: events } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'detail' as d from platform.outbox where organisation_id = $1 and payload->>'event' = 'side_effect_fired'
       and payload->'resource'->>'id' = $2`, [wb.cell.org, m.id]));
    assert.deepEqual([events.length, events[0]!.d.kind, events[0]!.d.recipients], [1, 'notification', 2]);
  });
});
