// The pure parts of canvas-layout: state rule compilation and evaluation (spec 28.4, 28.5),
// staleness defaults from a manifest, the layout engine (29.2, 29.8), and the Estate map's
// health rules (32.1).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { manifestSchema } from '../../src/contracts/connect/manifest.contract.ts';
import { connectionHealth, derivedId } from '../../src/services/canvas-layout/estate.service.ts';
import { layout } from '../../src/services/canvas-layout/layoutEngine.service.ts';
import { cadenceOf } from '../../src/services/canvas-layout/staleness.service.ts';
import { compileStateRules, evaluateState, readsOf, type CompiledStateRules, type InputState } from '../../src/services/canvas-layout/stateEvaluation.service.ts';
import type { SourceChange } from '../../src/contracts/change-stream/delta.contract.ts';
import type { OntologyManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { captureObservations } from '../../src/services/change-stream/capture.service.ts';
import { singleSourceObjectId } from '../../src/utils/siloObjectId.util.ts';
import { restManifest } from './connect.helper.ts';

const STATUS = '00000000-0000-4000-8000-000000000001';
const PRESSURE = '00000000-0000-4000-8000-000000000002';
const SERVICED = '00000000-0000-4000-8000-000000000003';
const inputs = [
  { propertyIdentityId: STATUS, apiName: 'status_code', dataType: 'string' },
  { propertyIdentityId: PRESSURE, apiName: 'pressure', dataType: 'decimal' },
  { propertyIdentityId: SERVICED, apiName: 'last_service', dataType: 'timestamp' },
];
const PUMP_RULES = [
  { state: 'failed' as const, when: 'self.status_code in ["TRIP", "FAULT"]', reason: 'Status reports trip or fault' },
  { state: 'warning' as const, when: 'self.pressure > 9.5', reason: 'Discharge pressure above 9.5 bar' },
  { state: 'warning' as const, when: 'now - self.last_service > duration("8760h")', reason: 'Service overdue' },
];

function compiled(): CompiledStateRules {
  const out = compileStateRules(inputs, PUMP_RULES, 900);
  assert.ok('compiled' in out);
  return out.compiled;
}

const now = new Date('2026-11-02T12:00:00Z');
const values = (status: unknown, pressure: unknown, serviced: unknown, extra: Partial<Record<string, Partial<InputState>>> = {}): Record<string, InputState> => ({
  [STATUS]: { value: status, visible: true, ...extra[STATUS] },
  [PRESSURE]: { value: pressure, visible: true, ...extra[PRESSURE] },
  [SERVICED]: { value: serviced, visible: true, ...extra[SERVICED] },
});

describe('state rules (spec 28.4)', () => {
  test('a condition reads only declared inputs, as self.<input>; quoted names are not reads', () => {
    const declared = new Set(['status_code', 'pressure']);
    assert.deepEqual(readsOf('self.status_code == "self.pressure" && self.pressure > 1', declared), { reads: ['pressure', 'status_code'] });
    assert.equal((readsOf('self.flow > 2', declared) as { issue: string }).issue, 'undeclared_input');
    assert.equal((readsOf('self["pressure"] > 2', declared) as { issue: string }).issue, 'self_misused');
    assert.equal((readsOf('size(self) > 2', declared) as { issue: string }).issue, 'self_misused');
    assert.equal((readsOf('fn.days_since(self.pressure) > 2', declared) as { issue: string }).issue, 'function_unavailable');
  });

  test('every issue is reported at once, and a rule that does not parse is one of them', () => {
    const out = compileStateRules(inputs, [
      { state: 'failed', when: 'self.flow > 1', reason: 'r' },
      { state: 'warning', when: 'self.pressure >', reason: 'r' },
    ], 900);
    assert.ok('issues' in out);
    assert.deepEqual(out.issues.map((i) => [i.rule, i.code]), [[0, 'undeclared_input'], [1, 'parse']]);
  });

  test('the hash is the same rule, whoever compiles it: inputs in any order, the same rules and window', () => {
    const a = compiled().hash;
    const out = compileStateRules([...inputs].reverse(), PUMP_RULES, 900);
    assert.ok('compiled' in out);
    assert.equal(out.compiled.hash, a);
    const other = compileStateRules(inputs, PUMP_RULES, 600);
    assert.ok('compiled' in other);
    assert.notEqual(other.compiled.hash, a);
  });

  test('ordered, first match wins; nothing matching is normal', () => {
    const rules = compiled();
    assert.equal(evaluateState(rules, values('TRIP', 12, '2026-10-01T00:00:00Z'), now).state, 'failed');
    assert.deepEqual(evaluateState(rules, values('RUN', 12, '2026-10-01T00:00:00Z'), now),
      { state: 'warning', reason: 'Discharge pressure above 9.5 bar' });
    assert.equal(evaluateState(rules, values('RUN', 3, '2024-01-01T00:00:00Z'), now).reason, 'Service overdue');
    assert.equal(evaluateState(rules, values('RUN', 3, '2026-10-01T00:00:00Z'), now).state, 'normal');
  });

  test('a null input makes a condition that reads it unknown, never false, so a missing value never passes as normal', () => {
    const rules = compiled();
    assert.deepEqual(evaluateState(rules, values(null, 3, '2026-10-01T00:00:00Z'), now), { state: 'unknown', reason: 'status_code has no value' });
    // A later rule matching does not rescue it: the first rule might have matched.
    assert.equal(evaluateState(rules, values(null, 12, '2026-10-01T00:00:00Z'), now).state, 'unknown');
  });

  test('an input the viewer may not see makes the state unknown, saying so without the value', () => {
    const rules = compiled();
    const hidden = values('TRIP', 12, '2026-10-01T00:00:00Z', { [STATUS]: { visible: false } });
    assert.deepEqual(evaluateState(rules, hidden, now), { state: 'unknown', reason: 'depends on a field not visible to you' });
  });

  test('staleness is checked first: stale, with the last known state', () => {
    const rules = compiled();
    const old = values('FAULT', 3, '2026-10-01T00:00:00Z', { [PRESSURE]: { stale: true } });
    assert.deepEqual(evaluateState(rules, old, now), { state: 'stale', reason: 'an input is older than its source allows', lastKnown: 'failed' });
  });
});

describe('staleness defaults (spec 28.5)', () => {
  const manifest = (changeStream?: unknown) => manifestSchema.parse({
    ...restManifest({
      baseUrl: 'https://api.example.com',
      objects: ['a', 'b'].map((name) => ({
        name, identifier: ['id'], source: { kind: 'rest', request: { method: 'GET', path: `/${name}`, query: {} }, records: { jsonata: 'results' } },
        fields: [{ name: 'id', type: 'string' }, { name: 'updated_at', type: 'date-time' }],
        pushdown: { filters: [{ field: 'updated_at', ops: ['gt'], patch: { cel: '{"query": {"since": string(value)}}' } }] },
      })),
    }),
    ...(changeStream === undefined ? {} : { changeStream }),
  });

  test('two polls, three heartbeats, a minute of CDC, or the freshness window; the strictest of several', () => {
    assert.deepEqual(cadenceOf(manifest()), { kind: 'none', cadenceSeconds: 900, defaultThresholdSeconds: 900 });
    const polled = manifest({ objects: [{ object: 'a', sources: [{ kind: 'poll', intervalSeconds: 300, watermarkField: 'updated_at' }] }] });
    assert.deepEqual(cadenceOf(polled), { kind: 'poll', cadenceSeconds: 300, defaultThresholdSeconds: 600 });
    assert.equal(cadenceOf(polled, ['b']).kind, 'none', 'an object with no stream falls back to the window');
    const mixed = manifest({
      objects: [
        { object: 'a', sources: [{ kind: 'poll', intervalSeconds: 3_600, watermarkField: 'updated_at' }] },
        { object: 'b', sources: [{ kind: 'poll', intervalSeconds: 120, watermarkField: 'updated_at' }] },
      ],
    });
    assert.equal(cadenceOf(mixed).defaultThresholdSeconds, 240);
  });
});

describe('the layout engine (spec 29.2, 29.8)', () => {
  test('layered: each edge points forward a layer; a cycle is broken, not looped', () => {
    const edges: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 1], [0, 4]];
    const laid = layout('graph_layered', { n: 5, edges });
    const x = (i: number) => laid.positions[i]![0]!;
    assert.ok(x(1) > x(0) && x(2) > x(1));
    assert.ok(x(4) > x(0));
    assert.equal(laid.notPlaced, 0);
    assert.deepEqual(laid.backEdges, [3], 'the edge closing the cycle is named, so it is drawn distinctly');
    assert.deepEqual(layout('graph_layered', { n: 5, edges }), laid, 'deterministic');
  });

  test('hierarchy: children to the right of their parent; one parent each, and a loop is ignored', () => {
    const laid = layout('hierarchy', { n: 4, edges: [[0, 1], [0, 2], [1, 3], [3, 0], [2, 3]] });
    const [p0, p1, p2, p3] = laid.positions;
    assert.ok(p1![0]! > p0![0]! && p2![0]! > p0![0]! && p3![0]! > p1![0]!);
    assert.deepEqual(laid.positions.map((p) => p[2]), [0, 0, 0, 0], 'one tree, one cluster');
    assert.deepEqual(laid.parents, [-1, 0, 0, 1], 'each member\'s container, for nested regions and counts per state');
  });

  test('timeline: time across, lanes down; a member without a time is not placed and counted', () => {
    const laid = layout('timeline', { n: 3, edges: [], time: [100, undefined, 300], lane: [0, 1, 2] });
    assert.equal(laid.notPlaced, 1);
    assert.deepEqual(laid.positions[1], [null, null, 1]);
    assert.ok(laid.positions[2]![0]! > laid.positions[0]![0]!);
  });

  test('force: deterministic, settled, and clustered by component', () => {
    const edges: [number, number][] = [[0, 1], [1, 2], [3, 4]];
    const a = layout('graph_force', { n: 5, edges });
    assert.deepEqual(layout('graph_force', { n: 5, edges }), a);
    assert.equal(a.positions[0]![2], a.positions[2]![2]);
    assert.notEqual(a.positions[0]![2], a.positions[3]![2]);
    const big = layout('graph_force', { n: 20_000, edges: Array.from({ length: 19_999 }, (_, i) => [i, i + 1] as [number, number]) });
    assert.equal(big.positions.length, 20_000);
  });
});

describe('Estate map health (spec 32.1)', () => {
  const connection = (status: string, lastHealthyAt: string | null) => ({ status, lastHealthyAt }) as never;
  const at = Date.parse('2026-11-02T12:00:00Z');
  test('failed when halted or revoked, warning on a failed refresh, unknown never probed, stale past the daily check', () => {
    assert.equal(connectionHealth(connection('halted', '2026-11-02T11:00:00Z'), false, at).health, 'failed');
    assert.equal(connectionHealth(connection('active', '2026-11-02T11:00:00Z'), true, at).health, 'warning');
    assert.equal(connectionHealth(connection('draft', null), false, at).health, 'unknown');
    assert.equal(connectionHealth(connection('active', '2026-10-30T11:00:00Z'), false, at).health, 'stale');
    assert.equal(connectionHealth(connection('active', '2026-11-02T11:00:00Z'), false, at).health, 'normal');
  });

  test('a derived node id is a stable UUID', () => {
    const id = derivedId('change_stream', '0190a0b0-0000-7000-8000-000000000000');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(derivedId('change_stream', '0190a0b0-0000-7000-8000-000000000000'), id);
  });
});

describe('change-stream deltas queued to Capture (spec 30.7)', () => {
  const ORG = '00000000-0000-4000-8000-0000000000aa';
  const CONN = '00000000-0000-4000-8000-0000000000bb';
  const PUMP = '00000000-0000-4000-8000-0000000000cc';
  const SITE = '00000000-0000-4000-8000-0000000000dd';
  const mapping = (fieldPath: string) => ({ connectionId: CONN, sourceObject: 'pumps', fieldPath, valueMap: null, sourceTimeZone: null, confidence: 1 });
  const ontology = {
    objectTypes: [
      { id: PUMP, status: 'active', resolutionClass: 'single_source', contributingObjects: [{ connectionId: CONN, sourceObject: 'pumps', identifierFieldPath: 'id' }],
        properties: [{ apiName: 'pressure', mappings: [mapping('discharge_bar')] }, { apiName: 'status_code', mappings: [mapping('status')] }] },
      // A resolvable type: its object is known only after resolution, which a stream does not run.
      { id: SITE, status: 'active', resolutionClass: 'resolvable', contributingObjects: [{ connectionId: CONN, sourceObject: 'pumps', identifierFieldPath: 'id' }],
        properties: [{ apiName: 'pressure', mappings: [mapping('discharge_bar')] }] },
    ],
  } as unknown as OntologyManifest;
  const change = (operation: 'update' | 'delete', changed: Record<string, number>, entityRef = 'P-1'): SourceChange => ({
    organisationId: ORG, connectionId: CONN, manifestVersion: '1.0.0', object: 'pumps', entityRef, operation, changed,
    observedAt: '2026-11-09T10:00:00.000Z', sourceAt: null, sourceSeq: null, ordering: 'observed_at', source: 'webhook', markings: [],
  });

  test('a single-source type\'s mapped fields, by property, under the object id computed from the record; deletions and resolvable types are not captured', () => {
    const byTime = captureObservations(ontology, ORG, CONN, [change('update', { discharge_bar: 9.7, unmapped: 1 }), change('delete', {}, 'P-2')]);
    const observations = byTime.get('2026-11-09T10:00:00.000Z')!;
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0], {
      objectTypeId: PUMP, objectRef: singleSourceObjectId(ORG, PUMP, CONN, 'pumps', 'P-1'), values: { pressure: 9.7 }, connectionIds: { pressure: CONN },
    });
  });
});
