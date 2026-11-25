// Pipeline schedules (D241): a pipeline run on a schedule as its own service principal, granted
// read on the connections its inputs read and silo.import, never exceeding its owner. Set by an
// owner who may write into its output Silo now, no oftener than every fifteen minutes; run by the
// due sweep; missed times counted, never backfilled; each failed run tells the owner, and after the
// failures it allows in a row it pauses; resumed; an archived pipeline's schedule pauses; removing
// it revokes its principal. Real processes: the files cell with Import Siloes, sweeping fast.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { createImportSilo, createSource, uploadFile } from '../../src/contracts/siloes/import.contract.ts';
import {
  archivePipeline, createPipeline, getPipeline, listPipelineRuns, removePipelineSchedule, resumePipelineSchedule, setPipelineSchedule, type PipelineDocument,
} from '../../src/contracts/workspace/pipeline.contract.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createFilesCell, invoiceType, type FilesCell } from './scheduler.helper.ts';

let f: FilesCell;
let pipelineId: string;
let doc: PipelineDocument;

/** Waits for the sweep: until the check holds, or fails after fifteen seconds. */
async function until<T>(check: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const out = await check();
    if (out !== undefined) return out;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const due = (ago = '1 minute') => f.cell.migrate.query(`update workspace.pipeline_schedules set next_run_at = now() - interval '${ago}' where pipeline_id = $1`, [pipelineId]);
const scheduledRuns = async () => (await f.gateway.call(listPipelineRuns, { params: { pipelineId } }, f.cell.as(f.root))).runs.filter((r) => r.trigger === 'schedule');

before(async () => {
  f = await createFilesCell({ siloes: true, workspace: { sweepTickMs: 100 } });
  await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query('update iam.organisations set storage_enabled = true where id = $1', [f.cell.org]));
  const siloId = (await f.gateway.call(createImportSilo, { body: { name: 'Derived', purpose: 'Pipeline outputs', retentionDays: 365 } }, f.keyed(f.root))).id;
  const sourceId = (await f.gateway.call(createSource, { params: { siloId }, body: { kind: 'upload' } }, f.cell.as(f.root))).id;
  const setId = (await f.gateway.call(saveObjectSet, {
    body: { name: 'Invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } } },
  }, f.keyed(f.root))).id;
  doc = {
    schemaVersion: '1',
    inputs: [{ id: 'invoices', objectSetId: setId, propertyIds: [f.prop('invoice_id'), f.prop('total')], limit: 1000 }],
    steps: [{ op: 'filter', cel: 'total > 100' }],
    output: { siloId, sourceId, filename: 'large.csv' },
  };
  pipelineId = (await f.gateway.call(createPipeline, { body: { name: 'Large invoices', document: doc } }, f.keyed(f.root))).id;
});

after(async () => {
  await f?.close();
});

describe('pipeline schedules (D241)', () => {
  test('set by an owner who may write its output now, no oftener than every fifteen minutes; its own principal made with it', async () => {
    await assert.rejects(f.gateway.call(setPipelineSchedule, { params: { pipelineId }, body: { schedule: '*/5 * * * *' } }, f.cell.as(f.root)), { code: 'scheduler.interval_too_short' });
    const set = await f.gateway.call(setPipelineSchedule, { params: { pipelineId }, body: { schedule: '0 * * * *', pauseAfterFailures: 2 } }, f.cell.as(f.root));
    assert.ok(set.schedule !== null && set.schedule.status === 'active' && set.schedule.nextRunAt !== null);
    const { rows } = await f.cell.migrate.query('select kind, owner_membership_id, revoked_at from iam.service_principals where id = $1', [set.schedule!.servicePrincipalId]);
    assert.deepEqual([rows[0].kind, rows[0].owner_membership_id, rows[0].revoked_at], ['automation', f.root.membershipId, null]);
    // A member who may not import into the Silo cannot schedule a pipeline of theirs writing into it.
    const theirs = await f.gateway.call(createPipeline, { body: { name: 'Mine', document: doc } }, f.keyed(f.member)).catch((e: { code?: string }) => e);
    if ('id' in theirs) {
      await assert.rejects(f.gateway.call(setPipelineSchedule, { params: { pipelineId: theirs.id }, body: { schedule: '0 * * * *' } }, f.cell.as(f.member)), { code: 'import.not_permitted' });
    }
  });

  test('run by the sweep as its principal: completed, its next time moved on', async () => {
    await due();
    const [run] = await until(async () => { const r = await scheduledRuns(); return r.some((x) => x.status !== 'running') ? r : undefined; }, 'a scheduled run');
    assert.deepEqual([run!.status, run!.rows, run!.startedBy, run!.failure], ['completed', 2, null, null]);
    const p = await f.gateway.call(getPipeline, { params: { pipelineId } }, f.cell.as(f.root));
    assert.ok(Date.parse(p.schedule!.nextRunAt!) > Date.now() && p.schedule!.lastRunAt !== null && p.schedule!.failuresInARow === 0);
  });

  test('missed times are counted, never backfilled: one run', async () => {
    const before = (await scheduledRuns()).length;
    await due('3 hours 30 minutes');
    await until(async () => ((await scheduledRuns()).filter((r) => r.status !== 'running').length > before ? true : undefined), 'the late run');
    assert.equal((await scheduledRuns()).length, before + 1);
    const { rows } = await f.cell.migrate.query(`select payload->'detail' as d from platform.outbox where payload->>'event' = 'pipeline_run_skipped' order by seq desc limit 1`);
    assert.ok(Number(rows[0].d.missed) >= 3, JSON.stringify(rows[0].d));
  });

  test('a failed run tells its owner; after the failures it allows in a row it pauses; resumed, it counts afresh', async () => {
    // The input's type marked, and not the Silo: a run would declassify, so it fails.
    const marking = await f.gateway.call(createMarking, { body: { name: 'Billing', kind: 'classification', rank: 1 } }, f.cell.as(f.root));
    await f.gateway.call(grantClearance, { body: { markingId: marking.id, holder: { kind: 'membership', id: f.root.membershipId } } }, f.cell.as(f.root));
    await f.gateway.call(applyMarking, { body: { markingId: marking.id, resource: { type: 'object_type', id: invoiceType(f.manifest) } } }, f.cell.as(f.root));
    for (let i = 1; i <= 2; i++) {
      await due();
      await until(async () => ((await scheduledRuns()).filter((r) => r.status === 'failed').length >= i ? true : undefined), `failure ${i}`);
    }
    const failed = (await scheduledRuns()).find((r) => r.status === 'failed')!;
    assert.match(failed.failure ?? '', /does not carry Billing/);
    const p = await until(async () => { const x = await f.gateway.call(getPipeline, { params: { pipelineId } }, f.cell.as(f.root)); return x.schedule?.status === 'paused' ? x : undefined; }, 'the pause');
    assert.deepEqual([p.schedule!.pausedReason, p.schedule!.failuresInARow, p.schedule!.nextRunAt], ['failures', 2, null]);
    const told = await until(async () => {
      const { rows } = await f.cell.migrate.query(`select count(*)::int as n from workspace.notifications where kind = 'pipeline_run_failed' and recipient_membership_id = $1`, [f.root.membershipId]);
      return rows[0].n >= 2 ? rows[0].n : undefined;
    }, 'the owner told');
    assert.ok(told >= 2);
    const resumed = await f.gateway.call(resumePipelineSchedule, { params: { pipelineId } }, f.cell.as(f.root));
    assert.deepEqual([resumed.schedule!.status, resumed.schedule!.failuresInARow, resumed.schedule!.nextRunAt !== null], ['active', 0, true]);
  });

  test('an archived pipeline\'s schedule pauses; removing a schedule revokes its principal and keeps its runs', async () => {
    const archived = await f.gateway.call(archivePipeline, { params: { pipelineId } }, f.cell.as(f.root));
    assert.deepEqual([archived.schedule!.status, archived.schedule!.pausedReason], ['paused', 'archived']);
    const principal = archived.schedule!.servicePrincipalId;
    const removed = await f.gateway.call(removePipelineSchedule, { params: { pipelineId } }, f.cell.as(f.root));
    assert.equal(removed.schedule, null);
    const { rows } = await f.cell.migrate.query('select revoked_at from iam.service_principals where id = $1', [principal]);
    assert.ok(rows[0].revoked_at !== null);
    assert.ok((await scheduledRuns()).length >= 4, 'its runs are kept');
    const events = (await f.cell.migrate.query(`select distinct payload->>'event' as e from platform.outbox where payload->>'event' like 'pipeline_schedule_%'`)).rows.map((r) => r.e).sort();
    assert.deepEqual(events, ['pipeline_schedule_paused', 'pipeline_schedule_removed', 'pipeline_schedule_resumed', 'pipeline_schedule_set']);
  });

  test('no other principal puts a file into a Silo, whatever it holds (decided 2026-11-23)', async () => {
    const principal = uuidv7();
    await f.cell.migrate.query(
      // An automation principal that is no pipeline's (as an integration or a Cron is): refused before its permissions are asked.
      `insert into iam.service_principals (id, organisation_id, kind, name, owner_membership_id, created_by) values ($1, $2, 'automation', 'An integration', $3, $3)`,
      [principal, f.cell.org, f.root.membershipId]);
    const { siloId, sourceId } = doc.output!;
    await assert.rejects(f.cell.client('workspace').call(uploadFile, {
      params: { siloId, sourceId }, body: { filename: 'x.csv', contentBase64: Buffer.from('a,b\n1,2\n').toString('base64') },
    }, { request: { organisationId: f.cell.org, servicePrincipalId: principal }, correlationId: uuidv7(), idempotencyKey: uuidv7() }), { code: 'siloes.person_required' });
  });
});
