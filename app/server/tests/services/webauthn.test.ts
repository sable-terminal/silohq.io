// WebAuthn as an MFA factor and changing a password while signed in (spec 55.3, 55.4), end
// to end through the gateway, with a software authenticator: a P-256 key pair, the
// authenticator data and the 'none' attestation built as a security key would build them.
// The verification itself is @simplewebauthn/server's.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { issueToken } from '../../src/utils/token.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { browser, call, ORIGIN, PASSWORD, startCell, type Browser, type Cell } from './sso.helper.ts';

let cell: Cell;
const RP_ID = new URL(ORIGIN).hostname;
const b64 = (data: Uint8Array | string): string => Buffer.from(data).toString('base64url');
const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();

/** A security key: one credential, a counter it moves on with each assertion. */
class SoftKey {
  readonly id = randomBytes(32);
  readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  counter = 0;

  private coseKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
    ]));
  }

  private authData(flags: number, attested?: Uint8Array): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(RP_ID), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  register(options: { challenge: string }, origin = ORIGIN) {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.id.length);
    const attested = Buffer.concat([Buffer.alloc(16), length, this.id, Buffer.from(this.coseKey())]);
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false });
    const attestation = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(this.authData(0x41, attested))]]) as never);
    return {
      id: b64(this.id), rawId: b64(this.id), type: 'public-key',
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestation), transports: ['usb'] }, clientExtensionResults: {},
    };
  }

  assert(options: { challenge: string }, overrides: { origin?: string; signer?: KeyObject; counter?: number } = {}) {
    this.counter = overrides.counter ?? this.counter + 1;
    const authData = this.authData(0x01);
    const clientData = JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: overrides.origin ?? ORIGIN, crossOrigin: false });
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), overrides.signer ?? this.keys.privateKey);
    return {
      id: b64(this.id), rawId: b64(this.id), type: 'public-key',
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature) }, clientExtensionResults: {},
    };
  }
}

/** A member who accepted an invitation by password: a signed-in browser. */
async function member(email: string): Promise<Browser> {
  const { token, hash } = issueToken('invitation');
  await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `insert into iam.invitations (id, organisation_id, email, token_hash, role_id, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + interval '1 day')`, [uuidv7(), cell.org, email, hash, cell.roles['Member'], cell.rootMembership]));
  const who = browser();
  const accepted = await call(cell.gateway, who, 'POST', '/invitations/accept', {
    organisationSlug: 'acme', token, password: PASSWORD, firstName: 'Key', lastName: 'Holder',
  });
  assert.equal(accepted.status, 201, accepted.text);
  return who;
}

async function signInAs(email: string, password = PASSWORD): Promise<{ who: Browser; status: number; body: any }> {
  const who = browser();
  const reply = await call(cell.gateway, who, 'POST', '/sessions', { organisationSlug: 'acme', email, password });
  return { who, status: reply.status, body: reply.body };
}

before(async () => {
  cell = await startCell();
});

after(async () => {
  await cell?.close();
});

describe('a security key as an MFA factor', () => {
  const key = new SoftKey();
  const email = 'key.holder@acme.example';

  test('registered with the library\'s ceremony: confirmed at once, MFA satisfied', async () => {
    const who = await member(email);
    const started = await call(cell.gateway, who, 'POST', '/mfa/webauthn');
    assert.equal(started.status, 201, started.text);
    assert.equal(started.body.options.rp.id, RP_ID);
    assert.equal(started.body.options.attestation, 'none');
    const confirmed = await call(cell.gateway, who, 'POST', '/mfa/webauthn/confirm', { response: key.register(started.body.options) });
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.body.mfa, 'satisfied');
    const { rows } = await cell.migrate.query(
      `select f.kind, f.confirmed_at is not null as confirmed, f.sign_count from iam.mfa_factors f join iam.users u on u.id = f.user_id where u.email = $1`, [email]);
    assert.deepEqual(rows, [{ kind: 'webauthn', confirmed: true, sign_count: '0' }]);
  });

  test('a new sign-in needs the key: only the MFA routes until it is verified', async () => {
    const { who, body } = await signInAs(email);
    assert.equal(body.mfa, 'required');
    assert.equal((await call(cell.gateway, who, 'GET', '/scim-tokens')).status, 403, 'nothing else yet');
    const started = await call(cell.gateway, who, 'POST', '/session/mfa/webauthn');
    assert.equal(started.status, 201, started.text);
    assert.deepEqual(started.body.options.allowCredentials.map((c: { id: string }) => c.id), [b64(key.id)]);
    const verified = await call(cell.gateway, who, 'POST', '/session/mfa/webauthn/verify', { response: key.assert(started.body.options) });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.body.mfa, 'satisfied');
    const { rows } = await cell.migrate.query(
      `select f.sign_count from iam.mfa_factors f join iam.users u on u.id = f.user_id where u.email = $1`, [email]);
    assert.equal(rows[0].sign_count, '1');
  });

  test('an assertion is used once, and a counter that does not move on is refused as a clone', async () => {
    const first = await signInAs(email);
    const options = (await call(cell.gateway, first.who, 'POST', '/session/mfa/webauthn')).body.options;
    const answer = key.assert(options);
    assert.equal((await call(cell.gateway, first.who, 'POST', '/session/mfa/webauthn/verify', { response: answer })).status, 200);

    const second = await signInAs(email);
    await call(cell.gateway, second.who, 'POST', '/session/mfa/webauthn');
    const replay = await call(cell.gateway, second.who, 'POST', '/session/mfa/webauthn/verify', { response: answer });
    assert.equal(replay.status, 401, 'the old challenge');
    assert.equal(replay.body.error.code, 'webauthn.failed');

    const third = await signInAs(email);
    const fresh = (await call(cell.gateway, third.who, 'POST', '/session/mfa/webauthn')).body.options;
    const clone = await call(cell.gateway, third.who, 'POST', '/session/mfa/webauthn/verify', { response: key.assert(fresh, { counter: 1 }) });
    assert.equal(clone.status, 401);
    assert.equal(await Number((await cell.migrate.query(
      `select count(*) as n from platform.outbox where payload->>'event' = 'login_failed' and payload->'detail'->>'reason' like 'mfa_webauthn%'`)).rows[0].n) >= 2, true);
    key.counter = 2;
  });

  test('another origin, or another key\'s signature, is refused', async () => {
    const { who } = await signInAs(email);
    const options = (await call(cell.gateway, who, 'POST', '/session/mfa/webauthn')).body.options;
    const phished = await call(cell.gateway, who, 'POST', '/session/mfa/webauthn/verify', { response: key.assert(options, { origin: 'https://app.silo.test.evil.example' }) });
    assert.equal(phished.status, 401);
    const again = (await call(cell.gateway, who, 'POST', '/session/mfa/webauthn')).body.options;
    const forged = await call(cell.gateway, who, 'POST', '/session/mfa/webauthn/verify', {
      response: key.assert(again, { signer: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }),
    });
    assert.equal(forged.status, 401);
  });

  test('a second key is added only after MFA is satisfied in the session', async () => {
    const { who } = await signInAs(email);
    const early = await call(cell.gateway, who, 'POST', '/mfa/webauthn');
    assert.equal(early.status, 403);
    assert.equal(early.body.error.code, 'mfa.verify_first');
    const options = (await call(cell.gateway, who, 'POST', '/session/mfa/webauthn')).body.options;
    assert.equal((await call(cell.gateway, who, 'POST', '/session/mfa/webauthn/verify', { response: key.assert(options) })).status, 200);
    const started = await call(cell.gateway, who, 'POST', '/mfa/webauthn');
    assert.deepEqual(started.body.options.excludeCredentials.map((c: { id: string }) => c.id), [b64(key.id)]);
    const second = new SoftKey();
    assert.equal((await call(cell.gateway, who, 'POST', '/mfa/webauthn/confirm', { response: second.register(started.body.options) })).status, 200);
    const dup = (await call(cell.gateway, who, 'POST', '/mfa/webauthn')).body.options;
    const twice = await call(cell.gateway, who, 'POST', '/mfa/webauthn/confirm', { response: second.register(dup) });
    assert.equal(twice.status, 409);
  });
});

describe('changing a password while signed in', () => {
  const email = 'changer@acme.example';

  test('needs the current password; revokes every other session, keeps this one', async () => {
    const here = await member(email);
    const elsewhere = (await signInAs(email)).who;
    const wrong = await call(cell.gateway, here, 'POST', '/password', { currentPassword: 'not it at all', newPassword: 'a whole new passphrase' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'auth.password_wrong');
    const short = await call(cell.gateway, here, 'POST', '/password', { currentPassword: PASSWORD, newPassword: 'short' });
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, 'password.too_short');

    const changed = await call(cell.gateway, here, 'POST', '/password', { currentPassword: PASSWORD, newPassword: 'a whole new passphrase' });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.body.otherSessionsRevoked, 1);
    assert.equal((await call(cell.gateway, here, 'GET', '/session')).status, 200, 'this session stays');
    assert.equal((await call(cell.gateway, elsewhere, 'GET', '/session')).status, 401, 'the other is gone at once');
    assert.equal((await signInAs(email)).status, 401, 'the old password no longer works');
    assert.equal((await signInAs(email, 'a whole new passphrase')).status, 201);
    const { rows } = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where payload->>'event' = 'password_changed'`);
    assert.equal(rows[0].detail.sessions_revoked, 1);
  });

  test('needs a signed-in, complete session', async () => {
    const reply = await call(cell.gateway, browser(), 'POST', '/password', { currentPassword: PASSWORD, newPassword: 'a whole new passphrase' });
    assert.equal(reply.status, 401);
  });
});
