// Recovering an execution whose process died (spec 45.3: nothing is retried blindly). The
// sweep reads every target back, records what landed as applied and what did not as not
// applied, writes nothing, and finishes the mutation with its receipt; an execution still
// running in this process, or not yet stale, is left alone.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, getReceipt, proposeMutation } from '../../src/contracts/actions/mutation.contract.ts';
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

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      // Separated execution: approval does not run it, so the test can stand in for a process that died.
      await cell.start(createActionsService({ executionSeparated: true, sweep: false, onExecution: (e) => { execution = e; } }), 'actions', 'test_app',
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

describe('recovering an interrupted execution (spec 45.3)', () => {
  test('what landed is recorded as applied, the rest as not applied, and nothing is written again', async () => {
    const m = await gateway.call(proposeMutation, { body: {
      actionTypeId: setStatus, parameters: { status: 'held' }, objects: [1, 2, 3].map((id) => ({ connectionId: wb.sqlConnection, reference: String(id) })),
    } }, keyed(root));
    await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(approver));
    // A process began executing an hour ago and died after writing two of the three records.
    await inTx(wb.cell.app, { orgId: wb.cell.org }, async () => {
      await wb.cell.app.query(
        `insert into action.mutation_executions (id, organisation_id, mutation_id, connection_id, phase, status, executed_by_membership_id, connector_version, attempted_at)
         values ($1, $2, $3, $4, 'full', 'executing', $5, '1.0.0', now() - interval '1 hour')`,
        [uuidv7(), wb.cell.org, m.id, wb.sqlConnection, approver.membershipId]);
      await wb.cell.app.query(`update action.mutations set status = 'executing' where id = $1`, [m.id]);
    });
    await wb.customer.query(`update sales.orders set status = 'held' where id in (1, 2)`);

    assert.equal(await execution.recoverInterrupted(uuidv7(), new Date(), 2 * 60 * 60_000), 0, 'not stale yet');
    assert.equal(await execution.recoverInterrupted(uuidv7()), 1);
    const done = await gateway.call(getMutation, { params: { mutationId: m.id } }, wb.cell.as(root));
    assert.equal(done.status, 'partially_failed');
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, wb.cell.as(root));
    assert.deepEqual((receipt.summary as { counts: Record<string, number> }).counts, { targets: 3, verified: 2, diverged: 0, failed: 0, skipped: 0 });
    assert.equal(done.executions[0]!.error, 'interrupted');
    const { rows } = await wb.customer.query('select id, status from sales.orders where id <= 3 order by id');
    assert.deepEqual(rows.map((r) => `${r.id}:${r.status}`), ['1:held', '2:held', '3:open'], 'the third record was not written');
    assert.equal(await execution.recoverInterrupted(uuidv7()), 0, 'recovered once');
  });
});
