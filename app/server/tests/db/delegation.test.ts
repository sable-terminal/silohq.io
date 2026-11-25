// The permission catalogue, the seeded roles and delegation (spec 56.7, 56.8, 57.2, 76),
// enforced by the database whatever the application does.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type pg from 'pg';
import { createLocalCell, createMembership, createOrganisation, createUser } from './fixtures.helper.ts';
import { createHarness, inTx, uuidv7, type Harness } from './harness.helper.ts';

let h: Harness;
let migrate: pg.Client;
let app: pg.Client;
let auth: pg.Client;
let org: string;
const roles: Record<string, string> = {};
const scopes: Record<string, string> = {};
const people: Record<string, string> = {};

const asOrg = <T>(work: () => Promise<T>): Promise<T> => inTx(app, { orgId: org }, work);

async function scope(name: string, parent: string | null, createdBy: string, typeId: string): Promise<string> {
  const id = uuidv7();
  await asOrg(() => app.query(
    'insert into iam.scopes (id, organisation_id, scope_type_id, name, parent_scope_id, path, depth, created_by) values ($1, $2, $3, $4, $5, $6, 1, $7)',
    [id, org, typeId, name, parent, 'x', createdBy]));
  return id;
}

async function grant(by: string, to: string, role: string, onScope: string | null, actedAt: string | null): Promise<string> {
  const id = uuidv7();
  await asOrg(() => app.query(
    `insert into iam.role_assignments (id, organisation_id, membership_id, role_id, on_scope_id, granted_by, granted_at_scope_id)
     values ($1, $2, $3, $4, $5, $6, $7)`, [id, org, to, role, onScope, by, actedAt]));
  return id;
}

const revoke = (id: string, by: string) => asOrg(() => app.query(
  'update iam.role_assignments set revoked_at = now(), revoked_by = $2 where id = $1', [id, by]));

before(async () => {
  h = await createHarness();
  migrate = await h.connect('test_migrate');
  app = await h.connect('test_app');
  auth = await h.connect('test_auth');
  await createLocalCell(migrate);
  org = await createOrganisation(app, 'acme');
  const { rows } = await asOrg(() => app.query('select id, name from iam.roles where organisation_id = $1', [org]));
  for (const row of rows) roles[row.name as string] = row.id as string;
  for (const name of ['super', 'eng', 'eng2', 'sales', 'x']) {
    people[name] = await createMembership(app, org, await createUser(auth, `${name}@acme.example`));
  }
  // The first super admin, as provisioning creates it.
  await migrate.query(
    `insert into iam.role_assignments (id, organisation_id, membership_id, role_id, granted_by) values ($1, $2, $3, $4, $3)`,
    [uuidv7(), org, people['super'], roles['Super admin']]);
  const type = uuidv7();
  await asOrg(() => app.query('insert into iam.scope_types (id, organisation_id, name) values ($1, $2, $3)', [type, org, 'Department']));
  scopes['engineering'] = await scope('Engineering', null, people['super']!, type);
  scopes['platform'] = await scope('Platform', scopes['engineering']!, people['super']!, type);
  scopes['sales'] = await scope('Sales', null, people['super']!, type);
  await grant(people['super']!, people['eng']!, roles['Admin']!, scopes['engineering']!, null);
  await grant(people['super']!, people['eng2']!, roles['Admin']!, scopes['engineering']!, null);
  await grant(people['super']!, people['sales']!, roles['Admin']!, scopes['sales']!, null);
});

after(async () => {
  await h?.close();
});

describe('the permission catalogue (spec 76, 57.2)', () => {
  // 141: spec 76's catalogue less connector.promote and connector.tier_promote, the marketplace's, dropped on 2026-11-23,
  // and workbook.save, report.save, process.save, pipeline.save, ai_agent.save, notebook.save and model.save, beyond the spec (D232 to D240).
  test('141 permissions, seeded and fixed', async () => {
    const { rows } = await migrate.query('select count(*)::int as n from iam.permissions');
    assert.equal(rows[0].n, 141);
    await assert.rejects(app.query(`insert into iam.permissions (id, category, scopeable, description) values ('x.y', 'standard', true, 'x')`),
      /permission denied/);
  });

  test('every organisation starts with the seeded roles, at policy version 1', async () => {
    assert.deepEqual(Object.keys(roles).sort(), ['Admin', 'Billing', 'Member', 'Physical operations', 'Security reviewer', 'Super admin']);
    const counts = await asOrg(() => app.query(
      `select r.name, count(*)::int as n from iam.role_permissions rp join iam.roles r on r.id = rp.role_id
       where rp.organisation_id = $1 group by r.name`, [org]));
    const byName = Object.fromEntries(counts.rows.map((r) => [r.name, r.n]));
    assert.equal(byName['Super admin'], 133, 'every customer permission but actuation.approve, the Physical operations role\'s alone (47.8)');
    assert.equal(byName['Physical operations'], 1);
    const fresh = await createOrganisation(app, 'fresh');
    const version = await inTx(app, { orgId: fresh }, () => app.query('select version from iam.policy_versions where organisation_id = $1', [fresh]));
    assert.equal(Number(version.rows[0].version), 1);
  });

  test('no customer role holds a Silo staff permission; organisation-wide-only ones stay in Super admin', async () => {
    const custom = uuidv7();
    await asOrg(() => app.query(`insert into iam.roles (id, organisation_id, name) values ($1, $2, 'Custom')`, [custom, org]));
    const add = (role: string, permission: string) => asOrg(() => app.query(
      'insert into iam.role_permissions (organisation_id, role_id, permission_id) values ($1, $2, $3)', [org, role, permission]));
    await assert.rejects(add(custom, 'key.rotate'), /Silo staff/);
    await assert.rejects(add(roles['Super admin']!, 'payment.record'), /Silo staff/);
    await assert.rejects(add(custom, 'clearance.grant'), /Super admin role only/);
    await add(custom, 'ontology.view');
  });
});

describe('delegation (spec 56.7)', () => {
  test('a super admin grants anywhere, organisation-wide included', async () => {
    await grant(people['super']!, people['x']!, roles['Member']!, null, null);
  });

  test('an admin grants within their subtree, recording the scope they acted under', async () => {
    await grant(people['eng']!, people['x']!, roles['Member']!, scopes['platform']!, scopes['engineering']!);
  });

  test('rule 1: never outside the subtree', async () => {
    await assert.rejects(grant(people['eng']!, people['x']!, roles['Member']!, scopes['sales']!, scopes['engineering']!), /does not administer/);
  });

  test('rule 3: only a super admin grants organisation-wide, or creates a super admin', async () => {
    await assert.rejects(grant(people['eng']!, people['x']!, roles['Member']!, null, null), /only a super admin/);
    await assert.rejects(grant(people['eng']!, people['x']!, roles['Super admin']!, scopes['platform']!, scopes['engineering']!),
      /organisation-wide only/);
  });

  test('rules 2 and 5: no escalation, and whitelisted roles only', async () => {
    await assert.rejects(grant(people['eng']!, people['x']!, roles['Billing']!, scopes['platform']!, scopes['engineering']!),
      /permissions the granter does not/);
    const editors = uuidv7();
    await asOrg(async () => {
      await app.query(`insert into iam.roles (id, organisation_id, name) values ($1, $2, 'Ontology editors')`, [editors, org]);
      await app.query(`insert into iam.role_permissions (organisation_id, role_id, permission_id) values ($1, $2, 'ontology.view')`, [org, editors]);
    });
    await assert.rejects(grant(people['eng']!, people['x']!, editors, scopes['platform']!, scopes['engineering']!), /may not assign/);
  });

  test('provenance: the scope acted under must contain the target', async () => {
    await assert.rejects(grant(people['eng']!, people['x']!, roles['Member']!, scopes['platform']!, null), /granted_at_scope_id/);
    await assert.rejects(grant(people['eng']!, people['x']!, roles['Member']!, scopes['platform']!, scopes['sales']!), /granted_at_scope_id/);
  });
});

describe('revocation (spec 56.8)', () => {
  test('by the issuer, an admin over the scope it was issued under, or a super admin; never another admin', async () => {
    const first = await grant(people['eng']!, people['sales']!, roles['Member']!, scopes['platform']!, scopes['engineering']!);
    await assert.rejects(revoke(first, people['x']!), /only the issuer/);
    await revoke(first, people['eng2']!);
    const second = await grant(people['eng']!, people['sales']!, roles['Member']!, scopes['platform']!, scopes['engineering']!);
    await revoke(second, people['eng']!);
    const third = await grant(people['eng']!, people['sales']!, roles['Member']!, scopes['platform']!, scopes['engineering']!);
    await revoke(third, people['super']!);
    const fourth = await grant(people['sales']!, people['eng']!, roles['Member']!, scopes['sales']!, scopes['sales']!);
    await assert.rejects(revoke(fourth, people['eng']!), /only the issuer/);
  });
});
