// Crons that mutate (spec 40.5, 43.11): a mutate action proposes a confirmed Action type over
// the objects its question returned, as the Cron's principal on behalf of the member who
// authorised it; in execute mode it writes without a person present, only inside every bound
// set at creation, and otherwise falls back to the approvals queue. The receipt names the
// person who authorised the Cron.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, getReceipt, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { grantConnection } from '../../src/contracts/policy/governance.contract.ts';
import { createCron, listCronRuns, runCronNow, type CronRunView } from '../../src/contracts/scheduler/cron.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createFilesCell, INVOICES, invoiceType, resetInvoices, until, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let approver: Signed;
let view = '';
let closeInvoice = '';
const DAY = 86_400_000;

const runs = async (cronId: string): Promise<CronRunView[]> => (await f.gateway.call(listCronRuns, { params: { cronId }, query: {} }, f.cell.as(f.root))).runs;
async function ranOnce(cronId: string): Promise<CronRunView> {
  await f.gateway.call(runCronNow, { params: { cronId } }, f.cell.as(f.root));
  return until('the run', async () => {
    const [run] = await runs(cronId);
    return run !== undefined && run.status !== 'running' ? run : undefined;
  });
}
async function settled(mutationId: string): Promise<MutationView> {
  return until('the mutation', async () => {
    const m = await f.gateway.call(getMutation, { params: { mutationId } }, f.cell.as(f.root));
    return m.completedAt !== null || m.status === 'awaiting_approval' ? m : undefined;
  });
}
const mutate = (name: string, action: Record<string, unknown>) => f.gateway.call(createCron, { body: {
  name, subject: { savedViewId: view }, trigger: { schedule: '0 7 * * *' }, actions: [{ kind: 'mutate', actionTypeId: closeInvoice, ...action }],
} as never }, f.keyed(f.root));

before(async () => {
  f = await createFilesCell({ writes: true });
  approver = await f.cell.member('approver2@acme.example', 'Super admin');
  // An approver reads every field in the diff (44.2).
  await f.gateway.call(grantConnection, { body: { connectionId: f.crm, grantee: { kind: 'membership', id: approver.membershipId }, access: 'read' } },
    f.cell.as(f.root));
  const type = invoiceType(f.manifest);
  const created = await f.gateway.call(proposeActionType, { body: { apiName: 'close_invoice', displayName: 'Close invoice', owningScopeId: f.cell.scopes['engineering']! } },
    f.keyed(f.root));
  await f.gateway.call(publishActionTypeVersion, { params: { actionTypeId: created.id }, body: {
    ontologyVersionId: f.manifest.version.id, objectTypeId: type, properties: ['status'],
    rules: [{ kind: 'set_property', property: 'status', value: { cel: '"closed"' } }], permittedConnections: [f.crm],
  } }, f.keyed(f.root));
  closeInvoice = created.id;
  view = (await f.view(f.root, {
    nodes: [{ objectTypeId: type, filters: [] }],
    select: [{ node: 0, property: f.prop('invoice_id') }, { node: 0, property: f.prop('status') }], sort: [{ property: f.prop('invoice_id'), direction: 'asc' }],
  }, 'All invoices')).viewId;
});

after(async () => {
  await f?.close();
});

describe('Crons that mutate (spec 40.5, 43.11)', () => {
  test('creation: execute names its bounds, within what the Action type may write and reach', async () => {
    await assert.rejects(mutate('No bounds', { mode: 'execute' }), { code: 'contract.request_invalid' });
    const bounds = { mode: 'execute', maxRows: 10, connectionIds: [f.crm], expiresAt: new Date(Date.now() + DAY).toISOString() };
    await assert.rejects(mutate('Wrong property', { ...bounds, properties: ['total'] }), { code: 'scheduler.mutate_property' });
    await assert.rejects(mutate('Wrong connection', { ...bounds, properties: ['status'], connectionIds: [uuidv7()] }), { code: 'scheduler.mutate_connection' });
    await assert.rejects(mutate('Expired', { ...bounds, properties: ['status'], expiresAt: new Date(Date.now() - DAY).toISOString() }),
      { code: 'scheduler.mutate_expired' });
  });

  test('a physical Action is proposed by a Cron, never executed: execute mode is refused at creation, and recorded (spec 47.2, 47.8)', async () => {
    const created = await f.gateway.call(proposeActionType, { body: { apiName: 'close_valve', displayName: 'Close valve', owningScopeId: f.cell.scopes['engineering']! } },
      f.keyed(f.root));
    await f.gateway.call(publishActionTypeVersion, { params: { actionTypeId: created.id }, body: {
      ontologyVersionId: f.manifest.version.id, objectTypeId: invoiceType(f.manifest), properties: ['status'],
      rules: [{ kind: 'set_property', property: 'status', value: { cel: '"closed"' } }], permittedConnections: [f.crm], riskClass: 'physical',
    } as never }, f.keyed(f.root));
    await assert.rejects(f.gateway.call(createCron, { body: {
      name: 'Close valves at once', subject: { savedViewId: view }, trigger: { schedule: '0 7 * * *' },
      actions: [{ kind: 'mutate', actionTypeId: created.id, mode: 'execute', properties: ['status'], maxRows: 10, connectionIds: [f.crm], expiresAt: new Date(Date.now() + DAY).toISOString() }],
    } as never }, f.keyed(f.root)), { code: 'scheduler.mutate_physical' });
    const { rows } = await f.cell.migrate.query(
      `select payload->'resource'->>'id' as type from platform.outbox where organisation_id = $1 and payload->>'event' = 'physical_cron_execute_refused'`, [f.cell.org]);
    assert.deepEqual(rows.map((r) => r.type), [created.id]);
    const { rows: forty } = await f.cell.migrate.query(
      `select payload->'resource'->>'id' as type, payload->'detail'->>'mode' as mode from platform.outbox where organisation_id = $1 and payload->>'event' = 'automation_actuation_refused'`,
      [f.cell.org]);
    assert.deepEqual(forty.map((r) => [r.type, r.mode]), [[created.id, 'execute']], 'chapter 40\'s record of the same refusal');
  });

  test('propose: the Cron\'s principal proposes, the authorising member stands as requester, a person approves', async () => {
    resetInvoices();
    const cron = await mutate('Close by proposal', { mode: 'propose' });
    const run = await ranOnce(cron.id);
    const action = run.actions.find((a) => a.kind === 'mutate')!;
    assert.equal(action.outcome, 'proposed', JSON.stringify(run));
    const m = await settled(action.mutationId!);
    assert.deepEqual([m.status, m.origin, m.rowCount], ['awaiting_approval', 'cron', 3]);
    assert.ok(INVOICES.every((i) => i.status !== 'closed'), 'nothing is written before approval');
    await f.gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, f.cell.as(approver));
    const done = await until('completion', async () => {
      const x = await f.gateway.call(getMutation, { params: { mutationId: m.id } }, f.cell.as(f.root));
      return x.completedAt !== null ? x : undefined;
    });
    assert.equal(done.status, 'completed');
    assert.ok(INVOICES.every((i) => i.status === 'closed'));
    const receipt = await f.gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, f.cell.as(f.root));
    assert.equal((receipt.document as { authorisedBy: string }).authorisedBy, f.root.membershipId, 'the receipt names who authorised the Cron');
  });

  test('execute within bounds writes with no one present; outside a bound it falls back to propose', async () => {
    resetInvoices();
    const bounds = { mode: 'execute', properties: ['status'], connectionIds: [f.crm], expiresAt: new Date(Date.now() + DAY).toISOString() };
    const within = await mutate('Close at once', { ...bounds, maxRows: 10 });
    const action = (await ranOnce(within.id)).actions.find((a) => a.kind === 'mutate')!;
    assert.equal(action.outcome, 'executed');
    const done = await until('completion', async () => {
      const x = await f.gateway.call(getMutation, { params: { mutationId: action.mutationId! } }, f.cell.as(f.root));
      return x.completedAt !== null ? x : undefined;
    });
    const { rows: why } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `select e.status, e.error, v.outcome, v.reason from action.mutation_executions e left join action.mutation_verifications v on v.execution_id = e.id
       where e.mutation_id = $1`, [done.id]));
    assert.equal(done.status, 'completed', JSON.stringify(why));
    assert.ok(INVOICES.every((i) => i.status === 'closed'));
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `select m.cron_mode, m.authorising_membership_id, m.proposer_principal_id is not null as by_principal,
         (select count(*)::int from action.approval_steps s join action.approval_chains c on c.id = s.chain_id where c.mutation_id = m.id) as steps,
         (select executed_by_principal_id is not null from action.mutation_executions e where e.mutation_id = m.id limit 1) as run_by_principal
       from action.mutations m where m.id = $1`, [done.id]));
    assert.deepEqual(rows[0], { cron_mode: 'execute_within_bounds', authorising_membership_id: f.root.membershipId, by_principal: true, steps: 0, run_by_principal: true });

    resetInvoices();
    const tight = await mutate('Close two at most', { ...bounds, maxRows: 2 });
    const fallback = (await ranOnce(tight.id)).actions.find((a) => a.kind === 'mutate')!;
    assert.equal(fallback.outcome, 'proposed', 'three rows exceed its maximum of two: proposed instead');
    assert.equal((await settled(fallback.mutationId!)).status, 'awaiting_approval');
    assert.ok(INVOICES.every((i) => i.status !== 'closed'));
  });

  test('an Action type that needs a parameter: its value set with the action, sealed, never shown back; the Cron proposes with it', async () => {
    const type = invoiceType(f.manifest);
    const created = await f.gateway.call(proposeActionType, { body: { apiName: 'set_status', displayName: 'Set status', owningScopeId: f.cell.scopes['engineering']! } },
      f.keyed(f.root));
    await f.gateway.call(publishActionTypeVersion, { params: { actionTypeId: created.id }, body: {
      ontologyVersionId: f.manifest.version.id, objectTypeId: type, properties: ['status'], parameters: [{ name: 'to', type: 'string', required: true }],
      rules: [{ kind: 'set_property', property: 'status', value: { parameter: 'to' } }], permittedConnections: [f.crm],
    } }, f.keyed(f.root));
    const withParameters = (name: string, parameters?: Record<string, unknown>) => f.gateway.call(createCron, { body: {
      name, subject: { savedViewId: view }, trigger: { schedule: '0 7 * * *' },
      actions: [{ kind: 'mutate', actionTypeId: created.id, ...(parameters === undefined ? {} : { parameters }) }],
    } as never }, f.keyed(f.root));
    await assert.rejects(withParameters('No value'), { code: 'scheduler.mutate_parameters' });
    await assert.rejects(withParameters('Unknown', { to: 'disputed', colour: 'red' }), { code: 'scheduler.mutate_parameter_unknown' });
    await assert.rejects(withParameters('Wrong type', { to: 7 }), { code: 'scheduler.mutate_parameter_type' });
    resetInvoices();
    const cron = await withParameters('Mark them all', { to: 'disputed' });
    const { rows: [stored] } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `select parameter_values, configuration from automation.automation_actions where automation_id = $1`, [cron.id]));
    assert.ok(stored.parameter_values !== null && !Buffer.from(stored.parameter_values).toString('latin1').includes('disputed'), 'sealed at rest');
    assert.deepEqual(stored.configuration.parameters, ['to'], 'names only, never the value');
    assert.ok(!JSON.stringify(cron).includes('disputed'), 'never shown back');
    const action = (await ranOnce(cron.id)).actions.find((a) => a.kind === 'mutate')!;
    assert.equal(action.outcome, 'proposed', JSON.stringify(action));
    const m = await settled(action.mutationId!);
    await f.gateway.call(decideApproval, { params: { chainId: m.chain!.id }, body: { decision: 'approved', diffHash: m.diffHash! } }, f.cell.as(approver));
    await until('completion', async () => {
      const x = await f.gateway.call(getMutation, { params: { mutationId: m.id } }, f.cell.as(f.root));
      return x.completedAt !== null ? x : undefined;
    });
    assert.ok(INVOICES.every((i) => i.status === 'disputed'), 'written with the value the person set');
  });

  test('an execute authorisation is recorded as its person\'s; once it expires the Cron proposes instead (40.6)', async () => {
    resetInvoices();
    const lapsing = await mutate('Close until it lapses', {
      mode: 'execute', properties: ['status'], connectionIds: [f.crm], maxRows: 10, expiresAt: new Date(Date.now() + 1500).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const action = (await ranOnce(lapsing.id)).actions.find((a) => a.kind === 'mutate')!;
    assert.equal(action.outcome, 'proposed', 'returned to propose mode, not refused');
    assert.equal((await settled(action.mutationId!)).status, 'awaiting_approval');
    assert.ok(INVOICES.every((i) => i.status !== 'closed'), 'nothing written without a person');
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `select count(*)::int as n from platform.outbox where organisation_id = $1 and payload->>'event' = 'automation_authorised'
         and payload->'resource'->>'id' = $2`, [f.cell.org, lapsing.id]));
    assert.equal(rows[0]!.n, 1);
  });
});
