// The web client's API calls: same-origin requests to /api/v1 built from the gateway's own
// route table and typed by its route definitions; a state-changing call carries the CSRF
// header and a keyed one an idempotency key; a refusal comes back as the gateway stated it.
// Type checks (npm run typecheck) prove the routes' types reach the client: a wrong input
// fails to compile.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { ApiError, createApi, pathOf, queryOf, type Input, type Output } from '../src/api/client.api.ts';

const SERVER_DIR = path.resolve(import.meta.dirname, '../../server');

// Types: the sign-in route's input and output are the gateway's.
const signIn: Input<'signIn'> = { body: { organisationSlug: 'acme', email: 'ada@acme.example', password: 'secret' } };
// @ts-expect-error a sign-in names its organisation
const withoutOrganisation: Input<'signIn'> = { body: { email: 'ada@acme.example', password: 'secret' } };
type Session = Output<'signIn'>;
const mfa: Session['mfa'] = 'satisfied';
// @ts-expect-error a session's MFA state is one the gateway names
const unknownMfa: Session['mfa'] = 'maybe';
void [withoutOrganisation, mfa, unknownMfa];

interface Sent { url: string; init: RequestInit }

function fakeFetch(reply: { status: number; body?: unknown; headers?: Record<string, string> }) {
  const sent: Sent[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers ?? {} });
  };
  return { sent, fetcher };
}

test('a path takes its parameters encoded; a missing one is refused before anything is sent', () => {
  assert.equal(pathOf('/api/v1/workspace/views/:viewId/shares/:shareId/revoke', { viewId: 'a b', shareId: 'c/d' }),
    '/api/v1/workspace/views/a%20b/shares/c%2Fd/revoke');
  assert.throws(() => pathOf('/api/v1/workspace/views/:viewId', {}), /viewId/);
});

test('a query repeats an array\'s key and leaves out what is absent', () => {
  assert.equal(queryOf({ limit: 20, cursor: undefined, kinds: ['a', 'b'] }), '?limit=20&kinds=a&kinds=b');
  assert.equal(queryOf({}), '');
  assert.equal(queryOf(undefined), '');
});

test('a sign-in posts JSON to the gateway, same-origin, with the CSRF header the gateway asks for', async () => {
  const session = { sessionId: crypto.randomUUID(), mfa: 'satisfied' };
  const { sent, fetcher } = fakeFetch({ status: 201, body: session });
  const api = createApi(fetcher);
  assert.deepEqual(await api.call('signIn', signIn), session);
  const [request] = sent;
  assert.equal(request?.url, '/api/v1/sessions');
  assert.equal(request?.init.method, 'POST');
  assert.equal(request?.init.credentials, 'same-origin');
  const headers = request?.init.headers as Record<string, string>;
  assert.equal(headers['x-silo-csrf'], '1');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['idempotency-key'], undefined, 'a sign-in is not keyed');
  assert.deepEqual(JSON.parse(String(request?.init.body)), signIn.body);
});

test('a read sends no CSRF header and no body; a reply with no content is undefined', async () => {
  const { sent, fetcher } = fakeFetch({ status: 204 });
  const api = createApi(fetcher);
  assert.equal(await api.call('currentSession', {}), undefined);
  assert.equal(sent[0]?.init.method, 'GET');
  assert.equal((sent[0]?.init.headers as Record<string, string>)['x-silo-csrf'], undefined);
  assert.equal(sent[0]?.init.body, undefined);
});

test('a keyed call carries the key given, the same for each retry of one intent', async () => {
  const { sent, fetcher } = fakeFetch({ status: 201, body: {} });
  const api = createApi(fetcher);
  const key = crypto.randomUUID();
  await api.call('createConnector', { body: { slug: 'c-1', name: 'Orders', provider: 'Example', sourceRoute: 'visual' } }, { idempotencyKey: key });
  await api.call('createConnector', { body: { slug: 'c-1', name: 'Orders', provider: 'Example', sourceRoute: 'visual' } }, { idempotencyKey: key });
  assert.deepEqual(sent.map((s) => (s.init.headers as Record<string, string>)['idempotency-key']), [key, key]);
});

test('a refusal is the gateway\'s, with its category, code and the correlation id to quote', async () => {
  const { fetcher } = fakeFetch({
    status: 401, headers: { 'x-correlation-id': 'corr-1' },
    body: { error: { category: 'unauthenticated', code: 'auth.invalid_credentials', message: 'the email or password is wrong', retryable: false } },
  });
  const api = createApi(fetcher);
  await assert.rejects(api.call('signIn', signIn), (error: unknown) => error instanceof ApiError && error.status === 401
    && error.category === 'unauthenticated' && error.code === 'auth.invalid_credentials' && error.message === 'the email or password is wrong'
    && error.correlationId === 'corr-1');
  const broken = createApi(async () => new Response('<html>', { status: 502 }));
  await assert.rejects(broken.call('signIn', signIn), (error: unknown) => error instanceof ApiError && error.status === 502 && error.category === 'internal');
});

test('the route table is the gateway\'s current one', async () => {
  await promisify(execFile)('node', ['src/scripts/webRoutes.script.ts', '--check'], { cwd: SERVER_DIR });
});
