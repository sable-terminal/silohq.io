// Administration (spec 56, 57.2): scope types and scopes, custom roles, role assignments,
// scope memberships and the orphan list. Each operation is decided here by policy itself
// and audited in the transaction of the change; the database enforces the delegation
// rules again on every assignment (spec 56.7), so nothing here can grant what a trigger
// would refuse. The tiers (spec 56.5): scope types and top-level scopes need a super admin;
// an admin manages scopes within their subtree; roles are defined organisation-wide.

import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import {
  membershipRepo, roleAssignmentRepo, roleGrantableRoleRepo, rolePermissionRepo, roleRepo, scopeMembershipRepo, scopeRepo,
  scopeTypeRepo,
} from '../../repos/iam/index.repo.ts';
import type { RoleWithPermissions } from '../../repos/iam/role.repo.ts';
import type { RoleAssignment } from '../../models/iam/roleAssignment.model.ts';
import type { Scope } from '../../models/iam/scope.model.ts';
import type { ScopeMembership } from '../../models/iam/scopeMembership.model.ts';
import type { ScopeType } from '../../models/iam/scopeType.model.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  auditActorOf, contextOf, demand, isCheckViolation, isInsufficientPrivilege, isUniqueViolation, may, membershipOf, recordPolicyEvent,
  requireActor, type AdminDeps,
} from './deps.service.ts';
import type { Subject } from './policy.service.ts';

const tx = <T>(deps: AdminDeps, subject: Subject, work: (db: Queryable) => Promise<T>): Promise<T> =>
  inTransaction(deps.databases.pool('control'), contextOf(subject.actor), work);

const event = (ctx: HandlerContext, subject: Subject) => ({
  organisationId: subject.actor.organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor),
});

const notFound = (what: string, code: string): AppError => new AppError('not_found', `no such ${what}`, { code });

/** Whether the actor administers any scope a membership sits in, or the whole organisation, with this permission. */
export async function administersMember(deps: AdminDeps, subject: Subject, membershipId: string, permission: string): Promise<boolean> {
  if (await may(deps, subject, permission, { organisationWide: true })) return true;
  const scopes = await tx(deps, subject, (db) => scopeMembershipRepo.activeScopes(db, membershipId));
  for (const scope of scopes) if (await may(deps, subject, permission, { scopeId: scope.scopeId })) return true;
  return false;
}

// ----------------------------------------------------------------------------- scope types and scopes

export async function createScopeType(deps: AdminDeps, ctx: HandlerContext, input: { name: string; icon?: string | undefined;
  colour?: string | undefined }): Promise<ScopeType> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'scope_type.manage', { organisationWide: true });
  try {
    return await tx(deps, subject, async (db) => {
      const row = await scopeTypeRepo.insert(db, {
        id: uuidv7(), organisationId: subject.actor.organisationId, name: input.name, icon: input.icon ?? null, colour: input.colour ?? null,
      });
      await recordPolicyEvent(db, { ...event(ctx, subject), event: 'scope_type_created', resource: { type: 'scope_type', id: row.id } });
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'a scope type with that name exists', { code: 'scope_type.name_taken' });
    throw error;
  }
}

export async function listScopeTypes(deps: AdminDeps, ctx: HandlerContext): Promise<ScopeType[]> {
  const subject = await requireActor(deps, ctx);
  return tx(deps, subject, (db) => scopeTypeRepo.list(db));
}

export async function createScope(deps: AdminDeps, ctx: HandlerContext, input: { name: string; scopeTypeId: string;
  parentScopeId?: string | undefined }): Promise<Scope> {
  const subject = await requireActor(deps, ctx);
  const actor = membershipOf(subject);
  // A top-level scope is the organisation's, so a super admin's (spec 56.5).
  await demand(deps, ctx, subject, 'scope.manage', input.parentScopeId === undefined ? { organisationWide: true } : { scopeId: input.parentScopeId });
  try {
    return await tx(deps, subject, async (db) => {
      if (!await scopeTypeRepo.findById(db, input.scopeTypeId)) throw notFound('scope type', 'scope_type.not_found');
      if (input.parentScopeId !== undefined) {
        const parent = await scopeRepo.findById(db, input.parentScopeId);
        if (!parent || parent.archivedAt !== null) throw notFound('scope', 'scope.not_found');
      }
      // The path and depth are the trigger's (iam.scopes_maintain_path); these are placeholders.
      const row = await scopeRepo.insert(db, {
        id: uuidv7(), organisationId: subject.actor.organisationId, scopeTypeId: input.scopeTypeId, name: input.name,
        parentScopeId: input.parentScopeId ?? null, path: 'x', depth: 1, createdBy: actor,
      });
      await recordPolicyEvent(db, {
        ...event(ctx, subject), event: 'scope_created', scopeId: row.id, resource: { type: 'scope', id: row.id },
        detail: { parent_scope_id: row.parentScopeId, depth: row.depth },
      });
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'a scope with that name exists there', { code: 'scope.name_taken' });
    if (isCheckViolation(error)) throw new AppError('validation', 'scopes nest at most 12 deep (spec 56.4)', { code: 'scope.too_deep' });
    throw error;
  }
}

export async function listScopes(deps: AdminDeps, ctx: HandlerContext, includeArchived: boolean): Promise<Scope[]> {
  const subject = await requireActor(deps, ctx);
  return tx(deps, subject, (db) => scopeRepo.list(db, includeArchived));
}

export async function updateScope(deps: AdminDeps, ctx: HandlerContext, scopeId: string, input: { version: number;
  name?: string | undefined; parentScopeId?: string | null | undefined }): Promise<Scope> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'scope.manage', { scopeId });
  const moving = input.parentScopeId !== undefined;
  if (moving) {
    // Moving a scope out of one's own subtree gives authority away, so it needs the new
    // parent too (organisation-wide for the top level): a super admin, or an admin of both
    // places (spec 56.13, the proposal for regulated customers).
    await demand(deps, ctx, subject, 'scope.manage', input.parentScopeId === null ? { organisationWide: true } : { scopeId: input.parentScopeId! });
  }
  try {
    return await tx(deps, subject, async (db) => {
      const before = await scopeRepo.findById(db, scopeId);
      if (!before) throw notFound('scope', 'scope.not_found');
      if (before.archivedAt !== null) throw new AppError('conflict', 'an archived scope does not change', { code: 'scope.archived' });
      const updated = await scopeRepo.updateAtVersion(db, scopeId, input.version, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(moving ? { parentScopeId: input.parentScopeId ?? null } : {}),
      });
      if (!updated) throw new AppError('conflict', 'the scope changed since it was read', { code: 'scope.stale' });
      if (input.name !== undefined && input.name !== before.name) {
        await recordPolicyEvent(db, { ...event(ctx, subject), event: 'scope_renamed', scopeId, resource: { type: 'scope', id: scopeId } });
      }
      if (moving && before.parentScopeId !== updated.parentScopeId) {
        // Moving a node changes who administers everything beneath it: both paths are recorded (spec 56.12).
        await recordPolicyEvent(db, {
          ...event(ctx, subject), event: 'scope_moved', scopeId, resource: { type: 'scope', id: scopeId },
          detail: { old_path: before.path, new_path: updated.path, old_parent_scope_id: before.parentScopeId, new_parent_scope_id: updated.parentScopeId },
        });
      }
      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'a scope with that name exists there', { code: 'scope.name_taken' });
    if (isCheckViolation(error)) {
      throw new AppError('validation', 'a scope cannot move beneath itself or deeper than 12 levels (spec 56.4)', { code: 'scope.invalid_move' });
    }
    throw error;
  }
}

export async function archiveScope(deps: AdminDeps, ctx: HandlerContext, scopeId: string, version: number): Promise<Scope> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'scope.manage', { scopeId });
  try {
    return await tx(deps, subject, async (db) => {
      const before = await scopeRepo.findById(db, scopeId);
      if (!before) throw notFound('scope', 'scope.not_found');
      if (before.archivedAt !== null) return before;
      const updated = await scopeRepo.updateAtVersion(db, scopeId, version, { archivedAt: new Date().toISOString() });
      if (!updated) throw new AppError('conflict', 'the scope changed since it was read', { code: 'scope.stale' });
      await recordPolicyEvent(db, { ...event(ctx, subject), event: 'scope_archived', scopeId, resource: { type: 'scope', id: scopeId } });
      return updated;
    });
  } catch (error) {
    if (isCheckViolation(error)) {
      throw new AppError('conflict', 'reassign the members beneath this scope before archiving it (spec 56.4)', { code: 'scope.has_members' });
    }
    throw error;
  }
}

// ----------------------------------------------------------------------------- roles

async function readRole(db: Queryable, roleId: string): Promise<RoleWithPermissions> {
  const role = (await roleRepo.listWithPermissions(db)).find((r) => r.id === roleId);
  if (!role) throw notFound('role', 'role.not_found');
  return role;
}

function checkCatalogue(deps: AdminDeps, permissions: readonly string[]): void {
  const unknown = permissions.filter((p) => !deps.catalogue.has(p));
  if (unknown.length > 0) {
    throw new AppError('validation', 'not permissions of the catalogue (spec 76)', { code: 'role.unknown_permission', details: { count: String(unknown.length) } });
  }
}

const roleRefused = (): AppError => new AppError('forbidden',
  'a customer role holds no Silo staff permission, and organisation-wide-only permissions stay in Super admin (spec 56.7 rule 4)',
  { code: 'role.permission_refused' });

// Roles are the organisation's: defining one is an organisation-wide act of delegation.
export async function createRole(deps: AdminDeps, ctx: HandlerContext, input: { name: string; permissions: readonly string[];
  grantableRoleIds: readonly string[] }): Promise<RoleWithPermissions> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'admin.delegate', { organisationWide: true });
  checkCatalogue(deps, input.permissions);
  const organisationId = subject.actor.organisationId;
  try {
    return await tx(deps, subject, async (db) => {
      const role = await roleRepo.insert(db, { id: uuidv7(), organisationId, name: input.name });
      await rolePermissionRepo.replace(db, organisationId, role.id, [...new Set(input.permissions)]);
      for (const grantable of new Set(input.grantableRoleIds)) {
        if (!await roleRepo.findById(db, grantable)) throw notFound('role', 'role.not_found');
        await roleGrantableRoleRepo.insert(db, { organisationId, grantingRoleId: role.id, grantableRoleId: grantable });
      }
      await recordPolicyEvent(db, {
        ...event(ctx, subject), event: 'role_defined', resource: { type: 'role', id: role.id },
        detail: { permission_count: new Set(input.permissions).size, grantable_role_count: new Set(input.grantableRoleIds).size },
      });
      return readRole(db, role.id);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'a role with that name exists', { code: 'role.name_taken' });
    if (isInsufficientPrivilege(error)) throw roleRefused();
    throw error;
  }
}

export async function listRoles(deps: AdminDeps, ctx: HandlerContext): Promise<RoleWithPermissions[]> {
  const subject = await requireActor(deps, ctx);
  return tx(deps, subject, (db) => roleRepo.listWithPermissions(db));
}

export async function setRolePermissions(deps: AdminDeps, ctx: HandlerContext, roleId: string, permissions: readonly string[])
  : Promise<RoleWithPermissions> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'admin.delegate', { organisationWide: true });
  checkCatalogue(deps, permissions);
  try {
    return await tx(deps, subject, async (db) => {
      const role = await readRole(db, roleId);
      // Super admin holds every customer permission by definition (spec 56.5).
      if (role.systemRole && role.name === 'Super admin') {
        throw new AppError('forbidden', 'the Super admin role holds every customer permission', { code: 'role.super_admin_fixed' });
      }
      if (role.retiredAt !== null) throw new AppError('conflict', 'a retired role does not change', { code: 'role.retired' });
      const { added, removed } = await rolePermissionRepo.replace(db, subject.actor.organisationId, roleId, [...new Set(permissions)]);
      if (added + removed > 0) {
        await recordPolicyEvent(db, { ...event(ctx, subject), event: 'role_changed', resource: { type: 'role', id: roleId }, detail: { added, removed } });
      }
      return readRole(db, roleId);
    });
  } catch (error) {
    // At commit, the deferred check refuses a role a service principal holds gaining an authorising permission (spec 60.6).
    if (isInsufficientPrivilege(error)) throw roleRefused();
    throw error;
  }
}

export async function retireRole(deps: AdminDeps, ctx: HandlerContext, roleId: string): Promise<RoleWithPermissions> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'admin.delegate', { organisationWide: true });
  return tx(deps, subject, async (db) => {
    const role = await readRole(db, roleId);
    if (role.systemRole) throw new AppError('forbidden', 'a seeded role is not retired', { code: 'role.system' });
    if (role.retiredAt !== null) return role;
    if (await roleRepo.hasLiveAssignments(db, roleId)) {
      throw new AppError('conflict', 'revoke every assignment of this role before retiring it', { code: 'role.in_use' });
    }
    await roleRepo.update(db, roleId, { retiredAt: new Date().toISOString(), version: role.version + 1 });
    await recordPolicyEvent(db, { ...event(ctx, subject), event: 'role_retired', resource: { type: 'role', id: roleId } });
    return readRole(db, roleId);
  });
}

// ----------------------------------------------------------------------------- assignments

const scimManaged = () => new AppError('conflict',
  'this member\'s roles come from your identity provider: change their groups there, or how a group maps to roles in Silo', { code: 'role.scim_managed' });

export async function grantRole(deps: AdminDeps, ctx: HandlerContext, input: { membershipId: string; roleId: string;
  scopeId?: string | undefined; expiresAt?: string | undefined }): Promise<RoleAssignment> {
  const subject = await requireActor(deps, ctx);
  const granter = membershipOf(subject);
  const scopeId = input.scopeId ?? null;
  await demand(deps, ctx, subject, 'admin.delegate', scopeId === null ? { organisationWide: true } : { scopeId });
  const organisationId = subject.actor.organisationId;
  try {
    return await tx(deps, subject, async (db) => {
      const target = await membershipRepo.findById(db, input.membershipId);
      if (!target || target.status !== 'active') throw notFound('active member', 'member.not_found');
      // The identity provider is the source of truth for a SCIM-managed member (decision 2026-11-14).
      if (target.scimManaged) throw scimManaged();
      // Granting what is already held changes nothing.
      const held = (await roleAssignmentRepo.listForMembership(db, input.membershipId))
        .find((a) => a.roleId === input.roleId && a.onScopeId === scopeId && a.onConnectionId === null && a.onSiloId === null
          && a.onViewId === null && a.onObjectTypeId === null && a.onAppId === null);
      if (held) return held;
      const refusal = await roleAssignmentRepo.grantRefusal(db, organisationId, granter, input.roleId, scopeId);
      if (refusal !== null) throw new AppError('forbidden', `that role cannot be given there: ${refusal}`, { code: 'role.grant_refused' });
      const actedAt = scopeId === null ? null : await roleAssignmentRepo.actingScope(db, organisationId, granter, scopeId);
      const row = await roleAssignmentRepo.insert(db, {
        id: uuidv7(), organisationId, membershipId: input.membershipId, roleId: input.roleId, onScopeId: scopeId, grantedBy: granter,
        grantedAtScopeId: actedAt, expiresAt: input.expiresAt ?? null,
      });
      const role = await readRole(db, input.roleId);
      const base = { ...event(ctx, subject), subjectMembershipId: input.membershipId, scopeId, resource: { type: 'role_assignment', id: row.id } };
      await recordPolicyEvent(db, { ...base, event: 'role_granted', detail: { role_id: input.roleId, granted_at_scope_id: actedAt } });
      if (role.permissions.includes('admin.delegate')) {
        // The chain a reviewer walks back from a compromised account (spec 56.12).
        await recordPolicyEvent(db, {
          ...base, event: 'admin_delegated',
          detail: { role_id: input.roleId, granted_at_scope_id: actedAt, target_scope_id: scopeId, permission_count: role.permissions.length },
        });
      }
      return row;
    });
  } catch (error) {
    if (isInsufficientPrivilege(error)) throw new AppError('forbidden', 'the delegation rules refuse that grant (spec 56.7)', { code: 'role.grant_refused' });
    throw error;
  }
}

export async function revokeRole(deps: AdminDeps, ctx: HandlerContext, assignmentId: string): Promise<RoleAssignment> {
  const subject = await requireActor(deps, ctx);
  const revoker = membershipOf(subject);
  const organisationId = subject.actor.organisationId;
  try {
    return await tx(deps, subject, async (db) => {
      const before = await roleAssignmentRepo.findById(db, assignmentId);
      if (!before) throw notFound('role assignment', 'role_assignment.not_found');
      if (before.revokedAt !== null) return before;
      if (before.scimGroupMappingId !== null || (await membershipRepo.findById(db, before.membershipId))?.scimManaged === true) throw scimManaged();
      // The revocation trigger decides who may (spec 56.8): the issuer, an admin over the
      // scope it was issued under, or a super admin.
      const row = (await roleAssignmentRepo.update(db, assignmentId, { revokedAt: new Date().toISOString(), revokedBy: revoker }))!;
      const role = await readRole(db, before.roleId);
      const base = { ...event(ctx, subject), subjectMembershipId: before.membershipId, scopeId: before.onScopeId,
        resource: { type: 'role_assignment', id: assignmentId } };
      await recordPolicyEvent(db, { ...base, event: 'role_revoked', detail: { role_id: before.roleId } });
      if (revoker !== before.grantedBy && before.grantedBy !== before.membershipId
        && await roleAssignmentRepo.isSuperAdmin(db, organisationId, revoker)) {
        await recordPolicyEvent(db, { ...base, event: 'grant_revoked_by_other_admin', detail: { granted_by: before.grantedBy } });
      }
      if (role.permissions.includes('admin.delegate')) {
        await recordPolicyEvent(db, { ...base, event: 'admin_revoked', detail: { role_id: before.roleId } });
        // No cascade: what they issued stays, and surfaces on the orphan list (spec 56.8).
        const issued = await roleAssignmentRepo.countLiveIssuedBy(db, before.membershipId);
        if (issued > 0) {
          await recordPolicyEvent(db, { ...base, event: 'grant_orphaned', detail: { issuer_membership_id: before.membershipId, grant_count: issued } });
        }
      }
      return row;
    });
  } catch (error) {
    if (isInsufficientPrivilege(error)) {
      throw new AppError('forbidden', 'only the issuer, an admin over the scope it was issued under, or a super admin may revoke this',
        { code: 'role.revoke_refused' });
    }
    throw error;
  }
}

export async function listRoleAssignments(deps: AdminDeps, ctx: HandlerContext, membershipId: string): Promise<RoleAssignment[]> {
  const subject = await requireActor(deps, ctx);
  if (subject.actor.membershipId !== membershipId && !await administersMember(deps, subject, membershipId, 'admin.delegate')) {
    await demand(deps, ctx, subject, 'admin.delegate', { organisationWide: true });
  }
  return tx(deps, subject, (db) => roleAssignmentRepo.listForMembership(db, membershipId));
}

export async function listOrphanedGrants(deps: AdminDeps, ctx: HandlerContext): Promise<RoleAssignment[]> {
  const subject = await requireActor(deps, ctx);
  if (await may(deps, subject, 'admin.delegate', { organisationWide: true })) {
    return tx(deps, subject, (db) => roleAssignmentRepo.orphans(db, subject.actor.organisationId, null));
  }
  // The subtrees the reader administers: grants issued under scopes within them.
  const paths = subject.authority.grants.filter((g) => g.permissions.includes('admin.delegate') && g.scopePath !== null && g.resourceType === null)
    .map((g) => g.scopePath!);
  if (paths.length === 0) await demand(deps, ctx, subject, 'admin.delegate', { organisationWide: true });
  return tx(deps, subject, (db) => roleAssignmentRepo.orphans(db, subject.actor.organisationId, paths));
}

// ----------------------------------------------------------------------------- scope memberships

export async function addScopeMember(deps: AdminDeps, ctx: HandlerContext, input: { membershipId: string; scopeId: string;
  isPrimary: boolean }): Promise<ScopeMembership> {
  const subject = await requireActor(deps, ctx);
  const actor = membershipOf(subject);
  await demand(deps, ctx, subject, 'scope.manage', { scopeId: input.scopeId });
  try {
    return await tx(deps, subject, async (db) => {
      const target = await membershipRepo.findById(db, input.membershipId);
      if (!target || target.status !== 'active') throw notFound('active member', 'member.not_found');
      const scope = await scopeRepo.findById(db, input.scopeId);
      if (!scope || scope.archivedAt !== null) throw notFound('scope', 'scope.not_found');
      const existing = await scopeMembershipRepo.findByMembershipIdAndScopeId(db, {
        organisationId: subject.actor.organisationId, membershipId: input.membershipId, scopeId: input.scopeId,
      });
      if (existing && existing.inactiveSince === null) return existing;
      const row = existing
        ? (await scopeMembershipRepo.update(db, existing.id, { inactiveSince: null, isPrimary: input.isPrimary }))!
        : await scopeMembershipRepo.insert(db, {
          id: uuidv7(), organisationId: subject.actor.organisationId, membershipId: input.membershipId, scopeId: input.scopeId,
          isPrimary: input.isPrimary, addedBy: actor,
        });
      await recordPolicyEvent(db, {
        ...event(ctx, subject), event: 'scope_membership_added', subjectMembershipId: input.membershipId, scopeId: input.scopeId,
        resource: { type: 'scope_membership', id: row.id },
      });
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'the member already has a primary scope', { code: 'scope_membership.primary_taken' });
    throw error;
  }
}

/** A scope's current members (D272): scope.manage at the scope. */
export async function listScopeMembers(deps: AdminDeps, ctx: HandlerContext, scopeId: string): Promise<ScopeMembership[]> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'scope.manage', { scopeId });
  return tx(deps, subject, async (db) => {
    const scope = await scopeRepo.findById(db, scopeId);
    if (!scope) throw notFound('scope', 'scope.not_found');
    return scopeMembershipRepo.activeForScope(db, scopeId);
  });
}

export async function removeScopeMember(deps: AdminDeps, ctx: HandlerContext, scopeMembershipId: string): Promise<ScopeMembership> {
  const subject = await requireActor(deps, ctx);
  const row = await tx(deps, subject, (db) => scopeMembershipRepo.findById(db, scopeMembershipId));
  if (!row) throw notFound('scope membership', 'scope_membership.not_found');
  await demand(deps, ctx, subject, 'scope.manage', { scopeId: row.scopeId });
  if (row.inactiveSince !== null) return row;
  return tx(deps, subject, async (db) => {
    const updated = (await scopeMembershipRepo.update(db, scopeMembershipId, { inactiveSince: new Date().toISOString(), isPrimary: false }))!;
    await recordPolicyEvent(db, {
      ...event(ctx, subject), event: 'scope_membership_removed', subjectMembershipId: row.membershipId, scopeId: row.scopeId,
      resource: { type: 'scope_membership', id: row.id },
    });
    return updated;
  });
}
