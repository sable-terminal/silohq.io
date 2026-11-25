// Provisioning a cell's first key version and a design partner's first organisation,
// person and membership, as the migration role, through the repos.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { provisionKey, provisionOrganisation, registerLocalCellInDirectory, registerOrganisationInDirectory } from '../../src/db/scripts/provision.script.ts';
import { verifyPassword } from '../../src/utils/password.util.ts';
import { CELL_ID, createLocalCell } from './fixtures.helper.ts';
import { createHarness, type Harness } from './harness.helper.ts';

let h: Harness;
let migrate: pg.Client;
let auth: pg.Client;
const fastEnv = { ARGON2_MEMORY_KIB: '1024', ARGON2_PASSES: '1' };
const input = {
  slug: 'wayne', name: 'Wayne Enterprises', email: 'Bruce@Wayne.example', firstName: 'Bruce', lastName: 'Wayne',
  password: 'a long enough passphrase', cellId: CELL_ID, plan: 'enterprise' as const, timeZone: 'Europe/London',
};

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  auth = await h.connect('test_auth');
  await createLocalCell(migrate);
});

after(async () => {
  await h?.close();
});

describe('provisioning', () => {
  test('registers key versions in order, each new one active', async () => {
    await withTransaction(migrate, {}, (db) => provisionKey(db, { provider: 'local', keyUri: 'local:one' }));
    await withTransaction(migrate, {}, (db) => provisionKey(db, { provider: 'local', keyUri: 'local:two' }));
    const { rows } = await migrate.query(`select version, status from iam.kms_key_versions where provider = 'local' order by version`);
    assert.deepEqual(rows, [{ version: 1, status: 'decrypt_only' }, { version: 2, status: 'active' }]);
  });

  test('creates an organisation, a person who can sign in, and an active membership', async () => {
    const created = await withTransaction(migrate, {}, (db) => provisionOrganisation(db, input, fastEnv));
    const { rows } = await auth.query('select id, password_hash, status from iam.find_user_for_login($1)', ['bruce@wayne.example']);
    assert.equal(rows[0].id, created.userId);
    assert.equal(await verifyPassword(input.password, rows[0].password_hash), true);
    const org = await auth.query('select id, status from iam.find_organisation_for_login($1)', ['wayne']);
    assert.deepEqual(org.rows, [{ id: created.organisationId, status: 'active' }]);
    const membership = await migrate.query('select status from iam.memberships where id = $1', [created.membershipId]);
    assert.equal(membership.rows[0].status, 'active');
    const superAdmin = await migrate.query('select iam.is_super_admin($1, $2) as yes', [created.organisationId, created.membershipId]);
    assert.equal(superAdmin.rows[0].yes, true, 'the first person is the super admin');
  });

  test('refuses a short password', async () => {
    await assert.rejects(withTransaction(migrate, {}, (db) => provisionOrganisation(db, { ...input, slug: 'short', email: 's@x.example', password: 'short' }, fastEnv)),
      /at least 12 characters/);
  });

  test('an organisation routes once its slug is in the directory; a slug placed elsewhere is refused', async () => {
    const directory = await h.connect('test_dir_migrate', 'directory');
    try {
      await assert.rejects(withTransaction(directory, {}, (db) => registerOrganisationInDirectory(db, 'wayne', CELL_ID)), /is not in the directory/);
      await withTransaction(directory, {}, (db) => registerLocalCellInDirectory(db, CELL_ID));
      assert.equal(await withTransaction(directory, {}, (db) => registerOrganisationInDirectory(db, 'wayne', CELL_ID)), 'registered');
      assert.equal(await withTransaction(directory, {}, (db) => registerOrganisationInDirectory(db, 'wayne', CELL_ID)), 'already');
      const { rows } = await directory.query('select cell_id, status from directory.organisation_directory where organisation_slug = $1', ['wayne']);
      assert.deepEqual(rows, [{ cell_id: CELL_ID, status: 'active' }]);
      await withTransaction(directory, {}, (db) => registerLocalCellInDirectory(db, 'eu-fra-9'));
      await assert.rejects(withTransaction(directory, {}, (db) => registerOrganisationInDirectory(db, 'wayne', 'eu-fra-9')), /already placed/);
    } finally {
      await directory.end();
    }
  });
});
