// Scenario branches end to end (spec 39.8): Actions staged in a branch and never executed;
// staging checks them as a proposal would (a refusal is learned at staging) and keeps the
// touched values as the base, sealed; opening recomputes staleness and walks each effect over
// the confirmed graph as a run of the branch; conflicts are decided per property; two
// branches compare; promotion turns staged Actions into proposals through the mutation path,
// with the branch as origin, and never approves them; a closed branch's bases purge at the
// end of its retention.
//
// The cell: the writeback cell's CRM (contacts with a manager and a due date) with actions
// and approvals, and simulation over the executor. The manager link is a confirmed hard edge
// with a one-day buffer: what happens to a contact reaches the contact it reports to.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { proposeActionType, publishActionTypeVersion, type VersionDefinitionInput } from '../../src/contracts/actions/actionType.contract.ts';
import { getMutation, getReceipt, proposeMutation, type MutationView } from '../../src/contracts/actions/mutation.contract.ts';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { grantAllowance } from '../../src/contracts/metering/allowance.contract.ts';
import {
  closeBranch, compareBranch, createBranch, getBranch, openBranch, promoteBranch, resolveStagedConflicts, restageAction, stageAction,
  type BranchView, type OpenedBranchView,
} from '../../src/contracts/simulation/branch.contract.ts';
import { confirmEdge, deriveEdges } from '../../src/contracts/simulation/graph.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { maintenanceRepo } from '../../src/repos/platform/maintenance.repo.ts';
import { createActionsService } from '../../src/routes/actions/index.route.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { service as executorService } from '../../src/routes/executor/index.route.ts';
import { createMeteringService } from '../../src/routes/metering/index.route.ts';
import { createNotifyService } from '../../src/routes/notify/index.route.ts';
import { service as plannerService } from '../../src/routes/planner/index.route.ts';
import { service as pushdownService } from '../../src/routes/pushdown-compiler/index.route.ts';
import { service as resolutionService } from '../../src/routes/resolution/index.route.ts';
import { service as simulationService } from '../../src/routes/simulation/index.route.ts';
import { singleSourceObjectId } from '../../src/utils/siloObjectId.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import type { Signed } from './connect.helper.ts';
import { createWritebackCell, freePort, type WritebackCell } from './writeback.helper.ts';
import { listObjectScenarios } from '../../src/contracts/simulation/scenario.contract.ts';
import { openCanvasView } from '../../src/contracts/canvas-layout/canvasView.contract.ts';
import { service as canvasLayoutService } from '../../src/routes/canvas-layout/index.route.ts';

let wb: WritebackCell;
let gateway: ServiceClient;
let root: Signed;
let second: Signed;
const types: Record<string, string> = {};

const keyed = (who: Signed = root) => ({ ...wb.cell.as(who), idempotencyKey: uuidv7() });
const as = (who: Signed = root) => wb.cell.as(who);
const contact = (reference: string) => ({ connectionId: wb.restConnection, reference });
const objectId = (reference: string) => singleSourceObjectId(wb.cell.org, wb.contactTypeId, wb.restConnection, 'contacts', reference);
/** A canvas view overlaying a scenario, owned by a member (canvas-layout's own tests cover saving one). */
const overlayView = async (scenarioId: string, owner: string): Promise<string> => {
  const id = uuidv7();
  await wb.cell.migrate.query(
    `insert into clone.canvas_views (id, organisation_id, owner_membership_id, name, canvas_scope, layout_kind, scenario_id, ontology_version)
     values ($1, $2, $3, 'Overlay', 'estate_ontology', 'graph_force', $4, 1)`, [id, wb.cell.org, owner, scenarioId]);
  return id;
};
const audit = async (event: string) => (await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by created_at, id`,
  [wb.cell.org, event]))).rows.map((r) => r.payload);

async function actionType(apiName: string, def: VersionDefinitionInput): Promise<string> {
  const type = await gateway.call(proposeActionType, { body: { apiName, displayName: apiName, owningScopeId: wb.cell.scopes['engineering']! } }, keyed());
  const published = await gateway.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: def }, keyed());
  assert.equal(published.status, 'confirmed');
  return type.id;
}

async function until(mutationId: string, done: (m: MutationView) => boolean): Promise<MutationView> {
  for (let i = 0; i < 100; i++) {
    const m = await gateway.call(getMutation, { params: { mutationId } }, as());
    if (done(m)) return m;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the mutation did not reach the expected state');
}

const branchFrom = (name: string, scenario: string) => gateway.call(createBranch, {
  body: { name, from: { kind: 'object_view', scenario: { name: scenario } } } as never,
}, as());
const stage = (branchId: string, actionTypeId: string, parameters: Record<string, unknown>, references: string[]) => gateway.call(stageAction, {
  params: { branchId }, body: { actionTypeId, parameters: parameters as never, objects: references.map(contact) },
}, keyed());
const open = (branchId: string): Promise<OpenedBranchView> => gateway.call(openBranch, { params: { branchId } }, keyed());

before(async () => {
  wb = await createWritebackCell({
    custom: true, dated: true,
    start: async (cell) => {
      const bounds = { EXECUTOR_MAX_ROWS_PER_SOURCE_STEP: '50', EXECUTOR_MAX_RESULT_ROWS: '1000' };
      await cell.start(pushdownService, 'pushdown-compiler', 'test_app');
      await cell.start(resolutionService, 'resolution', 'test_app');
      await cell.start(plannerService, 'planner', 'test_app', bounds);
      await cell.start(executorService, 'executor', 'test_app', bounds);
      await cell.start(createMeteringService(), 'metering', 'test_app', { DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl });
      await cell.start(createNotifyService(), 'notify', 'test_app', { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_TLS: 'none', NOTIFY_LINK_BASE_URL: 'http://app.test/' });
      // actions and approvals call each other: each is told the other's address.
      const [actionsPort, approvalsPort] = [await freePort(), await freePort()];
      await cell.start(createActionsService(), 'actions', 'test_app', { HTTP_PORT: String(actionsPort), SERVICE_URL_APPROVALS: `http://127.0.0.1:${approvalsPort}` });
      await cell.start(approvalsService, 'approvals', 'test_app', { HTTP_PORT: String(approvalsPort) });
      await cell.start(simulationService, 'simulation', 'test_app');
      await cell.start(canvasLayoutService, 'canvas-layout', 'test_app', { REDIS_STATE_URL: `${LOCAL.redisUrl}/2` });
    },
  });
  gateway = wb.gateway;
  root = wb.root;
  second = await wb.cell.member('second@acme.example', 'Super admin');
  await wb.grant(second.membershipId, wb.restConnection, 'read');
  for (const reference of ['c2', 'c3']) wb.contacts.get(reference)!.properties.manager = 'c1';
  await wb.enableWrites(wb.restConnection);

  // What billing writes from a verified subscription, so compiles and simulations can be charged.
  const subscription = uuidv7();
  await inTx(wb.cell.app, { orgId: wb.cell.org }, async () => {
    await wb.cell.app.query(
      `insert into billing.subscriptions (id, organisation_id, plan, seat_count, term, discount_tier, stripe_customer_id, stripe_subscription_id,
         current_period_start, current_period_end, status)
       values ($1, $2, 'business', 10, 'monthly', 'list', 'cus_b', $3, now() - interval '1 day', now() + interval '29 days', 'active')`,
      [subscription, wb.cell.org, `sub_${uuidv7().slice(-12)}`]);
    await wb.cell.app.query(
      `insert into billing.entitlements (id, organisation_id, seats, tokens_per_seat_period, simulations_per_seat_period, daily_token_limit,
         storage_included_bytes, capabilities, source, subscription_id, effective_from)
       values ($1, $2, 10, 1000, 50, 400, 0, '{sso}', 'subscription', $3, now())`, [uuidv7(), wb.cell.org, subscription]);
    await wb.cell.app.query(`insert into billing.seats (id, organisation_id, subscription_id, membership_id, plan_tier, status) values ($1, $2, $3, $4, 'business', 'assigned')`,
      [uuidv7(), wb.cell.org, subscription, root.membershipId]);
  });
  await wb.cell.client('auth').call(grantAllowance, { body: { membershipId: root.membershipId } }, as());
  await inTx(wb.cell.app, { orgId: wb.cell.org }, async () => {
    await wb.cell.app.query(`update billing.token_allowances set tokens_granted = 1000 where organisation_id = $1`, [wb.cell.org]);
    await wb.cell.app.query(`update billing.simulation_allowances set simulations_granted = 50 where organisation_id = $1`, [wb.cell.org]);
  });

  const base = { ontologyVersionId: wb.ontologyVersionId, objectTypeId: wb.contactTypeId, permittedConnections: [wb.restConnection] };
  types['move_due'] = await actionType('move_due', {
    ...base, properties: ['due'], parameters: [{ name: 'new_due', type: 'date', required: true }],
    rules: [{ kind: 'set_property', property: 'due', value: { parameter: 'new_due' } }],
  } as never);
  types['set_score'] = await actionType('set_score', {
    ...base, properties: ['score', 'name'],
    parameters: [{ name: 'new_score', type: 'integer', required: true, validation: 'new_score >= 0 && new_score <= 100', message: 'Score must be between 0 and 100' }],
    rules: [
      { kind: 'set_property', property: 'score', value: { parameter: 'new_score' } },
      { kind: 'set_property', property: 'name', value: { cel: 'current.name' } },
    ],
  } as never);
  types['delete_contact'] = await actionType('delete_contact', { ...base, rules: [{ kind: 'delete_object' }] } as never);

  // The dependency graph: the manager link, confirmed hard with a one-day lead time and a one-day buffer.
  const derived = await gateway.call(deriveEdges, { body: {} }, as());
  const edge = derived.proposed[0]!;
  await gateway.call(confirmEdge, {
    params: { edgeId: edge.id }, body: { kind: 'hard', leadTime: { value: 1, unit: 'days' }, buffer: { value: 1, unit: 'days' }, reason: 'as we run it', version: 1 } as never,
  }, as());
});

after(async () => {
  await wb?.close();
});

let slip: BranchView;
let drop: BranchView;

describe('staging and opening (spec 39.8)', () => {
  test('staging checks the Action as a proposal would: a refusal is learned at staging; the base is sealed; nothing is written', async () => {
    slip = await branchFrom('Slip', 'Contact moves');
    assert.equal(slip.status, 'open');
    assert.equal(slip.label, 'Scenario branch: Slip');
    await assert.rejects(stage(slip.id, types['set_score']!, { new_score: 500 }, ['c2']),
      (e: { code?: string; details?: Record<string, unknown> }) => e.code === 'simulation.stage_refused' && e.details?.['stage'] === 'intent'
        && e.details['reason'] === 'Score must be between 0 and 100');
    const staged = await stage(slip.id, types['move_due']!, { new_due: '2026-12-04' }, ['c2']);
    assert.deepEqual([staged.operation, staged.targets, staged.properties, staged.staleness, staged.physical], ['update_partial', 1, ['due'], 'clean', false]);
    assert.equal(wb.contacts.get('c2')!.properties.due, '2026-12-01');
    assert.ok(!wb.crmRequests.some((r) => r.startsWith('PATCH')), 'nothing in a branch writes to a source');
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      'select property, base_value, staged_value from simulation.staged_action_bases where staged_action_id = $1', [staged.id]));
    assert.deepEqual(rows.map((r) => r.property), ['due']);
    assert.ok(!Buffer.from(rows[0].base_value).toString('latin1').includes('2026-12-01'), 'the base is sealed, never plain');
    assert.equal((await audit('action_staged')).length, 1);
    const charged = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select count(*)::int as n from billing.token_transactions where organisation_id = $1 and operation = 'compile'`, [wb.cell.org]));
    assert.equal(charged.rows[0].n, 1, 'staging is metered as a compile; a refused staging is not');
  });

  test('opening walks each effect over the confirmed graph as a run of the branch, charged as a re-run', async () => {
    const opened = await open(slip.id);
    const [check] = opened.checks;
    assert.equal(check!.staleness, 'clean');
    assert.deepEqual(check!.targets[0]!.effect, { form: 'delayed', delay: 'PT259200S', reason: null });
    assert.deepEqual(check!.targets[0]!.properties.map((p) => [p.property, p.current, p.branch, p.state]), [['due', '2026-12-01', '2026-12-04', 'clean']]);
    assert.equal(opened.run.charge?.operation, 'simulation_rerun');
    const manager = opened.run.reached.find((x) => x.objectId === objectId('c1'));
    assert.ok(manager !== undefined, 'what happens to c2 reaches the contact it reports to');
    assert.equal(manager.delay, 'PT172800S', 'three days late, less the one-day buffer');
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      'select branch_id from simulation.simulation_runs where id = $1', [opened.run.runId]));
    assert.equal(rows[0].branch_id, slip.id);
  });

  test('two branches of one scenario compare: objects affected in one only, and the change in delay for objects in both', async () => {
    drop = await gateway.call(createBranch, { body: { name: 'Drop', from: { kind: 'scenario', scenarioId: slip.scenarioId }, retentionDays: 0 } as never }, as());
    await stage(drop.id, types['delete_contact']!, {}, ['c2']);
    const opened = await open(drop.id);
    assert.deepEqual(opened.checks[0]!.targets[0]!.effect, { form: 'unavailable', delay: null, reason: null });
    const compared = await gateway.call(compareBranch, { params: { branchId: slip.id }, query: { against: drop.id } }, as());
    assert.deepEqual(compared.against, { kind: 'branch', id: drop.id });
    assert.deepEqual(compared.downstream.delayChanged.map((x) => [x.objectId, x.here, x.there]), [[objectId('c1'), 'PT172800S', null]]);
    assert.deepEqual(compared.targets.map((t) => [t.branchId, t.property, t.current, t.branch]),
      [[slip.id, 'due', '2026-12-01', '2026-12-04'], [drop.id, '@record', true, false]]);
    assert.equal((await audit('branch_compared')).length, 1);
  });
});

describe('staleness and promotion (spec 39.8)', () => {
  let tidy: BranchView;
  const staged: Record<string, string> = {};

  test('the object view\'s scenarios: those staging an Action targeting the object, and those whose latest run reaches it (34.2)', async () => {
    const on = async (reference: string, who: Signed = root) => (await gateway.call(listObjectScenarios, {
      body: { objectTypeId: wb.contactTypeId, objectId: objectId(reference) },
    }, as(who))).scenarios;
    const c2 = await on('c2');
    assert.deepEqual(c2.map((x) => [x.scenario.id, x.scenario.access]), [[slip.scenarioId, 'owner']]);
    assert.deepEqual(c2[0]!.staged.map((x) => [x.branchName, x.actionTypeId, x.branchStatus]),
      [['Drop', types['delete_contact'], 'open'], ['Slip', types['move_due'], 'open']], 'each branch staging an Action on it');
    const c1 = await on('c1');
    assert.deepEqual(c1[0]!.staged, [], 'nothing is staged on c1');
    const fromSlip = c1[0]!.reached.find((r) => r.branchId === slip.id)!;
    assert.deepEqual([fromSlip.effect, fromSlip.delay], ['delayed', 'PT172800S'], 'reached by the latest run of the branch');
    assert.deepEqual(await on('c5'), [], 'untouched');
    assert.deepEqual(await on('c2', second), [], 'a scenario is private by default (39.7)');
  });

  test('a change since staging conflicts, naming who made it where Silo wrote it; the same value is already applied; a record gone is orphaned', async () => {
    tidy = await branchFrom('Tidy', 'Clean-up');
    staged['c1'] = (await stage(tidy.id, types['set_score']!, { new_score: 77 }, ['c1'])).id;
    staged['c4'] = (await stage(tidy.id, types['set_score']!, { new_score: 44 }, ['c4'])).id;
    staged['c5'] = (await stage(tidy.id, types['set_score']!, { new_score: 66 }, ['c5'])).id;
    staged['c3'] = (await stage(tidy.id, types['delete_contact']!, {}, ['c3'])).id;

    // Since staging: c1 changed through Silo (a mutation root proposed and second approved), c4 in the CRM itself,
    // c5 already holds the staged value, and c3 is gone.
    const real = await gateway.call(proposeMutation, { body: { actionTypeId: types['set_score']!, parameters: { new_score: 12 }, objects: [contact('c1')] } }, keyed());
    await gateway.call(decideApproval, { params: { chainId: real.chain!.id }, body: { decision: 'approved', diffHash: real.diffHash! } }, as(second));
    await until(real.id, (m) => m.completedAt !== null);
    wb.contacts.get('c4')!.properties.score = 41;
    wb.contacts.get('c5')!.properties.score = 66;
    wb.contacts.delete('c3');

    const opened = await open(tidy.id);
    assert.deepEqual(opened.branch.counts, { clean: 0, conflicted: 2, alreadyApplied: 1, orphaned: 1, promoted: 0 });
    const byStaged = Object.fromEntries(opened.branch.stagedActions.map((s) => [s.id, s]));
    assert.deepEqual(byStaged[staged['c1']!]!.conflicts.map((c) => [c.property, c.changedBy, c.changedByKnown]), [['score', root.membershipId, true]]);
    assert.deepEqual(byStaged[staged['c4']!]!.conflicts.map((c) => [c.property, c.changedBy, c.changedByKnown]), [['score', null, false]]);
    const c1 = opened.checks.find((c) => c.stagedActionId === staged['c1'])!.targets[0]!;
    assert.deepEqual(c1.properties.find((p) => p.property === 'score'), { property: 'score', current: 12, branch: 77, branchUnknown: false, state: 'conflicted', resolution: null });
    assert.deepEqual((await audit('branch_staleness_detected')).map((e) => e.detail), [{ clean: 0, conflicted: 2, already_applied: 1, orphaned: 1, run_id: opened.run.runId }]);
  });

  test('the person decides each conflicted property; re-staging takes the value now as the base', async () => {
    const kept = await gateway.call(resolveStagedConflicts, {
      params: { stagedActionId: staged['c1']! }, body: { resolutions: [{ ...contact('c1'), property: 'score', choice: 'keep_staged' }] },
    }, as());
    assert.equal(kept.staleness, 'clean');
    await assert.rejects(gateway.call(resolveStagedConflicts, {
      params: { stagedActionId: staged['c1']! }, body: { resolutions: [{ ...contact('c1'), property: 'name', choice: 'keep_staged' }] },
    }, as()), { code: 'simulation.no_such_conflict' });
    const restaged = await gateway.call(restageAction, { params: { stagedActionId: staged['c4']! } }, keyed());
    assert.deepEqual([restaged.staleness, restaged.conflicts], ['clean', []]);
  });

  test('promotion: each promotable staged Action becomes a proposal through the mutation path, origin the branch, never approved', async () => {
    // Promoted from a canvas view overlaying the scenario (30.9): the view must overlay this branch's scenario.
    await assert.rejects(gateway.call(promoteBranch, { params: { branchId: tidy.id }, body: { canvasViewId: await overlayView(slip.scenarioId, root.membershipId) } }, keyed()),
      { code: 'scenario.canvas_view_mismatch' });
    const canvasViewId = await overlayView(tidy.scenarioId, root.membershipId);
    const out = await gateway.call(promoteBranch, { params: { branchId: tidy.id }, body: { canvasViewId } }, keyed());
    assert.deepEqual((await audit('staged_action_promoted_from_canvas')).map((p) => p.detail.canvas_view_id), [canvasViewId, canvasViewId]);
    assert.deepEqual(out.promoted.map((p) => p.stagedActionId).sort(), [staged['c1'], staged['c4']].sort());
    assert.deepEqual(out.notPromoted.map((n) => [n.stagedActionId, n.reason]).sort(), [[staged['c3'], 'orphaned'], [staged['c5'], 'already_applied']].sort());
    assert.equal(out.branch.status, 'partially_promoted');
    const c1 = await gateway.call(getMutation, { params: { mutationId: out.promoted.find((p) => p.stagedActionId === staged['c1'])!.mutationId } }, as());
    assert.equal(c1.origin, 'scenario_promotion');
    assert.equal(c1.status, 'awaiting_approval', 'promotion creates proposals and never approves them');
    assert.ok(c1.chain!.approvalsRequired >= 1);
    assert.deepEqual([c1.promotion?.branchId, c1.promotion?.stagedActionId], [tidy.id, staged['c1']]);
    assert.ok(c1.promotion?.simulation.runId !== null, 'the approver sees the branch simulation with the proposal');
    const scoreRow = c1.preview!.rows.find((r) => r.field === 'score')!;
    assert.deepEqual([scoreRow.prior, scoreRow.proposed], [12, 77], 'prior state is read afresh at promotion, never the base');
    assert.equal(wb.contacts.get('c1')!.properties.score, 12, 'nothing is written until the chain is satisfied');
    assert.equal((await audit('staged_action_promoted')).length, 2);
    assert.deepEqual((await audit('scenario_action_promoted')).map((p) => p.detail.staged_action_id).sort(), [staged['c1'], staged['c4']].sort(),
      'the mutation path records where each proposal came from');

    await gateway.call(decideApproval, { params: { chainId: c1.chain!.id }, body: { decision: 'approved', diffHash: c1.diffHash! } }, as(second));
    const done = await until(c1.id, (m) => m.completedAt !== null);
    assert.equal(wb.contacts.get('c1')!.properties.score, 77);
    const receipt = await gateway.call(getReceipt, { params: { receiptId: done.receiptId! } }, as());
    assert.deepEqual((receipt.summary['promotion'] as { stagedActionId: string }).stagedActionId, staged['c1'], 'the receipt names its staged Action');
  });

  test('a canvas view overlays a scenario only for an opener who may see it (spec 30.9)', async () => {
    const mine = await overlayView(tidy.scenarioId, root.membershipId);
    const opened = await gateway.call(openCanvasView, { params: { canvasViewId: mine } }, as());
    assert.equal(opened.view.scenarioId, tidy.scenarioId);
    assert.deepEqual((await audit('scenario_overlaid')).map((p) => [p.resource.id, p.detail.scenario_id]), [[mine, tidy.scenarioId]]);
    // A scenario is private by default (39.7): on another person's view of it, the overlay is withheld, and said so.
    const theirs = await overlayView(tidy.scenarioId, second.membershipId);
    const withheld = await gateway.call(openCanvasView, { params: { canvasViewId: theirs } }, as(second));
    assert.deepEqual([withheld.view.scenarioId, withheld.statement !== null], [null, true]);
    assert.equal((await audit('scenario_overlaid')).length, 1, 'nothing overlaid for them');
  });

  test('a promoted branch stays openable as the record of what was simulated', async () => {
    const opened = await open(tidy.id);
    assert.equal(opened.branch.counts.promoted, 2);
    const view = await gateway.call(getBranch, { params: { branchId: tidy.id } }, as());
    assert.ok(view.stagedActions.filter((s) => s.promotedActionId !== null).every((s) => s.promotedAt !== null));
  });
});

describe('close and retention (spec 39.8, 39.11)', () => {
  test('a closed branch takes nothing more; its bases purge at the end of its retention, and then it cannot be opened', async () => {
    const closed = await gateway.call(closeBranch, { params: { branchId: drop.id }, body: { version: drop.version } }, as());
    assert.equal(closed.status, 'closed');
    assert.ok(closed.basesPurgeAt !== null);
    await assert.rejects(stage(drop.id, types['move_due']!, { new_due: '2026-12-09' }, ['c2']), { code: 'simulation.branch_not_open' });
    assert.ok(await maintenanceRepo.purgeBranchBases(wb.cell.migrate, 100) >= 1);
    assert.ok(await maintenanceRepo.closeOutPurgedBranches(wb.cell.migrate, 100) >= 1);
    const { rows } = await inTx(wb.cell.app, { orgId: wb.cell.org }, () => wb.cell.app.query(
      `select b.purged_at, b.base_value, s.manifest_values from simulation.staged_action_bases b
         join simulation.staged_actions s on s.id = b.staged_action_id where s.branch_id = $1`, [drop.id]));
    assert.ok(rows.every((r) => r.purged_at !== null && r.base_value === null && r.manifest_values === null));
    assert.equal((await gateway.call(getBranch, { params: { branchId: drop.id } }, as())).basesPurged, true);
    await assert.rejects(open(drop.id), { code: 'simulation.branch_purged' });
  });
});
