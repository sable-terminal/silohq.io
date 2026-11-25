// Simulation end to end (spec 39): edges proposed from the ontology's link types and
// confirmed by a person (each change a graph version), failure scenarios walked
// deterministically over the confirmed graph through the executor, hard and soft paths
// kept apart, stopping at unconfirmed edges, uncleared types and the fan-out bound, runs
// charged against the simulation allowance under the request's key, and comparison.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setInferenceSettings } from '../../src/contracts/policy/inference.contract.ts';
import { runPlan, type QueryResult } from '../../src/contracts/executor/result.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import { confirmEdge, deriveEdges, listEdges, proposeEdge, reviseEdge, type EdgeView } from '../../src/contracts/simulation/graph.contract.ts';
import {
  compareRuns, copyScenario, getLatestSimulationRun, listSimulationRuns, getScenario, getSimulationRun, listScenarios, revokeScenarioShare, runScenario, saveScenario, shareScenario, type RunView,
} from '../../src/contracts/simulation/scenario.contract.ts';
import { service as simulationService } from '../../src/routes/simulation/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { startRecognitionCell, type RecognitionCell } from './recognition.helper.ts';

let r: RecognitionCell;
let edges: Record<string, EdgeView>;
const ids: Record<string, string> = {};

const days = (value: number) => ({ value, unit: 'days' as const });
const outboxEvents = async (event: string) => (await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by created_at, id`,
  [r.cell.org, event]))).rows.map((row) => row.payload);
const save = (name: string, failure: object, bounds = { hops: 4, fanOut: 1000 }) =>
  r.gateway.call(saveScenario, { body: { name, statedFailure: failure as never, bounds } }, r.cell.as(r.root));
const runIt = (scenarioId: string, idempotencyKey = uuidv7()) =>
  r.gateway.call(runScenario, { params: { scenarioId } }, { ...r.cell.as(r.root), idempotencyKey });
const reachedIds = (v: RunView, soft: boolean) => v.reached.filter((x) => x.viaSoftEdge === soft).map((x) => x.objectId).sort();

before(async () => {
  r = await startRecognitionCell([{ definition: simulationService, name: 'simulation' }]);
  // The Silo object ids of the objects the scenarios name, read as any reader would.
  const read = async (typeName: string, idProperty: string) => {
    const out = await r.cell.client('simulation').call(runPlan, {
      body: {
        plan: { schemaVersion: '1', ontologyVersionId: r.manifest.version.id, nodes: [{ objectTypeId: r.type(typeName).id, filters: [] }], hops: [],
          select: [{ node: 0, property: r.prop(typeName, idProperty) }], sort: [] },
        parameters: {}, trigger: 'structured', useCache: false,
      },
    }, r.cell.as(r.root));
    assert.equal(out.outcome, 'answer');
    for (const o of (out as { result: QueryResult }).result.page.objects) ids[String(o.values[idProperty])] = o.id;
  };
  await read('supplier', 'registration');
  await read('order', 'order_id');
  await read('delivery', 'delivery_id');
  await read('note', 'note_id');
});

after(async () => {
  await r?.close();
});

describe('the dependency graph (spec 39.2, 39.3)', () => {
  test('derivation proposes one edge per link type, never live; graph.propose is needed', async () => {
    await assert.rejects(r.gateway.call(deriveEdges, { body: {} }, r.cell.as(r.viewer)), { category: 'forbidden' });
    const out = await r.gateway.call(deriveEdges, { body: {} }, r.cell.as(r.root));
    assert.equal(out.proposed.length, 3);
    assert.ok(out.proposed.every((e) => e.status === 'proposed' && e.source === 'structure' && e.leadTime === null));
    edges = Object.fromEntries(out.proposed.map((e) => [r.manifest.linkTypes.find((l) => l.id === e.viaLinkTypeId)!.apiName, e]));
    const again = await r.gateway.call(deriveEdges, { body: {} }, r.cell.as(r.root));
    assert.equal(again.alreadyPresent, 3);
    assert.equal(again.proposed.length, 0);
    assert.equal((await r.gateway.call(listEdges, { query: {} }, r.cell.as(r.root))).graphVersion, 0, 'proposals change no version');
  });

  test('a person confirms with a kind and lead time; each change is a graph version, recorded', async () => {
    const confirm = (name: string, body: object, who = r.root) =>
      r.gateway.call(confirmEdge, { params: { edgeId: edges[name]!.id }, body: { reason: 'as we run it', version: 1, ...body } as never }, r.cell.as(who));
    await assert.rejects(confirm('supplier_orders', { kind: 'hard', leadTime: days(5) }, r.viewer), { category: 'forbidden' });
    const first = await confirm('supplier_orders', { kind: 'hard', leadTime: days(5) });
    assert.equal(first.graphVersion, 1);
    assert.equal(first.edge.status, 'confirmed');
    assert.equal(first.edge.source, 'stated', 'a structural proposal confirmed with a stated lead time');
    const second = await confirm('order_deliveries', { kind: 'soft', leadTime: days(2), buffer: days(1) });
    assert.equal(second.graphVersion, 2);
    await assert.rejects(confirm('supplier_orders', { kind: 'hard', leadTime: days(5) }), { code: 'simulation.edge_status' });
    const revised = await r.gateway.call(reviseEdge, {
      params: { edgeId: edges['supplier_orders']!.id }, body: { leadTime: days(6), reason: 'longer since September', version: 2 },
    }, r.cell.as(r.root));
    assert.equal(revised.graphVersion, 3);
    assert.deepEqual(revised.edge.leadTime, days(6));
    edges['supplier_orders'] = revised.edge;
    edges['order_deliveries'] = second.edge;
    const { rows } = await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
      'select change_kind, graph_version::int as v from simulation.edge_revisions where organisation_id = $1 order by graph_version', [r.cell.org]));
    assert.deepEqual(rows.map((x) => [x.change_kind, x.v]), [['confirmed', 1], ['confirmed', 2], ['revised', 3]]);
    assert.equal((await outboxEvents('graph_edge_confirmed')).length, 2);
  });
});

describe('failure scenarios (spec 39.4, 39.6, 39.7, 39.9)', () => {
  let scenario: string;
  let firstRun: RunView;

  test('a form is stated in full; a scenario is private', async () => {
    const failure = { form: 'unavailable', objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] };
    await assert.rejects(save('c', { ...failure, form: 'reduced_capacity' }), { code: 'contract.request_invalid' }, 'reduced capacity states the share left');
    const saved = await save('Acme fails', failure);
    scenario = saved.id;
    assert.equal(saved.graphVersion, 3);
    await assert.rejects(r.gateway.call(getScenario, { params: { scenarioId: scenario } }, r.cell.as(r.viewer)), { code: 'simulation.scenario_not_found' });
  });

  test('shared as saved views are (39.7): the holder sees it and runs it only under their own permissions; revoked, it is private again', async () => {
    const share = await r.gateway.call(shareScenario, {
      params: { scenarioId: scenario }, body: { grantee: { kind: 'membership', membershipId: r.viewer.membershipId }, access: 'run' },
    }, r.cell.as(r.root));
    assert.equal(share.state, 'live');
    assert.equal((await r.gateway.call(getScenario, { params: { scenarioId: scenario } }, r.cell.as(r.viewer))).access, 'run');
    assert.deepEqual((await r.gateway.call(listScenarios, { query: { filter: 'shared' } }, r.cell.as(r.viewer))).scenarios.map((x) => x.id), [scenario]);
    await assert.rejects(r.gateway.call(runScenario, { params: { scenarioId: scenario } }, { ...r.cell.as(r.viewer), idempotencyKey: uuidv7() }),
      { code: 'simulation.not_permitted' }, 'a run share never lends the owner\'s permissions');
    await assert.rejects(r.gateway.call(copyScenario, { params: { scenarioId: scenario }, body: { name: 'Mine' } }, r.cell.as(r.viewer)),
      { code: 'simulation.scenario_not_found' }, 'copying needs a copy share');
    const revoked = await r.gateway.call(revokeScenarioShare, { params: { scenarioId: scenario, shareId: share.id } }, r.cell.as(r.root));
    assert.equal(revoked.state, 'revoked');
    await assert.rejects(r.gateway.call(getScenario, { params: { scenarioId: scenario } }, r.cell.as(r.viewer)), { code: 'simulation.scenario_not_found' });
    assert.deepEqual((await outboxEvents('scenario_shared')).length, 2);
  });

  test('an unavailable supplier: its orders fail through the hard edge, their deliveries are late through the soft one, and the walk stops at the unconfirmed edge', async () => {
    const key = uuidv7();
    firstRun = await runIt(scenario, key);
    assert.equal(firstRun.status, 'completed');
    assert.equal(firstRun.graphVersion, 3);
    assert.equal(firstRun.charge?.operation, 'simulation');
    assert.deepEqual(reachedIds(firstRun, false), [ids['o1'], ids['o2']].sort());
    assert.ok(firstRun.reached.filter((x) => !x.viaSoftEdge).every((x) => x.effect === 'fails' && x.delay === null && x.path.length === 1));
    assert.deepEqual(reachedIds(firstRun, true), [ids['d1'], ids['d2']].sort(), 'reported apart from hard-only paths');
    const late = firstRun.reached.find((x) => x.viaSoftEdge)!;
    assert.equal(late.effect, 'delayed');
    assert.equal(late.delay, 'PT86400S', 'the soft edge\'s two days less its one-day buffer');
    assert.deepEqual(late.path.map((p) => [p.kind, p.source]), [['hard', 'stated'], ['soft', 'stated']]);
    assert.ok(!firstRun.reached.some((x) => x.objectId === ids['n1']), 'never routed across an unconfirmed edge');
    assert.deepEqual(firstRun.stopped.map((s) => s.stop), [{ reason: 'unconfirmed_edge', edgeId: edges['order_notes']!.id, objectTypeId: null, hop: null }]);
    assert.equal((await outboxEvents('simulation_crossed_unconfirmed_edge')).length, 1);

    // A retry under the same key is the same run, charged once.
    const again = await runIt(scenario, key);
    assert.equal(again.runId, firstRun.runId);
    const { rows } = await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
      'select operation, weight::text from billing.token_transactions where organisation_id = $1 and simulation_run_id = $2', [r.cell.org, firstRun.runId]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, 'simulation');
    // A result holds references only.
    const stored = await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
      'select count(*)::int as n from simulation.simulation_results where organisation_id = $1 and run_id = $2', [r.cell.org, firstRun.runId]));
    assert.equal(stored.rows[0].n, 5);
    const read = await r.gateway.call(getSimulationRun, { params: { runId: firstRun.runId } }, r.cell.as(r.root));
    assert.equal(read.reached.length, 4);
    const lineage = await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
      `select count(*)::int as n from gov.lineage_nodes where organisation_id = $1 and kind = 'simulation_result' and ref_id = $2`, [r.cell.org, firstRun.runId]));
    assert.equal(lineage.rows[0].n, 1);
    const notified = await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
      `select count(*)::int as n from workspace.notifications where organisation_id = $1 and simulation_run_id = $2`, [r.cell.org, firstRun.runId]));
    assert.equal(notified.rows[0].n, 1);
  });

  test('a re-run is charged at the re-run rate; once the graph changes, the runs compare but are not like for like', async () => {
    // The canvas overlay draws the latest run as stored (30.9), and says when the graph has changed since.
    const latest = () => r.gateway.call(getLatestSimulationRun, { params: { scenarioId: scenario } }, r.cell.as(r.root));
    assert.deepEqual([(await latest()).run?.runId, (await latest()).graphChanged], [firstRun.runId, false]);
    await r.gateway.call(confirmEdge, {
      params: { edgeId: edges['order_notes']!.id }, body: { kind: 'hard', leadTime: days(1), buffer: null, reason: 'notes follow orders', version: 1 },
    }, r.cell.as(r.root));
    const before = await latest();
    assert.deepEqual([before.run?.runId, before.graphChanged, before.graphVersion], [firstRun.runId, true, 4]);
    const second = await runIt(scenario);
    assert.deepEqual([(await latest()).run?.runId, (await latest()).graphChanged], [second.runId, false]);
    assert.equal(second.charge?.operation, 'simulation_rerun');
    assert.equal(second.graphVersion, 4);
    assert.deepEqual(second.stopped, []);
    // Both runs are listed, newest first, so any two can be compared on a later visit (D269).
    const listed = (await r.gateway.call(listSimulationRuns, { params: { scenarioId: scenario }, query: {} }, r.cell.as(r.root))).runs;
    assert.deepEqual(listed.slice(0, 2).map((x) => [x.runId, x.graphVersion, x.status]), [[second.runId, 4, 'completed'], [firstRun.runId, before.run!.graphVersion, 'completed']]);
    const compared = await r.gateway.call(compareRuns, { params: { scenarioId: scenario }, query: { from: firstRun.runId, to: second.runId } }, r.cell.as(r.root));
    assert.deepEqual(compared.entered.map((x) => x.objectId), [ids['n1']]);
    assert.deepEqual(compared.left, []);
    assert.equal(compared.graphChanged, true);
    assert.equal(compared.comparable, false);
  });

  test('a delay is reduced by each buffer, and ends where a buffer absorbs it', async () => {
    const saved = await save('Acme late', { form: 'delayed', delay: { value: 12, unit: 'hours' }, objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] });
    const out = await runIt(saved.id);
    assert.deepEqual(reachedIds(out, false).sort(), [ids['n1'], ids['o1'], ids['o2']].sort());
    assert.ok(out.reached.every((x) => x.effect === 'delayed' && x.delay === 'PT43200S'));
    assert.deepEqual(reachedIds(out, true), [], 'the one-day buffer absorbs twelve hours');
  });

  test('fan-out past the bound stops and names the hop; nothing is kept in part', async () => {
    const saved = await save('Acme, narrow', { form: 'unavailable', objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] }, { hops: 4, fanOut: 1 });
    const out = await runIt(saved.id);
    assert.equal(out.boundedAtHop, 1);
    assert.deepEqual(out.reached, []);
    assert.deepEqual(out.stopped.map((s) => s.stop), [{ reason: 'bounded_hop', edgeId: null, objectTypeId: null, hop: 1 }]);
    assert.equal((await outboxEvents('simulation_bounded')).length, 1);
  });

  test('an object type the runner is not cleared for stops the walk at that edge', async () => {
    const { id: marking } = await r.gateway.call(createMarking, { body: { name: 'Logistics', kind: 'classification' } }, r.cell.as(r.root));
    await r.gateway.call(applyMarking, { body: { markingId: marking, resource: { type: 'object_type', id: r.type('delivery').id } } }, r.cell.as(r.root));
    const out = await runIt(scenario);
    assert.deepEqual(reachedIds(out, true), []);
    assert.ok(out.stopped.some((s) => s.stop?.reason === 'uncleared_object_type' && s.stop.objectTypeId === r.type('delivery').id));
  });

  test('past the allowance a run is refused with the bound named, and the run is recorded as failed', async () => {
    // Used so far: 1 + 0.5 + 0.5 (Acme fails), 1 (late), 1 (narrow) = 4 of 5.
    const saved = await save('Brill fails', { form: 'unavailable', objectTypeId: r.type('supplier').id, objectIds: [ids['R02']] });
    await runIt(saved.id);
    const another = await save('Cobalt fails', { form: 'unavailable', objectTypeId: r.type('supplier').id, objectIds: [ids['R03']] });
    await assert.rejects(runIt(another.id), (error: { category?: string; details?: Record<string, unknown> }) =>
      error.category === 'bounds' && error.details?.['bound'] === 'simulation_allowance');
    const { rows } = await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
      `select status from simulation.simulation_runs where organisation_id = $1 and scenario_id = $2`, [r.cell.org, another.id]));
    assert.deepEqual(rows.map((x) => x.status), ['failed']);
  });
});

describe('probabilistic propagation (spec 39.5)', () => {
  test('probabilistic: a path whose every edge has observations is sampled from them; one crossing a stated edge is computed deterministically and says so (39.5)', async () => {
    // The scenarios above spent the allowance and marked deliveries; this one is paid from purchased simulations by a cleared runner.
    await r.cell.migrate.query(`insert into billing.token_balances (id, organisation_id, membership_id, simulations_purchased_remaining)
      values ($1, $2, $3, 10) on conflict (organisation_id, membership_id) do update set simulations_purchased_remaining = 10`,
    [uuidv7(), r.cell.org, r.root.membershipId]);
    const { rows: [marking] } = await r.cell.migrate.query(`select id from gov.markings where organisation_id = $1 and name = 'Logistics'`, [r.cell.org]);
    await r.gateway.call(grantClearance, { body: { markingId: marking.id, holder: { kind: 'membership', id: r.root.membershipId } } }, r.cell.as(r.root));
    const soft = edges['order_deliveries']!;
    // As an observed lead time leaves it: source history, its observations (one to three days) kept on the edge.
    const samples = Array.from({ length: 40 }, (_, i) => (1 + (i % 3)) * 86_400);
    await r.cell.migrate.query(`update simulation.dependency_edges set source = 'history',
      evidence_ref = jsonb_build_object('history', jsonb_build_object('samples', $2::jsonb)) where id = $1`, [soft.id, JSON.stringify(samples)]);
    try {
      const probabilistic = (name: string, failure: object) => r.gateway.call(saveScenario, {
        body: { name, statedFailure: failure as never, mode: 'probabilistic', bounds: { hops: 2, fanOut: 100, iterations: 500 } },
      }, r.cell.as(r.root));
      const fromOrder = await runIt((await probabilistic('o1 fails', { form: 'unavailable', objectTypeId: r.type('order').id, objectIds: [ids['o1']] })).id);
      assert.deepEqual([fromOrder.mode, fromOrder.iterations], ['probabilistic', 500]);
      assert.match(fromOrder.statement ?? '', /sampled independently/);
      const d1 = fromOrder.reached.find((x) => x.objectId === ids['d1'])!;
      assert.equal(d1.pathMode, 'probabilistic');
      assert.equal(d1.probability, 1, 'a soft edge from a failure always delays');
      assert.ok(d1.probabilityInterval![0] > 0.99 && d1.probabilityInterval![1] > 0.999, 'its credible interval, from the iterations');
      assert.ok(d1.spread !== null && d1.spread.p10 !== null && d1.spread.p90 !== null);
      assert.ok(Number(/\d+/.exec(d1.spread.p90!)![0]) <= 2 * 86_400, 'never beyond the longest observation less the buffer');
      assert.deepEqual(d1.path.map((p) => [p.source, p.sampleSize]), [['history', 40]]);

      const fromSupplier = await runIt((await probabilistic('R01 fails', { form: 'unavailable', objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] })).id);
      const late = fromSupplier.reached.find((x) => x.objectId === ids['d1'])!;
      assert.deepEqual([late.pathMode, late.probability, late.spread], ['deterministic', null, null], 'the hard edge has no observations: computed from stated lead times');
      assert.deepEqual([fromSupplier.inferred, fromSupplier.inferenceStatement], [false, null], 'inference is off unless the organisation turns it on');
      assert.deepEqual(late.path.map((p) => [p.source, p.sampleSize]), [['stated', null], ['history', 40]]);

      // The organisation turns simulation inference on (D72): the same path is simulated from beliefs, and says so.
      await r.gateway.call(setInferenceSettings, { body: { simulation: true } }, r.cell.as(r.root));
      try {
        const inferred = await runIt((await probabilistic('R01 fails, inferred', { form: 'unavailable', objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] })).id);
        assert.equal(inferred.inferred, true);
        assert.match(inferred.inferenceStatement ?? '', /stated lead time as the median/);
        const lateInferred = inferred.reached.find((x) => x.objectId === ids['d1'])!;
        assert.equal(lateInferred.pathMode, 'inferred');
        assert.ok(lateInferred.probability !== null && lateInferred.spread !== null && lateInferred.probabilityInterval !== null);
      } finally {
        await r.gateway.call(setInferenceSettings, { body: { simulation: false } }, r.cell.as(r.root));
      }
    } finally {
      await r.cell.migrate.query(`update simulation.dependency_edges set source = 'stated', evidence_ref = null where id = $1`, [soft.id]);
    }
  });
});

describe('unavailable for a period (decision 2026-11-14)', () => {
  test('each dependant is out for the longer of the outage and its recovery lead time; soft dependants are late by that less their buffer', async () => {
    const short = await save('Acme out two days', { form: 'unavailable_for_period', period: days(2), objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] });
    const shortRun = await runIt(short.id);
    const orders = shortRun.reached.filter((x) => !x.viaSoftEdge && [ids['o1'], ids['o2']].includes(x.objectId!));
    assert.equal(orders.length, 2);
    assert.ok(orders.every((x) => x.effect === 'fails' && x.unavailableFor === 'PT518400S'), 'the six-day recovery outlasts a two-day outage');
    const notes = shortRun.reached.filter((x) => !x.viaSoftEdge && x.path.length === 2);
    assert.ok(notes.length > 0 && notes.every((x) => x.unavailableFor === 'PT518400S'), 'carried on past the order: its one-day recovery is shorter');
    assert.ok(shortRun.reached.filter((x) => x.viaSoftEdge).every((x) => x.effect === 'delayed' && x.delay === 'PT432000S'), 'six days less the one-day buffer');

    const long = await save('Acme out ten days', { form: 'unavailable_for_period', period: days(10), objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] });
    const longRun = await runIt(long.id);
    assert.ok(longRun.reached.filter((x) => !x.viaSoftEdge).every((x) => x.unavailableFor === 'PT864000S'), 'the outage outlasts every recovery');
    await assert.rejects(save('No period', { form: 'unavailable_for_period', objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] }));
  });
});

describe('resources and capacity (decision 2026-11-14)', () => {
  test('a supplier left half its capacity cannot meet its orders\' demand: each order is constrained by the share unmet', async () => {
    const proposed = await r.gateway.call(proposeEdge, {
      body: { fromObjectTypeId: r.type('supplier').id, toObjectTypeId: r.type('order').id, viaLinkTypeId: edges['supplier_orders']!.viaLinkTypeId, kind: 'resource' },
    }, r.cell.as(r.root));
    await assert.rejects(r.gateway.call(confirmEdge, { params: { edgeId: proposed.id }, body: { kind: 'resource', leadTime: days(1), reason: 'shared line', version: 1 } },
      r.cell.as(r.root)));
    await assert.rejects(r.gateway.call(confirmEdge, { params: { edgeId: proposed.id }, body: {
      kind: 'resource', leadTime: days(1), reason: 'shared line', version: 1,
      capacity: { consumption: 1, capacityPropertyId: r.prop('supplier', 'email'), demandPropertyId: r.prop('order', 'units'), period: 'day' },
    } }, r.cell.as(r.root)), { code: 'simulation.capacity_properties' });
    const confirmed = await r.gateway.call(confirmEdge, { params: { edgeId: proposed.id }, body: {
      kind: 'resource', leadTime: days(1), reason: 'the supplier\'s line makes ten units a day', version: 1,
      capacity: { consumption: 1, capacityPropertyId: r.prop('supplier', 'rating'), demandPropertyId: r.prop('order', 'units'), period: 'day' },
    } }, r.cell.as(r.root));
    assert.deepEqual(confirmed.edge.capacity?.period, 'day');

    // Acme (rating 10) has orders o1 (4 units) and o2 (3): demand 7. Half its capacity leaves 5: 2 of 7 unmet.
    const half = await save('Acme at half capacity', { form: 'reduced_capacity', capacityRemaining: 0.5, objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] });
    const halfRun = await runIt(half.id);
    const constrained = halfRun.reached.filter((x) => x.effect === 'constrained');
    assert.deepEqual(constrained.map((x) => x.objectId).sort(), [ids['o1'], ids['o2']].sort());
    assert.ok(constrained.every((x) => x.shortfall === 0.2857 && x.period === 'day' && x.path[0]!.kind === 'resource'));

    const most = await save('Acme at nine tenths', { form: 'reduced_capacity', capacityRemaining: 0.9, objectTypeId: r.type('supplier').id, objectIds: [ids['R01']] });
    assert.equal((await runIt(most.id)).reached.filter((x) => x.effect === 'constrained').length, 0, 'nine units cover seven');
  });
});
