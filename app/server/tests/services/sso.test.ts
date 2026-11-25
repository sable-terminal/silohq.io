// OIDC sign-in end to end (spec 55.5; review D1): configuring a provider (its secret sealed
// in the credential service), the browser flow through the gateway, the links a sign-in
// may make (just in time, an invitation, the signed-in person's own account) and the ones
// it never makes (an existing person matched by address), and what the flow refuses.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { issueToken } from '../../src/utils/token.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import {
  browser, call, oidcSignIn, signIn, startCell, startFakeOidc, storeProvider, type Browser, type Cell, type FakeOidc,
} from './sso.helper.ts';

const CLIENT_ID = 'silo-test';
const CLIENT_SECRET = 'shh-a-client-secret-of-some-length';
let cell: Cell;
let idp: FakeOidc;
let other: FakeOidc;
let root: Browser;
/** Configured through the gateway, as a super admin would. */
const managed = uuidv7();
/** The sign-in tests' provider, set up straight through the credential service. */
const provider = uuidv7();
let providerVersion = 1;

// Entra-style: the subject is tid:oid; the claims are the fake provider's next login.
const person = (oid: string, email: string, extra: Record<string, unknown> = {}) => ({
  claims: { sub: `pairwise-${oid}`, tid: 'tenant-1', oid, email, email_verified: true, given_name: 'Ada', family_name: 'Byron', ...extra },
});

const flowSettings = (extra: Record<string, unknown> = {}) => ({ clientId: CLIENT_ID, subjectClaims: ['tid', 'oid'], ...extra });

async function reconfigure(changes: { active?: boolean; settings?: Record<string, unknown> }): Promise<void> {
  providerVersion = await storeProvider(cell, provider, {
    issuer: idp.issuer, jitProvisioning: true, defaultRoleId: cell.roles['Member']!, defaultScopeId: null, active: changes.active ?? true,
    expectedVersion: providerVersion, configuredBy: cell.rootMembership,
    config: { kind: 'oidc', settings: flowSettings(changes.settings) as never },
  });
}

/** An open invitation, as auth would store it; the token as the email would carry it. */
async function invite(email: string, role: string): Promise<string> {
  const { token, hash } = issueToken('invitation');
  await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
    `insert into iam.invitations (id, organisation_id, email, token_hash, role_id, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + interval '1 day')`, [uuidv7(), cell.org, email, hash, cell.roles[role], cell.rootMembership]));
  return token;
}

before(async () => {
  cell = await startCell();
  idp = await startFakeOidc(CLIENT_ID, CLIENT_SECRET);
  other = await startFakeOidc('managed-client', 'managed-secret-value');
  root = await signIn(cell.gateway, 'root@acme.example');
  providerVersion = await storeProvider(cell, provider, {
    issuer: idp.issuer, jitProvisioning: true, defaultRoleId: cell.roles['Member']!, defaultScopeId: null, active: true,
    expectedVersion: null, configuredBy: cell.rootMembership,
    config: { kind: 'oidc', settings: flowSettings() as never, clientSecret: CLIENT_SECRET },
  });
});

after(async () => {
  await idp?.close();
  await other?.close();
  await cell?.close();
});

const count = async (sql: string, params: unknown[]): Promise<number> =>
  Number((await cell.migrate.query(sql, params)).rows[0].n);

describe('configuring a provider (org.sso.manage)', () => {
  const configure = (body: Record<string, unknown>, who = root) => call(cell.gateway, who, 'PUT', `/identity-providers/${managed}`, body);

  test('a super admin configures one; the secret is sealed and never read back', async () => {
    const reply = await configure({
      expectedVersion: null, active: true, jitProvisioning: false,
      config: { kind: 'oidc', issuer: other.issuer, settings: { clientId: 'managed-client' }, clientSecret: 'managed-secret-value' },
    });
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.body.config.kind, 'oidc');
    assert.equal(reply.body.config.hasClientSecret, true);
    assert.equal(reply.text.includes('managed-secret-value'), false);
    assert.equal(reply.body.configuredBy, cell.rootMembership);

    const { rows } = await cell.migrate.query('select metadata_sealed, issuer from iam.identity_providers where id = $1', [managed]);
    assert.equal(rows[0].issuer, other.issuer);
    assert.equal((rows[0].metadata_sealed as Buffer).includes(Buffer.from('managed-secret-value')), false, 'ciphertext only');
    assert.ok(await count(`select count(*) as n from iam.credential_unwraps where identity_provider_id = $1 and reason = 'idp'`, [managed]) >= 1);
    assert.equal(await count(`select count(*) as n from platform.outbox where organisation_id = $1 and payload->>'event' = 'provider_configured'`, [cell.org]), 1);
    const listed = await call(cell.gateway, root, 'GET', '/identity-providers');
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body.providers.map((p: { providerId: string }) => p.providerId).sort(), [managed, provider].sort());
  });

  test('a new version keeps the stored secret when none is sent; a stale version is refused; the issuer is unique', async () => {
    const current = await call(cell.gateway, root, 'GET', `/identity-providers/${managed}`);
    assert.equal(current.status, 200, current.text);
    const reply = await configure({
      expectedVersion: current.body.version, active: true,
      config: { kind: 'oidc', issuer: other.issuer, settings: { ...current.body.config.settings, scopes: ['openid', 'email'] } },
    });
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.body.config.hasClientSecret, true);
    assert.equal(reply.body.version, current.body.version + 1);
    const stale = await configure({ expectedVersion: current.body.version, active: true, config: { kind: 'oidc', issuer: other.issuer, settings: { clientId: 'x' } } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'sso.provider_stale');
    const taken = await call(cell.gateway, root, 'PUT', `/identity-providers/${uuidv7()}`, {
      expectedVersion: null, active: true, config: { kind: 'oidc', issuer: idp.issuer, settings: { clientId: 'x' }, clientSecret: 'y' },
    });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'sso.issuer_taken');
  });

  test('a member without org.sso.manage is refused; the sign-in page sees only active providers', async () => {
    const token = await invite('plain@acme.example', 'Member');
    const member = browser();
    const accepted = await call(cell.gateway, member, 'POST', '/invitations/accept', {
      organisationSlug: 'acme', token, password: 'correct horse battery staple', firstName: 'Plain', lastName: 'Member',
    });
    assert.equal(accepted.status, 201, accepted.text);
    const refused = await configure({ expectedVersion: 2, active: true, config: { kind: 'oidc', issuer: other.issuer, settings: { clientId: 'x' } } }, member);
    assert.equal(refused.status, 403);
    assert.equal((await call(cell.gateway, member, 'GET', '/identity-providers')).status, 403);
    const options = await call(cell.gateway, undefined, 'GET', '/sso/options?organisationSlug=acme');
    assert.equal(options.body.ssoRequired, false);
    assert.ok(options.body.providers.some((p: { providerId: string }) => p.providerId === provider));
  });
});

describe('signing in by OIDC', () => {
  test('just in time: a new person joins with the default role only, linked by subject', async () => {
    idp.next = person('oid-jit', 'new.person@acme.example');
    const { who, reply } = await oidcSignIn(cell.gateway, provider);
    assert.equal(reply.status, 201, reply.text);
    assert.equal(reply.body.authMethod, 'sso');
    assert.equal(reply.body.mfa, 'not_required');
    assert.ok(who.cookie, 'the session cookie is set');
    const me = await call(cell.gateway, who, 'GET', '/session');
    assert.equal(me.body.userId, reply.body.userId);
    assert.equal(me.body.authMethod, 'sso');

    const { rows } = await cell.migrate.query(
      `select u.sso_only, u.password_hash, i.subject, i.linked_via, r.name as role, s.auth_method
         from iam.users u join iam.user_identities i on i.user_id = u.id
         join iam.role_assignments a on a.membership_id = $2 join iam.roles r on r.id = a.role_id
         join iam.sessions s on s.id = $3
        where u.id = $1`, [reply.body.userId, reply.body.membershipId, reply.body.sessionId]);
    assert.deepEqual(rows, [{ sso_only: true, password_hash: null, subject: 'tenant-1:oid-jit', linked_via: 'jit', role: 'Member', auth_method: 'sso' }]);
    // The token exchange used the sealed secret (basic) and a PKCE verifier only this browser could derive.
    const last = idp.tokenRequests.at(-1)!;
    assert.match(last.body.get('code_verifier')!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(last.body.get('client_secret'), null);

    // Again: the link names the person; nothing new is created.
    const again = await oidcSignIn(cell.gateway, provider);
    assert.equal(again.reply.status, 201, again.reply.text);
    assert.equal(again.reply.body.userId, reply.body.userId);
    assert.equal(await count('select count(*) as n from iam.user_identities where user_id = $1', [reply.body.userId]), 1);
    assert.equal(await count(`select count(*) as n from platform.outbox where organisation_id = $1 and payload->>'event' = 'member_joined'
      and payload->'detail'->>'method' = 'sso_jit'`, [cell.org]), 1);
  });

  test('never by address: an existing person\'s address from the provider does not sign in as them', async () => {
    idp.next = person('oid-attacker', 'root@acme.example');
    const { reply } = await oidcSignIn(cell.gateway, provider);
    assert.equal(reply.status, 403, reply.text);
    assert.equal(reply.body.error.code, 'sso.link_required');
    assert.equal(await count(`select count(*) as n from iam.user_identities where subject = 'tenant-1:oid-attacker'`, []), 0);
  });

  test('the signed-in person links their own account, then signs in by it; an identity linked elsewhere is refused', async () => {
    idp.next = person('oid-root', 'someone.else@other.example');
    const linked = await oidcSignIn(cell.gateway, provider, { who: root, link: true });
    assert.equal(linked.reply.status, 201, linked.reply.text);
    const { rows } = await cell.migrate.query(
      `select i.linked_via, i.email_at_link from iam.user_identities i join iam.memberships m on m.user_id = i.user_id where m.id = $1`,
      [cell.rootMembership]);
    assert.deepEqual(rows, [{ linked_via: 'existing_session', email_at_link: 'someone.else@other.example' }]);
    idp.next = person('oid-root', 'whatever@other.example');
    const by = await oidcSignIn(cell.gateway, provider);
    assert.equal(by.reply.status, 201, by.reply.text);
    assert.equal(by.reply.body.membershipId, cell.rootMembership);

    idp.next = person('oid-jit', 'new.person@acme.example');
    const elsewhere = await oidcSignIn(cell.gateway, provider, { who: root, link: true });
    assert.equal(elsewhere.reply.status, 409, elsewhere.reply.text);
    assert.equal(elsewhere.reply.body.error.code, 'sso.identity_linked_elsewhere');
  });

  test('linking needs a signed-in person', async () => {
    const reply = await call(cell.gateway, browser(), 'POST', '/sso/link', { providerId: provider });
    assert.equal(reply.status, 401);
  });

  test('accepting an invitation by SSO: the provider\'s verified address must be the invited one', async () => {
    const token = await invite('invitee@acme.example', 'Billing');
    idp.next = person('oid-invitee', 'mallory@acme.example');
    const mismatch = await oidcSignIn(cell.gateway, provider, { invitationToken: token });
    assert.equal(mismatch.reply.status, 403, mismatch.reply.text);
    assert.equal(mismatch.reply.body.error.code, 'sso.invitation_address_mismatch');
    idp.next = person('oid-invitee', 'INVITEE@acme.example');
    const accepted = await oidcSignIn(cell.gateway, provider, { invitationToken: token });
    assert.equal(accepted.reply.status, 201, accepted.reply.text);
    const { rows } = await cell.migrate.query(
      `select i.linked_via, r.name as role, inv.accepted_at is not null as accepted, u.sso_only
         from iam.user_identities i join iam.users u on u.id = i.user_id
         join iam.role_assignments a on a.membership_id = $2 join iam.roles r on r.id = a.role_id
         join iam.invitations inv on inv.accepted_membership_id = $2
        where i.user_id = $1`, [accepted.reply.body.userId, accepted.reply.body.membershipId]);
    assert.deepEqual(rows, [{ linked_via: 'invitation', role: 'Billing', accepted: true, sso_only: true }]);
    const used = await oidcSignIn(cell.gateway, provider, { invitationToken: token });
    assert.equal(used.reply.status, 401, 'an accepted invitation starts nothing');
  });

  test('a provider\'s MFA satisfies the organisation\'s rule only when the configuration trusts it', async () => {
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('update iam.organisations set mfa_required = true where id = $1', [cell.org]));
    try {
      idp.next = person('oid-mfa', 'mfa.person@acme.example', { amr: ['pwd', 'mfa'] });
      const untrusted = await oidcSignIn(cell.gateway, provider);
      assert.equal(untrusted.reply.status, 201, untrusted.reply.text);
      assert.equal(untrusted.reply.body.mfa, 'enrolment_required');

      await reconfigure({ settings: { trustProviderMfa: true } });
      idp.next = person('oid-mfa', 'mfa.person@acme.example', { amr: ['pwd', 'mfa'] });
      const satisfied = await oidcSignIn(cell.gateway, provider);
      assert.equal(satisfied.reply.status, 201, satisfied.reply.text);
      assert.equal(satisfied.reply.body.mfa, 'satisfied');
      const me = await call(cell.gateway, satisfied.who, 'GET', '/session');
      assert.equal(me.body.mfa, 'satisfied');
      const { rows } = await cell.migrate.query('select mfa_satisfied_at is not null as satisfied from iam.sessions where id = $1', [satisfied.reply.body.sessionId]);
      assert.equal(rows[0].satisfied, true, 'the row agrees, so a rebuilt hot copy does too');

      idp.next = person('oid-mfa', 'mfa.person@acme.example', { amr: ['pwd'] });
      const without = await oidcSignIn(cell.gateway, provider);
      assert.equal(without.reply.body.mfa, 'enrolment_required', 'no MFA in the amr, no MFA');
    } finally {
      await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('update iam.organisations set mfa_required = false where id = $1', [cell.org]));
      await reconfigure({});
    }
  });

  test('sso_required: password sign-in is refused, SSO is not', async () => {
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('update iam.organisations set sso_required = true where id = $1', [cell.org]));
    try {
      const password = await call(cell.gateway, browser(), 'POST', '/sessions', {
        organisationSlug: 'acme', email: 'root@acme.example', password: 'correct horse battery staple',
      });
      assert.equal(password.status, 403);
      assert.equal(password.body.error.code, 'auth.sso_required');
      const options = await call(cell.gateway, undefined, 'GET', '/sso/options?organisationSlug=acme');
      assert.equal(options.body.ssoRequired, true);
      idp.next = person('oid-root', 'whatever@other.example');
      const sso = await oidcSignIn(cell.gateway, provider);
      assert.equal(sso.reply.status, 201, sso.reply.text);
    } finally {
      await inTx(cell.app, { orgId: cell.org }, () => cell.app.query('update iam.organisations set sso_required = false where id = $1', [cell.org]));
    }
  });
});

describe('what the flow refuses', () => {
  test('another browser cannot finish the flow, and the flow is used once', async () => {
    idp.next = person('oid-jit', 'new.person@acme.example');
    const stolen = await oidcSignIn(cell.gateway, provider, { tamperBinding: true });
    assert.equal(stolen.reply.status, 401);
    assert.equal(stolen.reply.body.error.code, 'sso.flow_invalid');

    const who = browser();
    const started = await call(cell.gateway, who, 'POST', '/sso/start', { organisationSlug: 'acme', providerId: provider });
    const location = new URL((await fetch(started.body.redirectUrl, { redirect: 'manual' })).headers.get('location')!);
    const body = { callbackQuery: location.search.slice(1), binding: started.body.binding };
    assert.equal((await call(cell.gateway, who, 'POST', '/sso/oidc/complete', body)).status, 201);
    const replay = await call(cell.gateway, browser(), 'POST', '/sso/oidc/complete', body);
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'sso.flow_invalid');
  });

  test('a state the flow did not issue is refused', async () => {
    idp.next = { ...person('oid-jit', 'new.person@acme.example'), state: `${cell.org}.${'A'.repeat(43)}` };
    const { reply } = await oidcSignIn(cell.gateway, provider);
    assert.equal(reply.status, 401);
    assert.equal(reply.body.error.code, 'sso.flow_invalid');
  });

  test('an ID token the provider did not sign is refused by the library', async () => {
    idp.next = person('oid-jit', 'new.person@acme.example');
    idp.rogueKey = true;
    try {
      const { reply } = await oidcSignIn(cell.gateway, provider);
      assert.equal(reply.status, 401, reply.text);
      assert.equal(reply.body.error.code, 'sso.assertion_invalid');
    } finally {
      idp.rogueKey = false;
    }
    assert.ok(await count(`select count(*) as n from iam.credential_unwraps where identity_provider_id = $1 and reason = 'sso_assert'`, [provider]) >= 1);
  });

  test('the provider refusing the person ends the flow; an unverified address cannot join just in time', async () => {
    idp.next = { claims: {}, error: 'access_denied' };
    const refused = await oidcSignIn(cell.gateway, provider);
    assert.equal(refused.reply.status, 401, refused.reply.text);
    assert.equal(refused.reply.body.error.code, 'sso.provider_refused');

    idp.next = person('oid-unverified', 'unverified@acme.example', { email_verified: false });
    const unverified = await oidcSignIn(cell.gateway, provider);
    assert.equal(unverified.reply.status, 403, unverified.reply.text);
    assert.equal(unverified.reply.body.error.code, 'sso.email_unverified');
  });

  test('an inactive provider starts nothing', async () => {
    await reconfigure({ active: false });
    try {
      const started = await call(cell.gateway, browser(), 'POST', '/sso/start', { organisationSlug: 'acme', providerId: provider });
      assert.equal(started.status, 404);
      const options = await call(cell.gateway, undefined, 'GET', '/sso/options?organisationSlug=acme');
      assert.equal(options.body.providers.some((p: { providerId: string }) => p.providerId === provider), false);
    } finally {
      await reconfigure({});
    }
  });
});
