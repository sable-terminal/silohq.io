// The three Redis instances of a cell (spec 5.2, 8.1): redis-session (hot copy of
// sessions), redis-data (results in flight, caches, queues, idempotency keys) and
// redis-state (live object state). All three are non-persistent and use TLS in transit
// (spec 8.3, binding). What each holds is declared in src/infra/keyspaces.infra.ts.

import { z } from 'zod';
import { parseSection, read, readSecret, zPositiveInt, type Env } from './env.config.ts';

export const REDIS_INSTANCES = ['session', 'data', 'state'] as const;
export type RedisInstance = (typeof REDIS_INSTANCES)[number];

const redisUrl = z.string().regex(/^rediss?:\/\/.+/, 'must be a redis:// or rediss:// URL');

const schema = z.object({
  session: redisUrl.optional(),
  data: redisUrl.optional(),
  state: redisUrl.optional(),
  caFile: z.string().optional(),
  // 'config': verify at startup with CONFIG GET that RDB and AOF are off. 'external':
  // the instance refuses CONFIG and its settings are verified by its operator; spec 8.3
  // allows a managed offering only where it guarantees them.
  persistenceCheck: z.enum(['config', 'external']).default('config'),
  // A command that takes longer fails, so a slow or unreachable Redis becomes a cache
  // miss or a refusal, never a request that hangs. Commands are not queued while the
  // client reconnects.
  commandTimeoutMs: zPositiveInt(30_000).default(2_000),
});

export type RedisConfig = z.output<typeof schema>;

export function loadRedisConfig(env: Env, problems: string[]): RedisConfig | undefined {
  return parseSection(schema, {
    session: readSecret(env, 'REDIS_SESSION_URL', problems),
    data: readSecret(env, 'REDIS_DATA_URL', problems),
    state: readSecret(env, 'REDIS_STATE_URL', problems),
    caFile: read(env, 'REDIS_CA_FILE'),
    persistenceCheck: read(env, 'REDIS_PERSISTENCE_CHECK'),
    commandTimeoutMs: read(env, 'REDIS_COMMAND_TIMEOUT_MS'),
  }, {
    session: 'REDIS_SESSION_URL', data: 'REDIS_DATA_URL', state: 'REDIS_STATE_URL',
    caFile: 'REDIS_CA_FILE', persistenceCheck: 'REDIS_PERSISTENCE_CHECK', commandTimeoutMs: 'REDIS_COMMAND_TIMEOUT_MS',
  }, problems);
}
