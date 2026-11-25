// The models match the migrated schema, every table has a repo, and the repos work
// against a real database: under row-level security, as the service roles, with jsonb,
// arrays and the type parsers the models describe.

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { generate, modelFilesOnDisk, schemaFilesOnDisk, SERVER_ROOT } from '../../src/db/scripts/generateModels.script.ts';
import { withTransaction } from '../../src/infra/postgres.infra.ts';
import { authEventRepo } from '../../src/repos/audit/index.repo.ts';
import { organisationRepo } from '../../src/repos/iam/index.repo.ts';
import { lensRepo } from '../../src/repos/recognition/index.repo.ts';
import { CELL_ID, createLocalCell, createMembership, createOrganisation, createUser } from './fixtures.helper.ts';
import { createHarness, uuidv7, type Harness } from './harness.helper.ts';

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let audit: pg.Client;

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');
  audit = await h.connect('test_audit');
  await createLocalCell(migrate);
});

after(async () => {
  await h?.close();
});

describe('generated models', () => {
  test('models and schemas match the migrated schema: regenerate with npm run db:models after changing a migration', async () => {
    const generated = await generate(migrate, await h.connect('test_dir_migrate', 'directory'));
    const files = [...generated.models, ...generated.schemas, ...generated.indexes];
    const stale: string[] = [];
    for (const file of files) {
      const onDisk = await readFile(path.join(SERVER_ROOT, file.path), 'utf8').catch(() => null);
      if (onDisk !== file.content) stale.push(file.path);
    }
    const expected = new Set(files.map((m) => m.path));
    const orphaned = [...await modelFilesOnDisk(), ...await schemaFilesOnDisk()].filter((f) => !expected.has(f));
    assert.deepEqual({ stale, orphaned }, { stale: [], orphaned: [] });
  });

  test('every table a service reads has a repo', async () => {
    const generated = await generate(migrate, await h.connect('test_dir_migrate', 'directory'));
    const missing: string[] = [];
    for (const repo of generated.repos) {
      await access(path.join(SERVER_ROOT, repo.path)).catch(() => missing.push(repo.path));
    }
    assert.deepEqual(missing, []);
    assert.equal(generated.repos.length, generated.models.length);
  });
});

describe('repos', () => {
  test('insert, find and update under row-level security, with camelCase rows', async () => {
    const id = uuidv7();
    const created = await withTransaction(app, { organisationId: id }, (db) =>
      organisationRepo.insert(db, {
        id, name: 'Initech', slug: 'initech', plan: 'standard', cellId: CELL_ID, calendarTimeZone: 'Europe/London',
      }));
    assert.equal(created.name, 'Initech');
    assert.equal(created.status, 'active');
    assert.match(created.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?\+00:00$/);
    assert.equal(created.financialYearStartMonth, null);

    const renamed = await withTransaction(app, { organisationId: id }, (db) =>
      organisationRepo.update(db, id, { name: 'Initech Ltd' }));
    assert.equal(renamed?.name, 'Initech Ltd');

    const bySlug = await withTransaction(app, { organisationId: id }, (db) => organisationRepo.findBySlug(db, 'initech'));
    assert.equal(bySlug?.id, id);

    const other = await createOrganisation(app, 'hooli');
    const seenByOther = await withTransaction(app, { organisationId: other }, (db) => organisationRepo.findById(db, id));
    assert.equal(seenByOther, undefined);
    // No organisation in the context: the policy cannot read app.org_id, so the statement fails.
    await assert.rejects(withTransaction(app, {}, (db) => organisationRepo.findById(db, id)), /app\.org_id|type uuid/);
  });

  test('a jsonb array is stored as JSON, and text arrays round-trip', async () => {
    const orgId = await createOrganisation(app, 'umbrella');
    const membershipId = await createMembership(app, orgId, await createUser(auth, 'lens@umbrella.example'));
    const workingSets = [{ name: 'late invoices', objects: ['a', 'b'] }];
    const lens = await withTransaction(app, { organisationId: orgId }, (db) =>
      lensRepo.insert(db, { id: uuidv7(), organisationId: orgId, membershipId, name: 'Arrears', workingSets }));
    assert.deepEqual(lens.workingSets, workingSets);
  });

  test('a ledger repo appends and reads, and has no update or remove', async () => {
    const orgId = await createOrganisation(app, 'soylent');
    const event = await withTransaction(audit, { organisationId: orgId }, (db) =>
      authEventRepo.insert(db, { organisationId: orgId, event: 'login_failed', detail: { reason: 'password' } }));
    assert.equal(typeof event.id, 'string');
    assert.deepEqual(event.detail, { reason: 'password' });

    const found = await withTransaction(audit, { organisationId: orgId }, (db) =>
      authEventRepo.findByKey(db, { id: event.id, occurredAt: event.occurredAt }));
    assert.equal(found?.event, 'login_failed');
    assert.equal('update' in authEventRepo, false);
    assert.equal('remove' in authEventRepo, false);
  });
});
