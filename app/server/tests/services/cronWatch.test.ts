// Change triggers (spec 40.2): a Cron that watches an object set evaluates when a watched
// property's field changes, or an object enters or leaves, through the change streams that
// feed the state plane; changes coalesce over its window and the run evaluates current
// state. A stream gone stale is reported once as a gap, and current state is evaluated once
// when it resumes. A source with no change stream, or one that is not subscribable (it has not
// passed the change-stream class; decision 2026-11-15), is refused at creation, with a
// schedule offered. Deltas are published on bus-live as change-stream would.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../../src/config/index.config.ts';
import { sourceChange, type SourceChange } from '../../src/contracts/change-stream/delta.contract.ts';
import { saveObjectSet } from '../../src/contracts/ontology/objectSet.contract.ts';
import { createCron, getCron, listCronRuns } from '../../src/contracts/scheduler/cron.contract.ts';
import { connectLiveBus, liveSubjects, type LiveBus } from '../../src/infra/bus.infra.ts';
import { changeStatusKeys } from '../../src/infra/keyspaces.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';
import { clock, createFilesCell, invoiceType, until, type FilesCell } from './scheduler.helper.ts';
import { markSubscribable } from './subscribable.helper.ts';

let f: FilesCell;
let bus: LiveBus;
let state: RedisStore;
let setId = '';
let cronId = '';
const WINDOW = 60;

const cron = (id: string) => f.gateway.call(getCron, { params: { cronId: id } }, f.cell.as(f.member));
function publish(changed: Record<string, string>, operation: SourceChange['operation'] = 'update'): void {
  bus.publish(sourceChange, liveSubjects.change(f.cell.org, f.crm, 'invoices'), {
    organisationId: f.cell.org, connectionId: f.crm, manifestVersion: '1.0.0', object: 'invoices', entityRef: 'i1', operation, changed,
    observedAt: new Date().toISOString(), sourceAt: null, sourceSeq: null, ordering: 'observed_at', source: 'poll', markings: [],
  });
}

before(async () => {
  f = await createFilesCell({ watch: true });
  const set = await f.gateway.call(saveObjectSet, { body: {
    name: 'Invoices', definition: { kind: 'filter', base: { objectTypeId: invoiceType(f.manifest) }, predicate: { cel: 'true', properties: [] } },
  } }, f.keyed(f.member));
  setId = set.id;
  const config = loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'scheduler', SILO_CELL_ID: '00000000-0000-4000-8000-000000000001', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', PG_CONTROL_URL: f.cell.h.url('test_app'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`,
    REDIS_STATE_URL: `${LOCAL.redisUrl}/2`, NATS_LIVE_URL: LOCAL.natsUrl,
  });
  bus = await connectLiveBus(config.bus, 'test');
  state = await connectRedis('state', config.redis);
});

after(async () => {
  clock.offset = 0;
  await bus?.close();
  await state?.close();
  await f?.close();
});

describe('change triggers (spec 40.2)', () => {
  test('a watch is over an object set, its properties the set\'s type\'s', async () => {
    const base = { name: 'w', trigger: { watch: { properties: [f.prop('status')], windowSeconds: WINDOW } }, actions: [{ kind: 'notify' }] };
    await assert.rejects(f.gateway.call(createCron, { body: { ...base, subject: { savedViewId: uuidv7() } } as never }, f.keyed(f.member)),
      { code: 'scheduler.watch_needs_object_set' });
    await assert.rejects(f.gateway.call(createCron, { body: { ...base, subject: { objectSetId: setId }, trigger: { watch: { properties: [uuidv7()], windowSeconds: WINDOW } } } as never },
      f.keyed(f.member)), { code: 'scheduler.watch_property' });
  });

  test('a change condition needs a subscribable stream: until the class has passed, a schedule is offered', async () => {
    const body = { name: 'w', subject: { objectSetId: setId }, trigger: { watch: { properties: [f.prop('status')], windowSeconds: WINDOW } }, actions: [{ kind: 'notify' }] };
    await assert.rejects(f.gateway.call(createCron, { body } as never, f.keyed(f.member)), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, 'scheduler.not_subscribable');
      assert.match(error.message ?? '', /schedule/);
      return true;
    });
    await markSubscribable(f.cell, f.crm, ['invoices']);
  });

  test('a watched field\'s change makes it due a window later; an unwatched one does not; the run evaluates current state', async () => {
    const created = await f.gateway.call(createCron, { body: {
      name: 'Status changes', subject: { objectSetId: setId }, trigger: { watch: { properties: [f.prop('status')], windowSeconds: WINDOW } },
      condition: { kind: 'result', operator: 'returned_rows' }, actions: [{ kind: 'notify' }],
    } as never }, f.keyed(f.member));
    cronId = created.id;
    assert.equal(created.nextRunAt, null, 'due only when a change makes it so');
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      'select consumer_kind, source_kind, connection_id from connect.change_stream_subscriptions where cron_id = $1', [cronId]));
    assert.deepEqual(rows, [{ consumer_kind: 'cron', source_kind: 'poll', connection_id: f.crm }]);
    assert.ok(await f.watcher!.refresh() >= 1);
    await bus.flush();

    publish({ total: '99' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await cron(cronId)).nextRunAt, null, 'a change to a field nobody watches');
    const before = Date.now();
    publish({ status: 'paid' });
    publish({ status: 'open' });
    const due = await until('due', async () => (await cron(cronId)).nextRunAt ?? undefined);
    const at = Date.parse(due);
    assert.ok(at >= before + WINDOW * 1000 - 1_000 && at <= Date.now() + WINDOW * 1000 + 1_000, 'a window after the first change; the second coalesced');

    clock.offset = WINDOW * 1000 + 2_000;
    const runs = await until('the change run', async () => {
      const all = (await f.gateway.call(listCronRuns, { params: { cronId }, query: {} }, f.cell.as(f.member))).runs;
      return all.length > 0 && all[0]!.status !== 'running' ? all : undefined;
    });
    clock.offset = 0;
    assert.deepEqual([runs.length, runs[0]!.trigger, runs[0]!.conditionOutcome], [1, 'change', 'met']);
    assert.equal((await cron(cronId)).nextRunAt, null, 'ran once, and waits for the next change');
  });

  test('a stream gone stale is a gap told once; when it resumes, the Cron evaluates once', async () => {
    const key = changeStatusKeys.key(f.cell.org, { connectionId: f.crm });
    await state.putHash(changeStatusKeys, key, { status: 'stale', source: 'poll', since: new Date().toISOString() });
    await f.watcher!.refresh();
    await f.watcher!.refresh();
    const { rows } = await inTx(f.cell.app, { orgId: f.cell.org }, () => f.cell.app.query(
      `select count(*)::int as n from platform.outbox where payload->>'event' = 'automation_change_gap' and payload->'resource'->>'id' = $1`, [cronId]));
    assert.equal(rows[0].n, 1, 'told once');
    await state.putHash(changeStatusKeys, key, { status: 'live', source: 'poll', since: new Date().toISOString() });
    await f.watcher!.refresh();
    assert.ok((await cron(cronId)).nextRunAt !== null, 'current state evaluated once on resumption');
  });
});
