// The Action ledger (spec 48.2, 66.4): off by default; switched on for a Warehouse by a holder
// of silo.enable who has read its disclosure, with or without values. Each executed Action
// then adds one row per object after its receipt, merged by ledger id; values only when
// chosen; off again, nothing more is written. BigQuery is the fake the Warehouse tests use.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { setActionLedger } from '../../src/contracts/warehouse/warehouse.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createWarehouseSchemaService } from '../../src/routes/warehouse-schema/index.route.ts';
import { createWarehouseSyncService } from '../../src/routes/warehouse-sync/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createFakeBigQuery, type FakeBigQuery } from './warehouse.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
let bq: FakeBigQuery;
let warehouseId = '';
let setScore = '';
const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });

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

const ledgerRows = () => [...(bq.table('action_ledger')?.rows.values() ?? [])];
async function rowFor(receiptId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const row = ledgerRows().find((r) => r['receipt_id'] === receiptId);
    if (row !== undefined) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no ledger row for the receipt');
}

before(async () => {
  bq = createFakeBigQuery();
  const env = { BIGQUERY_PROJECT_ID: 'silo-test-proj', BIGQUERY_LOCATION: 'europe-west2', WAREHOUSE_WRITER_MEMBERS: 'serviceAccount:writer@silo-test-proj.iam.gserviceaccount.com' };
  wb = await createWritebackCell({
    start: async (cell) => {
      await cell.start(createWarehouseSchemaService({ bigQuery: bq }), 'warehouse-schema', 'test_app', env);
      await cell.start(createWarehouseSyncService({ bigQuery: bq, schedule: false }), 'warehouse-sync', 'test_app', env);
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
  // Siloes on, and an active Warehouse (its provisioning is the Warehouse tests' subject).
  const siloId = uuidv7();
  warehouseId = uuidv7();
  await inTx(wb.cell.app, { orgId: wb.cell.org }, async () => {
    await wb.cell.app.query('update iam.organisations set storage_enabled = true where id = $1', [wb.cell.org]);
    await wb.cell.app.query(
      `insert into siloes.siloes (id, organisation_id, kind, name, purpose, retention_days, location, status, created_by)
       values ($1, $2, 'warehouse', 'Warehouse', 'Decisions', 365, 'europe-west2', 'provisioning', $3)`, [siloId, wb.cell.org, root.membershipId]);
    await wb.cell.app.query(
      `insert into siloes.warehouse_projects (id, organisation_id, silo_id, gcp_project_id, dataset, location, kms_key_ref, status, provisioning_step, created_by)
       values ($1, $2, $3, 'silo-uklon1-000000000001', 'silo', 'europe-west2', 'projects/p/locations/l/keyRings/r/cryptoKeys/k', 'active', 'backfill_started', $4)`,
      [warehouseId, wb.cell.org, siloId, root.membershipId]);
  });
});

after(async () => {
  await wb?.close();
});

describe('the Action ledger (spec 48.2)', () => {
  test('off by default; switched on only with its disclosure acknowledged, which creates its table', async () => {
    const before = await executed(21, 'c1');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(bq.table('action_ledger'), undefined, 'off: no table, no rows');
    assert.ok(before.receiptId);

    await assert.rejects(gateway.call(setActionLedger, { params: { warehouseId }, body: { mode: 'references' } }, wb.cell.as(root)),
      { code: 'warehouse.ledger_disclosure' });
    const on = await gateway.call(setActionLedger, { params: { warehouseId }, body: { mode: 'references', disclosureAcknowledged: true } }, wb.cell.as(root));
    assert.equal(on.mode, 'references');
    assert.match(on.disclosure, /queryable|copy/);
    assert.equal(on.table?.kind, 'ledger');
    assert.ok(bq.table('action_ledger')!.columns.some((c) => c.name === '_marking_ids'));
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select payload->'detail' as d from platform.outbox where payload->>'event' = 'ledger_enabled'`));
    assert.deepEqual(rows.map((r) => r.d), [{ values: false }], 'the reviewer reads who chose it, and that values were not included');
  });

  test('each executed Action adds a row per object after its receipt: references and outcomes, values only when chosen', async () => {
    const done = await executed(33, 'c2');
    const row = await rowFor(done.receiptId!);
    assert.deepEqual([row['mutation_id'], row['operation'], row['outcome'], row['origin'], row['action_type'], row['generic_edit']],
      [done.id, 'update_partial', 'verified', 'action', 'set_score v1', false]);
    assert.deepEqual(row['fields'], ['score']);
    assert.deepEqual(row['approvers'], [approver.membershipId]);
    assert.deepEqual([row['prior_values'], row['new_values']], [null, null], 'references only');

    await gateway.call(setActionLedger, { params: { warehouseId }, body: { mode: 'values', disclosureAcknowledged: true } }, wb.cell.as(root));
    const valued = await executed(44, 'c2');
    const withValues = await rowFor(valued.receiptId!);
    assert.deepEqual([JSON.parse(String(withValues['prior_values'])), JSON.parse(String(withValues['new_values']))], [{ score: 33 }, { score: 44 }]);
  });

  test('switched off, nothing more is written', async () => {
    await gateway.call(setActionLedger, { params: { warehouseId }, body: { mode: 'off' } }, wb.cell.as(root));
    const count = ledgerRows().length;
    await executed(55, 'c3');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ledgerRows().length, count);
  });
});
