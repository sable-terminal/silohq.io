// Receipt purge (spec 46.1, 48.2, 65.3, 70): a receipt's values go, its hash, references and
// counts stay. Asked by a holder of silo.purge for one receipt or every receipt naming an
// object, through the organisation's approval chain where one is configured; swept when past
// its retention. The Action ledger's values for those receipts go with them; references stay.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, getReceipt, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { getReceiptPurge, requestReceiptPurge, runReceiptRetentionSweep, type ReceiptPurgeView } from '../../src/contracts/actions/receiptPurge.contract.ts';
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

const DAY = 86_400_000;
let ahead = 0;
let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
let viewer: Signed;
let bq: FakeBigQuery;
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

const ledgerRow = (receiptId: string) => [...(bq.table('action_ledger')?.rows.values() ?? [])].find((r) => r['receipt_id'] === receiptId);
async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const found = await check();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const events = async (name: string) => (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
  `select payload->'detail' as detail, payload->'resource' as resource from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at`,
  [wb.cell.org, name]))).rows as { detail: Record<string, unknown>; resource: { id: string } }[];
const sql = (text: string, values: unknown[] = []) => inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(text, values));

/** A purge as asked, then as it ends: through the approval chain where one is configured, decided by another holder of silo.purge. */
async function purge(body: { scope: 'receipt'; receiptId: string } | { scope: 'object'; objectId: string }): Promise<ReceiptPurgeView> {
  const asked = await gateway.call(requestReceiptPurge, { body }, wb.cell.as(root));
  if (asked.status === 'awaiting_approval') {
    await gateway.call(decideApproval, { params: { chainId: asked.approvalChainId! }, body: { decision: 'approved', diffHash: asked.documentHash! } }, wb.cell.as(approver));
  }
  return until('the purge to end', async () => {
    const now = await gateway.call(getReceiptPurge, { params: { purgeId: asked.id } }, wb.cell.as(root));
    return now.status === 'completed' || now.status === 'failed' ? now : undefined;
  });
}

before(async () => {
  bq = createFakeBigQuery();
  const env = { BIGQUERY_PROJECT_ID: 'silo-test-proj', BIGQUERY_LOCATION: 'europe-west2', WAREHOUSE_WRITER_MEMBERS: 'serviceAccount:writer@silo-test-proj.iam.gserviceaccount.com' };
  wb = await createWritebackCell({
    start: async (cell) => {
      await cell.start(createWarehouseSchemaService({ bigQuery: bq }), 'warehouse-schema', 'test_app', env);
      await cell.start(createWarehouseSyncService({ bigQuery: bq, schedule: false }), 'warehouse-sync', 'test_app', env);
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService({ sweep: false, now: () => Date.now() + ahead }), 'actions', 'test_app',
        { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  approver = await wb.cell.member('approver@acme.example', 'Super admin');
  viewer = await wb.cell.member('viewer@acme.example', 'Member');
  await wb.grant(approver.membershipId, wb.restConnection, 'read');
  await wb.enableWrites(wb.restConnection);
  const type = await gateway.call(proposeActionType, { body: { apiName: 'set_score', displayName: 'Set score', owningScopeId: wb.cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: {
    ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, properties: ['score'],
    parameters: [{ name: 'score', type: 'integer', required: true }], rules: [{ kind: 'set_property', property: 'score', value: { parameter: 'score' } }],
    permittedConnections: [wb.restConnection],
  } }, keyed(root));
  setScore = type.id;
  // A Warehouse whose Action ledger holds values (its provisioning is the Warehouse tests' subject).
  const siloId = uuidv7();
  const warehouseId = uuidv7();
  await sql('update iam.organisations set storage_enabled = true where id = $1', [wb.cell.org]);
  await sql(`insert into siloes.siloes (id, organisation_id, kind, name, purpose, retention_days, location, status, created_by)
             values ($1, $2, 'warehouse', 'Warehouse', 'Decisions', 365, 'europe-west2', 'provisioning', $3)`, [siloId, wb.cell.org, root.membershipId]);
  await sql(`insert into siloes.warehouse_projects (id, organisation_id, silo_id, gcp_project_id, dataset, location, kms_key_ref, status, provisioning_step, created_by)
             values ($1, $2, $3, 'silo-uklon1-000000000001', 'silo', 'europe-west2', 'projects/p/locations/l/keyRings/r/cryptoKeys/k', 'active', 'backfill_started', $4)`,
  [warehouseId, wb.cell.org, siloId, root.membershipId]);
  await gateway.call(setActionLedger, { params: { warehouseId }, body: { mode: 'values', disclosureAcknowledged: true } }, wb.cell.as(root));
});

after(async () => {
  await wb?.close();
});

describe('receipt purge (spec 46.1, 70)', () => {
  test('one receipt: its values go, everywhere the mutation kept them; its hash, references and counts stay; the ledger loses the values too', async () => {
    const first = await executed(21, 'c1');
    const kept = await executed(22, 'c2');
    await until('the ledger rows', () => (ledgerRow(first.receiptId!) && ledgerRow(kept.receiptId!) ? true : undefined));
    assert.notEqual(ledgerRow(first.receiptId!)!['new_values'], null);
    await assert.rejects(gateway.call(requestReceiptPurge, { body: { scope: 'receipt', receiptId: first.receiptId! } }, wb.cell.as(viewer)),
      { code: 'action.not_permitted' });
    await assert.rejects(gateway.call(requestReceiptPurge, { body: { scope: 'receipt', receiptId: uuidv7() } }, wb.cell.as(root)), { code: 'receipt.not_found' });
    const before = await gateway.call(getReceipt, { params: { receiptId: first.receiptId! } }, wb.cell.as(root));
    assert.notEqual(before.document, null);

    const done = await purge({ scope: 'receipt', receiptId: first.receiptId! });
    assert.deepEqual([done.status, done.receipts, done.ledgerRows], ['completed', 1, 1]);
    // The purge ledger (8.2; D251), for a restore to purge again.
    const { rows: [ledger] } = await wb.cell.migrate.query(
      `select payload from platform.outbox where topic = 'platform.purge_ledger' and payload->>'purgeId' = $1`, [done.id]);
    assert.deepEqual(ledger.payload, { kind: 'receipt_values', purgeId: done.id, receiptIds: [first.receiptId] });
    const after = await gateway.call(getReceipt, { params: { receiptId: first.receiptId! } }, wb.cell.as(root));
    assert.equal(after.document, null, 'the values are gone');
    assert.ok(after.purgedAt);
    assert.equal(after.documentHash, before.documentHash, 'the hash in the audit ledger still matches the receipt');
    assert.deepEqual(after.summary, before.summary, 'references and counts stay');
    const { rows: [m] } = await sql('select intent, diff, manifest_values, purged_at from action.mutations where id = $1', [first.id]);
    assert.deepEqual([m.intent, m.diff, m.manifest_values], [null, null, null]);
    assert.ok(m.purged_at);
    assert.equal((await sql('select count(*)::int as n from action.prior_states where mutation_id = $1 and value is not null', [first.id])).rows[0].n, 0);
    assert.ok((await sql('select count(*)::int as n from action.prior_states where mutation_id = $1', [first.id])).rows[0].n > 0, 'the rows stay');
    assert.deepEqual([ledgerRow(first.receiptId!)!['prior_values'], ledgerRow(first.receiptId!)!['new_values']], [null, null]);
    assert.ok(ledgerRow(first.receiptId!)!['outcome'], 'the ledger keeps references and outcomes');
    assert.notEqual(ledgerRow(kept.receiptId!)!['new_values'], null, 'another receipt\'s row keeps its values');
    assert.notEqual((await gateway.call(getReceipt, { params: { receiptId: kept.receiptId! } }, wb.cell.as(root))).document, null);

    const purged = (await events('receipt_purged')).at(-1)!;
    assert.deepEqual([purged.resource.id, purged.detail['mutation_id'], purged.detail['reason']], [first.receiptId, first.id, 'requested']);
    assert.deepEqual((await events('purge_completed')).at(-1)!.detail,
      { purge_id: done.id, scope: 'receipt_receipt', receipts: 1, ledger_rows: 1, receipts_kept_hashes: true });
    assert.deepEqual((await events('ledger_purged')).at(-1)!.detail, { reason: 'receipt_purge', receipts: 1, rows: 1, receipts_kept: true });
    await assert.rejects(gateway.call(requestReceiptPurge, { body: { scope: 'receipt', receiptId: first.receiptId! } }, wb.cell.as(root)),
      { code: 'receipt.already_purged' }, 'once purged, a receipt is not purged again');
  });

  test('an erasure: every receipt of a commit on the object, and nothing of another object\'s', async () => {
    const a = await executed(31, 'c3');
    const b = await executed(32, 'c3');
    const other = await executed(33, 'c4');
    const { rows: [commit] } = await sql('select object_id from action.action_commits where mutation_id = $1', [a.id]);
    const done = await purge({ scope: 'object', objectId: commit.object_id as string });
    assert.deepEqual([done.status, done.receipts], ['completed', 2]);
    for (const m of [a, b]) assert.equal((await gateway.call(getReceipt, { params: { receiptId: m.receiptId! } }, wb.cell.as(root))).document, null);
    assert.notEqual((await gateway.call(getReceipt, { params: { receiptId: other.receiptId! } }, wb.cell.as(root))).document, null);
  });

  test('past its retention, a receipt is swept with the rest of its values, and the reason is the retention', async () => {
    const swept = await executed(41, 'c5');
    const { rows: [r] } = await sql('select retention_until from action.receipts where id = $1', [swept.receiptId]);
    assert.ok(Date.parse(r.retention_until) - Date.now() > 700 * DAY, 'two years');
    assert.deepEqual(await wb.cell.client('admin-portal').call(runReceiptRetentionSweep, {}, wb.cell.as(root)), { receipts: 0, ledgerRows: 0 });
    ahead = 731 * DAY;
    try {
      const out = await wb.cell.client('admin-portal').call(runReceiptRetentionSweep, {}, wb.cell.as(root));
      assert.ok(out.receipts >= 2, 'every receipt not yet purged');
    } finally {
      ahead = 0;
    }
    assert.equal((await gateway.call(getReceipt, { params: { receiptId: swept.receiptId! } }, wb.cell.as(root))).document, null);
    assert.equal((await sql('select count(*)::int as n from action.receipts where purged_at is null')).rows[0].n, 0);
    assert.ok((await events('receipt_purged')).some((e) => e.resource.id === swept.receiptId && e.detail['reason'] === 'retention'));
  });
});
