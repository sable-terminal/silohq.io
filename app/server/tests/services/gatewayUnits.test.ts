// The gateway's pure parts: client addresses behind proxies, the session cookie, the
// cross-site rules, public errors, the route table's guardrails, and the live pipeline
// (projection, coalescing, back-pressure) on a manual clock.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { createInvitation as internalInvite } from '../../src/contracts/auth/invitation.contract.ts';
import { resolveSession } from '../../src/contracts/auth/session.contract.ts';
import { enrolTotp } from '../../src/contracts/credential/totp.contract.ts';
import type { DeltaFrame, GroupFrame, ServerFrame } from '../../src/contracts/gateway/live.contract.ts';
import { definePublicRoute } from '../../src/contracts/gateway/publicRoute.contract.ts';
import { PUBLIC_ROUTES } from '../../src/contracts/gateway/routeTable.contract.ts';
import { clientAddress } from '../../src/middleware/clientAddress.middleware.ts';
import {
  clearedSessionCookie, readCookie, SESSION_COOKIE, sessionCookie, sessionTokenOf,
} from '../../src/middleware/cookies.middleware.ts';
import { checkBodyType, checkCrossSite, checkWebSocketOrigin } from '../../src/middleware/crossSite.middleware.ts';
import { createLiveSubscriber, type Timers } from '../../src/services/gateway/liveSubscriber.service.ts';
import { publicError } from '../../src/middleware/errors.middleware.ts';
import { AppError } from '../../src/utils/errors.util.ts';
import { issueSessionToken } from '../../src/utils/token.util.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';

const ORIGIN = 'https://app.silo.test';

describe('the client address (spec 7.3)', () => {
  test('is the address the trusted proxies saw, whatever the client wrote before it', () => {
    assert.equal(clientAddress('10.0.0.1', '6.6.6.6, 203.0.113.9', 1), '203.0.113.9');
    assert.equal(clientAddress('10.0.0.1', ['6.6.6.6', '203.0.113.9, 10.0.0.2'], 2), '203.0.113.9');
    assert.equal(clientAddress('10.0.0.1', '203.0.113.9', 0), '10.0.0.1', 'no trusted proxy: the peer');
    assert.equal(clientAddress('10.0.0.1', undefined, 1), '10.0.0.1', 'fewer entries than hops: the leftmost known');
    assert.equal(clientAddress('::ffff:127.0.0.1', undefined, 0), '127.0.0.1');
    assert.equal(clientAddress('10.0.0.1', 'not-an-address', 1), '10.0.0.1', 'a forged entry that is not an address');
    assert.equal(clientAddress('10.0.0.1', '2001:DB8::1', 1), '2001:db8::1');
  });
});

describe('the session cookie', () => {
  const { token } = issueSessionToken(uuidv7(), uuidv7());

  test('is host-only, Secure, HttpOnly and SameSite=Strict, and lives as long as the session', () => {
    const now = Date.now();
    const cookie = sessionCookie(token, new Date(now + 3_600_000).toISOString(), now);
    assert.ok(cookie.startsWith(`${SESSION_COOKIE}=${token}; `));
    assert.match(cookie, /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600$/);
    assert.doesNotMatch(cookie, /Domain=/i);
    assert.match(clearedSessionCookie(), /^__Host-silo_session=; .*Max-Age=0$/);
  });

  test('is read only when it has the shape of a session token', () => {
    assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=x; ${SESSION_COOKIE}=y`, SESSION_COOKIE), 'x', 'the first occurrence wins');
    assert.equal(sessionTokenOf(`theme=dark; ${SESSION_COOKIE}=${token}`), token);
    assert.equal(sessionTokenOf(`${SESSION_COOKIE}=silo_ses_short`), undefined);
    assert.equal(sessionTokenOf(undefined), undefined);
  });
});

describe('cross-site defences', () => {
  const refused = { code: 'gateway.cross_site' };
  test('state changes need this origin and the custom header; reads need neither', () => {
    checkCrossSite('POST', { origin: ORIGIN, 'x-silo-csrf': '1' }, ORIGIN);
    checkCrossSite('GET', {}, ORIGIN);
    assert.throws(() => checkCrossSite('POST', { 'x-silo-csrf': '1' }, ORIGIN), refused);
    assert.throws(() => checkCrossSite('DELETE', { origin: 'https://evil.example', 'x-silo-csrf': '1' }, ORIGIN), refused);
    assert.throws(() => checkCrossSite('POST', { origin: ORIGIN }, ORIGIN), refused);
    assert.throws(() => checkCrossSite('POST', { origin: `${ORIGIN}.evil.example`, 'x-silo-csrf': '1' }, ORIGIN), refused);
  });

  test('fetch metadata from another site is refused even for a read', () => {
    assert.throws(() => checkCrossSite('GET', { 'sec-fetch-site': 'cross-site' }, ORIGIN), refused);
    assert.throws(() => checkCrossSite('GET', { 'sec-fetch-site': 'same-site' }, ORIGIN), refused);
    checkCrossSite('GET', { 'sec-fetch-site': 'same-origin' }, ORIGIN);
    checkCrossSite('GET', { 'sec-fetch-site': 'none' }, ORIGIN);
  });

  test('WebSocket handshakes need this origin; bodies must be JSON', () => {
    checkWebSocketOrigin({ origin: ORIGIN }, ORIGIN);
    assert.throws(() => checkWebSocketOrigin({}, ORIGIN), refused);
    checkBodyType({ 'content-length': '2', 'content-type': 'application/json; charset=utf-8' });
    checkBodyType({});
    assert.throws(() => checkBodyType({ 'content-length': '2', 'content-type': 'text/plain' }), { code: 'request.content_type' });
    assert.throws(() => checkBodyType({ 'transfer-encoding': 'chunked', 'content-type': 'application/x-www-form-urlencoded' }),
      { code: 'request.content_type' });
  });
});

describe('public errors', () => {
  test('a refusal keeps its code and details, less the internal service', () => {
    const { status, body } = publicError(new AppError('forbidden', 'no', { code: 'auth.not_permitted', details: { reason: 'x', service: 'auth' } }));
    assert.equal(status, 403);
    assert.deepEqual(body.error.details, { reason: 'x' });
  });

  test('a failure inside the cell keeps its category and code, with a generic message and no details', () => {
    const { status, body } = publicError(new AppError('unavailable', 'auth could not be reached', {
      code: 'service.unreachable', details: { service: 'auth' }, retryable: true,
    }));
    assert.equal(status, 503);
    assert.equal(body.error.code, 'service.unreachable');
    assert.equal(body.error.details, undefined);
    assert.doesNotMatch(body.error.message, /auth/);
    assert.equal(publicError(new Error('driver said: secret row')).body.error.message.includes('secret'), false);
  });
});

describe('the route table', () => {
  test('every route is under /api/v1, and every complete-session route names a permission, its own records, or why its service decides', () => {
    for (const route of PUBLIC_ROUTES) {
      assert.ok(route.path.startsWith('/api/v1/'), route.id);
      if (route.session === 'complete') assert.ok(route.permission !== undefined || route.ownRecords || route.decidedByService !== undefined, route.id);
      if (route.forwards) assert.ok(route.forwards.callers.includes('gateway'), route.id);
    }
  });

  test('a route cannot skip authorisation, reach a contract the gateway may not call, or forge context', () => {
    assert.throws(() => definePublicRoute({
      name: 'unitNoPermission', method: 'POST', path: '/unit/a', session: 'complete', body: internalInvite.body, response: internalInvite.response,
      forwards: internalInvite, call: (input) => ({ body: input.body }), reply: (output) => output,
    }), /names the permission/);
    assert.throws(() => definePublicRoute({
      name: 'unitNotCaller', method: 'POST', path: '/unit/b', session: 'mfa_pending', response: enrolTotp.response,
      forwards: enrolTotp, call: () => ({ body: { userId: uuidv7(), organisationId: uuidv7(), accountLabel: 'x' } }) as never, reply: (output) => output,
    }), /not a listed caller/);
    assert.throws(() => definePublicRoute({
      name: 'unitNoSession', method: 'POST', path: '/unit/c', session: 'none', body: internalInvite.body, response: internalInvite.response,
      forwards: internalInvite, call: (input) => ({ body: input.body }), reply: (output) => output,
    }), /only a session gives/);
    assert.throws(() => definePublicRoute({
      name: 'unitClash', method: 'GET', path: '/session', session: 'mfa_pending', response: z.object({}),
      answer: () => ({}),
    }), /already gateway.currentSession/);
    assert.throws(() => definePublicRoute({
      name: 'unitAnswerNoSession', method: 'GET', path: '/unit/d', session: 'none', response: resolveSession.response,
      answer: () => { throw new Error('unreachable'); },
    }), /an answer comes from the session/);
  });
});

// ----------------------------------------------------------------------------- live pipeline

function manualClock(): Timers & { advance(ms: number): void } {
  let now = 0;
  let timers: { at: number; work: () => void }[] = [];
  return {
    setTimeout(work, ms) {
      const timer = { at: now + ms, work };
      timers.push(timer);
      return timer;
    },
    clearTimeout(handle) {
      timers = timers.filter((t) => t !== handle);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.work();
      }
      now = until;
    },
  };
}

const at = '2026-11-01T12:00:00.000Z';
const delta = (seq: number, object: string, changes: Record<string, string | number>, state?: string): DeltaFrame => ({
  type: 'delta', seq, object, coalesced: 0,
  changes: Object.entries(changes).map(([property, value]) => ({ property, value, source: 'conn_a', receivedAt: at })),
  ...(state === undefined ? {} : { state: { value: state, ruleVersion: 1, reason: 'rule' } }),
});

const modes: string[] = [];

function pipeline(options: { bufferCapacity?: number; coalesceMs?: number } = {}) {
  const clock = manualClock();
  const sent: ServerFrame[] = [];
  let stalled = 0;
  const subscriber = createLiveSubscriber({
    subscriptionId: 's_test', timers: clock, bufferCapacity: options.bufferCapacity, coalesceMs: options.coalesceMs ?? 250,
    onModeChange: (mode) => modes.push(mode),
    send: (frame) => {
      sent.push(frame);
      return JSON.stringify(frame).length;
    },
    onStalled: () => {
      stalled += 1;
    },
  });
  return { clock, sent, subscriber, stalled: () => stalled };
}

const deltas = (frames: ServerFrame[]) => frames.filter((f): f is Extract<ServerFrame, { type: 'delta' }> => f.type === 'delta');

describe('the live pipeline (spec 30.4)', () => {
  test('frames wait until the subscription is accepted, then pass the projection', () => {
    const { subscriber, sent, clock } = pipeline();
    const snapshot: GroupFrame = {
      type: 'snapshot', seq: 5, page: 0, last: true,
      objects: [{ object: 'o1', values: [{ property: 'status', value: 'RUN', source: 'conn_a', ageMs: 10 }, { property: 'salary', value: 1, source: 'conn_a', ageMs: 10 }] }],
    };
    subscriber.deliver(snapshot);
    assert.equal(sent.length, 0);
    subscriber.activate(['status']);
    assert.equal(sent[0]?.type, 'snapshot');
    assert.deepEqual((sent[0] as Extract<ServerFrame, { type: 'snapshot' }>).objects[0]!.values.map((v) => v.property), ['status']);
    subscriber.deliver(delta(6, 'o1', { salary: 2 }));
    clock.advance(300);
    assert.equal(deltas(sent).length, 0, 'a delta of withheld fields only is dropped');
  });

  test('within a window, the latest value per object and property, with the count coalesced', () => {
    const { subscriber, sent, clock } = pipeline();
    subscriber.activate(['status', 'flow']);
    subscriber.deliver(delta(1, 'o1', { status: 'RUN', flow: 1 }));
    subscriber.deliver(delta(2, 'o1', { flow: 2 }));
    subscriber.deliver(delta(3, 'o2', { flow: 9 }));
    subscriber.deliver(delta(4, 'o1', { flow: 3 }));
    assert.equal(sent.length, 0, 'nothing before the window closes');
    clock.advance(250);
    const out = deltas(sent);
    assert.deepEqual(out.map((d) => [d.object, d.seq, d.coalesced]), [['o2', 3, 0], ['o1', 4, 2]]);
    assert.deepEqual(Object.fromEntries(out[1]!.changes.map((c) => [c.property, c.value])), { status: 'RUN', flow: 3 });
    assert.ok(out.every((d) => d.sub === 's_test'));
  });

  test('a visual state transition is never coalesced away: normal, failed, normal sends both', () => {
    const { subscriber, sent, clock } = pipeline();
    subscriber.activate(['status']);
    subscriber.deliver(delta(1, 'p1', { status: 'TRIP' }, 'failed'));
    subscriber.deliver(delta(2, 'p1', { status: 'RUN' }, 'normal'));
    clock.advance(250);
    assert.deepEqual(deltas(sent).map((d) => d.state?.value), ['failed', 'normal']);
  });

  test('a projection change applies at once, to deltas still waiting too', () => {
    const { subscriber, sent, clock } = pipeline();
    subscriber.activate(['status', 'salary']);
    subscriber.deliver(delta(1, 'o1', { status: 'RUN', salary: 5 }));
    subscriber.deliver({ type: 'projection_changed', granted: ['status'], withheld: ['salary'] });
    clock.advance(250);
    assert.equal(sent[0]?.type, 'projection_changed');
    assert.deepEqual(deltas(sent)[0]!.changes.map((c) => c.property), ['status']);
  });

  test('past the high-water mark: snapshot mode, the latest per changed object every 2 seconds, until acknowledged', () => {
    const { subscriber, sent, clock } = pipeline({ bufferCapacity: 4, coalesceMs: 0 });
    subscriber.activate(['flow']);
    for (let seq = 1; seq <= 5; seq++) subscriber.deliver(delta(seq, `o${seq}`, { flow: seq }));
    assert.equal(subscriber.mode, 'snapshot');
    assert.deepEqual(sent.at(-1), { type: 'buffer_mode', sub: 's_test', mode: 'snapshot' });
    const before = deltas(sent).length;
    for (let seq = 6; seq <= 20; seq++) subscriber.deliver(delta(seq, 'o1', { flow: seq }));
    assert.equal(deltas(sent).length, before, 'nothing is sent between snapshots');
    clock.advance(2_000);
    const latest = deltas(sent).at(-1)!;
    assert.deepEqual([latest.object, latest.seq, latest.coalesced, latest.changes[0]!.value], ['o1', 20, 14, 20]);
    subscriber.ack(20);
    assert.equal(subscriber.mode, 'live');
    assert.deepEqual(sent.at(-1), { type: 'buffer_mode', sub: 's_test', mode: 'live' });
    assert.equal(subscriber.unacknowledged.frames, 0);
    assert.deepEqual(modes.slice(-2), ['snapshot', 'live'], 'each change of mode told to the state plane, which audits snapshot mode');
  });

  test('a client that never acknowledges is stalled', () => {
    const { subscriber, clock, stalled } = pipeline({ bufferCapacity: 1, coalesceMs: 0 });
    subscriber.activate(['flow']);
    for (let round = 0; round < 12; round++) {
      subscriber.deliver(delta(round * 2 + 1, `a${round}`, { flow: 1 }));
      subscriber.deliver(delta(round * 2 + 2, `b${round}`, { flow: 1 }));
      clock.advance(2_000);
    }
    assert.ok(stalled() > 0);
  });

  test('too many frames before acceptance: the client is told to resynchronise', () => {
    const { subscriber, sent } = pipeline();
    for (let seq = 0; seq < 1_001; seq++) subscriber.deliver(delta(seq, 'o1', { flow: seq }));
    subscriber.activate(['flow']);
    assert.deepEqual(sent, [{ type: 'resync_required', sub: 's_test' }]);
  });
});
