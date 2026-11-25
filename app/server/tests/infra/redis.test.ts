// Redis (spec 8.3, 8.5; design: Redis keyspaces): every key belongs to a keyspace and
// has a TTL, keys carry the organisation as a hash tag, values are validated and bounded,
// a full instance refuses writes, the cache fails open, and an instance that persists is
// refused.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { unpack } from 'msgpackr';
import { createClient, RESP_TYPES } from 'redis';
import { z } from 'zod';
import {
  changeDedupKeys, claimIdempotencyKey, completeIdempotencyKey, idempotencyKeys, liveIndexKeys, lockKeys,
  membershipSessionKeys, permissionKeys, quotaKeys, rateLimitKeys, releaseIdempotencyKey, resultCacheKeys,
  resultPageKeys, sessionKeys, withLock,
} from '../../src/infra/keyspaces.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { connectRedis, defineKeyspace, definedKeyspaces, hashField, type RedisStore } from '../../src/infra/redis.infra.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';
import { recordValue } from '../../src/utils/recordValue.util.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { LOCAL } from './services.helper.ts';

const config = {
  session: LOCAL.redisUrl, data: LOCAL.redisUrl, state: LOCAL.redisUrl, persistenceCheck: 'config' as const, commandTimeoutMs: 2_000,
};
const logLines: string[] = [];
const logger = createLogger({ service: 'test', cell: 'test', release: 'test', level: 'debug', write: (line) => logLines.push(line) });

let data: RedisStore;
let session: RedisStore;
let state: RedisStore;
let raw: ReturnType<typeof createClient>;

// Test keyspaces, under test classes so they cannot collide with the catalogue.
const Note = defineKeyspace({
  pattern: 'tnote:{org}:<noteId>', instance: 'data', kind: 'value', values: false,
  schema: z.object({ title: z.string(), count: z.int() }), ttlSeconds: { max: 600, default: 60 }, maxBytes: 128,
});
const Profile = defineKeyspace({
  pattern: 'tprof:{org}:<profileId>', instance: 'data', kind: 'hash', values: false,
  schema: z.object({ name: z.string(), visits: hashField.int(), active: hashField.flag(), seenAt: hashField.timestamp() }),
  ttlSeconds: { max: 600, default: 300 }, maxBytes: 200,
});
const Members = defineKeyspace({
  pattern: 'tmem:{org}:<groupId>', instance: 'data', kind: 'set', values: false, schema: z.string(),
  ttlSeconds: { max: 600, default: 100 }, ttlMode: 'extend', maxMembers: 3,
});
const Window = defineKeyspace({
  pattern: 'twin:{org}:<name>', instance: 'data', kind: 'counter', values: false, schema: z.int(),
  ttlSeconds: { max: 600, default: 60 }, ttlMode: 'keep',
});
const TestLock = defineKeyspace({
  pattern: 'tlock:{org}:<name>', instance: 'data', kind: 'lock', values: false, schema: z.string(),
  ttlSeconds: { max: 30, default: 1 }, maxBytes: 64,
});

before(async () => {
  data = await connectRedis('data', config, { logger });
  session = await connectRedis('session', config, { logger });
  state = await connectRedis('state', config, { logger });
  raw = createClient({ url: LOCAL.redisUrl });
  await raw.connect();
});

after(async () => {
  await data?.close();
  await session?.close();
  await state?.close();
  await raw?.close();
});

describe('keys', () => {
  test('carry the class, then the organisation as a hash tag, then the parts', () => {
    const org = uuidv7();
    assert.equal(sessionKeys.key(org, { sessionId: 's1' }), `sess:{${org}}:s1`);
    assert.equal(resultPageKeys.key(org, { queryId: 'q1', page: 3 }), `res:{${org}}:q1:p:3`);
    assert.equal(liveIndexKeys.key(org), `live:{${org}}`);
    assert.equal(
      resultCacheKeys.key(org, { planHash: 'ab', ontologyVersion: 7, periodResolution: 'month', permissionFingerprint: 'cd' }),
      `cache:{${org}}:ab:7:month:cd`);
    assert.ok(sessionKeys.matches(sessionKeys.key(org, { sessionId: 's1' })));
    assert.ok(!sessionKeys.matches(`sess:{${org}}:s1:extra`));
  });

  test('a global key is tagged by its subject, so global keys spread across slots', () => {
    assert.equal(rateLimitKeys.key({ subject: '9f86d081', limit: 'login' }), 'rl:{9f86d081}:login');
  });

  test('refuse anything but a UUID organisation and identifier parts', () => {
    const org = uuidv7();
    assert.throws(() => sessionKeys.key('acme', { sessionId: 's' }), TypeError);
    for (const bad of ['has space', 'a:b', '{x}', '', 'x'.repeat(201)]) {
      assert.throws(() => sessionKeys.key(org, { sessionId: bad }), TypeError, bad);
    }
    assert.throws(() => resultPageKeys.key(org, { queryId: 'q', page: -1 }), TypeError);
    assert.throws(() => resultPageKeys.key(org, { queryId: 'q' } as never), TypeError);
  });
});

describe('keyspace registry', () => {
  const base = { instance: 'data' as const, kind: 'value' as const, values: false, schema: z.string(), ttlSeconds: { max: 60 }, maxBytes: 10 };
  const { maxBytes: _bound, ...unbounded } = base;

  test('the catalogue covers the three instances', () => {
    const classes = (instance: string) => [...new Set(definedKeyspaces().filter((k) => k.instance === instance).map((k) => k.class))].sort();
    assert.deepEqual(classes('session'), ['perm', 'purp', 'sess', 'sessmem', 'stf']);
    assert.deepEqual(classes('state'), ['cs', 'dedup', 'live', 'st', 'sub']);
    for (const c of ['res', 'cache', 'tun', 'lock', 'cq', 'cqgap', 'idem', 'quota', 'rl']) assert.ok(classes('data').includes(c), c);
  });

  test('refuses a pattern twice, and one class on two instances', () => {
    assert.throws(() => defineKeyspace({ ...base, pattern: 'tnote:{org}:<noteId>' }), /already defined/);
    assert.throws(() => defineKeyspace({ ...base, pattern: 'tnote:{org}:x:<y>', instance: 'state' }), /already lives/);
  });

  test('record values only where spec 8.5 allows, and only when the schema says so', () => {
    const marked = recordValue(z.string());
    assert.throws(() => defineKeyspace({ ...base, pattern: 'tv1:{org}:<a>', schema: marked }), /recordValue/);
    assert.throws(() => defineKeyspace({ ...base, pattern: 'tv2:{org}:<a>', values: true }), /recordValue/);
    assert.throws(() => defineKeyspace({ ...base, pattern: 'tv3:{org}:<a>', schema: marked, values: true }), /spec 8\.5/);
    assert.throws(() => defineKeyspace({ ...base, pattern: 'res:{org}:<a>:tv4', instance: 'session', schema: marked, values: true }),
      /already lives|spec 8\.5/);
  });

  test('refuses a bad pattern, TTL or missing bound', () => {
    assert.throws(() => defineKeyspace({ ...base, pattern: 'Bad:{org}' }), /pattern/);
    assert.throws(() => defineKeyspace({ ...base, pattern: 'tb1:org:<a>' }), /pattern/);
    assert.throws(() => defineKeyspace({ ...base, pattern: 'tb2:{org}:<a>', ttlSeconds: { max: 60, default: 61 } }), /TTL/);
    assert.throws(() => defineKeyspace({ ...base, pattern: 'tb3:{org}:<a>', ttlSeconds: { max: 0 } }), /TTL/);
    assert.throws(() => defineKeyspace({ ...unbounded, pattern: 'tb4:{org}:<a>' }), /maxBytes/);
    assert.throws(() => defineKeyspace({ ...unbounded, pattern: 'tb5:{org}:<a>', kind: 'set' }), /maxMembers/);
    assert.throws(() => defineKeyspace({ ...base, pattern: 'tb6:{org}:<a>', kind: 'hash' }), /object of fields/);
  });
});

describe('values', () => {
  test('are MessagePack, validated, and written with a TTL no longer than the keyspace allows', async () => {
    const key = Note.key(uuidv7(), { noteId: 'n1' });
    assert.equal(await data.put(Note, key, { title: 'hello', count: 2 }), true);
    assert.deepEqual(await data.read(Note, key), { title: 'hello', count: 2 });
    const ttl = await raw.ttl(key);
    assert.ok(ttl > 0 && ttl <= 60, `default TTL, got ${ttl}`);
    const bytes = await raw.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }).get(key);
    assert.deepEqual(unpack(bytes as unknown as Buffer), { title: 'hello', count: 2 });
    await assert.rejects(data.put(Note, key, { title: 'x', count: 1 }, { ttlSeconds: 601 }), TypeError);
    await assert.rejects(data.put(Note, key, { title: 'x', count: 1 }, { ttlSeconds: 0 }), TypeError);
    await assert.rejects(data.put(Note, key, { title: 'x', count: 1.5 }), { category: 'validation', code: 'redis.schema_mismatch' });
    assert.equal(await data.put(Note, key, { title: 'again', count: 3 }, { ifAbsent: true }), false);
  });

  test('a value over its bound is refused with the bound named, never truncated', async () => {
    const key = Note.key(uuidv7(), { noteId: 'big' });
    await assert.rejects(data.put(Note, key, { title: 'x'.repeat(200), count: 1 }),
      { category: 'bounds', code: 'bound.redis.tnote.bytes' });
    assert.equal(await raw.exists(key), 0);
  });

  test('a value that fails its schema on read is a miss, logged by category and deleted', async () => {
    const key = Note.key(uuidv7(), { noteId: 'corrupt' });
    await raw.set(key, 'not messagepack of a note', { expiration: { type: 'EX', value: 60 } });
    logLines.length = 0;
    assert.equal(await data.read(Note, key), undefined);
    assert.equal(await raw.exists(key), 0);
    const line = JSON.parse(logLines.at(-1)!);
    assert.equal(line.event, 'redis.invalid_value');
    assert.equal(line.resourceType, 'tnote');
    assert.ok(!logLines.join('').includes('not messagepack'));
  });

  test('a keyspace is used only on its own instance and as its own kind', async () => {
    const org = uuidv7();
    await assert.rejects(data.put(permissionKeys, permissionKeys.key(org, { sessionId: 's', policyVersion: 1 }),
      { membershipActive: true, grants: [], memberScopePaths: [], obligations: [] }), /lives on redis-session/);
    await assert.rejects(session.put(Note as never, Note.key(org, { noteId: 'x' }) as never, { title: 'x', count: 1 } as never),
      /lives on redis-data/);
  });
});

describe('hashes', () => {
  test('encode fields to strings and decode them back', async () => {
    const key = Profile.key(uuidv7(), { profileId: 'p1' });
    const seenAt = '2026-10-29T08:00:00.123456+00:00';
    await data.putHash(Profile, key, { name: 'ada', visits: 3, active: true, seenAt });
    assert.deepEqual(await raw.hGetAll(key), { name: 'ada', visits: '3', active: '1', seenAt });
    assert.deepEqual(await data.readHash(Profile, key), { name: 'ada', visits: 3, active: true, seenAt });
    assert.ok((await raw.ttl(key)) > 0);
  });

  test('setFields changes an existing hash only, keeps its TTL, and respects the bound', async () => {
    const org = uuidv7();
    const key = Profile.key(org, { profileId: 'p2' });
    await data.putHash(Profile, key, { name: 'ada', visits: 1, active: true, seenAt: '2026-10-29T08:00:00Z' }, { ttlSeconds: 500 });
    assert.equal(await data.setFields(Profile, key, { active: false }), true);
    assert.equal((await data.readHash(Profile, key))?.active, false);
    assert.ok((await raw.ttl(key)) > 400);
    await assert.rejects(data.setFields(Profile, key, { name: 'x'.repeat(300) }), { category: 'bounds' });
    const missing = Profile.key(org, { profileId: 'gone' });
    assert.equal(await data.setFields(Profile, missing, { active: false }), false);
    assert.equal(await raw.exists(missing), 0, 'no key created without a TTL');
  });

  test('incrementField counts atomically with a TTL', async () => {
    const key = Profile.key(uuidv7(), { profileId: 'p3' });
    assert.equal(await data.incrementField(Profile, key, 'visits'), 1);
    assert.equal(await data.incrementField(Profile, key, 'visits', 4), 5);
    assert.ok((await raw.ttl(key)) > 0);
  });

  test('the session hot copy holds names and flags only', async () => {
    const org = uuidv7();
    const key = sessionKeys.key(org, { sessionId: uuidv7() });
    const now = '2026-10-29T08:00:00.000000+00:00';
    await session.putHash(sessionKeys, key, {
      membershipId: uuidv7(), userId: uuidv7(), authStrength: 'mfa', policyVersionAtIssue: 4,
      issuedAt: now, idleExpiresAt: now, absoluteExpiresAt: now, idleMinutes: 30, revoked: false, tokenHash: 'ab'.repeat(32),
    }, { ttlSeconds: 1800 });
    assert.equal(await session.setFields(sessionKeys, key, { revoked: true }), true);
    assert.equal((await session.readHash(sessionKeys, key))?.revoked, true);
    await assert.rejects(session.putHash(sessionKeys, key, {} as never, { ttlSeconds: 60 }), { code: 'redis.schema_mismatch' });
    await assert.rejects(session.putHash(sessionKeys, key, {
      authStrength: 'mfa', policyVersionAtIssue: 1, issuedAt: now, idleExpiresAt: now, absoluteExpiresAt: now, idleMinutes: 30,
      revoked: false, tokenHash: 'ab'.repeat(32),
    }), /no default TTL/);
  });
});

describe('sets, sorted sets and counters', () => {
  test('a set refuses an add past its bound, and extend never shortens its TTL', async () => {
    const key = Members.key(uuidv7(), { groupId: 'g1' });
    assert.equal(await data.addMembers(Members, key, ['a', 'b'], { ttlSeconds: 300 }), 2);
    assert.equal(await data.addMembers(Members, key, ['b', 'c'], { ttlSeconds: 50 }), 1);
    assert.ok((await raw.ttl(key)) > 250, 'a shorter TTL did not shorten it');
    await assert.rejects(data.addMembers(Members, key, ['d']), { category: 'bounds', code: 'bound.redis.tmem.members' });
    assert.deepEqual((await data.members(Members, key)).sort(), ['a', 'b', 'c']);
    await data.addMembers(Members, key, ['a'], { ttlSeconds: 500 });
    assert.ok((await raw.ttl(key)) > 450, 'a longer TTL extended it');
    assert.equal(await data.removeMembers(Members, key, ['a']), 1);
    assert.equal(await data.countMembers(Members, key), 2);
  });

  test('membership sessions keep at most 100 and outlive their longest session', async () => {
    const key = membershipSessionKeys.key(uuidv7(), { membershipId: uuidv7() });
    await session.addMembers(membershipSessionKeys, key, Array.from({ length: 100 }, () => uuidv7()), { ttlSeconds: 3600 });
    await assert.rejects(session.addMembers(membershipSessionKeys, key, [uuidv7()], { ttlSeconds: 60 }), { category: 'bounds' });
    assert.ok((await raw.ttl(key)) > 3500);
    // A session sliding to a later expiry extends the set; a shorter touch never shortens it.
    assert.equal(await session.touch(membershipSessionKeys, key, 7200), true);
    assert.equal(await session.touch(membershipSessionKeys, key, 60), false);
    assert.ok((await raw.ttl(key)) > 7100);
  });

  test('a sorted set counts and trims by score', async () => {
    const org = uuidv7();
    const live = liveIndexKeys.key(org);
    const objects = [uuidv7(), uuidv7(), uuidv7()];
    assert.equal(await state.addScored(liveIndexKeys, live, objects.map((member, i) => ({ member, score: 100 + i }))), 3);
    assert.equal(await state.countScored(liveIndexKeys, live, 101, Infinity), 2);
    assert.equal(await state.removeScoredUpTo(liveIndexKeys, live, 100), 1);
    assert.equal(await state.countMembers(liveIndexKeys, live), 2);
    await assert.rejects(state.addScored(changeDedupKeys, changeDedupKeys.key(org, { connectionId: 'c' }), [{ member: 'nothex', score: 1 }]),
      { code: 'redis.schema_mismatch' });
  });

  test('a fixed-window counter keeps the TTL its first increment set', async () => {
    const key = Window.key(uuidv7(), { name: 'w' });
    assert.equal(await data.increment(Window, key, 1, { ttlSeconds: 300 }), 1);
    assert.equal(await data.increment(Window, key, 1, { ttlSeconds: 30 }), 2);
    assert.ok((await raw.ttl(key)) > 250);
    await assert.rejects(data.touch(Window, key, 600), TypeError, 'a fixed window never moves');
    const quota = quotaKeys.key(uuidv7(), { quotaClass: 'pages' });
    assert.equal(await data.increment(quotaKeys, quota, 4096), 4096);
    assert.equal(await data.increment(quotaKeys, quota, -1024), 3072);
    assert.equal(await data.readCounter(quotaKeys, quota), 3072);
  });
});

describe('locks', () => {
  test('one holder at a time; only the holder renews or releases', async () => {
    const key = lockKeys.key(uuidv7(), { purpose: 'oauth', resourceId: uuidv7() });
    const token = await data.acquireLock(lockKeys, key);
    assert.ok(token);
    assert.equal(await data.acquireLock(lockKeys, key), undefined);
    assert.equal(await data.renewLock(lockKeys, key, 'not-the-token'), false);
    assert.equal(await data.releaseLock(lockKeys, key, 'not-the-token'), false);
    assert.equal(await data.renewLock(lockKeys, key, token), true);
    assert.equal(await data.releaseLock(lockKeys, key, token), true);
    assert.equal(await raw.exists(key), 0);
  });

  test('withLock renews while work runs, and releases after', async () => {
    const key = TestLock.key(uuidv7(), { name: 'refresh' });
    const outcome = await withLock(data, TestLock, key, async (signal) => {
      assert.deepEqual(await withLock(data, TestLock, key, async () => 'second'), { acquired: false });
      await sleep(1_500); // longer than the 1-second TTL: renewal keeps it
      assert.equal(signal.aborted, false);
      assert.equal(await raw.exists(key), 1);
      return 'done';
    });
    assert.deepEqual(outcome, { acquired: true, value: 'done' });
    assert.equal(await raw.exists(key), 0);
  });

  test('withLock aborts work whose lock was lost, and never deletes the new holder', async () => {
    const key = TestLock.key(uuidv7(), { name: 'lost' });
    const outcome = await withLock(data, TestLock, key, async (signal) => {
      await raw.set(key, 'someone-else', { expiration: { type: 'PX', value: 5_000 } });
      for (let i = 0; i < 30 && !signal.aborted; i++) await sleep(50);
      return signal.aborted;
    });
    assert.deepEqual(outcome, { acquired: true, value: true });
    assert.equal(await raw.get(key), 'someone-else');
  });
});

describe('idempotency keys', () => {
  test('claim, refuse while in progress, then return the result', async () => {
    const org = uuidv7();
    const idem = uuidv7();
    assert.deepEqual(await claimIdempotencyKey(data, org, 'mutation', idem), { state: 'claimed' });
    assert.deepEqual(await claimIdempotencyKey(data, org, 'mutation', idem), { state: 'in_progress' });
    await completeIdempotencyKey(data, org, 'mutation', idem, 'receipt-1');
    assert.deepEqual(await claimIdempotencyKey(data, org, 'mutation', idem), { state: 'done', resultRef: 'receipt-1' });
    const key = idempotencyKeys.key(org, { scope: 'mutation', idempotencyKey: idem });
    const ttl = await raw.ttl(key);
    assert.ok(ttl > 86_000 && ttl <= 86_400);
  });

  test('a released key may be claimed again, and a malformed key is refused', async () => {
    const org = uuidv7();
    assert.deepEqual(await claimIdempotencyKey(data, org, 'export', 'k-1'), { state: 'claimed' });
    await releaseIdempotencyKey(data, org, 'export', 'k-1');
    assert.deepEqual(await claimIdempotencyKey(data, org, 'export', 'k-1'), { state: 'claimed' });
    await assert.rejects(claimIdempotencyKey(data, org, 'export', 'has space'), { category: 'validation', code: 'idempotency.invalid_key' });
  });
});

describe('cache-aside', () => {
  const grant = (permissions: string[]) => ({ permissions, scopePath: null, resourceType: null, resourceId: null });
  const perm = { membershipActive: true, grants: [grant(['silo.read'])], memberScopePaths: [], obligations: [] };

  test('concurrent callers share one load, and a later call is a hit', async () => {
    const key = permissionKeys.key(uuidv7(), { sessionId: uuidv7(), policyVersion: 3 });
    let loads = 0;
    const load = async () => {
      loads += 1;
      await sleep(50);
      return perm;
    };
    const results = await Promise.all([1, 2, 3, 4].map(() => session.cached(permissionKeys, key, load)));
    assert.equal(loads, 1);
    assert.ok(results.every((r) => r.grants[0]!.permissions[0] === 'silo.read'));
    await session.cached(permissionKeys, key, load);
    assert.equal(loads, 1);
    assert.ok((await raw.ttl(key)) <= 15 * 60);
  });

  test('a TTL of 0 disables the cache: nothing is read or written', async () => {
    const org = uuidv7();
    const key = resultCacheKeys.key(org, { planHash: 'aa', ontologyVersion: 1, periodResolution: 'day', permissionFingerprint: 'bb' });
    let loads = 0;
    const load = async () => { loads += 1; return { queryId: uuidv7(), computedAt: '2026-10-29T08:00:00Z' }; };
    await data.cached(resultCacheKeys, key, load, { ttlSeconds: 0 });
    await data.cached(resultCacheKeys, key, load, { ttlSeconds: 0 });
    assert.equal(loads, 2);
    assert.equal(await raw.exists(key), 0);
  });

  test('a value over its bound is served but not cached', async () => {
    const key = permissionKeys.key(uuidv7(), { sessionId: uuidv7(), policyVersion: 1 });
    const huge = { ...perm, grants: [grant(Array.from({ length: 1000 }, (_, i) => `permission.${'x'.repeat(80)}.${i}`))] };
    assert.equal((await session.cached(permissionKeys, key, async () => huge)).grants[0]!.permissions.length, 1000);
    assert.equal(await raw.exists(key), 0);
  });

  test('a Redis outage fails open: the load runs and its value is returned', async () => {
    const down = await connectRedis('session', config, { logger });
    await down.close();
    const key = permissionKeys.key(uuidv7(), { sessionId: uuidv7(), policyVersion: 1 });
    assert.deepEqual(await down.cached(permissionKeys, key, async () => perm), perm);
    await assert.rejects(down.put(permissionKeys, key, perm), { category: 'unavailable', code: 'redis.unavailable' });
  });

  test('a load that fails is not cached', async () => {
    const key = permissionKeys.key(uuidv7(), { sessionId: uuidv7(), policyVersion: 1 });
    await assert.rejects(session.cached(permissionKeys, key, async () => { throw new Error('policy down'); }), /policy down/);
    assert.equal(await raw.exists(key), 0);
  });
});

describe('instance rules', () => {
  test('a full instance refuses writes as capacity; the cache fails open (noeviction)', async () => {
    const [{ maxmemory }, { 'maxmemory-policy': policy }] = [await raw.configGet('maxmemory'), await raw.configGet('maxmemory-policy')];
    const key = Note.key(uuidv7(), { noteId: 'oom' });
    const pageKey = resultPageKeys.key(uuidv7(), { queryId: 'q', page: 1 });
    try {
      await raw.configSet({ maxmemory: '1', 'maxmemory-policy': 'noeviction' });
      await assert.rejects(data.put(Note, key, { title: 'x', count: 1 }), { category: 'capacity', code: 'redis.out_of_memory' });
      await assert.rejects(data.put(resultPageKeys, pageKey, [{ a: 1 }] as never), { category: 'capacity' });
      assert.deepEqual(await data.cached(Note, key, async () => ({ title: 'y', count: 2 })), { title: 'y', count: 2 });
      assert.equal(await data.read(Note, key), undefined, 'reads still work');
    } finally {
      await raw.configSet({ maxmemory: maxmemory ?? '0', 'maxmemory-policy': policy ?? 'noeviction' });
    }
  });

  test('the audit finds keys without a TTL and keys of no keyspace', async () => {
    // Scoped to this test's keys: whole-instance counts drift as other tests' keys expire.
    const run = uuidv7();
    const strays = [`stray:${run}:a`, `stray:${run}:b`];
    await raw.set(strays[0]!, 'no ttl');
    await raw.set(strays[1]!, 'unregistered', { expiration: { type: 'EX', value: 60 } });
    const org = uuidv7();
    const registered = Note.key(org, { noteId: 'audited' });
    await data.put(Note, registered, { title: 'a', count: 1 });
    try {
      const audit = await data.auditKeys({ match: `stray:${run}:*` });
      assert.equal(audit.scanned, 2);
      assert.equal(audit.withoutTtl, 1);
      assert.equal(audit.unregistered, 2);
      assert.deepEqual(audit.samples.withoutTtl, [strays[0]]);
      assert.deepEqual([...audit.samples.unregistered].sort(), [...strays].sort());
      const clean = await data.auditKeys({ match: registered });
      assert.deepEqual({ scanned: clean.scanned, withoutTtl: clean.withoutTtl, unregistered: clean.unregistered }, { scanned: 1, withoutTtl: 0, unregistered: 0 });
      const whole = await data.auditKeys();
      assert.ok(whole.withoutTtl >= 1 && whole.samples.withoutTtl.length <= 20, 'the unscoped audit counts them too, with a bounded sample');
    } finally {
      await raw.del(strays);
    }
  });

  test('an instance that persists is refused (spec 8.3)', async () => {
    await raw.configSet('appendonly', 'yes');
    try {
      await assert.rejects(connectRedis('state', config), { category: 'configuration', code: 'redis.persistence_enabled' });
    } finally {
      await raw.configSet('appendonly', 'no');
    }
  });
});
