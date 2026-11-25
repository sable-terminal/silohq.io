import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { env } from '../config/env.config';
import { childLogger } from '../config/logger.config';
import { build } from '../utils/cacheKey.util';

const log = childLogger('derived-store');

/**
 * Where tokens Silo obtained for itself are kept between instances
 * (MANIFEST-V2 §9.1, F15, F28): a login session, a client-credentials grant, a
 * signed assertion.
 *
 * SEALED BEFORE THEY ARRIVE HERE. This stores ciphertext and nothing else; the
 * service seals with the same envelope a stored credential uses. A lock per
 * key means one instance logs in while the others wait for its session — the
 * difference between a single-session system working and every instance
 * logging the others out in turn.
 *
 * ABSENT WITHOUT REDIS. One instance needs no sharing, and the cache in front
 * of this is then the whole of it.
 */

export interface DerivedStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Take the lock on `key` for `ttlMs`; the token to release it, or null when another holds it. */
  lock(key: string, ttlMs: number): Promise<string | null>;
  unlock(key: string, token: string): Promise<void>;
  /** Every entry whose key begins with `prefix`, gone. */
  deleteMatching(prefix: string): Promise<void>;
}

const valueKey = (key: string) => build({ plane: 'control', kind: 'derived-token', parts: [key] });
const lockKey = (key: string) => build({ plane: 'control', kind: 'derived-lock', parts: [key] });

class RedisDerivedStore implements DerivedStore {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get(valueKey(key));
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(valueKey(key), value, 'EX', Math.max(1, Math.floor(ttlSeconds)));
  }

  async lock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const taken = await this.redis.set(lockKey(key), token, 'PX', ttlMs, 'NX');
    return taken === 'OK' ? token : null;
  }

  async unlock(key: string, token: string): Promise<void> {
    await this.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey(key), token);
  }

  async deleteMatching(prefix: string): Promise<void> {
    const pattern = `${valueKey(prefix)}*`;
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }
}

let store: DerivedStore | null | undefined;

export function derivedStore(): DerivedStore | null {
  if (store !== undefined) return store;
  if (!env.REDIS_URL) {
    store = null;
    return store;
  }
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 5_000, enableOfflineQueue: false });
  redis.on('error', (error) => log.warn({ err: error }, 'Derived-token store unavailable; each instance keeps its own'));
  store = new RedisDerivedStore(redis);
  return store;
}
