// The client's data foundations (U1): the API client's retries, time limits and signals; the
// read cache's sharing, freshness, invalidation and clearing; the client status store. Pure: a
// fake fetch and a fake clock, no browser and no cell.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError, createApi, permissionOf, routeInfo, waitBefore, type ApiSignal } from '../src/api/client.api.ts';
import { QueryCache, resourceOf, stableKey } from '../src/data/cache.data.ts';
import { createStatusStore } from '../src/data/status.data.ts';
import { ROUTES } from '../src/api/routes.generated.ts';

interface Sent { url: string; init: RequestInit }
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'network';

/** Replies in order; the last repeats. */
function fakeFetch(...replies: Reply[]) {
  const sent: Sent[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    if (reply === 'network') throw new TypeError('Failed to fetch');
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers ?? {} });
  };
  return { sent, fetcher };
}

const noWait = async () => undefined;
const shed = { status: 503, body: { error: { category: 'capacity', code: 'load.shed', message: 'busy', retryable: true, retryAfterSeconds: 2 } } };
const ok = (body: unknown) => ({ status: 200, body });

describe('the route table carries what the client needs before it calls', () => {
  test('every route has its session, access and whether it writes', () => {
    for (const [name, route] of Object.entries(ROUTES)) {
      assert.ok(['none', 'mfa_pending', 'complete'].includes(route.session), `${name} session`);
      assert.equal(typeof route.writes, 'boolean', `${name} writes`);
      assert.ok(typeof route.access === 'object' || ['own', 'service', 'open'].includes(route.access), `${name} access`);
      if (route.method === 'GET') assert.equal(route.writes, false, `${name}: a GET never writes`);
    }
    assert.equal(permissionOf('createConnection'), 'connection.create');
    assert.equal(permissionOf('readMyPermissions'), undefined, 'the person\'s own records name no permission');
    assert.equal(routeInfo('signIn').session, 'none');
  });
});

describe('the API client', () => {
  test('a read the cell sheds is tried again after the time it gives, and succeeds', async () => {
    const waits: number[] = [];
    const { sent, fetcher } = fakeFetch(shed, ok({ items: [] }));
    const api = createApi(fetcher, async (ms) => {
      waits.push(ms);
    });
    const signals: ApiSignal[] = [];
    api.signals.subscribe((s) => signals.push(s));
    assert.deepEqual(await api.call('readRail', {}), { items: [] });
    assert.equal(sent.length, 2);
    assert.deepEqual(waits, [2000], 'the cell\'s retry time');
    assert.deepEqual(signals.filter((x) => x.type !== 'authenticated'), [{ type: 'overloaded', retryAfterSeconds: 2 }]);
  });

  test('a read gives up after three attempts and says why', async () => {
    const { sent, fetcher } = fakeFetch(shed);
    const api = createApi(fetcher, noWait);
    await assert.rejects(api.call('readRail', {}), (error: unknown) => error instanceof ApiError && error.kind === 'overloaded');
    assert.equal(sent.length, 3);
  });

  test('an unkeyed write is never tried twice: a retry could apply it twice', async () => {
    const { sent, fetcher } = fakeFetch('network');
    const api = createApi(fetcher, noWait);
    assert.equal(routeInfo('renameAskThread').keyed, false);
    assert.equal(routeInfo('renameAskThread').writes, true);
    await assert.rejects(api.call('renameAskThread', { params: { threadId: 't' }, body: { title: 'x' } } as never), (e: unknown) => e instanceof ApiError && e.kind === 'offline');
    assert.equal(sent.length, 1);
  });

  test('a keyed write is tried again with the same key, so the cell applies it once', async () => {
    const keyed = (Object.entries(ROUTES).find(([, r]) => r.keyed && r.writes) ?? [])[0] as keyof typeof ROUTES;
    assert.ok(keyed, 'some write is keyed');
    const { sent, fetcher } = fakeFetch('network', { status: 204 });
    const api = createApi(fetcher, noWait);
    const params = Object.fromEntries([...routeInfo(keyed).path.matchAll(/:([a-zA-Z]+)/g)].map((m) => [m[1], 'x']));
    await api.call(keyed, { params, body: {} } as never);
    assert.equal(sent.length, 2);
    const keys = sent.map((s) => (s.init.headers as Record<string, string>)['idempotency-key']);
    assert.ok(keys[0] !== undefined && keys[0] === keys[1], 'one key for the intent');
  });

  test('a refusal is not retried, and its fields and correlation id survive', async () => {
    const { sent, fetcher } = fakeFetch({
      status: 400, headers: { 'x-correlation-id': 'corr-1' },
      body: { error: { category: 'validation', code: 'contract.request_invalid', message: 'the request does not match its contract', retryable: false,
        issues: [{ path: 'body.name', code: 'too_small', message: 'Too small' }] } },
    });
    const api = createApi(fetcher, noWait);
    const error = await api.call('readRail', {}).catch((e: unknown) => e) as ApiError;
    assert.equal(sent.length, 1);
    assert.equal(error.kind, 'validation');
    assert.equal(error.correlationId, 'corr-1');
    assert.equal(error.issueFor('name')?.message, 'Too small');
    assert.equal(error.sentence, 'The request does not match its contract.');
  });

  test('the session ending, writes pausing, and the network going and returning are each announced', async () => {
    const signals: ApiSignal[] = [];
    const ended = createApi(fakeFetch({ status: 401, body: { error: { category: 'unauthenticated', code: 'gateway.session_required', message: 'sign in' } } }).fetcher, noWait);
    ended.signals.subscribe((s) => signals.push(s));
    await assert.rejects(ended.call('readRail', {}));
    const paused = createApi(fakeFetch({ status: 409, body: { error: { category: 'conflict', code: 'tenant_migrations.writes_paused', message: 'moving', retryable: true } } }).fetcher, noWait);
    paused.signals.subscribe((s) => signals.push(s));
    await assert.rejects(paused.call('renameAskThread', { params: { threadId: 't' }, body: { title: 'x' } } as never), (e: unknown) => e instanceof ApiError && e.kind === 'paused');
    const flaky = createApi(fakeFetch('network', ok({ items: [] })).fetcher, noWait);
    flaky.signals.subscribe((s) => signals.push(s));
    await flaky.call('readRail', {});
    assert.deepEqual(signals.map((s) => s.type).filter((t) => t !== 'authenticated'), ['unauthenticated', 'paused', 'offline', 'reachable']);
    assert.ok(signals.some((s) => s.type === 'authenticated'), 'a session answering says so');
  });

  test('a call over its time limit is abandoned as a timeout; a caller\'s abort is the caller\'s', async () => {
    const hang = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const api = createApi(hang, noWait);
    await assert.rejects(api.call('readRail', {}, { timeoutMs: 5, attempts: 1 }), (e: unknown) => e instanceof ApiError && e.kind === 'timeout');
    const controller = new AbortController();
    const call = api.call('readRail', {}, { signal: controller.signal });
    controller.abort(new DOMException('left the page', 'AbortError'));
    await assert.rejects(call, (e: unknown) => !(e instanceof ApiError));
  });

  test('backoff without a figure from the cell grows and stays bounded', () => {
    const error = new ApiError(0, undefined, undefined, undefined, { category: 'unavailable', code: 'client.offline', message: 'x', retryable: true });
    assert.equal(waitBefore(1, error, () => 1), 500);
    assert.equal(waitBefore(3, error, () => 1), 2000);
    assert.ok(waitBefore(20, error, () => 1) <= 15_000);
  });
});

describe('the read cache', () => {
  const listing = (n: number) => ({ items: [{ item: 'home', available: true, needs: null, n }] });

  test('one key, one request: concurrent reads share it', async () => {
    const { sent, fetcher } = fakeFetch(ok(listing(1)));
    const cache = new QueryCache(createApi(fetcher, noWait));
    const [a, b] = await Promise.all([cache.fetch('readRail', {}), cache.fetch('readRail', {})]);
    assert.equal(sent.length, 1);
    assert.equal(a, b);
  });

  test('keys ignore the order inputs were written in, and absent values', () => {
    assert.equal(stableKey({ b: 1, a: { d: 2, c: 3 } }), stableKey({ a: { c: 3, d: 2 }, b: 1, e: undefined }));
    assert.notEqual(stableKey({ a: [1, 2] }), stableKey({ a: [2, 1] }));
  });

  test('a fresh answer is reused; a stale one is read again', async () => {
    let now = 0;
    const { sent, fetcher } = fakeFetch(ok(listing(1)), ok(listing(2)));
    const cache = new QueryCache(createApi(fetcher, noWait), { staleMs: 1000, now: () => now });
    await cache.get('readRail', {});
    now = 500;
    assert.deepEqual(await cache.get('readRail', {}), listing(1));
    now = 1500;
    assert.deepEqual(await cache.get('readRail', {}), listing(2));
    assert.equal(sent.length, 2);
  });

  test('a write makes its resource\'s watched reads stale, and they are read again at once', async () => {
    const { sent, fetcher } = fakeFetch(ok({ connections: [] }), ok({ connections: [{ id: 'c' }] }));
    const cache = new QueryCache(createApi(fetcher, noWait));
    const seen: unknown[] = [];
    const input = { query: {} };
    const stop = cache.subscribe('listConnections', input, () => seen.push(cache.snapshot('listConnections', input as never).data));
    await cache.fetch('listConnections', input as never);
    assert.equal(resourceOf(routeInfo('renameConnection').path), '/api/v1/connect/connections');
    cache.invalidateAfter('renameConnection');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(sent.length, 2, 'read again');
    assert.deepEqual(cache.snapshot('listConnections', input as never).data, { connections: [{ id: 'c' }] });
    stop();
  });

  test('a write during a read asks again after it: the first answer may predate the write', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) await gate;
      return new Response(JSON.stringify({ n: calls }), { status: 200 });
    };
    const cache = new QueryCache(createApi(fetcher, noWait));
    const stop = cache.subscribe('readRail', {}, () => undefined);
    const first = cache.fetch('readRail', {});
    cache.invalidate(() => true);
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls, 2);
    assert.deepEqual(cache.snapshot('readRail', {}).data, { n: 2 });
    stop();
  });

  test('a failed refresh keeps the answer shown, with the failure beside it', async () => {
    const { fetcher } = fakeFetch(ok(listing(1)), { status: 500, body: { error: { category: 'internal', code: 'x', message: 'broke' } } });
    const cache = new QueryCache(createApi(fetcher, noWait));
    const stop = cache.subscribe('readRail', {}, () => undefined);
    await cache.fetch('readRail', {});
    await cache.fetch('readRail', {}).catch(() => undefined);
    const snap = cache.snapshot('readRail', {});
    assert.equal(snap.status, 'success');
    assert.deepEqual(snap.data, listing(1));
    assert.ok(snap.error instanceof ApiError);
    stop();
  });

  test('clearing forgets every answer, and a read from before is never shown after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetcher = async () => {
      await gate;
      return new Response(JSON.stringify(listing(1)), { status: 200 });
    };
    const cache = new QueryCache(createApi(fetcher, noWait));
    const stop = cache.subscribe('readRail', {}, () => undefined);
    const before = cache.fetch('readRail', {}).catch(() => undefined);
    cache.clear();
    release();
    await before;
    assert.equal(cache.snapshot('readRail', {}).status, 'loading', 'the old session\'s answer is not shown');
    stop();
  });

  test('a read nobody watches any more is abandoned', async () => {
    let aborted = false;
    const fetcher = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
    const cache = new QueryCache(createApi(fetcher, noWait), { keepMs: 1 });
    const stop = cache.subscribe('readRail', {}, () => undefined);
    cache.ensure('readRail', {});
    stop();
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(aborted);
    assert.equal(cache.size, 0, 'dropped after its keep time');
  });
});

describe('the client status', () => {
  test('signals set it; a pause ends when resumed; shedding ends on its own', async () => {
    const api = createApi(fakeFetch(ok({})).fetcher, noWait);
    let now = 0;
    const store = createStatusStore(api.signals, () => now);
    let changes = 0;
    store.subscribe(() => {
      changes += 1;
    });
    api.signals.emit({ type: 'paused' });
    api.signals.emit({ type: 'paused' });
    assert.equal(store.get().paused, true);
    assert.equal(changes, 1, 'the same state twice is one change');
    store.resume();
    assert.equal(store.get().paused, false);
    api.signals.emit({ type: 'overloaded', retryAfterSeconds: 0 });
    assert.equal(store.get().overloadedUntil, 0);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.get().overloadedUntil, undefined);
    api.signals.emit({ type: 'unauthenticated', route: 'readRail' });
    assert.equal(store.get().session, 'ended');
    api.signals.emit({ type: 'authenticated' });
    assert.equal(store.get().session, 'live', 'signed in again since');
  });
});
