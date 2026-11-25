import Redis from 'ioredis';
import { env, isProd } from '../config/env.config';
import { childLogger } from '../config/logger.config';
import { build, planeOf, tenantPrefix, ttlFor, type KeySpec } from '../utils/cacheKey.util';

const log = childLogger('cache');

/**
 * Redis.
 *
 * IT OBEYS `utils/cacheKey.util.ts`; IT DOES NOT DEFINE THE RULES. Every write
 * goes through `build`, which refuses a data-plane key with no tenant and caps
 * how long a data-plane value may live. This client cannot be handed a raw
 * string, which is what stops the rule being bypassed by whoever is in a hurry.
 *
 * IT IS OPTIONAL AND EVERY OPERATION DEGRADES. Without `REDIS_URL` the cache is a
 * no-op: reads miss, writes vanish, and the application is slower and correct. A
 * cache that takes the product down when it is unavailable is a cache that has
 * become a database.
 *
 * SESSIONS ARE THE ONE THING THAT LOOKS LIKE AN EXCEPTION AND IS NOT. Postgres is
 * the record of truth and the revocation list; this holds a short-lived copy. A
 * cache miss costs a query, never a logout.
 */

const client: Redis | null = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      // Fail fast rather than queueing: a request waiting on a dead cache is
      // worse than a request that missed it.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
      connectTimeout: 5_000,
    })
  : null;

if (client) {
  client.on('error', (error) => {
    // Logged at warn, not error. An unreachable cache is a degradation, and
    // paging somebody for it teaches them to ignore the page.
    log.warn({ err: error }, 'Cache unavailable; continuing without it');
  });
} else if (isProd) {
  log.error('REDIS_URL is not set in production. Every request will reach the database.');
}

export function isAvailable(): boolean {
  return client !== null && client.status === 'ready';
}

/**
 * Whether a cache was asked for at all.
 *
 * DIFFERENT FROM `isAvailable`, AND THE DIFFERENCE DECIDES A SECURITY QUESTION.
 * "No REDIS_URL" is a deployment posture — a developer's laptop, a test run —
 * and it is a state `assertProductionReady` refuses to boot with. "Configured
 * and not answering" is an outage, and it is the one a fail-closed limiter
 * exists for: it is the state an attacker can sometimes cause, and the one where
 * failing open opens an unlimited guessing window.
 *
 * Collapsing the two makes a limiter that either cannot fail closed in
 * production or cannot be developed against. `isConfigured` is what tells them
 * apart.
 */
export function isConfigured(): boolean {
  return client !== null;
}

export async function get<T>(spec: KeySpec): Promise<T | null> {
  if (!isAvailable()) return null;
  const key = build(spec);

  try {
    const raw = await client!.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error) {
    // A cache read failing is a miss. Rethrowing makes the cache a dependency.
    log.warn({ err: error, key }, 'Cache read failed');
    return null;
  }
}

export async function set(spec: KeySpec, value: unknown, ttlSeconds: number): Promise<void> {
  if (!isAvailable()) return;
  const key = build(spec);
  const ttl = ttlFor(spec.plane, ttlSeconds);

  try {
    await client!.set(key, JSON.stringify(value), 'EX', ttl);
  } catch (error) {
    log.warn({ err: error, key }, 'Cache write failed');
  }
}

export async function del(spec: KeySpec): Promise<void> {
  if (!isAvailable()) return;

  try {
    await client!.del(build(spec));
  } catch (error) {
    /*
     * A FAILED DELETE IS DIFFERENT FROM A FAILED READ OR WRITE, and this is the
     * one place the degradation argument does not hold cleanly. Deletes carry
     * revocations — a signed-out session, a withdrawn grant — and a delete that
     * silently failed leaves the old value readable until its TTL. That is why
     * `SESSION_CACHE_TTL_SECONDS` is 60: the TTL is the backstop for exactly
     * this, so the window is a minute rather than the session's lifetime.
     */
    log.error({ err: error }, 'Cache delete failed; the value will persist until its TTL');
  }
}

/**
 * Everything cached for one tenant, gone.
 *
 * FOR SUSPENSION AND DEPROVISIONING. `SCAN` rather than `KEYS`, because `KEYS` on
 * a large instance blocks the server for the length of the scan and takes every
 * other tenant down with it.
 */
export async function purgeTenant(organisationId: string): Promise<number> {
  if (!isAvailable()) return 0;

  const pattern = `${tenantPrefix(organisationId)}*`;
  let cursor = '0';
  let removed = 0;

  do {
    const [next, keys] = await client!.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) {
      removed += await client!.del(...keys);
    }
  } while (cursor !== '0');

  log.info({ organisationId, removed }, 'Purged tenant cache');
  return removed;
}

/**
 * Read through, writing what was computed.
 *
 * The plane and TTL come from the spec, so a caller cannot accidentally cache a
 * customer's result for an hour by passing the wrong number.
 */
export async function remember<T>(
  spec: KeySpec,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = await get<T>(spec);
  if (cached !== null) return cached;

  const value = await compute();
  await set(spec, value, ttlSeconds);
  return value;
}

/**
 * Increment a counter within a window, for rate limiting.
 *
 * THE TTL IS SET ONLY ON THE FIRST INCREMENT. Setting it every time makes a
 * sliding window that never expires while a caller keeps hitting it — so an
 * attacker sending one request per second holds the counter open forever and the
 * limit never resets.
 */
export async function increment(spec: KeySpec, windowSeconds: number): Promise<number> {
  if (!isAvailable()) {
    /*
     * NO CACHE MEANS NO RATE LIMITING, AND THE CALLER MUST DECIDE WHAT THAT
     * MEANS. Returning 0 says "not limited", which fails open. That is right for
     * a general request limiter and wrong for a login limiter, so this reports
     * the fact rather than choosing.
     */
    return 0;
  }

  const key = build(spec);
  const count = await client!.incr(key);
  if (count === 1) await client!.expire(key, windowSeconds);
  return count;
}

export async function close(): Promise<void> {
  await client?.quit();
}

/** For the readiness probe: whether the cache is reachable, not whether it exists. */
export async function ping(): Promise<{ configured: boolean; reachable: boolean }> {
  if (!client) return { configured: false, reachable: false };
  try {
    await client.ping();
    return { configured: true, reachable: true };
  } catch {
    return { configured: true, reachable: false };
  }
}

export { planeOf };
