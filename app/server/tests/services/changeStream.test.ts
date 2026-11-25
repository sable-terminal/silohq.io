// change-stream end to end (spec 18): the manifest's change-stream block; enabling a
// connection's stream (the path token and a generated secret shown once, stream.enable for
// anyone but the owner); a provider's deliveries through the real gateway, verified by the
// credential service before anything is decoded, refused unsigned, replayed or for an
// unknown token; decoding into deltas on bus-live with only declared fields, de-duplicated
// and published only where the state plane holds the object live; change epochs for result
// cache invalidation; polling with a watermark through connect-runtime, the fallback from a
// silent webhook, and a failing source marked stale; rotating and disabling.
// Real processes: credential, policy, auth, connect-registry, connect-runtime, change-stream,
// gateway, with a fake provider API.

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import { sourceChange, type SourceChange } from '../../src/contracts/change-stream/delta.contract.ts';
import {
  disableStream, enableStream, getStreamStatus, pauseStream, resumeStream, rotateWebhookSecret,
} from '../../src/contracts/change-stream/stream.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { connectLiveBus, type LiveBus } from '../../src/infra/bus.infra.ts';
import {
  changeStatusKeys, changeWatermarkKeys, readChangeEpochs, registerChangeInterest,
} from '../../src/infra/keyspaces.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createChangeStreamService } from '../../src/routes/change-stream/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let member: Signed;
let api: Server;
let apiUrl: string;
let edge: string;
let bus: LiveBus;
let state: RedisStore;
let data: RedisStore;
const received: SourceChange[] = [];
let failReads = false;

// The fake provider: contacts, each with an update time, filtered and sorted as the manifest asks.
const contacts = new Map<string, { id: string; email: string; score: number; updated_at: string; internal: string }>([
  ['c1', { id: 'c1', email: 'ada@example.com', score: 10, updated_at: '2026-11-01T10:00:00.000Z', internal: 'x' }],
  ['c2', { id: 'c2', email: 'grace@example.com', score: 20, updated_at: '2026-11-01T11:00:00.000Z', internal: 'y' }],
]);

const objects = (sources: unknown[]) => [{
  name: 'contacts', identifier: ['id'],
  fields: [
    { name: 'id', type: 'string', nullable: false }, { name: 'email', type: 'string' }, { name: 'score', type: 'integer' },
    { name: 'updated_at', type: 'date-time' },
  ],
  source: { kind: 'rest', request: { method: 'GET', path: '/v1/contacts', query: {} }, records: { jsonata: 'results' } },
  pushdown: {
    filters: [{ field: 'updated_at', ops: ['gt'], patch: { cel: '{"query": {"updated_after": string(value)}}' } }],
    sort: [{ field: 'updated_at', patch: { cel: '{"query": {"sort": (direction == "desc" ? "-" : "") + field}}' } }],
    limit: { patch: { cel: '{"query": {"limit": string(limit)}}' } },
  },
  _sources: sources,
}];

const VERIFY = '{"expected": hex(hmac_sha256(secret.webhook, headers["x-timestamp"] + "." + body)), "provided": headers["x-signature"], '
  + '"signedAt": int(headers["x-timestamp"])}';
const DECODE = '[events.{"object": object, "entityRef": id, "operation": type, "changed": data, "sourceSeq": seq}]';

function manifest(version: string, options: { webhook?: boolean; poll?: boolean; heartbeat?: number } = {}) {
  const sources = [
    ...(options.webhook === false ? [] : [{ kind: 'webhook' }]),
    ...(options.poll === false ? [] : [{ kind: 'poll', intervalSeconds: 60, watermarkField: 'updated_at' }]),
  ];
  const [contactsObject] = objects(sources);
  const { _sources: _, ...object } = contactsObject!;
  return doc({
    schemaVersion: '1',
    identity: { name: 'Example CRM', provider: 'Example', version },
    transport: { viaAgent: false, baseUrl: apiUrl },
    protocol: { kind: 'rest' },
    auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
    objects: [object],
    changeStream: {
      ...(options.webhook === false ? {} : {
        webhook: { verify: { cel: VERIFY }, decode: { jsonata: DECODE }, ...(options.heartbeat ? { heartbeatSeconds: options.heartbeat } : {}) },
      }),
      objects: [{ object: 'contacts', sources, ordering: 'source_sequence' }],
    },
  });
}

async function activeConnection(document: Record<string, never>): Promise<string> {
  const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
  const connector = await gateway.call(createConnector, { body: { slug: `c-${uuidv7().slice(-12)}`, name: 'CRM', provider: 'Example', sourceRoute: 'visual' } }, keyed());
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document } }, keyed());
  let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'CRM', owningScopeId: cell.scopes['engineering']! } }, keyed());
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
  }
  return connection.id;
}

/** A provider's delivery to the public path, signed with the secret at the given time. */
async function deliver(path: string, secret: string | undefined, events: unknown[], options: { at?: number; signature?: string } = {}) {
  const body = JSON.stringify({ events });
  const timestamp = String(options.at ?? Math.floor(Date.now() / 1000));
  const signature = options.signature ?? (secret === undefined ? undefined : createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'));
  const res = await fetch(`${edge}${path}`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-timestamp': timestamp, ...(signature === undefined ? {} : { 'x-signature': signature }), 'x-forwarded-for': '203.0.113.9' },
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const outboxEvents = async (): Promise<string[]> => {
  const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `select payload->>'event' as event from platform.outbox where organisation_id = $1 and event = 'audit_event' order by created_at, id`, [cell.org]));
  return rows.map((r) => r.event as string);
};

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.headers.authorization !== 'Bearer tok_valid' || failReads) {
      res.writeHead(failReads ? 503 : 401, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    let rows = [...contacts.values()];
    const after = url.searchParams.get('updated_after');
    if (after !== null) rows = rows.filter((r) => r.updated_at > after);
    const sort = url.searchParams.get('sort');
    if (sort === 'updated_at') rows.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    if (sort === '-updated_at') rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const limit = Number(url.searchParams.get('limit') ?? '1000');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: rows.slice(0, limit) }));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

  cell = await createConnectCell();
  const live = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(createChangeStreamService({ tickMs: 150 }), 'change-stream', 'test_app', live);
  let port = 0;
  await cell.start(createGatewayService({ onListening: (p) => { port = p; } }), 'gateway', 'test_app', {
    ...live, GATEWAY_PUBLIC_ORIGIN: 'https://app.silo.test', GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
    IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
  });
  edge = `http://127.0.0.1:${port}`;
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  member = await cell.member('member@acme.example', 'Member', 'engineering');

  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'change-stream', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: cell.h.url('test_app'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, ...live,
  });
  bus = await connectLiveBus(config.bus, 'test');
  bus.subscribe(sourceChange, 'chg.>', (delta) => {
    if (delta.organisationId === cell.org) received.push(delta);
  });
  await bus.flush();
  state = await connectRedis('state', config.redis);
  data = await connectRedis('data', config.redis);
});

after(async () => {
  await bus?.close();
  await state?.close();
  await data?.close();
  await cell?.close();
  await new Promise((resolve) => api?.close(resolve));
});

describe('the change stream block of a manifest (spec 18.1, 18.6)', () => {
  test('a webhook needs its block, a poll a watermark the source filters with gt, and every expression must compile', async () => {
    const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
    const connector = await gateway.call(createConnector, { body: { slug: `bad-${uuidv7().slice(-10)}`, name: 'Bad', provider: 'Example', sourceRoute: 'visual' } }, keyed());
    const put = (document: object) => gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: document as never } }, keyed());
    const base = manifest('1.0.0') as unknown as Record<string, any>;
    await assert.rejects(put({ ...base, changeStream: { objects: base.changeStream.objects } }), { code: 'manifest.invalid' });
    await assert.rejects(put({ ...base, changeStream: { ...base.changeStream, objects: [{ object: 'contacts', sources: [{ kind: 'poll', intervalSeconds: 60, watermarkField: 'email' }] }] } }),
      { code: 'manifest.invalid' });
    await assert.rejects(put({ ...base, changeStream: { ...base.changeStream, objects: [{ object: 'contacts', sources: [{ kind: 'poll', intervalSeconds: 30, watermarkField: 'updated_at' }] }] } }),
      { code: 'manifest.invalid' }, 'polling at least every 60 seconds');
    await assert.rejects(put({ ...base, changeStream: { ...base.changeStream, webhook: { ...base.changeStream.webhook, verify: { cel: 'secret.webhook ==' } } } }),
      { code: 'manifest.expression_invalid' });
    await assert.rejects(put({ ...base, changeStream: { ...base.changeStream, objects: [{ ...base.changeStream.objects[0], dedupKey: { cel: 'secret.webhook' } }] } }),
      { code: 'manifest.expression_invalid' }, 'only verify may name the secret');
    await assert.rejects(put({ ...base, changeStream: { ...base.changeStream, webhook: { ...base.changeStream.webhook, decode: { jsonata: '$eval("1")' } } } }),
      { code: 'manifest.expression_invalid' });
  });
});

describe('enabling and managing a stream (spec 18.8, 18.10)', () => {
  let connectionId: string;

  before(async () => {
    connectionId = await activeConnection(manifest('1.0.0'));
  });

  test('stream.enable for anyone but the owner; the owner gets the path and a generated secret, once', async () => {
    await assert.rejects(gateway.call(enableStream, { params: { connectionId }, body: {} }, cell.as(member)), { code: 'stream.not_permitted' });
    const enabled = await gateway.call(enableStream, { params: { connectionId }, body: {} }, cell.as(root));
    assert.match(enabled.webhook!.path, new RegExp(`^/api/v1/hooks/changes/${cell.org}/[A-Za-z0-9_-]{43}$`));
    assert.ok(enabled.webhook!.secret && enabled.webhook!.secret.length >= 40, 'a generated secret, shown once');
    assert.equal(enabled.stream.webhook!.status, 'active');
    assert.equal(enabled.stream.webhook!.lastFour, enabled.webhook!.secret!.slice(-4));
    assert.deepEqual(enabled.stream.objects.map((o) => [o.object, o.inUse]), [['contacts', 'webhook']]);
    await assert.rejects(gateway.call(enableStream, { params: { connectionId }, body: {} }, cell.as(root)), { code: 'stream.already_enabled' });
    const status = await gateway.call(getStreamStatus, { params: { connectionId } }, cell.as(root));
    assert.equal(status.webhook!.rejectedCount, 0);
    const events = await outboxEvents();
    for (const event of ['webhook_registered', 'stream_enabled']) assert.ok(events.includes(event), event);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select count(*)::int as n from connect.connection_credentials_safe where connection_id = $1 and field_name = 'webhook_signing_secret' and revoked_at is null`,
      [connectionId]));
    assert.equal(rows[0].n, 1, 'the secret is a sealed connection credential');
  });

  describe('deliveries through the gateway (spec 18.2, 18.3, 18.6, 18.8)', () => {
    let path: string;
    let secret: string;

    before(async () => {
      await gateway.call(disableStream, { params: { connectionId } }, cell.as(root));
      const enabled = await gateway.call(enableStream, { params: { connectionId }, body: { secret: 'provider-issued-signing-secret-1' } }, cell.as(root));
      path = enabled.webhook!.path;
      secret = 'provider-issued-signing-secret-1';
      assert.equal(enabled.webhook!.secret, undefined, 'a provider\'s own secret is never shown back');
      await registerChangeInterest(state, CELL_ID, cell.org, connectionId, ['contacts']);
    });

    test('a signed delivery becomes deltas with declared fields only, live where held; a repeat is dropped', async () => {
      const before = (await readChangeEpochs(data, cell.org, [{ connectionId, sourceObject: 'contacts' }]))[0]!;
      const event = { object: 'contacts', id: 'c1', type: 'update', seq: 101, data: { score: 11, internal: 'never', email: 'ada@example.com' } };
      const reply = await deliver(path, secret, [event, { object: 'invoices', id: 'i1', type: 'insert', seq: 1, data: {} }]);
      assert.equal(reply.status, 202);
      assert.deepEqual(reply.body, { received: true }, 'the provider learns nothing more');
      const delta = await until('the delta', () => received.find((d) => d.connectionId === connectionId && d.entityRef === 'c1' && d.sourceSeq === '101'));
      assert.equal(delta.operation, 'update');
      assert.deepEqual(delta.changed, { score: 11, email: 'ada@example.com' }, 'only fields the manifest declares');
      assert.equal(delta.ordering, 'source_sequence');
      assert.equal(delta.source, 'webhook');
      assert.equal(received.filter((d) => d.object === 'invoices').length, 0, 'an object the manifest does not stream is discarded');
      const after = (await readChangeEpochs(data, cell.org, [{ connectionId, sourceObject: 'contacts' }]))[0]!;
      assert.ok(after > before, 'cached results over contacts stop matching (spec 24.6)');

      const count = received.length;
      assert.equal((await deliver(path, secret, [event])).status, 202);
      await sleep(300);
      assert.equal(received.length, count, 'the same event within ten minutes is a duplicate');
      const health = await state.readHash(changeStatusKeys, changeStatusKeys.key(cell.org, { connectionId }));
      assert.equal(health?.status, 'live');
      assert.equal(health?.source, 'webhook');
    });

    test('nothing is published for an object no one holds live, though caches are still invalidated', async () => {
      await state.remove(changeStatusKeys, changeStatusKeys.key(cell.org, { connectionId }));
      const other = await activeConnection(manifest('1.0.1'));
      const enabled = await gateway.call(enableStream, { params: { connectionId: other }, body: {} }, cell.as(root));
      const before = (await readChangeEpochs(data, cell.org, [{ connectionId: other, sourceObject: 'contacts' }]))[0]!;
      const reply = await deliver(enabled.webhook!.path, enabled.webhook!.secret, [{ object: 'contacts', id: 'c2', type: 'update', seq: 5, data: { score: 1 } }]);
      assert.equal(reply.status, 202);
      await sleep(300);
      assert.equal(received.filter((d) => d.connectionId === other).length, 0);
      assert.equal((await readChangeEpochs(data, cell.org, [{ connectionId: other, sourceObject: 'contacts' }]))[0], before + 1);
    });

    test('unsigned, wrongly signed and replayed deliveries are refused and counted; an unknown token is not found', async () => {
      const count = received.length;
      const event = [{ object: 'contacts', id: 'c1', type: 'update', seq: 200, data: { score: 99 } }];
      assert.equal((await deliver(path, undefined, event)).status, 401);
      assert.equal((await deliver(path, secret, event, { signature: 'f'.repeat(64) })).status, 401);
      assert.equal((await deliver(path, secret, event, { at: Math.floor(Date.now() / 1000) - 600 })).status, 401, 'signed ten minutes ago');
      assert.equal((await deliver(path.replace(/[A-Za-z0-9_-]{43}$/, 'A'.repeat(43)), secret, event)).status, 404);
      assert.equal((await deliver(path.replace(cell.org, uuidv7()), secret, event)).status, 404);
      await sleep(300);
      assert.equal(received.length, count, 'a refused body is never decoded');
      const status = await gateway.call(getStreamStatus, { params: { connectionId } }, cell.as(root));
      assert.equal(status.webhook!.rejectedCount, 3);
      assert.ok((await outboxEvents()).includes('webhook_signature_rejected'));
      const browserLike = await fetch(`${edge}${path}`, { method: 'POST', body: '{}', headers: { 'sec-fetch-site': 'cross-site', 'x-forwarded-for': '203.0.113.9' } });
      assert.equal(browserLike.status, 403, 'a browser does not send webhooks');
    });

    test('a paused endpoint routes nothing; resumed, it does; a rotated secret replaces the old one', async () => {
      await gateway.call(pauseStream, { params: { connectionId } }, cell.as(root));
      const event = [{ object: 'contacts', id: 'c2', type: 'update', seq: 300, data: { score: 21 } }];
      assert.equal((await deliver(path, secret, event)).status, 404);
      await gateway.call(resumeStream, { params: { connectionId } }, cell.as(root));
      assert.equal((await deliver(path, secret, event)).status, 202);
      const rotated = await gateway.call(rotateWebhookSecret, { params: { connectionId }, body: {} }, cell.as(root));
      assert.ok(rotated.secret);
      const next = [{ object: 'contacts', id: 'c2', type: 'update', seq: 301, data: { score: 22 } }];
      assert.equal((await deliver(path, secret, next)).status, 401, 'the old secret no longer signs');
      assert.equal((await deliver(path, rotated.secret, next)).status, 202);
      await until('the rotated delivery', () => received.find((d) => d.entityRef === 'c2' && d.sourceSeq === '301'));
      assert.ok((await outboxEvents()).includes('webhook_secret_rotated'));
    });
  });

  describe('polling with a watermark (spec 18.1, 18.7)', () => {
    let pollOnly: string;
    const due = (id: string) => state.put(changeWatermarkKeys, changeWatermarkKeys.key(cell.org, { connectionId: id, object: 'contacts' }),
      { watermark: '2026-11-01T11:00:00.000Z', polledAt: new Date(Date.now() - 120_000).toISOString() });

    before(async () => {
      pollOnly = await activeConnection(manifest('2.0.0', { webhook: false }));
    });

    test('the first poll finds the watermark; a change after it becomes a delta; the watermark moves', async () => {
      await registerChangeInterest(state, CELL_ID, cell.org, pollOnly, ['contacts']);
      const mark = await until('the first watermark', async () =>
        (await state.read(changeWatermarkKeys, changeWatermarkKeys.key(cell.org, { connectionId: pollOnly, object: 'contacts' })))?.watermark ?? undefined);
      assert.equal(mark, '2026-11-01T11:00:00.000Z', 'the latest update time, read once');
      assert.equal(received.filter((d) => d.connectionId === pollOnly).length, 0, 'current state is the snapshot\'s, not a delta');
      contacts.set('c1', { ...contacts.get('c1')!, score: 15, updated_at: '2026-11-01T12:00:00.000Z' });
      await due(pollOnly);
      const delta = await until('the polled delta', () => received.find((d) => d.connectionId === pollOnly && d.entityRef === 'c1'));
      assert.equal(delta.source, 'poll');
      assert.equal(delta.changed['score'], 15);
      assert.equal(delta.sourceSeq, '2026-11-01T12:00:00.000Z');
      const moved = await until('the watermark to move', async () => {
        const w = await state.read(changeWatermarkKeys, changeWatermarkKeys.key(cell.org, { connectionId: pollOnly, object: 'contacts' }));
        return w?.watermark === '2026-11-01T12:00:00.000Z' ? w : undefined;
      });
      assert.ok(moved);
      const status = await gateway.call(getStreamStatus, { params: { connectionId: pollOnly } }, cell.as(root));
      assert.deepEqual(status.objects.map((o) => [o.inUse, o.status]), [['poll', 'live']]);
    });

    test('a failing source marks the stream stale with why; it recovers when the source does', async () => {
      failReads = true;
      await due(pollOnly);
      const stale = await until('stale', async () => {
        const record = await state.readHash(changeStatusKeys, changeStatusKeys.key(cell.org, { connectionId: pollOnly }));
        return record?.status === 'stale' ? record : undefined;
      });
      assert.match(stale.reason ?? '', /^poll failed/);
      failReads = false;
      await due(pollOnly);
      await until('recovered', async () =>
        (await state.readHash(changeStatusKeys, changeStatusKeys.key(cell.org, { connectionId: pollOnly })))?.status === 'live' ? true : undefined);
      const events = await outboxEvents();
      assert.ok(events.includes('stream_stale') && events.includes('stream_recovered'));
    });

    test('a webhook silent past its heartbeat marks the stream delayed and falls back to polling', async () => {
      const both = await activeConnection(manifest('3.0.0', { heartbeat: 60 }));
      await gateway.call(enableStream, { params: { connectionId: both }, body: {} }, cell.as(root));
      await state.putHash(changeStatusKeys, changeStatusKeys.key(cell.org, { connectionId: both }), {
        status: 'live', source: 'webhook', since: new Date(Date.now() - 600_000).toISOString(),
        lastDeliveryAt: new Date(Date.now() - 120_000).toISOString(),
      });
      await registerChangeInterest(state, CELL_ID, cell.org, both, ['contacts']);
      await until('delayed then polled', async () => {
        const status = await gateway.call(getStreamStatus, { params: { connectionId: both } }, cell.as(root));
        return status.objects[0]!.inUse === 'poll' ? status : undefined;
      });
      assert.ok((await outboxEvents()).includes('stream_delayed'));
    });
  });

  test('the browser reaches stream management through the gateway, with stream.manage on the connection', async () => {
    const session = async (email: string) => {
      const res = await fetch(`${edge}/api/v1/sessions`, {
        method: 'POST', body: JSON.stringify({ organisationSlug: 'acme', email, password: 'correct horse battery staple' }),
        headers: { 'content-type': 'application/json', origin: 'https://app.silo.test', 'x-silo-csrf': '1', 'x-forwarded-for': '198.51.100.40' },
      });
      assert.equal(res.status, 201);
      return res.headers.getSetCookie().map((c) => /^__Host-silo_session=([^;]+);/.exec(c)?.[1]).find((c) => c !== undefined)!;
    };
    const read = async (cookie: string) => {
      const res = await fetch(`${edge}/api/v1/connect/connections/${connectionId}/stream`, {
        headers: { cookie: `__Host-silo_session=${cookie}`, 'x-forwarded-for': '198.51.100.40' },
      });
      return { status: res.status, body: await res.json() as { objects?: unknown[] } };
    };
    const owner = await read(await session('root@acme.example'));
    assert.equal(owner.status, 200);
    assert.equal(owner.body.objects?.length, 1);
    assert.equal((await read(await session('member@acme.example'))).status, 403, 'a member without stream.manage');
  });

  test('a route its service decides: the owner renames the connection through the gateway, a member is refused by connect-registry', async () => {
    const cookieOf = async (email: string) => {
      const res = await fetch(`${edge}/api/v1/sessions`, {
        method: 'POST', body: JSON.stringify({ organisationSlug: 'acme', email, password: 'correct horse battery staple' }),
        headers: { 'content-type': 'application/json', origin: 'https://app.silo.test', 'x-silo-csrf': '1', 'x-forwarded-for': '198.51.100.41' },
      });
      return res.headers.getSetCookie().map((c) => /^__Host-silo_session=([^;]+);/.exec(c)?.[1]).find((c) => c !== undefined)!;
    };
    const call = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${edge}/api/v1${path}`, {
      method, headers: {
        cookie: `__Host-silo_session=${cookie}`, 'x-forwarded-for': '198.51.100.41', origin: 'https://app.silo.test', 'x-silo-csrf': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const owner = await cookieOf('root@acme.example');
    const read = await call(owner, 'GET', `/connect/connections/${connectionId}`);
    assert.equal(read.status, 200);
    const { version } = await read.json() as { version: number };
    const member = await cookieOf('member@acme.example');
    const refused = await call(member, 'PATCH', `/connect/connections/${connectionId}`, { name: 'Renamed by a member', version });
    assert.equal(refused.status, 403, 'the gateway forwards; connect-registry refuses');
    const renamed = await call(owner, 'PATCH', `/connect/connections/${connectionId}`, { name: 'CRM (renamed)', version });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json() as { name: string }).name, 'CRM (renamed)');
  });

  test('disabling revokes the endpoint: its path routes nothing', async () => {
    const status = await gateway.call(disableStream, { params: { connectionId } }, cell.as(root));
    assert.equal(status.webhook, null);
    assert.ok((await outboxEvents()).includes('stream_disabled'));
  });
});
