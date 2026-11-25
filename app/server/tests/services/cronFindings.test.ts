// Finding conditions on Crons (spec 40.3, 40.12 step 2): "tell me when this kind of problem
// appears". The outlier detector raises Kilo's rating. A Cron watching it is not met by what
// was raised before it existed, is met by a finding raised since its last run (read as the Cron,
// with no Lens); one asking for a score above a bar is met only above it; and one asking
// for a recurrence is met only when the finding went away and came back, not when a run raised
// it again straight after.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { configureDetector, listDetectors, runDetectors } from '../../src/contracts/recognition/detector.contract.ts';
import { listFindings } from '../../src/contracts/recognition/finding.contract.ts';
import { createCron, listCronRuns, runCronNow } from '../../src/contracts/scheduler/cron.contract.ts';
import { service as recognitionService } from '../../src/routes/recognition/index.route.ts';
import { createSchedulerService } from '../../src/routes/scheduler/index.route.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { startRecognitionCell, SUPPLIERS, type RecognitionCell } from './recognition.helper.ts';

let r: RecognitionCell;
let suppliersSet = '';
let outlier = '';
const keyed = () => ({ ...r.cell.as(r.root), idempotencyKey: uuidv7() });
const detect = () => r.gateway.call(runDetectors, { body: { objectTypeId: r.type('supplier').id, detectors: ['outlier'] } }, r.cell.as(r.root));

async function until<T>(what: string, check: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const cron = (name: string, condition: Record<string, unknown>) => r.gateway.call(createCron, {
  body: {
    name, subject: { objectSetId: suppliersSet }, trigger: { schedule: '0 6 * * *' },
    condition: { kind: 'finding', detectorId: outlier, objectTypeId: r.type('supplier').id, ...condition } as never, actions: [{ kind: 'notify' }],
  },
}, keyed());

/** Runs the Cron now and waits for the run: its condition's outcome. */
async function runNow(cronId: string): Promise<string | null> {
  const before = (await r.gateway.call(listCronRuns, { params: { cronId }, query: {} }, r.cell.as(r.root))).runs.length;
  await r.gateway.call(runCronNow, { params: { cronId } }, r.cell.as(r.root));
  const runs = await until('the run', async () => {
    const all = (await r.gateway.call(listCronRuns, { params: { cronId }, query: {} }, r.cell.as(r.root))).runs;
    return all.length > before && all[0]!.status !== 'running' ? all : undefined;
  });
  assert.equal(runs[0]!.status, 'completed', JSON.stringify(runs[0]));
  return runs[0]!.conditionOutcome;
}

before(async () => {
  r = await startRecognitionCell([
    { definition: recognitionService, name: 'recognition' },
    { definition: createSchedulerService(), name: 'scheduler', env: { SCHEDULER_TICK_MS: '150' } },
  ]);
  outlier = (await r.gateway.call(listDetectors, {}, r.cell.as(r.root))).detectors.find((d) => d.key === 'outlier')!.id;
  await r.gateway.call(configureDetector, {
    params: { objectTypeId: r.type('supplier').id, detector: 'outlier' },
    body: { properties: [r.prop('supplier', 'rating')], timeField: null, enabled: true },
  }, r.cell.as(r.root));
  suppliersSet = (await r.gateway.call(saveObjectSet, {
    body: { name: 'Every supplier', definition: { kind: 'filter', base: { objectTypeId: r.type('supplier').id }, predicate: { cel: 'true', properties: [] } } },
  }, keyed())).id;
  await detect(); // Kilo's rating, raised before any Cron exists.
});

after(async () => {
  await r?.close();
});

describe('finding conditions (spec 40.3)', () => {
  test('a condition names a detector and a type the owner may see; a score bar only for score_above', async () => {
    await assert.rejects(cron('No such detector', { operator: 'raised', detectorId: uuidv7() }), { code: 'scheduler.detector_unknown' });
    await assert.rejects(cron('No such type', { operator: 'raised', objectTypeId: uuidv7() }), { code: 'scheduler.object_type_unavailable' });
    await assert.rejects(cron('No bar', { operator: 'score_above' }), { code: 'contract.request_invalid' });
  });

  test('raised: not by what was raised before the Cron; by what was raised since its last run; and only once', async () => {
    const raised = await cron('Outliers', { operator: 'raised' });
    assert.equal(raised.condition?.kind, 'finding');
    assert.deepEqual(raised.condition?.target, { detectorId: outlier, objectTypeId: r.type('supplier').id });
    const high = await cron('Strong outliers', { operator: 'score_above', threshold: 1_000_000 });
    const low = await cron('Any scored outlier', { operator: 'score_above', threshold: -1 });
    assert.equal(await runNow(raised.id), 'not_met', 'Kilo\'s finding predates the Cron');
    await detect(); // raised again
    assert.equal(await runNow(raised.id), 'met');
    assert.equal(await runNow(raised.id), 'not_met', 'nothing new since the last run');
    assert.equal(await runNow(high.id), 'not_met', 'none scores that high');
    assert.equal(await runNow(low.id), 'met');
  });

  test('recurred: not when a run raises it again straight after; when it went away and came back', async () => {
    const recurred = await cron('Recurring outliers', { operator: 'recurred' });
    await detect();
    assert.equal(await runNow(recurred.id), 'not_met', 'raised again in the next run: it never went away');
    const kilo = SUPPLIERS.find((s) => s.id === 's11')!;
    kilo.rating = 11;
    try {
      await detect(); // gone
      const current = await r.gateway.call(listFindings, { query: { objectTypeId: r.type('supplier').id, detector: 'outlier' } as never }, r.cell.as(r.root));
      assert.equal(current.findings.length, 0, 'Kilo is in line now');
    } finally {
      kilo.rating = 95;
    }
    await detect(); // back
    assert.equal(await runNow(recurred.id), 'met');
  });
});

describe('a finding-only Cron (spec 40.3: no question to author)', () => {
  const findingOnly = (name: string, extra: Record<string, unknown> = {}) => r.gateway.call(createCron, {
    body: {
      name, trigger: { schedule: '0 6 * * *' },
      condition: { kind: 'finding', operator: 'raised', detectorId: outlier, objectTypeId: r.type('supplier').id }, actions: [{ kind: 'notify' }],
      ...extra,
    } as never,
  }, keyed());

  test('with no question: finding conditions alone, on a schedule, notifying or escalating', async () => {
    await assert.rejects(findingOnly('Rows', { condition: { kind: 'result', operator: 'returned_rows' } }), { code: 'scheduler.finding_only_conditions' });
    await assert.rejects(findingOnly('Nothing to watch', { condition: undefined }), { code: 'scheduler.finding_only_conditions' });
    await assert.rejects(findingOnly('A report', { actions: [{ kind: 'report' }] }), { code: 'scheduler.finding_only_actions' });
    await assert.rejects(findingOnly('A watch', { trigger: { watch: { properties: [], windowSeconds: 60 } } }), { code: 'scheduler.watch_needs_object_set' });
  });

  test('met by a finding raised since its last check; its notification counts the findings, never values', async () => {
    const created = await findingOnly('Outliers anywhere');
    assert.deepEqual([created.savedViewId, created.connectionIds, created.condition?.kind], [null, [], 'finding']);
    assert.equal(await runNow(created.id), 'not_met', 'nothing raised since it was made');
    await detect();
    assert.equal(await runNow(created.id), 'met');
    const [run] = (await r.gateway.call(listCronRuns, { params: { cronId: created.id }, query: {} }, r.cell.as(r.root))).runs;
    assert.deepEqual(run!.actions.map((a) => [a.kind, a.outcome, a.resultCounts]), [['notify', 'delivered', { findings: 1, recipients: 1 }]]);
    assert.equal(await runNow(created.id), 'not_met', 'and only once');
  });
});
