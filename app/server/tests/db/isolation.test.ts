// Tenant isolation and identity protections, exercised as the services would use
// them: each through its own login, with SET LOCAL context per transaction.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { createLocalCell, createMembership, createOrganisation, createUser } from './fixtures.helper.ts';
import { ARGON2_HASH, createHarness, inTx, uuidv7, type Harness } from './harness.helper.ts';

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let credential: pg.Client;

let orgA: string;
let orgB: string;
let userA: string;
let userB: string;
let memberA: string;
let memberB: string;

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');
  credential = await h.connect('test_credential');

  await createLocalCell(migrate);
  orgA = await createOrganisation(app, 'acme');
  orgB = await createOrganisation(app, 'globex');
  userA = await createUser(auth, 'ada@acme.example');
  userB = await createUser(auth, 'bob@globex.example');
  memberA = await createMembership(app, orgA, userA);
  memberB = await createMembership(app, orgB, userB);
});

after(async () => {
  await h?.close();
});

describe('tenant isolation', () => {
  test('a new organisation starts at policy version 1', async () => {
    const { rows } = await inTx(app, { orgId: orgA }, () =>
      app.query('select version from iam.policy_versions'));
    assert.deepEqual(rows, [{ version: '1' }]);
  });

  test('a service sees only its own organisation', async () => {
    await inTx(app, { orgId: orgA }, async () => {
      const orgs = await app.query('select id from iam.organisations');
      assert.deepEqual(orgs.rows.map((r) => r.id), [orgA]);
      const members = await app.query('select id from iam.memberships');
      assert.deepEqual(members.rows.map((r) => r.id), [memberA]);
    });
  });

  test("writing a row for another organisation is refused", async () => {
    await assert.rejects(
      inTx(app, { orgId: orgA }, () =>
        app.query(`insert into iam.scope_types (id, organisation_id, name) values ($1, $2, 'Region')`,
          [uuidv7(), orgB])),
      /row-level security/,
    );
  });

  test('a connection that never set app.org_id fails closed', async () => {
    const fresh = await h.connect('test_app');
    await assert.rejects(fresh.query('select count(*) from iam.memberships'), /app\.org_id/);
  });

  test('SET LOCAL does not carry a tenant into the next transaction on a pooled connection', async () => {
    await inTx(app, { orgId: orgA }, () => app.query('select 1'));
    await assert.rejects(app.query('select count(*) from iam.memberships'), /invalid input syntax for type uuid/);
  });

  test('a composite key stops a cross-tenant reference even when RLS is bypassed', async () => {
    const scopeType = uuidv7();
    await migrate.query(`insert into iam.scope_types (id, organisation_id, name) values ($1, $2, 'Region')`,
      [scopeType, orgA]);
    await assert.rejects(
      migrate.query(
        `insert into iam.scopes (id, organisation_id, scope_type_id, name, created_by)
         values ($1, $2, $3, 'North', $4)`,
        [uuidv7(), orgA, scopeType, memberB]),
      /foreign key/,
    );
  });

  test('the system organisation has no members', async () => {
    const systemOrg = uuidv7();
    await migrate.query(
      `insert into iam.organisations (id, name, slug, plan, cell_id, calendar_time_zone, is_system)
       values ($1, 'Silo system', 'silo-system', 'enterprise', 'uk-lon-1', 'UTC', true)`, [systemOrg]);
    await assert.rejects(createMembership(app, systemOrg, userA), /system organisation has no members/);
  });

  test('a time zone must be a real IANA zone', async () => {
    const id = uuidv7();
    await assert.rejects(
      inTx(app, { orgId: id }, () =>
        app.query(`insert into iam.organisations (id, name, slug, plan, cell_id, calendar_time_zone)
                   values ($1, 'Initech', 'initech', 'standard', 'uk-lon-1', 'Mars/Olympus')`, [id])),
      /unknown IANA time zone/,
    );
  });
});

describe('identity', () => {
  test('services cannot read user-keyed tables', async () => {
    for (const table of ['iam.users', 'iam.sessions', 'iam.password_resets', 'iam.mfa_factors', 'iam.user_identities']) {
      await assert.rejects(
        inTx(app, { orgId: orgA }, () => app.query(`select 1 from ${table} limit 1`)),
        /permission denied/, table);
    }
  });

  test('the auth service sees one user at a time, and finds a login by email', async () => {
    const own = await inTx(auth, { userId: userA }, () => auth.query('select id from iam.users'));
    assert.deepEqual(own.rows.map((r) => r.id), [userA]);

    const found = await auth.query('select id, sso_only from iam.find_user_for_login($1)', ['BOB@globex.example']);
    assert.deepEqual(found.rows, [{ id: userB, sso_only: false }]);
  });

  test('a user record cannot hold anything but an Argon2id hash', async () => {
    const id = uuidv7();
    await assert.rejects(
      inTx(auth, { userId: id }, () =>
        auth.query(`insert into iam.users (id, first_name, last_name, email, password_hash)
                    values ($1, 'Eve', 'Plain', 'eve@example.com', 'hunter2')`, [id])),
      /check constraint/,
    );
  });

  test('member profiles show the current organisation only, without credentials', async () => {
    const { rows, fields } = await inTx(app, { orgId: orgA }, () => app.query('select * from iam.member_profiles'));
    assert.deepEqual(rows.map((r) => r.membership_id), [memberA]);
    assert.ok(!fields.some((f) => /password|mfa|locked|failed/.test(f.name)));
  });

  test('a password reset is used once and revokes every session of the user', async () => {
    const sessionToken = randomBytes(32);
    const resetToken = randomBytes(32);
    const sessionId = uuidv7();
    await inTx(auth, { userId: userA }, async () => {
      await auth.query(
        `insert into iam.sessions (id, token_hash, user_id, expires_at, auth_method)
         values ($1, $2, $3, now() + interval '1 hour', 'password')`, [sessionId, sessionToken, userA]);
      await auth.query(
        `insert into iam.password_resets (id, user_id, token_hash, expires_at)
         values ($1, $2, $3, now() + interval '30 minutes')`, [uuidv7(), userA, resetToken]);
    });

    const live = await auth.query('select id from iam.resolve_session($1)', [sessionToken]);
    assert.deepEqual(live.rows.map((r) => r.id), [sessionId]);

    const first = await auth.query('select user_id, revoked_session_ids from iam.consume_password_reset($1, $2)', [resetToken, ARGON2_HASH]);
    assert.deepEqual(first.rows, [{ user_id: userA, revoked_session_ids: [sessionId] }]);

    const second = await auth.query('select * from iam.consume_password_reset($1, $2)', [resetToken, ARGON2_HASH]);
    assert.equal(second.rowCount, 0);

    const revoked = await auth.query('select id from iam.resolve_session($1)', [sessionToken]);
    assert.equal(revoked.rowCount, 0);
  });

  test('a session is reachable by its user or within its organisation, nowhere else', async () => {
    const sessionId = uuidv7();
    await inTx(auth, { userId: userA }, () =>
      auth.query(
        `insert into iam.sessions (id, token_hash, user_id, organisation_id, active_membership_id, expires_at, auth_method)
         values ($1, $2, $3, $4, $5, now() + interval '1 hour', 'password')`,
        [sessionId, randomBytes(32), userA, orgA, memberA]));

    const count = async (context: { orgId?: string; userId?: string }): Promise<number> =>
      (await inTx(auth, context, () => auth.query('select 1 from iam.sessions where id = $1', [sessionId]))).rowCount ?? 0;

    assert.equal(await count({ userId: userA }), 1);
    assert.equal(await count({ orgId: orgA }), 1);
    assert.equal(await count({ userId: userB }), 0);
    assert.equal(await count({ orgId: orgB }), 0);
  });

  test('sealed SSO metadata is readable by the credential mediator only, and one subject links one user', async () => {
    const keyVersion = uuidv7();
    await migrate.query(
      `insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at)
       values ($1, 'gcp_kms', 'projects/p/locations/europe-west2/keyRings/r/cryptoKeys/k', 1, 'active', now())`,
      [keyVersion]);

    const providerId = uuidv7();
    await inTx(credential, { orgId: orgA }, () =>
      credential.query(
        `insert into iam.identity_providers (id, organisation_id, kind, issuer, metadata_sealed, nonce, dek_wrapped, key_version_id)
         values ($1, $2, 'oidc', 'https://login.microsoftonline.com/tid/v2.0', $3, $4, $5, $6)`,
        [providerId, orgA, randomBytes(64), randomBytes(12), randomBytes(40), keyVersion]));

    const visible = await inTx(app, { orgId: orgA }, () => app.query('select issuer from iam.identity_providers'));
    assert.equal(visible.rowCount, 1);
    await assert.rejects(
      inTx(app, { orgId: orgA }, () => app.query('select metadata_sealed from iam.identity_providers')),
      /permission denied/,
    );

    const link = (userId: string) =>
      inTx(auth, { orgId: orgA }, () =>
        auth.query(
          `insert into iam.user_identities (id, organisation_id, identity_provider_id, user_id, subject, email_at_link, linked_via)
           values ($1, $2, $3, $4, 'tid:oid-123', 'ada@acme.example', 'invitation')`,
          [uuidv7(), orgA, providerId, userId]));
    await link(userA);
    await assert.rejects(link(userB), /duplicate key/);

    await assert.rejects(
      migrate.query(`update iam.kms_key_versions set status = 'retired', retired_at = now() where id = $1`, [keyVersion]),
      /still wraps live keys/,
    );
  });
});
