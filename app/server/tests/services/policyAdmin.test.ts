// Administration over the API, end to end (spec 56, 55.7, 57.2): credential, auth and
// policy as real processes. A super admin builds a scope tree and appoints an admin for
// Engineering, who administers their subtree and nothing outside it; roles, grants and
// their revocation follow the delegation rules; an admin's revocation leaves an orphan
// list, not a cascade; suspension and removal end access in one step and reinstatement
// restores it as it was.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  addScopeMember, listScopeMembers, archiveScope, createRole, createScope, createScopeType, grantRole, listMembers, listOrphanedGrants, listRoleAssignments,
  listScopes, reinstateMember, removeMember, removeScopeMember, retireRole, revokeRole, setRolePermissions, suspendMember, updateScope,
  listDirectory,
} from '../../src/contracts/policy/admin.contract.ts';
import { authorise, listMyPermissions, listPermittedScopes } from '../../src/contracts/policy/decision.contract.ts';
import { uuidv7 } from '../db/harness.helper.ts';
import { startPolicyCell, type PolicyCell, type Signed } from './policy.helper.ts';

let cell: PolicyCell;
let root: Signed;
let eve: Signed;
let max: Signed;
let sam: Signed;
let department: string;
const scopes: Record<string, { id: string; version: number }> = {};

const where = async (who: Signed, permission: string) =>
  (await cell.call(listPermittedScopes, { body: { permission } }, who)).scopes.map((s) => s.name).sort();
const may = async (who: Signed, permission: string, scope?: string) =>
  (await cell.call(authorise, { body: { permission, ...(scope ? { scopeId: scopes[scope]!.id } : {}) } }, who)).decision;

before(async () => {
  cell = await startPolicyCell();
  root = await cell.signIn('root@acme.example');
});

after(async () => {
  await cell?.close();
});

describe('scope types and scopes (spec 56.3 to 56.5)', () => {
  test('a super admin creates scope types and top-level scopes; the tree is built by the database', async () => {
    department = (await cell.call(createScopeType, { body: { name: 'Department' } }, root)).id;
    await assert.rejects(cell.call(createScopeType, { body: { name: 'Department' } }, root), { code: 'scope_type.name_taken' });
    for (const [name, parent] of [['engineering', undefined], ['sales', undefined], ['platform', 'engineering']] as const) {
      const scope = await cell.call(createScope, { body: { name, scopeTypeId: department, ...(parent ? { parentScopeId: scopes[parent]!.id } : {}) } }, root);
      scopes[name] = { id: scope.id, version: scope.version };
    }
    const { scopes: tree } = await cell.call(listScopes, { query: {} }, root);
    assert.equal(tree.find((s) => s.id === scopes['platform']!.id)?.depth, 2);
    await assert.rejects(cell.call(createScope, { body: { name: 'engineering', scopeTypeId: department } }, root), { code: 'scope.name_taken' });
  });

  test('an admin of Engineering manages scopes beneath it and nowhere else', async () => {
    eve = await cell.join(root, 'eve@acme.example', 'Admin', scopes['engineering']!.id);
    max = await cell.join(root, 'max@acme.example', 'Member', scopes['platform']!.id);
    sam = await cell.join(root, 'sam@acme.example', 'Member', scopes['sales']!.id);
    const payments = await cell.call(createScope, { body: { name: 'payments', scopeTypeId: department, parentScopeId: scopes['platform']!.id } }, eve);
    scopes['payments'] = { id: payments.id, version: payments.version };
    await assert.rejects(cell.call(createScope, { body: { name: 'emea', scopeTypeId: department, parentScopeId: scopes['sales']!.id } }, eve),
      { category: 'forbidden', code: 'policy.not_permitted' });
    await assert.rejects(cell.call(createScope, { body: { name: 'ops', scopeTypeId: department } }, eve), { code: 'policy.not_permitted' },
      'a top-level scope is a super admin\'s');
    await assert.rejects(cell.call(createScopeType, { body: { name: 'Team' } }, eve), { code: 'policy.not_permitted' });
    const denied = await cell.events('authorisation_denied');
    assert.ok(denied.some((e) => e.detail['permission'] === 'scope.manage' && e.scopeId === scopes['sales']!.id), 'refusals are audited');
  });

  test('the scopes where a member holds a permission: their subtree by the rule authorise uses, offered before they try (W7)', async () => {
    assert.deepEqual(await where(eve, 'scope.manage'), ['engineering', 'payments', 'platform'], 'an admin of Engineering: Engineering and beneath, not Sales');
    assert.deepEqual(await where(root, 'scope.manage'), ['engineering', 'payments', 'platform', 'sales']);
    assert.deepEqual(await where(sam, 'scope.manage'), []);
    assert.deepEqual(await where(eve, 'no.such_permission'), [], 'an unknown permission is held nowhere');
    for (const name of await where(eve, 'scope.manage')) assert.equal(await may(eve, 'scope.manage', name), 'allow', `authorise agrees at ${name}`);
  });

  test('every permission, described, and whether the member holds it anywhere: what the client offers before they try (U1)', async () => {
    const mine = async (who: Signed) => new Map((await cell.call(listMyPermissions, {}, who)).permissions.map((p) => [p.id, p]));
    const eves = await mine(eve);
    const roots = await mine(root);
    assert.equal(eves.size, roots.size, 'the whole catalogue, whoever asks');
    assert.ok([...eves.values()].every((p) => p.description.length > 0), 'each permission says what it allows');
    assert.equal(eves.get('scope.manage')!.held, true, 'held on Engineering');
    assert.equal(roots.get('scope.manage')!.held, true);
    assert.equal((await mine(sam)).get('scope.manage')!.held, false);
    for (const [id, p] of eves) if (p.held) assert.ok(await may(eve, id) === 'allow' || (await where(eve, id)).length > 0, `${id} is held somewhere`);
  });

  test('the directory: every member\'s name and state and every live scope, for any member, never an address (U4)', async () => {
    const seen = await cell.call(listDirectory, {}, sam);
    assert.ok(seen.members.length >= 3);
    assert.ok(seen.members.every((m) => !('email' in m) && m.displayName.length > 0));
    assert.deepEqual(seen.scopes.map((s) => s.name).sort(), (await cell.call(listDirectory, {}, root)).scopes.map((s) => s.name).sort(), 'the same for an admin');
    assert.ok(seen.scopes.some((s) => s.name === 'engineering'));
  });

  test('moving a scope out of the mover\'s subtree needs the new parent too; the move records both paths', async () => {
    await assert.rejects(cell.call(updateScope, { params: { scopeId: scopes['payments']!.id },
      body: { version: scopes['payments']!.version, parentScopeId: scopes['sales']!.id } }, eve), { code: 'policy.not_permitted' });
    const renamed = await cell.call(updateScope, { params: { scopeId: scopes['payments']!.id },
      body: { version: scopes['payments']!.version, name: 'billing' } }, eve);
    const moved = await cell.call(updateScope, { params: { scopeId: scopes['payments']!.id },
      body: { version: renamed.version, parentScopeId: scopes['sales']!.id } }, root);
    scopes['payments'] = { id: moved.id, version: moved.version };
    assert.equal(moved.parentScopeId, scopes['sales']!.id);
    await assert.rejects(cell.call(updateScope, { params: { scopeId: scopes['payments']!.id }, body: { version: 1, name: 'stale' } }, root),
      { code: 'scope.stale' });
    const [event] = await cell.events('scope_moved');
    assert.notEqual(event!.detail['old_path'], event!.detail['new_path']);
    await assert.rejects(cell.call(updateScope, { params: { scopeId: scopes['engineering']!.id },
      body: { version: scopes['engineering']!.version, parentScopeId: scopes['platform']!.id } }, root), { code: 'scope.invalid_move' },
      'never beneath its own descendant');
  });

  test('a scope with members beneath it is not archived until they are reassigned', async () => {
    await assert.rejects(cell.call(archiveScope, { params: { scopeId: scopes['engineering']!.id }, body: { version: scopes['engineering']!.version } }, root),
      { code: 'scope.has_members' });
    const archived = await cell.call(archiveScope, { params: { scopeId: scopes['payments']!.id }, body: { version: scopes['payments']!.version } }, root);
    assert.ok(archived.archivedAt);
  });
});

describe('roles and delegation (spec 56.7, 57.2)', () => {
  let analysts: string;

  test('roles are defined organisation-wide, from the catalogue, never with a Silo staff permission', async () => {
    const role = await cell.call(createRole, { body: { name: 'Analysts', permissions: ['query.compile', 'ontology.view'] } }, root);
    analysts = role.id;
    assert.deepEqual(role.permissions, ['ontology.view', 'query.compile']);
    await assert.rejects(cell.call(createRole, { body: { name: 'Mine', permissions: ['query.compile'] } }, eve), { code: 'policy.not_permitted' });
    await assert.rejects(cell.call(setRolePermissions, { params: { roleId: analysts }, body: { permissions: ['key.rotate'] } }, root),
      { code: 'role.permission_refused' });
    await assert.rejects(cell.call(setRolePermissions, { params: { roleId: analysts }, body: { permissions: ['no.such'] } }, root),
      { code: 'role.unknown_permission' });
    await assert.rejects(cell.call(setRolePermissions, { params: { roleId: cell.roles['Super admin']! }, body: { permissions: [] } }, root),
      { code: 'role.super_admin_fixed' });
    const changed = await cell.call(setRolePermissions, { params: { roleId: analysts }, body: { permissions: ['query.compile'] } }, root);
    assert.deepEqual(changed.permissions, ['query.compile']);
  });

  test('an admin grants within their subtree only, whitelisted roles only; granting what is held changes nothing', async () => {
    await assert.rejects(cell.call(grantRole, { body: { membershipId: sam.membershipId, roleId: cell.roles['Member']!, scopeId: scopes['sales']!.id } }, eve),
      { code: 'policy.not_permitted' });
    await assert.rejects(cell.call(grantRole, { body: { membershipId: max.membershipId, roleId: analysts, scopeId: scopes['platform']!.id } }, eve),
      { code: 'role.grant_refused' }, 'Analysts is not on the Admin role\'s whitelist');
    const first = await cell.call(grantRole, { body: { membershipId: max.membershipId, roleId: cell.roles['Admin']!, scopeId: scopes['platform']!.id } }, eve);
    const again = await cell.call(grantRole, { body: { membershipId: max.membershipId, roleId: cell.roles['Admin']!, scopeId: scopes['platform']!.id } }, eve);
    assert.equal(again.id, first.id);
    assert.equal(first.grantedAtScopeId, scopes['engineering']!.id, 'provenance: the scope eve acted under');
    const delegated = await cell.events('admin_delegated');
    assert.ok(delegated.some((e) => e.subjectMembershipId === max.membershipId && e.detail['granted_at_scope_id'] === scopes['engineering']!.id));
    max = await cell.signIn('max@acme.example');
    assert.equal(await may(max, 'scope.manage', 'platform'), 'allow');
    assert.equal(await may(max, 'scope.manage', 'engineering'), 'deny');
  });

  test('revocation is by the issuer, an admin over where it was issued, or a super admin; a super admin revoking is recorded', async () => {
    const grant = await cell.call(grantRole, { body: { membershipId: max.membershipId, roleId: cell.roles['Member']!, scopeId: scopes['engineering']!.id } }, eve);
    await assert.rejects(cell.call(revokeRole, { params: { assignmentId: grant.id } }, sam), { code: 'role.revoke_refused' });
    const revoked = await cell.call(revokeRole, { params: { assignmentId: grant.id } }, root);
    assert.ok(revoked.revokedAt);
    assert.ok((await cell.events('grant_revoked_by_other_admin')).some((e) => e.resource?.id === grant.id));
  });

  test('no cascade: grants an admin issued survive their revocation and surface on the orphan list above', async () => {
    const eveAdmin = (await cell.call(listRoleAssignments, { query: { membershipId: eve.membershipId } }, root)).assignments
      .find((a) => a.roleId === cell.roles['Admin'] && a.onScopeId === scopes['engineering']!.id)!;
    await cell.call(revokeRole, { params: { assignmentId: eveAdmin.id } }, root);
    const { assignments } = await cell.call(listOrphanedGrants, {}, root);
    assert.ok(assignments.some((a) => a.membershipId === max.membershipId && a.grantedBy === eve.membershipId && a.revokedAt === null));
    assert.equal(await may(max, 'scope.manage', 'platform'), 'allow', 'max keeps the access eve gave');
    assert.ok((await cell.events('grant_orphaned')).some((e) => e.detail['issuer_membership_id'] === eve.membershipId));
    assert.ok((await cell.events('admin_revoked')).length >= 1);
    // An admin sees only what was issued under scopes they administer: max administers Platform, not Engineering.
    assert.deepEqual((await cell.call(listOrphanedGrants, {}, max)).assignments, []);
  });

  test('a role in use is not retired; a seeded role never is', async () => {
    await assert.rejects(cell.call(retireRole, { params: { roleId: cell.roles['Member']! } }, root), { code: 'role.system' });
    const unused = await cell.call(createRole, { body: { name: 'Unused', permissions: ['ontology.view'] } }, root);
    assert.ok((await cell.call(retireRole, { params: { roleId: unused.id } }, root)).retiredAt);
  });
});

describe('scope memberships and members (spec 56.4, 55.7, 56.8)', () => {
  test('an admin adds and removes scope memberships within their subtree; removal keeps the row out of resolution', async () => {
    const added = await cell.call(addScopeMember, { body: { membershipId: sam.membershipId, scopeId: scopes['platform']!.id } }, max);
    assert.equal(added.inactiveSince, null);
    // Listed with its scope, by the id a removal names (D272); refused outside the admin's subtree.
    assert.ok((await cell.call(listScopeMembers, { params: { scopeId: scopes['platform']!.id } }, max)).members.some((m) => m.id === added.id && m.membershipId === sam.membershipId));
    await assert.rejects(cell.call(listScopeMembers, { params: { scopeId: scopes['sales']!.id } }, max), { code: 'policy.not_permitted' });
    await assert.rejects(cell.call(addScopeMember, { body: { membershipId: max.membershipId, scopeId: scopes['sales']!.id } }, max),
      { code: 'policy.not_permitted' });
    const removed = await cell.call(removeScopeMember, { params: { scopeMembershipId: added.id } }, max);
    assert.ok(removed.inactiveSince);
    assert.equal((await cell.call(listScopeMembers, { params: { scopeId: scopes['platform']!.id } }, max)).members.some((m) => m.id === added.id), false, 'removed, no longer listed');
    const again = await cell.call(addScopeMember, { body: { membershipId: sam.membershipId, scopeId: scopes['platform']!.id } }, max);
    assert.equal(again.id, added.id, 'the same row returns to resolution');
    await cell.call(removeScopeMember, { params: { scopeMembershipId: added.id } }, max);
  });

  test('suspension removes all access at once, silencing grants and revoking sessions; reinstatement restores them', async () => {
    await assert.rejects(cell.call(suspendMember, { params: { membershipId: sam.membershipId } }, max), { code: 'policy.not_permitted' },
      'sam sits in Sales, outside max\'s subtree');
    await assert.rejects(cell.call(suspendMember, { params: { membershipId: root.membershipId } }, max), { code: 'policy.not_permitted' },
      'a super admin answers to super admins');
    await assert.rejects(cell.call(suspendMember, { params: { membershipId: root.membershipId } }, root), { code: 'member.self' });

    const suspended = await cell.call(suspendMember, { params: { membershipId: max.membershipId } }, root);
    assert.equal(suspended.status, 'suspended');
    assert.ok(suspended.grantsSilenced >= 2);
    assert.equal(suspended.sessionsRevoked >= 1, true);
    assert.equal((await cell.call(authorise, { body: { permission: 'query.compile' } }, max)).reason, 'session_unknown');
    await assert.rejects(cell.signIn('max@acme.example'), (error: { code?: string }) => typeof error.code === 'string');
    const { rows } = await cell.migrate.query('select count(*)::int as n from iam.role_assignments where membership_id = $1 and silenced_at is not null and revoked_at is null',
      [max.membershipId]);
    assert.equal(rows[0].n, suspended.grantsSilenced);
    for (const name of ['member_suspended', 'grants_silenced', 'membership_suspended_with_active_grants', 'session_revoked']) {
      assert.ok((await cell.events(name)).some((e) => e.subjectMembershipId === max.membershipId), name);
    }

    const reinstated = await cell.call(reinstateMember, { params: { membershipId: max.membershipId } }, root);
    assert.equal(reinstated.status, 'active');
    assert.equal(reinstated.grantsRestored, suspended.grantsSilenced);
    max = await cell.signIn('max@acme.example');
    assert.equal(await may(max, 'scope.manage', 'platform'), 'allow', 'the prior state, restored');
  });

  test('removal also takes scopes out of resolution; reinstatement brings them back', async () => {
    const removed = await cell.call(removeMember, { params: { membershipId: max.membershipId } }, root);
    assert.equal(removed.status, 'removed');
    assert.deepEqual(removed.scopeIds, []);
    assert.ok((await cell.events('member_removed')).some((e) => e.subjectMembershipId === max.membershipId));
    await assert.rejects(cell.call(suspendMember, { params: { membershipId: max.membershipId } }, root), { code: 'member.status' });
    const back = await cell.call(reinstateMember, { params: { membershipId: max.membershipId } }, root);
    assert.deepEqual(back.scopeIds, [scopes['platform']!.id]);
    const listed = (await cell.call(listMembers, { query: { scopeId: scopes['engineering']!.id } }, eve)).members;
    assert.ok(listed.some((m) => m.membershipId === max.membershipId && m.status === 'active'));
    // Each member by name and address, as the pages that say who did something show them.
    assert.deepEqual(listed.filter((m) => m.membershipId === max.membershipId).map((m) => [m.displayName, m.email]), [['New Person', 'max@acme.example']]);
    void uuidv7;
  });
});
