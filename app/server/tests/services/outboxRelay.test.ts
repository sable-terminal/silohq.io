// The outbox relay on a fresh cell database, as its own login (silo_outbox_relay: the
// three relay functions and nothing else), with a recording bus in place of bus-durable.
// Per-key order, retries with backoff, rows that cannot be published, and dead-lettering
// after 7 days. tests/services/audit.test.ts runs it against JetStream end to end.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type pg from 'pg';
import type { z } from 'zod';
import { loadConfig } from '../../src/config/index.config.ts';
import type { DurableBus, DurableMessage } from '../../src/infra/bus.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { openDatabases, type Databases } from '../../src/infra/postgres.infra.ts';
import { backoffSeconds, createRelay, type Relay } from '../../src/services/outbox-relay/relay.service.ts';
import { ledgerSince } from '../../src/services/maintenance/restore.service.ts';
import { createMemoryStore } from './memoryStore.helper.ts';
import { AppError } from '../../src/utils/errors.util.ts';
import { CELL_ID, createLocalCell, createOrganisation } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';

const quiet = createLogger({ service: 'outbox-relay', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });

interface Published { eventId: string; orderingKey: string; name: string; payload: unknown }

class RecordingBus implements DurableBus {
  published: Published[] = [];
  failing = new Set<string>();
  async publish<S extends z.ZodType>(definition: DurableMessage<S>, payload: z.input<S>, options: { eventId: string; orderingKey: string }) {
    if (this.failing.has(options.orderingKey)) throw new AppError('unavailable', 'bus-durable publish failed', { code: 'bus.durable.publish' });
    if (!definition.schema.safeParse(payload).success) throw new AppError('validation', 'mismatch', { code: 'bus.schema_mismatch' });
    this.published.push({ eventId: options.eventId, orderingKey: options.orderingKey, name: definition.name, payload });
  }
  async subscribe(): Promise<() => Promise<void>> { return async () => undefined; }
  async close() {}
}

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let databases: Databases;
let bus: RecordingBus;
let relay: Relay;
let orgA: string;
let orgB: string;

const authEvent = (event = 'login') => ({ event, userId: null, membershipId: null, ipHash: null, detail: {} });

async function enqueue(org: string, options: { event?: string; version?: number; payload?: unknown; createdAt?: string; key?: string; topic?: string } = {}) {
  const id = uuidv7();
  await inTx(app, { orgId: org }, () => app.query(
    `insert into platform.outbox (id, organisation_id, topic, ordering_key, event, schema_version, payload, correlation_id${options.createdAt ? ', created_at' : ''})
     values ($1, $2, $3, $4, $5, $6, $7, $8${options.createdAt ? ', $9' : ''})`,
    [id, org, options.topic ?? 'audit.events', options.key ?? org, options.event ?? 'auth_event', options.version ?? 1,
      JSON.stringify(options.payload ?? authEvent()), uuidv7(), ...(options.createdAt ? [options.createdAt] : [])]));
  return id;
}

const state = async (id: string) => (await migrate.query(
  `select published_at, attempts, last_error_category, dead_lettered_at, next_attempt_at > now() as waiting from platform.outbox where id = $1`, [id])).rows[0];

async function drain(max = 50): Promise<void> {
  for (let i = 0; i < max; i++) {
    const r = await relay.pass();
    if (r.published === 0) return;
  }
}

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  await createLocalCell(migrate);
  orgA = await createOrganisation(app, 'acme');
  orgB = await createOrganisation(app, 'globex');
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'outbox-relay', SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: h.url('test_relay'), DURABLE_BUS: 'jetstream',
    NATS_DURABLE_URL: 'nats://127.0.0.1:54222',
  });
  databases = openDatabases(config.postgres, 'outbox-relay', ['control']);
});

beforeEach(async () => {
  bus = new RecordingBus();
  relay = createRelay({ databases, bus, logger: quiet });
  // Each test starts from an empty outbox.
  await migrate.query('delete from platform.outbox');
});

after(async () => {
  await databases?.close(1000);
  await h?.close();
});

describe('the outbox relay (spec 9.2)', () => {
  test('publishes every row once, strictly in order per ordering key, with the row id as event id', async () => {
    const a = [await enqueue(orgA), await enqueue(orgA), await enqueue(orgA)];
    const b = [await enqueue(orgB), await enqueue(orgB)];
    const waiting = await relay.backlog();
    assert.ok(waiting.pending >= 5 && waiting.oldestSeconds >= 0, 'the backlog the Fleet agent gates a release on (spec 11.2)');
    const first = await relay.pass();
    assert.equal(first.claimed, 2, 'only the head of each key is claimed');
    await drain();
    assert.deepEqual(bus.published.filter((p) => p.orderingKey === orgA).map((p) => p.eventId), a);
    assert.deepEqual(bus.published.filter((p) => p.orderingKey === orgB).map((p) => p.eventId), b);
    for (const id of [...a, ...b]) assert.ok((await state(id)).published_at, 'marked published');
    const envelope = bus.published[0]!.payload as { organisationId: string; occurredAt: string; correlationId: string; payload: unknown };
    assert.equal(envelope.organisationId, orgA);
    assert.deepEqual(envelope.payload, authEvent());
    assert.match(envelope.occurredAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await relay.pass()).claimed, 0, 'nothing left');
    assert.deepEqual(await relay.backlog(), { pending: 0, oldestSeconds: 0 });
  });

  test('a failed publish backs off and holds its key; other keys carry on', async () => {
    const a1 = await enqueue(orgA);
    const a2 = await enqueue(orgA);
    const b1 = await enqueue(orgB);
    bus.failing.add(orgA);
    await drain();
    assert.deepEqual(bus.published.map((p) => p.eventId), [b1]);
    const failed = await state(a1);
    assert.equal(failed.last_error_category, 'unavailable');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.waiting, true, 'retried later, not at once');
    assert.equal((await state(a2)).attempts, 0, 'the row behind it was never claimed');
    // Due again: published in order once the bus recovers.
    bus.failing.clear();
    await migrate.query('update platform.outbox set next_attempt_at = now() where id = $1', [a1]);
    await drain();
    assert.deepEqual(bus.published.map((p) => p.eventId), [b1, a1, a2]);
  });

  test('backoff doubles from 1 second to the cap, with jitter', () => {
    const mid = () => 0.5;
    assert.deepEqual([1, 2, 3, 4, 9, 20].map((n) => backoffSeconds(n, 300, mid)), [1, 2, 4, 8, 256, 300]);
    assert.ok(backoffSeconds(5, 300, () => 0) >= 12 && backoffSeconds(5, 300, () => 1) <= 20);
  });

  test('a row with no listed message, or a payload that does not match, is never published and holds its key', async () => {
    const unknown = await enqueue(orgA, { event: 'no_such_message' });
    const behind = await enqueue(orgA);
    const bad = await enqueue(orgB, { payload: { event: 'login', userId: 'not-a-uuid', membershipId: null, ipHash: null, detail: {} } });
    const wrongVersion = await enqueue(orgB, { key: `${orgB}`, version: 9, topic: 'audit.events' });
    await drain();
    assert.equal(bus.published.length, 0);
    assert.equal((await state(unknown)).last_error_category, 'unregistered_message');
    assert.equal((await state(bad)).last_error_category, 'schema_mismatch');
    assert.equal((await state(behind)).attempts, 0);
    assert.equal((await state(wrongVersion)).attempts, 0, 'behind the bad row of its key');
  });

  test('a row unpublished for 7 days is dead-lettered and its key moves on', async () => {
    const old = await enqueue(orgA, { createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    const next = await enqueue(orgA);
    bus.failing.add(orgA);
    const result = await relay.pass();
    assert.equal(result.deadLettered, 1);
    assert.ok((await state(old)).dead_lettered_at);
    bus.failing.clear();
    await drain();
    assert.deepEqual(bus.published.map((p) => p.eventId), [next]);
  });

  test('the purge ledger goes to object-backup, never the bus; without the store it waits, holding its key (8.2; D251)', async () => {
    const store = createMemoryStore();
    const withBackup = createRelay({ databases, bus, logger: quiet, backup: store });
    const entry = { kind: 'files', fileIds: [uuidv7()] };
    const id = await enqueue(orgA, { topic: 'platform.purge_ledger', event: 'purge_recorded', payload: entry });
    // A relay with no backup store leaves it waiting.
    await relay.pass();
    assert.equal((await state(id)).last_error_category, 'ledger_store_missing');
    await migrate.query('update platform.outbox set next_attempt_at = now() where id = $1', [id]);
    await withBackup.pass();
    assert.ok((await state(id)).published_at, 'delivered');
    assert.equal(bus.published.length, 0, 'nothing on the bus');
    const [key] = store.keys('backup');
    assert.match(key!, /^cell\/purge-ledger\/\d{4}\/\d\d\/\d\d\/\d{4}-\d\d-\d\dT\d{6}\.\d{3}Z\./);
    const stored = JSON.parse((await store.get('backup', key as never)).toString('utf8'));
    assert.deepEqual([stored.id, stored.organisationId, stored.entry], [id, orgA, entry]);
    // A restore reads it back: everything after the restore point, nothing before.
    const since = new Date(Date.parse(stored.occurredAt) - 60_000).toISOString();
    assert.deepEqual((await ledgerSince(store, since)).map((e) => e.id), [id]);
    assert.deepEqual(await ledgerSince(store, stored.occurredAt), [], 'made at the restore point: already in the backup');
    await assert.rejects(ledgerSince(store, 'yesterday'), { code: 'restore.since_invalid' });
  });

  test('a crashed relay\'s claim runs out and the row is published by another', async () => {
    const id = await enqueue(orgA);
    const short = createRelay({ databases, bus, logger: quiet, options: { leaseSeconds: 1 } });
    // Claimed and never marked: what a relay that died after claiming leaves.
    await databases.pool('control').query('select * from platform.outbox_claim(10, make_interval(secs => 1))');
    assert.equal((await short.pass()).claimed, 0, 'leased to the first relay');
    await new Promise((r) => setTimeout(r, 1100));
    await short.pass();
    assert.deepEqual(bus.published.map((p) => p.eventId), [id]);
  });
});
