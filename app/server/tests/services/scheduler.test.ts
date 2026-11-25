// Crons end to end (spec 40): a member's saved view, run on a schedule as the Cron's own
// service principal through the real query path, a condition over its answer, and notify,
// report and escalate actions; the gates (owner, halted connection, overlap), the failure
// policy, missed runs, and what the owner may change.

import { holdShedLevel } from '../../src/infra/load.infra.ts';
import { SHED_ORDER } from '../../src/contracts/endpoint.contract.ts';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { changeConnectionStatus, getConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { listFiles, downloadFile } from '../../src/contracts/files/file.contract.ts';
import { listNotifications } from '../../src/contracts/notify/notification.contract.ts';
import { revokeConnectionGrant, grantConnection } from '../../src/contracts/policy/governance.contract.ts';
import { removeMember } from '../../src/contracts/policy/admin.contract.ts';
import {
  acknowledgeEscalation, createCron, deleteCron, getCron, listCronRuns, listCrons, pauseCron, resumeCron, runCronNow, type CronRunView,
} from '../../src/contracts/scheduler/cron.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { getManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { openBranch } from '../../src/contracts/ontology/proposal.contract.ts';
import { compilePlan } from '../../src/contracts/compile/compile.contract.ts';
import { saveView } from '../../src/contracts/workspace/view.contract.ts';
import { clock, createFilesCell, INVOICES, invoiceType, resetInvoices, until, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let listView: string;
let sumView: string;

const runs = async (cronId: string, who = f.member): Promise<CronRunView[]> =>
  (await f.gateway.call(listCronRuns, { params: { cronId }, query: {} }, f.cell.as(who))).runs;
const finished = (cronId: string, count: number) => until(`${count} finished runs`, async () => {
  const all = await runs(cronId);
  return all.length >= count && all.slice(0, count).every((r) => r.status !== 'running') ? all : undefined;
});
const cron = (body: object, who = f.member) => f.gateway.call(createCron, { body: body as never }, f.keyed(who));
const notifications = async (who = f.member) =>
  (await f.gateway.call(listNotifications, { query: {} }, f.cell.as(who))).notifications;

before(async () => {
  f = await createFilesCell();
  const type = invoiceType(f.manifest);
  listView = (await f.view(f.member, {
    nodes: [{ objectTypeId: type, filters: [] }],
    select: [{ node: 0, property: f.prop('invoice_id') }, { node: 0, property: f.prop('customer') }, { node: 0, property: f.prop('total') }],
    sort: [{ property: f.prop('invoice_id'), direction: 'asc' }],
  }, 'Invoices')).viewId;
  sumView = (await f.view(f.member, {
    nodes: [{ objectTypeId: type, filters: [] }],
    aggregate: { groupBy: [], measures: [{ fn: 'sum', node: 0, property: f.prop('total'), as: 'billed' }] },
  }, 'Billed')).viewId;
});

after(async () => {
  await f?.close();
});

describe('creating a Cron (spec 40.1, 40.6, 40.7)', () => {
  // Mutate actions are tests/services/cronMutations.test.ts's, in a cell where actions runs.
  test('refused: too frequent, a finding condition, a change trigger on a question, a view the owner cannot run', async () => {
    const base = { name: 'x', subject: { savedViewId: listView }, trigger: { schedule: '0 9 * * *' }, actions: [{ kind: 'notify' }] };
    await assert.rejects(cron({ ...base, trigger: { schedule: '*/5 * * * *' } }), { code: 'scheduler.interval_too_short' });
    // A change trigger watches an object set (tests/services/cronWatch.test.ts), never a saved question.
    await assert.rejects(cron({ ...base, trigger: { watch: { properties: [], windowSeconds: 60 } } }), { code: 'scheduler.watch_needs_object_set' });
    await assert.rejects(cron(base, f.outsider), { code: 'workspace.view_not_found' }, 'another member\'s private view');
  });

  test('the Cron has its own automation principal, its next run in the organisation\'s time zone, and the connections it reads', async () => {
    const created = await cron({
      name: 'Morning check', subject: { savedViewId: listView }, trigger: { schedule: '0 9 * * *' }, actions: [{ kind: 'notify' }],
    });
    assert.equal(created.timezone, 'Europe/London');
    assert.equal(created.status, 'active');
    assert.deepEqual(created.connectionIds, [f.crm]);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' }).format(new Date(created.nextRunAt!));
    assert.equal(local, '09:00');
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      'select kind, owner_membership_id, revoked_at from iam.service_principals where id = $1', [created.servicePrincipalId]));
    assert.deepEqual(rows[0], { kind: 'automation', owner_membership_id: f.member.membershipId, revoked_at: null });
    await assert.rejects(cron({ name: 'Morning check', subject: { savedViewId: listView }, trigger: { schedule: '0 10 * * *' }, actions: [{ kind: 'notify' }] }),
      { code: 'scheduler.name_taken' });
    // Gone, so the later tests' clock jumps never make it due (between 07:30 and 09:00 one would).
    await f.gateway.call(deleteCron, { params: { cronId: created.id } }, f.cell.as(f.member));
  });
});

describe('a scheduled run (spec 40.4 to 40.7)', () => {
  test('due: runs as its principal, meets its condition, notifies, reports into Files, and moves to the next day', async () => {
    const created = await cron({
      name: 'Open invoices', subject: { savedViewId: listView }, trigger: { schedule: '30 7 * * *' },
      condition: { kind: 'result', operator: 'returned_rows' }, actions: [{ kind: 'notify' }, { kind: 'report', format: 'csv' }],
    });
    const before = await notifications();
    clock.offset = Date.parse(created.nextRunAt!) - Date.now() + 1_000;
    const [run] = await finished(created.id, 1);
    clock.offset = 0;
    assert.equal(run!.trigger, 'schedule');
    assert.equal(run!.status, 'completed');
    assert.equal(run!.conditionOutcome, 'met');
    assert.deepEqual(run!.actions.map((a) => [a.kind, a.outcome]), [['notify', 'delivered'], ['report', 'succeeded']], JSON.stringify(run!.actions));
    assert.deepEqual(run!.actions[0]!.resultCounts, { rows: 3, recipients: 1 }, 'counts, never values');

    const items = await notifications();
    assert.equal(items.length, before.length + 1);
    assert.equal(items[0]!.kind, 'cron_notify');

    // The report is the owner's file, from the Cron's run, frozen.
    const files = (await f.gateway.call(listFiles, { query: {} }, f.cell.as(f.member))).files;
    const report = files.find((x) => x.id === run!.actions[1]!.fileId)!;
    assert.equal(report.createdBy, f.member.membershipId);
    assert.equal(report.provenance?.sourceKind, 'cron_report');
    assert.equal(report.provenance?.sourceId, run!.id);
    const content = await f.gateway.call(downloadFile, { params: { fileId: report.id } }, f.cell.as(f.member));
    const csv = Buffer.from(content.content, 'base64').toString('utf8');
    assert.ok(csv.includes('Invoice number,Customer,Total'));
    assert.ok(csv.includes('"Brill, plc"'));

    const after = await f.gateway.call(getCron, { params: { cronId: created.id } }, f.cell.as(f.member));
    assert.ok(Date.parse(after.nextRunAt!) > Date.parse(created.nextRunAt!), 'moved on, from now');
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `select payload->>'event' as event, payload->'actor'->>'kind' as actor from platform.outbox
       where payload->'resource'->>'id' = $1 order by seq`, [created.id]));
    const events = rows.map((r) => r.event);
    for (const e of ['automation_created', 'automation_run_started', 'automation_condition_met', 'automation_action_taken', 'automation_run_completed']) {
      assert.ok(events.includes(e), e);
    }
    assert.equal(rows.find((r) => r.event === 'automation_run_started')!.actor, 'service_principal', 'the run is the Cron\'s, never its owner\'s');
  });

  test('"differs from previous" keeps a keyed hash, never the rows; the first run is the baseline', async () => {
    const created = await cron({
      name: 'Changes', subject: { savedViewId: listView }, trigger: { schedule: '0 6 * * *' },
      condition: { kind: 'result', operator: 'differs_from_previous' }, actions: [{ kind: 'notify' }],
    });
    const manual = () => f.gateway.call(runCronNow, { params: { cronId: created.id } }, f.cell.as(f.member));
    await manual();
    assert.equal((await finished(created.id, 1))[0]!.conditionOutcome, 'not_met');
    await manual();
    assert.equal((await finished(created.id, 2))[0]!.conditionOutcome, 'not_met', 'the same answer');
    INVOICES.push({ id: 'i4', customer: 'Cobalt', total: 50, status: 'open' });
    try {
      await manual();
      const latest = (await finished(created.id, 3))[0]!;
      assert.equal(latest.conditionOutcome, 'met');
      assert.equal(latest.trigger, 'manual');
    } finally {
      resetInvoices();
    }
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      'select octet_length(previous_result_hash) as bytes, previous_row_count from automation.automation_run_state where automation_id = $1', [created.id]));
    assert.deepEqual(rows[0], { bytes: 32, previous_row_count: '4' });
  });

  test('a value over one figure: met above the threshold; the figure is sealed between runs', async () => {
    const created = await cron({
      name: 'Billed', subject: { savedViewId: sumView }, trigger: { schedule: '0 6 * * *' },
      condition: { kind: 'composite', combinator: 'AND', operands: [
        { kind: 'value', operator: 'above', figure: { measure: 'billed' }, threshold: 400 },
        { kind: 'result', operator: 'returned_rows' },
      ] },
      actions: [{ kind: 'notify' }],
    });
    await f.gateway.call(runCronNow, { params: { cronId: created.id } }, f.cell.as(f.member));
    const first = (await finished(created.id, 1))[0]!;
    assert.equal(first.conditionOutcome, 'met', `120 + 80 + 300 is above 400: ${JSON.stringify(first)}`);
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      'select previous_value from automation.automation_run_state where automation_id = $1', [created.id]));
    assert.ok(rows[0].previous_value.length > 20);
    assert.ok(!rows[0].previous_value.toString('utf8').includes('500'), 'sealed, never in clear');
  });
});

describe('the gates (spec 40.6, 40.7, 40.8)', () => {
  test('a Cron cannot exceed its owner: without the owner\'s grant the run fails, and the owner is told', async () => {
    const created = await cron({
      name: 'Grant check', subject: { savedViewId: listView }, trigger: { schedule: '0 6 * * *' }, actions: [{ kind: 'notify' }],
      failurePolicy: { mode: 'pause_after', failures: 2 },
    });
    await f.gateway.call(revokeConnectionGrant, { params: { grantId: f.memberGrantId } }, f.cell.as(f.root));
    try {
      for (const n of [1, 2]) {
        await f.gateway.call(runCronNow, { params: { cronId: created.id } }, f.cell.as(f.member));
        const [latest] = await finished(created.id, n);
        assert.equal(latest!.status, 'failed');
        assert.match(latest!.error ?? '', /^refused\./);
        assert.ok(latest!.actions.some((a) => a.kind === 'notify' && (a.resultCounts as Record<string, number>)['failed'] === 1));
      }
      const paused = await f.gateway.call(getCron, { params: { cronId: created.id } }, f.cell.as(f.member));
      assert.equal(paused.status, 'paused');
      assert.equal(paused.pausedReason, 'repeated_failure');
    } finally {
      const again = await f.gateway.call(grantConnection, {
        body: { connectionId: f.crm, grantee: { kind: 'membership', id: f.member.membershipId }, access: 'read' },
      }, f.cell.as(f.root));
      f.memberGrantId = again.id;
    }
  });

  test('a run still in progress makes the next skip, not queue', async () => {
    const created = await cron({ name: 'Overlap', subject: { savedViewId: listView }, trigger: { schedule: '0 6 * * *' }, actions: [{ kind: 'notify' }] });
    await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `insert into automation.automation_runs (id, organisation_id, automation_id, trigger_kind, status, started_at)
       values ($1, $2, $3, 'schedule', 'running', now())`, [uuidv7(), f.cell.org, created.id]));
    const out = await f.gateway.call(runCronNow, { params: { cronId: created.id } }, f.cell.as(f.member));
    assert.equal(out.skipped, 'overlap');
    assert.equal((await runs(created.id))[0]!.skippedReason, 'overlap');
  });

  test('a halted connection pauses the Cron and says so; resuming waits for the connection', async () => {
    const created = await cron({ name: 'Halt', subject: { savedViewId: listView }, trigger: { schedule: '0 6 * * *' }, actions: [{ kind: 'notify' }] });
    let connection = await f.gateway.call(getConnection, { params: { connectionId: f.crm } }, f.cell.as(f.root));
    connection = await f.gateway.call(changeConnectionStatus, {
      params: { connectionId: f.crm }, body: { move: 'halt', version: connection.version, reason: 'maintenance' } as never,
    }, f.cell.as(f.root));
    try {
      const out = await f.gateway.call(runCronNow, { params: { cronId: created.id } }, f.cell.as(f.member));
      assert.equal(out.skipped, 'connection_halted');
      const paused = await f.gateway.call(getCron, { params: { cronId: created.id } }, f.cell.as(f.member));
      assert.equal(paused.pausedReason, 'connection_halted');
      await assert.rejects(f.gateway.call(resumeCron, { params: { cronId: created.id } }, f.cell.as(f.member)), { code: 'scheduler.connection_halted' });
      assert.ok((await runs(created.id))[0]!.actions.some((a) => (a.resultCounts as Record<string, number>)['paused'] === 1), 'the owner is told');
    } finally {
      await f.gateway.call(changeConnectionStatus, { params: { connectionId: f.crm }, body: { move: 'resume', version: connection.version } }, f.cell.as(f.root));
    }
    const resumed = await f.gateway.call(resumeCron, { params: { cronId: created.id } }, f.cell.as(f.member));
    assert.equal(resumed.status, 'active');
  });

  test('missed runs are reported as a gap and run once, never backfilled', async () => {
    const created = await cron({ name: 'Missed', subject: { savedViewId: listView }, trigger: { schedule: '0 6 * * *' }, actions: [{ kind: 'notify' }] });
    // Due at the 06:00 three days before the latest one passed (London): three more fell since,
    // whatever the time of day the test runs at.
    await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `update automation.automations set next_run_at = (
         date_trunc('day', now() at time zone 'Europe/London') + interval '6 hours'
         - case when now() at time zone 'Europe/London' < date_trunc('day', now() at time zone 'Europe/London') + interval '6 hours'
                then interval '1 day' else interval '0' end
         - interval '3 days') at time zone 'Europe/London'
       where id = $1`, [created.id]));
    const all = await finished(created.id, 1);
    assert.equal(all.length, 1, 'one run, not four');
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `select payload->'detail' as detail from platform.outbox where payload->>'event' = 'automation_run_skipped'
       and payload->'resource'->>'id' = $1`, [created.id]));
    assert.equal(rows[0].detail.reason, 'missed');
    assert.equal(rows[0].detail.missed, 3);
  });

  test('under load a Cron is shed (12.4): a missed run, reported, not backfilled; it runs once the load falls', async () => {
    const created = await cron({ name: 'Shed', subject: { savedViewId: listView }, trigger: { schedule: '0 * * * *' }, actions: [{ kind: 'notify' }] });
    holdShedLevel(SHED_ORDER.indexOf('cron') + 1);
    try {
      await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
        `update automation.automations set next_run_at = now() - interval '1 second' where id = $1`, [created.id]));
      const skipped = await until('the shed run to be reported', async () => {
        const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
          `select payload->'detail' as detail from platform.outbox where payload->>'event' = 'automation_run_skipped' and payload->'resource'->>'id' = $1`, [created.id]));
        return rows.length > 0 ? rows : undefined;
      });
      assert.deepEqual([skipped[0].detail.reason, skipped[0].detail.missed], ['capacity', 1]);
      assert.equal((await runs(created.id)).length, 0, 'not run');
    } finally {
      holdShedLevel(undefined);
    }
    await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `update automation.automations set next_run_at = now() - interval '1 second' where id = $1`, [created.id]));
    assert.equal((await finished(created.id, 1)).length, 1, 'the next time runs as usual');
  });

  test('an owner who is no longer active pauses the Cron; it never runs under them', async () => {
    const leaver = await f.cell.member('leaver@acme.example', 'Member');
    await f.gateway.call(grantConnection, { body: { connectionId: f.crm, grantee: { kind: 'membership', id: leaver.membershipId }, access: 'read' } },
      f.cell.as(f.root));
    const theirs = await f.view(leaver, {
      nodes: [{ objectTypeId: invoiceType(f.manifest), filters: [] }], select: [{ node: 0, property: f.prop('invoice_id') }],
    }, 'Mine');
    const created = await cron({ name: 'Leaver', subject: { savedViewId: theirs.viewId }, trigger: { schedule: '0 6 * * *' }, actions: [{ kind: 'notify' }] }, leaver);
    await f.cell.migrate.query(`update iam.memberships set status = 'removed', removed_at = now() where id = $1`, [leaver.membershipId]);
    await f.cell.migrate.query(`update automation.automations set next_run_at = now() - interval '1 minute' where id = $1`, [created.id]);
    const row = await until('the pause', async () => {
      const { rows } = await f.cell.migrate.query('select status, paused_reason from automation.automations where id = $1', [created.id]);
      return rows[0].status === 'paused' ? rows[0] : undefined;
    });
    assert.equal(row.paused_reason, 'owner_removed');
    const { rows } = await f.cell.migrate.query('select status, skipped_reason from automation.automation_runs where automation_id = $1', [created.id]);
    assert.deepEqual(rows, [{ status: 'skipped', skipped_reason: 'owner_unavailable' }]);
  });

  test('removing a member pauses their Crons at once, each recorded (spec 55.7, 55.8)', async () => {
    const leaver = await f.cell.member('another-leaver@acme.example', 'Member');
    await f.gateway.call(grantConnection, { body: { connectionId: f.crm, grantee: { kind: 'membership', id: leaver.membershipId }, access: 'read' } },
      f.cell.as(f.root));
    const theirs = await f.view(leaver, {
      nodes: [{ objectTypeId: invoiceType(f.manifest), filters: [] }], select: [{ node: 0, property: f.prop('invoice_id') }],
    }, 'Theirs');
    const created = await cron({ name: 'Leaver two', subject: { savedViewId: theirs.viewId }, trigger: { schedule: '0 6 * * *' }, actions: [{ kind: 'notify' }] }, leaver);
    await f.gateway.call(removeMember, { params: { membershipId: leaver.membershipId } }, f.cell.as(f.root));
    const { rows: [row] } = await f.cell.migrate.query('select status, paused_reason from automation.automations where id = $1', [created.id]);
    assert.deepEqual([row.status, row.paused_reason], ['paused', 'owner_removed'], 'paused with the removal, not at its next firing');
    const { rows: events } = await f.cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where payload->>'event' = 'cron_paused_on_removal' and payload->'resource'->>'id' = $1`, [created.id]);
    assert.deepEqual(events.map((e) => e.detail.owner_membership_id), [leaver.membershipId]);
  });
});

describe('escalations and management (spec 40.4, 40.8, 40.9)', () => {
  test('an escalation stays open until the member it names acknowledges it', async () => {
    const created = await cron({
      name: 'Escalate', subject: { savedViewId: listView }, trigger: { schedule: '0 6 * * *' },
      actions: [{ kind: 'escalate', membershipId: f.root.membershipId }],
    });
    await f.gateway.call(runCronNow, { params: { cronId: created.id } }, f.cell.as(f.member));
    const action = (await finished(created.id, 1))[0]!.actions[0]!;
    assert.equal(action.escalatedMembershipId, f.root.membershipId);
    assert.ok((await notifications(f.root)).some((n) => n.kind === 'cron_escalate'));
    await assert.rejects(f.gateway.call(acknowledgeEscalation, { params: { runActionId: action.id } }, f.cell.as(f.member)),
      { code: 'scheduler.escalation_not_found' });
    const acknowledged = await f.gateway.call(acknowledgeEscalation, { params: { runActionId: action.id } }, f.cell.as(f.root));
    assert.ok(acknowledged.acknowledgedAt !== null);
  });

  test('others see nothing; the owner pauses and resumes; deleting stops it and revokes its principal', async () => {
    const created = await cron({ name: 'Lifecycle', subject: { savedViewId: listView }, trigger: { schedule: '0 6 * * *' }, actions: [{ kind: 'notify' }] });
    await assert.rejects(f.gateway.call(getCron, { params: { cronId: created.id } }, f.cell.as(f.outsider)), { code: 'scheduler.cron_not_found' });
    await assert.rejects(f.gateway.call(pauseCron, { params: { cronId: created.id } }, f.cell.as(f.outsider)), { code: 'scheduler.cron_not_found' });
    assert.ok((await f.gateway.call(listCrons, { query: { which: 'managed' } }, f.cell.as(f.root))).crons.some((c) => c.id === created.id),
      'a super admin manages every Cron');
    assert.equal((await f.gateway.call(pauseCron, { params: { cronId: created.id } }, f.cell.as(f.member))).pausedReason, 'manual');
    const paused = await f.gateway.call(runCronNow, { params: { cronId: created.id } }, f.cell.as(f.member));
    assert.equal(paused.skipped, 'paused');
    assert.equal((await f.gateway.call(resumeCron, { params: { cronId: created.id } }, f.cell.as(f.member))).status, 'active');
    const deleted = await f.gateway.call(deleteCron, { params: { cronId: created.id } }, f.cell.as(f.member));
    assert.equal(deleted.status, 'stopped');
    const { rows } = await f.cell.migrate.query('select revoked_at from iam.service_principals where id = $1', [created.servicePrincipalId]);
    assert.ok(rows[0].revoked_at !== null);
    await assert.rejects(f.gateway.call(getCron, { params: { cronId: created.id } }, f.cell.as(f.member)), { code: 'scheduler.cron_not_found' });
  });
});

describe('a Cron runs against main (spec 25.3)', () => {
  test('one over a view compiled on an ontology branch is refused', async () => {
    const branch = await f.gateway.call(openBranch, { body: { name: 'cron what if' } }, f.keyed(f.root));
    // A change on the branch, so its head is its own version and not main's.
    await f.gateway.call(putObjectType, { params: { branchId: branch.id, apiName: 'invoice_draft' }, body: {
      displayName: 'Draft invoice', pluralName: 'Draft invoices', contributingObjects: [{ connectionId: f.crm, sourceObject: 'invoices', identifierFieldPath: 'id' }],
      properties: [{ apiName: 'draft_id', displayName: 'Id', dataType: 'string', mappings: [{ connectionId: f.crm, sourceObject: 'invoices', fieldPath: 'id' }] }],
      primaryKey: 'draft_id', title: 'draft_id',
    } as never }, f.keyed(f.root));
    const onBranch = await f.gateway.call(getManifest, { query: { branchId: branch.id } }, f.cell.as(f.root));
    const draft = onBranch.objectTypes.find((t) => t.apiName === 'invoice_draft')!;
    const compiled = await f.gateway.call(compilePlan, {
      body: { plan: { schemaVersion: '1', ontologyVersionId: onBranch.version.id, nodes: [{ objectTypeId: draft.id }] }, execute: false },
    }, f.cell.as(f.root));
    assert.equal(compiled.outcome, 'plan');
    if (compiled.outcome !== 'plan') return;
    const view = await f.gateway.call(saveView, { body: { kind: 'result', name: 'Drafts on the branch', manifestId: compiled.planId } }, f.keyed(f.root));
    await assert.rejects(cron({ name: 'Drafts', subject: { savedViewId: view.id }, trigger: { schedule: '0 9 * * *' }, actions: [{ kind: 'notify' }] }, f.root),
      { code: 'cron.plan_on_branch' });
  });
});
