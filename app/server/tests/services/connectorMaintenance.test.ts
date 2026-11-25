// Connector maintenance end to end (spec 17.3 to 17.5): real credential, policy, auth,
// connect-registry, connect-runtime, conformance and connector-maintenance processes, a stub
// metering that records charges, and a fake REST source whose structure each test changes
// under one connection: a field renamed, a field gone, a new field, a widened or wrong type,
// the object gone, a filter silently ignored.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { changeConnectionStatus, createConnection, getConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion, getConnector, getManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import {
  decideHealProposal, getHealProposal, getRecheck, listHealProposals, reportSourceDrift, requestRecheck,
  type HealProposalView, type RecheckView,
} from '../../src/contracts/connector-maintenance/maintenance.contract.ts';
import { charge } from '../../src/contracts/metering/charge.contract.ts';
import { route } from '../../src/infra/http.infra.ts';
import { defineService } from '../../src/infra/service.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as conformanceService } from '../../src/routes/conformance/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { createConnectorMaintenanceService } from '../../src/routes/connector-maintenance/index.route.ts';
import { AppError } from '../../src/utils/errors.util.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, restManifest, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let runtime: ServiceClient;
let root: Signed;
let reviewer: Signed;
let plain: Signed;
let api: Server;
let baseUrl: string;

// ----------------------------------------------------------------------------- the fake source

interface Mode {
  rename?: boolean;
  dropEmail?: boolean;
  twoCandidates?: boolean;
  phone?: boolean;
  decimalScore?: boolean;
  stringScore?: boolean;
  gone?: boolean;
  ignoreEmail?: boolean;
}
const modes = new Map<string, Mode>();
const CONTACTS = Array.from({ length: 20 }, (_, i) => ({
  id: `c${String(i + 1).padStart(2, '0')}`, email: `person${i + 1}@example.com`, score: (i * 7) % 40, stage: ['lead', 'won', 'lost'][i % 3]!,
  phone: `0207 946 ${String(100 + i)}`,
}));

function record(c: (typeof CONTACTS)[number], mode: Mode): Record<string, unknown> {
  const properties: Record<string, unknown> = { stage: c.stage };
  if (mode.rename) properties['email_address'] = c.email;
  else if (mode.twoCandidates) {
    properties['contact_email'] = c.email;
    properties['alt_email'] = c.email.replace('@', '+x@');
  } else if (!mode.dropEmail) properties['email'] = c.email;
  properties['score'] = mode.stringScore ? 'high' : mode.decimalScore ? c.score + 0.5 : c.score;
  if (mode.phone) properties['phone'] = c.phone;
  return { id: c.id, properties };
}
const emailOf = (r: Record<string, unknown>) => {
  const p = r['properties'] as Record<string, unknown>;
  return p['email'] ?? p['email_address'] ?? p['contact_email'];
};

const PAGE = 10;
function startApi(): Promise<void> {
  api = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer tok_good') return send(401, { message: 'bad token' });
    const [, prefix, key, resource] = url.pathname.split('/');
    const mode = modes.get(key ?? '') ?? {};
    if (prefix !== 'c' || resource !== 'contacts' || mode.gone) return send(404, {});
    let rows = CONTACTS.map((c) => record(c, mode));
    const id = url.searchParams.get('id');
    if (id !== null) rows = rows.filter((r) => r['id'] === id);
    const email = url.searchParams.get('email');
    if (email !== null && !mode.ignoreEmail) rows = rows.filter((r) => emailOf(r) === email);
    const page = Number(url.searchParams.get('page') ?? 1);
    return send(200, { results: rows.slice((page - 1) * PAGE, page * PAGE), next: page * PAGE < rows.length ? page + 1 : null });
  });
  return new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
}

const filter = (field: string) => ({ field, ops: ['eq'], patch: { cel: `{"query": {"${field}": string(value)}}` } });
const manifest = (key: string) => restManifest({
  baseUrl: `${baseUrl}/c/${key}`,
  objects: [{
    name: 'contacts', identifier: ['id'],
    fields: [
      { name: 'id', type: 'string' }, { name: 'email', type: 'string', path: 'properties.email' },
      { name: 'score', type: 'integer', path: 'properties.score' }, { name: 'stage', type: 'string', path: 'properties.stage' },
    ],
    source: {
      kind: 'rest', request: { method: 'GET', path: '/contacts' }, records: { jsonata: 'results' },
      paging: { next: { cel: 'response.body.next != null ? {"query": {"page": string(response.body.next)}} : stop()' }, maxPages: 10 },
    },
    pushdown: { filters: [filter('id'), filter('email')] },
  }],
});

// ----------------------------------------------------------------------------- stub metering

const charges: { healProposalId: string | undefined; trigger: string; membershipId: string | undefined }[] = [];
let refuseCharges = false;
const meteringStub = defineService({
  name: 'metering',
  // redis-data: the charge is keyed.
  needs: { redis: ['data'] },
  create: () => ({
    routes: [route(charge, {
      async handle({ body }, ctx) {
        if (body.trigger !== 'authored') return { charged: false as const, reason: 'never_metered' as const };
        if (refuseCharges) throw new AppError('bounds', 'no tokens left', { code: 'metering.allowance_exhausted', details: { bound: 'allowance' } });
        charges.push({ healProposalId: body.healProposalId, trigger: body.trigger, membershipId: ctx.request.membershipId });
        return { charged: true as const, transactionId: String(charges.length), operation: body.operation, pool: 'tokens' as const, weight: '2', source: 'allowance' as const };
      },
      resultRef: (out) => (out.charged ? `tx.${out.transactionId}` : 'none'),
      replay: async () => ({ charged: true as const, transactionId: '0', operation: 'repair_proposal' as const, pool: 'tokens' as const, weight: '2', source: 'allowance' as const }),
    })],
  }),
});

// ----------------------------------------------------------------------------- helpers

before(async () => {
  await startApi();
  baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  cell = await createConnectCell();
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(conformanceService, 'conformance', 'test_app');
  await cell.start(meteringStub, 'metering', 'test_app', { DURABLE_BUS: 'jetstream', NATS_DURABLE_URL: 'nats://127.0.0.1:1' });
  await cell.start(createConnectorMaintenanceService({ weekly: { intervalMs: 3_600_000 }, runTimeoutMs: 120_000, pollMs: 100 }),
    'connector-maintenance', 'test_app');
  gateway = cell.client('gateway');
  runtime = cell.client('connect-runtime');
  root = await cell.signIn('root@acme.example');
  reviewer = await cell.member('rev@acme.example', 'Admin', 'engineering');
  plain = await cell.member('mo@acme.example', 'Member', 'platform');
});

after(async () => {
  await cell?.close();
  api?.close();
});

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

async function activeConnection(key: string): Promise<string> {
  modes.set(key, {});
  const connector = await gateway.call(createConnector, {
    body: { slug: `mnt-${key}-${uuidv7().slice(-8)}`, name: `Contacts ${key}`, provider: 'Example', sourceRoute: 'ai' },
  }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest(key) } }, keyed(root));
  let connection = await gateway.call(createConnection, {
    body: { connectorId: connector.id, name: `Contacts ${key}`, owningScopeId: cell.scopes['engineering']! },
  }, keyed(root));
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_good' } } }, cell.as(root));
  connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move: 'probe', version: connection.version } }, cell.as(root));
  await cell.passConformance(connection.id);
  connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move: 'confirm', version: connection.version } }, cell.as(root));
  connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move: 'activate', version: connection.version } }, cell.as(root));
  return connection.id;
}

async function finished(recheckId: string): Promise<RecheckView> {
  for (let i = 0; i < 1_200; i++) {
    const r = await gateway.call(getRecheck, { params: { recheckId } }, cell.as(root));
    if (r.status !== 'running') return r;
    await sleep(100);
  }
  throw new Error('the re-check did not finish');
}

const recheck = async (connectionId: string, who: Signed = root): Promise<RecheckView> =>
  finished((await gateway.call(requestRecheck, { params: { connectionId } }, keyed(who))).id);

const proposal = (id: string): Promise<HealProposalView> => gateway.call(getHealProposal, { params: { proposalId: id } }, cell.as(root));

async function settled(id: string, until: (p: HealProposalView) => boolean): Promise<HealProposalView> {
  for (let i = 0; i < 1_200; i++) {
    const p = await proposal(id);
    if (until(p)) return p;
    await sleep(100);
  }
  throw new Error('the proposal did not settle');
}

const connection = (id: string) => gateway.call(getConnection, { params: { connectionId: id } }, cell.as(root));

async function events(name: string): Promise<{ resource: { id: string } | null; detail: Record<string, unknown> }[]> {
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by created_at, id`,
    [cell.org, name]));
  return rows.map((r) => r.payload as never);
}

// ----------------------------------------------------------------------------- tests

describe('the re-check (spec 17.3)', () => {
  let healthy: string;

  before(async () => {
    healthy = await activeConnection('healthy');
  });

  test('a healthy connection: the suite passes, the structure is recorded, the connection is marked healthy', async () => {
    const r = await recheck(healthy);
    assert.equal(r.status, 'completed', JSON.stringify(r.errors));
    assert.equal(r.trigger, 'manual');
    assert.equal(r.verified, true);
    assert.deepEqual(r.drift, []);
    assert.deepEqual(r.healProposalIds, []);
    assert.equal(r.healthy, true);
    assert.deepEqual(r.objects, [{ object: 'contacts', observable: true, reason: null, records: 20 }]);
    assert.notEqual((await connection(healthy)).lastHealthyAt, null);
  });

  test('findings are structure only: paths, kinds and counts, never a value', async () => {
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select findings::text as f from connect.probe_runs where connection_id = $1 and stage = 'recheck'`, [healthy]));
    const text = rows.map((r) => r.f as string).join('\n');
    assert.match(text, /"properties\.email"/);
    for (const c of CONTACTS) {
      assert.ok(!text.includes(c.email), 'an email address is a value');
      assert.ok(!text.includes(c.phone), 'a phone number is a value');
    }
  });

  test('one re-check at a time per connection, and only of an active or verified connection', async () => {
    const id = await activeConnection('busy');
    const first = await gateway.call(requestRecheck, { params: { connectionId: id } }, keyed(root));
    await assert.rejects(gateway.call(requestRecheck, { params: { connectionId: id } }, keyed(root)), { code: 'maintenance.recheck_in_progress' });
    await finished(first.id);
  });

  test('without connector.verify a member may not ask for one', async () => {
    await assert.rejects(gateway.call(requestRecheck, { params: { connectionId: healthy } }, keyed(plain)), { code: 'maintenance.not_permitted' });
  });

  test('a runtime self-heal starts one, and none again within the quiet window', async () => {
    const id = await activeConnection('selfheal');
    const report = () => runtime.call(reportSourceDrift, { params: { connectionId: id }, body: { signal: 'source_error' } }, { request: { organisationId: cell.org } });
    const first = await report();
    assert.equal(first.started, true);
    const done = await finished(first.recheckId!);
    assert.equal(done.trigger, 'self_heal');
    assert.equal(done.healthy, true);
    assert.deepEqual(await report(), { started: false, recheckId: first.recheckId });
  });
});

describe('repairs (spec 17.3)', () => {
  test('a field renamed: a new version, tested in the sandbox, applied; answers carry the field again', async () => {
    const id = await activeConnection('rename');
    await recheck(id); // the baseline a rename is judged against
    const before = await connection(id);
    modes.set('rename', { rename: true });
    const r = await recheck(id);
    assert.equal(r.status, 'completed', JSON.stringify(r.errors));
    assert.deepEqual(r.drift.map((d) => [d.kind, d.field]), [['rename', 'email']]);
    assert.equal(r.halted, false);
    assert.equal(r.healthy, true);
    const p = await proposal(r.healProposalIds[0]!);
    assert.equal(p.changeKind, 'rename');
    assert.equal(p.disposition, 'auto_applied');
    assert.deepEqual(p.changes, [{ op: 'rename_field', object: 'contacts', field: 'email', fromPath: 'properties.email', toPath: 'properties.email_address' }]);
    assert.equal(p.sandbox.status, 'passed');
    assert.notEqual(p.sandbox.conformanceRunId, null);
    assert.equal(p.charge, 'charged', 'a person asked for the re-check');
    assert.deepEqual(charges.filter((c) => c.healProposalId === p.id).map((c) => c.membershipId), [root.membershipId]);

    const now = await connection(id);
    assert.equal(now.manifestId, p.appliedManifestId);
    assert.notEqual(now.manifestId, before.manifestId);
    assert.equal(now.status, 'active');
    const connector = await gateway.call(getConnector, { params: { connectorId: now.connectorId } }, cell.as(root));
    assert.equal(connector.currentManifestId, p.appliedManifestId, 'the repaired version is current');
    const version = await gateway.call(getManifestVersion, { params: { connectorId: now.connectorId, versionId: p.appliedManifestId! } }, cell.as(root));
    assert.equal(version.version, '1.0.1');
    assert.equal(version.parentVersionId, before.manifestId);
    const out = await cell.client('executor').call(readObject, {
      body: { connectionId: id, reason: 'query', step: { object: 'contacts', filters: [], sort: [], fields: ['email'], limit: 3 } },
    }, { request: { organisationId: cell.org } });
    assert.ok(out.rows.every((row) => typeof row['email'] === 'string'));
    assert.ok((await events('heal_proposed')).some((e) => e.resource?.id === p.id));
    assert.ok((await events('heal_applied')).some((e) => e.resource?.id === p.id));
  });

  test('declared pushdown the source ignores is removed in a new version', async () => {
    const id = await activeConnection('pushdown');
    modes.set('pushdown', { ignoreEmail: true });
    const r = await recheck(id);
    assert.equal(r.status, 'completed', JSON.stringify(r.errors));
    assert.ok(r.drift.some((d) => d.kind === 'pushdown_lost' && d.field === 'email'));
    const p = await proposal(r.healProposalIds[0]!);
    assert.equal(p.changeKind, 'pushdown_lost');
    assert.equal(p.disposition, 'auto_applied');
    assert.deepEqual(p.changes, [{ op: 'remove_filter', object: 'contacts', field: 'email', ops: ['eq'] }]);
    const now = await connection(id);
    const version = await gateway.call(getManifestVersion, { params: { connectorId: now.connectorId, versionId: now.manifestId } }, cell.as(root));
    const filters = (version.document as { objects: { pushdown: { filters: { field: string }[] } }[] }).objects[0]!.pushdown.filters;
    assert.deepEqual(filters.map((f) => f.field), ['id']);
  });

  test('a new field is proposed, never applied silently; accepted, it is tested and applied', async () => {
    const id = await activeConnection('newfield');
    await recheck(id);
    modes.set('newfield', { phone: true });
    const r = await recheck(id);
    assert.equal(r.status, 'completed', JSON.stringify(r.errors));
    assert.deepEqual(r.drift.map((d) => [d.kind, d.field]), [['new_field', 'properties_phone']]);
    assert.equal(r.healthy, true, 'a new field changes no answer');
    const before = await connection(id);
    const p = await proposal(r.healProposalIds[0]!);
    assert.equal(p.disposition, 'awaiting_review');
    assert.equal(p.candidateManifestId, null);
    assert.deepEqual(p.changes, [{ op: 'add_field', object: 'contacts', field: 'properties_phone', type: 'string', path: 'properties.phone' }]);

    await assert.rejects(gateway.call(decideHealProposal, { params: { proposalId: p.id }, body: { decision: 'accept' } }, cell.as(plain)),
      { code: 'maintenance.not_permitted' });
    const accepted = await gateway.call(decideHealProposal, { params: { proposalId: p.id }, body: { decision: 'accept' } }, cell.as(reviewer));
    assert.equal(accepted.reviewedBy, reviewer.membershipId);
    const applied = await settled(p.id, (x) => x.disposition !== 'awaiting_review' || x.sandbox.status === 'failed');
    assert.equal(applied.disposition, 'applied', JSON.stringify(applied.sandbox));
    assert.equal((await connection(id)).manifestId, applied.appliedManifestId);
    assert.notEqual(applied.appliedManifestId, before.manifestId);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select created_by_membership_id from connect.connector_manifests where id = $1', [applied.appliedManifestId]));
    assert.equal(rows[0].created_by_membership_id, reviewer.membershipId, 'the person who accepted it made the version');
    assert.equal(charges.filter((c) => c.healProposalId === p.id).length, 1, 'charged once, when proposed');
  });

  test('a widened type waits for review; a rejection closes it', async () => {
    const id = await activeConnection('widen');
    modes.set('widen', { decimalScore: true });
    const r = await recheck(id);
    assert.deepEqual(r.drift.map((d) => [d.kind, d.field]), [['type_widened', 'score']]);
    assert.equal(r.halted, false);
    assert.equal(r.healthy, false, 'decimals read as empty until the widening is applied');
    assert.equal((await connection(id)).status, 'active');
    const p = await proposal(r.healProposalIds[0]!);
    assert.equal(p.changeKind, 'type_changed');
    assert.equal(p.disposition, 'awaiting_review');
    const rejected = await gateway.call(decideHealProposal, { params: { proposalId: p.id }, body: { decision: 'reject' } }, cell.as(reviewer));
    assert.equal(rejected.disposition, 'rejected');
    await assert.rejects(gateway.call(decideHealProposal, { params: { proposalId: p.id }, body: { decision: 'accept' } }, cell.as(reviewer)),
      { code: 'heal.not_awaiting_review' });
    assert.ok((await events('heal_rejected')).some((e) => e.resource?.id === p.id));
  });

  test('a repair refused by metering is recorded and not applied; a rename left unapplied halts', async () => {
    const id = await activeConnection('broke');
    await recheck(id);
    modes.set('broke', { rename: true });
    refuseCharges = true;
    try {
      const r = await recheck(id);
      assert.equal(r.status, 'completed', JSON.stringify(r.errors));
      const p = await proposal(r.healProposalIds[0]!);
      assert.equal(p.charge, 'refused');
      assert.equal(p.disposition, 'awaiting_review');
      assert.equal(p.candidateManifestId, null);
      assert.equal(r.halted, true);
      assert.equal((await connection(id)).status, 'halted');
    } finally {
      refuseCharges = false;
    }
  });
});

describe('halts (spec 17.3)', () => {
  test('a field gone with no single consistent replacement is a change of meaning: the connection halts', async () => {
    const id = await activeConnection('meaning');
    await recheck(id);
    modes.set('meaning', { twoCandidates: true });
    const r = await recheck(id);
    assert.equal(r.status, 'completed', JSON.stringify(r.errors));
    assert.deepEqual(r.drift.filter((d) => d.kind === 'meaning_changed').map((d) => d.field), ['email']);
    assert.equal(r.halted, true);
    const now = await connection(id);
    assert.equal(now.status, 'halted');
    assert.match(now.haltedReason ?? '', /^drift: semantic/);
    const p = await proposal(r.healProposalIds[0]!);
    assert.equal(p.changeKind, 'semantic');
    assert.equal(p.disposition, 'halted');
    assert.deepEqual(p.changes, []);
    assert.equal(p.charge, 'not_metered', 'a halt repairs nothing');
    assert.ok((await events('heal_halted')).some((e) => e.resource?.id === p.id));
    assert.ok((await events('connection_halted')).some((e) => e.resource?.id === id));
    await assert.rejects(gateway.call(requestRecheck, { params: { connectionId: id } }, keyed(root)), { code: 'maintenance.connection_not_checkable' });
  });

  test('without a baseline a missing field is never taken for a rename', async () => {
    const id = await activeConnection('nobaseline');
    modes.set('nobaseline', { rename: true });
    const r = await recheck(id);
    assert.ok(r.drift.some((d) => d.kind === 'meaning_changed' && d.field === 'email' && d.detail.includes('no_baseline')));
    assert.equal(r.halted, true);
  });

  test('a type that cannot hold its values halts; so does an object gone', async () => {
    const id = await activeConnection('types');
    modes.set('types', { stringScore: true });
    const r = await recheck(id);
    assert.deepEqual(r.drift.map((d) => [d.kind, d.field]), [['type_changed', 'score']]);
    assert.equal(r.halted, true);
    assert.equal((await proposal(r.healProposalIds[0]!)).disposition, 'halted');

    const gone = await activeConnection('gone');
    modes.set('gone', { gone: true });
    const g = await recheck(gone);
    assert.equal(g.status, 'completed', JSON.stringify(g.errors));
    assert.deepEqual(g.drift.map((d) => d.kind), ['object_removed']);
    assert.equal((await connection(gone)).status, 'halted');
  });
});

describe('heal proposals in review', () => {
  test('listed for a reviewer by disposition; a member without heal_review sees none', async () => {
    const listed = await gateway.call(listHealProposals, { query: { disposition: 'halted' } }, cell.as(reviewer));
    assert.ok(listed.proposals.length >= 3);
    assert.ok(listed.proposals.every((p) => p.disposition === 'halted'));
    const none = await gateway.call(listHealProposals, { query: {} }, cell.as(plain));
    assert.deepEqual(none.proposals, []);
  });
});

describe('the weekly re-check (spec 17.3)', () => {
  test('active connections without a recent re-check are due; a worker re-checks them as the service', async () => {
    const id = await activeConnection('weekly');
    const due = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select connection_id from connect.connections_due_for_recheck(interval '7 days', 500)`));
    const ids = due.rows.map((r) => r.connection_id as string);
    assert.ok(ids.includes(id));
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select id from connect.connections where status = 'active' and id in (select connection_id from connect.probe_runs where stage = 'recheck' and status = 'completed')`));
    for (const r of rows) assert.ok(!ids.includes(r.id as string), 'a connection re-checked this week is not due');

    const worker = await cell.start(createConnectorMaintenanceService({ weekly: { intervalMs: 200, concurrency: 1 }, runTimeoutMs: 120_000, pollMs: 100 }),
      'connector-maintenance', 'test_app');
    try {
      let weekly: { status: string; findings: { trigger: string } } | undefined;
      for (let i = 0; i < 600 && weekly?.status !== 'completed'; i++) {
        const found = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
          `select status, findings from connect.probe_runs where connection_id = $1 and stage = 'recheck' order by started_at desc limit 1`, [id]));
        weekly = found.rows[0] as typeof weekly;
        await sleep(100);
      }
      assert.equal(weekly?.status, 'completed');
      assert.equal(weekly?.findings.trigger, 'weekly');
      assert.equal(charges.some((c) => c.trigger !== 'authored'), false, 'a scheduled re-check is never charged');
    } finally {
      await worker.stop('test');
    }
  });
});
