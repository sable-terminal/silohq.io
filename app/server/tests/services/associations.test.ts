// Association analysis, outcomes and investigation (spec 38.6, 38.8), end to end over the
// recognition cell: populations named by current findings, co-occurrence with its sample
// size, temporal order only where a run saw one condition without the other, structural
// direction through a link type, outcomes designated and revoked, each computation keeping
// the set it replaced, and the four investigation questions answering the current part and
// naming what they cannot answer without Capture. The arithmetic is tested on its own first.
// Capture's side of investigation is in tests/services/siloes.test.ts.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  computeAssociations, designateOutcome, investigate, listAssociations, listOutcomes, revokeOutcome,
} from '../../src/contracts/recognition/association.contract.ts';
import { configureDetector, runDetectors } from '../../src/contracts/recognition/detector.contract.ts';
import { service as recognitionService } from '../../src/routes/recognition/index.route.ts';
import { createSiloesCaptureService } from '../../src/routes/siloes-capture/index.route.ts';
import {
  associateAcross, associateWithin, fixedLanguage, neutral, type Membership, type Population,
} from '../../src/services/recognition/associations.service.ts';
import { inTx } from '../db/harness.helper.ts';
import { createMemoryStore } from './memoryStore.helper.ts';
import { startRecognitionCell, SUPPLIERS, type RecognitionCell } from './recognition.helper.ts';

// ----------------------------------------------------------------------------- the arithmetic

const pop = (name: string, members: Record<string, Membership>, extra: Partial<Population> = {}): Population => ({
  objectTypeId: 't', property: null, detectorId: name, name, outcome: false, members: new Map(Object.entries(members)), ...extra,
});
const at = (start: number | null, lastAbsent: number | null = null): Membership => ({ start, lastAbsent });

describe('the arithmetic (spec 38.6)', () => {
  test('co-occurrence over the sample; precedence only where a run saw one without the other', () => {
    const a = pop('Alpha', { o1: at(1), o2: at(1), o3: at(5, 2) });
    // o1: Beta was examined at 3 and absent while Alpha already named it: Alpha precedes.
    // o2: both began without seeing one without the other: unordered.
    // o3: Alpha was absent at 2 while Beta (from 1) named it: Beta precedes.
    const b = pop('Beta', { o1: at(4, 3), o2: at(1), o3: at(1), o4: at(1) });
    const [row] = associateWithin([a, b], 10, 'things');
    assert.equal(row!.coOccurrence, 3);
    assert.equal(row!.sampleSize, 10);
    assert.deepEqual(row!.temporalOrder, { precedes: 1, follows: 1, unordered: 1, of: 3 });
    assert.equal(row!.statement,
      'Alpha occurs together with Beta in 3 of 10 things. Alpha precedes Beta in 1 of 3 instances. Beta precedes Alpha in 1 of 3 instances.');
  });

  test('pairs that never co-occur are left out, unless one side is an outcome, which is always the right side', () => {
    const a = pop('Alpha', { o1: at(1) });
    const b = pop('Beta', { o2: at(1) });
    assert.deepEqual(associateWithin([a, b], 5, 'things'), []);
    const outcome = pop('Zulu: yes', { o2: at(null) }, { property: 'zulu', detectorId: null, outcome: true });
    const rows = associateWithin([outcome, a, b], 5, 'things');
    assert.deepEqual(rows.map((r) => [r.left.name, r.right.name, r.coOccurrence]), [['Alpha', 'Zulu: yes', 0], ['Beta', 'Zulu: yes', 1]]);
    assert.equal(rows[1]!.temporalOrder, null, 'a property has no moments: no order is stated');
    assert.equal(rows[1]!.statement, 'Beta occurs together with Zulu: yes in 1 of 5 things.');
  });

  test('across a link type, in its direction', () => {
    const suppliers = pop('Disagreement', { s1: at(1), s2: at(1) }, { objectTypeId: 'supplier' });
    const orders = pop('Duplicate value', { o1: at(1), o2: at(1) }, { objectTypeId: 'order' });
    const linked = new Map([['s1', new Set(['o1', 'o2'])], ['s2', new Set(['o3'])]]);
    const [row] = associateAcross([suppliers], [orders], linked, { id: 'l', direction: 'forward', name: 'Orders' }, 12, 'suppliers', 'orders');
    assert.equal(row!.coOccurrence, 1);
    assert.equal(row!.statement, 'Disagreement on suppliers is linked through Orders to Duplicate value on orders in 1 of 12 suppliers.');
  });

  test('the language is fixed: a causal name is replaced, and a causal statement never leaves', () => {
    assert.equal(neutral('a property', 'Drives revenue', 'drives_revenue'), 'drives_revenue');
    assert.equal(neutral('a property', 'Causes', 'causes'), 'a property');
    assert.equal(neutral('a property', 'Fraud flag', 'is_flagged'), 'is_flagged');
    assert.throws(() => fixedLanguage('Alpha drives Beta'), { code: 'recognition.language_not_fixed' });
  });
});

// ----------------------------------------------------------------------------- end to end

let r: RecognitionCell;
const FORBIDDEN = /\b(cause|causes|caused|drive|drives|driven|fraud|fraudulent)\b/i;

const configure = (typeName: string, detector: string, properties: string[]) => r.gateway.call(configureDetector, {
  params: { objectTypeId: r.type(typeName).id, detector },
  body: { properties: properties.map((p) => r.prop(typeName, p)), timeField: null, enabled: true },
}, r.cell.as(r.root));
const run = (typeName: string, detectors: string[]) =>
  r.gateway.call(runDetectors, { body: { objectTypeId: r.type(typeName).id, detectors } }, r.cell.as(r.root));
const events = async (name: string) => (await inTx(r.cell.app, { orgId: r.cell.org }, () => r.cell.app.query(
  `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = $2 order by created_at`, [r.cell.org, name],
))).rows.map((row) => row.detail as Record<string, unknown>);

before(async () => {
  // Siloes Capture runs, as deployed, but this organisation has not switched Siloes on: no history is held.
  r = await startRecognitionCell([{
    definition: createSiloesCaptureService({ store: createMemoryStore(), schedule: false }), name: 'siloes-capture', env: {
      SILOES_POSTGRES_PRICE_PER_GIB_MONTH: '0.20', SILOES_STORAGE_PRICE_PER_GIB_MONTH: '0.02', SILOES_CAPTURE_DRAIN_SECONDS: '1', SILOES_PURGE_POLL_SECONDS: '1',
      SILOES_RETENTION_SWEEP_SECONDS: '604800', BIGQUERY_PROJECT_ID: 'silo-test-proj', BIGQUERY_LOCATION: 'europe-west2', OBJECT_STORE: 's3',
      OBJECT_BUCKET_SILOES: 'silo-test-siloes', S3_ENDPOINT: 'http://127.0.0.1:1', S3_REGION: 'eu-west-2', S3_FORCE_PATH_STYLE: 'true',
    },
  }, { definition: recognitionService, name: 'recognition' }]);
  await configure('supplier', 'missing_value', ['email']);
  await configure('supplier', 'outlier', ['rating']);
  await configure('supplier', 'disagreement', ['name']);
  await configure('supplier', 'duplicate_value', ['email']);
  await configure('order', 'duplicate_value', ['supplier_id']);
  // Kilo has no email from the first run; its rating is ordinary until a later run, so the
  // outlier detector examined it and did not name it while Missing value already did.
  const kilo = SUPPLIERS.find((s) => s.id === 's11')!;
  await run('supplier', ['missing_value']);
  kilo.rating = 11;
  try {
    await run('supplier', ['outlier']);
  } finally {
    kilo.rating = 95;
  }
  await run('supplier', ['outlier']);
  await run('supplier', ['disagreement', 'duplicate_value']);
  await run('order', ['duplicate_value']);
});

after(async () => {
  await r?.close();
});

describe('association analysis (spec 38.6)', () => {
  let first: string;

  test('co-occurrence on a type, with its sample size and the order a run observed', async () => {
    const out = await r.gateway.call(computeAssociations, {}, r.cell.as(r.root));
    first = out.computation.id;
    assert.equal(out.computation.supersedes, null);
    assert.deepEqual(out.skipped, []);
    const { associations, computation, withheld } = await r.gateway.call(listAssociations, { query: { objectTypeId: r.type('supplier').id } }, r.cell.as(r.root));
    assert.equal(computation?.id, first);
    assert.equal(withheld, 0);
    const together = associations.filter((a) => a.relation === 'occurs_together');
    assert.equal(together.length, 1, 'only Kilo is named twice; pairs that never co-occur are not stated');
    const [kilo] = together;
    assert.deepEqual([kilo!.left.detector, kilo!.right.detector, kilo!.coOccurrence, kilo!.sampleSize], ['missing_value', 'outlier', 1, SUPPLIERS.length]);
    assert.deepEqual(kilo!.temporalOrder, { precedes: 1, follows: 0, unordered: 0, of: 1 });
    assert.equal(kilo!.statement,
      `Missing value occurs together with Outlier in 1 of ${SUPPLIERS.length} Suppliers. Missing value precedes Outlier in 1 of 1 instances.`);
    for (const a of associations) assert.doesNotMatch(a.statement, FORBIDDEN);
    assert.deepEqual((await events('associations_computed')).at(-1), {
      associations: out.associations, object_types: 2, outcomes: 0, skipped: 0, supersedes: null,
    });
  });

  test('structural direction through a link type, each way', async () => {
    const link = r.link('supplier_orders');
    const { associations } = await r.gateway.call(listAssociations, { query: {} }, r.cell.as(r.root));
    const linked = associations.filter((a) => a.relation === 'linked_through');
    const forward = linked.find((a) => a.linkDirection === 'forward');
    const reverse = linked.find((a) => a.linkDirection === 'reverse');
    assert.equal(linked.length, 2);
    // Acme (s01) disagrees across systems and placed both orders that share a supplier.
    assert.deepEqual([forward!.left.objectTypeId, forward!.left.detector, forward!.right.objectTypeId, forward!.right.detector, forward!.coOccurrence, forward!.sampleSize],
      [r.type('supplier').id, 'disagreement', r.type('order').id, 'duplicate_value', 1, SUPPLIERS.length]);
    assert.equal(forward!.linkTypeId, link.id);
    assert.match(forward!.statement, new RegExp(`^Disagreement on Suppliers is linked through .+ to Duplicate value on orders in 1 of ${SUPPLIERS.length} Suppliers\\.$`));
    assert.deepEqual([reverse!.left.detector, reverse!.coOccurrence, reverse!.sampleSize], ['duplicate_value', 2, 4]);
    assert.equal(reverse!.temporalOrder, null);
  });

  test('an outcome is designated by someone holding outcome.designate: a yes/no property or a finding kind', async () => {
    const supplier = r.type('supplier').id;
    await assert.rejects(r.gateway.call(designateOutcome, { body: { objectTypeId: supplier, detector: 'missing_value' } }, r.cell.as(r.viewer)),
      { code: 'recognition.not_permitted' });
    await assert.rejects(r.gateway.call(designateOutcome, { body: { objectTypeId: supplier, property: 'email' } }, r.cell.as(r.root)),
      { code: 'recognition.outcome_not_boolean' });
    await assert.rejects(r.gateway.call(designateOutcome, { body: { objectTypeId: supplier, property: 'colour' } }, r.cell.as(r.root)),
      { code: 'recognition.outcome_property_unknown' });
    await assert.rejects(r.gateway.call(designateOutcome, { body: { objectTypeId: supplier, detector: 'nonesuch' } }, r.cell.as(r.root)),
      { code: 'recognition.detector_unknown' });
    const outcome = await r.gateway.call(designateOutcome, { body: { objectTypeId: supplier, detector: 'missing_value' } }, r.cell.as(r.root));
    assert.deepEqual([outcome.detector, outcome.property], ['missing_value', null]);
    await assert.rejects(r.gateway.call(designateOutcome, { body: { objectTypeId: supplier, detector: 'missing_value' } }, r.cell.as(r.root)),
      { code: 'recognition.outcome_exists' });
    assert.deepEqual((await r.gateway.call(listOutcomes, { query: { objectTypeId: supplier } }, r.cell.as(r.viewer))).outcomes.map((o) => o.id), [outcome.id]);
    assert.deepEqual((await events('outcome_designated')).at(-1), { object_type_id: supplier, property: null, detector: 'missing_value', change: 'designated' });

    // Designation never changes what a detector raises; analysis then states what co-occurs with it, at zero too.
    const again = await r.gateway.call(computeAssociations, {}, r.cell.as(r.root));
    assert.equal(again.computation.supersedes, first, 'the computation records that an earlier set existed');
    const { associations } = await r.gateway.call(listAssociations, { query: { outcomeId: outcome.id } }, r.cell.as(r.root));
    assert.deepEqual(associations.map((a) => [a.left.detector, a.right.detector, a.right.outcome, a.coOccurrence]).sort(),
      [['disagreement', 'missing_value', true, 0], ['duplicate_value', 'missing_value', true, 0], ['outlier', 'missing_value', true, 1]]);
    const kilo = associations.find((a) => a.left.detector === 'outlier')!;
    assert.deepEqual(kilo.temporalOrder, { precedes: 0, follows: 1, unordered: 0, of: 1 });
    assert.match(kilo.statement, /Missing value precedes Outlier in 1 of 1 instances\.$/);

    const revoked = await r.gateway.call(revokeOutcome, { params: { outcomeId: outcome.id } }, r.cell.as(r.root));
    assert.ok(revoked.revokedAt);
    await assert.rejects(r.gateway.call(revokeOutcome, { params: { outcomeId: outcome.id } }, r.cell.as(r.root)), { code: 'recognition.outcome_revoked' });
    assert.deepEqual((await r.gateway.call(listOutcomes, { query: {} }, r.cell.as(r.root))).outcomes, []);
  });
});

describe('investigation (spec 38.8)', () => {
  const ask = (question: 'gaps' | 'contradictions' | 'anomalies' | 'clusters', typeName = 'supplier') =>
    r.gateway.call(investigate, { body: { question, objectTypeId: r.type(typeName).id } }, r.cell.as(r.root));
  const statements = (out: Awaited<ReturnType<typeof ask>>) => [...out.current, ...out.historical].map((p) => p.statement);

  test('where are the gaps: empty values, records standing alone, properties one system holds, and the gap findings', async () => {
    const out = await ask('gaps');
    assert.equal(out.population, SUPPLIERS.length);
    const byKind = (kind: string) => out.current.filter((p) => p.kind === kind);
    assert.deepEqual(byKind('empty_values').map((p) => [p.property, p.count, p.of]).sort(),
      [['email', 1, SUPPLIERS.length], ['registration', 1, SUPPLIERS.length]]);
    assert.deepEqual(byKind('unmatched_records').map((p) => p.count), [1], 'Lima has no registration');
    assert.deepEqual(byKind('single_system').map((p) => [p.property, p.connectionId]).sort(), [['email', r.crm], ['rating', r.crm], ['region', r.crm]]);
    assert.ok(statements(out).includes(`Email is empty on 1 of ${SUPPLIERS.length} Suppliers.`));
    assert.ok(out.findings.every((f) => ['missing_value', 'unmatched_record'].includes(f.detector)));
    assert.ok(out.findings.some((f) => f.detector === 'missing_value'));
    // Siloes are off here: nothing history-dependent, and it says what it cannot answer.
    assert.equal(out.history, 'not_held');
    assert.deepEqual(out.capturedProperties, []);
    assert.deepEqual(out.historical, []);
    assert.deepEqual(out.requiresCapture, ['When a gap opened, or a system stopped populating a field, needs captured history of Suppliers: a Capture Silo.']);
  });

  test('where does data contradict itself: disputed values and the disagreement findings', async () => {
    const out = await ask('contradictions');
    assert.deepEqual(out.current.filter((p) => p.kind === 'disputed_values').map((p) => [p.property, p.count, p.of]), [['name', 5, SUPPLIERS.length]]);
    assert.equal(out.findings.filter((f) => f.detector === 'disagreement').length, 5);
    assert.match(out.requiresCapture[0]!, /^When a contradiction began, and which system changed/);
  });

  test('which records are anomalous: the federated detectors, each said to have found something or why not', async () => {
    const out = await ask('anomalies');
    const parts = new Map(out.current.map((p) => [p.detector, p]));
    assert.deepEqual([parts.get('outlier')!.kind, parts.get('outlier')!.count], ['findings', 1]);
    assert.deepEqual([parts.get('duplicate_value')!.kind, parts.get('duplicate_value')!.count], ['findings', 2]);
    assert.equal(parts.get('uniqueness')!.statement, 'Uniqueness has not run on Suppliers.');
    assert.match(out.requiresCapture[0]!, /^Deviation from an object's own past/);
  });

  test('where do clusters form: nothing computed from current state without Capture, and never an assertion of fraud', async () => {
    const out = await ask('clusters');
    assert.deepEqual([out.current, out.historical, out.findings, out.associations], [[], [], [], []]);
    assert.deepEqual(out.requiresCapture, ['Clustering is a statement about repetition over time: it needs captured history of Suppliers: a Capture Silo.']);
    for (const question of ['gaps', 'contradictions', 'anomalies', 'clusters'] as const) {
      const answer = await ask(question);
      for (const s of [...statements(answer), ...answer.requiresCapture]) assert.doesNotMatch(s, FORBIDDEN, s);
    }
  });
});
