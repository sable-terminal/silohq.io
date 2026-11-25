// Email fallback (spec 14.4, 16.1): a system with no API is connected by its notifications. Its
// manifest declares senders and rules (templates, never patterns); enabling the stream mints an
// address; the cell's mail relay posts each message to the real gateway, signed; a forwarded
// notification is read as itself; a matching rule becomes one change on bus-live, with only
// declared fields, typed; a repeat delivery is dropped by its Message-ID; a message from another
// sender, matching no rule, or without its record's identifier is set aside and changes nothing;
// an unsigned post or an unknown address is refused; reads of such a connection are refused.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import { sourceChange, type SourceChange } from '../../src/contracts/change-stream/delta.contract.ts';
import { disableStream, enableStream } from '../../src/contracts/change-stream/stream.contract.ts';
import { changeConnectionStatus, createConnection } from '../../src/contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { readObject } from '../../src/contracts/connect-runtime/read.contract.ts';
import { connectLiveBus, type LiveBus } from '../../src/infra/bus.infra.ts';
import { registerChangeInterest } from '../../src/infra/keyspaces.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import type { ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { createChangeStreamService } from '../../src/routes/change-stream/index.route.ts';
import { createConnectRuntimeService } from '../../src/routes/connect-runtime/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { confirmBuild, draftConnector, getBuild, probeBuild, type BuildView } from '../../src/contracts/connector-builder/build.contract.ts';
import { service as builderService } from '../../src/routes/connector-builder/index.route.ts';
import { getManifestVersion } from '../../src/contracts/connect-registry/connector.contract.ts';
import { relaySignature } from '../../src/services/change-stream/email.service.ts';
import { after as textAfter, extractNotification, typed } from '../../src/services/change-stream/emailRules.service.ts';
import { parseMessage } from '../../src/utils/mime.util.ts';
import { CELL_ID } from '../db/fixtures.helper.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { createConnectCell, doc, type ConnectCell, type Signed } from './connect.helper.ts';

const DOMAIN = 'inbound.silo.test';
const SECRET = 'relay-signing-secret-that-is-long-enough-1';

const RULES = {
  senders: ['noreply@shipper.example', '@alerts.shipper.example'],
  rules: [
    {
      object: 'shipments', when: [{ on: 'subject', contains: 'has shipped' }],
      fields: [
        { field: 'order_ref', on: 'subject', after: 'Order #', until: 'word' },
        { field: 'carrier', on: 'body', after: 'Carrier:' },
        { field: 'weight_kg', on: 'body', after: 'Weight:', until: 'kg' },
        { field: 'shipped_at', on: 'body', after: 'Shipped on:' },
      ],
    },
    { object: 'shipments', when: [{ on: 'subject', contains: 'cancelled' }], fields: [{ field: 'order_ref', on: 'subject', after: 'Order #', until: 'word' }], op: 'delete' },
  ],
};

const manifest = () => doc({
  schemaVersion: '1',
  identity: { name: 'Shipper notifications', provider: 'Shipper', version: '1.0.0' },
  transport: { viaAgent: false },
  protocol: { kind: 'email' },
  auth: { strategy: 'none', fields: [] },
  objects: [{
    name: 'shipments', identifier: ['order_ref'],
    fields: [
      { name: 'order_ref', type: 'string', nullable: false }, { name: 'carrier', type: 'string' }, { name: 'weight_kg', type: 'number' },
      { name: 'shipped_at', type: 'date-time' },
    ],
    source: { kind: 'email' },
  }],
  changeStream: { email: RULES, objects: [{ object: 'shipments', sources: [{ kind: 'email' }] }] },
});

const message = (o: { from?: string; subject: string; body: string; id?: string; html?: boolean }) => [
  `From: Shipper <${o.from ?? 'noreply@shipper.example'}>`,
  'To: ops@acme.example',
  `Subject: ${o.subject}`,
  'Date: Tue, 17 Nov 2026 09:30:00 +0000',
  `Message-ID: <${o.id ?? uuidv7()}@shipper.example>`,
  'MIME-Version: 1.0',
  `Content-Type: ${o.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
  '',
  o.body,
].join('\r\n');

describe('reading a message (RFC 5322, MIME)', () => {
  test('encoded words, quoted-printable, multipart alternatives and a forwarded message attached whole', () => {
    const raw = [
      'From: "Ops" <ops@acme.example>', 'Subject: =?utf-8?B?Rnc6IE9yZGVyICMxMDA0IGhhcyBzaGlwcGVk?=', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="outer"', '', '--outer', 'Content-Type: text/plain', '', 'See below.', '--outer',
      'Content-Type: message/rfc822', '',
      'From: Shipper <noreply@shipper.example>', 'Subject: Order #1004 has shipped', 'Message-ID: <m1@shipper.example>',
      'Content-Type: multipart/alternative; boundary="inner"', '', '--inner', 'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable', '', 'Carrier: Royal Mail =E2=80=94 tracked', 'Weight: 2.5 kg', '--inner',
      'Content-Type: text/html', '', '<p>Carrier: other</p>', '--inner--', '--outer--',
    ].join('\r\n');
    const parsed = parseMessage(raw);
    assert.equal(parsed.subject, 'Fw: Order #1004 has shipped');
    assert.equal(parsed.from, 'ops@acme.example');
    assert.equal(parsed.forwarded?.from, 'noreply@shipper.example');
    assert.equal(parsed.forwarded?.messageId, 'm1@shipper.example');
    assert.equal(parsed.forwarded?.text, 'Carrier: Royal Mail — tracked\nWeight: 2.5 kg\n');
    const html = parseMessage(message({ subject: 'x', body: '<table><tr><td>Carrier:</td><td>DPD &amp; co</td></tr></table><script>no()</script>', html: true }));
    assert.match(html.text, /Carrier:\s+DPD & co/);
    assert.doesNotMatch(html.text, /no\(\)/);
  });

  test('a field is the text after its label; a rule is plain text, so a message cannot make it slow', () => {
    assert.equal(textAfter('Weight: 12.5 kg (approx)', 'weight:', 'kg'), '12.5');
    assert.equal(textAfter('Order #A-77 has shipped', 'Order #', 'word'), 'A-77');
    assert.equal(textAfter('no label here', 'Carrier:', 'line'), undefined);
    assert.equal(typed('1,250.5', 'number'), 1250.5);
    assert.equal(typed('Yes', 'boolean'), true);
    const started = performance.now();
    textAfter(`${'a'.repeat(60_000)}!`, 'a'.repeat(100) + 'b', 'line');
    assert.ok(performance.now() - started < 200);
  });

  test('only declared senders; the first rule whose conditions hold; the identifier is required', () => {
    const objects = (manifest() as unknown as { objects: never[] }).objects;
    const block = { ...RULES, rules: RULES.rules.map((r) => ({ ...r, op: r.op ?? 'upsert', fields: r.fields.map((f) => ({ until: 'line', ...f })) })) } as never;
    assert.deepEqual(extractNotification(block, objects, parseMessage(message({ from: 'mallory@evil.example', subject: 'Order #1 has shipped', body: '' }))), { setAside: 'sender' });
    assert.deepEqual(extractNotification(block, objects, parseMessage(message({ subject: 'Your invoice', body: '' }))), { setAside: 'no_rule' });
    assert.deepEqual(extractNotification(block, objects, parseMessage(message({ subject: 'Something has shipped', body: '' }))), { setAside: 'identifier_missing' });
    const ok = extractNotification(block, objects, parseMessage(message({ from: 'x@alerts.shipper.example', subject: 'Order #9 has shipped', body: 'Carrier: DPD' })));
    assert.ok('draft' in ok);
    assert.deepEqual([ok.draft.entityRef, ok.draft.changed], ['9', { order_ref: '9', carrier: 'DPD' }]);
  });
});

let cell: ConnectCell;
let gateway: ServiceClient;
let root: Signed;
let edge = '';
let bus: LiveBus;
let state: RedisStore;
const received: SourceChange[] = [];

async function until<T>(what: string, check: () => T | undefined, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function post(recipient: string, raw: string, signature = relaySignature(SECRET, recipient, raw)) {
  const res = await fetch(`${edge}/api/v1/hooks/email`, {
    method: 'POST', body: raw, headers: { 'content-type': 'message/rfc822', 'x-silo-recipient': recipient, 'x-silo-signature': signature, 'x-forwarded-for': '203.0.113.30' },
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

before(async () => {
  cell = await createConnectCell();
  const live = { REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl };
  await cell.start(createConnectRuntimeService(), 'connect-runtime', 'test_app');
  await cell.start(createChangeStreamService({ tickMs: 150 }), 'change-stream', 'test_app', { ...live, INBOUND_EMAIL_DOMAIN: DOMAIN, INBOUND_EMAIL_SECRET: SECRET });
  let port = 0;
  await cell.start(createGatewayService({ onListening: (p) => { port = p; } }), 'gateway', 'test_app', {
    ...live, GATEWAY_PUBLIC_ORIGIN: 'https://app.silo.test', GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
    IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
  });
  edge = `http://127.0.0.1:${port}`;
  await cell.start(builderService, 'connector-builder', 'test_app');
  gateway = cell.client('gateway');
  root = await cell.signIn('root@acme.example');
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
});

after(async () => {
  await bus?.close();
  await state?.close();
  await cell?.close();
});

describe('email fallback end to end (spec 14.4)', () => {
  let connectionId: string;
  let address: string;

  test('the manifest declares its rules; a rule must extract its record\'s identifier; the connection is confirmed with no read', async () => {
    const keyed = () => ({ ...cell.as(root), idempotencyKey: uuidv7() });
    const connector = await gateway.call(createConnector, { body: { slug: `mail-${uuidv7().slice(-10)}`, name: 'Shipper', provider: 'Shipper', sourceRoute: 'ai' } }, keyed());
    const bad = manifest() as unknown as Record<string, any>;
    bad.changeStream.email = { ...RULES, rules: [{ object: 'shipments', when: [{ on: 'subject', contains: 'x' }], fields: [{ field: 'carrier', on: 'body', after: 'Carrier:' }] }] };
    await assert.rejects(gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: bad as never } }, keyed()), { code: 'manifest.invalid' });
    await gateway.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest() } }, keyed());
    let connection = await gateway.call(createConnection, { body: { connectorId: connector.id, name: 'Shipper', owningScopeId: cell.scopes['engineering']! } }, keyed());
    for (const move of ['probe', 'confirm', 'activate'] as const) {
      connection = await gateway.call(changeConnectionStatus, { params: { connectionId: connection.id }, body: { move, version: connection.version } }, cell.as(root));
    }
    connectionId = connection.id;
    assert.equal(connection.status, 'active');
    await assert.rejects(cell.client('executor').call(readObject, { body: { connectionId, reason: 'query', step: { object: 'shipments' } as never } }, cell.as(root)),
      { code: 'email.not_readable' });
  });

  test('enabling mints an address once; the relay\'s signed posts become changes; a forwarded notification is read as itself', async () => {
    const enabled = await gateway.call(enableStream, { params: { connectionId }, body: {} }, cell.as(root));
    address = enabled.email!.address;
    assert.match(address, new RegExp(`^c-[a-z2-7]{26}@${DOMAIN.replaceAll('.', '\\.')}$`));
    await assert.rejects(gateway.call(enableStream, { params: { connectionId }, body: {} }, cell.as(root)), { code: 'stream.already_enabled' });
    await registerChangeInterest(state, CELL_ID, cell.org, connectionId, ['shipments']);

    const raw = message({ subject: 'Order #1004 has shipped', body: 'Carrier: Royal Mail\nWeight: 2.5 kg\nShipped on: 2026-11-17T09:00:00Z\nSecret note: not a field', id: 'm-1004' });
    const out = await post(`Ops <${address}>`, raw);
    assert.equal(out.status, 202, JSON.stringify(out.body));
    const change = await until('the change', () => received.find((d) => d.connectionId === connectionId && d.entityRef === '1004'));
    assert.deepEqual([change.object, change.operation, change.source], ['shipments', 'update', 'email']);
    assert.deepEqual(change.changed, { order_ref: '1004', carrier: 'Royal Mail', weight_kg: 2.5, shipped_at: '2026-11-17T09:00:00.000Z' });

    const before = received.length;
    assert.equal((await post(address, raw)).status, 202);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(received.length, before, 'a repeat delivery (the same Message-ID) changes nothing');

    const forwarded = [
      'From: ops@acme.example', 'Subject: Fw: cancellation', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b',
      'Content-Type: message/rfc822', '', message({ subject: 'Order #1004 cancelled', body: 'Sorry.', id: 'm-c1' }), '--b--',
    ].join('\r\n');
    assert.equal((await post(address, forwarded)).status, 202);
    const cancelled = await until('the delete', () => received.find((d) => d.connectionId === connectionId && d.operation === 'delete'));
    assert.equal(cancelled.entityRef, '1004');
  });

  test('set aside, not changed: another sender, no rule; refused: unsigned, or an address no connection holds; disabled, the address is gone', async () => {
    const other = await post(address, message({ from: 'mallory@evil.example', subject: 'Order #66 has shipped', body: 'Carrier: x' }));
    assert.deepEqual([other.status, other.body['setAside']], [202, 'sender']);
    const unmatched = await post(address, message({ subject: 'Your monthly statement', body: '' }));
    assert.equal(unmatched.body['setAside'], 'no_rule');
    assert.equal((await post(address, message({ subject: 'Order #7 has shipped', body: '' }), 'v1=forged')).status, 401);
    assert.equal((await post(`c-${'a'.repeat(26)}@${DOMAIN}`, message({ subject: 'Order #7 has shipped', body: '' }))).status, 404);
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      'select messages_taken, messages_set_aside from connect.email_addresses where connection_id = $1', [connectionId]));
    assert.deepEqual([Number(rows[0].messages_taken), Number(rows[0].messages_set_aside)], [3, 2]);

    await gateway.call(disableStream, { params: { connectionId } }, cell.as(root));
    assert.equal((await post(address, message({ subject: 'Order #8 has shipped', body: '' }))).status, 404);
  });
});

describe('the AI builder from sample notifications (spec 16.1: email fallback is a protocol within the AI builder)', () => {
  const sample = (ref: string, carrier: string, weight: string, extra = '') => message({
    subject: `Order #${ref} has shipped`, body: `Hello,\nCarrier: ${carrier}\nWeight: ${weight} kg\nShipped on: 2026-11-1${ref.slice(-1)}T10:00:00Z\n${extra}Thanks`,
  });

  async function settled(connectionId: string): Promise<BuildView> {
    for (let i = 0; i < 600; i++) {
      const view = await gateway.call(getBuild, { params: { connectionId } }, cell.as(root));
      if (!view.running && view.stage !== 'parse') return view;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the build did not settle');
  }

  test('rules drafted in the cell with no model: the shared subject, the #reference, the labelled lines, typed; only counts kept', async () => {
    const samples = [
      sample('2001', 'Royal Mail', '1.5', 'Note: fragile\n'), sample('2002', 'DPD', '12'), sample('2003', 'Evri', '0.75'),
      message({ subject: 'Your invoice is ready', body: 'Amount: 10' }),
    ];
    const draft = await gateway.call(draftConnector, {
      body: { name: 'Shipper', slug: `ship-${uuidv7().slice(-8)}`, provider: 'Shipper', documentation: { kind: 'email', samples }, sandbox: { name: 'Shipper', owningScopeId: cell.scopes['engineering']! } },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const parse = draft.stages.find((s) => s.stage === 'parse')!.findings as { model: boolean; charged: boolean; email: { samples: number; matched: number; rules: number } };
    assert.deepEqual([parse.model, parse.charged, parse.email.samples, parse.email.matched, parse.email.rules], [false, false, 4, 3, 1],
      'the invoice names no record: its group is left out');
    const version = await gateway.call(getManifestVersion, { params: { connectorId: draft.connectorId, versionId: draft.manifest.id } }, cell.as(root));
    const document = version.document as { changeStream: { email: { senders: string[]; rules: { when: unknown[]; fields: { field: string; after: string; until: string }[] }[] } };
      objects: { identifier: string[]; fields: { name: string; type: string }[] }[] };
    const rule = document.changeStream.email.rules[0]!;
    assert.deepEqual(document.changeStream.email.senders, ['noreply@shipper.example']);
    assert.deepEqual(rule.when, [{ on: 'subject', contains: 'has shipped' }]);
    assert.deepEqual(document.objects[0]!.identifier, ['reference']);
    assert.deepEqual(rule.fields.find((f) => f.field === 'weight'), { field: 'weight', on: 'body', after: 'Weight:', until: 'kg' });
    assert.deepEqual(document.objects[0]!.fields.map((f) => [f.name, f.type]),
      [['reference', 'string'], ['carrier', 'string'], ['weight', 'number'], ['shipped_on', 'date-time']], 'a label one sample carries is left out');

    await gateway.call(probeBuild, { params: { connectionId: draft.connectionId } }, { ...cell.as(root), idempotencyKey: uuidv7() });
    const build = await settled(draft.connectionId);
    assert.deepEqual(build.stages.map((s) => `${s.stage}:${s.status}`), ['parse:completed', 'probe:completed', 'reconcile:completed', 'conform:completed', 'propose_mapping:completed']);
    assert.deepEqual((build.stages.find((s) => s.stage === 'conform')!.findings as { applicable: boolean }).applicable, false);
    const confirmed = await gateway.call(confirmBuild, {
      params: { connectionId: draft.connectionId }, body: { decisions: [{ object: build.proposals[0]!.object, accept: true }] },
    }, { ...cell.as(root), idempotencyKey: uuidv7() });
    assert.equal(confirmed.stages.at(-1)!.stage, 'verify');
    assert.equal(confirmed.stages.at(-1)!.status, 'completed', 'an email connection is confirmed with no read class');
    const { rows } = await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('select findings::text as f from connect.probe_runs where connection_id = $1', [draft.connectionId]));
    assert.ok(rows.every((r) => !String(r.f).includes('Royal Mail') && !String(r.f).includes('fragile')), 'no sample text is kept');
  });
});
