// Append-only ledgers, the policy version counter, the rule that service principals
// never authorise, the scope tree, the outbox relay, and partitions without a date limit.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { createLocalCell, createMembership, createOrganisation, createUser } from './fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from './harness.helper.ts';

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let audit: pg.Client;
let relay: pg.Client;

let orgA: string;
let orgB: string;
let userA: string;
let memberA: string;

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');
  audit = await h.connect('test_audit');
  relay = await h.connect('test_relay');

  await createLocalCell(migrate);
  orgA = await createOrganisation(app, 'acme');
  orgB = await createOrganisation(app, 'globex');
  userA = await createUser(auth, 'ada@acme.example');
  memberA = await createMembership(app, orgA, userA);
});

after(async () => {
  await h?.close();
});

describe('append-only ledgers', () => {
  test('the audit writer can insert but never change or remove an event', async () => {
    const { rows } = await inTx(audit, { orgId: orgA }, () =>
      audit.query(
        `insert into audit.auth_events (organisation_id, user_id, membership_id, event, detail)
         values ($1, $2, $3, 'login_succeeded', '{"method": "password"}') returning id`,
        [orgA, userA, memberA]));
    const id = rows[0]!.id as string;

    await assert.rejects(
      inTx(audit, { orgId: orgA }, () => audit.query(`update audit.auth_events set event = 'x' where id = $1`, [id])),
      /permission denied/);
    await assert.rejects(
      inTx(audit, { orgId: orgA }, () => audit.query('delete from audit.auth_events where id = $1', [id])),
      /permission denied/);
  });

  test('even the migration role cannot update, delete or truncate a ledger', async () => {
    await assert.rejects(migrate.query(`update audit.auth_events set event = 'x'`), /append-only/);
    await assert.rejects(migrate.query('delete from audit.auth_events'), /append-only/);
    await assert.rejects(migrate.query('truncate audit.auth_events'), /append-only/);
    await assert.rejects(migrate.query('truncate platform.model_calls'), /append-only/);
  });

  test('every audit event names exactly one actor', async () => {
    await assert.rejects(
      inTx(audit, { orgId: orgA }, () =>
        audit.query(
          `insert into audit.audit_events (occurred_at, source_event_id, organisation_id, event, correlation_id,
                                           chain_seq, prev_hash, row_hash, membership_id, system_service)
           values (now(), $1, $2, 'role_created', $1, 1, $3, $3, $4, 'scheduler')`,
          [uuidv7(), orgA, Buffer.alloc(32), memberA])),
      /check constraint/);
  });

  test('a redelivered audit event is refused by its source id', async () => {
    const source = uuidv7();
    const insert = (seq: number) =>
      inTx(audit, { orgId: orgA }, () =>
        audit.query(
          `insert into audit.audit_events (occurred_at, source_event_id, organisation_id, event, correlation_id,
                                           chain_seq, prev_hash, row_hash, membership_id)
           values ('2026-10-28T12:00:00Z', $1, $2, 'role_created', $1, $3, $4, $4, $5)`,
          [source, orgA, seq, Buffer.alloc(32), memberA]));
    await insert(1);
    await assert.rejects(insert(2), /duplicate key/);
  });
});

describe('policy version', () => {
  test('rises when a role changes, and services cannot set it', async () => {
    const version = async () =>
      (await inTx(app, { orgId: orgA }, () => app.query('select version from iam.policy_versions'))).rows[0]!.version;
    const before = Number(await version());

    await inTx(app, { orgId: orgA }, () =>
      app.query(`insert into iam.roles (id, organisation_id, name) values ($1, $2, 'Analyst')`, [uuidv7(), orgA]));
    assert.equal(Number(await version()), before + 1);

    await assert.rejects(
      inTx(app, { orgId: orgA }, () => app.query('update iam.policy_versions set version = version + 1')),
      /permission denied/);
    await assert.rejects(
      migrate.query('update iam.policy_versions set version = 1 where organisation_id = $1', [orgA]),
      /can only increase/);
  });

  test("changes in one organisation leave the other's version alone", async () => {
    const versionB = async () =>
      (await inTx(app, { orgId: orgB }, () => app.query('select version from iam.policy_versions'))).rows[0]!.version;
    const before = await versionB();
    await inTx(app, { orgId: orgA }, () =>
      app.query(`insert into iam.roles (id, organisation_id, name) values ($1, $2, 'Viewer')`, [uuidv7(), orgA]));
    assert.equal(await versionB(), before);
  });
});

describe('service principals never authorise', () => {
  // mutation.approve (authorising) and query.compile (standard) come from the seeded catalogue.
  const createPrincipal = async (): Promise<string> => {
    const id = uuidv7();
    await inTx(app, { orgId: orgA }, () =>
      app.query(
        `insert into iam.service_principals (id, organisation_id, kind, name, owner_membership_id, created_by)
         values ($1, $2, 'automation', 'Nightly report', $3, $3)`, [id, orgA, memberA]));
    return id;
  };

  test('a principal cannot be given a role that holds an authorising permission', async () => {
    const principal = await createPrincipal();
    const role = uuidv7();
    await assert.rejects(
      inTx(app, { orgId: orgA }, async () => {
        await app.query(`insert into iam.roles (id, organisation_id, name) values ($1, $2, 'Approver')`, [role, orgA]);
        await app.query(`insert into iam.role_permissions (organisation_id, role_id, permission_id)
                         values ($1, $2, 'mutation.approve')`, [orgA, role]);
        await app.query(`insert into iam.service_principal_roles (organisation_id, service_principal_id, role_id, granted_by)
                         values ($1, $2, $3, $4)`, [orgA, principal, role, memberA]);
      }),
      /never authorise/);
  });

  test("a role a principal holds cannot later gain an authorising permission", async () => {
    const principal = await createPrincipal();
    const role = uuidv7();
    await inTx(app, { orgId: orgA }, async () => {
      await app.query(`insert into iam.roles (id, organisation_id, name) values ($1, $2, 'Reporter')`, [role, orgA]);
      await app.query(`insert into iam.role_permissions (organisation_id, role_id, permission_id)
                       values ($1, $2, 'query.compile')`, [orgA, role]);
      await app.query(`insert into iam.service_principal_roles (organisation_id, service_principal_id, role_id, granted_by)
                       values ($1, $2, $3, $4)`, [orgA, principal, role, memberA]);
    });
    await assert.rejects(
      inTx(app, { orgId: orgA }, () =>
        app.query(`insert into iam.role_permissions (organisation_id, role_id, permission_id)
                   values ($1, $2, 'mutation.approve')`, [orgA, role])),
      /never authorise/);
  });
});

describe('scope tree', () => {
  test('a move carries its descendants, and a scope cannot move under its own descendant', async () => {
    const ids = { type: uuidv7(), r1: uuidv7(), c: uuidv7(), g: uuidv7(), r2: uuidv7() };
    const label = (id: string) => id.replaceAll('-', '');
    const path = async (id: string) =>
      (await inTx(app, { orgId: orgA }, () =>
        app.query('select path::text, depth from iam.scopes where id = $1', [id]))).rows[0];

    await inTx(app, { orgId: orgA }, async () => {
      await app.query(`insert into iam.scope_types (id, organisation_id, name) values ($1, $2, 'Unit')`, [ids.type, orgA]);
      const add = (id: string, name: string, parent: string | null) =>
        app.query(`insert into iam.scopes (id, organisation_id, scope_type_id, name, parent_scope_id, created_by)
                   values ($1, $2, $3, $4, $5, $6)`, [id, orgA, ids.type, name, parent, memberA]);
      await add(ids.r1, 'Europe', null);
      await add(ids.c, 'France', ids.r1);
      await add(ids.g, 'Paris', ids.c);
      await add(ids.r2, 'EMEA', null);
    });
    assert.deepEqual(await path(ids.g), { path: `${label(ids.r1)}.${label(ids.c)}.${label(ids.g)}`, depth: 3 });

    await inTx(app, { orgId: orgA }, () =>
      app.query('update iam.scopes set parent_scope_id = $1 where id = $2', [ids.r2, ids.c]));
    assert.deepEqual(await path(ids.g), { path: `${label(ids.r2)}.${label(ids.c)}.${label(ids.g)}`, depth: 3 });

    await assert.rejects(
      inTx(app, { orgId: orgA }, () => app.query('update iam.scopes set parent_scope_id = $1 where id = $2', [ids.g, ids.r2])),
      /own descendant/);
    await assert.rejects(
      inTx(app, { orgId: orgA }, () => app.query(`update iam.scopes set path = 'x' where id = $1`, [ids.g])),
      /maintained by the database/);
  });
});

describe('outbox relay', () => {
  const enqueue = (orgId: string, event: string) =>
    inTx(app, { orgId }, () =>
      app.query(
        `insert into platform.outbox (id, organisation_id, topic, ordering_key, event, payload, correlation_id)
         values ($1, $2, 'audit.events', $3, $4, '{}', $1)`, [uuidv7(), orgId, orgId, event]));

  test('the relay cannot read the table directly', async () => {
    await assert.rejects(relay.query('select * from platform.outbox'), /permission denied/);
  });

  test('an organisation-ordered event must carry the organisation as its key', async () => {
    await assert.rejects(
      inTx(app, { orgId: orgA }, () =>
        app.query(
          `insert into platform.outbox (id, organisation_id, topic, ordering_key, event, payload, correlation_id)
           values ($1, $2, 'audit.events', 'other', 'role_created', '{}', $1)`, [uuidv7(), orgA])),
      /check constraint/);
  });

  test('publishes across organisations, one event at a time per key, in order', async () => {
    await enqueue(orgA, 'first_event');
    await enqueue(orgA, 'second_event');
    await enqueue(orgB, 'other_org_event');

    // created_at goes back as text: a JavaScript Date would drop the microseconds.
    const claim = () =>
      relay.query<{ id: string; created_at: string; event: string }>(
        'select id, created_at::text as created_at, event from platform.outbox_claim(10) order by seq');

    const firstRound = await claim();
    assert.deepEqual(firstRound.rows.map((r) => r.event), ['first_event', 'other_org_event']);

    const published = await relay.query('select platform.outbox_mark_published($1::uuid[], $2::timestamptz[]) as n',
      [firstRound.rows.map((r) => r.id), firstRound.rows.map((r) => r.created_at)]);
    assert.equal(published.rows[0]!.n, 2);

    const secondRound = await claim();
    assert.deepEqual(secondRound.rows.map((r) => r.event), ['second_event']);
  });
});

describe('partitions', () => {
  const authEvent = (occurredAt: string) =>
    inTx(audit, { orgId: orgA }, () =>
      audit.query<{ id: string }>(
        `insert into audit.auth_events (organisation_id, user_id, event, occurred_at)
         values ($1, $2, 'login_succeeded', $3) returning id`,
        [orgA, userA, occurredAt]));
  const partitionOf = async (id: string) =>
    (await migrate.query(`select tableoid::regclass::text as p from audit.auth_events where id = $1`, [id])).rows[0]?.p;

  test('a write is never refused for its date, and the daily job moves it into its own month', async () => {
    const future = (await authEvent('2031-03-05T12:00:00Z')).rows[0]!.id;
    const past = (await authEvent('2019-06-01T08:00:00Z')).rows[0]!.id;
    assert.equal(await partitionOf(future), 'audit.auth_events_default');
    assert.equal(await partitionOf(past), 'audit.auth_events_default');

    const before = await migrate.query(
      `select default_rows, healthy from platform.partition_status() where parent = 'audit.auth_events'`);
    assert.deepEqual(before.rows, [{ default_rows: '2', healthy: false }]);

    await migrate.query('select platform.maintain_partitions()');

    assert.equal(await partitionOf(future), 'audit.auth_events_y2031m03');
    assert.equal(await partitionOf(past), 'audit.auth_events_y2019m06');
    const unhealthy = await migrate.query('select parent from platform.partition_status() where not healthy');
    assert.deepEqual(unhealthy.rows, []);
  });

  test('the default partition is append-only like the rest of the ledger', async () => {
    const id = (await authEvent('2045-01-01T00:00:00Z')).rows[0]!.id;
    assert.equal(await partitionOf(id), 'audit.auth_events_default');
    await assert.rejects(migrate.query('delete from audit.auth_events where id = $1', [id]), /append-only/);
    await migrate.query('select platform.maintain_partitions()');
    assert.equal(await partitionOf(id), 'audit.auth_events_y2045m01');
  });

  test("an organisation's Capture partitions join the daily job", async () => {
    await migrate.query('select siloes.create_capture_partitions($1)', [orgA]);
    const parent = `siloes.transitions_${orgA.replaceAll('-', '')}`;
    const { rows } = await migrate.query(
      `select healthy, to_regclass($1 || '_default') is not null as has_default
       from platform.partition_status() where parent = $1`, [parent]);
    assert.deepEqual(rows, [{ healthy: true, has_default: true }]);
  });

  test('a planned table that no longer exists is reported, not fatal', async () => {
    await migrate.query(`insert into platform.partition_plan (parent, granularity, create_ahead) values ('audit.gone', 'month', 3)`);
    try {
      await migrate.query('select platform.maintain_partitions()');
      const { rows } = await migrate.query(
        `select covered_until, healthy from platform.partition_status() where parent = 'audit.gone'`);
      assert.deepEqual(rows, [{ covered_until: null, healthy: false }]);
    } finally {
      await migrate.query(`delete from platform.partition_plan where parent = 'audit.gone'`);
    }
  });
});
