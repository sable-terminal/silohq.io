// Live state end to end (spec 18, 24.3, 30): a person's browser subscribes over the
// gateway's WebSocket to a saved object set; the state plane resolves it under that
// person's permissions (a connection grant, visible properties), snapshots it through
// connect-runtime and registers interest with change-stream; a provider's signed webhook
// becomes a delta that reaches the socket with the group's next sequence; a change that
// takes an object out of the filter is a departure; an older change is ignored; a resync
// answers with a fresh snapshot; refusals name the bound or the reason; revoking the grant
// withholds everything within seconds and ends the subscription.
// Real processes: credential, policy, auth, connect-registry, ontology, connect-runtime,
// change-stream, state-plane, gateway; a fake provider API; a real WebSocket client.

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { enableStream } from '../../src/contracts/change-stream/stream.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { LIVE_PATH, type ServerFrame } from '../../src/contracts/gateway/live.contract.ts';
import { putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import { grantConnection, revokeConnectionGrant } from '../../src/contracts/policy/governance.contract.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createChangeStreamService } from '../../src/routes/change-stream/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { reportLiveBufferMode } from '../../src/contracts/state-plane/subscription.contract.ts';
import { merged } from '../../src/services/state-plane/coalescing.service.ts';
import { createStatePlaneService } from '../../src/routes/state-plane/index.route.ts';
import { SESSION_COOKIE } from '../../src/middleware/cookies.middleware.ts';
import { singleSourceObjectId } from '../../src/services/state-plane/objectIds.service.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { loadConfig } from '../../src/config/index.config.ts';
import { connectRedis } from '../../src/infra/redis.infra.ts';
import { changeStatusKeys } from '../../src/infra/keyspaces.infra.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, doc, PASSWORD, type ConnectCell, type Signed } from './connect.helper.ts';
import { markSubscribable } from './subscribable.helper.ts';

const ORIGIN = 'https://app.silo.test';
let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let editor: Signed;
let viewer: Signed;
let api: Server;
let edge: string;
let connectionId: string;
let typeId: string;
let setId: string;
let grantId: string;
let hookPath: string;
let hookSecret: string;

const rows = new Map<string, { id: string; email: string; score: number }>([
  ['c1', { id: 'c1', email: 'ada@example.com', score: 15 }],
  ['c2', { id: 'c2', email: 'grace@example.com', score: 20 }],
  ['c3', { id: 'c3', email: 'alan@example.com', score: 5 }],
]);
const objectOf = (ref: string): string => singleSourceObjectId(cell.org, typeId, connectionId, 'contacts', ref);

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });
const audited = async (name: string) => (await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
  `select payload -> 'detail' as detail, payload -> 'resource' as resource, payload -> 'actor' as actor, payload ->> 'subjectMembershipId' as subject
     from platform.outbox where organisation_id = $1 and payload ->> 'event' = $2 order by seq`,
  [cell.org, name]))).rows as { detail: Record<string, unknown>; resource: unknown; actor: Record<string, unknown>; subject: string | null }[];
/** An audit event written after the frame that shows its change, so looked for a few times. */
const auditedSoon = async (name: string, where: (e: Awaited<ReturnType<typeof audited>>[number]) => boolean) => {
  for (let i = 0; i < 40; i += 1) {
    const found = (await audited(name)).filter(where);
    if (found.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
};

/** The provider's sequence per record: an event older than the last one applied describes a past state, not the source's now. */
const providerSeq = new Map<string, number>();

async function deliver(events: unknown[]): Promise<number> {
  // The provider's records change as its webhooks say, in order: a read of it afterwards agrees with the latest. A replayed older
  // event (the test of 18.6's ordering) leaves the source as it is, as a real provider would.
  for (const e of events as { id: string; type: string; seq?: number; data?: Record<string, unknown> }[]) {
    if (e.seq !== undefined && e.seq <= (providerSeq.get(e.id) ?? -1)) continue;
    if (e.seq !== undefined) providerSeq.set(e.id, e.seq);
    if (e.type === 'delete') rows.delete(e.id);
    else if (rows.has(e.id)) rows.set(e.id, { ...rows.get(e.id)!, ...(e.data ?? {}) } as never);
  }
  const body = JSON.stringify({ events });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', hookSecret).update(`${timestamp}.${body}`).digest('hex');
  const res = await fetch(`${edge}${hookPath}`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': signature, 'x-forwarded-for': '203.0.113.7' },
  });
  await res.text();
  return res.status;
}

// ----------------------------------------------------------------------------- a browser

let addresses = 0;
async function browserSession(email: string): Promise<{ cookie: string; address: string }> {
  const address = `198.51.100.${++addresses}`;
  const res = await fetch(`${edge}/api/v1/sessions`, {
    method: 'POST', body: JSON.stringify({ organisationSlug: 'acme', email, password: PASSWORD }),
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-silo-csrf': '1', 'x-forwarded-for': address },
  });
  assert.equal(res.status, 201, await res.clone().text());
  const cookie = res.headers.getSetCookie().map((c) => new RegExp(`^${SESSION_COOKIE}=([^;]+);`).exec(c)?.[1]).find((c) => c !== undefined)!;
  return { cookie, address };
}

interface Live {
  ws: WebSocket;
  send(message: unknown): void;
  next<T extends ServerFrame['type']>(type: T, where?: (frame: Extract<ServerFrame, { type: T }>) => boolean, timeoutMs?: number)
    : Promise<Extract<ServerFrame, { type: T }>>;
  none(type: ServerFrame['type'], where: (frame: any) => boolean, waitMs: number): Promise<void>;
  /** Frames of this type already received are set aside: the next one waited for arrives after now. */
  skip(type: ServerFrame['type']): void;
  /** Frames of this type received since the last skip of it. */
  received(type: ServerFrame['type']): any[];
}

async function connect(email: string): Promise<Live> {
  const session = await browserSession(email);
  const ws = new WebSocket(`${edge.replace('http', 'ws')}${LIVE_PATH}`, {
    headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session.cookie}`, 'x-forwarded-for': session.address },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
  });
  const frames: ServerFrame[] = [];
  const taken = new Set<number>();
  const skippedTo = new Map<string, number>();
  const waiters: (() => void)[] = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as ServerFrame;
    if (frame.type === 'heartbeat') ws.send(JSON.stringify({ type: 'heartbeat' }));
    if (frame.type === 'delta') ws.send(JSON.stringify({ type: 'ack', sub: frame.sub, seq: frame.seq }));
    frames.push(frame);
    for (const wake of waiters.splice(0)) wake();
  });
  const find = (type: string, where?: (frame: any) => boolean): number =>
    frames.findIndex((f, i) => !taken.has(i) && f.type === type && (where === undefined || where(f)));
  return {
    ws,
    send: (message) => ws.send(JSON.stringify(message)),
    async next(type, where, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = find(type, where as never);
        if (i >= 0) {
          taken.add(i);
          return frames[i] as never;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`no ${type} frame within ${timeoutMs} ms; saw ${frames.map((f) => f.type).join(',')}`);
        await Promise.race([new Promise<void>((wake) => waiters.push(wake)), sleep(left)]);
      }
    },
    skip(type) {
      frames.forEach((f, i) => { if (f.type === type) taken.add(i); });
      skippedTo.set(type, frames.length);
    },
    received(type) {
      return frames.slice(skippedTo.get(type) ?? 0).filter((f) => f.type === type);
    },
    async none(type, where, waitMs) {
      await sleep(waitMs);
      assert.equal(find(type, where), -1, `no ${type} frame expected`);
    },
  };
}

// ----------------------------------------------------------------------------- the cell

before(async () => {
  api = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok_valid') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [...rows.values()] }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  cell = await createConnectCell();
  const live = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(createChangeStreamService({ tickMs: 150 }), 'change-stream', 'test_app', live);
  // Coalescing above 10 changes a second per connection here (18.4 sets 1,000), so a test burst reaches it.
  await cell.start(createStatePlaneService({ watchMs: 300, coalesceAbovePerSecond: 10 }), 'state-plane', 'test_app', live);
  let port = 0;
  await cell.start(createGatewayService({ coalesceMs: 0, onListening: (p) => { port = p; } }), 'gateway', 'test_app', {
    ...live, GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
    IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), GATEWAY_HEARTBEAT_SECONDS: '1',
  });
  edge = `http://127.0.0.1:${port}`;
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  editor = await cell.member('editor@acme.example', 'Super admin');
  viewer = await cell.member('viewer@acme.example', 'Member', 'engineering');

  // A connection with a signed webhook, active.
  const connector = await gateway.call(createConnector, { body: { slug: 'crm', name: 'CRM', provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, {
    params: { connectorId: connector.id },
    body: {
      document: doc({
        schemaVersion: '1', identity: { name: 'Example CRM', provider: 'Example', version: '1.0.0' },
        transport: { viaAgent: false, baseUrl: apiUrl }, protocol: { kind: 'rest' },
        auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
        objects: [{
          name: 'contacts', identifier: ['id'],
          fields: [{ name: 'id', type: 'string', nullable: false }, { name: 'email', type: 'string' }, { name: 'score', type: 'integer' }],
          source: { kind: 'rest', request: { method: 'GET', path: '/v1/contacts', query: {} }, records: { jsonata: 'results' } },
        }],
        changeStream: {
          webhook: {
            verify: { cel: '{"expected": hex(hmac_sha256(secret.webhook, headers["x-timestamp"] + "." + body)), "provided": headers["x-signature"], "signedAt": int(headers["x-timestamp"])}' },
            decode: { jsonata: '[events.{"object": "contacts", "entityRef": id, "operation": type, "changed": data, "sourceSeq": seq}]' },
          },
          objects: [{ object: 'contacts', sources: [{ kind: 'webhook' }], ordering: 'source_sequence' }],
        },
      }),
    },
  }, keyed(root));
  let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'CRM', owningScopeId: cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
  }
  connectionId = connection.id;
  const enabled = await gateway.call(enableStream, { params: { connectionId }, body: {} }, cell.as(root));
  hookPath = enabled.webhook!.path;
  hookSecret = enabled.webhook!.secret!;
  // Its stream passed the change-stream class (tests/services/streamConformance.test.ts runs it).
  await markSubscribable(cell, connectionId, ['contacts']);

  // A contact type on main, and the viewer's grant and saved set.
  const branch = await gateway.call(openBranch, { body: { name: 'contacts' } }, keyed(editor));
  const mapped = (apiName: string, field: string, dataType: 'string' | 'integer') =>
    ({ apiName, displayName: apiName, dataType, mappings: [{ connectionId, sourceObject: 'contacts', fieldPath: field }] });
  const put = await gateway.call(putObjectType, {
    params: { branchId: branch.id, apiName: 'contact' },
    body: {
      displayName: 'Contact', pluralName: 'Contacts', contributingObjects: [{ connectionId, sourceObject: 'contacts', identifierFieldPath: 'id' }],
      properties: [mapped('contact_id', 'id', 'string'), mapped('email', 'email', 'string'), mapped('score', 'score', 'integer')],
      primaryKey: 'contact_id', title: 'email',
    },
  }, keyed(editor));
  typeId = put.element.id;
  const score = put.element.properties.find((p) => p.apiName === 'score')!.identityId;
  const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Contacts' } }, keyed(editor));
  await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
  await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
  grantId = (await gateway.call(grantConnection, {
    body: { connectionId, grantee: { kind: 'membership', id: viewer.membershipId }, access: 'read' },
  }, cell.as(root))).id;
  setId = (await gateway.call(saveObjectSet, {
    body: { name: 'Engaged contacts', definition: { kind: 'filter', base: { objectTypeId: typeId }, predicate: { cel: 'object.score > 10', properties: [score] } } },
  }, keyed(viewer))).id;
});

after(async () => {
  await cell?.close();
  await new Promise((resolve) => api?.close(resolve));
});

describe('a live subscription (spec 24.3, 30.1 to 30.3)', () => {
  let live: Live;
  let sub: string;
  let seq = 0;

  test('subscribed under the viewer\'s permissions: the set\'s members, granted and withheld fields by name, a snapshot and the source\'s health', async () => {
    live = await connect('viewer@acme.example');
    live.send({ type: 'subscribe', ref: 'r1', set: { kind: 'object_set', id: setId }, properties: ['email', 'score', 'nickname'] });
    const subscribed = await live.next('subscribed');
    sub = subscribed.sub;
    assert.equal(subscribed.objectCount, 2, 'scores above 10: c1 and c2');
    assert.deepEqual(subscribed.fields, { granted: ['email', 'score'], withheld: ['nickname'] });
    assert.deepEqual(subscribed.sources, [connectionId]);
    const snapshot = await live.next('snapshot');
    assert.equal(snapshot.last, true);
    seq = snapshot.seq;
    const byObject = new Map(snapshot.objects.map((o) => [o.object, new Map(o.values.map((v) => [v.property, v.value]))]));
    assert.deepEqual([...byObject.keys()].sort(), [objectOf('c1'), objectOf('c2')].sort());
    assert.equal(byObject.get(objectOf('c1'))!.get('score'), 15);
    assert.equal(byObject.get(objectOf('c2'))!.get('email'), 'grace@example.com');
    const status = await live.next('source_status');
    assert.equal(status.sources[0]!.source, connectionId);
    const { rows: recorded } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select object_count, connection_ids, ended_at from clone.live_subscriptions where membership_id = $1', [viewer.membershipId]));
    assert.equal(recorded.length, 1, 'metadata only, so a lost replica can be told from a live one');
    assert.equal(recorded[0].object_count, 2);
    assert.equal(recorded[0].ended_at, null);
    const opened = (await audited('subscription_opened')).find((e) => e.detail['connection_id'] === connectionId);
    assert.deepEqual([opened?.resource, opened?.detail['objects'], opened?.detail['mode'], opened?.detail['source_object']],
      [{ type: 'object_set', id: setId }, 2, 'live', 'contacts'], 'audited: the set, its source and counts, never its contents');
  });

  test('a provider\'s change reaches the socket with the group\'s next sequence', async () => {
    assert.equal(await deliver([{ id: 'c1', type: 'update', seq: 10, data: { score: 16 } }]), 202);
    const delta = await live.next('delta', (d) => d.object === objectOf('c1'));
    assert.ok(delta.seq > seq, 'sequences only rise');
    seq = delta.seq;
    assert.deepEqual(delta.changes.map((c) => [c.property, c.value, c.source]), [['score', 16, connectionId]]);
  });

  test('a change older than the last applied for its entity is ignored (spec 18.6)', async () => {
    assert.equal(await deliver([{ id: 'c1', type: 'update', seq: 9, data: { score: 1 } }]), 202);
    await live.none('delta', (d) => d.object === objectOf('c1') && d.changes.some((c: { value: unknown }) => c.value === 1), 600);
  });

  test('an object that no longer meets the filter leaves, and is told it came back', async () => {
    assert.equal(await deliver([{ id: 'c2', type: 'update', seq: 11, data: { score: 3 } }]), 202);
    await live.next('delta', (d) => d.object === objectOf('c2'));
    assert.equal((await live.next('membership', (m) => m.object === objectOf('c2'))).change, 'left');
    assert.equal(await deliver([{ id: 'c2', type: 'update', seq: 12, data: { score: 30 } }]), 202);
    assert.equal((await live.next('membership', (m) => m.object === objectOf('c2'))).change, 'entered');
  });

  test('a resync answers with resync_required and a fresh snapshot', async () => {
    // A snapshot a backfill sent earlier is not the answer to this resync.
    live.skip('snapshot');
    live.skip('resync_required');
    live.send({ type: 'resync_required', sub, lastSeq: 1 });
    await live.next('resync_required');
    const snapshot = await live.next('snapshot');
    const c1 = snapshot.objects.find((o) => o.object === objectOf('c1'))!;
    assert.equal(c1.values.find((v) => v.property === 'score')!.value, 16, 'current state, deltas included');
    const [resynced] = await auditedSoon('subscription_resynced', (e) => e.detail['connection_id'] === connectionId);
    assert.deepEqual([resynced?.actor, resynced?.subject, resynced?.detail['last_seq']], [{ kind: 'service', service: 'state-plane' }, viewer.membershipId, 1],
      'audited: the state plane sent the viewer the group anew');

    // The gateway reports a subscriber that fell behind (30.4): snapshot mode is audited, as its holder's; nobody else's report counts.
    assert.deepEqual(await gateway.call(reportLiveBufferMode, { params: { subscriptionId: sub }, body: { mode: 'snapshot' } }, cell.as(viewer)), { recorded: true });
    assert.deepEqual(await gateway.call(reportLiveBufferMode, { params: { subscriptionId: sub }, body: { mode: 'live' } }, cell.as(viewer)), { recorded: false });
    assert.deepEqual(await gateway.call(reportLiveBufferMode, { params: { subscriptionId: sub }, body: { mode: 'snapshot' } }, cell.as(editor)), { recorded: false });
    const snapshots = await audited('subscription_snapshot_mode');
    assert.deepEqual(snapshots.map((e) => [e.actor['membershipId'], e.detail['connection_id']]), [[viewer.membershipId, connectionId]]);
  });

  test('a stream lost and recovered: the group is read again, so a change missed meanwhile arrives in a fresh snapshot (spec 18.5, 18.7)', async () => {
    const config = loadConfig({
      SILO_ENV: 'test', SILO_SERVICE: 'state-plane', SILO_CELL_ID: 'uk-lon-1', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
      SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: cell.h.url('test_app'), REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl,
    });
    const state = await connectRedis('state', config.redis);
    try {
      const key = changeStatusKeys.key(cell.org, { connectionId });
      // The stream goes stale (an outage) and a change is made at the provider that no webhook brings.
      await state.putHash(changeStatusKeys, key, { status: 'stale', source: 'webhook', since: new Date().toISOString(), reason: 'Webhook deliveries stopped' });
      const stale = await live.next('source_status', (f) => f.sources[0]!.reason === 'Webhook deliveries stopped', 8_000);
      assert.equal(stale.sources[0]!.status, 'stale', 'never shown as live while it is not delivering');
      rows.set('c1', { ...rows.get('c1')!, score: 21 });
      await state.putHash(changeStatusKeys, key, { status: 'live', source: 'webhook', since: new Date().toISOString() });
      const scoreOf = (f: { objects: { object: string; values: { property: string; value: unknown }[] }[] }) =>
        f.objects.find((o) => o.object === objectOf('c1'))?.values.find((v) => v.property === 'score')?.value;
      live.skip('source_status');
      const snapshot = await live.next('snapshot', (f) => scoreOf(f) === 21, 8_000);
      assert.equal(scoreOf(snapshot), 21, 'the missed change, read again on recovery');
      assert.equal((await live.next('source_status', (f) => f.sources[0]!.status === 'healthy', 8_000)).sources[0]!.source, connectionId);
      // Written just after the snapshot is published, so looked for a few times.
      const backfilled = await auditedSoon('stream_backfill_completed', (e) => (e.resource as { id: string }).id === connectionId
        && e.detail['reason'] === 'recovered' && e.detail['objects'] === 2);
      assert.ok(backfilled.length > 0, JSON.stringify(await audited('stream_backfill_completed')));
      // source_declared_stale is read first (32.7): when clones stopped being current, for which source, how many objects; recovered says how long.
      const declared = (await auditedSoon('source_declared_stale', (e) => (e.resource as { id: string }).id === connectionId && e.detail['status'] === 'stale')).at(-1);
      const recovered = (await auditedSoon('source_recovered', (e) => (e.resource as { id: string }).id === connectionId && typeof e.detail['stale_ms'] === 'number')).at(-1);
      assert.ok(declared !== undefined && Number(declared.detail['objects']) >= 1 && declared.detail['subscriptions'] === 1, JSON.stringify(declared));
      assert.ok(recovered !== undefined && Number(recovered.detail['stale_ms']) >= 0 && Number(recovered.detail['objects']) >= 1, JSON.stringify(recovered));
    } finally {
      await state.close();
    }
  });

  test('a burst past the connection\'s rate is coalesced: each record\'s latest value each second, marked with how many it stands for (18.4)', async () => {
    live.skip('delta');
    const burst = Array.from({ length: 30 }, (_, i) => ({ id: 'c1', type: 'update', seq: 100 + i, data: { score: 40 + i } }));
    assert.equal(await deliver(burst), 202);
    const last = await live.next('delta', (d) => d.object === objectOf('c1') && d.changes.some((c: { value: unknown }) => c.value === 69), 8_000);
    assert.ok(last.coalesced > 0, 'the clone is told the change stands for others');
    const deltas = live.received('delta').filter((d) => d.object === objectOf('c1'));
    assert.ok(deltas.length < 30, `fewer frames than changes: ${deltas.length}`);
    const coalesced = await auditedSoon('stream_coalesced', (e) => (e.resource as { id: string }).id === connectionId);
    assert.equal(coalesced.length, 1, 'once for the episode');
    assert.equal(coalesced[0]!.detail['threshold'], 10);
  });

  test('revoking the viewer\'s grant withholds every field within seconds and ends the subscription (spec 30.1)', async () => {
    await gateway.call(revokeConnectionGrant, { params: { grantId } }, cell.as(root));
    const changed = await live.next('projection_changed', undefined, 8_000);
    assert.deepEqual(changed.granted, []);
    assert.deepEqual(changed.withheld, ['email', 'nickname', 'score']);
    assert.equal(await deliver([{ id: 'c1', type: 'update', seq: 20, data: { score: 17 } }]), 202);
    await live.none('delta', (d) => d.changes.some((c: { value: unknown }) => c.value === 17), 600);
    const { rows: ended } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select end_reason from clone.live_subscriptions where membership_id = $1', [viewer.membershipId]));
    assert.equal(ended[0].end_reason, 'revoked');
    const [narrowed] = await auditedSoon('subscription_projection_changed', (e) => e.subject === viewer.membershipId);
    assert.deepEqual([narrowed?.detail['granted'], narrowed?.detail['withheld'], narrowed?.detail['ended']], [0, 3, true], 'the policy change, by count, audited');
    const closed_ = await audited('subscription_closed');
    assert.deepEqual(closed_.map((e) => e.detail['reason']), ['revoked'], 'audited once');
    const closed = await live.next('unsubscribe', (u) => u.sub === sub, 5_000);
    assert.equal(closed.reason, 'ended', 'the gateway ends it at its next renewal, so the client knows');
    live.ws.close();
  });
});

describe('refusals (spec 30.3, 30.5)', () => {
  test('never a silent partial subscription: unresolvable, not permitted, and over a bound, each named', async () => {
    const live = await connect('root@acme.example');
    live.send({ type: 'subscribe', ref: 'view', set: { kind: 'view', id: uuidv7() }, properties: ['email'] });
    assert.equal((await live.next('refused', (r) => r.ref === 'view')).reason, 'unresolvable');
    live.send({ type: 'subscribe', ref: 'missing', set: { kind: 'object_set', id: uuidv7() }, properties: ['email'] });
    assert.equal((await live.next('refused', (r) => r.ref === 'missing')).reason, 'unresolvable');
    live.send({ type: 'subscribe', ref: 'private', set: { kind: 'object_set', id: setId }, properties: ['email'] });
    assert.equal((await live.next('refused', (r) => r.ref === 'private')).reason, 'unresolvable', 'another member\'s private set does not exist for them');
    live.ws.close();

    const viewerLive = await connect('viewer@acme.example');
    const many = Array.from({ length: 65 }, (_, i) => `p${i}`);
    viewerLive.send({ type: 'subscribe', ref: 'wide', set: { kind: 'object_set', id: setId }, properties: many });
    const wide = await viewerLive.next('refused', (r) => r.ref === 'wide');
    assert.deepEqual([wide.reason, wide.bound, wide.limit], ['bound', 'watched_properties_per_type', 64]);
    // The viewer's grant is gone: the connection is out of reach.
    viewerLive.send({ type: 'subscribe', ref: 'denied', set: { kind: 'object_set', id: setId }, properties: ['email'] });
    assert.equal((await viewerLive.next('refused', (r) => r.ref === 'denied')).reason, 'permission');
    viewerLive.ws.close();
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select count(*)::int as n from platform.outbox where organisation_id = $1 and payload->>'event' = 'subscription_refused_bound'`, [cell.org]));
    assert.ok(rows[0].n >= 1, 'a bound refusal is audited');
  });
});

describe('coalescing a record\'s changes (18.4, 18.6)', () => {
  test('each property its latest value, in the record\'s order; a deletion wins unless the record changed after it', () => {
    const at = (n: number) => new Date(Date.UTC(2026, 10, 18, 0, 0, n)).toISOString();
    const change = (seq: number, operation: 'update' | 'delete', changed: Record<string, unknown> = {}) => ({
      organisationId: uuidv7(), connectionId: uuidv7(), manifestVersion: '1', object: 'contacts', entityRef: 'c1', operation, changed: changed as never,
      observedAt: at(seq), sourceAt: null, sourceSeq: String(seq), ordering: 'source_sequence' as const, source: 'webhook' as const, markings: [] as string[],
    });
    const one = merged([change(3, 'update', { score: 3 }), change(1, 'update', { score: 1, email: 'a@example.com' }), change(2, 'update', { email: 'b@example.com' })]);
    assert.deepEqual([one.sourceSeq, one.changed], ['3', { score: 3, email: 'b@example.com' }], 'by sequence, not by arrival');
    assert.equal(merged([change(1, 'update', { score: 1 }), change(2, 'delete')]).operation, 'delete');
    const after = merged([change(1, 'update', { score: 1 }), change(2, 'delete'), change(3, 'update', { score: 3 })]);
    assert.deepEqual([after.operation, after.changed], ['update', { score: 3 }], 'only what changed since the deletion');
  });
});
