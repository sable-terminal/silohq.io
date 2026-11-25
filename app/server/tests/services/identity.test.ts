// A person's own sessions and factors, and API clients, through the gateway (spec 55.4,
// 60.2, 60.4 to 60.6): credential, policy, auth and a gateway as real processes on a fresh
// cell database, driven over real HTTP.
//
// - An API client exchanges its secret for a short-lived access session and sends it as a
//   bearer token: it acts as its service principal on routes the policy service decides,
//   never on a person's routes, and a revoked client's session ends on its next request.
// - Switching membership issues a new session in the other organisation and ends the old.
// - Factors are listed and removed; the last one stays while the organisation requires MFA.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.config.ts';
import { provisionOrganisation } from '../../src/db/scripts/provision.script.ts';
import { createLogger } from '../../src/infra/logger.infra.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { runProcess, type RunningProcess } from '../../src/process.ts';
import { createAuthService } from '../../src/routes/auth/index.route.ts';
import { service as credentialService } from '../../src/routes/credential/index.route.ts';
import { createGatewayService } from '../../src/routes/gateway/index.route.ts';
import { service as policyService } from '../../src/routes/policy/index.route.ts';
import { SESSION_COOKIE } from '../../src/middleware/cookies.middleware.ts';
import { base32Decode, totpCode, totpStep } from '../../src/utils/totp.util.ts';
import { CELL_ID, createLocalCell } from '../db/fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from '../db/harness.helper.ts';
import { LOCAL } from '../infra/services.helper.ts';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://app.silo.test';
const quiet = createLogger({ service: 'test', cell: CELL_ID, release: 'test', level: 'error', write: () => undefined });

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
const processes: RunningProcess[] = [];
let base: string;
let acme: { organisationId: string; membershipId: string; userId: string };
let beta: { organisationId: string; membershipId: string };
const signupLinks: { email: string; token: string; organisationName: string }[] = [];
const txtRecords = new Map<string, string[]>();

const env = (service: string, extra: Record<string, string>): Config => loadConfig({
  SILO_ENV: 'test', SILO_SERVICE: service, SILO_CELL_ID: CELL_ID, SILO_CELL_KIND: 'commercial', SILO_RESIDENCY: 'uk', SILO_HOSTING: 'gke',
  SILO_BUILD_TARGET: 'commercial', HTTP_HOST: '127.0.0.1', HTTP_PORT: '0', HTTP_DRAIN_SECONDS: '0', ...extra,
});

interface Browser { cookie: string | undefined }
interface Reply { status: number; body: any; text: string }

async function call(who: Browser | undefined, method: string, path: string, options: { body?: unknown; bearer?: string; browser?: boolean } = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'x-forwarded-for': '198.51.100.7' };
  const browser = options.browser ?? options.bearer === undefined;
  if (method !== 'GET' && browser) {
    headers['origin'] = ORIGIN;
    headers['x-silo-csrf'] = '1';
  }
  if (method !== 'GET') headers['idempotency-key'] = `k-${uuidv7()}`;
  if (who?.cookie) headers['cookie'] = `${SESSION_COOKIE}=${who.cookie}`;
  if (options.bearer) headers['authorization'] = `Bearer ${options.bearer}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const text = await res.text();
  for (const cookie of res.headers.getSetCookie()) {
    const match = /^__Host-silo_session=([^;]*);.*Max-Age=(\d+)$/.exec(cookie);
    if (match && who) who.cookie = match[2] === '0' ? undefined : match[1];
  }
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text), text };
}

async function signIn(slug = 'acme'): Promise<Browser & { session: any }> {
  const who: Browser = { cookie: undefined };
  const reply = await call(who, 'POST', '/sessions', { body: { organisationSlug: slug, email: 'root@acme.example', password: PASSWORD } });
  assert.equal(reply.status, 201, reply.text);
  return Object.assign(who, { session: reply.body });
}

const authEvents = async (organisationId: string, event: string) => (await inTx(app, { orgId: organisationId }, () => app.query(
  `select payload from platform.outbox where organisation_id = $1 and event = 'auth_event' and payload->>'event' = $2 order by created_at, id`,
  [organisationId, event]))).rows.map((r) => r.payload);

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  await createLocalCell(migrate);
  await migrate.query(`insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at) values ($1, 'local', 'local:t', 1, 'active', now())`, [uuidv7()]);
  const fast = { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' };
  const made = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'acme', name: 'Acme', email: 'root@acme.example', firstName: 'Root', lastName: 'Admin', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, fast));
  const other = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, {
    slug: 'beta', name: 'Beta', email: 'owner@beta.example', firstName: 'Beta', lastName: 'Owner', password: PASSWORD, cellId: CELL_ID,
    plan: 'business', timeZone: 'Europe/London',
  }, fast));
  const { rows: [user] } = await migrate.query('select user_id from iam.memberships where id = $1', [made.membershipId]);
  acme = { organisationId: made.organisationId, membershipId: made.membershipId, userId: user.user_id };
  // Root belongs to Beta too.
  const membershipId = uuidv7();
  await migrate.query(`insert into iam.memberships (id, user_id, organisation_id, status, joined_at) values ($1, $2, $3, 'active', now())`,
    [membershipId, acme.userId, other.organisationId]);
  beta = { organisationId: other.organisationId, membershipId };

  const pg = (login: 'test_auth' | 'test_credential' | 'test_app') => ({ PG_CONTROL_URL: h.url(login), REDIS_SESSION_URL: `${LOCAL.redisUrl}/0` });
  const credential = await runProcess([credentialService], env('credential', {
    ...pg('test_credential'), KMS_PROVIDER: 'local', KMS_LOCAL_KEY: randomBytes(32).toString('base64'),
  }), { logger: quiet });
  const policy = await runProcess([policyService], env('policy', pg('test_app')), { logger: quiet });
  const auth = await runProcess([createAuthService({
    invitationDelivery: { async deliver() {} }, resetDelivery: { async deliver() {} },
    signupDelivery: { async deliver(signup) { signupLinks.push(signup); } },
    dns: { async txt(name) { return txtRecords.get(name) ?? []; } },
  })], env('auth', {
    ...pg('test_auth'), REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'), ...fast,
    LOGIN_ATTEMPTS_PER_ADDRESS: '1000', LOGIN_ATTEMPTS_PER_EMAIL: '1000',
    SERVICE_URL_CREDENTIAL: `http://127.0.0.1:${credential.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  }), { logger: quiet });
  processes.push(auth, policy, credential);
  let port = 0;
  const gateway = await runProcess([createGatewayService({ onListening: (p) => { port = p; } })], env('gateway', {
    REDIS_DATA_URL: `${LOCAL.redisUrl}/1`, NATS_LIVE_URL: LOCAL.natsUrl, IDENTIFIER_HASH_KEY: randomBytes(32).toString('base64'),
    GATEWAY_PUBLIC_ORIGIN: ORIGIN, GATEWAY_PUBLIC_HOST: '127.0.0.1', GATEWAY_PUBLIC_PORT: '0', TRUST_PROXY_HOPS: '1',
    SERVICE_URL_AUTH: `http://127.0.0.1:${auth.port}`, SERVICE_URL_POLICY: `http://127.0.0.1:${policy.port}`,
  }), { logger: quiet });
  processes.unshift(gateway);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const p of processes) await p.stop('test');
  await h?.close();
});

describe('API clients (spec 60.4 to 60.6)', () => {
  let clientId: string;
  let secret: string;
  let token: string;

  test('a client exchanges its secret for a short-lived access session; a wrong secret or a browser is refused', async () => {
    const root = await signIn();
    const role = await call(root, 'POST', '/admin/roles', { body: { name: 'Scope reader', permissions: ['scope.manage'] } });
    assert.equal(role.status, 201, role.text);
    const created = await call(root, 'POST', '/governance/service-principals', {
      body: { kind: 'api_client', name: 'Nightly export', expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    });
    assert.equal(created.status, 201, created.text);
    ({ id: clientId, secret } = created.body);
    const granted = await call(root, 'POST', `/governance/service-principals/${clientId}/roles`, { body: { roleId: role.body.id } });
    assert.equal(granted.status, 201, granted.text);

    const exchange = (body: object, browser = false) => call(undefined, 'POST', '/api-clients/sessions', { body, browser });
    const wrong = await exchange({ organisationId: acme.organisationId, clientId, clientSecret: `silo_api_${'A'.repeat(43)}` });
    assert.deepEqual([wrong.status, wrong.body.error.code], [401, 'auth.client_invalid']);
    const fromBrowser = await fetch(`${base}/api/v1/api-clients/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify({ organisationId: acme.organisationId, clientId, clientSecret: secret }),
    });
    assert.equal(fromBrowser.status, 403, 'the exchange is for a client\'s server, never a page');
    const issued = await exchange({ organisationId: acme.organisationId, clientId, clientSecret: secret });
    assert.equal(issued.status, 201, issued.text);
    assert.equal(issued.body.tokenType, 'Bearer');
    assert.ok(Date.parse(issued.body.expiresAt) - Date.now() <= 15 * 60_000 + 5_000, 'short-lived');
    token = issued.body.accessToken;
    assert.equal((await authEvents(acme.organisationId, 'session_issued')).length, 1);
  });

  test('the bearer acts as the principal on a route the policy decides, never on a person\'s routes', async () => {
    const scopes = await call(undefined, 'GET', '/admin/scopes', { bearer: token });
    assert.equal(scopes.status, 200, scopes.text);
    const roles = await call(undefined, 'GET', '/admin/roles', { bearer: token });
    assert.deepEqual([roles.status, roles.body.error.code], [403, 'gateway.not_permitted'], 'only what its roles give');
    for (const path of ['/session', '/allowance']) {
      const refused = await call(undefined, 'GET', path, { bearer: token });
      assert.deepEqual([refused.status, refused.body.error.code], [403, 'gateway.member_required'], path);
    }
    const forged = await call(undefined, 'GET', '/admin/scopes', { bearer: `silo_ses_${'B'.repeat(86)}` });
    assert.equal(forged.status, 401);
  });

  test('while its organisation moves cell (6.4) the client\'s writes are refused, as a person\'s are; its reads go on', async () => {
    const destination = `uk-lon-${uuidv7().slice(-6)}`;
    await migrate.query(`insert into platform.cells (id, kind, residency, location, hosting, hostname, is_local, status, placement_open)
      values ($1, 'commercial', 'uk', 'London', 'gke', $2, false, 'active', true)`, [destination, `${destination}.silohq.io`]);
    const operator = uuidv7();
    await migrate.query(`insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident, sovereign_access_listed, status)
      values ($1, $2, 'Ops', 'sc', true, false, 'active')`, [operator, `ops-${operator}`]);
    const migration = uuidv7();
    await migrate.query(`insert into platform.tenant_migrations (id, organisation_id, source_cell_id, destination_cell_id, reason, status,
        requested_by_operator_id, notice_given_at, window_starts_at, window_ends_at, read_only_at, destination_key_id, destination_import_key)
      values ($1, $2, $3, $4, 'rebalancing', 'read_only', $5, now() - interval '31 days', now() - interval '1 minute', now() + interval '3 hours',
        now(), repeat('a', 64), 'key')`, [migration, acme.organisationId, CELL_ID, destination, operator]);
    try {
      const refused = await call(undefined, 'POST', '/admin/scopes', { bearer: token, body: { name: 'Moved', typeId: uuidv7() } });
      assert.deepEqual([refused.status, refused.body.error.code], [409, 'tenant_migrations.writes_paused'], refused.text);
      assert.equal((await call(undefined, 'GET', '/admin/scopes', { bearer: token })).status, 200);
    } finally {
      await migrate.query(`update platform.tenant_migrations set status = 'aborted', aborted_at = now() where id = $1`, [migration]);
    }
  });

  test('a revoked client\'s session ends on its next request', async () => {
    const root = await signIn();
    const revoked = await call(root, 'POST', `/governance/service-principals/${clientId}/revoke`, { body: {} });
    assert.equal(revoked.status, 200, revoked.text);
    const after = await call(undefined, 'GET', '/admin/scopes', { bearer: token });
    assert.deepEqual([after.status, after.body.error.code], [401, 'auth.session_invalid']);
  });
});

describe('switching membership (spec 60.2)', () => {
  test('memberships are listed; switching issues a new session in the other organisation and ends the old one', async () => {
    const root = await signIn();
    const listed = await call(root, 'GET', '/session/memberships');
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body.memberships.map((m: any) => [m.organisationSlug, m.current]).sort(), [['acme', true], ['beta', false]]);
    const before = root.cookie;
    const switched = await call(root, 'POST', '/session/membership', { body: { organisationId: beta.organisationId } });
    assert.equal(switched.status, 201, switched.text);
    assert.deepEqual([switched.body.organisationId, switched.body.membershipId], [beta.organisationId, beta.membershipId]);
    assert.notEqual(root.cookie, before, 'a new session, never the old one changed');
    const current = await call(root, 'GET', '/session');
    assert.equal(current.body.organisationId, beta.organisationId);
    const old = await call({ cookie: before }, 'GET', '/session');
    assert.equal(old.status, 401, 'the session it replaced has ended');
    assert.deepEqual((await authEvents(beta.organisationId, 'membership_switched')).map((e) => e.detail.direction), ['in']);
    assert.deepEqual((await authEvents(acme.organisationId, 'membership_switched')).map((e) => e.detail.direction), ['out']);
    const same = await call(root, 'POST', '/session/membership', { body: { organisationId: beta.organisationId } });
    assert.equal(same.body.error.code, 'auth.switch_same');
    const nowhere = await call(root, 'POST', '/session/membership', { body: { organisationId: uuidv7() } });
    assert.equal(nowhere.body.error.code, 'auth.membership_not_found');
  });
});

describe('self-serve sign-up (decision 2026-11-14)', () => {
  const start = (email: string, organisationSlug: string) => call(undefined, 'POST', '/signups', {
    body: { email, organisationName: 'Newco Ltd', organisationSlug, plan: 'standard', term: 'monthly', seats: 3 },
  });
  const linkFor = (email: string) => [...signupLinks].reverse().find((s) => s.email === email)!.token;

  test('a taken slug is refused; otherwise a one-time link goes to the address', async () => {
    const taken = await start('founder@newco.example', 'acme');
    assert.deepEqual([taken.status, taken.body.error.code], [409, 'signup.slug_taken']);
    const started = await start('Founder@Newco.example', 'newco');
    assert.equal(started.status, 202, started.text);
    assert.match(linkFor('founder@newco.example'), /^silo_sup_/);
  });

  test('the link creates the organisation with its founder as super admin, signed in', async () => {
    const who: Browser = { cookie: undefined };
    const bad = await call(who, 'POST', '/signups/complete', { body: { token: `silo_sup_${'A'.repeat(43)}`, password: PASSWORD, firstName: 'F', lastName: 'L' } });
    assert.deepEqual([bad.status, bad.body.error.code], [401, 'signup.invalid']);
    const token = linkFor('founder@newco.example');
    const done = await call(who, 'POST', '/signups/complete', { body: { token, password: PASSWORD, firstName: 'Fay', lastName: 'Founder' } });
    assert.equal(done.status, 201, done.text);
    assert.equal(done.body.checkoutUrl, null, 'no billing service here: billing starts the checkout again');
    assert.ok(who.cookie, 'signed in');
    const session = await call(who, 'GET', '/session');
    assert.equal(session.status, 200, session.text);
    const { rows: [org] } = await migrate.query(`select id, plan, name from iam.organisations where slug = 'newco'`);
    assert.deepEqual([org.plan, org.name], ['standard', 'Newco Ltd']);
    const { rows: roles } = await migrate.query(
      `select r.name, u.email_verified_at is not null as verified from iam.role_assignments a join iam.roles r on r.id = a.role_id
         join iam.memberships m on m.id = a.membership_id join iam.users u on u.id = m.user_id where a.organisation_id = $1`, [org.id]);
    assert.deepEqual(roles, [{ name: 'Super admin', verified: true }]);
    assert.equal((await authEvents(org.id, 'organisation_signed_up')).length, 1);
    const { rows: placed } = await migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'tenant_placed'`, [org.id]);
    assert.deepEqual(placed.map((r) => [r.detail.route, r.detail.plan]), [['signup', 'standard']], 'placed in this cell, in its own log');
    const again = await call(undefined, 'POST', '/signups/complete', { body: { token, password: PASSWORD, firstName: 'F', lastName: 'L' } });
    assert.deepEqual([again.status, again.body.error.code], [401, 'signup.invalid'], 'the link works once');
  });

  test('an address that has an account proves it with its current password', async () => {
    assert.equal((await start('root@acme.example', 'rootco')).status, 202);
    const token = linkFor('root@acme.example');
    const wrong = await call(undefined, 'POST', '/signups/complete', { body: { token, password: 'not the password at all' } });
    assert.deepEqual([wrong.status, wrong.body.error.code], [401, 'auth.login_failed']);
    const done = await call({ cookie: undefined }, 'POST', '/signups/complete', { body: { token, password: PASSWORD } });
    assert.equal(done.status, 201, done.text);
    const { rows } = await migrate.query(
      `select count(*)::int as n from iam.memberships m join iam.organisations o on o.id = m.organisation_id where m.user_id = $1 and o.slug = 'rootco'`, [acme.userId]);
    assert.equal(rows[0].n, 1);
  });
});

describe('email domains (decision 2026-11-14)', () => {
  test('verified through DNS, a domain is claimed: no separate sign-up at it, no second claim', async () => {
    const root = await signIn();
    const added = await call(root, 'POST', '/domains', { body: { domain: 'Acme.Example' } });
    assert.equal(added.status, 201, added.text);
    assert.deepEqual([added.body.domain, added.body.status, added.body.txtName], ['acme.example', 'pending', '_silo-verification.acme.example']);
    const early = await call(root, 'POST', `/domains/${added.body.id}/verification`, {});
    assert.deepEqual([early.status, early.body.error.code], [409, 'domain.not_verified']);
    txtRecords.set('_silo-verification.acme.example', ['v=spf1 -all', added.body.txtValue]);
    const verified = await call(root, 'POST', `/domains/${added.body.id}/verification`, {});
    assert.deepEqual([verified.status, verified.body.status], [200, 'verified']);
    assert.equal((await authEvents(acme.organisationId, 'domain_verified')).length, 1);

    const blocked = await call(undefined, 'POST', '/signups', {
      body: { email: 'someone@acme.example', organisationName: 'Shadow', organisationSlug: 'shadow-acme', plan: 'standard', term: 'monthly', seats: 1 },
    });
    assert.deepEqual([blocked.status, blocked.body.error.code], [409, 'signup.domain_claimed']);

    // Beta's own super admin cannot claim the same domain.
    const inBeta: Browser = { cookie: undefined };
    const signedIn = await call(inBeta, 'POST', '/sessions', { body: { organisationSlug: 'beta', email: 'owner@beta.example', password: PASSWORD } });
    assert.equal(signedIn.status, 201, signedIn.text);
    const other = await call(inBeta, 'POST', '/domains', { body: { domain: 'acme.example' } });
    assert.equal(other.status, 201, other.text);
    txtRecords.set('_silo-verification.acme.example', [added.body.txtValue, other.body.txtValue]);
    const second = await call(inBeta, 'POST', `/domains/${other.body.id}/verification`, {});
    assert.deepEqual([second.status, second.body.error.code], [409, 'domain.claimed_elsewhere']);

    assert.equal((await call(root, 'DELETE', `/domains/${added.body.id}`, {})).status, 204);
    const open = await call(undefined, 'POST', '/signups', {
      body: { email: 'someone@acme.example', organisationName: 'Shadow', organisationSlug: 'shadow-acme', plan: 'standard', term: 'monthly', seats: 1 },
    });
    assert.equal(open.status, 202, 'the claim ended with the domain');
  });
});

describe('unlinking an identity (decision 2026-11-14)', () => {
  test('refused while SSO is enforced and as the last way in; otherwise unlinked and audited', async () => {
    const credential = await h.connect('test_credential');
    const auth = await h.connect('test_auth');
    const kv = (await migrate.query(`select id from iam.kms_key_versions where status = 'active' limit 1`)).rows[0]!.id as string;
    const providers = [uuidv7(), uuidv7()];
    const identities = [uuidv7(), uuidv7()];
    try {
      for (const [i, providerId] of providers.entries()) {
        await inTx(credential, { orgId: acme.organisationId }, () => credential.query(
          `insert into iam.identity_providers (id, organisation_id, kind, issuer, metadata_sealed, nonce, dek_wrapped, key_version_id)
           values ($1, $2, 'oidc', $3, $4, $5, $6, $7)`,
          [providerId, acme.organisationId, `https://idp${i}.example`, randomBytes(64), randomBytes(12), randomBytes(40), kv]));
        await inTx(auth, { orgId: acme.organisationId }, () => auth.query(
          `insert into iam.user_identities (id, organisation_id, identity_provider_id, user_id, subject, email_at_link, linked_via)
           values ($1, $2, $3, $4, $5, 'root@acme.example', 'invitation')`, [identities[i], acme.organisationId, providerId, acme.userId, `sub-${i}`]));
      }
    } finally {
      await credential.end();
      await auth.end();
    }
    const root = await signIn();
    const listed = await call(root, 'GET', '/identities');
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body.identities.map((i: any) => i.id).sort(), [...identities].sort());
    assert.equal(listed.body.password, true);

    await inTx(app, { orgId: acme.organisationId }, () => app.query('update iam.organisations set sso_required = true where id = $1', [acme.organisationId]));
    const enforced = await call(root, 'POST', `/identities/${identities[0]}/unlinking`, {});
    assert.deepEqual([enforced.status, enforced.body.error.code], [409, 'identity.sso_enforced']);
    await inTx(app, { orgId: acme.organisationId }, () => app.query('update iam.organisations set sso_required = false where id = $1', [acme.organisationId]));

    const first = await call(root, 'POST', `/identities/${identities[0]}/unlinking`, {});
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.body.identities.map((i: any) => i.id), [identities[1]]);
    // With no password, the remaining identity is the only way in.
    const hash = (await migrate.query('select password_hash from iam.users where id = $1', [acme.userId])).rows[0]!.password_hash as string;
    await migrate.query(`update iam.users set password_hash = null, sso_only = true where id = $1`, [acme.userId]);
    try {
      const last = await call(root, 'POST', `/identities/${identities[1]}/unlinking`, {});
      assert.deepEqual([last.status, last.body.error.code], [409, 'identity.last_method']);
    } finally {
      await migrate.query(`update iam.users set password_hash = $2, sso_only = false where id = $1`, [acme.userId, hash]);
    }
    const again = await call(root, 'POST', `/identities/${identities[0]}/unlinking`, {});
    assert.deepEqual([again.status, again.body.error.code], [404, 'identity.not_found']);
    const events = await authEvents(acme.organisationId, 'identity_unlinked');
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].detail.provider_kind, events[0].detail.remaining], ['oidc', 1]);
  });
});

describe('MFA factors (spec 55.4)', () => {
  test('factors are listed without secrets; the last one stays while the organisation requires MFA; another can go', async () => {
    const root = await signIn();
    const enrol = async () => {
      const started = await call(root, 'POST', '/mfa/totp', {});
      assert.equal(started.status, 201, started.text);
      const secret = base32Decode(new URL(started.body.otpauthUri).searchParams.get('secret')!);
      const code = totpCode(secret, totpStep(Date.now()));
      const confirmed = await call(root, 'POST', '/mfa/totp/confirm', { body: { factorId: started.body.factorId, code } });
      assert.equal(confirmed.status, 200, confirmed.text);
      return started.body.factorId as string;
    };
    const first = await enrol();
    const listed = await call(root, 'GET', '/mfa/factors');
    assert.deepEqual(listed.body.factors.map((f: any) => [f.id, f.kind, f.confirmedAt !== null]), [[first, 'totp', true]]);
    assert.ok(!('secretSealed' in listed.body.factors[0]));
    await inTx(app, { orgId: acme.organisationId }, () => app.query('update iam.organisations set mfa_required = true where id = $1', [acme.organisationId]));
    const kept = await call(root, 'POST', `/mfa/factors/${first}/removal`, {});
    assert.deepEqual([kept.status, kept.body.error.code], [409, 'mfa.last_factor']);
    const second = await enrol();
    const removed = await call(root, 'POST', `/mfa/factors/${first}/removal`, {});
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual(removed.body.factors.map((f: any) => f.id), [second]);
    assert.equal((await authEvents(acme.organisationId, 'mfa_factor_removed')).length, 1);
  });
});
