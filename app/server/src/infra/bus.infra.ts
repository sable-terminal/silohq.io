// The two buses of a cell (spec 9).
//
// bus-live: NATS core, no persistence, at most once. Carries normalised source changes
// and state deltas, with values. Subjects (spec 9.2):
//   chg.<org_id>.<connection_id>.<source_object>   normalised source changes
//   sub.<org_id>.<group_id>                        deltas for one subscription group
//   ctl.<org_id>.resync.<group_id>                 resynchronisation requests
//
// bus-durable: Pub/Sub in commercial cells, NATS JetStream in the sovereign cell and
// self-managed installs. At least once; consumers are idempotent on the event id.
// Persists, so carries no values: references and counts only.
//
// Binding rules (spec 9.1): every message schema is a Zod definition registered against
// one bus; the registry refuses a bus-durable schema with a field marked as a record
// value (recordValue.util.ts); publishing refuses a message that does not match its
// schema. Messages are bounded at 256 KB live and 64 KB durable (spec 9.5). Trace
// context travels in message headers (spec 13.1).

import { readFileSync } from 'node:fs';
import { AckPolicy, jetstream, jetstreamManager, RetentionPolicy, StorageType } from '@nats-io/jetstream';
import { connect, credsAuthenticator, headers as natsHeaders, type NatsConnection } from '@nats-io/transport-node';
import type { z } from 'zod';
import type { BusConfig } from '../config/bus.config.ts';
import { LIMITS } from '../config/limits.config.ts';
import { AppError } from '../utils/errors.util.ts';
import { isUuid } from '../utils/id.util.ts';
import { containsRecordValue } from '../utils/recordValue.util.ts';
import { injectTraceContext, withExtractedTraceContext } from './telemetry.infra.ts';

// ----------------------------------------------------------------------------- registry

// platform.purge_ledger is listed so every outbox topic is a durable one, but the relay never
// publishes it: its rows go to object-backup (contracts/platform/purgeLedger.contract.ts).
export const DURABLE_TOPICS = [
  'audit.events', 'metering.usage', 'control.policy', 'control.connection', 'control.agent', 'control.action',
  'control.release', 'siloes.capture', 'platform.purge_ledger',
] as const;
export type DurableTopic = (typeof DURABLE_TOPICS)[number];

export interface DurableMessage<S extends z.ZodType = z.ZodType> {
  readonly bus: 'durable';
  readonly topic: DurableTopic;
  readonly name: string;
  readonly version: number;
  readonly schema: S;
}

export interface LiveMessage<S extends z.ZodType = z.ZodType> {
  readonly bus: 'live';
  readonly family: 'chg' | 'sub' | 'ctl';
  readonly name: string;
  readonly schema: S;
}

const registered = new Map<string, DurableMessage | LiveMessage>();
const NAME = /^[a-z][a-z0-9_]*$/;

function register<T extends DurableMessage | LiveMessage>(definition: T): T {
  if (!NAME.test(definition.name)) throw new TypeError(`message name ${definition.name} must be snake_case`);
  if (registered.has(definition.name)) throw new TypeError(`message ${definition.name} is already registered`);
  registered.set(definition.name, definition);
  return definition;
}

export function defineDurableMessage<S extends z.ZodType>(definition: Omit<DurableMessage<S>, 'bus'>): DurableMessage<S> {
  if (containsRecordValue(definition.schema)) {
    throw new TypeError(`bus-durable message ${definition.name} has a field marked as a record value (spec 9.1)`);
  }
  return register({ ...definition, bus: 'durable' });
}

export function defineLiveMessage<S extends z.ZodType>(definition: Omit<LiveMessage<S>, 'bus'>): LiveMessage<S> {
  return register({ ...definition, bus: 'live' });
}

function encode<S extends z.ZodType>(definition: DurableMessage<S> | LiveMessage<S>, payload: z.input<S>, limit: number): Uint8Array {
  const parsed = definition.schema.safeParse(payload);
  if (!parsed.success) {
    // Issues name paths and expectations; the payload is not echoed.
    throw new AppError('validation', `message ${definition.name} does not match its schema`, {
      code: 'bus.schema_mismatch', details: { message: definition.name, issues: parsed.error.issues.length },
    });
  }
  const bytes = Buffer.from(JSON.stringify(parsed.data), 'utf8');
  if (bytes.length > limit) throw new AppError('bounds', `message ${definition.name} exceeds ${limit} bytes`, {
    code: 'bus.message_too_large', details: { message: definition.name, bytes: bytes.length, limit },
  });
  return bytes;
}

// Decodes a received payload against its definition, so a consumer never trusts the wire.
export function decode<S extends z.ZodType>(definition: DurableMessage<S> | LiveMessage<S>, data: Uint8Array): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch (cause) {
    throw new AppError('validation', `message ${definition.name} is not JSON`, { code: 'bus.not_json', cause });
  }
  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('validation', `message ${definition.name} does not match its schema`, { code: 'bus.schema_mismatch' });
  }
  return parsed.data;
}

// ----------------------------------------------------------------------------- live subjects

// Subjects carry identifiers, never names (spec 9.2). The source object token is the
// connector's object identifier, restricted to subject-safe characters.
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const id = (value: string, what: string): string => {
  if (!isUuid(value)) throw new TypeError(`${what} must be a UUID`);
  return value;
};

export const liveSubjects = {
  change(organisationId: string, connectionId: string, sourceObject: string): string {
    if (!TOKEN.test(sourceObject)) throw new TypeError('source object must be a subject-safe token');
    return `chg.${id(organisationId, 'organisation')}.${id(connectionId, 'connection')}.${sourceObject}`;
  },
  subscription(organisationId: string, groupId: string): string {
    return `sub.${id(organisationId, 'organisation')}.${id(groupId, 'group')}`;
  },
  /** Every subscription group of one organisation: what a gateway pod listens on. */
  subscriptionsOf(organisationId: string): string {
    return `sub.${id(organisationId, 'organisation')}.*`;
  },
  resync(organisationId: string, groupId: string): string {
    return `ctl.${id(organisationId, 'organisation')}.resync.${id(groupId, 'group')}`;
  },
};

// ----------------------------------------------------------------------------- NATS connection

async function connectNats(url: string, config: BusConfig, name: string): Promise<NatsConnection> {
  try {
    return await connect({
      servers: url,
      name,
      ...(config.natsCredentialsFile ? { authenticator: credsAuthenticator(readFileSync(config.natsCredentialsFile)) } : {}),
      ...(config.natsCaFile ? { tls: { ca: readFileSync(config.natsCaFile, 'utf8') } } : {}),
    });
  } catch (cause) {
    throw new AppError('unavailable', 'NATS is unavailable', { code: 'bus.nats.unavailable', cause });
  }
}

const toHeaders = (values: Record<string, string>) => {
  const h = natsHeaders();
  for (const [key, value] of Object.entries(values)) h.set(key, value);
  return h;
};

// ----------------------------------------------------------------------------- bus-live

export interface LiveBus {
  publish<S extends z.ZodType>(definition: LiveMessage<S>, subject: string, payload: z.input<S>): void;
  /**
   * With a queue, each message goes to one subscriber of the queue across every process, as
   * a NATS queue group: how a service with several replicas takes each change once.
   */
  subscribe<S extends z.ZodType>(definition: LiveMessage<S>, subject: string,
    handler: (payload: z.output<S>, subject: string) => void | Promise<void>, options?: { queue?: string }): () => void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export async function connectLiveBus(config: BusConfig, service: string): Promise<LiveBus> {
  if (config.liveUrl === undefined) throw new AppError('configuration', 'bus-live is not configured', { code: 'config.bus.live' });
  const nc = await connectNats(config.liveUrl, config, `${service}:live`);
  return {
    publish(definition, subject, payload) {
      if (!subject.startsWith(`${definition.family}.`)) throw new TypeError(`${definition.name} publishes on ${definition.family}.*`);
      nc.publish(subject, encode(definition, payload, LIMITS.bus.liveMessageBytes), { headers: toHeaders(injectTraceContext()) });
    },
    subscribe(definition, subject, handler, options = {}) {
      const subscription = nc.subscribe(subject, {
        ...(options.queue === undefined ? {} : { queue: options.queue }),
        callback: (error, message) => {
          if (error) return;
          const carrier: Record<string, string> = {};
          for (const key of message.headers?.keys() ?? []) carrier[key] = message.headers!.get(key);
          // At most once (spec 9.1): a message that fails to decode or handle is dropped;
          // the client resynchronises on the sequence gap.
          withExtractedTraceContext(carrier, () => {
            try {
              void Promise.resolve(handler(decode(definition, message.data), message.subject)).catch(() => undefined);
            } catch {
              // dropped
            }
          });
        },
      });
      return () => subscription.unsubscribe();
    },
    flush: () => nc.flush(),
    close: () => nc.drain(),
  };
}

// ----------------------------------------------------------------------------- bus-durable

export interface DurableEnvelope {
  eventId: string;
  name: string;
  version: number;
  data: Uint8Array;
}

export interface DurableBus {
  /** orderingKey: the topic's ordering key (spec 9.2), such as the organisation id. */
  publish<S extends z.ZodType>(definition: DurableMessage<S>, payload: z.input<S>,
    options: { eventId: string; orderingKey: string }): Promise<void>;
  /** At least once: the handler must be idempotent on eventId. A throw redelivers. */
  subscribe(topic: DurableTopic, consumer: string, handler: (message: DurableEnvelope) => Promise<void>): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

const STREAM = 'SILO_DURABLE';
const SEVEN_DAYS_NS = LIMITS.bus.durableRetentionSeconds * 1_000_000_000;
const CONSUMER = /^[a-z][a-z0-9-]{0,62}$/;

async function connectJetStream(config: BusConfig, service: string): Promise<DurableBus> {
  if (config.durableUrl === undefined) throw new AppError('configuration', 'bus-durable is not configured', { code: 'config.bus.durable' });
  const nc = await connectNats(config.durableUrl, config, `${service}:durable`);
  const jsm = await jetstreamManager(nc);
  const subjects = DURABLE_TOPICS.map((topic) => `${topic}.>`);
  try {
    await jsm.streams.info(STREAM);
    await jsm.streams.update(STREAM, { subjects, max_age: SEVEN_DAYS_NS });
  } catch {
    await jsm.streams.add({ name: STREAM, subjects, retention: RetentionPolicy.Limits, storage: StorageType.File, max_age: SEVEN_DAYS_NS });
  }
  const js = jetstream(nc);
  return {
    async publish(definition, payload, options) {
      const data = encode(definition, payload, LIMITS.bus.durableMessageBytes);
      // The ordering key becomes the last subject token, so per-key order holds and a
      // consumer may filter by it. Nats-Msg-Id deduplicates a republished outbox row.
      const key = TOKEN.test(options.orderingKey) ? options.orderingKey : '_';
      await js.publish(`${definition.topic}.${key}`, data, {
        msgID: options.eventId,
        headers: toHeaders({ ...injectTraceContext(), 'silo-event-id': options.eventId, 'silo-name': definition.name, 'silo-version': String(definition.version) }),
      });
    },
    async subscribe(topic, consumer, handler) {
      if (!CONSUMER.test(consumer)) throw new TypeError('consumer name must be lowercase with dashes');
      const durable = `${consumer}-${topic.replace('.', '-')}`;
      await jsm.consumers.add(STREAM, { durable_name: durable, ack_policy: AckPolicy.Explicit, filter_subject: `${topic}.>` });
      const messages = await (await js.consumers.get(STREAM, durable)).consume();
      void (async () => {
        for await (const message of messages) {
          const carrier: Record<string, string> = {};
          for (const key of message.headers?.keys() ?? []) carrier[key] = message.headers!.get(key);
          try {
            await withExtractedTraceContext(carrier, () => handler({
              eventId: carrier['silo-event-id'] ?? '', name: carrier['silo-name'] ?? '',
              version: Number(carrier['silo-version'] ?? 0), data: message.data,
            }));
            message.ack();
          } catch {
            message.nak();
          }
        }
      })();
      return async () => { await messages.close(); };
    },
    close: () => nc.drain(),
  };
}

async function connectPubSub(config: BusConfig): Promise<DurableBus> {
  // Imported on use: the sovereign build carries no Pub/Sub client (spec 6.5).
  const { PubSub } = await import('@google-cloud/pubsub');
  const pubsub = new PubSub({ projectId: config.pubsubProjectId! });
  // One publisher per topic: ordering holds only within one publisher's queue.
  const topics = new Map<string, ReturnType<typeof pubsub.topic>>();
  const topicFor = (name: string) => {
    let topic = topics.get(name);
    if (!topic) {
      topic = pubsub.topic(name, { messageOrdering: true });
      topics.set(name, topic);
    }
    return topic;
  };
  return {
    async publish(definition, payload, options) {
      const data = Buffer.from(encode(definition, payload, LIMITS.bus.durableMessageBytes));
      const topic = topicFor(definition.topic);
      try {
        await topic.publishMessage({
          data, orderingKey: options.orderingKey,
          attributes: { ...injectTraceContext(), 'silo-event-id': options.eventId, 'silo-name': definition.name, 'silo-version': String(definition.version) },
        });
      } catch (cause) {
        // The client documents that a failed publish pauses its ordering key until
        // resumed. The outbox relay retries the row, so resume the key here.
        topic.resumePublishing(options.orderingKey);
        throw new AppError('unavailable', 'bus-durable publish failed', { code: 'bus.durable.publish', cause });
      }
    },
    async subscribe(topic, consumer, handler) {
      if (!CONSUMER.test(consumer)) throw new TypeError('consumer name must be lowercase with dashes');
      // Subscriptions are provisioned by the cell template, named <topic>.<consumer>.
      const subscription = pubsub.subscription(`${topic}.${consumer}`);
      subscription.on('message', (message) => {
        const attributes = message.attributes;
        void withExtractedTraceContext(attributes, () => handler({
          eventId: attributes['silo-event-id'] ?? '', name: attributes['silo-name'] ?? '',
          version: Number(attributes['silo-version'] ?? 0), data: message.data,
        })).then(() => message.ack(), () => message.nack());
      });
      subscription.on('error', () => undefined);
      return async () => { await subscription.close(); };
    },
    async close() {
      await Promise.all([...topics.values()].map((topic) => topic.flush()));
      await pubsub.close();
    },
  };
}

export async function connectDurableBus(config: BusConfig, service: string): Promise<DurableBus> {
  if (config.durable === 'pubsub') return connectPubSub(config);
  if (config.durable === 'jetstream') return connectJetStream(config, service);
  throw new AppError('configuration', 'bus-durable is not configured', { code: 'config.bus.durable' });
}
