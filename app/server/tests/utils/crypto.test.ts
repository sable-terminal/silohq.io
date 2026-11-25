// Crypto primitives, the envelope scheme of spec 61, passwords, tokens and TOTP.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  aesGcmOpen, aesGcmSeal, constantTimeEqual, keyedHash, randomBytes, sha256,
} from '../../src/utils/crypto.util.ts';
import {
  DekCache, lastFour, rewrap, seal, sealBindings, withOpened, type KeyRing, type KeyWrapper,
} from '../../src/utils/envelope.util.ts';
import { hashPassword, needsRehash, PasswordHasher, verifyPassword, type Argon2Params } from '../../src/utils/password.util.ts';
import { hashToken, issueScimToken, issueToken, parseScimToken, TOKEN_PATTERN, tokenKind } from '../../src/utils/token.util.ts';
import { base32Decode, base32Encode, totpCode, totpStep, verifyTotp } from '../../src/utils/totp.util.ts';
import { uuidv7 } from '../../src/utils/id.util.ts';

const aad = Buffer.from('row');

describe('AES-256-GCM', () => {
  test('opens what it sealed, with a fresh nonce each time', () => {
    const key = randomBytes(32);
    const a = aesGcmSeal(key, Buffer.from('secret'), aad);
    const b = aesGcmSeal(key, Buffer.from('secret'), aad);
    assert.notDeepEqual(a.nonce, b.nonce);
    assert.equal(a.nonce.length, 12);
    assert.equal(aesGcmOpen(key, a, aad).toString(), 'secret');
  });

  test('refuses tampered ciphertext, another row and another key', () => {
    const key = randomBytes(32);
    const sealed = aesGcmSeal(key, Buffer.from('secret'), aad);
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0]! ^= 1;
    assert.throws(() => aesGcmOpen(key, tampered, aad), { category: 'integrity' });
    assert.throws(() => aesGcmOpen(key, sealed, Buffer.from('other row')), { category: 'integrity' });
    assert.throws(() => aesGcmOpen(randomBytes(32), sealed, aad), { category: 'integrity' });
  });

  test('keyed hashes differ by purpose and compare in constant time', () => {
    const key = randomBytes(32);
    assert.notDeepEqual(keyedHash(key, 'ip', '10.0.0.1'), keyedHash(key, 'user_agent', '10.0.0.1'));
    assert.ok(constantTimeEqual(sha256('a'), sha256('a')));
    assert.ok(!constantTimeEqual(sha256('a'), sha256('b')));
    assert.ok(!constantTimeEqual(Buffer.alloc(1), Buffer.alloc(2)));
  });
});

// A KMS stand-in: each key version is a random KEK, and the wrap context is the AAD.
function testKeyRing(): KeyRing & { rotate(): void; unwraps: number } {
  const keks = new Map<string, Buffer>();
  let activeId = '';
  const ring = {
    unwraps: 0,
    rotate() {
      activeId = uuidv7();
      keks.set(activeId, randomBytes(32));
    },
    async active() { return wrapper(activeId); },
    async version(id: string) { return wrapper(id); },
  };
  const wrapper = (id: string): KeyWrapper => ({
    keyVersionId: id,
    async wrap(dek, context) {
      const sealed = aesGcmSeal(keks.get(id)!, dek, context);
      return Buffer.concat([sealed.nonce, sealed.ciphertext]);
    },
    async unwrap(wrapped, context) {
      ring.unwraps += 1;
      return aesGcmOpen(keks.get(id)!, { nonce: wrapped.subarray(0, 12), ciphertext: wrapped.subarray(12) }, context);
    },
  });
  ring.rotate();
  return ring;
}

describe('envelope scheme (spec 61)', () => {
  const row = { id: uuidv7(), organisationId: uuidv7(), connectionId: uuidv7(), fieldName: 'api_key', purpose: 'connection_auth' };

  test('a secret opens only inside the callback, and is zeroed afterwards', async () => {
    const keys = testKeyRing();
    const sealed = await seal(keys, Buffer.from('sk_live_abc123'), sealBindings.connectionCredential(row));
    let seen: Buffer | undefined;
    const { value } = await withOpened(keys, sealed, sealBindings.connectionCredential(row), async (plaintext) => {
      seen = plaintext;
      return plaintext.toString();
    });
    assert.equal(value, 'sk_live_abc123');
    assert.ok(seen!.every((byte) => byte === 0), 'plaintext is zeroed after use');
  });

  test('a sealed secret moved to another row or tenant does not open', async () => {
    const keys = testKeyRing();
    const sealed = await seal(keys, Buffer.from('secret'), sealBindings.connectionCredential(row));
    const elsewhere = [
      { ...row, id: uuidv7() },
      { ...row, organisationId: uuidv7() },
      { ...row, fieldName: 'password' },
    ];
    for (const other of elsewhere) {
      await assert.rejects(withOpened(keys, sealed, sealBindings.connectionCredential(other), async () => 'opened'),
        { category: 'integrity' });
    }
  });

  test('rotation re-wraps the key without touching the ciphertext, and both versions still open', async () => {
    const keys = testKeyRing();
    const binding = sealBindings.mfaFactor({ id: uuidv7(), userId: uuidv7(), kind: 'totp' });
    const sealed = await seal(keys, Buffer.from('totp-secret'), binding);
    keys.rotate();
    const rewrapped = await rewrap(keys, sealed, binding);
    assert.notEqual(rewrapped.keyVersionId, sealed.keyVersionId);
    const moved = { ...sealed, ...rewrapped };
    assert.deepEqual(moved.ciphertext, sealed.ciphertext);
    for (const version of [sealed, moved]) {
      const { value } = await withOpened(keys, version, binding, async (p) => p.toString());
      assert.equal(value, 'totp-secret');
    }
  });

  test('the data key cache serves at most 200 uses or 5 minutes, then unwraps again', async () => {
    const keys = testKeyRing();
    const binding = sealBindings.identityProvider({ id: uuidv7(), organisationId: uuidv7(), kind: 'oidc' });
    const sealed = await seal(keys, Buffer.from('client-secret'), binding);
    let now = 0;
    const cache = new DekCache({ now: () => now });
    const open = () => withOpened(keys, sealed, binding, async () => true, cache);

    assert.equal((await open()).dekCacheHit, false);
    for (let i = 0; i < 200; i += 1) assert.equal((await open()).dekCacheHit, true);
    assert.equal((await open()).dekCacheHit, false, 'the 201st use unwraps again');
    now += 5 * 60_000;
    assert.equal((await open()).dekCacheHit, false, 'an entry older than 5 minutes is gone');
  });

  test('last four is computed from the plaintext', () => {
    assert.equal(lastFour('sk_live_abc123'), 'c123');
    assert.equal(lastFour('ab'), 'ab');
  });
});

describe('passwords (Argon2id, spec 55.3)', () => {
  const fast: Argon2Params = { memoryKiB: 1024, passes: 1, parallelism: 1, saltBytes: 16, hashBytes: 32 };

  test('verifies the right password and refuses the wrong one', async () => {
    const encoded = await hashPassword('correct horse battery staple', fast);
    assert.match(encoded, /^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
    assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
    assert.equal(await verifyPassword('Correct horse battery staple', encoded), false);
    assert.equal(await verifyPassword('anything', 'not a hash'), false);
  });

  test('asks for a rehash when the parameters change', async () => {
    const encoded = await hashPassword('pw', fast);
    assert.equal(needsRehash(encoded, fast), false);
    assert.equal(needsRehash(encoded, { ...fast, memoryKiB: 2048 }), true);
  });

  test('refuses an absurdly long password before hashing it', async () => {
    await assert.rejects(hashPassword('x'.repeat(1025), fast), { category: 'validation' });
  });

  test('the hasher caps concurrent hashes and refuses past its queue, so a login flood cannot exhaust memory', async () => {
    const durations: number[] = [];
    const hasher = new PasswordHasher(fast, { maxConcurrent: 2, maxQueued: 3 }, (ms) => durations.push(ms));
    const burst = Array.from({ length: 7 }, (_, i) => hasher.hash(`pw-${i}`));
    const results = await Promise.allSettled(burst);
    // 2 run, 3 wait, the other 2 are refused with a retry time.
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
    for (const refused of results.filter((r) => r.status === 'rejected')) {
      assert.equal((refused as PromiseRejectedResult).reason.category, 'capacity');
    }
    assert.equal(durations.length, 5, 'each hash reports its duration');
    assert.ok(durations.every((ms) => Number.isInteger(ms) && ms >= 0));
    // Slots were all handed back: a later burst within the limits succeeds in full.
    const again = await Promise.all(Array.from({ length: 5 }, () => hasher.hash('pw')));
    assert.equal(again.length, 5);
  });

  test('the hasher never runs more hashes at once than its cap', async () => {
    const encoded = await hashPassword('pw', fast);
    const peaks: number[] = [];
    const hasher: PasswordHasher = new PasswordHasher(fast, { maxConcurrent: 2, maxQueued: 100 }, () => peaks.push(hasher.load().running));
    const calls = Array.from({ length: 6 }, () => hasher.verify('pw', encoded));
    assert.deepEqual(hasher.load(), { running: 2, waiting: 4 });
    assert.deepEqual(await Promise.all(calls), [true, true, true, true, true, true]);
    assert.ok(peaks.every((running) => running <= 2));
    assert.deepEqual(hasher.load(), { running: 0, waiting: 0 });
    // A hash that throws still frees its slot.
    await assert.rejects(hasher.hash('x'.repeat(2000)), { category: 'validation' });
    assert.deepEqual(hasher.load(), { running: 0, waiting: 0 });
  });
});

describe('tokens', () => {
  test('are 256-bit, prefixed by kind, and stored as SHA-256', () => {
    const { token, hash } = issueToken('session');
    assert.match(token, /^silo_ses_[A-Za-z0-9_-]{43}$/);
    assert.ok(TOKEN_PATTERN.test(`Authorization: Bearer ${token}`));
    assert.equal(hash.length, 32);
    assert.deepEqual(hash, hashToken(token));
    assert.equal(tokenKind(token), 'session');
    assert.equal(tokenKind('silo_xyz_' + 'a'.repeat(43)), undefined);
  });

  test('a SCIM token carries its organisation for routing', () => {
    const organisationId = uuidv7();
    const { token, hash } = issueScimToken(organisationId);
    assert.deepEqual(parseScimToken(token), { organisationId, hash });
    assert.equal(parseScimToken(`not-a-uuid.${'a'.repeat(43)}`), undefined);
    assert.equal(parseScimToken(organisationId), undefined);
  });
});

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890"; 6-digit codes are the
  // last six digits of the 8-digit vectors.
  const secret = Buffer.from('12345678901234567890');
  const vectors: [number, string][] = [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']];

  test('matches the RFC test vectors', () => {
    for (const [seconds, code] of vectors) assert.equal(totpCode(secret, totpStep(seconds * 1000)), code);
  });

  test('accepts one step of drift, and a code only once', () => {
    const atMs = 1234567890 * 1000;
    const step = verifyTotp(secret, '005924', { atMs: atMs + 30_000 });
    assert.equal(step, totpStep(atMs));
    assert.equal(verifyTotp(secret, '005924', { atMs: atMs + 90_000 }), undefined, 'too far');
    assert.equal(verifyTotp(secret, '005924', { atMs, lastAcceptedStep: step }), undefined, 'replay');
    assert.equal(verifyTotp(secret, '12345', { atMs }), undefined);
  });

  test('base32 round trips (RFC 4648 vectors)', () => {
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.equal(base32Encode(Buffer.from('f')), 'MY');
    assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
    assert.equal(base32Decode('mzxw 6ytb oi==').toString(), 'foobar');
  });
});
