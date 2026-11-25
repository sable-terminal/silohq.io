// The migration runner treats applied migrations as history, and the directory
// database routes logins without holding customer data.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { checkExpected, loadMigrations, migrate } from '../../src/db/scripts/migrate.script.ts';
import { createHarness, type Harness } from './harness.helper.ts';

let h: Harness;

before(async () => {
  h = await createHarness();
});

after(async () => {
  await h?.close();
});

describe('migration runner', () => {
  test('a second run applies nothing', async () => {
    assert.deepEqual(await migrate('cell', h.migrateUrl('cell'), () => undefined), []);
    assert.deepEqual(await migrate('directory', h.migrateUrl('directory'), () => undefined), []);
  });

  test('run by the Fleet agent, the files must be exactly the release\'s migrations, byte for byte (spec 11.3)', async () => {
    const files = await loadMigrations(path.join(import.meta.dirname, '../../src/db/migrations'));
    const named = files.map((f) => ({ version: f.version, name: f.name, digest: `sha256:${f.checksum}` }));
    assert.equal(checkExpected(files, named), undefined);
    assert.match(checkExpected(files, named.map((m) => ({ ...m, digest: `sha256:${'0'.repeat(64)}` })))!, /is not the release's 0001Initial/);
    assert.match(checkExpected(files, [...named, { version: '9999', name: 'Later', digest: named[0]!.digest }])!, /9999Later is in the release but not in the image/);
    assert.match(checkExpected(files, [])!, /is in the image but not in the release/);
    await assert.rejects(migrate('cell', h.migrateUrl('cell'), () => undefined, []), /nothing applied/);
    assert.deepEqual(await migrate('cell', h.migrateUrl('cell'), () => undefined, named), []);
  });

  test('a migration edited after it was applied stops the run', async () => {
    const db = await h.connect('test_migrate');
    const { rows } = await db.query(`select checksum from platform.schema_migrations where version = '0001'`);
    await db.query(`update platform.schema_migrations set checksum = 'edited' where version = '0001'`);
    try {
      await assert.rejects(migrate('cell', h.migrateUrl('cell'), () => undefined), /changed after it was applied/);
    } finally {
      await db.query(`update platform.schema_migrations set checksum = $1 where version = '0001'`, [rows[0]!.checksum]);
    }
  });

  test('only files named <version><Name>.migration.sql are accepted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'silo-migrations-'));
    try {
      await writeFile(path.join(dir, '0002AuditIndexes.migration.sql'), 'select 1;');
      const [loaded] = await loadMigrations(dir);
      assert.deepEqual([loaded?.version, loaded?.name], ['0002', 'AuditIndexes']);

      for (const bad of ['0003_snake_case.sql', '0003lowerStart.migration.sql', '0003Name.sql']) {
        await writeFile(path.join(dir, bad), 'select 1;');
        await assert.rejects(loadMigrations(dir), /must look like/);
        await rm(path.join(dir, bad));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('services cannot read or write the migration ledger', async () => {
    const app = await h.connect('test_app');
    await assert.rejects(app.query('select * from platform.schema_migrations'), /permission denied/);
  });
});

describe('directory', () => {
  test('routes a slug to a cell; the slug never changes, the cell moves only by update', async () => {
    const writer = await h.connect('test_dir_writer', 'directory');
    await writer.query(`
      insert into directory.cells (id, kind, residency, hostname, status) values
        ('uk-lon-1', 'commercial', 'uk', 'uk-lon-1.silohq.io', 'active'),
        ('uk-sov-1', 'sovereign', 'uk', 'uk-sov-1.silohq.io', 'active')`);
    await writer.query(`insert into directory.organisation_directory (organisation_slug, cell_id) values ('acme', 'uk-lon-1')`);

    const routed = await writer.query(`select cell_id from directory.organisation_directory where organisation_slug = 'ACME'`);
    assert.deepEqual(routed.rows, [{ cell_id: 'uk-lon-1' }]);

    await writer.query(`update directory.organisation_directory set cell_id = 'uk-sov-1' where organisation_slug = 'acme'`);
    await assert.rejects(
      writer.query(`update directory.organisation_directory set organisation_slug = 'acme2' where organisation_slug = 'acme'`),
      /cannot be changed/);
    await assert.rejects(writer.query(`delete from directory.organisation_directory`), /permission denied/);
  });

  test('stores an email only as a 32-byte hash, and readers cannot write', async () => {
    const writer = await h.connect('test_dir_writer', 'directory');
    await assert.rejects(
      writer.query(`insert into directory.identity_routing (email_hash, cell_id, hash_key_version)
                    values ($1, 'uk-lon-1', 1)`, [Buffer.from('ada@acme.example')]),
      /check constraint/);
    await writer.query(`insert into directory.identity_routing (email_hash, cell_id, hash_key_version)
                        values ($1, 'uk-lon-1', 1)`, [randomBytes(32)]);

    const reader = await h.connect('test_dir_reader', 'directory');
    await assert.rejects(
      reader.query(`insert into directory.identity_routing (email_hash, cell_id, hash_key_version)
                    values ($1, 'uk-lon-1', 1)`, [randomBytes(32)]),
      /permission denied/);
  });
});
