// Canonical JSON, the audit chain, redaction, errors, retry, time and ids.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { auditGenesisHash, auditRowHash, PartitionSeal, rowDigest, verifyAuditChain, type ChainedAuditEvent } from '../../src/utils/auditChain.util.ts';
import { canonicalJson } from '../../src/utils/canonicalJson.util.ts';
import { emailRoutingInput, normaliseEmail } from '../../src/utils/email.util.ts';
import { AppError, describeError, fromDatabaseError, refuse } from '../../src/utils/errors.util.ts';
import { isUuid, uuidv7 } from '../../src/utils/id.util.ts';
import { containsRecordValue, recordValue, type RecordValue, type SafeString } from '../../src/utils/recordValue.util.ts';
import { findValuePatterns, assertNoValuePatterns, isRedactedKey, redactKeys, REDACTED } from '../../src/utils/redaction.util.ts';
import { retry } from '../../src/utils/retry.util.ts';
import { countsAsActivity, effectiveSessionTimeouts, sessionExpiresAt } from '../../src/utils/session.util.ts';
import { canonicalTimestamp } from '../../src/utils/time.util.ts';

describe('canonical JSON (RFC 8785)', () => {
  test('sorts keys, drops whitespace, and writes numbers in ECMAScript form', () => {
    assert.equal(canonicalJson({ b: [1, true, null], a: { d: 'x', c: 1e21 }, z: undefined }),
      '{"a":{"c":1e+21,"d":"x"},"b":[1,true,null]}');
    assert.equal(canonicalJson({ '€': 1, '\r': 2, a: 3 }), '{"\\r":2,"a":3,"€":1}');
    assert.equal(canonicalJson(-0), '0');
  });

  test('refuses what is not JSON instead of guessing', () => {
    for (const bad of [NaN, Infinity, new Date(0), Buffer.from('x'), [undefined], 1n, () => 1]) {
      assert.throws(() => canonicalJson(bad), TypeError);
    }
  });
});

describe('time', () => {
  test('one canonical text per instant', () => {
    const same = ['2026-10-28T20:26:35.244100+00:00', '2026-10-28 20:26:35.2441+00', '2026-10-28T21:26:35.2441+01:00',
      '2026-10-28T20:26:35.244100Z'];
    for (const value of same) assert.equal(canonicalTimestamp(value), '2026-10-28T20:26:35.244100Z');
    assert.throws(() => canonicalTimestamp('yesterday'), TypeError);
  });
});

describe('audit hash chain', () => {
  const organisationId = uuidv7();
  const event = (chainSeq: number, detail: unknown = { count: chainSeq }): ChainedAuditEvent => ({
    organisationId, chainSeq, sourceEventId: uuidv7(), occurredAt: `2026-10-28T10:00:0${chainSeq}.000001Z`,
    retentionClass: 'standard', event: 'role_assigned', membershipId: uuidv7(), servicePrincipalId: null,
    operatorId: null, systemService: null, subjectMembershipId: null, scopeId: null, resourceType: 'role',
    resourceId: uuidv7(), purposeSessionId: null, operatorAccessSessionId: null, correlationId: uuidv7(),
    detail, ipHash: Buffer.alloc(32, 7),
  });
  const chain = (events: ChainedAuditEvent[]) => {
    let prev = auditGenesisHash(organisationId);
    return events.map((e) => {
      const row = { ...e, prevHash: prev, rowHash: auditRowHash(prev, e) };
      prev = row.rowHash;
      return row;
    });
  };

  test('an intact chain verifies', () => {
    const verdict = verifyAuditChain(organisationId, chain([event(1), event(2), event(3)]));
    assert.equal(verdict.ok, true);
  });

  test('a changed, removed or reordered row is found', () => {
    const rows = chain([event(1), event(2), event(3)]);
    assert.deepEqual(verifyAuditChain(organisationId, [rows[0]!, { ...rows[1]!, detail: { count: 99 } }, rows[2]!]),
      { ok: false, chainSeq: '2', reason: 'row_hash' });
    assert.deepEqual(verifyAuditChain(organisationId, [rows[0]!, rows[2]!]), { ok: false, chainSeq: '3', reason: 'gap' });
    const swapped = { ...rows[2]!, chainSeq: 2 };
    assert.deepEqual(verifyAuditChain(organisationId, [rows[0]!, swapped]), { ok: false, chainSeq: '2', reason: 'prev_hash' });
    assert.deepEqual(verifyAuditChain(uuidv7(), rows), { ok: false, chainSeq: '1', reason: 'organisation' });
    assert.notDeepEqual(auditGenesisHash(organisationId), auditGenesisHash(uuidv7()));
  });

  test('the hash does not depend on how the timestamp was formatted', () => {
    const e = event(1);
    const genesis = auditGenesisHash(organisationId);
    assert.deepEqual(auditRowHash(genesis, e), auditRowHash(genesis, { ...e, occurredAt: '2026-10-28 11:00:01.000001+01' }));
  });

  test('a partition seal changes when any row is dropped', () => {
    const digests = [rowDigest({ id: 1n, value: Buffer.from('a') }), rowDigest({ id: 2n }), rowDigest({ id: 3n })];
    const full = new PartitionSeal();
    digests.forEach((d) => full.add(d));
    const short = new PartitionSeal();
    [digests[0]!, digests[2]!].forEach((d) => short.add(d));
    assert.notDeepEqual(full.runningHash, short.runningHash);
    assert.equal(full.rowCount, 3);
  });
});

describe('redaction', () => {
  test('finds value patterns (spec 7.8)', () => {
    assert.deepEqual(findValuePatterns('contact ada@acme.example now'), ['email']);
    assert.deepEqual(findValuePatterns('card 4111 1111 1111 1111'), ['card_number']);
    assert.deepEqual(findValuePatterns('card 4111111111111111'), ['card_number', 'long_digit_string']);
    assert.deepEqual(findValuePatterns('NI AB 12 34 56 C'), ['national_insurance_number']);
    assert.deepEqual(findValuePatterns('account 0123456789'), ['long_digit_string']);
    assert.deepEqual(findValuePatterns(`token silo_ses_${'a'.repeat(43)}`), ['silo_token']);
    assert.deepEqual(findValuePatterns(`rows 42 in 1.5s for org ${uuidv7()}`), []);
    assert.deepEqual(findValuePatterns('org 01a1eb72-6ea9-7f72-a8a3-012345678912'), [], 'a UUID whose last group is digits is still an identifier');
    assert.deepEqual(findValuePatterns('4111 1111 1111 1112'), [], 'not Luhn-valid: no card');
    assert.throws(() => assertNoValuePatterns('Revenue for ada@acme.example', 'question'),
      (error: AppError) => error.category === 'validation' && !error.message.includes('ada'));
  });

  test('removes secret and value keys with everything beneath them (spec 13.1)', () => {
    for (const key of ['password', 'clientSecret', 'accessToken', 'authorization', 'Cookie', 'newValue', 'values', 'rows',
      'record', 'payload', 'prompt', 'completion', 'secret_sealed', 'api_key']) {
      assert.ok(isRedactedKey(key), key);
    }
    for (const key of ['rowCount', 'tokenHash', 'organisationId', 'durationMs', 'idempotencyKey', 'errorCode']) {
      assert.ok(!isRedactedKey(key), key);
    }
    const cyclic: Record<string, unknown> = { rowCount: 2, request: { headers: { authorization: 'Bearer x' }, rows: [{ a: 1 }] } };
    cyclic['self'] = cyclic;
    assert.deepEqual(redactKeys(cyclic), {
      rowCount: 2, request: { headers: { authorization: REDACTED }, rows: REDACTED }, self: REDACTED,
    });
  });
});

describe('record values', () => {
  test('the registry finds a marked field however deeply it is wrapped', () => {
    const plain = z.object({ organisationId: z.uuid(), count: z.number() });
    const marked = z.object({
      objects: z.array(z.object({ key: z.string(), after: recordValue(z.unknown()).optional() })),
    });
    const inUnion = z.union([z.object({ a: z.string() }), z.object({ b: recordValue(z.string()) })]);
    assert.equal(containsRecordValue(plain), false);
    assert.equal(containsRecordValue(marked), true);
    assert.equal(containsRecordValue(inUnion), true);
  });

  test('a record value is not a SafeString', () => {
    const value = 'ada@acme.example' as RecordValue<string>;
    // @ts-expect-error a record value cannot reach typed logging
    const blocked: SafeString = value;
    const allowed: SafeString = 'connection refused';
    assert.ok(blocked && allowed);
  });
});

describe('errors', () => {
  test('a database error keeps its class and constraint, never its message', () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint; Key (email)=(ada@acme.example)'), {
      code: '23505', constraint: 'users_email_key', schema: 'iam', table: 'users', detail: 'Key (email)=(ada@acme.example)',
    });
    const error = fromDatabaseError(pgError);
    assert.equal(error.category, 'conflict');
    assert.deepEqual(error.details, { sqlstate: '23505', constraint: 'users_email_key', table: 'iam.users' });
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes('ada@'));
    assert.equal(fromDatabaseError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).category, 'unavailable');
    assert.equal(fromDatabaseError({ code: '40001' }).retryable, true);
  });

  test('refusals are counted apart from errors (spec 12.1)', () => {
    assert.equal(refuse.bound('rows_per_source_step', 100000).refusal, true);
    assert.equal(refuse.capacity(30).retryAfterSeconds, 30);
    assert.equal(new AppError('internal', 'defect').refusal, false);
    assert.deepEqual(describeError(new TypeError('row 4 has value ada@acme.example')),
      { errorCategory: 'internal', errorCode: 'unhandled', errorClass: 'TypeError', refusal: false });
  });
});

describe('retry', () => {
  test('retries what is retryable, up to the limit, and stops on anything else', async () => {
    let calls = 0;
    const result = await retry(async () => {
      calls += 1;
      if (calls < 3) throw new AppError('unavailable', 'down');
      return 'ok';
    }, { attempts: 5, baseDelayMs: 1, maxDelayMs: 2 });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);

    calls = 0;
    await assert.rejects(retry(async () => { calls += 1; throw new AppError('validation', 'bad'); },
      { attempts: 5, baseDelayMs: 1, maxDelayMs: 2 }), { category: 'validation' });
    assert.equal(calls, 1);

    calls = 0;
    await assert.rejects(retry(async () => { calls += 1; throw new AppError('unavailable', 'down'); },
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 }));
    assert.equal(calls, 3);
  });
});

describe('ids and emails', () => {
  test('UUIDv7 carries its time and version', () => {
    const id = uuidv7(Date.UTC(2026, 9, 28));
    assert.ok(isUuid(id));
    assert.equal(id[14], '7');
    assert.ok(uuidv7(Date.UTC(2026, 9, 28)) < uuidv7(Date.UTC(2026, 9, 29)));
  });

  test('emails hash in one normal form', () => {
    assert.equal(normaliseEmail('  Ada@ACME.example '), 'ada@acme.example');
    assert.deepEqual(emailRoutingInput('Ada@Acme.example'), emailRoutingInput('ada@acme.example'));
  });
});

describe('sessions (spec 60)', () => {
  const cell = { idleMinutes: 30, absoluteMinutes: 12 * 60 };

  test('an organisation may shorten the timeouts, never lengthen them', () => {
    assert.deepEqual(effectiveSessionTimeouts(cell), cell);
    assert.deepEqual(effectiveSessionTimeouts(cell, { sessionIdleMinutes: null, sessionAbsoluteMinutes: null }), cell);
    assert.deepEqual(effectiveSessionTimeouts(cell, { sessionIdleMinutes: 10, sessionAbsoluteMinutes: 240 }),
      { idleMinutes: 10, absoluteMinutes: 240 });
    assert.deepEqual(effectiveSessionTimeouts(cell, { sessionIdleMinutes: 120, sessionAbsoluteMinutes: 7 * 24 * 60 }), cell);
  });

  test('live deltas and heartbeats are not activity; what the person does is', () => {
    assert.equal(countsAsActivity('http_request'), true);
    assert.equal(countsAsActivity('websocket_client_message'), true);
    assert.equal(countsAsActivity('websocket_delta'), false);
    assert.equal(countsAsActivity('websocket_heartbeat'), false);
  });

  test('a session ends at the earlier of idle and absolute expiry', () => {
    const issued = '2026-10-29T08:00:00.000Z';
    assert.equal(sessionExpiresAt(issued, '2026-10-29T09:00:00.000Z', cell), '2026-10-29T09:30:00.000Z');
    assert.equal(sessionExpiresAt(issued, '2026-10-29T19:50:00.000Z', cell), '2026-10-29T20:00:00.000Z');
  });
});
