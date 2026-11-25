// SCIM 2.0 provisioning end to end (RFC 7643, 7644; spec 55.5): a super admin issues a
// token through the gateway; a provisioning client creates, finds, changes and
// deprovisions members at /scim/v2 with it. Deprovisioning suspends the membership and
// revokes its sessions in one transaction; the token is checked on every request.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { issueToken } from '../../src/utils/token.util.ts';
import { inTx, uuidv7 } from '../db/harness.helper.ts';
import { browser, call, signIn, startCell, storeProvider, type Browser, type Cell } from './sso.helper.ts';

let cell: Cell;
let root: Browser;
let token: string;
let tokenId: string;

async function scim(method: string, path: string, body?: unknown, bearer: string | null = token)
  : Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.20', accept: 'application/scim+json' };
  if (bearer !== null) headers['authorization'] = `Bearer ${bearer}`;
  if (body !== undefined) headers['content-type'] = 'application/scim+json';
  const res = await fetch(`${cell.gateway}/scim/v2${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text), headers: res.headers };
}

const user = (userName: string, externalId: string, extra: Record<string, unknown> = {}) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName, externalId,
  name: { givenName: 'Grace', familyName: 'Hopper' }, emails: [{ value: userName, primary: true, type: 'work' }], active: true, ...extra,
});

const count = async (sql: string, params: unknown[]): Promise<number> => Number((await cell.migrate.query(sql, params)).rows[0].n);

before(async () => {
  cell = await startCell();
  root = await signIn(cell.gateway, 'root@acme.example');
  // The organisation's SSO provider names the default role SCIM members get.
  await storeProvider(cell, uuidv7(), {
    issuer: 'https://idp.example/oidc', jitProvisioning: true, defaultRoleId: cell.roles['Member']!, defaultScopeId: null, active: true,
    expectedVersion: null, configuredBy: cell.rootMembership, config: { kind: 'oidc', settings: { clientId: 'x' } as never, clientSecret: 'y' },
  });
  const issued = await call(cell.gateway, root, 'POST', '/scim-tokens');
  assert.equal(issued.status, 201, issued.text);
  token = issued.body.token;
  tokenId = issued.body.tokenId;
});

after(async () => {
  await cell?.close();
});

describe('the token', () => {
  test('issued once by a super admin, stored only as a hash, listed without it', async () => {
    assert.match(token, new RegExp(`^${cell.org}\\.[A-Za-z0-9_-]{43}$`));
    const listed = await call(cell.gateway, root, 'GET', '/scim-tokens');
    assert.equal(listed.status, 200, listed.text);
    assert.equal(listed.body.tokens.length, 1);
    assert.equal(JSON.stringify(listed.body).includes(token), false);
    assert.equal(await count(`select count(*) as n from platform.outbox where organisation_id = $1 and payload->>'event' = 'scim_token_issued'`, [cell.org]), 1);
  });

  test('no token, or a wrong one, is refused in SCIM\'s error shape', async () => {
    const none = await scim('GET', '/Users', undefined, null);
    assert.equal(none.status, 401);
    assert.deepEqual(none.body.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
    const wrong = await scim('GET', '/Users', undefined, `${cell.org}.${'A'.repeat(43)}`);
    assert.equal(wrong.status, 401);
    assert.equal((await scim('GET', '/Users', undefined, 'garbage')).status, 401);
  });

  test('the service provider configuration says what is supported', async () => {
    const config = await scim('GET', '/ServiceProviderConfig');
    assert.equal(config.status, 200);
    assert.equal(config.body.patch.supported, true);
    assert.equal(config.body.bulk.supported, false);
    assert.equal(config.headers.get('content-type')?.startsWith('application/scim+json'), true);
    const groups = await scim('GET', '/Groups');
    assert.deepEqual([groups.status, groups.body.totalResults], [200, 0]);
  });
});

describe('users', () => {
  let created: any;

  test('a client creates a member: a new SSO-only person, the default role, its externalId', async () => {
    const reply = await scim('POST', '/Users', user('grace@acme.example', 'ext-1'));
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    created = reply.body;
    assert.equal(reply.headers.get('location'), `https://app.silo.test/scim/v2/Users/${created.id}`);
    assert.equal(created.userName, 'grace@acme.example');
    assert.equal(created.externalId, 'ext-1');
    assert.equal(created.active, true);
    const { rows } = await cell.migrate.query(
      `select m.status, m.scim_external_id, u.sso_only, r.name as role
         from iam.memberships m join iam.users u on u.id = m.user_id
         join iam.role_assignments a on a.membership_id = m.id join iam.roles r on r.id = a.role_id
        where m.id = $1`, [created.id]);
    assert.deepEqual(rows, [{ status: 'active', scim_external_id: 'ext-1', sso_only: true, role: 'Member' }]);

    const again = await scim('POST', '/Users', user('GRACE@acme.example', 'ext-2'));
    assert.equal(again.status, 409);
    assert.equal(again.body.scimType, 'uniqueness');
  });

  test('found by userName, externalId, emails.value or id; listed in pages', async () => {
    for (const filter of ['userName eq "grace@acme.example"', 'externalId eq "ext-1"', 'emails.value eq "Grace@acme.example"', `id eq "${created.id}"`]) {
      const found = await scim('GET', `/Users?filter=${encodeURIComponent(filter)}`);
      assert.equal(found.status, 200, filter);
      assert.equal(found.body.totalResults, 1, filter);
      assert.equal(found.body.Resources[0].id, created.id, filter);
    }
    const none = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "nobody@acme.example"')}`);
    assert.equal(none.body.totalResults, 0);
    const page = await scim('GET', '/Users?startIndex=1&count=1');
    assert.equal(page.body.itemsPerPage, 1);
    assert.ok(page.body.totalResults >= 2, 'root and grace');
    const bad = await scim('GET', `/Users?filter=${encodeURIComponent('displayName co "x"')}`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.scimType, 'invalidFilter');
  });

  test('patched: the name and externalId change; the address does not', async () => {
    const patched = await scim('PATCH', `/Users/${created.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'name.familyName', value: 'Murray Hopper' }, { op: 'replace', value: { externalId: 'ext-1b' } }],
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.name.familyName, 'Murray Hopper');
    assert.equal(patched.body.externalId, 'ext-1b');
    const address = await scim('PATCH', `/Users/${created.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'userName', value: 'g@acme.example' }],
    });
    assert.equal(address.status, 400);
    assert.equal(address.body.scimType, 'mutability');
    const put = await scim('PUT', `/Users/${created.id}`, user('someone.else@acme.example', 'ext-1b'));
    assert.equal(put.status, 400);
  });

  test('deprovisioned (active "False", as Entra sends it): suspended, sessions revoked; then reinstated', async () => {
    // A member with a live session, invited and accepted by password.
    const { token: invitation, hash } = issueToken('invitation');
    await inTx(cell.app, { orgId: cell.org }, () => cell.app.query(
      `insert into iam.invitations (id, organisation_id, email, token_hash, role_id, invited_by, expires_at)
       values ($1, $2, 'leaver@acme.example', $3, $4, $5, now() + interval '1 day')`, [uuidv7(), cell.org, hash, cell.roles['Member'], cell.rootMembership]));
    const leaver = browser();
    const accepted = await call(cell.gateway, leaver, 'POST', '/invitations/accept', {
      organisationSlug: 'acme', token: invitation, password: 'correct horse battery staple', firstName: 'Lee', lastName: 'Ver',
    });
    assert.equal(accepted.status, 201, accepted.text);
    assert.equal((await call(cell.gateway, leaver, 'GET', '/session')).status, 200);

    const found = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "leaver@acme.example"')}`);
    const id = found.body.Resources[0].id;
    const off = await scim('PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.active, false);
    const { rows } = await cell.migrate.query(
      `select m.status, (select count(*)::int from iam.sessions s where s.active_membership_id = m.id and s.revoked_at is null) as live
         from iam.memberships m where m.id = $1`, [id]);
    assert.deepEqual(rows, [{ status: 'suspended', live: 0 }]);
    assert.equal((await call(cell.gateway, leaver, 'GET', '/session')).status, 401, 'the session is gone at once');
    const event = await cell.migrate.query(
      `select payload->'detail' as detail from platform.outbox where organisation_id = $1 and payload->>'event' = 'member_suspended'`, [cell.org]);
    assert.equal(event.rows[0].detail.sessions_revoked, 1);

    const on = await scim('PATCH', `/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: true } }],
    });
    assert.equal(on.body.active, true);
    assert.equal(await count(`select count(*) as n from platform.outbox where organisation_id = $1 and payload->>'event' = 'member_reinstated'`, [cell.org]), 1);
  });

  test('DELETE deprovisions too; an unknown id is not found', async () => {
    const deleted = await scim('DELETE', `/Users/${created.id}`);
    assert.equal(deleted.status, 204);
    assert.equal((await scim('GET', `/Users/${created.id}`)).body.active, false);
    assert.equal((await scim('GET', `/Users/${uuidv7()}`)).status, 404);
  });
});

describe('while the organisation moves cell (spec 6.4)', () => {
  test('a change is refused as unavailable, which a client retries; reading goes on', async () => {
    const destination = `uk-lon-${uuidv7().slice(-6)}`;
    await cell.migrate.query(`insert into platform.cells (id, kind, residency, location, hosting, hostname, is_local, status, placement_open)
      values ($1, 'commercial', 'uk', 'London', 'gke', $2, false, 'active', true)`, [destination, `${destination}.silohq.io`]);
    const operator = uuidv7();
    await cell.migrate.query(`insert into platform.operators (id, idp_subject, display_name, clearance, uk_resident, sovereign_access_listed, status)
      values ($1, $2, 'Ops', 'sc', true, false, 'active')`, [operator, `ops-${operator}`]);
    const migration = uuidv7();
    await cell.migrate.query(`insert into platform.tenant_migrations (id, organisation_id, source_cell_id, destination_cell_id, reason, status,
        requested_by_operator_id, notice_given_at, window_starts_at, window_ends_at, read_only_at, destination_key_id, destination_import_key)
      select $1, o.id, o.cell_id, $2, 'rebalancing', 'read_only', $3, now() - interval '31 days', now() - interval '1 minute', now() + interval '3 hours',
        now(), repeat('a', 64), 'key' from iam.organisations o where o.id = $4`, [migration, destination, operator, cell.org]);
    try {
      const refused = await scim('POST', '/Users', user('mover@acme.example', 'ext-mover'));
      assert.equal(refused.status, 503);
      assert.equal(refused.body.schemas[0], 'urn:ietf:params:scim:api:messages:2.0:Error');
      assert.equal(await count(`select count(*) as n from iam.users where email = 'mover@acme.example'`, []), 0);
      assert.equal((await scim('GET', '/Users')).status, 200);
    } finally {
      await cell.migrate.query(`update platform.tenant_migrations set status = 'aborted', aborted_at = now() where id = $1`, [migration]);
    }
  });
});

describe('revoking the token', () => {
  test('a revoked token is refused at once', async () => {
    const revoked = await call(cell.gateway, root, 'DELETE', `/scim-tokens/${tokenId}`);
    assert.equal(revoked.status, 204, revoked.text);
    assert.equal((await scim('GET', '/Users')).status, 401);
    assert.equal(await count(`select count(*) as n from platform.outbox where organisation_id = $1 and payload->>'event' = 'scim_token_revoked'`, [cell.org]), 1);
  });
});

describe('groups (decision 2026-11-14)', () => {
  const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
  const adminRole = () => cell.roles['Admin']!;
  const grants = async (membershipId: string) => (await cell.migrate.query(
    `select role_id, scim_group_mapping_id from iam.role_assignments where membership_id = $1 and revoked_at is null and role_id = $2`,
    [membershipId, adminRole()])).rows;
  let member = '';
  let groupId = '';
  let mappingId = '';

  before(async () => {
    // The tests above end by revoking their token.
    const issued = await call(cell.gateway, root, 'POST', '/scim-tokens');
    assert.equal(issued.status, 201, issued.text);
    token = issued.body.token;
    const created = await scim('POST', '/Users', user('ada@acme.example', 'ext-ada'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    member = created.body.id;
  });

  test('a pushed group grants nothing until an admin maps it', async () => {
    const created = await scim('POST', '/Groups', { schemas: [GROUP], displayName: 'Ops Admins', externalId: 'grp-1', members: [{ value: member }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    groupId = created.body.id;
    assert.deepEqual(created.body.members.map((m: any) => m.value), [member]);
    assert.equal((await grants(member)).length, 0, 'unmapped');
    const found = await scim('GET', `/Groups?filter=${encodeURIComponent('displayName eq "ops admins"')}&excludedAttributes=members`);
    assert.deepEqual([found.body.totalResults, found.body.Resources[0].id, 'members' in found.body.Resources[0]], [1, groupId, false]);
    const types = await scim('GET', '/ResourceTypes');
    assert.deepEqual(types.body.Resources.map((r: any) => r.id), ['User', 'Group']);
  });

  test('mapping it grants its members the role, given as the admin who mapped it', async () => {
    const mapped = await call(cell.gateway, root, 'POST', '/scim-group-mappings', { groupId, roleId: adminRole(), scopeId: null });
    assert.equal(mapped.status, 201, mapped.text);
    mappingId = mapped.body.mapping.id;
    assert.equal(mapped.body.granted, 1);
    assert.deepEqual((await grants(member)).map((g: any) => g.scim_group_mapping_id), [mappingId]);
    const listed = await call(cell.gateway, root, 'GET', '/scim-groups');
    assert.deepEqual(listed.body.groups.map((g: any) => [g.id, g.memberCount, g.mappings.length]), [[groupId, 1, 1]]);
  });

  test('renaming the group changes nothing; leaving it revokes the role, joining again grants it', async () => {
    const renamed = await scim('PATCH', `/Groups/${groupId}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'displayName', value: 'Super Admins' }] });
    assert.equal(renamed.status, 204);
    assert.equal((await grants(member)).length, 1, 'mapped by id, not by name');
    const left = await scim('PATCH', `/Groups/${groupId}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'remove', path: `members[value eq "${member}"]` }] });
    assert.equal(left.status, 204);
    assert.equal((await grants(member)).length, 0);
    const back = await scim('PATCH', `/Groups/${groupId}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Add', path: 'members', value: [{ value: member }] }] });
    assert.equal(back.status, 204);
    assert.equal((await grants(member)).length, 1);
  });

  test('a SCIM-managed member\'s roles are not edited by hand', async () => {
    const granted = await call(cell.gateway, root, 'POST', '/admin/role-assignments', { membershipId: member, roleId: cell.roles['Member']! });
    assert.deepEqual([granted.status, granted.body.error.code], [409, 'role.scim_managed']);
    const assignment = (await cell.migrate.query(
      `select id from iam.role_assignments where membership_id = $1 and scim_group_mapping_id is not null and revoked_at is null`, [member])).rows[0]!.id;
    const revoked = await call(cell.gateway, root, 'POST', `/admin/role-assignments/${assignment}/revoke`);
    assert.deepEqual([revoked.status, revoked.body.error.code], [409, 'role.scim_managed']);
  });

  test('removing the mapping, or deleting the group, revokes what it granted', async () => {
    const removed = await call(cell.gateway, root, 'DELETE', `/scim-group-mappings/${mappingId}`);
    assert.equal(removed.status, 204, removed.text);
    assert.equal((await grants(member)).length, 0);
    assert.equal((await scim('DELETE', `/Groups/${groupId}`)).status, 204);
    assert.equal((await scim('GET', `/Groups/${groupId}`)).status, 404);
    assert.equal(await count(`select count(*) as n from platform.outbox where organisation_id = $1 and payload->>'event' = 'scim_group_changed'`, [cell.org]), 5);
  });

  test('a member who is not the organisation\'s user is refused', async () => {
    const bad = await scim('POST', '/Groups', { schemas: [GROUP], displayName: 'Strangers', members: [{ value: uuidv7() }] });
    assert.deepEqual([bad.status, bad.body.scimType], [400, 'invalidValue']);
  });
});
