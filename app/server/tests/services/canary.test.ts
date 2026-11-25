// The canary (spec 43.9, 45.4), with the threshold lowered for the test (6 rows, a sample of
// 2): the sample is written and verified first and the mutation waits in canary; the final
// approver confirms the remainder after seeing every diverged or failed sample record, and
// the receipt covers both; a canary not confirmed before its chain expires finishes as
// expired, with a receipt for the sample alone and the rest never written. The sample size is
// the organisation's, set with mutation.policy across the organisation; the threshold is not.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { getActionSettings, setCanarySample } from '../../src/contracts/actions/settings.contract.ts';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { confirmCanary, getMutation, getReceipt, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import type { Execution } from '../../src/services/actions/execute.service.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
let execution: Execution;
let setStatus = '';
const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

async function until(mutationId: string, done: (m: MutationView) => boolean): Promise<MutationView> {
  for (let i = 0; i < 100; i++) {
    const m = await gateway.call(getMutation, { params: { mutationId } }, wb.cell.as(root));
    if (done(m)) return m;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the mutation did not reach the expected state');
}
const orders = (ids: number[]) => ids.map((id) => ({ connectionId: wb.sqlConnection, reference: String(id) }));
const statuses = async () => (await wb.customer.query('select id, status from sales.orders order by id')).rows.map((r) => `${r.id}:${r.status}`);
const events = async (name: string, mutationId: string) => (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
  `select payload->'detail' as d from platform.outbox where organisation_id = $1 and payload->>'event' = $2 and payload->'resource'->>'id' = $3`,
  [wb.cell.org, name, mutationId]))).rows.map((r) => r.d as Record<string, unknown>);

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService({ canary: { rows: 6, sample: 2 }, sweep: false, onExecution: (e) => { execution = e; } }), 'actions', 'test_app',
        { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  approver = await wb.cell.member('approver@acme.example', 'Super admin');
  await wb.grant(approver.membershipId, wb.sqlConnection, 'read');
  await wb.enableWrites(wb.sqlConnection);
  const type = await gateway.call(proposeActionType, { body: { apiName: 'set_order_status', displayName: 'Set status', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.orderTypeId, properties: ['status'],
    parameters: [{ name: 'status', type: 'string', required: true }],
    rules: [{ kind: 'set_property', property: 'status', value: { parameter: 'status' } }], permittedConnections: [wb.sqlConnection],
  } }, keyed(root));
  setStatus = type.id;
});

after(async () => {
  await wb?.close();
});

describe('the canary (spec 43.9, 45.4)', () => {
  test('at the threshold the preview says so; the sample is written and verified, and the mutation waits', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: setStatus, parameters: { status: 'held' }, objects: orders([1, 2, 3, 4, 5, 6, 7, 8]) } }, keyed(root));
    assert.deepEqual(m.preview!.canary, { sample: 2 });
    await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(approver));
    const waiting = await until(m.id, (x) => x.status === 'canary' && x.executions.every((e) => e.status !== 'executing'));
    assert.deepEqual(waiting.executions.map((e) => e.phase), ['canary']);
    assert.equal((await statuses()).filter((x) => x.endsWith(':held')).length, 2, 'only the sample is written');
    // What the random sample says about the rest (decision 2026-11-11): none of two failed, so with 95% confidence under 63%.
    assert.deepEqual([waiting.canaryEvidence?.sampled, waiting.canaryEvidence?.problems, waiting.canaryEvidence?.randomSample], [2, 0, true]);
    assert.equal(waiting.canaryEvidence!.problemRateUpper95, Math.round((1 - 0.05 ** (1 / 3)) * 10_000) / 10_000);
    const [executed] = await events('canary_executed', m.id);
    assert.deepEqual([executed!['sample'], executed!['verified'], executed!['diverged'], executed!['failed']], [2, 2, 0, 0]);

    await assert.rejects(gateway.call(confirmCanary, { params: { mutationId: m.id }, body: { seen: { diverged: 0, failed: 0 } } }, wb.cell.as(root)),
      { code: 'mutation.not_final_approver' });
    await assert.rejects(gateway.call(confirmCanary, { params: { mutationId: m.id }, body: { seen: { diverged: 1, failed: 0 } } }, wb.cell.as(approver)),
      { code: 'mutation.canary_unseen' });
    await gateway.call(confirmCanary, { params: { mutationId: m.id }, body: { seen: { diverged: 0, failed: 0 } } }, wb.cell.as(approver));
    const done = await until(m.id, (x) => x.completedAt !== null);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.executions.map((e) => e.phase).sort(), ['canary', 'full']);
    assert.deepEqual((await statuses()).slice(0, 8), ['1:held', '2:held', '3:held', '4:held', '5:held', '6:held', '7:held', '8:held']);
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, wb.cell.as(root));
    assert.equal((receipt.summary as { counts: { verified: number } }).counts.verified, 8, 'the receipt covers the sample and the rest');
    assert.equal((await events('canary_confirmed', m.id))[0]!['remainder'], 6);
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      'select canary_confirmed_by from action.mutations where id = $1', [m.id]));
    assert.equal(rows[0]!.canary_confirmed_by, approver.membershipId);
  });

  test('a canary not confirmed before its chain expires finishes as expired, with a receipt for its sample', async () => {
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: setStatus, parameters: { status: 'void' }, objects: orders([1, 2, 3, 4, 5, 6, 7]) } }, keyed(root));
    await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(approver));
    await until(m.id, (x) => x.status === 'canary' && x.executions.every((e) => e.status !== 'executing'));
    assert.equal(await execution.expireCanaries(uuidv7(), new Date()), 0, 'not before the chain expires');
    assert.equal(await execution.expireCanaries(uuidv7(), new Date(Date.now() + 30 * 86_400_000)), 1);
    const expired = await until(m.id, (x) => x.completedAt !== null);
    assert.equal(expired.status, 'expired');
    assert.equal((await statuses()).filter((x) => x.endsWith(':void')).length, 2, 'the rest was never written, and the sample is not undone');
    const receipt = await gateway.call(getReceipt, { params: { receiptId: expired.receiptId! } }, wb.cell.as(root));
    assert.equal((receipt.summary as { counts: { targets: number } }).counts.targets, 2);
    assert.equal((await events('canary_expired', m.id)).length, 1);
  });

  test('the sample size is the organisation\'s, set with mutation.policy across it; the threshold is not a setting', async () => {
    const member = await wb.cell.member('member@acme.example', 'Member');
    await assert.rejects(gateway.call(setCanarySample, { body: { sampleRows: 3 } }, wb.cell.as(member)), { code: 'action_settings.not_permitted' });
    const canary = (s: { canaryThresholdRows: number; canarySampleRows: number; custom: boolean }) =>
      ({ canaryThresholdRows: s.canaryThresholdRows, canarySampleRows: s.canarySampleRows, custom: s.custom });
    assert.deepEqual(canary(await gateway.call(setCanarySample, { body: { sampleRows: 3 } }, wb.cell.as(root))), { canaryThresholdRows: 6, canarySampleRows: 3, custom: true });
    assert.deepEqual(canary(await gateway.call(getActionSettings, {}, wb.cell.as(member))), { canaryThresholdRows: 6, canarySampleRows: 3, custom: true });
    const m = await gateway.call(proposeMutation, { body: { actionTypeId: setStatus, parameters: { status: 'hold' }, objects: orders([1, 2, 3, 4, 5, 6, 7]) } }, keyed(root));
    assert.deepEqual(m.preview!.canary, { sample: 3 });
    assert.deepEqual(canary(await gateway.call(setCanarySample, { body: { sampleRows: null } }, wb.cell.as(root))), { canaryThresholdRows: 6, canarySampleRows: 2, custom: false });
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'detail'->>'sample_rows' as rows from platform.outbox where organisation_id = $1 and payload->>'event' = 'canary_sample_set' order by created_at`, [wb.cell.org]));
    assert.deepEqual(rows.map((r) => r.rows), ['3', null]);
  });
});
