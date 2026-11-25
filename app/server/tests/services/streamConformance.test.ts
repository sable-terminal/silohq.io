// The change-stream class and the subscribable gate (spec 17.2; decision 2026-11-15): a stream is
// subscribable when its events are ordered, deduplicated, resumable from a watermark or
// sequence, and signal deletes, shown by a test record Silo creates, edits twice and deletes
// in the source while change-stream watches. What is not subscribable is refused to live
// viewers, unless an admin lets it be polled within the connector's rate limit; it is then
// subscribed as not live, refreshed every N minutes.
// Real processes: credential, policy, auth, connect-registry, ontology, connect-runtime,
// change-stream, conformance, state-plane; a fake help desk whose records carry a sequence and
// keep a deleted flag, and which sends signed deliveries for one connection.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { enableStream, getStreamStatus, receiveChangeWebhook, setPollingFallback } from '../../src/contracts/change-stream/stream.contract.ts';
import { startChangeStreamClass } from '../../src/contracts/conformance/changeStreamClass.contract.ts';
import { getConformanceRun, type ConformanceRunView } from '../../src/contracts/conformance/conformance.contract.ts';
import { changeConnectionStatus, createConnection, setConnectionSecrets } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { putObjectType } from '../../src/contracts/ontology/element.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { approveProposal, mergeProposal, openBranch, submitProposal } from '../../src/contracts/ontology/proposal.contract.ts';
import { closeLiveSubscription, openLiveSubscription } from '../../src/contracts/state-plane/subscription.contract.ts';
import { loadConfig } from '../../src/config/index.config.ts';
import { connectRedis } from '../../src/infra/redis.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { sourceStatusOf } from '../../src/services/state-plane/sourceStatus.service.ts';
import { createChangeStreamService } from '../../src/routes/change-stream/index.route.ts';
import { service as conformanceService } from '../../src/routes/conformance/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { service as ontologyService } from '../../src/routes/ontology/index.route.ts';
import { createStatePlaneService } from '../../src/routes/state-plane/index.route.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

interface Ticket { id: string; subject: string; status: string; seq: number; deleted: boolean }

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let api: Server;
let apiUrl = '';
const tickets = new Map<string, Ticket>();
let seq = 0;
let nextId = 1;
/** The hooked connection's endpoint: where the help desk sends its signed deliveries. */
let hook: { token: string; secret: string; client: ServiceClient } | undefined;
const connections: Record<'polled' | 'blind' | 'hooked' | 'tight', string> = { polled: '', blind: '', hooked: '', tight: '' };

const keyed = (who: Signed) => ({ ...cell.as(who), idempotencyKey: uuidv7() });

function deliver(events: unknown[]): void {
  if (hook === undefined) return;
  const payload = JSON.stringify({ events });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', hook.secret).update(`${timestamp}.${payload}`).digest('hex');
  void hook.client.call(receiveChangeWebhook, {
    body: { organisationId: cell.org, token: hook.token, payload, headers: { 'x-timestamp': timestamp, 'x-signature': signature } },
  }, { correlationId: uuidv7() }).catch(() => undefined);
}

/**
 * polled: polls by sequence and reads the deleted flag; blind: polls by sequence and cannot see
 * a delete; hooked: signed deliveries only; tight: like blind, under a tight declared rate limit.
 */
function ticketsManifest(variant: keyof typeof connections) {
  return doc({
    schemaVersion: '1',
    identity: { name: 'Example desk', provider: 'Example', version: '1.0.0' },
    transport: { viaAgent: false, baseUrl: variant === 'hooked' ? `${apiUrl}/hooked` : apiUrl },
    protocol: { kind: 'rest' },
    auth: { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] },
    ...(variant === 'tight' ? { limits: { requestsPerSecond: 0.1, maxAttempts: 3 } } : {}),
    objects: [{
      name: 'tickets', identifier: ['id'],
      fields: [
        { name: 'id', type: 'string', nullable: false }, { name: 'subject', type: 'string' }, { name: 'status', type: 'string' },
        { name: 'seq', type: 'integer' }, { name: 'deleted', type: 'boolean' },
      ],
      source: { kind: 'rest', request: { method: 'GET', path: '/v1/tickets', query: {} }, records: { jsonata: 'results' } },
      pushdown: { filters: [
        { field: 'seq', ops: ['gt'], patch: { cel: '{"query": {"since": string(value)}}' } },
        { field: 'id', ops: ['eq'], patch: { cel: '{"query": {"id": string(value)}}' } },
      ] },
      writes: {
        create: { request: { method: 'POST', path: '/v1/tickets' }, body: { jsonata: '{"properties": $}' }, result: { jsonata: 'id' } },
        update: { request: { method: 'PATCH', path: '/v1/tickets/{identifier}' }, body: { jsonata: '{"properties": $}' } },
        delete: { request: { method: 'DELETE', path: '/v1/tickets/{identifier}' } },
        bounds: { maxRows: 50 },
      },
    }],
    changeStream: variant === 'hooked' ? {
      webhook: {
        verify: { cel: '{"expected": hex(hmac_sha256(secret.webhook, headers["x-timestamp"] + "." + body)), "provided": headers["x-signature"], "signedAt": int(headers["x-timestamp"])}' },
        decode: { jsonata: '[events.{"object": "tickets", "entityRef": id, "operation": type, "changed": data, "sourceSeq": $string(seq)}]' },
      },
      objects: [{ object: 'tickets', sources: [{ kind: 'webhook' }], ordering: 'source_sequence' }],
    } : {
      objects: [{ object: 'tickets', sources: [{ kind: 'poll', intervalSeconds: 60, watermarkField: 'seq', ...(variant === 'polled' ? { deletedField: 'deleted' } : {}) }] }],
    },
  });
}

async function connectionFor(variant: keyof typeof connections): Promise<string> {
  const connector = await gateway.call(createConnector, { body: { slug: `desk-${variant}`, name: `Desk ${variant}`, provider: 'Example', sourceRoute: 'visual' } }, keyed(root));
  await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: ticketsManifest(variant) } }, keyed(root));
  let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: `Desk ${variant}`, owningScopeId: cell.scopes['engineering']! } }, keyed(root));
  await gateway.call(setConnectionSecrets, { params: { connectionId: connection.id }, body: { values: { token: 'tok_valid' } } }, cell.as(root));
  // The tight one is only ever asked to poll, never read: a draft is enough.
  if (variant === 'tight') return connection.id;
  for (const move of ['probe', 'confirm', 'activate'] as const) {
    if (move === 'confirm') await cell.passConformance(connection.id);
    connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
  }
  return connection.id;
}

/** Runs the class on a connection's tickets and waits for it to complete. */
async function runClass(connectionId: string): Promise<ConformanceRunView> {
  const started = await gateway.call(startChangeStreamClass, {
    params: { connectionId },
    body: { object: 'tickets', create: { subject: 'Sandbox', status: 'open' }, updates: [{ status: 'pending' }, { status: 'solved' }] },
  }, keyed(root));
  assert.equal(started.status, 'running');
  assert.deepEqual(started.classesRun, ['change_stream']);
  for (let i = 0; i < 300; i += 1) {
    const run = await gateway.call(getConformanceRun, { params: { runId: started.id } }, cell.as(root));
    if (run.status !== 'running') return run;
    await sleep(100);
  }
  throw new Error('the change-stream class did not complete');
}

const outcomes = (run: ConformanceRunView) => run.tests.map((t) => `${t.id.split('.')[1]}:${t.outcome}${t.reason === null ? '' : `:${t.reason}`}`);
const status = (connectionId: string) => gateway.call(getStreamStatus, { params: { connectionId } }, cell.as(root));

before(async () => {
  api = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer tok_valid') return send(401, {});
    const hooked = url.pathname.startsWith('/hooked/');
    const path = hooked ? url.pathname.slice('/hooked'.length) : url.pathname;
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const props = ((raw === '' ? {} : JSON.parse(raw)) as { properties?: Partial<Ticket> }).properties ?? {};
      if (req.method === 'GET' && path === '/v1/tickets') {
        const since = url.searchParams.get('since');
        const id = url.searchParams.get('id');
        const rows = [...tickets.values()].filter((t) => (since === null || t.seq > Number(since)) && (id === null || t.id === id)).sort((a, b) => a.seq - b.seq);
        return send(200, { results: rows });
      }
      if (req.method === 'POST' && path === '/v1/tickets') {
        const ticket: Ticket = { id: `t${nextId++}`, subject: props.subject ?? '', status: props.status ?? 'open', seq: ++seq, deleted: false };
        tickets.set(ticket.id, ticket);
        if (hooked) deliver([{ id: ticket.id, type: 'insert', data: { subject: ticket.subject, status: ticket.status }, seq: ticket.seq }]);
        return send(201, { id: ticket.id });
      }
      const match = /^\/v1\/tickets\/([^/]+)$/.exec(path);
      const found = match === null ? undefined : tickets.get(decodeURIComponent(match[1]!));
      if (found === undefined || found.deleted) return send(404, {});
      if (req.method === 'PATCH') {
        if (props.subject !== undefined) found.subject = props.subject;
        if (props.status !== undefined) found.status = props.status;
        found.seq = ++seq;
        if (hooked) deliver([{ id: found.id, type: 'update', data: props, seq: found.seq }]);
        return send(200, found);
      }
      if (req.method === 'DELETE') {
        // Kept with its flag set, as many help desks keep a deleted ticket.
        found.deleted = true;
        found.seq = ++seq;
        if (hooked) deliver([{ id: found.id, type: 'delete', data: {}, seq: found.seq }]);
        return send(204, undefined);
      }
      return send(404, {});
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  tickets.set('t0', { id: 't0', subject: 'Printer', status: 'open', seq: ++seq, deleted: false });

  cell = await createConnectCell();
  const live = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
  await cell.start(ontologyService, 'ontology', 'test_app');
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(createChangeStreamService({ tickMs: 150 }), 'change-stream', 'test_app', live);
  await cell.start(conformanceService, 'conformance', 'test_app', { CONFORMANCE_STREAM_WAIT_MS: '3000', CONFORMANCE_STREAM_POLL_MS: '100' });
  await cell.start(createStatePlaneService({ watchMs: 300 }), 'state-plane', 'test_app', live);
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
  for (const variant of Object.keys(connections) as (keyof typeof connections)[]) connections[variant] = await connectionFor(variant);
  const enabled = await gateway.call(enableStream, { params: { connectionId: connections.hooked }, body: {} }, cell.as(root));
  hook = { token: enabled.webhook!.path.split('/').at(-1)!, secret: enabled.webhook!.secret!, client: cell.client('gateway') };
});

after(async () => {
  await cell?.close();
  await new Promise((resolve) => api?.close(resolve));
});

describe('the change-stream class (spec 17.2, decision 2026-11-15)', () => {
  test('a poll by sequence that reads the deleted flag keeps order, drops repeats, resumes, and signals the delete: subscribable', async () => {
    assert.deepEqual((await status(connections.polled)).objects.map((o) => [o.subscribable, o.mode, o.conformanceRunId]), [[false, 'unavailable', null]]);
    const run = await runClass(connections.polled);
    assert.deepEqual(outcomes(run), [
      'delta:passed', 'ordered:passed', 'deduplicated:passed', 'resumable:passed', 'deletes:passed', 'signature:not_applicable:not_a_signed_source',
    ]);
    const object = (await status(connections.polled)).objects[0]!;
    assert.deepEqual([object.subscribable, object.mode, object.conformanceRunId, object.failedTests], [true, 'live', run.id, []]);
    // The test record is the run's, by identifier, and nothing of its values is recorded.
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select test_record_ref, results::text as results from connect.conformance_runs where id = $1', [run.id]));
    assert.match(rows[0].test_record_ref, /^t\d+$/);
    assert.ok(!/Sandbox|pending|solved/.test(rows[0].results), 'no value in the results');
    assert.equal(tickets.get(rows[0].test_record_ref)?.deleted, true, 'the test record was deleted');
  });

  test('a poll that cannot see a delete is not subscribable, and says which test it failed', async () => {
    const run = await runClass(connections.blind);
    assert.deepEqual(outcomes(run), [
      'delta:passed', 'ordered:passed', 'deduplicated:passed', 'resumable:passed', 'deletes:failed:delete_not_signalled',
      'signature:not_applicable:not_a_signed_source',
    ]);
    const object = (await status(connections.blind)).objects[0]!;
    assert.deepEqual([object.subscribable, object.mode, object.failedTests], [false, 'unavailable', ['deletes']]);
  });

  test('a signed webhook: ordered by sequence, deduplicated by it, signals deletes, refuses a forged delivery; alone it cannot resume', async () => {
    const run = await runClass(connections.hooked);
    assert.deepEqual(outcomes(run), [
      'delta:passed', 'ordered:passed', 'deduplicated:passed', 'resumable:failed:no_resume_source', 'deletes:passed', 'signature:passed',
    ]);
    const object = (await status(connections.hooked)).objects[0]!;
    assert.deepEqual([object.subscribable, object.failedTests], [false, ['resumable']]);
  });

  test('the class needs an object that is streamed', async () => {
    await assert.rejects(gateway.call(startChangeStreamClass, {
      params: { connectionId: connections.polled }, body: { object: 'invoices', create: { a: 1 }, updates: [{ a: 2 }, { a: 3 }] },
    }, keyed(root)), { code: 'step.object_unknown' });
    await assert.rejects(gateway.call(startChangeStreamClass, {
      params: { connectionId: connections.polled }, body: { object: 'tickets', create: { subject: 'x' }, updates: [{ status: 'a' }, { status: 'a' }] },
    }, keyed(root)), { code: 'contract.request_invalid' });
  });
});

describe('the subscribable gate (decision 2026-11-15)', () => {
  let setId = '';
  const subscribe = (id: string) => gateway.call(openLiveSubscription, {
    body: { subscriptionId: id, set: { kind: 'object_set', id: setId }, properties: ['subject', 'status'] },
  }, cell.as(root));

  before(async () => {
    // A ticket type over the help desk that cannot see deletes, proposed by an editor and
    // approved by root, and a saved set of it.
    const editor = await cell.member('editor@acme.example', 'Super admin');
    const branch = await gateway.call(openBranch, { body: { name: 'tickets' } }, keyed(editor));
    const mapped = (apiName: string, field: string) => ({
      apiName, displayName: apiName, dataType: 'string' as const, mappings: [{ connectionId: connections.blind, sourceObject: 'tickets', fieldPath: field }],
    });
    const put = await gateway.call(putObjectType, {
      params: { branchId: branch.id, apiName: 'ticket' },
      body: {
        displayName: 'Ticket', pluralName: 'Tickets', contributingObjects: [{ connectionId: connections.blind, sourceObject: 'tickets', identifierFieldPath: 'id' }],
        properties: [mapped('ticket_id', 'id'), mapped('subject', 'subject'), mapped('status', 'status')], primaryKey: 'ticket_id', title: 'subject',
      },
    }, keyed(editor));
    const proposal = await gateway.call(submitProposal, { params: { branchId: branch.id }, body: { title: 'Tickets' } }, keyed(editor));
    await gateway.call(approveProposal, { params: { proposalId: proposal.id }, body: { permission: 'ontology.confirm' } }, cell.as(root));
    await gateway.call(mergeProposal, { params: { proposalId: proposal.id } }, keyed(root));
    setId = (await gateway.call(saveObjectSet, {
      body: { name: 'All tickets', definition: { kind: 'filter', base: { objectTypeId: put.element.id }, predicate: { cel: 'true', properties: [] } } },
    }, keyed(root))).id;
  });

  test('a set over a stream that is not subscribable is refused to a live viewer', async () => {
    assert.deepEqual(await subscribe('s_blind_1'), { outcome: 'refused', reason: 'not_subscribable' });
  });

  test('an admin may let it be polled, given a watermark and room in the rate limit; never what already streams live', async () => {
    const fallback = (connectionId: string, body: { enabled: boolean; intervalMinutes?: number }) =>
      gateway.call(setPollingFallback, { params: { connectionId, object: 'tickets' }, body }, cell.as(root));
    await assert.rejects(fallback(connections.hooked, { enabled: true, intervalMinutes: 5 }), { code: 'stream.no_watermark' });
    await assert.rejects(fallback(connections.polled, { enabled: true, intervalMinutes: 5 }), { code: 'stream.subscribable' });
    // A tenth of 0.1 requests a second is 0.6 polls a minute: once a minute is too often, every two minutes is not.
    await assert.rejects(fallback(connections.tight, { enabled: true, intervalMinutes: 1 }), { code: 'stream.rate_limit_insufficient' });
    assert.equal((await fallback(connections.tight, { enabled: true, intervalMinutes: 2 })).objects[0]!.mode, 'polled');
    const object = (await fallback(connections.blind, { enabled: true, intervalMinutes: 5 })).objects[0]!;
    assert.deepEqual([object.subscribable, object.mode, object.refreshEverySeconds], [false, 'polled', 300]);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `select payload ->> 'event' as event, payload -> 'detail' as detail from platform.outbox
       where payload ->> 'event' = 'polling_fallback_enabled' order by created_at`, []));
    assert.deepEqual(rows.map((r: { detail: { object: string; interval_seconds: number } }) => [r.detail.object, r.detail.interval_seconds]), [['tickets', 120], ['tickets', 300]]);
  });

  test('then it is subscribed as polled, and its source says it is not live, how often it is refreshed, and how stale it is', async () => {
    const out = await subscribe('s_blind_2');
    assert.equal(out.outcome, 'subscribed', JSON.stringify(out));
    if (out.outcome !== 'subscribed') return;
    // Every ticket the help desk holds, the deleted ones too: this source cannot tell them apart.
    assert.deepEqual([out.mode, out.refreshEverySeconds, out.objectCount], ['polled', 300, tickets.size]);
    // The source status a polled clone is sent: not live, how often, and the age of the last refresh.
    const config = loadConfig({
      SILO_ENV: 'test', SILO_SERVICE: 'state-plane', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
      SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: cell.h.url('test_app'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`,
      REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl,
    });
    const state = await connectRedis('state', config.redis);
    try {
      const shown = await sourceStatusOf(state, cell.org, connections.blind, Date.now(), { sourceObject: 'tickets', refreshEverySeconds: 300 });
      assert.deepEqual([shown.status, shown.refreshEverySeconds, shown.reason], ['not_live', 300, 'Not live, refreshed every 5 minutes']);
    } finally {
      await state.close();
    }
    await gateway.call(closeLiveSubscription, { params: { subscriptionId: 's_blind_2' } }, cell.as(root));
  });

  test('disabling the fallback refuses the set again', async () => {
    await gateway.call(setPollingFallback, { params: { connectionId: connections.blind, object: 'tickets' }, body: { enabled: false } }, cell.as(root));
    assert.equal((await status(connections.blind)).objects[0]!.mode, 'unavailable');
    assert.deepEqual(await subscribe('s_blind_3'), { outcome: 'refused', reason: 'not_subscribable' });
  });
});
