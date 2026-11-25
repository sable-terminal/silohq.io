// Analysis over object sets (spec 37.8, 37.10): a chain built by hand from typed steps (a fresh set,
// a filter, a traversal, a group, a select back to the objects behind one group, a further
// traversal, a comparison of two sets), kept as an analysis manifest with its values sealed, run
// step by step under each step's bound, refused at the first step that exceeds its bound (naming
// the step, the bound and the count, the steps before it kept), and saved as a view of kind analysis.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { AnalysisStepInput } from '../../src/contracts/compile/analysis.contract.ts';
import { readResult } from '../../src/contracts/executor/result.contract.ts';
import { createAnalysis, readAnalysis, runAnalysis } from '../../src/contracts/workspace/analysis.contract.ts';
import { queryPlan, type QueryPlanInput } from '../../src/contracts/planner/plan.contract.ts';
import { stepsOfPlan } from '../../src/services/compile/analysis.service.ts';
import { runView, saveView } from '../../src/contracts/workspace/view.contract.ts';
import { service as compileService } from '../../src/routes/compile/index.route.ts';
import { createWorkspaceService } from '../../src/routes/workspace/index.route.ts';
import { startRecognitionCell, type RecognitionCell } from './recognition.helper.ts';

let r: RecognitionCell;

before(async () => {
  r = await startRecognitionCell([
    { definition: compileService, name: 'compile' },
    { definition: createWorkspaceService(), name: 'workspace' },
  ]);
});

after(async () => {
  await r?.close();
});

const chain = (orderBound = 10_000): AnalysisStepInput[] => [
  { operation: 'filter', base: { objectTypeId: r.type('supplier').id }, filters: [{ property: r.prop('supplier', 'region'), op: 'eq', value: { param: 'p1' } }] },
  { operation: 'traverse', input: 1, linkTypeId: r.link('supplier_orders').id, show: [r.prop('order', 'units')], bound: orderBound },
  { operation: 'group', input: 2, groupBy: [{ property: r.prop('order', 'supplier_id') }], measures: [{ fn: 'sum', property: r.prop('order', 'units'), as: 'units' }] },
  { operation: 'select', input: 3, key: [{ property: r.prop('order', 'supplier_id'), value: { param: 'p2' } }] },
  { operation: 'traverse', input: 4, linkTypeId: r.link('order_deliveries').id },
  { operation: 'compare', inputs: [2, 4], measures: [{ fn: 'count', as: 'orders' }] },
];
const values = { p1: 'north', p2: 's01' };

describe('analysis over object sets (spec 37.8)', () => {
  let analysisId: string;
  let manifestId: string;

  test('a chain kept as an analysis manifest; its values only for the person who bound them', async () => {
    const made = await r.gateway.call(createAnalysis, { body: { steps: chain(), parameters: values } }, r.cell.as(r.root));
    assert.equal(made.outcome, 'analysis', JSON.stringify(made).slice(0, 400));
    if (made.outcome !== 'analysis') return;
    ({ analysisId, manifestId } = made);
    assert.deepEqual(made.steps.map((s) => [s.position, s.operation, s.outputKind, s.inputSteps]), [
      [1, 'filter', 'object_set', []], [2, 'traverse', 'object_set', [1]], [3, 'group', 'result', [2]],
      [4, 'select', 'object_set', [3]], [5, 'traverse', 'object_set', [4]], [6, 'compare', 'result', [2, 4]],
    ]);
    const { rows } = await r.cell.migrate.query(
      `select m.kind, m.compile_class, (select count(*)::int from workspace.analysis_steps s where s.manifest_id = m.id) as steps
         from ontology.compiled_manifests m where m.id = $1`, [manifestId]);
    assert.deepEqual(rows[0], { kind: 'analysis', compile_class: 'standard', steps: 6 }, 'built by hand: standard, and never metered');
    const mine = await r.gateway.call(readAnalysis, { params: { manifestId }, query: { analysisId } }, r.cell.as(r.root));
    assert.deepEqual(mine.parameters, values);
    const theirs = await r.gateway.call(readAnalysis, { params: { manifestId }, query: { analysisId } }, r.cell.as(r.editor));
    assert.equal(theirs.parameters, null, 'the values stay with the person who bound them');
  });

  test('run step by step: north suppliers, their orders, units by supplier, the orders behind one, their deliveries, two sets compared', async () => {
    const ran = await r.gateway.call(runAnalysis, { params: { manifestId }, body: { analysisId } }, r.cell.as(r.root));
    assert.ok(ran.steps.every((s) => s.outcome === 'result'), JSON.stringify(ran.steps).slice(0, 600));
    const totals = ran.steps.map((s) => (s.outcome === 'result' ? s.results.map((x) => x.total) : []));
    assert.deepEqual(totals[1], [3], 'o1 and o2 from s01, o4 from s03');
    assert.deepEqual(totals[2], [2], 'two north suppliers have orders');
    assert.deepEqual(totals[3], [2], 'the orders behind s01');
    assert.deepEqual(totals[4], [2], 'o1\'s two deliveries; o2 has none');
    assert.deepEqual(totals[5], [1, 1], 'a comparison is two results, each run separately');
    const step = (n: number) => ran.steps[n - 1] as Extract<typeof ran.steps[number], { outcome: 'result' }>;
    const groups = await r.gateway.call(readResult, { params: { queryId: step(3).results[0]!.queryId } }, r.cell.as(r.root));
    assert.deepEqual(groups.page.groups.map((g) => [g.key['supplier_id'], g.measures['units']]), [['s01', 7], ['s03', 2]], 'largest first');
    const compared = await Promise.all(step(6).results.map((x) => r.gateway.call(readResult, { params: { queryId: x.queryId } }, r.cell.as(r.root))));
    assert.deepEqual(compared.map((c) => c.page.groups[0]!.measures['orders']), [3, 2], 'all their orders against the orders behind s01');
    const upTo = await r.gateway.call(runAnalysis, { params: { manifestId }, body: { analysisId, upTo: 2 } }, r.cell.as(r.root));
    assert.deepEqual(upTo.steps.map((s) => s.position), [1, 2], 'a builder looking at one step runs only so far');
  });

  test('a step over its bound is refused naming the step, the bound and the count; the steps before it keep their results, the rest do not run', async () => {
    const made = await r.gateway.call(createAnalysis, { body: { steps: chain(2), parameters: values } }, r.cell.as(r.root));
    assert.equal(made.outcome, 'analysis');
    if (made.outcome !== 'analysis') return;
    const ran = await r.gateway.call(runAnalysis, { params: { manifestId: made.manifestId }, body: { analysisId: made.analysisId } }, r.cell.as(r.root));
    assert.deepEqual(ran.steps.map((s) => s.outcome), ['result', 'refused', 'not_run', 'not_run', 'not_run', 'not_run']);
    const refused = ran.steps[1] as Extract<typeof ran.steps[number], { outcome: 'refused' }>;
    assert.equal(refused.refusal.code, 'analysis.step_bound');
    assert.deepEqual(refused.refusal.bound, { name: 'step_members', limit: 2, observed: 3 });
    assert.match(refused.refusal.reason, /^step 2 \(traverse\) has 3 members, over its bound of 2/);

    // Saved as a view of kind analysis, it is refused the same way, naming the step (37.10).
    const view = await r.gateway.call(saveView, { body: { kind: 'analysis', name: 'Bounded', manifestId: made.manifestId, fromBindingId: made.analysisId } }, r.keyed(r.root));
    const viewRun = await r.gateway.call(runView, { params: { viewId: view.id } }, r.cell.as(r.root));
    assert.equal(viewRun.run.outcome, 'refused');
    if (viewRun.run.outcome !== 'refused') return;
    assert.deepEqual([viewRun.run.reason, viewRun.run.step, viewRun.run.bound], ['bound_exceeded', { position: 2, operation: 'traverse' }, { name: 'step_members', limit: 2, observed: 3 }]);
  });

  test('a view of kind analysis runs with its own copy of the values; one ending in a comparison carries both sides', async () => {
    const view = await r.gateway.call(saveView, { body: { kind: 'analysis', name: 'North orders', manifestId, fromBindingId: analysisId } }, r.keyed(r.root));
    assert.equal(view.kind, 'analysis');
    const ran = await r.gateway.call(runView, { params: { viewId: view.id } }, r.cell.as(r.root));
    assert.equal(ran.run.outcome, 'result');
    if (ran.run.outcome !== 'result') return;
    assert.ok(ran.run.comparedRef !== undefined, 'the other side of the comparison');
    await assert.rejects(r.gateway.call(saveView, { body: { kind: 'analysis', name: 'Not mine', manifestId, fromBindingId: analysisId } }, r.keyed(r.editor)),
      { code: 'workspace.plan_not_found' }, 'never from someone else\'s values');
  });

  test('a chain that cannot be planned is refused naming its step', async () => {
    const reads = (steps: AnalysisStepInput[]) => r.gateway.call(createAnalysis, { body: { steps, parameters: values } }, r.cell.as(r.root));
    const later = await reads([{ operation: 'traverse', input: 1, linkTypeId: r.link('supplier_orders').id }]);
    assert.deepEqual(later.outcome === 'refusal' ? [later.refused.position, later.refused.refusal.code] : later.outcome, [1, 'analysis.input_later']);
    const notLinked = await reads([
      { operation: 'filter', base: { objectTypeId: r.type('supplier').id } },
      { operation: 'traverse', input: 1, linkTypeId: r.link('order_deliveries').id },
    ]);
    assert.deepEqual(notLinked.outcome === 'refusal' ? [notLinked.refused.position, notLinked.refused.refusal.code] : notLinked.outcome, [2, 'analysis.link_not_from_set']);
    const fromResult = await reads([
      { operation: 'filter', base: { objectTypeId: r.type('order').id } },
      { operation: 'group', input: 1, measures: [{ fn: 'count', as: 'n' }] },
      { operation: 'traverse', input: 2, linkTypeId: r.link('order_deliveries').id },
    ]);
    assert.deepEqual(fromResult.outcome === 'refusal' ? [fromResult.refused.position, fromResult.refused.refusal.code] : fromResult.outcome, [3, 'analysis.input_not_set']);
    const notTime = await reads([
      { operation: 'filter', base: { objectTypeId: r.type('order').id } },
      { operation: 'time_series', input: 1, property: r.prop('order', 'units'), unit: 'month', measures: [{ fn: 'count', as: 'n' }] },
    ]);
    assert.deepEqual(notTime.outcome === 'refusal' ? [notTime.refused.position, notTime.refused.refusal.code] : notTime.outcome, [2, 'plan.bucket_type'], 'the planner\'s refusal, naming the step');
  });
});

describe('an answer\'s plan as steps (spec 37.8)', () => {
  const u = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const plan = (body: Omit<QueryPlanInput, 'schemaVersion' | 'ontologyVersionId'>) => queryPlan.parse({ schemaVersion: '1', ontologyVersionId: u(1), ...body });
  const open = { property: u(30), op: 'eq' as const, value: { param: 'p1' } };

  test('the deepest filtered type first, each link followed back to the answer\'s objects, then its aggregate; a limit said not kept', () => {
    const out = stepsOfPlan(plan({
      nodes: [{ objectTypeId: u(10) }, { objectTypeId: u(11), filters: [open] }],
      hops: [{ from: 0, to: 1, linkTypeId: u(20), routeId: u(21) }],
      aggregate: { groupBy: [{ node: 0, property: u(31) }], measures: [{ fn: 'count', node: 0, as: 'n' }] },
      limit: 5,
    }));
    assert.ok(!('code' in out));
    if ('code' in out) return;
    assert.deepEqual(out.steps, [
      { operation: 'filter', base: { objectTypeId: u(11) }, filters: [open] },
      { operation: 'traverse', input: 1, linkTypeId: u(20), routeId: u(21), filters: [] },
      { operation: 'group', input: 2, groupBy: [{ property: u(31) }], measures: [{ fn: 'count', as: 'n' }] },
    ]);
    assert.deepEqual(out.notes, ['The answer showed the first 5; the steps keep every group, largest first, within each step\'s bound.']);
  });

  test('what is not a chain is said not to be one, and why', () => {
    const code = (p: ReturnType<typeof plan>) => { const out = stepsOfPlan(p); return 'code' in out ? out.code : 'steps'; };
    assert.equal(code(plan({
      nodes: [{ objectTypeId: u(10) }, { objectTypeId: u(11), filters: [open] }, { objectTypeId: u(12), filters: [open] }],
      hops: [{ from: 0, to: 1, linkTypeId: u(20), routeId: u(21) }, { from: 0, to: 2, linkTypeId: u(22), routeId: u(23) }],
    })), 'analysis.from_plan_branches');
    assert.equal(code(plan({
      nodes: [{ objectTypeId: u(10) }, { objectTypeId: u(11) }], hops: [{ from: 0, to: 1, linkTypeId: u(20), routeId: u(21) }],
      select: [{ node: 1, property: u(32) }],
    })), 'analysis.from_plan_unconditioned', 'a linked node only shown');
    assert.equal(code(plan({
      nodes: [{ objectTypeId: u(10) }, { objectTypeId: u(11), filters: [open] }], hops: [{ from: 0, to: 1, linkTypeId: u(20), routeId: u(21) }],
      aggregate: { groupBy: [], measures: [{ fn: 'sum', node: 1, property: u(33), as: 'spend' }] },
    })), 'analysis.from_plan_linked_measure');
  });
});

