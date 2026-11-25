// The unwrap ledger's reasons (decision 2026-10-29): mfa_verify and sso_assert are
// recorded in the organisation being logged into; a TOTP code is accepted once; an
// organisation may store shorter session timeouts.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { createLocalCell, createOrganisation, createUser } from './fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from './harness.helper.ts';

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let auth2: pg.Client;
let credential: pg.Client;

let orgA: string;
let userA: string;
let keyVersion: string;
let providerId: string;
let totpFactor: string;

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');
  auth2 = await h.connect('test_auth');
  credential = await h.connect('test_credential');

  await createLocalCell(migrate);
  orgA = await createOrganisation(app, 'acme');
  userA = await createUser(auth, 'ada@acme.example');

  keyVersion = uuidv7();
  await migrate.query(
    `insert into iam.kms_key_versions (id, provider, key_uri, version, status, activated_at)
     values ($1, 'gcp_kms', 'projects/p/locations/europe-west2/keyRings/r/cryptoKeys/k', 1, 'active', now())`,
    [keyVersion]);

  providerId = uuidv7();
  await inTx(credential, { orgId: orgA }, () =>
    credential.query(
      `insert into iam.identity_providers (id, organisation_id, kind, issuer, metadata_sealed, nonce, dek_wrapped, key_version_id)
       values ($1, $2, 'saml', 'https://idp.acme.example', $3, $4, $5, $6)`,
      [providerId, orgA, randomBytes(64), randomBytes(12), randomBytes(40), keyVersion]));

  totpFactor = uuidv7();
  await inTx(auth, { userId: userA }, () =>
    auth.query(
      `insert into iam.mfa_factors (id, user_id, kind, secret_sealed, nonce, dek_wrapped, key_version_id, confirmed_at)
       values ($1, $2, 'totp', $3, $4, $5, $6, now())`,
      [totpFactor, userA, randomBytes(36), randomBytes(12), randomBytes(40), keyVersion]));
});

after(async () => {
  await h?.close();
});

interface Unwrap {
  organisationId?: string | null;
  reason: string;
  connectionCredentialId?: string;
  identityProviderId?: string;
  mfaFactorId?: string;
  userId?: string;
}

// As the credential service writes it: in the organisation's context, after the unwrap.
const recordUnwrap = (row: Unwrap) =>
  inTx(credential, { orgId: orgA }, () =>
    credential.query(
      `insert into iam.credential_unwraps (organisation_id, connection_credential_id, identity_provider_id, mfa_factor_id,
         user_id, reason, calling_service, correlation_id, key_version_id, dek_cache_hit, outcome)
       values ($1, $2, $3, $4, $5, $6, 'credential', $7, $8, false, 'ok')`,
      [row.organisationId === undefined ? orgA : row.organisationId, row.connectionCredentialId ?? null,
        row.identityProviderId ?? null, row.mfaFactorId ?? null, row.userId ?? null, row.reason, uuidv7(), keyVersion]));

describe('unwrap reasons', () => {
  test('an MFA verification names the person and the factor, in the organisation being logged into', async () => {
    await recordUnwrap({ reason: 'mfa_verify', mfaFactorId: totpFactor, userId: userA });
    await assert.rejects(recordUnwrap({ reason: 'mfa_verify', mfaFactorId: totpFactor }), /check constraint/);
    await assert.rejects(recordUnwrap({ reason: 'mfa_verify', userId: userA }), /check constraint/);
    // Refused by row-level security first; the column is also not null.
    await assert.rejects(recordUnwrap({ reason: 'mfa_verify', mfaFactorId: totpFactor, userId: userA, organisationId: null }),
      /row-level security|not-null constraint/);
    const { rows } = await migrate.query(
      `select attnotnull from pg_attribute where attrelid = 'iam.credential_unwraps'::regclass and attname = 'organisation_id'`);
    assert.equal(rows[0]!.attnotnull, true);
    await assert.rejects(recordUnwrap({ reason: 'mfa_verify', mfaFactorId: uuidv7(), userId: userA }), /foreign key/);
  });

  test('an SSO assertion names its identity provider, as idp does', async () => {
    await recordUnwrap({ reason: 'sso_assert', identityProviderId: providerId });
    await recordUnwrap({ reason: 'idp', identityProviderId: providerId });
    await assert.rejects(recordUnwrap({ reason: 'sso_assert', mfaFactorId: totpFactor, userId: userA }), /check constraint/);
  });

  test('every other reason opens a connection credential, never a factor or a provider', async () => {
    await assert.rejects(recordUnwrap({ reason: 'query', mfaFactorId: totpFactor, userId: userA }), /check constraint/);
    await assert.rejects(recordUnwrap({ reason: 'query', identityProviderId: providerId }), /check constraint/);
    await assert.rejects(recordUnwrap({ reason: 'mfa_satisfied', mfaFactorId: totpFactor, userId: userA }), /check constraint/);
  });

  test('the organisation sees its MFA and SSO unwraps', async () => {
    const { rows } = await inTx(app, { orgId: orgA }, () =>
      app.query(`select reason, count(*)::int as n from iam.credential_unwraps
                 where reason in ('mfa_verify', 'sso_assert') group by reason order by reason`));
    assert.deepEqual(rows, [{ reason: 'mfa_verify', n: 1 }, { reason: 'sso_assert', n: 1 }]);
  });
});

describe('TOTP replay', () => {
  // The auth service accepts a code only if this moves last_used_step forward.
  const accept = (client: pg.Client, step: number) =>
    client.query(
      `update iam.mfa_factors set last_used_step = $2, last_used_at = now()
       where id = $1 and (last_used_step is null or last_used_step < $2)`,
      [totpFactor, step]);

  test('a code is accepted once, and never one older than the last', async () => {
    const step = 59_000_000;
    assert.equal((await inTx(auth, { userId: userA }, () => accept(auth, step))).rowCount, 1);
    assert.equal((await inTx(auth, { userId: userA }, () => accept(auth, step))).rowCount, 0, 'replay');
    assert.equal((await inTx(auth, { userId: userA }, () => accept(auth, step - 1))).rowCount, 0, 'drift back');
    assert.equal((await inTx(auth, { userId: userA }, () => accept(auth, step + 1))).rowCount, 1);
  });

  test('two logins racing with one code: only one succeeds', async () => {
    const step = 59_000_010;
    await auth.query('begin');
    await auth.query(`select set_config('app.user_id', $1, true)`, [userA]);
    await auth2.query('begin');
    await auth2.query(`select set_config('app.user_id', $1, true)`, [userA]);
    const first = await accept(auth, step);
    const second = accept(auth2, step); // waits on the row lock
    await auth.query('commit');
    const raced = await second;
    await auth2.query('commit');
    assert.equal(first.rowCount, 1);
    assert.equal(raced.rowCount, 0);
  });

  test('only a TOTP factor has a step', async () => {
    await assert.rejects(
      inTx(auth, { userId: userA }, () =>
        auth.query(
          `insert into iam.mfa_factors (id, user_id, kind, credential_id, webauthn_public_key, sign_count, last_used_step)
           values ($1, $2, 'webauthn', $3, $4, 0, 1)`,
          [uuidv7(), userA, randomBytes(32), randomBytes(65)])),
      /check constraint/);
  });
});

describe('organisation session policy', () => {
  const setPolicy = (idle: number | null, absolute: number | null) =>
    inTx(app, { orgId: orgA }, () =>
      app.query('update iam.organisations set session_idle_minutes = $2, session_absolute_minutes = $3 where id = $1',
        [orgA, idle, absolute]));

  test('stores shorter timeouts, or none to use the cell\'s', async () => {
    await setPolicy(10, 240);
    await setPolicy(null, null);
  });

  test('refuses a zero timeout and an idle timeout longer than the absolute one', async () => {
    await assert.rejects(setPolicy(0, 240), /check constraint/);
    await assert.rejects(setPolicy(300, 240), /check constraint/);
  });
});
