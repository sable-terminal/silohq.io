// The three Redis instances (spec 8.1, 8.3) and every key in them (design: Redis keyspaces).
//
// Every key belongs to a keyspace declared with defineKeyspace, as every bus message
// belongs to a registered schema. The catalogue is keyspaces.infra.ts. A keyspace names
// its instance, its key pattern, the Zod schema of what it holds, whether it may hold
// record values, its TTL cap and its size bound. The store has no call that writes
// outside a keyspace or without a TTL.
//
// Binding rules enforced here:
// - TTL on every key (spec 8.3): every write sets one in the same command, MULTI or
//   script. auditKeys serves the scheduled job that alerts on a key without a TTL, or one
//   that belongs to no keyspace.
// - No persistence (spec 8.3): connectRedis refuses an instance with RDB or AOF on.
// - Record values only where spec 8.5 allows them: result pages and the capture queue
//   on redis-data, live object state on redis-state (VALUE_CLASSES). A keyspace holds
//   values exactly when its schema has a recordValue() field.
// - Keys partitioned by organisation (spec 64.5): <class>:{<organisation_id>}:<rest>. The
//   braces are a Redis Cluster hash tag, so one organisation's keys of a class share a
//   slot and a script may touch several of them (design doc). Keys read before the
//   organisation is known form a closed set of global keyspaces whose hash tag is the
//   subject looked up (a hash of an address or email), so they spread across slots.
// - Bounds are refused, never truncated: a value over its keyspace's maxBytes, or a set
//   past maxMembers, is refused with the bound named. Instances run maxmemory-policy
//   noeviction (design doc), so a full instance refuses writes: AppError capacity
//   'redis.out_of_memory'. cached() fails open instead.
//
// Redis is never authoritative (spec 12.2): a missing key is a miss and the caller reads
// Postgres. So is a value that fails its schema on read; it is logged by category and
// deleted.

import { readFileSync } from 'node:fs';
import { Packr } from 'msgpackr';
import { createClient, ErrorReply, RESP_TYPES } from 'redis';
import { z } from 'zod';
import type { RedisConfig, RedisInstance } from '../config/redis.config.ts';
import { base64url, randomBytes } from '../utils/crypto.util.ts';
import { AppError, isAppError, refuse } from '../utils/errors.util.ts';
import { isUuid } from '../utils/id.util.ts';
import { containsRecordValue } from '../utils/recordValue.util.ts';
import type { Logger } from './logger.infra.ts';

// ----------------------------------------------------------------------------- keyspaces

/**
 * value: one MessagePack value. hash: a Redis hash, for values whose fields change on
 * their own (a session's revoked flag, counters). set and zset: members. counter: an
 * integer. lock: an owner token. stream: declared here, operated by its owning service.
 */
export type KeyspaceKind = 'value' | 'hash' | 'set' | 'zset' | 'counter' | 'lock' | 'stream';

/**
 * How a write to a set, sorted set, counter or hash field treats the TTL. reset: every
 * write sets it again. extend: never shortens it, so the key outlives its longest
 * member. keep: set when the key is created and never moved (a fixed window).
 */
export type TtlMode = 'reset' | 'extend' | 'keep';

// Spec 8.5: the only classes that may hold record values.
export const VALUE_CLASSES: Readonly<Record<RedisInstance, readonly string[]>> = {
  session: [],
  data: ['res', 'cq'],
  state: ['st'],
};

type Names<P extends string> = P extends `${string}<${infer N}>${infer Rest}` ? N | Names<Rest> : never;

/** The named parts of a key pattern, each an identifier or a non-negative integer. */
export type KeyParts<P extends string> = { readonly [K in Names<P>]: string | number };

type KeyArgs<P extends string> = P extends `${string}:{org}${string}`
  ? ([Names<P>] extends [never] ? [organisationId: string] : [organisationId: string, parts: KeyParts<P>])
  : [parts: KeyParts<P>];

declare const redisKeyBrand: unique symbol;
/** A key built by its keyspace. P is the keyspace pattern, so a key cannot be used with another keyspace. */
export type RedisKey<P extends string = string> = string & { readonly [redisKeyBrand]: P };

export interface KeyspaceDefinition<P extends string, K extends KeyspaceKind, S extends z.ZodType> {
  /**
   * The key, as the design doc writes it: '<class>:{org}:<name>:literal:<name>', or for a
   * global keyspace '<class>:{<subject>}:...', whose hash tag is a named part.
   */
  pattern: P;
  instance: RedisInstance;
  kind: K;
  /** value: the value. hash: an object of fields, each encoding to a string (hashField). set, zset: one member. counter: z.int(). lock: the token. */
  schema: S;
  /** May hold record values. Must match whether the schema has a recordValue() field. */
  values: boolean;
  /** max caps every TTL written; default applies when a write names none. */
  ttlSeconds: { max: number; default?: number };
  ttlMode?: TtlMode;
  /** Serialised bytes per key: value, hash and lock keyspaces. */
  maxBytes?: number;
  /** Members per key: set, zset and stream keyspaces. */
  maxMembers?: number;
}

type Segment = { literal: string } | { name: string };

export interface Keyspace<P extends string = string, K extends KeyspaceKind = KeyspaceKind, S extends z.ZodType = z.ZodType>
  extends Readonly<KeyspaceDefinition<P, K, S>> {
  readonly class: string;
  readonly scope: 'organisation' | 'global';
  readonly ttlMode: TtlMode;
  key(...args: KeyArgs<P>): RedisKey<P>;
  /** Whether a raw key belongs to this keyspace. */
  matches(key: string): boolean;
}

const PATTERN = /^([a-z][a-z0-9]*):\{(org|<[A-Za-z][A-Za-z0-9]*>)\}((?::(?:[a-z0-9_]+|<[A-Za-z][A-Za-z0-9]*>))*)$/;
const PART = /^[A-Za-z0-9_.-]{1,200}$/;
const PART_SOURCE = '[A-Za-z0-9_.-]{1,200}';
const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

const registered = new Map<string, Keyspace>();
const classInstance = new Map<string, RedisInstance>();

const segmentOf = (text: string): Segment => (text.startsWith('<') ? { name: text.slice(1, -1) } : { literal: text });

function partValue(parts: Record<string, string | number>, name: string): string {
  const value = parts[name];
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof text !== 'string' || !PART.test(text)) throw new TypeError(`key part ${name} must be an identifier`);
  return text;
}

export function defineKeyspace<const P extends string, K extends KeyspaceKind, S extends z.ZodType>(
  definition: KeyspaceDefinition<P, K, S>,
): Keyspace<P, K, S> {
  const where = `keyspace ${definition.pattern}`;
  const parsed = PATTERN.exec(definition.pattern);
  if (!parsed) throw new TypeError(`${where}: the pattern must be <class>:{org}:... or <class>:{<subject>}:...`);
  const [, cls, tag, rest] = parsed as unknown as [string, string, string, string];
  if (registered.has(definition.pattern)) throw new TypeError(`${where} is already defined`);
  const home = classInstance.get(cls);
  if (home !== undefined && home !== definition.instance) {
    throw new TypeError(`${where}: class ${cls} already lives on redis-${home}`);
  }
  const { max, default: fallback } = definition.ttlSeconds;
  if (!Number.isInteger(max) || max <= 0 || (fallback !== undefined && (!Number.isInteger(fallback) || fallback <= 0 || fallback > max))) {
    throw new TypeError(`${where}: TTLs are positive whole seconds, the default within the cap (spec 8.3)`);
  }
  const marked = containsRecordValue(definition.schema);
  if (marked !== definition.values) {
    throw new TypeError(`${where}: values must be true exactly when the schema has a recordValue() field`);
  }
  if (definition.values && !VALUE_CLASSES[definition.instance].includes(cls)) {
    throw new TypeError(`${where}: redis-${definition.instance} may not hold record values in ${cls} keys (spec 8.5)`);
  }
  const sized = ['value', 'hash', 'lock'].includes(definition.kind);
  if (sized && !(definition.maxBytes !== undefined && Number.isInteger(definition.maxBytes) && definition.maxBytes > 0)) {
    throw new TypeError(`${where}: a ${definition.kind} keyspace needs maxBytes`);
  }
  const counted = ['set', 'zset', 'stream'].includes(definition.kind);
  if (counted && !(definition.maxMembers !== undefined && Number.isInteger(definition.maxMembers) && definition.maxMembers > 0)) {
    throw new TypeError(`${where}: a ${definition.kind} keyspace needs maxMembers`);
  }
  const type = (definition.schema as unknown as { def: { type: string } }).def.type;
  if (definition.kind === 'hash' && type !== 'object' && type !== 'record') {
    throw new TypeError(`${where}: a hash keyspace's schema is an object of fields`);
  }

  const scope = tag === 'org' ? 'organisation' as const : 'global' as const;
  const tagSegment: Segment = scope === 'organisation' ? { literal: '' } : segmentOf(tag);
  const segments = rest.split(':').filter(Boolean).map(segmentOf);
  const source = [
    cls,
    `\\{${scope === 'organisation' ? UUID_SOURCE : PART_SOURCE}\\}`,
    ...segments.map((s) => ('literal' in s ? s.literal : PART_SOURCE)),
  ].join(':');
  const matcher = new RegExp(`^${source}$`);

  const keyspace: Keyspace<P, K, S> = {
    ...definition,
    class: cls,
    scope,
    ttlMode: definition.ttlMode ?? 'reset',
    key(...args: unknown[]): RedisKey<P> {
      let organisationId: string | undefined;
      let parts: Record<string, string | number>;
      if (scope === 'organisation') {
        organisationId = args[0] as string;
        if (!isUuid(organisationId)) throw new TypeError('organisation id must be a UUID');
        parts = (args[1] ?? {}) as Record<string, string | number>;
      } else {
        parts = (args[0] ?? {}) as Record<string, string | number>;
      }
      const tagText = organisationId ?? partValue(parts, (tagSegment as { name: string }).name);
      const restText = segments.map((s) => ('literal' in s ? s.literal : partValue(parts, s.name)));
      return [cls, `{${tagText}}`, ...restText].join(':') as RedisKey<P>;
    },
    matches: (key) => matcher.test(key),
  };
  registered.set(definition.pattern, keyspace as unknown as Keyspace);
  classInstance.set(cls, definition.instance);
  return keyspace;
}

/** Every keyspace defined in this process. The audit job imports keyspaces.infra.ts first. */
export function definedKeyspaces(): readonly Keyspace[] {
  return [...registered.values()];
}

/** Hash fields are strings in Redis; these encode the other field types (Zod codecs). */
export const hashField = {
  int: () => z.codec(z.string().regex(/^-?\d+$/), z.int(), { decode: (text) => Number(text), encode: (n) => String(n) }),
  flag: () => z.codec(z.enum(['0', '1']), z.boolean(), { decode: (text) => text === '1', encode: (b) => (b ? '1' : '0') }),
  timestamp: () => z.iso.datetime({ offset: true }),
};

// ----------------------------------------------------------------------------- store

type Client = ReturnType<typeof createClient>;

// Plain maps, no msgpackr record extension, so any MessagePack reader can decode a value.
const packr = new Packr({ useRecords: false, mapsAsObjects: true });

const TTL_SCRIPT = `
local function ttl(key, seconds, mode)
  if mode == 'reset' then redis.call('EXPIRE', key, seconds)
  elseif mode == 'extend' then redis.call('EXPIRE', key, seconds, 'NX'); redis.call('EXPIRE', key, seconds, 'GT')
  else redis.call('EXPIRE', key, seconds, 'NX') end
end
`;

// Adds members unless the key would pass its bound; the whole call is refused (-1).
// KEYS[1]; ARGV: max, ttl, mode, then the members (set) or score, member pairs (zset).
const SET_ADD = `${TTL_SCRIPT}
local new = 0
for i = 4, #ARGV do if redis.call('SISMEMBER', KEYS[1], ARGV[i]) == 0 then new = new + 1 end end
if redis.call('SCARD', KEYS[1]) + new > tonumber(ARGV[1]) then return -1 end
redis.call('SADD', KEYS[1], unpack(ARGV, 4))
ttl(KEYS[1], ARGV[2], ARGV[3])
return new`;

const ZSET_ADD = `${TTL_SCRIPT}
local new = 0
for i = 5, #ARGV, 2 do if not redis.call('ZSCORE', KEYS[1], ARGV[i]) then new = new + 1 end end
if redis.call('ZCARD', KEYS[1]) + new > tonumber(ARGV[1]) then return -1 end
redis.call('ZADD', KEYS[1], unpack(ARGV, 4))
ttl(KEYS[1], ARGV[2], ARGV[3])
return new`;

// Appends packed entries to a stream within its member bound (-1 refuses the whole batch),
// then applies the TTL mode. ARGV: max members, ttl, ttl mode, entry...
const STREAM_ADD = `${TTL_SCRIPT}
local add = #ARGV - 3
if redis.call('XLEN', KEYS[1]) + add > tonumber(ARGV[1]) then return -1 end
local ids = {}
for i = 4, #ARGV do ids[#ids + 1] = redis.call('XADD', KEYS[1], '*', 'v', ARGV[i]) end
ttl(KEYS[1], ARGV[2], ARGV[3])
return ids`;

// Changes fields of an existing hash only, so no key is created without a TTL; refuses
// (-2) if the hash would pass its byte bound. -1: no such key. ARGV: max bytes, field, value...
const HASH_SET_FIELDS = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local sizes = {}
local current = redis.call('HGETALL', KEYS[1])
for i = 1, #current, 2 do sizes[current[i]] = #current[i] + #current[i + 1] end
for i = 2, #ARGV, 2 do sizes[ARGV[i]] = #ARGV[i] + #ARGV[i + 1] end
local total = 0
for _, size in pairs(sizes) do total = total + size end
if total > tonumber(ARGV[1]) then return -2 end
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
return 1`;

// Creates the hash with a TTL unless it exists; returns the existing fields, or nothing.
const HASH_PUT_IF_ABSENT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('HGETALL', KEYS[1]) end
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('EXPIRE', KEYS[1], ARGV[1])
return false`;

// KEYS[1]; ARGV: max bytes, ttl, guard field ('' for none), guard value, then field, value
// pairs. 1 applied, 0 not newer, -1 not held, -2 over the size bound.
const LIVE_APPLY = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
if ARGV[3] ~= '' then
  local current = redis.call('HGET', KEYS[1], ARGV[3])
  if current then
    local a = tonumber(current)
    local b = tonumber(ARGV[4])
    if a and b then
      if b <= a then return 0 end
    elseif ARGV[4] <= current then return 0 end
  end
end
local sizes = {}
local current = redis.call('HGETALL', KEYS[1])
for i = 1, #current, 2 do sizes[current[i]] = #current[i] + #current[i + 1] end
for i = 5, #ARGV, 2 do sizes[ARGV[i]] = #ARGV[i] + #ARGV[i + 1] end
if ARGV[3] ~= '' then sizes[ARGV[3]] = #ARGV[3] + #ARGV[4] end
local total = 0
for _, size in pairs(sizes) do total = total + size end
if total > tonumber(ARGV[1]) then return -2 end
if #ARGV >= 5 then redis.call('HSET', KEYS[1], unpack(ARGV, 5)) end
if ARGV[3] ~= '' then redis.call('HSET', KEYS[1], ARGV[3], ARGV[4]) end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1`;

const LOCK_RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`;

const LOCK_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

// Lua's unpack takes a few thousand arguments; larger adds go in chunks, each atomic.
const CHUNK = 1_000;

type Of<S extends z.ZodType> = z.output<S>;

export interface KeyAudit {
  scanned: number;
  withoutTtl: number;
  /** Keys that match no keyspace defined for this instance. */
  unregistered: number;
  /** Up to AUDIT_SAMPLES of each, so the alert names what to look at. Keys hold no record values. */
  samples: { withoutTtl: string[]; unregistered: string[] };
}

const AUDIT_SAMPLES = 20;

export class RedisStore {
  readonly instance: RedisInstance;
  private readonly client: Client;
  private readonly binary: Client;
  private readonly logger: Logger | undefined;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(instance: RedisInstance, client: Client, logger?: Logger) {
    this.instance = instance;
    this.client = client;
    this.binary = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }) as unknown as Client;
    this.logger = logger;
  }

  // ------------------------------------------------------------------- value

  /** Writes a value with its TTL. With ifAbsent, only if the key does not exist; returns whether it wrote. */
  async put<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'value', S>, key: RedisKey<P>, value: Of<S>,
    options: { ttlSeconds?: number; ifAbsent?: boolean } = {},
  ): Promise<boolean> {
    this.own(keyspace, 'value');
    const ttl = ttlFor(keyspace, options.ttlSeconds);
    const bytes = packr.pack(validated(keyspace, value));
    withinBytes(keyspace, bytes.length);
    const reply = await this.run(keyspace, () => this.client.set(key, bytes, {
      expiration: { type: 'EX', value: ttl }, ...(options.ifAbsent ? { condition: 'NX' as const } : {}),
    }));
    return reply === 'OK';
  }

  async read<P extends string, S extends z.ZodType>(keyspace: Keyspace<P, 'value', S>, key: RedisKey<P>): Promise<Of<S> | undefined> {
    this.own(keyspace, 'value');
    const raw = await this.run(keyspace, () => this.binary.get(key)) as unknown as Buffer | null;
    if (raw === null) return undefined;
    let decoded: unknown;
    try {
      decoded = packr.unpack(raw);
    } catch {
      return this.invalid(keyspace, key);
    }
    const parsed = keyspace.schema.safeParse(decoded);
    return parsed.success ? parsed.data : this.invalid(keyspace, key);
  }

  // ------------------------------------------------------------------- hash

  /** Replaces the whole hash, with its TTL. */
  async putHash<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'hash', S>, key: RedisKey<P>, value: Of<S>, options: { ttlSeconds?: number } = {},
  ): Promise<void> {
    this.own(keyspace, 'hash');
    const ttl = ttlFor(keyspace, options.ttlSeconds);
    const fields = encodeFields(keyspace, keyspace.schema, value);
    withinBytes(keyspace, hashBytes(fields));
    await this.run(keyspace, () => this.client.multi().unlink(key).hSet(key, fields).expire(key, ttl).exec());
  }

  /** Creates the hash unless it exists. Returns created, or the hash that was already there. */
  async putHashIfAbsent<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'hash', S>, key: RedisKey<P>, value: Of<S>, options: { ttlSeconds?: number } = {},
  ): Promise<{ created: true } | { created: false; current: Of<S> | undefined }> {
    this.own(keyspace, 'hash');
    const ttl = ttlFor(keyspace, options.ttlSeconds);
    const fields = encodeFields(keyspace, keyspace.schema, value);
    withinBytes(keyspace, hashBytes(fields));
    const reply = await this.run(keyspace, () => this.client.eval(HASH_PUT_IF_ABSENT, {
      keys: [key], arguments: [String(ttl), ...Object.entries(fields).flat()],
    })) as string[] | null;
    if (reply === null) return { created: true };
    return { created: false, current: await this.decodeHash(keyspace, key, pairs(reply)) };
  }

  async readHash<P extends string, S extends z.ZodType>(keyspace: Keyspace<P, 'hash', S>, key: RedisKey<P>): Promise<Of<S> | undefined> {
    this.own(keyspace, 'hash');
    const raw = await this.run(keyspace, () => this.client.hGetAll(key)) as Record<string, string>;
    return Object.keys(raw).length === 0 ? undefined : this.decodeHash(keyspace, key, raw);
  }

  /** Changes some fields of an existing hash; its TTL stays. Returns false if the hash is gone. */
  async setFields<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'hash', S>, key: RedisKey<P>, changes: Partial<Of<S>>,
  ): Promise<boolean> {
    this.own(keyspace, 'hash');
    const schema = keyspace.schema as unknown as z.ZodObject;
    if (schema.def.type !== 'object') throw new TypeError(`${keyspace.pattern}: fields are set by its owning service`);
    const fields = encodeFields(keyspace, schema.partial(), changes);
    if (Object.keys(fields).length === 0) return true;
    const reply = await this.run(keyspace, () => this.client.eval(HASH_SET_FIELDS, {
      keys: [key], arguments: [String(keyspace.maxBytes), ...Object.entries(fields).flat()],
    })) as number;
    if (reply === -2) throw refuse.bound(`redis.${keyspace.class}.bytes`, keyspace.maxBytes!);
    return reply === 1;
  }

  /** Adds to an integer field, creating the hash if needed, with the keyspace's TTL mode. */
  async incrementField<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'hash', S>, key: RedisKey<P>, field: keyof Of<S> & string, by = 1,
    options: { ttlSeconds?: number } = {},
  ): Promise<number> {
    this.own(keyspace, 'hash');
    const ttl = ttlFor(keyspace, options.ttlSeconds);
    const shape = (keyspace.schema as unknown as z.ZodObject).def.shape as Record<string, unknown> | undefined;
    if (!shape || !(field in shape)) throw new TypeError(`${keyspace.pattern} has no field ${field}`);
    const reply = await this.run(keyspace, () => this.client.eval(`${TTL_SCRIPT}
local value = redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
ttl(KEYS[1], ARGV[3], ARGV[4])
return value`, { keys: [key], arguments: [field, String(by), String(ttl), keyspace.ttlMode] }));
    return Number(reply);
  }

  /**
   * State-plane: applies changed fields to a live object hash (dynamic fields per input and
   * source), only if the object is held and the change is newer than the last one applied
   * for its source (guard: the sequence field and the new sequence; numbers compare as
   * numbers, anything else as text, so ISO timestamps and zero-padded positions order).
   * The TTL is re-armed. applied, stale (not newer), absent (not held), or bound (the
   * object would pass its size).
   */
  async applyLiveFields<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'hash', S>, key: RedisKey<P>, guard: { field: string; value: string } | undefined,
    changes: Record<string, string>, options: { ttlSeconds?: number } = {},
  ): Promise<'applied' | 'stale' | 'absent' | 'bound'> {
    this.own(keyspace, 'hash');
    if (!keyspace.values) throw new TypeError(`${keyspace.pattern} does not hold live values`);
    const ttl = ttlFor(keyspace, options.ttlSeconds);
    const reply = await this.run(keyspace, () => this.client.eval(LIVE_APPLY, {
      keys: [key],
      arguments: [String(keyspace.maxBytes), String(ttl), guard?.field ?? '', guard?.value ?? '', ...Object.entries(changes).flat()],
    })) as number;
    return reply === 1 ? 'applied' : reply === 0 ? 'stale' : reply === -1 ? 'absent' : 'bound';
  }

  // ------------------------------------------------------------------- set and sorted set

  /** Adds members within the bound; returns how many were new. */
  async addMembers<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'set', S>, key: RedisKey<P>, members: Of<S>[], options: { ttlSeconds?: number } = {},
  ): Promise<number> {
    this.own(keyspace, 'set');
    const ttl = ttlFor(keyspace, options.ttlSeconds);
    const unique = [...new Set(members.map((m) => memberText(keyspace, m)))];
    let added = 0;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const reply = await this.run(keyspace, () => this.client.eval(SET_ADD, {
        keys: [key], arguments: [String(keyspace.maxMembers), String(ttl), keyspace.ttlMode, ...unique.slice(i, i + CHUNK)],
      })) as number;
      if (reply === -1) throw refuse.bound(`redis.${keyspace.class}.members`, keyspace.maxMembers!);
      added += reply;
    }
    return added;
  }

  async members<P extends string, S extends z.ZodType>(keyspace: Keyspace<P, 'set', S>, key: RedisKey<P>): Promise<Of<S>[]> {
    this.own(keyspace, 'set');
    const raw = await this.run(keyspace, () => this.client.sMembers(key)) as string[];
    const parsed = z.array(keyspace.schema).safeParse(raw);
    return parsed.success ? parsed.data : (await this.invalid(keyspace, key)) ?? [];
  }

  async removeMembers<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'set', S>, key: RedisKey<P>, members: Of<S>[],
  ): Promise<number> {
    this.own(keyspace, 'set');
    if (members.length === 0) return 0;
    return this.run(keyspace, () => this.client.sRem(key, members.map((m) => memberText(keyspace, m))));
  }

  async countMembers<P extends string>(keyspace: Keyspace<P, 'set' | 'zset'>, key: RedisKey<P>): Promise<number> {
    this.own(keyspace, keyspace.kind);
    return this.run(keyspace, () => (keyspace.kind === 'set' ? this.client.sCard(key) : this.client.zCard(key)));
  }

  /** Adds or re-scores members within the bound; returns how many were new. */
  async addScored<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'zset', S>, key: RedisKey<P>, entries: { member: Of<S>; score: number }[],
    options: { ttlSeconds?: number } = {},
  ): Promise<number> {
    this.own(keyspace, 'zset');
    const ttl = ttlFor(keyspace, options.ttlSeconds);
    const byMember = new Map(entries.map((e) => {
      if (!Number.isFinite(e.score)) throw new TypeError('a score must be a finite number');
      return [memberText(keyspace, e.member), e.score] as const;
    }));
    const flat = [...byMember].map(([member, score]) => [String(score), member]);
    let added = 0;
    for (let i = 0; i < flat.length; i += CHUNK) {
      const reply = await this.run(keyspace, () => this.client.eval(ZSET_ADD, {
        keys: [key], arguments: [String(keyspace.maxMembers), String(ttl), keyspace.ttlMode, ...flat.slice(i, i + CHUNK).flat()],
      })) as number;
      if (reply === -1) throw refuse.bound(`redis.${keyspace.class}.members`, keyspace.maxMembers!);
      added += reply;
    }
    return added;
  }

  /** The members of a sorted set scored at least min (all by default), lowest score first. */
  async scoredMembers<P extends string, S extends z.ZodType>(keyspace: Keyspace<P, 'zset', S>, key: RedisKey<P>, min?: number): Promise<Of<S>[]> {
    this.own(keyspace, 'zset');
    const raw = await this.run(keyspace, () => (min === undefined ? this.client.zRange(key, 0, -1)
      : this.client.zRangeByScore(key, min, '+inf'))) as string[];
    const parsed = z.array(keyspace.schema).safeParse(raw);
    return parsed.success ? parsed.data : (await this.invalid(keyspace, key)) ?? [];
  }

  async countScored<P extends string>(keyspace: Keyspace<P, 'zset'>, key: RedisKey<P>, min: number, max: number): Promise<number> {
    this.own(keyspace, 'zset');
    return this.run(keyspace, () => this.client.zCount(key, min, max));
  }

  /** Removes members scored at or below max (an expiry time, say). */
  async removeScoredUpTo<P extends string>(keyspace: Keyspace<P, 'zset'>, key: RedisKey<P>, max: number): Promise<number> {
    this.own(keyspace, 'zset');
    return this.run(keyspace, () => this.client.zRemRangeByScore(key, '-inf', max));
  }

  // ------------------------------------------------------------------- counter

  /** Adds to a counter (negative to subtract), with the keyspace's TTL mode. */
  // ------------------------------------------------------------------- stream

  /**
   * Appends entries to a stream, all or none: over the keyspace's member bound the batch is
   * refused (bounds), and the producer counts the gap. Returns the entries' ids.
   */
  async appendStream<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'stream', S>, key: RedisKey<P>, entries: Of<S>[], options: { ttlSeconds?: number } = {},
  ): Promise<string[]> {
    this.own(keyspace, 'stream');
    if (entries.length === 0) return [];
    const ttl = ttlFor(keyspace, options.ttlSeconds);
    const ids: string[] = [];
    for (let i = 0; i < entries.length; i += CHUNK) {
      const packed = entries.slice(i, i + CHUNK).map((e) => packr.pack(validated(keyspace, e)).toString('base64'));
      const reply = await this.run(keyspace, () => this.client.eval(STREAM_ADD, {
        keys: [key], arguments: [String(keyspace.maxMembers), String(ttl), keyspace.ttlMode, ...packed],
      })) as string[] | number;
      if (reply === -1) throw refuse.bound(`redis.${keyspace.class}.members`, keyspace.maxMembers!);
      ids.push(...(reply as string[]));
    }
    return ids;
  }

  /** The oldest entries of a stream, up to count, with their ids. An entry that does not decode is skipped and reported. */
  async readStream<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'stream', S>, key: RedisKey<P>, count: number,
  ): Promise<{ id: string; entry: Of<S> }[]> {
    this.own(keyspace, 'stream');
    const raw = await this.run(keyspace, () => this.client.xRange(key, '-', '+', { COUNT: count })) as { id: string; message: Record<string, string> }[];
    const out: { id: string; entry: Of<S> }[] = [];
    for (const r of raw) {
      try {
        const parsed = keyspace.schema.safeParse(packr.unpack(Buffer.from(r.message['v'] ?? '', 'base64')));
        if (parsed.success) out.push({ id: r.id, entry: parsed.data as Of<S> });
        else await this.invalid(keyspace, key);
      } catch {
        await this.invalid(keyspace, key);
      }
    }
    return out;
  }

  /** Removes entries by id once they are written where they belong. */
  async deleteStreamEntries<P extends string>(keyspace: Keyspace<P, 'stream'>, key: RedisKey<P>, ids: string[]): Promise<number> {
    this.own(keyspace, 'stream');
    if (ids.length === 0) return 0;
    return this.run(keyspace, () => this.client.xDel(key, ids));
  }

  async increment<P extends string>(
    keyspace: Keyspace<P, 'counter'>, key: RedisKey<P>, by = 1, options: { ttlSeconds?: number } = {},
  ): Promise<number> {
    this.own(keyspace, 'counter');
    if (!Number.isSafeInteger(by)) throw new TypeError('a counter moves by a whole number');
    const ttl = ttlFor(keyspace, options.ttlSeconds);
    const reply = await this.run(keyspace, () => this.client.eval(`${TTL_SCRIPT}
local value = redis.call('INCRBY', KEYS[1], ARGV[1])
ttl(KEYS[1], ARGV[2], ARGV[3])
return value`, { keys: [key], arguments: [String(by), String(ttl), keyspace.ttlMode] }));
    return Number(reply);
  }

  async readCounter<P extends string>(keyspace: Keyspace<P, 'counter'>, key: RedisKey<P>): Promise<number> {
    this.own(keyspace, 'counter');
    const raw = await this.run(keyspace, () => this.client.get(key));
    return raw === null ? 0 : Number(raw);
  }

  // ------------------------------------------------------------------- lock

  /** SET NX PX with a random owner token (design: lock keys). Undefined if someone holds it. */
  async acquireLock<P extends string>(keyspace: Keyspace<P, 'lock'>, key: RedisKey<P>, ttlSeconds?: number): Promise<string | undefined> {
    this.own(keyspace, 'lock');
    const ttl = ttlFor(keyspace, ttlSeconds);
    const token = base64url(randomBytes(16));
    const reply = await this.run(keyspace, () => this.client.set(key, token, {
      condition: 'NX', expiration: { type: 'PX', value: ttl * 1000 },
    }));
    return reply === 'OK' ? token : undefined;
  }

  /** Extends the lock if this token still holds it. */
  async renewLock<P extends string>(keyspace: Keyspace<P, 'lock'>, key: RedisKey<P>, token: string, ttlSeconds?: number): Promise<boolean> {
    this.own(keyspace, 'lock');
    const ttl = ttlFor(keyspace, ttlSeconds);
    return (await this.run(keyspace, () => this.client.eval(LOCK_RENEW, { keys: [key], arguments: [token, String(ttl * 1000)] }))) === 1;
  }

  /** Deletes the lock if this token still holds it. */
  async releaseLock<P extends string>(keyspace: Keyspace<P, 'lock'>, key: RedisKey<P>, token: string): Promise<boolean> {
    this.own(keyspace, 'lock');
    return (await this.run(keyspace, () => this.client.eval(LOCK_RELEASE, { keys: [key], arguments: [token] }))) === 1;
  }

  // ------------------------------------------------------------------- any kind

  /**
   * Re-arms a key's TTL, as reading a result page does (spec 8.1: "15 minutes after last
   * read"), following the keyspace's TTL mode: an extend keyspace is never shortened, so
   * auth can extend sessmem each time a session slides; a keep keyspace (a fixed window)
   * never moves. Returns whether the TTL changed.
   */
  async touch<P extends string>(keyspace: Keyspace<P>, key: RedisKey<P>, ttlSeconds?: number): Promise<boolean> {
    this.own(keyspace, keyspace.kind);
    if (keyspace.ttlMode === 'keep') throw new TypeError(`${keyspace.pattern} keeps the TTL it was created with`);
    const ttl = ttlFor(keyspace, ttlSeconds);
    const reply = keyspace.ttlMode === 'extend'
      ? await this.run(keyspace, () => this.client.expire(key, ttl, 'GT'))
      : await this.run(keyspace, () => this.client.expire(key, ttl));
    return reply === 1;
  }

  async remove<P extends string>(keyspace: Keyspace<P>, ...keys: RedisKey<P>[]): Promise<number> {
    this.own(keyspace, keyspace.kind);
    return keys.length === 0 ? 0 : this.run(keyspace, () => this.client.unlink(keys));
  }

  // ------------------------------------------------------------------- cache-aside

  /**
   * Cache-aside for a value keyspace. Concurrent calls in this process for one key share
   * one load. A Redis failure, a full instance or an oversized value never fails the
   * call: it loads and returns without caching. ttlSeconds 0 disables the cache (an
   * organisation may set 0, spec 8.1): nothing is read or written. A stale value is never
   * served as current because the key carries every version the value depends on (spec
   * 24.6, 7.7); a load that fails is not cached.
   */
  async cached<P extends string, S extends z.ZodType>(
    keyspace: Keyspace<P, 'value', S>, key: RedisKey<P>, load: () => Promise<Of<S>>, options: { ttlSeconds?: number } = {},
  ): Promise<Of<S>> {
    this.own(keyspace, 'value');
    if (options.ttlSeconds === 0) return load();
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<Of<S>>;
    const flight = (async () => {
      const hit = await this.read(keyspace, key).catch((error: unknown) => this.failOpen(keyspace, 'read', error));
      if (hit !== undefined) return hit;
      const value = await load();
      await this.put(keyspace, key, value, options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds })
        .catch((error: unknown) => this.failOpen(keyspace, 'write', error));
      return value;
    })();
    this.inFlight.set(key, flight);
    const clear = (): void => {
      if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
    };
    flight.then(clear, clear);
    return flight;
  }

  // ------------------------------------------------------------------- operations

  async ping(): Promise<void> {
    await this.client.ping();
  }

  // Refuses an instance that persists (spec 8.3), unless its operator verifies the
  // settings externally because the instance refuses CONFIG.
  async verifyNoPersistence(mode: RedisConfig['persistenceCheck']): Promise<void> {
    if (mode === 'external') return;
    const save = await this.client.configGet('save');
    const appendonly = await this.client.configGet('appendonly');
    if ((save['save'] ?? '') !== '' || appendonly['appendonly'] !== 'no') {
      throw new AppError('configuration', `redis-${this.instance} persists data; RDB and AOF must be off (spec 8.3)`, {
        code: 'redis.persistence_enabled', details: { instance: this.instance },
      });
    }
  }

  // For the scheduled job (spec 8.3, 13.2; design: "a scheduled job scans for keys with
  // TTL -1 and pages on any"): keys without a TTL, and keys of no keyspace defined for
  // this instance. Scans at most scanLimit keys with SCAN, never KEYS. The job imports
  // keyspaces.infra.ts so the catalogue is defined.
  /** match narrows the scan to a glob (an operator looking at one prefix); scanLimit bounds it. */
  async auditKeys(options: { scanLimit?: number; match?: string } = {}): Promise<KeyAudit> {
    const scanLimit = options.scanLimit ?? 100_000;
    const mine = definedKeyspaces().filter((k) => k.instance === this.instance);
    const audit: KeyAudit = { scanned: 0, withoutTtl: 0, unregistered: 0, samples: { withoutTtl: [], unregistered: [] } };
    const note = (list: string[], key: string) => { if (list.length < AUDIT_SAMPLES) list.push(key); };
    for await (const batch of this.client.scanIterator({ COUNT: 1000, ...(options.match ? { MATCH: options.match } : {}) })) {
      const keys = batch as string[];
      const ttls = await Promise.all(keys.map((key) => this.client.ttl(key)));
      keys.forEach((key, i) => {
        if (ttls[i] === -1) { audit.withoutTtl += 1; note(audit.samples.withoutTtl, key); }
        if (!mine.some((k) => k.matches(key))) { audit.unregistered += 1; note(audit.samples.unregistered, key); }
      });
      audit.scanned += keys.length;
      if (audit.scanned >= scanLimit) break;
    }
    return audit;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // ------------------------------------------------------------------- internals

  private own(keyspace: Keyspace, kind: KeyspaceKind): void {
    if (keyspace.instance !== this.instance) {
      throw new TypeError(`${keyspace.pattern} lives on redis-${keyspace.instance}, not redis-${this.instance}`);
    }
    if (keyspace.kind !== kind) throw new TypeError(`${keyspace.pattern} is a ${keyspace.kind} keyspace`);
  }

  private async run<T>(keyspace: Keyspace, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw redisFailure(this.instance, keyspace, error);
    }
  }

  private async decodeHash<S extends z.ZodType>(keyspace: Keyspace<string, 'hash', S>, key: string, raw: Record<string, string>)
    : Promise<Of<S> | undefined> {
    const decoded = keyspace.schema.safeDecode(raw as z.input<S>);
    return decoded.success ? decoded.data as Of<S> : this.invalid(keyspace, key);
  }

  // A value that fails its schema is a miss: logged by category, never by content, and
  // deleted so the next writer replaces it.
  private async invalid(keyspace: Keyspace, key: string): Promise<undefined> {
    this.logger?.warn('a Redis value failed its schema and was treated as a miss', {
      event: 'redis.invalid_value', dependency: `redis-${this.instance}`, resourceType: keyspace.class,
    });
    await this.client.unlink(key).catch(() => undefined);
    return undefined;
  }

  private failOpen(keyspace: Keyspace, operation: 'read' | 'write', error: unknown): undefined {
    this.logger?.failure(`a cache ${operation} failed and was skipped`, error, {
      event: 'redis.cache_skipped', dependency: `redis-${this.instance}`, resourceType: keyspace.class,
    });
    return undefined;
  }
}

function ttlFor(keyspace: Keyspace, ttlSeconds: number | undefined): number {
  const ttl = ttlSeconds ?? keyspace.ttlSeconds.default;
  if (ttl === undefined) throw new TypeError(`${keyspace.pattern} has no default TTL; name one (spec 8.3)`);
  if (!Number.isInteger(ttl) || ttl <= 0) throw new TypeError('every Redis key needs a positive TTL in whole seconds (spec 8.3)');
  if (ttl > keyspace.ttlSeconds.max) throw new TypeError(`${keyspace.pattern} keeps a key at most ${keyspace.ttlSeconds.max} seconds`);
  return ttl;
}

function validated(keyspace: Keyspace, value: unknown): unknown {
  const parsed = keyspace.schema.safeParse(value);
  if (!parsed.success) {
    // Issues name paths and expectations; the value is not echoed.
    throw new AppError('validation', `a ${keyspace.class} value does not match its keyspace schema`, {
      code: 'redis.schema_mismatch', details: { keyspace: keyspace.pattern, issues: parsed.error.issues.length },
    });
  }
  return parsed.data;
}

function encodeFields(keyspace: Keyspace, schema: z.ZodType, value: unknown): Record<string, string> {
  const encoded = schema.safeEncode(value);
  const fields = encoded.success ? encoded.data as Record<string, unknown> : undefined;
  if (!fields || Object.values(fields).some((v) => v !== undefined && typeof v !== 'string')) {
    throw new AppError('validation', `a ${keyspace.class} hash does not match its keyspace schema`, {
      code: 'redis.schema_mismatch', details: { keyspace: keyspace.pattern },
    });
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

function memberText(keyspace: Keyspace, member: unknown): string {
  const text = validated(keyspace, member);
  if (typeof text !== 'string') throw new TypeError(`${keyspace.pattern} members are strings`);
  return text;
}

const hashBytes = (fields: Record<string, string>): number =>
  Object.entries(fields).reduce((sum, [f, v]) => sum + Buffer.byteLength(f) + Buffer.byteLength(v), 0);

function withinBytes(keyspace: Keyspace, bytes: number): void {
  if (bytes > keyspace.maxBytes!) throw refuse.bound(`redis.${keyspace.class}.bytes`, keyspace.maxBytes!, { bytes });
}

const pairs = (flat: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]!] = flat[i + 1]!;
  return out;
};

// Redis failures as AppErrors. A full instance (noeviction) is capacity; anything that
// means Redis cannot be reached in time is unavailable. Redis's own message is kept as
// the cause only, which is never logged.
function redisFailure(instance: RedisInstance, keyspace: Keyspace, error: unknown): unknown {
  if (isAppError(error) || error instanceof TypeError) return error;
  const details = { instance, keyspace: keyspace.class };
  if (error instanceof ErrorReply && error.message.startsWith('OOM')) {
    return new AppError('capacity', `redis-${instance} is full`, {
      code: 'redis.out_of_memory', details, retryAfterSeconds: 1, cause: error,
    });
  }
  if (error instanceof ErrorReply) {
    return new AppError('internal', `redis-${instance} refused the command`, { code: 'redis.refused', details, cause: error });
  }
  return new AppError('unavailable', `redis-${instance} is unavailable`, { code: 'redis.unavailable', details, cause: error });
}

// ----------------------------------------------------------------------------- connection

export async function connectRedis(
  instance: RedisInstance, config: RedisConfig, options: { logger?: Logger } = {},
): Promise<RedisStore> {
  const url = config[instance];
  if (url === undefined) {
    throw new AppError('configuration', `redis-${instance} is not configured`, { code: `config.redis.${instance}` });
  }
  const client: Client = createClient({
    url,
    // A command fails rather than waits: none is queued while reconnecting, and each has
    // a timeout, so a Redis outage is a miss or a refusal, never a hung request.
    disableOfflineQueue: true,
    commandOptions: { timeout: config.commandTimeoutMs },
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 5_000),
      ...(url.startsWith('rediss://') && config.caFile ? { tls: true as const, ca: readFileSync(config.caFile, 'utf8') } : {}),
    },
  });
  // Connection errors surface through commands; the listener only stops an unhandled
  // 'error' event from crashing the process.
  client.on('error', () => undefined);
  await client.connect();
  const store = new RedisStore(instance, client, options.logger);
  try {
    await store.verifyNoPersistence(config.persistenceCheck);
  } catch (error) {
    await client.close();
    throw error;
  }
  return store;
}
