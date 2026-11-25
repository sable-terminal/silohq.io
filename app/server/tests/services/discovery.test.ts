// Agent discovery end to end (spec 19): real credential, policy, auth, connect-registry,
// approvals, ontology and discovery processes, and a scripted fake agent standing in for the
// Silo Agent's tunnel. The cell holds the agent to its authorisation: targets, methods, the
// host bound, revocation and the switch.

import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { decideApproval } from '../../src/contracts/approvals/approval.contract.ts';
import { getConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { getConnector, getManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import {
  getDiscoverySettings, getFinding, getScanAuthorisation, getScanRun, listFindings, listScanRuns, requestScanAuthorisation, reviewFinding,
  revokeScanAuthorisation, setDiscoveryEnabled, startScan, type AuthorisationView, type FoundStructure, type RunView,
} from '../../src/contracts/discovery/discovery.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { service as approvalsService } from '../../src/routes/approvals/index.route.ts';
import { createDiscoveryService } from '../../src/routes/discovery/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { reportScanEvents, scanEvent, type DiscoveryScan, type ScanEvent } from '../../src/contracts/discovery/scan.contract.ts';
import type { DiscoveryAgentChannel } from '../../src/services/discovery/agent.service.ts';
import { fieldType } from '../../src/services/discovery/proposals.service.ts';
import { verifyDiscoveryScan } from '../../src/services/discovery/scans.service.ts';
import { AppError } from '../../src/utils/errors.util.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { createConnectCell, TEST_SCAN_KEYS, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let admin: Signed;
let approver: Signed;
let plain: Signed;
let agentId: string;
let poolId: string;

// ----------------------------------------------------------------------------- the fake agent

// Standing in for connect-runtime and the agent behind it: the scan is checked as they check
// it, the script's events are passed to discovery in numbered reports as connect-runtime
// passes them (a malformed one ends the scan, as the tunnel would), and a report answered
// with stop stops the script.
type Script = (scan: DiscoveryScan, signal: AbortSignal) => AsyncIterable<unknown>;
let script: Script = async function* () { yield { type: 'end', status: 'completed' }; };
const seen: DiscoveryScan[] = [];
let refuseStart: AppError | undefined;
const agent: DiscoveryAgentChannel = {
  async start(ctx, request) {
    if (refuseStart !== undefined) throw refuseStart;
    const scan = verifyDiscoveryScan(createPublicKey(TEST_SCAN_KEYS.publicKey), request.scan,
      { organisationId: ctx.request.organisationId!, agentId: request.agentId, runId: request.runId });
    seen.push(scan);
    const stop = new AbortController();
    const runtime = cell.client('connect-runtime');
    let sequence = 0;
    let events: ScanEvent[] = [];
    const report = async () => {
      sequence += 1;
      const sent = events;
      events = [];
      const answer = await runtime.call(reportScanEvents, { params: { runId: request.runId }, body: { agentId: request.agentId, sequence, events: sent } },
        { request: { organisationId: ctx.request.organisationId! }, correlationId: uuidv7() });
      if (answer.stop) stop.abort();
    };
    void (async () => {
      let ended = false;
      for await (const raw of script(scan, stop.signal)) {
        if (stop.signal.aborted) break;
        const parsed = scanEvent.safeParse(raw);
        events.push(parsed.success ? parsed.data : { type: 'end', status: 'failed', reason: 'frame_invalid' });
        ended = !parsed.success || parsed.data.type === 'end';
        if (ended) break;
        if (events.length >= 2) await report();
      }
      if (stop.signal.aborted) return;
      if (!ended) events.push({ type: 'end', status: 'failed', reason: 'tunnel_ended' });
      await report();
    })().catch(() => undefined);
  },
};

const at = (): string => new Date().toISOString();
const probe = (host: string, port: number | null, outcome = 'open', method = 'port_scan') => ({ type: 'probe', host, port, method, outcome, probedAt: at() });

const CATALOGUE: FoundStructure = {
  product: 'Example SQL', version: '15.4', protocol: 'sql', dialect: 'postgres', port: 5432, nodeClasses: [], topics: [],
  schemas: [{
    name: 'sales', tables: [
      { name: 'customers', rowCount: 120, primaryKey: ['id'], uniqueKeys: [['email']], foreignKeys: [],
        columns: [{ name: 'id', type: 'integer', nullable: false }, { name: 'name', type: 'text', nullable: true }, { name: 'email', type: 'text', nullable: true }] },
      { name: 'orders', rowCount: 900, primaryKey: ['id'], uniqueKeys: [],
        columns: [{ name: 'id', type: 'bigint', nullable: false }, { name: 'customer_id', type: 'integer', nullable: false },
          { name: 'total', type: 'numeric(12,2)', nullable: true }],
        foreignKeys: [{ columns: ['customer_id'], targetSchema: 'sales', targetTable: 'customers', targetColumns: ['id'] }] },
      // No key declared: discovery infers the reference from the column's name and type (19.4).
      { name: 'invoices', rowCount: 40, primaryKey: ['id'], uniqueKeys: [], foreignKeys: [],
        columns: [{ name: 'id', type: 'bigint', nullable: false }, { name: 'customer_id', type: 'integer', nullable: true }] },
    ],
  }],
};
const PORT_ONLY: FoundStructure = { product: 'Unknown service', version: null, protocol: 'other', dialect: null, port: 8080, schemas: [], nodeClasses: [], topics: [] };

// ----------------------------------------------------------------------------- setup

before(async () => {
  cell = await createConnectCell();
  await cell.start(approvalsService, 'approvals', 'test_app');
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createDiscoveryService({ agent, silentMs: 1_500, sweepMs: 200 }), 'discovery', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  admin = await cell.member('adm@acme.example', 'Admin', 'engineering');
  approver = await cell.member('appr@acme.example', 'Admin', 'engineering');
  plain = await cell.member('mo@acme.example', 'Member', 'platform');

  poolId = uuidv7();
  agentId = uuidv7();
  const principal = uuidv7();
  const fingerprint = createHash('sha256').update(agentId).digest();
  await cell.migrate.query('insert into connect.agent_pools (id, organisation_id, name, created_by) values ($1, $2, $3, $4)',
    [poolId, cell.org, 'Office', root.membershipId]);
  await cell.migrate.query(
    `insert into iam.service_principals (id, organisation_id, kind, name, certificate_fingerprint, owner_membership_id, created_by)
     values ($1, $2, 'agent', 'office-agent', $3, $4, $4)`, [principal, cell.org, fingerprint, root.membershipId]);
  await cell.migrate.query(
    `insert into connect.agents (id, organisation_id, pool_id, name, service_principal_id, certificate_fingerprint, certificate_serial,
       certificate_issued_at, certificate_expires_at, version, platform, hostname, enrolled_by)
     values ($1, $2, $3, 'office-agent', $4, $5, 'serial-1', now(), now() + interval '30 days', '1.4.0', 'linux_x86_64', 'office-1', $6)`,
    [agentId, cell.org, poolId, principal, fingerprint, root.membershipId]);
});

after(async () => {
  await cell?.close();
});

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
const inADay = () => new Date(Date.now() + 86_400_000).toISOString();

async function authorised(overrides: Partial<{ ranges: string[]; methods: string[]; maxHosts: number }> = {}): Promise<AuthorisationView> {
  const a = await gateway.call(requestScanAuthorisation, {
    body: {
      agentId, ranges: overrides.ranges ?? ['10.0.0.0/24'], methods: (overrides.methods ?? ['port_scan', 'catalogue_introspection']) as never,
      maxHosts: overrides.maxHosts ?? 50, expiresAt: inADay(),
    },
  }, keyed(admin));
  await gateway.call(decideApproval, { params: { chainId: a.approvalChainId }, body: { decision: 'approved', diffHash: a.documentHash } }, cell.as(approver));
  return a;
}

async function finished(runId: string): Promise<RunView> {
  for (let i = 0; i < 500; i++) {
    const r = await gateway.call(getScanRun, { params: { runId } }, cell.as(admin));
    if (r.status !== 'running') return r;
    await sleep(20);
  }
  throw new Error('the scan did not end');
}

async function scanned(authorisationId: string): Promise<RunView> {
  const run = await gateway.call(startScan, { params: { authorisationId } }, keyed(admin));
  return finished(run.id);
}

async function events(name: string): Promise<{ resource: { id: string } | null; detail: Record<string, unknown> }[]> {
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `select payload from platform.outbox where organisation_id = $1 and event = 'audit_event' and payload->>'event' = $2 order by created_at, id`,
    [cell.org, name]));
  return rows.map((r) => r.payload as never);
}

// ----------------------------------------------------------------------------- tests

describe('the switch (spec 19.1)', () => {
  test('off by default, and then unreachable', async () => {
    assert.equal((await gateway.call(getDiscoverySettings, {}, cell.as(admin))).enabled, false);
    await assert.rejects(gateway.call(requestScanAuthorisation, {
      body: { agentId, ranges: ['10.0.0.1'], methods: ['port_scan'], maxHosts: 10, expiresAt: inADay() },
    }, keyed(admin)), { code: 'discovery.disabled' });
    await assert.rejects(gateway.call(listFindings, { query: {} }, cell.as(admin)), { code: 'discovery.disabled' });
  });

  test('only discovery.manage held organisation-wide turns it on: never a scope admin', async () => {
    await assert.rejects(gateway.call(setDiscoveryEnabled, { body: { enabled: true } }, cell.as(admin)), { code: 'discovery.not_permitted' });
    const on = await gateway.call(setDiscoveryEnabled, { body: { enabled: true } }, cell.as(root));
    assert.equal(on.enabled, true);
    assert.equal(on.enabledBy, root.membershipId);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select discovery_enabled from iam.organisations where id = $1', [cell.org]));
    assert.equal(rows[0].discovery_enabled, true);
    assert.equal((await events('discovery_enabled')).length, 1);
  });
});

describe('scan authorisations (spec 19.2)', () => {
  test('explicit targets, a window, a known agent', async () => {
    const body = { agentId, ranges: ['10.0.0.0/24'], methods: ['port_scan' as const], maxHosts: 10, expiresAt: inADay() };
    await assert.rejects(gateway.call(requestScanAuthorisation, { body: { ...body, ranges: ['10.0.0.0/8'] } }, keyed(admin)), { category: 'validation' });
    await assert.rejects(gateway.call(requestScanAuthorisation, {
      body: { ...body, expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString() },
    }, keyed(admin)), { code: 'discovery.expiry_too_far' });
    await assert.rejects(gateway.call(requestScanAuthorisation, { body: { ...body, agentId: uuidv7() } }, keyed(admin)), { code: 'discovery.agent_not_found' });
    await assert.rejects(gateway.call(requestScanAuthorisation, { body }, keyed(plain)), { code: 'discovery.not_permitted' });
  });

  test('routed through approval: no scan until another person who may authorise approves the document', async () => {
    const a = await gateway.call(requestScanAuthorisation, {
      body: { agentId, ranges: ['10.0.0.0/24', 'db.internal.example'], methods: ['port_scan', 'catalogue_introspection'], maxHosts: 20, expiresAt: inADay() },
    }, keyed(admin));
    assert.equal(a.status, 'pending');
    assert.match(a.documentHash, /^[0-9a-f]{64}$/);
    await assert.rejects(gateway.call(startScan, { params: { authorisationId: a.id } }, keyed(admin)), { code: 'discovery.authorisation_not_usable' });
    const approve = (who: Signed, hash = a.documentHash) =>
      gateway.call(decideApproval, { params: { chainId: a.approvalChainId }, body: { decision: 'approved', diffHash: hash } }, cell.as(who));
    await assert.rejects(approve(admin), { code: 'approval.not_qualified' });
    await assert.rejects(approve(plain), { code: 'approval.not_permitted' });
    await assert.rejects(approve(approver, '0'.repeat(64)), { code: 'approval.diff_mismatch' });
    const chain = await approve(approver);
    assert.equal(chain.status, 'approved');
    assert.equal(chain.subjectKind, 'discovery_scan');
    assert.deepEqual(chain.subject, { kind: 'discovery_scan', id: a.id, siloId: null }, 'the chain names the authorisation it approves (D264)');
    assert.equal((await gateway.call(getScanAuthorisation, { params: { authorisationId: a.id } }, cell.as(admin))).status, 'approved');
    assert.equal((await events('scan_authorised')).some((e) => e.resource?.id === a.id), true);
  });
});

describe('scans (spec 19.3)', () => {
  test('every probe is logged, one row and one host_probed event each; findings carry their proposals', async () => {
    const a = await authorised();
    script = async function* () {
      yield probe('10.0.0.5', 5432);
      yield probe('10.0.0.6', 22, 'closed');
      yield { type: 'finding', host: '10.0.0.5', method: 'catalogue_introspection', found: CATALOGUE };
      yield { type: 'finding', host: '10.0.0.6', method: 'port_scan', found: PORT_ONLY };
      yield { type: 'end', status: 'completed' };
    };
    const run = await scanned(a.id);
    assert.equal(run.status, 'completed', JSON.stringify(run.reasons));
    assert.equal(run.probes, 2);
    assert.equal(run.findings, 2);
    assert.equal(run.hostsContacted, 2);
    assert.equal(seen.at(-1)!.authorisationSha256, a.documentHash, 'the agent is given the approved document, signed for this run on this agent');
    assert.equal(seen.at(-1)!.scanId, run.id);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select host, port, method, outcome, agent_id from connect.discovery_probes where run_id = $1 order by host', [run.id]));
    assert.deepEqual(rows.map((r) => [r.host, r.port, r.outcome, r.agent_id]), [['10.0.0.5', 5432, 'open', agentId], ['10.0.0.6', 22, 'closed', agentId]]);
    const probed = (await events('host_probed')).filter((e) => e.resource?.id === run.id);
    assert.deepEqual(probed.map((e) => e.detail['host']).sort(), ['10.0.0.5', '10.0.0.6']);
    assert.ok((await events('scan_completed')).some((e) => e.resource?.id === run.id));
    const runs = (await gateway.call(listScanRuns, { params: { authorisationId: a.id }, query: {} }, cell.as(admin))).runs;
    assert.deepEqual(runs.map((r) => [r.id, r.status, r.findings]), [[run.id, 'completed', 2]], 'found again under its authorisation, newest first');
    await assert.rejects(gateway.call(listScanRuns, { params: { authorisationId: uuidv7() }, query: {} }, cell.as(admin)), { code: 'discovery.authorisation_not_found' });

    const findings = (await gateway.call(listFindings, { query: { runId: run.id } }, cell.as(admin))).findings;
    const db = findings.find((f) => f.host === '10.0.0.5')!;
    assert.equal(db.proposedConnectorType, 'sql:postgres');
    assert.deepEqual(db.proposedObjectTypes.map((o) => [o.apiName, o.identifier.join(',')]), [['customer', 'id'], ['order', 'id'], ['invoice', 'id']]);
    assert.deepEqual(db.proposedLinks.map((l) => [l.from, l.to, l.origin]), [
      ['sales.orders', 'sales.customers', 'declared'], ['sales.invoices', 'sales.customers', 'inferred'],
    ]);
    assert.equal(db.reviewDecision, 'pending');
  });

  test('the cell holds the agent to its authorisation: targets, methods, the host bound', async () => {
    const bounded = await authorised({ maxHosts: 2 });
    script = async function* () {
      for (const host of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) yield probe(host, 80);
      yield { type: 'end', status: 'completed' };
    };
    const capped = await scanned(bounded.id);
    assert.equal(capped.status, 'failed');
    assert.deepEqual(capped.reasons, ['max_hosts']);

    const outside = await authorised();
    script = async function* () { yield probe('192.168.1.1', 80); };
    assert.deepEqual((await scanned(outside.id)).reasons, ['target_outside_authorisation']);

    const methods = await authorised({ methods: ['port_scan'] });
    script = async function* () { yield probe('10.0.0.7', 1883, 'open', 'mqtt_observe'); };
    assert.deepEqual((await scanned(methods.id)).reasons, ['method_not_authorised']);
  });

  test('a finding is structure only: a name that looks like a value is refused', async () => {
    const a = await authorised();
    const leaky: FoundStructure = {
      ...CATALOGUE,
      schemas: [{ name: 'public', tables: [{ ...CATALOGUE.schemas[0]!.tables[0]!, columns: [{ name: 'jane.doe@example.com', type: 'text', nullable: true }] }] }],
    };
    script = async function* () {
      yield { type: 'finding', host: '10.0.0.9', method: 'catalogue_introspection', found: leaky };
      yield { type: 'finding', host: '10.0.0.9', method: 'catalogue_introspection', found: { ...CATALOGUE, rows: [{ id: 1 }] } };
      yield { type: 'end', status: 'completed' };
    };
    const run = await scanned(a.id);
    assert.equal(run.findings, 0);
    // The value-like name is set aside; the event that is not a finding's shape ends the scan.
    assert.equal(run.status, 'failed');
    assert.deepEqual(run.reasons, ['finding_refused:value_pattern', 'agent:frame_invalid']);
  });

  test('a report is taken once, in order: one sent again adds nothing, one out of order is refused', async () => {
    const a = await authorised();
    script = async function* () {
      yield probe('10.0.0.21', 80);
      yield probe('10.0.0.22', 80);
      await sleep(400);
      yield { type: 'end', status: 'completed' };
    };
    const started = await gateway.call(startScan, { params: { authorisationId: a.id } }, keyed(admin));
    for (let i = 0; i < 100 && (await gateway.call(getScanRun, { params: { runId: started.id } }, cell.as(admin))).probes < 2; i++) await sleep(20);
    const runtime = cell.client('connect-runtime');
    const as = { request: { organisationId: cell.org }, correlationId: uuidv7() };
    const again = await runtime.call(reportScanEvents, { params: { runId: started.id }, body: { agentId, sequence: 1, events: [probe('10.0.0.21', 80) as never] } }, as);
    assert.deepEqual(again, { stop: false, reason: null });
    await assert.rejects(runtime.call(reportScanEvents, { params: { runId: started.id }, body: { agentId, sequence: 9, events: [] } }, as),
      { code: 'discovery.report_out_of_order' });
    await assert.rejects(runtime.call(reportScanEvents, { params: { runId: started.id }, body: { agentId: uuidv7(), sequence: 2, events: [] } }, as),
      { code: 'discovery.agent_mismatch' });
    const run = await finished(started.id);
    assert.equal(run.status, 'completed');
    assert.equal(run.probes, 2);
  });

  test('a scan the agent cannot be given fails at once, saying why', async () => {
    const a = await authorised();
    refuseStart = new AppError('source_unreachable', 'the agent is not connected', { code: 'agent.unavailable' });
    try {
      const run = await gateway.call(startScan, { params: { authorisationId: a.id } }, keyed(admin));
      assert.equal(run.status, 'failed');
      assert.deepEqual(run.reasons, ['agent.unavailable']);
    } finally {
      refuseStart = undefined;
    }
  });

  test('a run whose reports stop is ended: its agent was lost', async () => {
    const a = await authorised();
    script = async function* () {
      yield probe('10.0.0.31', 80);
      yield probe('10.0.0.32', 80);
      await new Promise(() => undefined);
    };
    const run = await scanned(a.id);
    assert.equal(run.status, 'failed');
    assert.deepEqual(run.reasons, ['agent_silent']);
    assert.equal(run.probes, 2);
  });

  test('revoking the authorisation stops its scan', async () => {
    const a = await authorised();
    script = async function* (_instruction, signal) {
      for (let n = 1; !signal.aborted; n++) {
        yield probe(`10.0.0.${(n % 200) + 1}`, 443);
        await sleep(10);
      }
    };
    const run = await gateway.call(startScan, { params: { authorisationId: a.id } }, keyed(admin));
    for (let i = 0; i < 200 && (await gateway.call(getScanRun, { params: { runId: run.id } }, cell.as(admin))).probes === 0; i++) await sleep(20);
    const revoked = await gateway.call(revokeScanAuthorisation, { params: { authorisationId: a.id } }, cell.as(admin));
    assert.equal(revoked.status, 'revoked');
    assert.equal((await gateway.call(revokeScanAuthorisation, { params: { authorisationId: a.id } }, cell.as(admin))).revokedAt, revoked.revokedAt);
    let end: RunView | undefined;
    for (let i = 0; i < 200 && end?.status !== 'revoked'; i++) {
      end = await gateway.call(getScanRun, { params: { runId: run.id } }, cell.as(admin));
      await sleep(20);
    }
    assert.equal(end?.status, 'revoked');
    assert.deepEqual(end?.reasons, ['authorisation_revoked']);
    await assert.rejects(gateway.call(startScan, { params: { authorisationId: a.id } }, keyed(admin)), { code: 'discovery.authorisation_not_usable' });
  });
});

describe('findings in review (spec 19.4)', () => {
  let database: string;
  let portOnly: string;

  before(async () => {
    const a = await authorised();
    script = async function* () {
      yield { type: 'finding', host: '10.0.0.5', method: 'catalogue_introspection', found: CATALOGUE };
      yield { type: 'finding', host: '10.0.0.5', method: 'catalogue_introspection', found: CATALOGUE };
      yield { type: 'finding', host: '10.0.0.8', method: 'port_scan', found: PORT_ONLY };
      yield { type: 'end', status: 'completed' };
    };
    const run = await scanned(a.id);
    const findings = (await gateway.call(listFindings, { query: { runId: run.id } }, cell.as(admin))).findings;
    database = findings.filter((f) => f.host === '10.0.0.5').at(-1)!.id;
    portOnly = findings.find((f) => f.host === '10.0.0.8')!.id;
  });

  test('approved and promoted: a private connector and a draft connection on the agent\'s pool; nothing connected', async () => {
    await assert.rejects(gateway.call(reviewFinding, { params: { findingId: database }, body: { decision: 'reject' } }, keyed(plain)),
      { code: 'discovery.not_permitted' });
    const f = await gateway.call(reviewFinding, {
      params: { findingId: database }, body: { decision: 'approve', promote: { owningScopeId: cell.scopes['engineering']!, proposeOntology: false } },
    }, keyed(admin));
    assert.equal(f.reviewDecision, 'approved');
    assert.equal(f.reviewedBy, admin.membershipId);
    const connector = await gateway.call(getConnector, { params: { connectorId: f.promotedConnectorId! } }, cell.as(root));
    assert.equal(connector.sourceRoute, 'visual');
    assert.equal(connector.trustTier, 'private');
    const connection = await gateway.call(getConnection, { params: { connectionId: f.promotedConnectionId! } }, cell.as(root));
    assert.equal(connection.status, 'draft');
    assert.equal(connection.agentPoolId, poolId);
    const version = await gateway.call(getManifestVersion, { params: { connectorId: connector.id, versionId: connection.manifestId } }, cell.as(root));
    const doc = version.document as { transport: { viaAgent: boolean }; objects: { name: string; relationships: unknown[] }[] };
    assert.equal(doc.transport.viaAgent, true);
    assert.deepEqual(doc.objects.map((o) => o.name), ['customers', 'orders', 'invoices']);
    assert.deepEqual(doc.objects[1]!.relationships, [{ field: 'customer_id', targetObject: 'customers', targetField: 'id', kind: 'foreign_key' }]);
    assert.ok((await events('finding_promoted_to_connector')).some((e) => e.resource?.id === database));
    await assert.rejects(gateway.call(reviewFinding, { params: { findingId: database }, body: { decision: 'reject' } }, keyed(admin)),
      { code: 'discovery.finding_reviewed' });
  });

  test('a finding without a catalogue is approved, not promoted', async () => {
    await assert.rejects(gateway.call(reviewFinding, {
      params: { findingId: portOnly }, body: { decision: 'approve', promote: { owningScopeId: cell.scopes['engineering']!, proposeOntology: false } },
    }, keyed(admin)), { code: 'discovery.not_promotable' });
    const f = await gateway.call(reviewFinding, { params: { findingId: portOnly }, body: { decision: 'approve' } }, keyed(admin));
    assert.equal(f.reviewDecision, 'approved');
    assert.equal(f.promotedConnectionId, null);
  });

  test('with proposeOntology, the promoted structure enters derivation and confirmation', async () => {
    const pending = (await gateway.call(listFindings, { query: { decision: 'pending' } }, cell.as(admin))).findings
      .find((f) => f.host === '10.0.0.5' && f.id !== database)!;
    const f = await gateway.call(reviewFinding, {
      params: { findingId: pending.id }, body: { decision: 'approve', promote: { owningScopeId: cell.scopes['engineering']!, proposeOntology: true } },
    }, keyed(root));
    assert.notEqual(f.ontologyProposalId, null);
    assert.ok((await events('finding_proposed_to_ontology')).some((e) => e.resource?.id === pending.id));
    // The declared key is a link at its usual confidence; the inferred reference a lower one,
    // labelled inferred; the unique email a match key candidate (19.4).
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(`select changes -> 'decisions' as decisions from ontology.ontology_proposals where id = $1`, [f.ontologyProposalId]));
    const decisions = rows[0].decisions as { kind: string; confidence: number; evidence: { source: string; detail: string }[];
      definition: { matchKeys?: { property: string }[]; routes?: { sourceObject: string; origin: string }[]; contributingObjects?: { sourceObject: string }[] } }[];
    const links = decisions.filter((d) => d.kind === 'link_type').map((d) => [d.definition.routes![0]!.sourceObject, d.definition.routes![0]!.origin, d.confidence]);
    assert.deepEqual(links.sort(), [['invoices', 'inferred', 0.5], ['orders', 'declared_fk', 0.95]]);
    const inferred = decisions.find((d) => d.kind === 'link_type' && d.definition.routes![0]!.origin === 'inferred')!;
    assert.match(inferred.evidence[0]!.detail, /Inferred: no key is declared/);
    const customers = decisions.find((d) => d.kind === 'object_type' && d.definition.contributingObjects![0]!.sourceObject === 'customers')!;
    assert.deepEqual(customers.definition.matchKeys, [{ property: 'email' }]);
    assert.deepEqual(await gateway.call(getFinding, { params: { findingId: pending.id } }, cell.as(admin)), f);
  });
});

describe('off again', () => {
  test('switching discovery off stops scans in progress and makes the service unreachable', async () => {
    const a = await authorised();
    script = async function* (_instruction, signal) {
      for (let n = 1; !signal.aborted; n++) {
        yield probe(`10.0.0.${(n % 200) + 1}`, 443);
        await sleep(10);
      }
    };
    const run = await gateway.call(startScan, { params: { authorisationId: a.id } }, keyed(admin));
    await sleep(100);
    await gateway.call(setDiscoveryEnabled, { body: { enabled: false } }, cell.as(root));
    let status = 'running';
    for (let i = 0; i < 200 && status === 'running'; i++) {
      const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select status from connect.discovery_runs where id = $1', [run.id]));
      status = rows[0].status as string;
      await sleep(20);
    }
    assert.equal(status, 'revoked');
    await assert.rejects(gateway.call(getScanRun, { params: { runId: run.id } }, cell.as(admin)), { code: 'discovery.disabled' });
    assert.ok((await events('discovery_disabled')).length === 1);
  });

  test('compiled out of the sovereign build: the service refuses to start', () => {
    const definition = createDiscoveryService({ agent });
    assert.throws(() => definition.create({ config: { cell: { buildTarget: 'sovereign' } } } as never), { code: 'config.discovery.sovereign' });
  });
});

describe('the promoted connector\'s field types (spec 19.4)', () => {
  test('a catalogue type by its own name, with what MySQL, SQL Server and Oracle mean by theirs', () => {
    const typed = (pairs: [string, string | null][]) => pairs.map(([t, d]) => fieldType(t, d));
    assert.deepEqual(typed([['int', 'mysql'], ['bigint', 'sqlserver'], ['decimal(12,2)', 'mysql'], ['varchar(200)', 'sqlserver'], ['bit', 'sqlserver'],
      ['datetime2', 'sqlserver'], ['tinyint(1)', 'mysql'], ['tinyint(4)', 'mysql']]),
    ['integer', 'integer', 'number', 'string', 'boolean', 'date-time', 'boolean', 'integer']);
    assert.deepEqual(typed([['number(10)', 'oracle'], ['number(12,2)', 'oracle'], ['number', 'oracle'], ['date', 'oracle'], ['date', 'postgres'], ['varchar2(200)', 'oracle']]),
      ['integer', 'number', 'number', 'date-time', 'date', 'string']);
  });
});
