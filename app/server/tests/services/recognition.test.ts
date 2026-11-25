// Recognition end to end (spec 38): detectors run over a real population read through the
// executor, against two systems (crm and erp, suppliers resolved by registration), with
// run states, thresholds derived and tuned by organisation dispositions, findings with
// lineage markings, links and scores, visibility, Lenses, ranking by a fake model that
// cannot introduce or uncited-rank a finding, and the runner's notification.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { setInferenceSettings } from '../../src/contracts/policy/inference.contract.ts';
import { changeConnectionStatus, getConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import {
  configureDetector, getRun, listConfigurations, listDetectors, runDetectors, type RunView,
} from '../../src/contracts/recognition/detector.contract.ts';
import {
  dispositionFinding, getFinding, listFindings, listObjectFindings, rankFindings, type FindingView,
} from '../../src/contracts/recognition/finding.contract.ts';
import { applyMarking, createMarking, grantClearance } from '../../src/contracts/policy/governance.contract.ts';
import {
  copyLens, createLens, listLenses, listSharedLenses, openLens, recordLensDisposition, revokeLensShare, shareLens,
} from '../../src/contracts/recognition/lens.contract.ts';
import { service as recognitionService } from '../../src/routes/recognition/index.route.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { startRecognitionCell, SUPPLIERS, type RecognitionCell } from './recognition.helper.ts';

let r: RecognitionCell;

const configure = (detector: string, properties: string[], extra: { timeField?: string; enabled?: boolean; version?: number } = {}, who = r.root) =>
  r.gateway.call(configureDetector, {
    params: { objectTypeId: r.type('supplier').id, detector },
    body: { properties, timeField: extra.timeField ?? null, enabled: extra.enabled ?? true, ...(extra.version ? { version: extra.version } : {}) },
  }, r.cell.as(who));
const run = (objectTypeId: string, detectors?: string[], who = r.root) =>
  r.gateway.call(runDetectors, { body: { objectTypeId, ...(detectors ? { detectors } : {}) } }, r.cell.as(who));
const byDetector = (runs: RunView[], key: string) => runs.find((x) => x.detector === key)!;
const findings = async (query: Record<string, string> = {}, who = r.root) =>
  r.gateway.call(listFindings, { query: { objectTypeId: r.type('supplier').id, ...query } as never }, r.cell.as(who));
const outboxEvents = async (event: string) => (await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by created_at, id`,
  [r.cell.org, event]))).rows.map((row) => row.payload);

before(async () => {
  r = await startRecognitionCell([{ definition: recognitionService, name: 'recognition' }]);
});

after(async () => {
  await r?.close();
});

describe('the registry and configuration (spec 38.2, 38.11)', () => {
  test('the detectors are listed with what each declares it needs', async () => {
    const { detectors } = await r.gateway.call(listDetectors, {}, r.cell.as(r.viewer));
    assert.deepEqual(detectors.map((d) => d.key).sort(),
      ['disagreement', 'drift', 'duplicate_value', 'missing_value', 'outlier', 'recurrence', 'timeliness', 'timing_deviation', 'uniqueness',
        'unmatched_record']);
    const timing = detectors.find((d) => d.key === 'timing_deviation')!;
    assert.equal(timing.executionMode, 'history');
    assert.deepEqual(timing.minimumBaseline, { amount: 30, unit: 'days' });
  });

  test('configuring needs recognition.configure; properties are named by identity and must belong to the type', async () => {
    await assert.rejects(configure('missing_value', [r.prop('supplier', 'email')], {}, r.viewer), { category: 'forbidden', code: 'recognition.not_permitted' });
    await assert.rejects(configure('missing_value', [r.prop('order', 'order_id')]), { code: 'recognition.property_unknown' });
    await assert.rejects(configure('unmatched_record', [r.prop('supplier', 'email')]), { code: 'recognition.property_not_taken' });
    const saved = await configure('missing_value', [r.prop('supplier', 'email')]);
    assert.equal(saved.version, 1);
    await assert.rejects(configure('missing_value', [r.prop('supplier', 'email')]), { code: 'recognition.configuration_exists' });
    await configure('disagreement', [r.prop('supplier', 'name')]);
    await configure('outlier', [r.prop('supplier', 'rating'), r.prop('supplier', 'region')]);
    await configure('duplicate_value', [r.prop('supplier', 'email')]);
    const { configurations } = await r.gateway.call(listConfigurations, { params: { objectTypeId: r.type('supplier').id } }, r.cell.as(r.viewer));
    assert.equal(configurations.length, 4);
    assert.equal(configurations.find((c) => c.detector === 'outlier')!.properties.length, 2);
  });
});

describe('a run (spec 38.2 to 38.4)', () => {
  let runs: RunView[];
  let first: FindingView[];

  test('every detector states what it did: ran with its population and count, or why not', async () => {
    const out = await run(r.type('supplier').id);
    runs = out.runs;
    assert.deepEqual(out.disabled, []);
    assert.equal(runs.length, 10);
    // The two named by decision 2026-11-14 need configuring first: uniqueness its properties, timeliness its time field.
    assert.deepEqual([byDetector(runs, 'uniqueness').state, byDetector(runs, 'uniqueness').stateDetail], ['not_configured', { missing: 'property', notVisible: 0 }]);
    assert.deepEqual([byDetector(runs, 'timeliness').state, byDetector(runs, 'timeliness').stateDetail], ['not_configured', { missing: 'time_field' }]);
    for (const key of ['disagreement', 'missing_value', 'outlier', 'duplicate_value', 'unmatched_record']) {
      assert.equal(byDetector(runs, key).state, 'ran', key);
      assert.equal(byDetector(runs, key).populationCount, SUPPLIERS.length, key);
    }
    assert.equal(byDetector(runs, 'disagreement').findingsCount, 5, 'five suppliers whose two systems disagree on the name');
    assert.equal(byDetector(runs, 'missing_value').findingsCount, 1, 'Kilo has no email; eleven of twelve do');
    assert.equal(byDetector(runs, 'outlier').findingsCount, 1, 'Kilo\'s rating; region is not numeric');
    assert.deepEqual(byDetector(runs, 'outlier').properties, ['rating', 'region']);
    assert.equal(byDetector(runs, 'duplicate_value').findingsCount, 1, 'India and Juliet share an email');
    assert.equal(byDetector(runs, 'unmatched_record').findingsCount, 1, 'Lima has no registration, so it stands alone');
    // A history detector needs the property it examines first, and Capture after that (tests/services/siloes.test.ts).
    for (const key of ['timing_deviation', 'drift', 'recurrence']) {
      assert.equal(byDetector(runs, key).state, 'not_configured', key);
      assert.deepEqual(byDetector(runs, key).stateDetail, { missing: 'property', notVisible: 0 });
      assert.equal(byDetector(runs, key).findingsCount, 0);
    }
    const again = await r.gateway.call(getRun, { params: { runId: byDetector(runs, 'outlier').runId } }, r.cell.as(r.root));
    assert.equal(again.findingsCount, 1);
  });

  test('a finding holds identifiers and statistics, never a record value', async () => {
    first = (await findings()).findings;
    assert.equal(first.length, 9);
    const text = JSON.stringify(first);
    for (const s of SUPPLIERS) {
      assert.ok(!text.includes(s.name), 'no name');
      if (s.email) assert.ok(!text.includes(s.email), 'no email');
    }
    assert.ok(!/[:[,]95(\.0+)?[,\]}]/.test(text), 'no rating, as a number anywhere');
    const outlier = first.find((f) => f.detector === 'outlier')!;
    assert.equal(outlier.computation.statistic, 'robust_z');
    assert.equal(outlier.computation.threshold, 5, 'a population under 30 derives the stricter bound');
    assert.ok(outlier.computation.value >= 5);
    assert.equal(outlier.computation.population, 12);
    assert.deepEqual(outlier.properties, ['rating']);
    assert.deepEqual(outlier.connectionIds, [r.crm]);
    const duplicate = first.find((f) => f.detector === 'duplicate_value')!;
    assert.equal(duplicate.objectIds.length, 2);
    assert.equal(duplicate.computation.value, 2);
    const disagreement = first.find((f) => f.detector === 'disagreement')!;
    assert.deepEqual(disagreement.connectionIds.sort(), [r.crm, r.erp].sort());
    assert.equal(disagreement.coverage.disputed, 5);
  });

  test('findings about the same object are linked, both ways; each is a lineage artefact', async () => {
    const outlier = first.find((f) => f.detector === 'outlier')!;
    const missing = first.find((f) => f.detector === 'missing_value')!;
    assert.deepEqual(outlier.objectIds, missing.objectIds, 'both are about Kilo');
    assert.ok(outlier.links.some((l) => l.findingId === missing.id && l.sharedObjects === 1));
    assert.ok(missing.links.some((l) => l.findingId === outlier.id));
    const { rows } = await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
      `select count(*)::int as n from gov.lineage_nodes n join gov.lineage_edges e on e.organisation_id = n.organisation_id and e.to_node_id = n.id
        where n.organisation_id = $1 and n.kind = 'finding' and n.ref_id = $2`, [r.cell.org, outlier.id]));
    assert.equal(rows[0].n, 2, 'derived from the object type version, read via crm');
    const panel = await r.gateway.call(listObjectFindings, { params: { objectTypeId: r.type('supplier').id, objectId: outlier.objectIds[0]! }, query: {} },
      r.cell.as(r.root));
    assert.deepEqual(panel.findings.map((f) => f.detector).sort(), ['missing_value', 'outlier']);
  });

  test('the same inputs give the same findings; a later run supersedes the earlier', async () => {
    const out = await run(r.type('supplier').id, ['outlier', 'disagreement']);
    const now = (await findings()).findings;
    const outliers = now.filter((f) => f.detector === 'outlier');
    assert.equal(outliers.length, 1);
    const before = first.find((f) => f.detector === 'outlier')!;
    assert.notEqual(outliers[0]!.id, before.id, 'a new finding, from a new run');
    assert.equal(outliers[0]!.runId, byDetector(out.runs, 'outlier').runId);
    assert.deepEqual(outliers[0]!.computation, before.computation);
    assert.deepEqual(outliers[0]!.objectIds, before.objectIds);
    const old = await r.gateway.call(getFinding, { params: { findingId: before.id }, query: {} }, r.cell.as(r.root));
    assert.equal(old.current, false);
    const all = await findings({ includeSuperseded: 'true' });
    assert.ok(all.findings.length > now.length);
    const events = await outboxEvents('finding_raised');
    assert.ok(events.length >= 11);
    assert.ok(events.every((e) => !JSON.stringify(e).includes('Kilo')));
  });

  test('the runner is told of the run, once, on Home', async () => {
    const { rows } = await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
      `select count(*)::int as n from workspace.notifications where organisation_id = $1 and recipient_membership_id = $2 and kind = 'finding_new'`,
      [r.cell.org, r.root.membershipId]));
    assert.ok(rows[0].n >= 5 && rows[0].n <= 7, 'one per run that raised something');
  });

  test('a disabled detector is not run; a detector the runner cannot see the properties of is not configured for them', async () => {
    const { configurations } = await r.gateway.call(listConfigurations, { params: { objectTypeId: r.type('supplier').id } }, r.cell.as(r.root));
    const dup = configurations.find((c) => c.detector === 'duplicate_value')!;
    await configure('duplicate_value', dup.properties, { enabled: false, version: dup.version });
    const out = await run(r.type('supplier').id, ['duplicate_value', 'unmatched_record']);
    assert.deepEqual(out.disabled, ['duplicate_value']);
    assert.deepEqual(out.runs.map((x) => x.detector), ['unmatched_record']);
  });
});

describe('visibility (spec 38.11)', () => {
  test('a finding whose markings the reader does not hold is withheld, counted, never described', async () => {
    const { id: marking } = await r.gateway.call(createMarking, { body: { name: 'Restricted suppliers', kind: 'classification' } }, r.cell.as(r.root));
    for (const who of [r.root, r.editor]) {
      await r.gateway.call(grantClearance, { body: { markingId: marking, holder: { kind: 'membership', id: who.membershipId } } }, r.cell.as(r.root));
    }
    await r.gateway.call(applyMarking, { body: { markingId: marking, resource: { type: 'object_type', id: r.type('supplier').id } } }, r.cell.as(r.root));
    const out = await run(r.type('supplier').id, ['unmatched_record']);
    const fresh = (await findings({ detector: 'unmatched_record' })).findings;
    assert.equal(fresh.length, 1);
    assert.ok(fresh[0]!.markingIds.includes(marking), 'inherited from the object type through lineage');
    assert.equal(fresh[0]!.runId, out.runs[0]!.runId);
    const seen = await findings({ detector: 'unmatched_record' }, r.viewer);
    assert.equal(seen.findings.length, 0);
    assert.ok(seen.withheld >= 1);
    await assert.rejects(r.gateway.call(getFinding, { params: { findingId: fresh[0]!.id }, query: {} }, r.cell.as(r.viewer)), { code: 'recognition.finding_not_found' });
  });
});

describe('dispositions and thresholds (spec 38.5, 38.9)', () => {
  test('an organisation disposition needs finding.disposition; a stale version is refused', async () => {
    const f = (await findings({ detector: 'disagreement' })).findings[0]!;
    await assert.rejects(r.gateway.call(dispositionFinding, { params: { findingId: f.id }, body: { disposition: 'dismissed', version: 1 } }, r.cell.as(r.viewer)));
    await assert.rejects(r.gateway.call(dispositionFinding, { params: { findingId: f.id }, body: { disposition: 'dismissed', version: 99 } }, r.cell.as(r.root)),
      { code: 'recognition.finding_stale' });
  });

  test('a Lens dismissal silences a finding for its owner only, and never tunes', async () => {
    const lens = await r.gateway.call(createLens, { body: { name: 'Mine', workingSets: [] } }, r.cell.as(r.root));
    const f = (await findings({ detector: 'disagreement' })).findings[0]!;
    await r.gateway.call(recordLensDisposition, { params: { lensId: lens.id, findingId: f.id }, body: { disposition: 'dismissed' } }, r.cell.as(r.root));
    const through = await findings({ detector: 'disagreement', lensId: lens.id });
    assert.equal(through.silenced, 1);
    assert.ok(!through.findings.some((x) => x.id === f.id));
    assert.ok((await findings({ detector: 'disagreement' })).findings.some((x) => x.id === f.id), 'still there without the Lens');
    const { lenses } = await r.gateway.call(listLenses, {}, r.cell.as(r.root));
    assert.equal(lenses.find((l) => l.id === lens.id)!.dispositions.dismissed, 1);
    await assert.rejects(r.gateway.call(listFindings, { query: { lensId: lens.id } as never }, r.cell.as(r.editor)), { code: 'recognition.lens_not_found' });
  });

  test('a shared Lens opens under the recipient\'s own access; view does not copy; revoking ends it (decision 2026-11-14)', async () => {
    const some = (await findings({ detector: 'disagreement' })).findings.slice(0, 2).map((x) => x.id);
    const lens = await r.gateway.call(createLens, { body: { name: 'To share', workingSets: [{ kind: 'findings', name: 'Watch', findingIds: some }] } },
      r.cell.as(r.root));
    const keyed = { ...r.cell.as(r.root), idempotencyKey: uuidv7() };
    const shared = await r.gateway.call(shareLens, { params: { lensId: lens.id }, body: { grantee: { kind: 'membership', membershipId: r.editor.membershipId }, access: 'view' } }, keyed);
    assert.equal(shared.coverage.recipients, 1);
    const opened = await r.gateway.call(openLens, { params: { lensId: lens.id } }, r.cell.as(r.editor));
    assert.equal(opened.access, 'view');
    const seen = opened.workingSets[0]!.kind === 'findings' ? opened.workingSets[0]!.findingIds.length : 0;
    assert.equal(seen + opened.hidden, some.length, 'what is hidden is dropped and counted');
    assert.equal(shared.coverage.lowest, Math.round((seen / some.length) * 10_000) / 10_000, 'coverage at share is what the recipient sees');
    assert.equal(opened.statement === null, opened.hidden === 0);
    assert.deepEqual((await r.gateway.call(listSharedLenses, {}, r.cell.as(r.editor))).lenses.map((l) => l.id), [lens.id]);
    await assert.rejects(r.gateway.call(copyLens, { params: { lensId: lens.id }, body: { name: 'Mine now' } }, { ...r.cell.as(r.editor), idempotencyKey: uuidv7() }),
      { code: 'recognition.lens_copy_not_shared' });
    await assert.rejects(r.gateway.call(listFindings, { query: { lensId: lens.id } as never }, r.cell.as(r.editor)), { code: 'recognition.lens_not_found' },
      'view does not apply the Lens');
    await r.gateway.call(revokeLensShare, { params: { shareId: shared.share.id } }, r.cell.as(r.root));
    await assert.rejects(r.gateway.call(openLens, { params: { lensId: lens.id } }, r.cell.as(r.editor)), { code: 'recognition.lens_not_found' });
    assert.equal((await outboxEvents('lens_shared')).length, 1);
  });

  test('four dismissals move nothing; the fifth raises the threshold by at most a quarter, audited with its evidence', async () => {
    const current = (await findings({ detector: 'disagreement' })).findings;
    assert.equal(current.length, 5);
    for (let i = 0; i < 4; i += 1) {
      const out = await r.gateway.call(dispositionFinding, { params: { findingId: current[i]!.id }, body: { disposition: 'dismissed', version: 1 } }, r.cell.as(r.root));
      assert.equal(out.tuned, null, 'under the five-decision floor');
      assert.equal(out.finding.orgDisposition, 'dismissed');
    }
    const fifth = await r.gateway.call(dispositionFinding, { params: { findingId: current[4]!.id }, body: { disposition: 'dismissed', version: 1 } }, r.cell.as(r.root));
    // Five of five dismissed: the posterior is sure of the majority, and moves it less than the quarter cap (decision 2026-11-11).
    assert.deepEqual(fifth.tuned, { from: 1, to: 1.1786 });
    const [event] = await outboxEvents('threshold_tuned');
    assert.equal(event.detail.dismissed, 5);
    assert.equal(event.detail.from, 1);
    assert.equal(event.detail.to, 1.1786);
    // One disputed property no longer reaches the tuned threshold.
    const out = await run(r.type('supplier').id, ['disagreement']);
    assert.equal(out.runs[0]!.findingsCount, 0);
  });

  test('where the organisation turns inference on, a finding says how often its kind proved useful (D73)', async () => {
    const [before] = (await findings({ detector: 'disagreement', includeSuperseded: 'true' })).findings;
    assert.equal(before!.usefulness, null, 'off by default');
    await r.gateway.call(setInferenceSettings, { body: { findings: true } }, r.cell.as(r.root));
    try {
      const [after] = (await findings({ detector: 'disagreement', includeSuperseded: 'true' })).findings;
      assert.deepEqual([after!.usefulness?.confirmed, after!.usefulness?.dismissed], [0, 5]);
      assert.equal(after!.usefulness?.probability, Math.round((1 / 7) * 10_000) / 10_000, 'none of five confirmed: about one in seven, not zero');
      assert.match(after!.usefulness?.statement ?? '', /computed fact/);
    } finally {
      await r.gateway.call(setInferenceSettings, { body: { findings: false } }, r.cell.as(r.root));
    }
  });
});

describe('ranking (spec 38.7)', () => {
  test('the model orders what the reader sees; it cannot introduce, leave uncited or repeat a finding', async () => {
    await run(r.type('supplier').id, ['outlier', 'missing_value']);
    r.modelReplies.push({ ranking: [{ item: 1, citation: 'far past its threshold' }, { item: 7, citation: 'invented' },
      { item: 0, citation: ' ' }, { item: 1, citation: 'again' }] });
    const before = r.modelRequests.length;
    const ranking = await r.gateway.call(rankFindings, { body: { objectTypeId: r.type('supplier').id, limit: 50 } }, r.cell.as(r.root));
    assert.equal(ranking.ranked.length, 1);
    assert.equal(ranking.ranked[0]!.position, 1);
    assert.deepEqual(ranking.discarded, { unknown: 1, uncited: 1, duplicate: 1 });
    assert.ok(ranking.unranked.length >= 1, 'the rest stay visible, unranked');
    const prompt = JSON.stringify(r.modelRequests.slice(before));
    for (const s of SUPPLIERS) assert.ok(!prompt.includes(s.name) && !(s.email && prompt.includes(s.email)), 'no record value in the prompt');
    assert.ok(prompt.includes('Rating'), 'the vocabulary names what the findings are about');
    const [event] = await outboxEvents('ranking_produced');
    assert.equal(event.detail.discarded_unknown, 1);
  });
});

describe('run states the population decides (spec 38.2)', () => {
  test('a population over the federated bound is refused, never computed in part', async () => {
    const out = await run(r.type('event').id, ['unmatched_record']);
    assert.equal(out.runs[0]!.state, 'bounded');
    assert.equal(out.runs[0]!.findingsCount, 0);
    assert.equal(out.runs[0]!.stateDetail!['bound'], 'rows_per_source_step');
  });

  test('a halted connection makes the run state source_unreachable, naming it', async () => {
    let connection = await r.gateway.call(getConnection, { params: { connectionId: r.erp } }, r.cell.as(r.root));
    connection = await r.gateway.call(changeConnectionStatus, { params: { connectionId: r.erp }, body: { move: 'halt', version: connection.version, reason: 'maintenance' } as never },
      r.cell.as(r.root));
    try {
      const out = await run(r.type('supplier').id, ['unmatched_record']);
      assert.equal(out.runs[0]!.state, 'source_unreachable');
      assert.equal(out.runs[0]!.stateDetail!['connectionId'], r.erp);
    } finally {
      await r.gateway.call(changeConnectionStatus, { params: { connectionId: r.erp }, body: { move: 'resume', version: connection.version } as never },
        r.cell.as(r.root));
    }
  });
});
