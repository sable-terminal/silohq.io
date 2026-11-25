import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { env } from '../config/env.config';
import { childLogger } from '../config/logger.config';
import { build } from '../utils/cacheKey.util';
import { scopedObjectKey } from '../utils/inputSanitiser.util';
import { LocalBus, type Bus } from '../engine/relay/agent.relay';
import * as objectStore from './objectStore.infra';

const log = childLogger('relay-bus');

/**
 * How Silo instances pass agent jobs and results to each other (MANIFEST-V2 §9.9).
 *
 * REDIS CARRIES ROUTING; SEALED BYTES RIDE BESIDE IT. A job or result small
 * enough for one Redis value is parked there for a minute under the
 * organisation's data-plane key and taken once; anything larger goes to object
 * storage under the organisation's prefix and is deleted as it is read. Every
 * byte either holds is ciphertext sealed to its one reader.
 *
 * WITHOUT REDIS THERE IS ONE INSTANCE, and every agent that connects is on it:
 * the in-memory bus is then exactly right, not a degraded mode.
 */

/** Past this a parked payload goes to object storage rather than Redis. */
const REDIS_VALUE_BYTES = 900_000;
/** How long a parked payload waits to be taken. The reader is already listening. */
const PARKED_SECONDS = 60;

class RedisBus implements Bus {
  readonly instanceId = `i-${randomUUID()}`;
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, (message: Record<string, unknown>) => void>();

  constructor(url: string) {
    const options = { maxRetriesPerRequest: 2, connectTimeout: 5_000, lazyConnect: false };
    this.publisher = new Redis(url, options);
    this.subscriber = new Redis(url, options);
    for (const client of [this.publisher, this.subscriber]) client.on('error', (error) => log.warn({ err: error }, 'Relay bus unavailable'));
    this.subscriber.on('message', (channel: string, text: string) => {
      const handler = this.handlers.get(channel);
      if (!handler) return;
      try {
        handler(JSON.parse(text) as Record<string, unknown>);
      } catch (error) {
        log.warn({ err: error, channel }, 'A relay message could not be read');
      }
    });
  }

  async publish(channel: string, message: Record<string, unknown>): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, handler: (message: Record<string, unknown>) => void): Promise<void> {
    this.handlers.set(channel, handler);
    await this.subscriber.subscribe(channel);
  }

  private parkedKey(organisationId: string, key: string): string {
    return build({ plane: 'data', kind: 'relay', organisationId, parts: [key] });
  }

  async put(organisationId: string, key: string, bytes: Buffer): Promise<void> {
    if (bytes.length <= REDIS_VALUE_BYTES) {
      await this.publisher.set(this.parkedKey(organisationId, key), bytes.toString('base64'), 'EX', PARKED_SECONDS);
      return;
    }
    const objectKey = scopedObjectKey(organisationId, 'relay', key);
    await objectStore.putAt({ key: objectKey, body: bytes, sniffedContentType: 'application/octet-stream' });
    await this.publisher.set(this.parkedKey(organisationId, key), `object:${objectKey}`, 'EX', PARKED_SECONDS);
  }

  async take(organisationId: string, key: string): Promise<Buffer | null> {
    const value = await this.publisher.getdel(this.parkedKey(organisationId, key));
    if (value === null) return null;
    if (!value.startsWith('object:')) return Buffer.from(value, 'base64');
    const objectKey = value.slice('object:'.length);
    try {
      return await objectStore.get(objectKey);
    } finally {
      await objectStore.remove(objectKey).catch(() => {});
    }
  }

  private presenceKey(agentId: string): string {
    return build({ plane: 'control', kind: 'agent-presence', parts: [agentId] });
  }

  async setPresence(agentId: string, instanceId: string, ttlSeconds: number): Promise<void> {
    await this.publisher.set(this.presenceKey(agentId), instanceId, 'EX', ttlSeconds);
  }

  async presence(agentId: string): Promise<string | null> {
    return this.publisher.get(this.presenceKey(agentId));
  }

  /* Only the instance that holds the socket may say it has gone: compare, then delete. */
  async clearPresence(agentId: string, instanceId: string): Promise<void> {
    await this.publisher.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      this.presenceKey(agentId),
      instanceId,
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}

let bus: Bus | null = null;

/** The bus this process uses: Redis when there is one, memory when there is not. */
export function relayBus(): Bus {
  bus ??= env.REDIS_URL ? new RedisBus(env.REDIS_URL) : new LocalBus();
  return bus;
}

export async function closeRelayBus(): Promise<void> {
  if (bus instanceof RedisBus) await bus.close();
  bus = null;
}
