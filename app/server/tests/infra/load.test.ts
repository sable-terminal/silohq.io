// Load shedding and quotas (spec 12.4; D250): the shedding order exactly as the spec gives it;
// the level a delay sheds to; a request refused at the door with a retry time when its class is
// shed, and never when it names none (approvals, revert and audit name none); the change-event
// windows per organisation and per connection, against redis-data.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { definedContracts, SHED_ORDER, type AnyContract } from '../../src/contracts/endpoint.contract.ts';
import { createLoadGauge, holdShedLevel, processLoad, shedLevel, sustainedLevel } from '../../src/infra/load.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { createEdgeLimiter } from '../../src/middleware/rateLimit.middleware.ts';
import { shedUnderLoad } from '../../src/middleware/shed.middleware.ts';
import { chargeChangeRate } from '../../src/services/change-stream/publish.service.ts';
import { isAppError } from '../../src/utils/errors.util.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';
import { LOCAL } from './services.helper.ts';

let data: RedisStore;

before(async () => {
  data = await connectRedis('data', {
    session: LOCAL.redisUrl, data: LOCAL.redisUrl, state: LOCAL.redisUrl, persistenceCheck: 'config', commandTimeoutMs: 2_000,
  }, { logger: createLogger({ service: 'test', cell: 'test', release: 'test', level: 'error', write: () => undefined }) });
});

after(async () => {
  holdShedLevel(undefined);
  await data?.close();
});

/** Runs a middleware once: what it threw, or whether it passed the request on. */
function through(contract: Partial<AnyContract>): { passed: boolean; error?: unknown } {
  let passed = false;
  try {
    shedUnderLoad(contract as AnyContract, processLoad())({} as never, {} as never, () => { passed = true; });
    return { passed };
  } catch (error) {
    return { passed, error };
  }
}

describe('load shedding (spec 12.4)', () => {
  test('the order is the spec\'s, first shed to last', () => {
    assert.deepEqual([...SHED_ORDER], [
      'recognition_run', 'index_rebuild', 'simulation', 'export_render', 'subscription', 'compile', 'view_run', 'cron', 'action_execution', 'session_auth',
    ]);
  });

  test('below the start nothing is shed; each step past it sheds one more class, never more than there are', () => {
    const settings = { startMs: 200, stepMs: 50 };
    assert.deepEqual([0, 199, 200, 249, 250, 449, 650, 10_000].map((d) => shedLevel(d, settings)), [0, 0, 1, 1, 2, 5, 10, 10]);
    // Only sustained load sheds: one bad second among good ones sheds nothing.
    assert.deepEqual([[], [9], [9, 9], [0, 9, 9], [9, 9, 9], [4, 9, 6], [9, 9, 9, 0]].map((r) => sustainedLevel(r)), [0, 0, 0, 0, 9, 4, 0]);
    const gauge = createLoadGauge(() => ({ ...settings, sampleMs: 20 }));
    assert.equal(gauge.level(), 0, 'a process that keeps up sheds nothing');
    gauge.stop();
  });

  test('a shed class is refused at the door with a retry time; a later class and one that names none go on', () => {
    holdShedLevel(3);
    const refused = through({ shed: 'simulation' });
    assert.ok(isAppError(refused.error) && refused.error.code === 'capacity.shed' && refused.error.retryAfterSeconds === 6, String(refused.error));
    assert.equal(refused.passed, false);
    assert.equal(through({ shed: 'export_render' }).passed, true, 'the fourth class is not shed at level 3');
    assert.equal(through({}).passed, true, 'a contract naming no class is never shed');
    holdShedLevel(SHED_ORDER.length);
    assert.equal(through({ shed: 'session_auth' }).passed, false, 'at the top, even session authentication');
    assert.equal(through({}).passed, true, 'and still never one that names none');
    holdShedLevel(undefined);
  });

  test('approvals, revert and audit are never shed; every class is someone\'s', async () => {
    const root = new URL('../../src/contracts/', import.meta.url);
    for (const dir of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const file of readdirSync(new URL(`${dir.name}/`, root)).filter((f) => f.endsWith('.contract.ts'))) {
        await import(new URL(`${dir.name}/${file}`, root).href);
      }
    }
    const contracts = definedContracts();
    const neverShed = contracts.filter((c) => ['approvals', 'revert', 'audit'].includes(c.service));
    assert.ok(neverShed.length > 10);
    assert.deepEqual(neverShed.filter((c) => c.shed !== undefined).map((c) => c.id), []);
    const used = new Set(contracts.map((c) => c.shed).filter((s) => s !== undefined));
    assert.deepEqual(SHED_ORDER.filter((s) => s !== 'cron' && !used.has(s)), [], 'each class names the work it sheds');
  });
});

describe('request quotas (spec 12.4: one tenant cannot consume a cell)', () => {
  test('every session of an organisation counts towards its window at the edge; over it, rate limited', async () => {
    const limiter = createEdgeLimiter(data, Buffer.alloc(32, 7), { windowSeconds: 60, perAddress: 1_000, perSession: 1_000, perOrganisation: 3 });
    const organisation = uuidv7();
    for (const session of [uuidv7(), uuidv7(), uuidv7()]) {
      await limiter.perSession(session);
      await limiter.perOrganisation(organisation);
    }
    await assert.rejects(limiter.perOrganisation(organisation), (e: unknown) => isAppError(e) && e.category === 'rate_limited' && e.retryAfterSeconds === 60);
    await limiter.perOrganisation(uuidv7());
  });
});

describe('change-event quotas (spec 9.5, 12.4)', () => {
  test('a delivery over the organisation\'s or the connection\'s second is refused whole, rate limited, with a retry time', async () => {
    const [organisation, connection, other] = [uuidv7(), uuidv7(), uuidv7()];
    const limits = { perOrganisation: 10, perConnection: 6 };
    await chargeChangeRate(data, organisation, connection, 5, limits);
    await assert.rejects(chargeChangeRate(data, organisation, connection, 2, limits),
      (e: unknown) => isAppError(e) && e.code === 'stream.rate_limited' && e.category === 'rate_limited' && e.details['quota'] === 'change_events_connection');
    // Another connection of the same organisation still counts towards the organisation's second.
    await assert.rejects(chargeChangeRate(data, organisation, other, 4, limits),
      (e: unknown) => isAppError(e) && e.details['quota'] === 'change_events_organisation');
    await chargeChangeRate(data, uuidv7(), uuidv7(), 0, limits);
  });
});

describe('the paging signals (spec 13.2; D252)', () => {
  test('unwraps in the last five minutes; keys without a TTL, audited at most every ten minutes', async () => {
    const { noteUnwrap, unwrapsLastFiveMinutes } = await import('../../src/services/credential/unwrapRate.service.ts');
    const { keysWithoutTtlGauge } = await import('../../src/infra/signals.infra.ts');
    const start = Date.now() + 3_600_000;
    for (let i = 0; i < 3; i++) noteUnwrap(start + i * 60_000);
    assert.equal(unwrapsLastFiveMinutes(start + 3 * 60_000), 3);
    assert.equal(unwrapsLastFiveMinutes(start + 5 * 60_000 + 30_000), 2, 'the first has left the window');
    let audits = 0;
    const gauge = keysWithoutTtlGauge(async () => { audits += 1; return { withoutTtl: 4 }; });
    assert.equal(await gauge(), 4);
    assert.equal(await gauge(), 4);
    assert.equal(audits, 1, 'the audit runs at most every ten minutes');
  });
});
