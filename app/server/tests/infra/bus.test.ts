// The buses (spec 9): schemas are enforced on both sides, bus-durable never carries a
// record value, messages are bounded, and per-key order holds. bus-durable runs against
// JetStream (sovereign, self-managed) and the Pub/Sub emulator (commercial).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import {
  connectDurableBus, connectLiveBus, decode, defineDurableMessage, defineLiveMessage, liveSubjects,
  type DurableBus, type DurableEnvelope, type LiveBus,
} from '../../src/infra/bus.infra.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';
import { recordValue } from '../../src/utils/recordValue.util.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { LOCAL } from './services.helper.ts';

// Read by the Pub/Sub client. Each test file runs in its own process.
process.env['PUBSUB_EMULATOR_HOST'] = LOCAL.pubsubEmulatorHost;

const suffix = Date.now().toString(36);
const Delta = defineLiveMessage({
  family: 'sub', name: `test_delta_${suffix}`,
  schema: z.object({ objectKey: z.string(), sequence: z.number().int(), after: recordValue(z.unknown()) }),
});
const Usage = defineDurableMessage({
  topic: 'metering.usage', name: `test_usage_${suffix}`, version: 1,
  schema: z.object({ organisationId: z.uuid(), tokens: z.number().int().min(0) }),
});

let live: LiveBus;
const config = { liveUrl: LOCAL.natsUrl, durable: 'jetstream' as const, durableUrl: LOCAL.natsUrl };

before(async () => {
  live = await connectLiveBus(config, 'test');
});

after(async () => {
  await live?.close();
});

describe('message registry', () => {
  test('refuses a bus-durable schema carrying a record value (spec 9.1)', () => {
    assert.throws(() => defineDurableMessage({
      topic: 'audit.events', name: `test_leaky_${suffix}`, version: 1,
      schema: z.object({ rows: z.array(z.object({ value: recordValue(z.string()) })) }),
    }), /record value/);
  });

  test('refuses a second definition under one name', () => {
    assert.throws(() => defineLiveMessage({ family: 'sub', name: Delta.name, schema: z.object({}) }), /already registered/);
  });
});

describe('bus-live', () => {
  test('delivers a valid message and refuses an invalid one', async () => {
    const org = uuidv7();
    const group = uuidv7();
    const received: unknown[] = [];
    const stop = live.subscribe(Delta, liveSubjects.subscriptionsOf(org), (payload) => {
      received.push(payload);
    });
    await live.flush();
    live.publish(Delta, liveSubjects.subscription(org, group), { objectKey: 'k1', sequence: 1, after: { status: 'open' } });
    assert.throws(() => live.publish(Delta, liveSubjects.subscription(org, group), { objectKey: 'k1', sequence: 'two' } as never),
      { category: 'validation' });
    await live.flush();
    await sleep(100);
    stop();
    assert.deepEqual(received, [{ objectKey: 'k1', sequence: 1, after: { status: 'open' } }]);
  });

  test('subjects carry identifiers only, and messages are bounded', () => {
    assert.throws(() => liveSubjects.change(uuidv7(), uuidv7(), 'customers.archive'), TypeError);
    assert.throws(() => live.publish(Delta, liveSubjects.subscription(uuidv7(), uuidv7()),
      { objectKey: 'k', sequence: 1, after: 'x'.repeat(300 * 1024) }), { category: 'bounds' });
  });
});

const Release = defineDurableMessage({
  topic: 'control.release', name: `test_release_${suffix}`, version: 1, schema: z.object({ release: z.string() }),
});

const CONSUMERS = ['once', 'order', 'retry'].map((name) => `test-${suffix}-${name}`);

// The cell template provisions topics and subscriptions (<topic>.<consumer>); here the
// test does, against the emulator.
async function provisionPubSub(): Promise<void> {
  const { PubSub } = await import('@google-cloud/pubsub');
  const admin = new PubSub({ projectId: LOCAL.gcpProjectId });
  try {
    const [topic] = await admin.topic(Usage.topic).get({ autoCreate: true });
    for (const consumer of CONSUMERS) {
      await topic.createSubscription(`${Usage.topic}.${consumer}`, { enableMessageOrdering: true, ackDeadlineSeconds: 10 });
    }
  } finally {
    await admin.close();
  }
}

const durableBuses = [
  { name: 'JetStream', deduplicates: true, provision: async () => undefined, config },
  { name: 'Pub/Sub emulator', deduplicates: false, provision: provisionPubSub,
    config: { durable: 'pubsub' as const, pubsubProjectId: LOCAL.gcpProjectId } },
];

async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  for (const started = Date.now(); !condition() && Date.now() - started < ms;) await sleep(50);
}

for (const bus of durableBuses) {
  describe(`bus-durable (${bus.name})`, () => {
    let durable: DurableBus;
    before(async () => {
      await bus.provision();
      durable = await connectDurableBus(bus.config, 'test');
    });
    after(async () => {
      await durable?.close();
    });

    test('delivers an event to each consumer, carrying its event id', async () => {
      const organisationId = uuidv7();
      const eventId = uuidv7();
      const seen: DurableEnvelope[] = [];
      const stop = await durable.subscribe('metering.usage', CONSUMERS[0]!, async (message) => {
        if (message.eventId === eventId) seen.push(message);
      });
      await durable.publish(Usage, { organisationId, tokens: 3 }, { eventId, orderingKey: organisationId });
      // The outbox relay may publish a row twice. JetStream drops the copy by event id;
      // Pub/Sub delivers both, and the consumer's inbox drops it by event id.
      await durable.publish(Usage, { organisationId, tokens: 3 }, { eventId, orderingKey: organisationId });
      await waitFor(() => seen.length >= (bus.deduplicates ? 1 : 2));
      await sleep(300);
      await stop();
      assert.equal(seen.length, bus.deduplicates ? 1 : 2);
      for (const message of seen) {
        assert.equal(message.name, Usage.name);
        assert.equal(message.version, 1);
        assert.deepEqual(decode(Usage, message.data), { organisationId, tokens: 3 });
      }
    });

    test('keeps the order of events with one ordering key', async () => {
      const organisationId = uuidv7();
      const seen: number[] = [];
      const stop = await durable.subscribe('metering.usage', CONSUMERS[1]!, async (message) => {
        // The topic is shared: other services' messages (and earlier runs') pass this consumer by.
        if (message.name !== Usage.name) return;
        const payload = decode(Usage, message.data);
        if (payload.organisationId === organisationId) seen.push(payload.tokens);
      });
      await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((tokens) =>
        durable.publish(Usage, { organisationId, tokens }, { eventId: uuidv7(), orderingKey: organisationId })));
      await waitFor(() => seen.length >= 8);
      await stop();
      assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7]);
    });

    test('redelivers an event whose handler throws', async () => {
      const organisationId = uuidv7();
      const eventId = uuidv7();
      let attempts = 0;
      let handled = false;
      const stop = await durable.subscribe('metering.usage', CONSUMERS[2]!, async (message) => {
        if (message.eventId !== eventId) return;
        attempts += 1;
        if (attempts === 1) throw new Error('first attempt fails');
        handled = true;
      });
      await durable.publish(Usage, { organisationId, tokens: 1 }, { eventId, orderingKey: organisationId });
      await waitFor(() => handled);
      await stop();
      assert.ok(handled);
      assert.ok(attempts >= 2);
    });

    test('refuses a message that does not match its schema', async () => {
      await assert.rejects(durable.publish(Usage, { organisationId: 'acme', tokens: -1 }, { eventId: uuidv7(), orderingKey: 'x' }),
        { category: 'validation' });
    });

    // The client documents that a failed publish pauses its ordering key until resumed;
    // the adapter resumes it, so the outbox relay's retry goes through.
    test('a failed publish does not block its ordering key', { skip: bus.deduplicates }, async () => {
      const { PubSub } = await import('@google-cloud/pubsub');
      const admin = new PubSub({ projectId: LOCAL.gcpProjectId });
      try {
        await admin.topic(Release.topic).delete().catch(() => undefined);
        const organisationId = uuidv7();
        const event = { eventId: uuidv7(), orderingKey: organisationId };
        await assert.rejects(durable.publish(Release, { release: 'r1' }, event), { category: 'unavailable', code: 'bus.durable.publish' });
        await admin.createTopic(Release.topic);
        await durable.publish(Release, { release: 'r1' }, event);
      } finally {
        await admin.close();
      }
    });
  });
}
