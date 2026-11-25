// The service shell end to end, without TLS (tests/infra/mtls.test.ts covers TLS): a
// process hosting test endpoints, called through the service client. Contracts are
// validated on both sides, listed callers and request context are enforced, keyed
// operations replay, failures arrive as the AppError raised, and shutdown drains.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { defineContract } from '../../src/contracts/endpoint.contract.ts';
import { route } from '../../src/infra/http.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { defineService } from '../../src/infra/service.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { refuse } from '../../src/utils/errors.util.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';
import { sleep } from '../../src/utils/time.util.ts';
import { LOCAL } from './services.helper.ts';

const note = z.object({ id: z.uuid(), text: z.string().min(1) });
const noteBody = z.object({ text: z.string().min(1).max(200) });

const createNote = defineContract({
  service: 'workspace', name: 'createNote', method: 'POST', path: '/v1/notes', callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed', body: noteBody, response: note, status: 201, maxBodyBytes: 4096,
});
const readNote = defineContract({
  service: 'workspace', name: 'readNote', method: 'GET', path: '/v1/notes/:noteId', callers: ['gateway', 'ask'],
  context: 'organisation', idempotency: 'none', params: z.object({ noteId: z.uuid() }),
  query: z.object({ fields: z.enum(['all', 'text']).default('all') }), response: note,
});
const whoAmI = defineContract({
  service: 'workspace', name: 'whoAmI', method: 'GET', path: '/v1/me', callers: ['gateway'], context: 'user',
  idempotency: 'none', response: z.object({ userId: z.uuid() }),
});
const slow = defineContract({
  service: 'workspace', name: 'slow', method: 'GET', path: '/v1/slow', callers: ['gateway'], context: 'none',
  idempotency: 'none', query: z.object({ ms: z.coerce.number().int().min(0).max(5000) }), response: z.object({ ok: z.boolean() }),
});
/** An operation bounded by more than the listener's timeout declares it: its callers and its deadline wait that long. */
const patient = defineContract({
  service: 'workspace', name: 'patient', method: 'GET', path: '/v1/patient', callers: ['gateway'], context: 'none',
  idempotency: 'none', query: z.object({ ms: z.coerce.number().int().min(0).max(5000) }), response: z.object({ ok: z.boolean() }),
  timeoutMs: 3_000,
});
const broken = defineContract({
  service: 'workspace', name: 'broken', method: 'GET', path: '/v1/broken', callers: ['gateway'], context: 'none',
  idempotency: 'none', response: note,
});
const shed = defineContract({
  service: 'workspace', name: 'shed', method: 'POST', path: '/v1/shed', callers: ['gateway'], context: 'none',
  idempotency: 'none', response: z.undefined(),
});
const shedRead = defineContract({
  service: 'workspace', name: 'shedRead', method: 'GET', path: '/v1/shed', callers: ['gateway'], context: 'none',
  idempotency: 'none', response: z.object({ ok: z.boolean() }),
});

const notes = new Map<string, string>();
const calls = { create: 0, shed: 0, shedRead: 0 };
let failNextCreate = false;
let workerRuns = 0;

const workspace = defineService({
  name: 'workspace',
  needs: { redis: ['data'] },
  create: () => ({
    routes: [
      route(createNote, {
        async handle(input) {
          calls.create += 1;
          if (failNextCreate) {
            failNextCreate = false;
            throw new Error('a driver error with a value in it: alice@example.com');
          }
          const id = uuidv7();
          notes.set(id, input.body.text);
          return { id, text: input.body.text };
        },
        resultRef: (output) => output.id,
        replay: async (ref) => ({ id: ref!, text: notes.get(ref!)! }),
      }),
      route(readNote, {
        async handle(input) {
          const text = notes.get(input.params.noteId);
          if (text === undefined) throw refuse.bound('test', 1);
          return { id: input.params.noteId, text };
        },
      }),
      route(whoAmI, { handle: async (_input, ctx) => ({ userId: ctx.request.userId! }) }),
      route(slow, {
        async handle(input, ctx) {
          await sleep(input.query.ms, ctx.signal);
          return { ok: true };
        },
      }),
      route(patient, {
        async handle(input, ctx) {
          await sleep(input.query.ms, ctx.signal);
          return { ok: true };
        },
      }),
      route(broken, { handle: async () => ({ id: 'not-a-uuid', text: '' }) as never }),
      route(shed, {
        async handle() {
          calls.shed += 1;
          throw refuse.capacity(2);
        },
      }),
      route(shedRead, {
        async handle() {
          calls.shedRead += 1;
          throw refuse.capacity(0);
        },
      }),
    ],
    workers: [{
      name: 'ticker',
      async run(signal) {
        while (!signal.aborted) {
          workerRuns += 1;
          await sleep(20, signal).catch(() => undefined);
        }
      },
    }],
  }),
});

const lines: string[] = [];
const logger = createLogger({ service: 'workspace', cell: 'uk-lon-1', release: 'test', level: 'debug', write: (l) => lines.push(l) });

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    SILO_ENV: 'test', SILO_SERVICE: 'workspace', SILO_CELL_ID: 'uk-lon-1', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
    SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0',
    // The real workspace service's needs; the fake one here opens no database.
    PG_CONTROL_URL: 'postgres://unused@127.0.0.1:1/unused',
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, HTTP_DRAIN_SECONDS: '0', HTTP_REQUEST_TIMEOUT_MS: '400', ...overrides,
  });
}

let processRun: RunningProcess;
let config: Config;
let gateway: ServiceClient;
let base: string;
const org = uuidv7();
const member = uuidv7();
const asMember = { request: { organisationId: org, membershipId: member } };

before(async () => {
  config = testConfig();
  processRun = await runProcess([workspace], config, { logger });
  base = `http://127.0.0.1:${processRun.port}`;
  gateway = createServiceClient({ caller: 'gateway', http: { ...config.http, serviceUrls: { workspace: base } } });
});

after(async () => {
  gateway?.close();
  await processRun?.stop('test');
});

const raw = (path: string, init: RequestInit & { caller?: string } = {}): Promise<Response> => fetch(`${base}${path}`, {
  ...init, headers: { ...(init.caller ? { 'x-silo-caller': init.caller } : {}), ...(init.headers as Record<string, string> ?? {}) },
});

describe('contracts on both sides', () => {
  test('a listed caller creates and reads, with the response validated', async () => {
    const created = await gateway.call(createNote, { body: { text: 'hello' } }, { ...asMember, idempotencyKey: uuidv7() });
    assert.equal(created.text, 'hello');
    const read = await gateway.call(readNote, { params: { noteId: created.id }, query: { fields: 'text' } }, asMember);
    assert.deepEqual(read, created);
  });

  test('the server refuses a request that does not match, naming the paths', async () => {
    const res = await raw(`/v1/notes/not-a-uuid?fields=everything`, {
      caller: 'gateway', headers: { 'x-silo-organisation-id': org },
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: string; issues: { path: string }[] } };
    assert.equal(body.error.code, 'contract.request_invalid');
    assert.deepEqual(body.error.issues.map((i) => i.path).sort(), ['params.noteId', 'query.fields']);
  });

  test('the client refuses to send a request that does not match', async () => {
    await assert.rejects(gateway.call(createNote, { body: { text: '' } }, { ...asMember, idempotencyKey: uuidv7() }),
      { category: 'validation', code: 'contract.request_invalid' });
  });

  test('a response that does not match its contract is never sent', async () => {
    await assert.rejects(gateway.call(broken, {}), { category: 'internal', code: 'contract.response_invalid' });
    assert.ok(lines.some((l) => l.includes('"event":"contract.response_invalid"')));
  });

  test('the correlation id travels and comes back', async () => {
    const correlationId = uuidv7();
    const res = await raw('/v1/slow?ms=0', { caller: 'gateway', headers: { 'x-correlation-id': correlationId } });
    assert.equal(res.headers.get('x-correlation-id'), correlationId);
    // The request line is written when the response finishes, which may be after the client has read it.
    const logged = () => lines.some((l) => l.includes(correlationId) && l.includes('"event":"http.request"'));
    for (let i = 0; i < 50 && !logged(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(logged());
  });
});

describe('callers and context (spec 7.1, 64.3)', () => {
  test('an unlisted caller is refused by the server, and by its own client', async () => {
    const res = await raw('/v1/notes', { method: 'POST', caller: 'ask', headers: { 'x-silo-organisation-id': org } });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'caller.not_listed');
    const ask = createServiceClient({ caller: 'ask', http: { ...config.http, serviceUrls: { workspace: base } } });
    await assert.rejects(ask.call(createNote, { body: { text: 'x' } }, { ...asMember, idempotencyKey: uuidv7() }), { code: 'caller.not_listed' });
    ask.close();
  });

  test('a caller that names no service is unauthenticated', async () => {
    const res = await raw('/v1/slow?ms=0');
    assert.equal(res.status, 401);
  });

  test('the context the contract requires must arrive, as lowercase UUIDs', async () => {
    const missing = await raw(`/v1/notes/${uuidv7()}`, { caller: 'gateway' });
    assert.equal((await missing.json() as { error: { code: string } }).error.code, 'context.organisation_missing');
    const bad = await raw(`/v1/notes/${uuidv7()}`, { caller: 'gateway', headers: { 'x-silo-organisation-id': 'ACME' } });
    assert.equal((await bad.json() as { error: { code: string } }).error.code, 'context.invalid');
    const user = uuidv7();
    assert.deepEqual(await gateway.call(whoAmI, {}, { request: { userId: user } }), { userId: user });
    await assert.rejects(gateway.call(whoAmI, {}, {}), { code: 'context.user_missing' });
  });
});

describe('keyed operations (spec 7.1: callers retry under idempotency keys)', () => {
  test('a retried request runs once and returns the first result', async () => {
    const key = uuidv7();
    const before = calls.create;
    const first = await gateway.call(createNote, { body: { text: 'once' } }, { ...asMember, idempotencyKey: key });
    const second = await gateway.call(createNote, { body: { text: 'once' } }, { ...asMember, idempotencyKey: key });
    assert.deepEqual(second, first);
    assert.equal(calls.create - before, 1);
  });

  test('a key reused for a different request is refused', async () => {
    const key = uuidv7();
    await gateway.call(createNote, { body: { text: 'first' } }, { ...asMember, idempotencyKey: key });
    await assert.rejects(gateway.call(createNote, { body: { text: 'second' } }, { ...asMember, idempotencyKey: key }),
      { category: 'validation', code: 'idempotency.key_reused' });
  });

  test('a keyed request without a key is refused, and a failed attempt frees the key', async () => {
    const res = await raw('/v1/notes', {
      method: 'POST', caller: 'gateway', headers: { 'x-silo-organisation-id': org, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'idempotency.key_missing');
    const key = uuidv7();
    failNextCreate = true;
    await assert.rejects(gateway.call(createNote, { body: { text: 'retry me' } }, { ...asMember, idempotencyKey: key }),
      { category: 'internal' });
    const retried = await gateway.call(createNote, { body: { text: 'retry me' } }, { ...asMember, idempotencyKey: key });
    assert.equal(retried.text, 'retry me');
    // The driver's message, and the value in it, never left the process or reached a log.
    assert.ok(!lines.some((l) => l.includes('alice@example.com')));
  });
});

describe('failures and bounds', () => {
  test('a capacity refusal names its wait; a write is sent once, a read is retried', async () => {
    const res = await raw('/v1/shed', { method: 'POST', caller: 'gateway' });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '2');
    const before = calls.shed;
    await assert.rejects(gateway.call(shed, {}), { category: 'capacity', retryAfterSeconds: 2 });
    assert.equal(calls.shed - before, 1, 'not known to be safe to repeat');
    const reads = calls.shedRead;
    await assert.rejects(gateway.call(shedRead, {}), { category: 'capacity' });
    assert.equal(calls.shedRead - reads, 3, 'a GET is retried');
  });

  test('a request over the timeout answers 504; one within it completes', async () => {
    await assert.rejects(gateway.call(slow, { query: { ms: 2000 } }), { category: 'timeout', code: 'request.timeout' });
    assert.deepEqual(await gateway.call(slow, { query: { ms: 10 } }), { ok: true });
  });

  test('an operation declaring a longer bound is waited for, by its deadline and by its callers; a call may still ask for less', async () => {
    assert.deepEqual(await gateway.call(patient, { query: { ms: 1000 } }), { ok: true }, 'past the listener\'s 400 ms, within the declared 3 s');
    const hasty = createServiceClient({ caller: 'gateway', timeoutMs: 200, http: { ...config.http, serviceUrls: { workspace: base } } });
    try {
      assert.deepEqual(await hasty.call(patient, { query: { ms: 600 } }), { ok: true }, 'the operation\'s bound over the client\'s default');
      await assert.rejects(hasty.call(slow, { query: { ms: 600 } }), { code: 'service.timeout' }, 'the client\'s default elsewhere');
    } finally {
      hasty.close();
    }
    await assert.rejects(gateway.call(patient, { query: { ms: 1000 } }, { timeoutMs: 300 }), { code: 'service.timeout' }, 'a call\'s own wait first');
    assert.throws(() => defineContract({
      service: 'workspace', name: 'tooPatient', method: 'GET', path: '/v1/too-patient', callers: ['gateway'], context: 'none',
      idempotency: 'none', response: z.object({ ok: z.boolean() }), timeoutMs: 600_000,
    }), /timeout/);
  });

  test('a body over its bound is refused, never truncated; bad JSON is refused', async () => {
    const big = await raw('/v1/notes', {
      method: 'POST', caller: 'gateway', headers: { 'x-silo-organisation-id': org, 'content-type': 'application/json', 'idempotency-key': uuidv7() },
      body: JSON.stringify({ text: 'x'.repeat(8000) }),
    });
    assert.equal(big.status, 422);
    assert.equal((await big.json() as { error: { code: string } }).error.code, 'bound.request_body_bytes');
    const bad = await raw('/v1/notes', {
      method: 'POST', caller: 'gateway', headers: { 'x-silo-organisation-id': org, 'content-type': 'application/json', 'idempotency-key': uuidv7() },
      body: '{"text":',
    });
    assert.equal((await bad.json() as { error: { code: string } }).error.code, 'request.json_invalid');
  });

  test('an unknown endpoint is not found', async () => {
    const res = await raw('/v1/nothing', { caller: 'gateway' });
    assert.equal(res.status, 404);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'route.not_found');
  });
});

describe('health and lifecycle', () => {
  test('liveness and readiness, with each dependency checked', async () => {
    assert.deepEqual(await (await raw('/healthz')).json(), { ok: true });
    const ready = await (await raw('/readyz')).json() as { ok: boolean; checks: { name: string; ok: boolean }[] };
    assert.equal(ready.ok, true);
    assert.deepEqual(ready.checks.map((c) => c.name), ['redis.data']);
    assert.ok(workerRuns > 0, 'the worker runs');
  });

  test('shutdown drains: readiness fails, a request in flight finishes, workers stop', async () => {
    const other = await runProcess([workspace], testConfig({ HTTP_DRAIN_SECONDS: '1' }), { logger });
    const url = `http://127.0.0.1:${other.port}`;
    const client = createServiceClient({ caller: 'gateway', http: { ...config.http, serviceUrls: { workspace: url } } });
    const inFlight = client.call(slow, { query: { ms: 200 } });
    await sleep(50);
    const stopping = other.stop('test');
    const ready = await fetch(`${url}/readyz`);
    assert.equal(ready.status, 503, 'readiness fails while draining');
    assert.deepEqual(await ready.json(), { ok: false, draining: true });
    assert.deepEqual(await inFlight, { ok: true });
    assert.equal(await stopping, true);
    assert.equal(await other.stopped, true);
    client.close();
    await assert.rejects(fetch(`${url}/healthz`));
  });

  test('a failing worker stops the process', async () => {
    const failing = defineService({
      name: 'workspace',
      needs: {},
      create: () => ({ routes: [], workers: [{ name: 'boom', run: async () => { throw new Error('boom'); } }] }),
    });
    const run = await runProcess([failing], testConfig(), { logger });
    assert.equal(await run.stopped, false);
    assert.ok(lines.some((l) => l.includes('"event":"worker.failed"')));
  });

  test('a process runs exactly the services it hosts', async () => {
    await assert.rejects(runProcess([], testConfig(), { logger }), { code: 'config.process.services' });
    await assert.rejects(runProcess([workspace], testConfig({ SILO_SERVICES: 'workspace,ask' }), { logger }),
      { code: 'config.process.services' });
  });
});
