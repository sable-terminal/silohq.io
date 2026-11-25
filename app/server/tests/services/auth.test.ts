// The auth and credential services end to end: two real processes against a fresh cell
// database, Redis and a local key, called through the gateway's client.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { confirmTotpEnrolment, startTotpEnrolment, verifyMfa } from '../../src/contracts/auth/mfa.contract.ts';
import { requestPasswordReset, resetPassword } from '../../src/contracts/auth/password.contract.ts';
import { login, resolveSession, revokeSession } from '../../src/contracts/auth/session.contract.ts';
import { sessionKeys } from '../../src/infra/keyspaces.infra.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { connectRedis, type RedisStore } from '../../src/infra/redis.infra.ts';
import { createServiceClient, type ServiceClient } from '../../src/infra/serviceClient.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { hashPassword } from '../../src/utils/password.util.ts';
import { base32Decode, totpCode, totpStep } from '../../src/utils/totp.util.ts';
import { parseSessionToken } from '../../src/utils/token.util.ts';
import { createLocalCell, createMembership, createOrganisation } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a much longer passphrase 2026';
const BREACHED = 'password1234567';
const fast = { memoryKiB: 1024, passes: 1, parallelism: 1, saltBytes: 16, hashBytes: 32 };

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let credential: RunningProcess;
let authProcess: RunningProcess;
let gateway: ServiceClient;
let redisSession: RedisStore;
let breachDir: string;
const delivered: { token: string; email: string }[] = [];
const quiet = createLogger({ service: 'test', cell: 'uk-lon-1', release: 'test', level: 'error', write: () => undefined });

let orgId: string;
let ssoOrgId: string;

async function createUserWithPassword(email: string, password = PASSWORD): Promise<string> {
  const id = uuidv7();
  const passwordHash = await hashPassword(password, fast);
  await inTx(auth, { userId: id }, () => auth.query(
    'insert into iam.users (id, first_name, last_name, email, password_hash) values ($1, $2, $3, $4, $5)',
    [id, 'Test', 'Person', email, passwordHash]));
  return id;
}

// The breach list as the dataset lays it out: files for each prefix the tests touch.
function writeBreachList(dir: string): void {
  const files = new Map<string, string[]>();
  const add = (password: string, breached: boolean): void => {
    const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
    const lines = files.get(hash.slice(0, 5)) ?? ['0000000000000000000000000000000000A:1'];
    if (breached) lines.push(`${hash.slice(5)}:42`);
    files.set(hash.slice(0, 5), lines);
  };
  add(BREACHED, true);
  add(NEW_PASSWORD, false);
  for (const [prefix, lines] of files) writeFileSync(path.join(dir, `${prefix}.txt`), `${lines.join('\r\n')}\r\n`);
}

const baseEnv = (service: string, login: 'test_auth' | 'test_credential'): Record<string, string> => ({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: 'uk-lon-1', SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk',
  SILO_HOSTING: 'gke', SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0',
  PG_CONTROL_URL: h.url(login),
});

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');
  await createLocalCell(migrate);
  await migrate.query(
    `insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at)
     values ($1, 'local', 'local:test', 1, 'active', now())`, [uuidv7()]);
  orgId = await createOrganisation(app, 'acme');
  ssoOrgId = await createOrganisation(app, 'initech');
  await migrate.query('update iam.organisations set sso_required = true where id = $1', [ssoOrgId]);

  breachDir = mkdtempSync(path.join(tmpdir(), 'silo-breach-'));
  writeBreachList(breachDir);

  credential = await runProcess([credentialService], loadConfig({
    ...baseEnv('credential', 'test_credential'), KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
  }), { logger: quiet });

  const authConfig: Config = loadConfig({
    ...baseEnv('auth', 'test_auth'),
    REDIS_SESSION_URL: `${LOCAL.redisUrl}/0`, REDIS_DATA_URL: `${LOCAL.redisUrl}/1`,
    IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
    ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1', LOGIN_LOCKOUT_THRESHOLD: '3', LOGIN_ATTEMPTS_PER_ADDRESS: '5',
    LOGIN_ATTEMPTS_PER_EMAIL: '50', BREACH_LIST_DIR: breachDir,
    SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`,
  });
  authProcess = await runProcess([createAuthService({
    resetDelivery: { async deliver(reset) { delivered.push({ token: reset.token, email: reset.email }); } },
  })], authConfig, { logger: quiet });
  gateway = createServiceClient({ caller: 'gateway', http: { ...authConfig.http, serviceUrls: { auth: `http://127.0.0.1:${authProcess.port}` } } });
  redisSession = await connectRedis('session', { ...authConfig.redis, session: `${LOCAL.redisUrl}/0` });
});

after(async () => {
  gateway?.close();
  await redisSession?.close();
  await authProcess?.stop('test');
  await credential?.stop('test');
  await h?.close();
  rmSync(breachDir, { recursive: true, force: true });
});

async function member(email: string, organisationId = orgId): Promise<string> {
  const userId = await createUserWithPassword(email);
  await createMembership(app, organisationId, userId);
  return userId;
}

const signIn = (email: string, password = PASSWORD, slug = 'acme', address?: string) =>
  gateway.call(login, { body: { organisationSlug: slug, email, password, ...(address ? { client: { address } } : {}) } });

async function outboxEvents(organisationId: string): Promise<string[]> {
  const { rows } = await migrate.query(
    `select payload->>'event' as event from platform.outbox where organisation_id = $1 and topic = 'audit.events' order by seq`, [organisationId]);
  return rows.map((r) => r.event as string);
}

describe('password login (spec 55.3, 60.1)', () => {
  test('a member signs in to their organisation and gets a session bound to their membership', async () => {
    const userId = await member('ada@acme.example');
    const session = await signIn('ada@acme.example');
    assert.equal(session.userId, userId);
    assert.equal(session.organisationId, orgId);
    assert.equal(session.mfa, 'not_required');
    assert.deepEqual(parseSessionToken(session.sessionToken)?.sessionId, session.sessionId);
    const resolved = await gateway.call(resolveSession, { body: { sessionToken: session.sessionToken, activity: 'http_request' } });
    assert.equal(resolved.membershipId, session.membershipId);
    assert.ok((await outboxEvents(orgId)).includes('login'));
  });

  test('every failure answers the same', async () => {
    await member('bob@acme.example');
    for (const [email, password, slug] of [
      ['bob@acme.example', 'wrong password!!', 'acme'], ['nobody@acme.example', PASSWORD, 'acme'], ['bob@acme.example', PASSWORD, 'no-such-org'],
    ] as const) {
      await assert.rejects(signIn(email, password, slug), { category: 'unauthenticated', code: 'auth.login_failed' });
    }
  });

  test('repeated failure locks the account, and a locked account refuses even the right password', async () => {
    await member('carol@acme.example');
    for (let i = 0; i < 3; i++) await assert.rejects(signIn('carol@acme.example', 'nope nope nope'), { code: 'auth.login_failed' });
    await assert.rejects(signIn('carol@acme.example'), { code: 'auth.login_failed' });
    assert.ok((await outboxEvents(orgId)).includes('lockout'));
  });

  test('a person who is not a member of the organisation cannot sign in to it', async () => {
    const userId = await createUserWithPassword('dave@globex.example');
    void userId;
    await assert.rejects(signIn('dave@globex.example'), { code: 'auth.login_failed' });
  });

  test('an organisation that requires SSO refuses password login', async () => {
    await member('erin@initech.example', ssoOrgId);
    await assert.rejects(signIn('erin@initech.example', PASSWORD, 'initech'), { category: 'forbidden', code: 'auth.sso_required' });
  });

  test('attempts from one address are rate limited', async () => {
    await member('frank@acme.example');
    const address = '203.0.113.7';
    for (let i = 0; i < 5; i++) await signIn('frank@acme.example', PASSWORD, 'acme', address);
    await assert.rejects(signIn('frank@acme.example', PASSWORD, 'acme', address), { category: 'rate_limited' });
  });
});

describe('sessions (spec 60.1, 60.2; decisions 2026-10-29)', () => {
  let token: string;
  let key: ReturnType<typeof sessionKeys.key>;
  before(async () => {
    await member('grace@acme.example');
    const session = await signIn('grace@acme.example');
    token = session.sessionToken;
    key = sessionKeys.key(orgId, { sessionId: session.sessionId });
  });

  const resolve = (activity: 'http_request' | 'websocket_delta' = 'http_request', sessionToken = token) =>
    gateway.call(resolveSession, { body: { sessionToken, activity } });

  test('only what the person does moves the idle clock', async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    await redisSession.setFields(sessionKeys, key, { idleExpiresAt: soon });
    assert.equal((await resolve('websocket_delta')).idleExpiresAt, soon, 'a live delta is not activity');
    const slid = await resolve('http_request');
    assert.ok(Date.parse(slid.idleExpiresAt) > Date.now() + 29 * 60_000, 'a request slides it to 30 minutes');
  });

  test('a lost hot copy is rebuilt from Postgres', async () => {
    await redisSession.remove(sessionKeys, key);
    assert.ok((await resolve()).sessionId);
    assert.ok(await redisSession.readHash(sessionKeys, key), 'the copy is back');
  });

  test('a token with the right ids and the wrong secret is refused', async () => {
    const forged = `${token.slice(0, -10)}AAAAAAAAAA`;
    await assert.rejects(resolve('http_request', forged), { code: 'auth.session_invalid' });
  });

  test('an idle session is refused and revoked, so no rebuild can revive it', async () => {
    const session = await signIn('grace@acme.example');
    const idleKey = sessionKeys.key(orgId, { sessionId: session.sessionId });
    await redisSession.setFields(sessionKeys, idleKey, { idleExpiresAt: new Date(Date.now() - 1000).toISOString() });
    await assert.rejects(resolve('http_request', session.sessionToken), { code: 'auth.session_invalid' });
    await redisSession.remove(sessionKeys, idleKey);
    await assert.rejects(resolve('http_request', session.sessionToken), { code: 'auth.session_invalid' });
  });

  test('an organisation\'s shorter idle timeout applies', async () => {
    await migrate.query('update iam.organisations set session_idle_minutes = 10 where id = $1', [orgId]);
    try {
      const session = await signIn('grace@acme.example');
      assert.ok(Date.parse(session.idleExpiresAt) < Date.now() + 11 * 60_000);
    } finally {
      await migrate.query('update iam.organisations set session_idle_minutes = null where id = $1', [orgId]);
    }
  });

  test('sign-out revokes in Postgres and removes the copy', async () => {
    const session = await signIn('grace@acme.example');
    await gateway.call(revokeSession, { body: { sessionToken: session.sessionToken } });
    await assert.rejects(resolve('http_request', session.sessionToken), { code: 'auth.session_invalid' });
    assert.equal(await redisSession.readHash(sessionKeys, sessionKeys.key(orgId, { sessionId: session.sessionId })), undefined);
    await gateway.call(revokeSession, { body: { sessionToken: session.sessionToken } });
  });
});

describe('MFA by TOTP (spec 55.4; decisions 2026-10-29)', () => {
  test('enrol, confirm, then each later sign-in needs a fresh code, and a code works once', async () => {
    const userId = await member('heidi@acme.example');
    const first = await signIn('heidi@acme.example');
    const { factorId, otpauthUri } = await gateway.call(startTotpEnrolment, { body: { sessionToken: first.sessionToken } });
    const secret = base32Decode(new URL(otpauthUri).searchParams.get('secret')!);
    const step = totpStep();
    const wrong = String((Number(totpCode(secret, step)) + 1) % 1_000_000).padStart(6, '0');
    await assert.rejects(gateway.call(confirmTotpEnrolment, { body: { sessionToken: first.sessionToken, factorId, code: wrong } }),
      { code: 'auth.mfa_failed' });
    const confirmed = await gateway.call(confirmTotpEnrolment, { body: { sessionToken: first.sessionToken, factorId, code: totpCode(secret, step) } });
    assert.equal(confirmed.mfa, 'satisfied');

    const second = await signIn('heidi@acme.example');
    assert.equal(second.mfa, 'required');
    await assert.rejects(gateway.call(startTotpEnrolment, { body: { sessionToken: second.sessionToken } }), { code: 'mfa.verify_first' });
    await assert.rejects(gateway.call(verifyMfa, { body: { sessionToken: second.sessionToken, code: totpCode(secret, step) } }),
      { code: 'auth.mfa_failed' }, 'the code used to confirm cannot be used again');
    const next = totpCode(secret, step + 1);
    const verified = await gateway.call(verifyMfa, { body: { sessionToken: second.sessionToken, code: next } });
    assert.equal(verified.mfa, 'satisfied');
    const resolved = await gateway.call(resolveSession, { body: { sessionToken: second.sessionToken, activity: 'http_request' } });
    assert.equal(resolved.mfa, 'satisfied');

    const third = await signIn('heidi@acme.example');
    await assert.rejects(gateway.call(verifyMfa, { body: { sessionToken: third.sessionToken, code: next } }), { code: 'auth.mfa_failed' });

    const { rows } = await migrate.query(
      `select reason, outcome, user_id, organisation_id from iam.credential_unwraps where mfa_factor_id = $1 order by occurred_at`, [factorId]);
    assert.ok(rows.length >= 3);
    assert.ok(rows.every((r) => r.reason === 'mfa_verify' && r.user_id === userId && r.organisation_id === orgId && r.outcome === 'ok'));
    const events = await outboxEvents(orgId);
    assert.ok(events.includes('mfa_enrolled') && events.includes('mfa_satisfied'));
  });

  test('an organisation that requires MFA sends a person without a factor to enrol', async () => {
    const mfaOrg = await createOrganisation(app, 'hooli');
    await migrate.query('update iam.organisations set mfa_required = true where id = $1', [mfaOrg]);
    await member('ivan@hooli.example', mfaOrg);
    const session = await signIn('ivan@hooli.example', PASSWORD, 'hooli');
    assert.equal(session.mfa, 'enrolment_required');
    await assert.rejects(gateway.call(verifyMfa, { body: { sessionToken: session.sessionToken, code: '123456' } }), { code: 'mfa.not_enrolled' });
  });
});

describe('password reset (spec 55.3)', () => {
  test('single use, revokes every session, and checks the new password', async () => {
    await member('judy@acme.example');
    const before = await signIn('judy@acme.example');
    await gateway.call(requestPasswordReset, { body: { organisationSlug: 'acme', email: 'nobody-here@acme.example' } });
    assert.equal(delivered.length, 0, 'nothing is sent for an unknown address, and the answer is the same');
    await gateway.call(requestPasswordReset, { body: { organisationSlug: 'acme', email: 'judy@acme.example' } });
    const { token } = delivered.at(-1)!;

    const consume = (newPassword: string) => gateway.call(resetPassword, { body: { organisationSlug: 'acme', token, newPassword } });
    await assert.rejects(consume('short'), { code: 'password.too_short' });
    await assert.rejects(consume(BREACHED), { code: 'password.breached' });
    await consume(NEW_PASSWORD);
    await assert.rejects(consume(NEW_PASSWORD), { code: 'auth.reset_invalid' }, 'single use');

    await assert.rejects(gateway.call(resolveSession, { body: { sessionToken: before.sessionToken, activity: 'http_request' } }),
      { code: 'auth.session_invalid' }, 'every earlier session is revoked');
    await assert.rejects(signIn('judy@acme.example'), { code: 'auth.login_failed' });
    assert.ok((await signIn('judy@acme.example', NEW_PASSWORD)).sessionId);
    const events = await outboxEvents(orgId);
    assert.ok(events.includes('password_reset_requested') && events.includes('password_reset_consumed'));
  });
});
