// The build check of spec 11.3 and the build rules, run against the migrated
// database. Spec 79.1: tests are shown to fail before they are trusted, so the
// second test plants one violation per rule and requires every rule to catch it.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CELL_SCHEMAS, ENCRYPTED_COLUMNS, LEDGERS, lint, NEVER_DELETED, RULE_NAMES, USER_KEYED } from './lint.helper.ts';
import { createHarness, type Harness } from './harness.helper.ts';

let h: Harness;

before(async () => {
  h = await createHarness();
});

after(async () => {
  await h?.close();
});

test('the cell schemas break none of the build rules', async () => {
  const db = await h.connect('test_migrate');
  const violations = await lint(db, {
    schemas: CELL_SCHEMAS, ledgers: LEDGERS, encryptedColumns: ENCRYPTED_COLUMNS, userKeyed: USER_KEYED,
    neverDeleted: NEVER_DELETED,
  });
  assert.deepEqual(violations, []);
});

test('the directory schema breaks none of the build rules', async () => {
  const db = await h.connect('test_dir_migrate', 'directory');
  const violations = await lint(db, {
    schemas: ['directory'], ledgers: [], encryptedColumns: [], userKeyed: [], neverDeleted: [],
  });
  assert.deepEqual(violations, []);
});

test('every rule catches a planted violation', async () => {
  const db = await h.connect('test_migrate');
  await db.query(`
    create schema lint_canary;

    create type lint_canary.mood as enum ('calm');                              -- no-enum-types

    create table lint_canary.parent (                                           -- tenant-rls (no RLS)
      id uuid primary key,
      organisation_id uuid not null,
      unique (organisation_id, id));

    create table lint_canary.child (                                            -- tenant-key (no (organisation_id, id))
      id uuid primary key,
      organisation_id uuid not null,
      parent_id uuid references lint_canary.parent (id),                        -- composite-tenant-fk, fk-index
      seen_at timestamp,                                                        -- timestamptz-only
      secret text,                                                              -- encrypted-columns (text, indexed)
      updated_at timestamptz);                                                  -- updated-at-trigger
    create index child_secret on lint_canary.child (secret);
    select platform.enable_tenant_rls('lint_canary.child');
    comment on column lint_canary.child.seen_at is 'fk-pending: lint_canary.parent';  -- fk-pending-resolved
    grant usage on schema lint_canary to silo_app;
    grant truncate on lint_canary.child to silo_app;                            -- service-role-limits

    create table lint_canary.ledger (                                           -- append-only-ledger
      id bigint primary key, organisation_id uuid not null);
    select platform.enable_tenant_rls('lint_canary.ledger');

    create table lint_canary.users (id uuid primary key);                       -- user-keyed-rls
    grant select on lint_canary.users to silo_app;                              -- user-keyed-privileges

    create table lint_canary.people (id uuid primary key);
    grant delete on lint_canary.people to silo_app;                             -- never-deleted

    create table lint_canary.events (at timestamptz not null)
      partition by range (at);                                                  -- partition-default

    create function lint_canary.open_to_all() returns int language sql as 'select 1';
    grant execute on function lint_canary.open_to_all() to public;              -- function-not-public
    create function lint_canary.loose_definer() returns int
      language sql security definer as 'select 1';                              -- definer-search-path
    grant execute on function lint_canary.loose_definer() to silo_app;
  `);

  try {
    const violations = await lint(db, {
      schemas: ['lint_canary'],
      ledgers: ['lint_canary.ledger'],
      encryptedColumns: ['lint_canary.child.secret'],
      userKeyed: ['lint_canary.users'],
      neverDeleted: ['lint_canary.people'],
    });
    const fired = new Set(violations.map((v) => v.rule));

    const silent = RULE_NAMES.filter((rule) => !fired.has(rule));
    assert.deepEqual(silent, [], `rules that missed their planted violation: ${silent.join(', ')}`);
  } finally {
    await db.query('drop schema lint_canary cascade');
  }
});
