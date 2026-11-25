// AI FDE stage 9 and steady state (spec 51.11): Reliability reads a connection's heal
// proposals, its latest re-check, its change stream health and its field profiles, and
// proposes only heal_review and reliability_finding. A heal awaiting review is a heal_review
// (a new field included: proposed, never applied silently); a halt is reported; a failing
// re-check, a stream silent or lagging while the source is otherwise healthy, and a field
// whose profile moved are findings. Everything it carries is a name, a code or a count.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StreamStatusView } from '../../src/contracts/change-stream/stream.contract.ts';
import type { HealProposalView, RecheckView } from '../../src/contracts/connector-maintenance/maintenance.contract.ts';
import { ROLE_PROPOSAL_KINDS } from '../../src/contracts/fde-orchestrator/events.contract.ts';
import { reliabilityProposals, type ReliabilityInputs } from '../../src/services/fde-orchestrator/roles.service.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';

const connectionId = uuidv7();
const at = (days: number) => new Date(Date.UTC(2026, 10, 1 + days)).toISOString();

const heal = (disposition: HealProposalView['disposition'], changeKind: HealProposalView['changeKind'], sandbox: HealProposalView['sandbox']['status'] = 'not_run'): HealProposalView => ({
  id: uuidv7(), connectionId, fromManifestId: uuidv7(), changeKind, disposition,
  changes: changeKind === 'new_field' ? [{ op: 'add_field', object: 'invoices', field: 'region', type: 'string', path: 'region' }] : [],
  drift: [{ kind: changeKind === 'new_field' ? 'new_field' : 'meaning_changed', object: 'invoices', field: changeKind === 'new_field' ? 'region' : 'status', detail: 'presence 1.0 to 0.2' }],
  candidateManifestId: null, sandbox: { status: sandbox, conformanceRunId: sandbox === 'passed' ? uuidv7() : null, reason: null },
  appliedManifestId: null, charge: 'not_metered', reviewedBy: null, reviewedAt: null, createdAt: at(0),
});

const recheck = (verified: boolean): RecheckView => ({
  id: uuidv7(), connectionId, manifestId: uuidv7(), trigger: 'weekly', status: 'completed', conformanceRunId: uuidv7(), verified,
  objects: [], drift: [], halted: false, healthy: verified, healProposalIds: [], errors: verified ? [] : ['read.timeout'], startedAt: at(0), completedAt: at(0),
});

const stream = (status: StreamStatusView['objects'][number]['status']): StreamStatusView => ({
  connectionId, webhook: null, capture: null, objects: [{ object: 'invoices', declared: ['poll'], inUse: 'poll', status, lastDeltaAt: at(-2), reason: null,
    subscribable: true, mode: 'live', refreshEverySeconds: null, conformanceRunId: null, failedTests: [] }],
});

const profile = (field: string, day: number, counts: { rows: number; nulls: number; distinct: number | null; conforming: number }) => ({
  sourceObject: 'invoices', fieldPath: field, rowCount: counts.rows, distinctCount: counts.distinct, nullCount: counts.nulls, emptyCount: 0,
  minLength: 1, maxLength: 10, typeConformanceCount: counts.conforming, profiledAt: at(day), connectorVersion: '1.0.0',
});

const inputs = (over: Partial<ReliabilityInputs>): ReliabilityInputs =>
  ({ connectionId, connectionStatus: 'active', heals: [], recheck: recheck(true), stream: undefined, profiles: [], ...over });
const findings = (i: ReliabilityInputs) => reliabilityProposals(i).filter((p) => p.kind === 'reliability_finding').map((p) => p.payload['finding']);

describe('AI FDE Reliability (spec 51.11)', () => {
  test('only heal_review and reliability_finding, as the role\'s kinds', () => {
    assert.deepEqual(ROLE_PROPOSAL_KINDS.reliability, ['heal_review', 'reliability_finding']);
    const all = reliabilityProposals(inputs({ heals: [heal('awaiting_review', 'rename'), heal('halted', 'semantic')], recheck: recheck(false) }));
    assert.ok(all.every((p) => ROLE_PROPOSAL_KINDS.reliability.includes(p.kind)));
  });

  test('a heal awaiting review is a heal_review, more confident once its repair passed in the sandbox; a new field is proposed, never applied', () => {
    const [tested, added] = reliabilityProposals(inputs({ heals: [heal('awaiting_review', 'rename', 'passed'), heal('awaiting_review', 'new_field')] }));
    assert.deepEqual([tested!.kind, tested!.confidence, tested!.evidence.map((e) => e.type)], ['heal_review', 0.8, ['probe', 'sandbox_cycle']]);
    assert.deepEqual([added!.kind, added!.payload['changeKind'], added!.confidence], ['heal_review', 'new_field', 0.5]);
    assert.deepEqual(added!.payload['drift'], [{ kind: 'new_field', object: 'invoices', field: 'region' }], 'names only: the drift detail stays behind');
    assert.equal(reliabilityProposals(inputs({ heals: [heal('applied', 'rename'), heal('auto_applied', 'pushdown_lost'), heal('rejected', 'rename')] })).length, 0);
  });

  test('a halt (a change of meaning, a removed object) and a failing re-check are reported', () => {
    const halted = heal('halted', 'object_removed');
    const out = reliabilityProposals(inputs({ heals: [halted], recheck: recheck(false) }));
    assert.deepEqual(out.map((p) => [p.payload['finding'], p.payload['findingKey']]).slice(0, 1), [['halted', `heal:${halted.id}`]]);
    assert.deepEqual(out[1]!.payload['errors'], ['read.timeout']);
  });

  test('a stream silent or lagging is a finding only while the connection is active and its re-check passed', () => {
    assert.deepEqual(findings(inputs({ stream: stream('stale') })), ['stream_silent']);
    assert.deepEqual(findings(inputs({ stream: stream('delayed') })), ['stream_lagging']);
    assert.deepEqual(findings(inputs({ stream: stream('live') })), []);
    assert.deepEqual(findings(inputs({ stream: stream('stale'), connectionStatus: 'halted' })), [], 'a halted connection is silent for its own reason');
    assert.deepEqual(findings(inputs({ stream: stream('stale'), recheck: recheck(false) })), ['conformance_failing'], 'the source is not healthy');
  });

  test('a field whose null rate, distinctness or type conformance moved between its last two profiles drifted; a steady one did not', () => {
    const profiles = [
      profile('status', 7, { rows: 1000, nulls: 600, distinct: 4, conforming: 1000 }), profile('status', 0, { rows: 1000, nulls: 10, distinct: 4, conforming: 1000 }),
      profile('total', 7, { rows: 1000, nulls: 0, distinct: 950, conforming: 500 }), profile('total', 0, { rows: 1000, nulls: 0, distinct: 980, conforming: 1000 }),
      profile('code', 7, { rows: 1000, nulls: 0, distinct: 10, conforming: 1000 }), profile('code', 0, { rows: 1000, nulls: 0, distinct: 990, conforming: 1000 }),
      profile('name', 7, { rows: 1000, nulls: 5, distinct: 900, conforming: 1000 }), profile('name', 0, { rows: 1000, nulls: 8, distinct: 910, conforming: 1000 }),
      profile('lonely', 7, { rows: 1000, nulls: 999, distinct: 1, conforming: 1 }),
    ];
    const drifted = reliabilityProposals(inputs({ profiles })).map((p) => [p.payload['field'], p.payload['moved']])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepEqual(drifted, [['code', ['distinctness']], ['status', ['null_rate']], ['total', ['type_conformance']]]);
    const status = reliabilityProposals(inputs({ profiles })).find((p) => p.payload['field'] === 'status')!;
    assert.deepEqual(status.payload['measures'], { rows: [1000, 1000], nullRate: [0.01, 0.6], distinctRatio: [0.004, 0.004], typeConformance: [1, 1] });
    assert.equal(status.payload['findingKey'], `profile:invoices:status:${at(7)}`, 'a later profile is a new finding; the same one is not');
    assert.deepEqual(status.evidence.map((e) => e.type), ['field_profile']);
  });
});
