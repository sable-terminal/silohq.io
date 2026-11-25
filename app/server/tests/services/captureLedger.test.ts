// The Action ledger in a Capture Silo (spec 48.2, 66.4, 70; D205): where the cell has no
// Warehouse, as in the sovereign cell, the ledger "requires a configured UK-resident store",
// and the organisation's Capture Silo in the cell's own Postgres is it. Off by default; switched
// on for one Capture Silo by a holder of silo.enable who has read its disclosure; a copy the Silo
// cannot take is kept sealed and sent again until written; each executed
// Action then adds one row per object after its receipt, once; values sealed, only when chosen;
// read through the reader's own access; a receipt purge clears the values and never fails for
// want of a Warehouse; the Silo's retention and its purge reach the rows.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { getReceiptPurge, requestReceiptPurge, type ReceiptPurgeView } from '../../src/contracts/actions/receiptPurge.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { listCaptureLedger, setCaptureActionLedger, writeCaptureLedger } from '../../src/contracts/siloes/captureLedger.contract.ts';
import { createCaptureSilo, getSilo } from '../../src/contracts/siloes/siloes.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createSiloesCaptureService } from '../../src/routes/siloes-capture/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let approver: Signed;
let setScore = '';
let holder = '';
let other = '';
const keyed = (who: Signed) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });
const sql = (text: string, values: unknown[] = []) => inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(text, values));

async function until<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const found = await check();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function executed(score: number, reference: string): Promise<MutationView> {
  const m = await gateway.call(proposeMutation, { body: { actionTypeId: setScore, parameters: { score }, objects: [{ connectionId: wb.restConnection, reference }] } }, keyed(root));
  await gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, wb.cell.as(approver));
  return until('the mutation to finish', async () => {
    const done = await gateway.call(getMutation, { params: { mutationId: m.id } }, wb.cell.as(root));
    return done.completedAt !== null ? done : undefined;
  });
}

const rowsOf = async (receiptId: string) => (await sql(`select * from siloes.action_ledger where receipt_id = $1`, [receiptId])).rows;
const rowFor = (receiptId: string) => until('the ledger row', async () => (await rowsOf(receiptId))[0]);

async function purge(receiptId: string): Promise<ReceiptPurgeView> {
  const asked = await gateway.call(requestReceiptPurge, { body: { scope: 'receipt', receiptId } }, wb.cell.as(root));
  if (asked.status === 'awaiting_approval') {
    await gateway.call(decideApproval, { params: { chainId: asked.approvalChainId! }, body: { decision: 'approved', diffHash: asked.documentHash! } }, wb.cell.as(approver));
  }
  return until('the purge to end', async () => {
    const now = await gateway.call(getReceiptPurge, { params: { purgeId: asked.id } }, wb.cell.as(root));
    return now.status === 'completed' || now.status === 'failed' ? now : undefined;
  });
}

before(async () => {
  wb = await createWritebackCell({
    start: async (cell) => {
      // A cell whose build carries no Warehouse: no warehouse-schema, no warehouse-sync, no BigQuery.
      await cell.start(createSiloesCaptureService({ schedule: false }), 'siloes-capture', 'test_app', {
        SILO_APPROVED_CAPABILITIES: 'siloes_capture', SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20',
      });
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
  await sql('update iam.organisations set storage_enabled = true where id = $1', [wb.cell.org]);
  holder = (await gateway.call(createCaptureSilo, { body: { name: 'Decisions', purpose: 'Our own decisions, analysed', retentionDays: 365 } }, keyed(root))).id;
  other = (await gateway.call(createCaptureSilo, { body: { name: 'Elsewhere', purpose: 'Another purpose', retentionDays: 30 } }, keyed(root))).id;
});

after(async () => {
  await wb?.close();
});

describe('the Action ledger in a Capture Silo (spec 48.2; D205)', () => {
  test('off by default; on for one Capture Silo only with its disclosure acknowledged; one Silo holds it', async () => {
    const before = await executed(21, 'c1');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await rowsOf(before.receiptId!), [], 'off: nothing kept');
    assert.equal((await gateway.call(getSilo, { params: { siloId: holder } }, wb.cell.as(root))).actionLedger, 'off');

    await assert.rejects(gateway.call(setCaptureActionLedger, { params: { siloId: holder }, body: { mode: 'references' } }, wb.cell.as(root)),
      { code: 'siloes.ledger_disclosure' });
    const on = await gateway.call(setCaptureActionLedger, { params: { siloId: holder }, body: { mode: 'references', disclosureAcknowledged: true } }, wb.cell.as(root));
    assert.equal(on.mode, 'references');
    assert.match(on.disclosure, /in this cell/);
    assert.equal((await gateway.call(getSilo, { params: { siloId: holder } }, wb.cell.as(root))).actionLedger, 'references');
    await assert.rejects(gateway.call(setCaptureActionLedger, { params: { siloId: other }, body: { mode: 'values', disclosureAcknowledged: true } }, wb.cell.as(root)),
      { code: 'siloes.ledger_elsewhere' });
    const { rows } = await sql(`select payload->'detail' as d, payload->'resource'->>'id' as silo from platform.outbox where payload->>'event' = 'ledger_enabled'`);
    assert.deepEqual(rows, [{ d: { values: false }, silo: holder }], 'who chose it, and that values were not included');
  });

  test('each executed Action adds a row per object after its receipt, once; values sealed to the row, only when chosen', async () => {
    const done = await executed(33, 'c2');
    const row = await rowFor(done.receiptId!);
    assert.deepEqual([row.mutation_id, row.silo_id, row.operation, row.outcome, row.origin, row.action_type, row.generic_edit, row.fields, row.approvers],
      [done.id, holder, 'update_partial', 'verified', 'action', 'set_score v1', false, ['score'], [approver.membershipId]]);
    assert.deepEqual([row.prior_values, row.new_values], [null, null], 'references only');

    await gateway.call(setCaptureActionLedger, { params: { siloId: holder }, body: { mode: 'values', disclosureAcknowledged: true } }, wb.cell.as(root));
    const valued = await executed(44, 'c2');
    const sealed = await rowFor(valued.receiptId!);
    assert.ok(Buffer.isBuffer(sealed.prior_values) && Buffer.isBuffer(sealed.new_values));
    assert.ok(!sealed.new_values.toString('latin1').includes('44'), 'sealed, not plain');

    // actions retrying a copy adds nothing.
    const { rows: [again] } = await sql(`select * from siloes.action_ledger where ledger_id = $1`, [sealed.ledger_id]);
    const copy = await wb.cell.client('actions').call(writeCaptureLedger, { body: { receiptId: valued.receiptId!, rows: [{
      ledgerId: again.ledger_id, mutationId: again.mutation_id, receiptId: again.receipt_id, commitId: again.commit_id, actionType: again.action_type,
      genericEdit: again.generic_edit, riskClass: again.risk_class, objectType: again.object_type, objectId: again.object_id, connectionId: again.connection_id,
      operation: again.operation, fields: again.fields, priorValues: { score: 0 }, newValues: { score: 0 }, proposer: again.proposer, approvers: again.approvers,
      selfApproved: again.self_approved, origin: again.origin, outcome: again.outcome, revertsMutationId: null, proposedAt: null,
      executedAt: new Date(again.executed_at).toISOString(), markingIds: [],
    }] } }, wb.cell.as(root));
    assert.deepEqual(copy, { written: 0, mode: 'values' });
  });

  test('read through the reader\'s own access: values opened; a row with a marking the reader lacks is withheld; pages follow', async () => {
    const page = await gateway.call(listCaptureLedger, { params: { siloId: holder }, query: { limit: 50 } }, wb.cell.as(root));
    assert.equal(page.mode, 'values');
    assert.deepEqual([page.rows.length, page.withheld], [2, 0]);
    const newest = page.rows[0]!;
    assert.deepEqual([newest.priorValues, newest.newValues], [{ score: 33 }, { score: 44 }]);
    assert.deepEqual([page.rows[1]!.priorValues, page.rows[1]!.newValues], [null, null]);

    // A row carrying a marking nobody here holds.
    const marked = await executed(55, 'c3');
    const markedRow = await rowFor(marked.receiptId!);
    await wb.cell.migrate.query(`alter table siloes.action_ledger disable trigger action_ledger_frozen`);
    await wb.cell.migrate.query(`update siloes.action_ledger set marking_ids = array[$1::uuid] where ledger_id = $2`, [uuidv7(), markedRow.ledger_id]);
    await wb.cell.migrate.query(`alter table siloes.action_ledger enable trigger action_ledger_frozen`);
    const withMarked = await gateway.call(listCaptureLedger, { params: { siloId: holder }, query: { limit: 50 } }, wb.cell.as(root));
    assert.deepEqual([withMarked.rows.length, withMarked.withheld], [2, 1]);
    assert.ok(!withMarked.rows.some((r) => r.receiptId === marked.receiptId));

    const first = await gateway.call(listCaptureLedger, { params: { siloId: holder }, query: { limit: 1 } }, wb.cell.as(root));
    assert.ok(first.next);
    const second = await gateway.call(listCaptureLedger, { params: { siloId: holder }, query: { limit: 1, cursor: first.next } }, wb.cell.as(root));
    assert.deepEqual(second.rows.map((r) => r.receiptId), [newest.receiptId]);
    const one = await gateway.call(listCaptureLedger, { params: { siloId: holder }, query: { receiptId: newest.receiptId, limit: 50 } }, wb.cell.as(root));
    assert.deepEqual(one.rows.map((r) => r.ledgerId), [newest.ledgerId]);
    await assert.rejects(gateway.call(listCaptureLedger, { params: { siloId: holder }, query: { cursor: 'nope', limit: 5 } }, wb.cell.as(root)), { code: 'siloes.bad_cursor' });
  });

  test('a receipt purge clears the values here, with no Warehouse to ask; references and outcomes stay', async () => {
    const valued = (await sql(`select receipt_id from siloes.action_ledger where new_values is not null order by executed_at limit 1`)).rows[0]!.receipt_id as string;
    const done = await purge(valued);
    assert.deepEqual([done.status, done.receipts, done.ledgerRows], ['completed', 1, 1]);
    const [row] = await rowsOf(valued);
    assert.deepEqual([row.prior_values, row.new_values, row.outcome], [null, null, 'verified']);
    assert.ok(row.values_cleared_at);
    const { rows } = await sql(`select payload->'detail' as d from platform.outbox where payload->>'event' = 'ledger_purged'`);
    assert.deepEqual(rows.at(-1)!.d, { reason: 'receipt_purge', receipts: 1, rows: 1, receipts_kept: true });
  });

  test('a copy the Silo cannot take is kept sealed and sent again until written; a purge before then leaves it its references, not its values', async () => {
    // The Silo's store is away: every write of the copy fails.
    await wb.cell.migrate.query('alter table siloes.action_ledger rename to action_ledger_away');
    let receiptId = '';
    try {
      receiptId = (await executed(55, 'c2')).receiptId!;
      const owed = await until('the copy to be kept', async () => (await sql('select * from action.ledger_copies where id = $1', [receiptId])).rows[0]);
      assert.equal(owed.row_count, 1);
      assert.ok(Buffer.isBuffer(owed.rows_sealed) && !owed.rows_sealed.toString('latin1').includes('55'), 'sealed, not plain');
      assert.ok(owed.last_failure !== null && Date.parse(owed.next_attempt_at) > Date.now(), 'it waits before it is sent again');
    } finally {
      await wb.cell.migrate.query('alter table siloes.action_ledger_away rename to action_ledger');
    }
    assert.equal((await rowsOf(receiptId)).length, 0, 'nothing written yet');

    // Purged while owed: the copy keeps its references and outcome, and loses its values.
    assert.equal((await purge(receiptId)).status, 'completed');
    await sql('update action.ledger_copies set next_attempt_at = now() where id = $1', [receiptId]);
    const row = await rowFor(receiptId);
    assert.deepEqual([row.outcome, row.fields, row.prior_values, row.new_values], ['verified', ['score'], null, null]);
    await until('the copy to go once written', async () => ((await sql('select 1 from action.ledger_copies where id = $1', [receiptId])).rowCount === 0 ? true : undefined));
  });

  test('the Silo\'s retention reaches the rows, and purging the Silo removes its copy; switched off, nothing more is written', async () => {
    const before = Number((await sql(`select count(*) from siloes.action_ledger where silo_id = $1`, [holder])).rows[0].count);
    assert.equal(before, 4, "the four Actions executed while it was on");
    const bytes = (await sql(`select siloes.capture_bytes($1, $2)::bigint as b`, [wb.cell.org, holder])).rows[0].b;
    assert.ok(Number(bytes) > 0, 'metered with its Silo');
    const swept = (await sql(`select * from siloes.sweep_capture($1, $2, now() - interval '1 day')`, [wb.cell.org, holder])).rows[0];
    assert.equal(Number(swept.ledger), 0, 'nothing is older than the window');
    const typeOnly = (await sql(`select * from siloes.purge_capture($1, $2, $3)`, [wb.cell.org, holder, wb.contactTypeId])).rows[0];
    assert.equal(Number(typeOnly.ledger), 0, 'an object type\'s wipe is of captured history, not the ledger');
    const whole = (await sql(`select * from siloes.purge_capture($1, $2)`, [wb.cell.org, holder])).rows[0];
    assert.equal(Number(whole.ledger), before, 'the whole Silo: its copy goes; the receipts remain the record');

    await gateway.call(setCaptureActionLedger, { params: { siloId: holder }, body: { mode: 'off' } }, wb.cell.as(root));
    const after = await executed(66, 'c4');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await rowsOf(after.receiptId!), []);
  });
});
