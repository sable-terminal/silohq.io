// What a cell's Fleet agent tells the global tier and brings back (spec 6.3, 11.5, 11.6, 13.4;
// D199): registration (never a sovereign cell's in the shared directory); a shared commercial
// cell's status, each component judged on what its services answered since the last report;
// a dedicated cell's change policy carried to fleet-control; Fleet's events about a single-tenant
// cell copied into its customers' audit logs, once each, never the system or synthetic
// organisation's.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { recordFleetEvents, recordIncidentEvents, recordRedactionViolations } from '../../src/contracts/audit/fleetEvents.contract.ts';
import { provisionSyntheticTenant } from '../../src/contracts/auth/synthetic.contract.ts';
import type { ProcessSignals } from '../../src/contracts/fleet-control/signals.contract.ts';
import type { AnyContract } from '../../src/contracts/endpoint.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createAuditService } from '../../src/routes/audit/index.route.ts';
import { componentState, createCellReports } from '../../src/services/fleet-control/cellReports.service.ts';
import { createSignalStore } from '../../src/services/fleet-control/cellSignals.service.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, type ConnectCell } from './connect.helper.ts';

const quiet = createLogger({ service: 'fleet-control', cell: 'test', release: 'test', level: 'error', write: () => undefined });
const hosts = { app: 'ded-acme.silohq.io', oauthCallbackUrl: 'https://ded-acme.silohq.io/oauth', hooks: 'hooks.ded-acme.silohq.io', agent: 'agent.ded-acme.silohq.io' };

/** A service client that records what is called and answers as told. */
function recording(answers: Record<string, (input: unknown) => unknown>) {
  const calls: { id: string; input: any }[] = [];
  const client: ServiceClient = {
    async call<C extends AnyContract>(contract: C, input: unknown) {
      calls.push({ id: contract.id, input });
      const answer = answers[contract.id];
      if (answer === undefined) throw new Error(`no answer for ${contract.id}`);
      return answer(input) as never;
    },
    close() {},
  };
  return { client, calls };
}

const signals = (services: string[], total: number, errors: number): ProcessSignals => ({
  services: services as never, release: 'r1', startedAt: new Date().toISOString(), reportedAt: new Date().toISOString(),
  requests: { total, refused: 0, errors, latency: [0, 0, 0, 0, 0, 0, 0, 0, 0] }, gauges: {},
});

describe('a cell\'s reports (D199)', () => {
  test('registration: kind, residency, hostname and status; a sovereign cell registers nothing in the shared directory', async () => {
    const { client, calls } = recording({ 'directory.registerCell': () => ({}), 'connect-registry.cellConnectionCount': () => ({ connections: 12 }) });
    const reports = createCellReports({ services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'ded-acme', kind: 'dedicated', residency: 'uk', hosts }, status: 'active' });
    assert.equal(await reports.register(uuidv7()), true);
    assert.deepEqual(calls.find((c) => c.id === 'directory.registerCell'), {
      id: 'directory.registerCell', input: { params: { cellId: 'ded-acme' }, body: { kind: 'dedicated', residency: 'uk', hostname: hosts.app, status: 'active', connectionCount: 12 } },
    }, 'with its live connections (D203)');
    const sovereign = createCellReports({ services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'uk-sov-1', kind: 'sovereign', residency: 'uk', hosts }, status: 'active' });
    const before = calls.length;
    assert.equal(await sovereign.register(uuidv7()), false);
    assert.equal(calls.length, before, 'a sovereign cell asks and registers nothing');
  });

  test('status: each component on what its services answered since the last report; none reporting is an outage; only a shared cell reports', async () => {
    assert.deepEqual([componentState(0, 0, 0), componentState(1, 10, 9), componentState(1, 100, 1), componentState(1, 100, 2), componentState(1, 100, 6), componentState(1, 100, 26)],
      ['major_outage', 'operational', 'operational', 'degraded', 'partial_outage', 'major_outage']);
    const store = createSignalStore();
    const { client, calls } = recording({ 'status.reportCellStatus': () => ({ accepted: true }) });
    const reports = createCellReports({ services: client, logger: quiet, signals: store, cell: { id: 'uk-lon-1', kind: 'commercial', residency: 'uk', hosts }, status: 'active' });
    store.receive('gw', signals(['gateway'], 1_000, 0));
    store.receive('compile', signals(['compile', 'planner'], 1_000, 400));
    const first = (await reports.reportStatus(uuidv7()))!;
    assert.deepEqual([first.app, first.questions, first.login], ['operational', 'major_outage', 'major_outage']);
    // Since the last report the compiler answered 100 more, 3 of them failing: degraded, not its whole life's 40%.
    store.receive('compile', { ...signals(['compile', 'planner'], 1_100, 403), reportedAt: new Date(Date.now() + 1_000).toISOString() });
    const second = (await reports.reportStatus(uuidv7()))!;
    assert.equal(second.questions, 'degraded');
    assert.equal(calls.at(-1)!.input.body.components.length, 8);
    const dedicated = createCellReports({ services: client, logger: quiet, signals: store, cell: { id: 'ded-acme', kind: 'dedicated', residency: 'uk', hosts }, status: 'active' });
    assert.equal(await dedicated.reportStatus(uuidv7()), undefined, 'a dedicated cell never appears on the status page');
  });

  test('a dedicated cell carries its customer\'s change policy to fleet-control; a shared cell has none', async () => {
    const policy = { organisationId: uuidv7(), timeZone: 'Europe/London', windows: [{ day: 2, start: '22:00', end: '02:00' }], changeAuthorityMembershipId: null, freezes: [], exceptions: [] };
    const { client, calls } = recording({
      'policy.listChangePoliciesForFleet': () => ({ policies: [policy] }),
      'fleet-control.putCellChangePolicy': () => ({ cellId: 'ded-acme', reportedAt: new Date().toISOString(), freezesSet: 0 }),
    });
    const dedicated = createCellReports({ services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'ded-acme', kind: 'dedicated', residency: 'uk', hosts }, status: 'active' });
    assert.equal(await dedicated.carryPolicy(uuidv7()), 1);
    assert.deepEqual(calls.at(-1), { id: 'fleet-control.putCellChangePolicy', input: { params: { cellId: 'ded-acme' }, body: policy } });
    const shared = createCellReports({ services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'uk-lon-1', kind: 'commercial', residency: 'uk', hosts }, status: 'active' });
    assert.equal(await shared.carryPolicy(uuidv7()), 0);
  });

  test('a shared cell carries the status page\'s incidents naming it: declared and, once resolved, resolved (D209)', async () => {
    const notice = (id: string, kind: 'incident' | 'maintenance', cellIds: string[], resolvedAt: string | null) => ({
      id, kind, severity: kind === 'incident' ? 'sev2' : null, title: 'Questions slow', cellIds, components: ['questions'], state: resolvedAt === null ? 'investigating' : 'resolved',
      startedAt: '2026-11-22T09:00:00.000Z', resolvedAt, window: null, updates: [],
    });
    const [ours, elsewhere, maintenance] = [uuidv7(), uuidv7(), uuidv7()];
    const { client, calls } = recording({
      'status.readStatus': () => ({ schema: 'silo.status.v1', generatedAt: new Date().toISOString(), cells: [],
        notices: [notice(ours, 'incident', ['uk-lon-1'], '2026-11-22T10:00:00.000Z'), notice(elsewhere, 'incident', ['eu-fra-1'], null), notice(maintenance, 'maintenance', ['uk-lon-1'], null)] }),
      'audit.recordIncidentEvents': (input) => ({ copied: (input as { body: { events: unknown[] } }).body.events.length, skipped: 0 }),
    });
    const shared = createCellReports({ services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'uk-lon-1', kind: 'commercial', residency: 'uk', hosts }, status: 'active' });
    assert.equal(await shared.copyIncidents(uuidv7()), 2);
    const sent = calls.find((c) => c.id === 'audit.recordIncidentEvents')!.input.body.events;
    assert.deepEqual(sent.map((e: { noticeId: string; event: string }) => [e.noticeId, e.event]), [[ours, 'incident_declared'], [ours, 'incident_resolved']]);
    const dedicated = createCellReports({ services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'ded-acme', kind: 'dedicated', residency: 'uk', hosts }, status: 'active' });
    assert.equal(await dedicated.copyIncidents(uuidv7()), 0, 'a dedicated cell is never on the status page');
  });

  test('log lines redacted of a value pattern go to the organisation each named, what came since the last look (D209)', async () => {
    const org = uuidv7();
    const store = createSignalStore();
    const withRedactions = (count: number, at: number): ProcessSignals => ({ ...signals(['executor'], 10, 0), reportedAt: new Date(Date.now() + at).toISOString(),
      redactions: [{ organisationId: org, count, kinds: ['email'] }] });
    const { client, calls } = recording({ 'audit.recordRedactionViolations': (input) => ({ recorded: (input as { body: { violations: unknown[] } }).body.violations.length }) });
    const reports = createCellReports({ services: client, logger: quiet, signals: store, cell: { id: 'ded-acme', kind: 'dedicated', residency: 'uk', hosts }, status: 'active' });
    store.receive('exec-1', withRedactions(3, 0));
    assert.equal(await reports.copyRedactions(uuidv7()), 1);
    assert.deepEqual(calls.at(-1)!.input.body.violations, [{ organisationId: org, services: ['executor'], lines: 3, kinds: ['email'] }]);
    assert.equal(await reports.copyRedactions(uuidv7()), 0, 'nothing new since');
    store.receive('exec-1', withRedactions(5, 1_000));
    await reports.copyRedactions(uuidv7());
    assert.equal(calls.at(-1)!.input.body.violations[0].lines, 2, 'only what came since');
  });

  test('a single-tenant cell copies Fleet\'s events from the last one copied; a shared cell copies none', async () => {
    const event = (seq: number) => ({
      seq, event: 'rollout_started', occurredAt: new Date().toISOString(), releaseId: 'r1', rolloutId: uuidv7(), cellId: 'ded-acme', channel: 'stable',
      operatorId: null, detail: {}, hash: 'a'.repeat(64),
    });
    const pages = [[event(1), event(2)], [event(3)], []];
    const { client, calls } = recording({
      'fleet-control.listCellEvents': () => ({ events: pages.shift() ?? [], next: null }),
      'audit.recordFleetEvents': (input) => ({ copied: (input as { body: { events: unknown[] } }).body.events.length, skipped: 0 }),
    });
    const reports = createCellReports({ services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'ded-acme', kind: 'self_managed', residency: 'uk', hosts }, status: 'active' });
    assert.equal(await reports.copyEvents(uuidv7()), 2);
    assert.equal(await reports.copyEvents(uuidv7()), 1);
    assert.equal(await reports.copyEvents(uuidv7()), 0, 'nothing new');
    const lists = calls.filter((c) => c.id === 'fleet-control.listCellEvents').map((c) => c.input.query);
    assert.deepEqual(lists, [{}, { after: '2' }, { after: '3' }], 'each read starts after the last copied');
    const shared = createCellReports({ services: client, logger: quiet, signals: createSignalStore(), cell: { id: 'uk-lon-1', kind: 'commercial', residency: 'uk', hosts }, status: 'active' });
    assert.equal(await shared.copyEvents(uuidv7()), 0);
  });
});

describe('Fleet\'s events into a single-tenant cell\'s audit logs (spec 11.6)', () => {
  let cell: ConnectCell;

  before(async () => {
    cell = await createConnectCell();
    await cell.start(createAuditService({ consumer: `fleet-copy-${uuidv7().slice(-8)}` }), 'audit', 'test_audit_service' as never, { DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: LOCAL.natsUrl });
  });

  after(async () => {
    await cell?.close();
  });

  test('each event once into every customer organisation\'s log, never the synthetic one\'s; a freeze is the customer\'s own', async () => {
    const synthetic = await cell.client('fleet-control').call(provisionSyntheticTenant, {});
    const event = (seq: number, name: string) => ({
      seq, event: name as never, occurredAt: new Date().toISOString(), releaseId: 'r7', rolloutId: uuidv7(), cellId: 'ded-acme', channel: 'stable',
      operatorId: null, detail: { wave: 5, why: 'x'.repeat(300) }, hash: 'b'.repeat(64),
    });
    const agent = cell.client('fleet-control');
    const first = await agent.call(recordFleetEvents, { body: { events: [event(41, 'rollout_started'), event(42, 'change_freeze_set'), event(43, 'migration_applied')] } });
    assert.deepEqual(first, { copied: 2, skipped: 1 });
    const again = await agent.call(recordFleetEvents, { body: { events: [event(41, 'rollout_started')] } });
    assert.deepEqual(again, { copied: 0, skipped: 1 }, 'copied once, whatever the agent retries');
    const { rows } = await cell.migrate.query(
      `select organisation_id, event, payload->'detail' as detail from platform.outbox where event in ('rollout_started', 'migration_applied') order by event, organisation_id`);
    const orgs = new Set(rows.map((r) => r.organisation_id));
    assert.ok(orgs.has(cell.org), 'the customer\'s log');
    assert.ok(!orgs.has(synthetic.organisationId), 'never the synthetic organisation\'s');
    assert.equal(rows.filter((r) => r.event === 'rollout_started').length, orgs.size, 'one copy each');
    const detail = rows.find((r) => r.event === 'rollout_started')!.detail;
    assert.deepEqual([detail.fleet_seq, detail.release_id, detail.wave, detail.why.length], [41, 'r7', 5, 200]);
  });

  test('a redaction violation goes into the organisation it named; one this cell does not hold is skipped (13.1; D209)', async () => {
    const out = await cell.client('fleet-control').call(recordRedactionViolations, { body: { violations: [
      { organisationId: cell.org, services: ['executor'], lines: 2, kinds: ['email'] },
      { organisationId: uuidv7(), services: ['executor'], lines: 1, kinds: ['email'] },
    ] } });
    assert.deepEqual(out, { recorded: 1 });
    const { rows } = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'redaction_violation_detected'`, [cell.org]);
    assert.deepEqual(rows.map((r) => [r.detail.lines, r.detail.services, r.detail.kinds]), [[2, 'executor', 'email']]);
  });

  test('a status incident goes into every customer organisation\'s log once, declared and resolved (13.5; D209)', async () => {
    const noticeId = uuidv7();
    const events = [
      { noticeId, event: 'incident_declared' as const, occurredAt: '2026-11-22T09:00:00.000Z', severity: 'sev1', components: ['questions', 'actions'] },
      { noticeId, event: 'incident_resolved' as const, occurredAt: '2026-11-22T10:00:00.000Z', severity: 'sev1', components: ['questions', 'actions'] },
    ];
    const agent = cell.client('fleet-control');
    assert.deepEqual(await agent.call(recordIncidentEvents, { body: { events } }), { copied: 2, skipped: 0 });
    assert.deepEqual(await agent.call(recordIncidentEvents, { body: { events } }), { copied: 0, skipped: 2 }, 'once, whatever the agent retries');
    const { rows } = await cell.migrate.query(
      `select organisation_id, payload->>'event' as event, payload->'detail' as detail from platform.outbox where payload->'resource'->>'id' = $1 order by payload->>'event'`, [noticeId]);
    assert.deepEqual([...new Set(rows.map((r) => r.event))], ['incident_declared', 'incident_resolved']);
    assert.ok(rows.some((r) => r.organisation_id === cell.org));
    assert.equal(rows[0].detail.components, 'questions,actions');
  });
});
