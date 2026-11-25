// Administration over the API (spec 56, 55.7, 57.2): scope types and scopes, custom
// roles, role assignments, scope memberships, and suspending, removing and reinstating a
// membership. The policy service decides every one itself and the database enforces the
// delegation rules again (spec 56.7), so the API can never grant what a trigger refuses.
//
// Creates are safe to retry without a key: each has a natural unique key. Granting what is
// already held returns the live grant; creating a named thing that exists is a conflict.

import { z } from 'zod';
import { roleAssignmentSchema } from '../../schemas/iam/roleAssignment.schema.ts';
import { scopeSchema } from '../../schemas/iam/scope.schema.ts';
import { scopeTypeSchema } from '../../schemas/iam/scopeType.schema.ts';
import { defineContract } from '../endpoint.contract.ts';

const CALLERS = ['gateway'] as const;
const READERS = ['gateway', 'admin-portal'] as const;
const name = z.string().trim().min(1).max(200);
const permissionId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

export const scopeTypeView = scopeTypeSchema.pick({ id: true, name: true, icon: true, colour: true });
export const scopeView = scopeSchema.pick({
  id: true, scopeTypeId: true, name: true, parentScopeId: true, depth: true, archivedAt: true, version: true,
});
export const roleView = z.object({
  id: z.uuid(), name: z.string(), systemRole: z.boolean(), retiredAt: z.string().nullable(), version: z.number().int(),
  permissions: z.array(z.string()), grantableRoleIds: z.array(z.uuid()),
});
export const roleAssignmentView = roleAssignmentSchema.pick({
  id: true, membershipId: true, roleId: true, onScopeId: true, onConnectionId: true, onSiloId: true, onViewId: true,
  onObjectTypeId: true, onAppId: true, grantedBy: true, grantedAtScopeId: true, grantedAt: true, expiresAt: true,
  revokedAt: true, silencedAt: true,
});
export const memberView = z.object({
  membershipId: z.uuid(),
  /** The person's name, as their account holds it; and the address they sign in with. */
  displayName: z.string(),
  email: z.string(),
  status: z.enum(['invited', 'active', 'suspended', 'removed']),
  joinedAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  removedAt: z.string().nullable(),
  scopeIds: z.array(z.uuid()),
});

// ----------------------------------------------------------------------------- scopes

export const createScopeType = defineContract({
  service: 'policy', name: 'createScopeType', method: 'POST', path: '/v1/scope-types', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ name, icon: z.string().max(64).optional(), colour: z.string().max(32).optional() }),
  response: scopeTypeView, status: 201, maxBodyBytes: 2048,
});

export const listScopeTypes = defineContract({
  service: 'policy', name: 'listScopeTypes', method: 'GET', path: '/v1/scope-types', callers: READERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({ scopeTypes: z.array(scopeTypeView) }),
});

export const createScope = defineContract({
  service: 'policy', name: 'createScope', method: 'POST', path: '/v1/scopes', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ name, scopeTypeId: z.uuid(), parentScopeId: z.uuid().optional() }),
  response: scopeView, status: 201, maxBodyBytes: 2048,
});

export const listScopes = defineContract({
  service: 'policy', name: 'listScopes', method: 'GET', path: '/v1/scopes', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ includeArchived: z.enum(['true', 'false']).default('false') }),
  response: z.object({ scopes: z.array(scopeView) }),
});

const scopeId = z.strictObject({ scopeId: z.uuid() });

export const updateScope = defineContract({
  service: 'policy', name: 'updateScope', method: 'PATCH', path: '/v1/scopes/:scopeId', callers: CALLERS,
  // A rename or a move, at the version read; the same change again changes nothing.
  context: 'organisation', idempotency: 'none',
  params: scopeId,
  body: z.strictObject({
    version: z.int().min(1),
    name: name.optional(),
    /** A move: the new parent, or null for the top level. Moving out of the mover's own subtree needs a super admin. */
    parentScopeId: z.uuid().nullable().optional(),
  }).refine((b) => b.name !== undefined || b.parentScopeId !== undefined, 'a rename, a move, or both'),
  response: scopeView, maxBodyBytes: 2048,
});

export const archiveScope = defineContract({
  service: 'policy', name: 'archiveScope', method: 'POST', path: '/v1/scopes/:scopeId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: scopeId,
  body: z.strictObject({ version: z.int().min(1) }),
  response: scopeView, maxBodyBytes: 512,
});

// ----------------------------------------------------------------------------- roles

export const createRole = defineContract({
  service: 'policy', name: 'createRole', method: 'POST', path: '/v1/roles', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    name,
    permissions: z.array(permissionId).max(200),
    /** Roles a holder of this one may assign (spec 56.7 rule 5). */
    grantableRoleIds: z.array(z.uuid()).max(50).default([]),
  }),
  response: roleView, status: 201, maxBodyBytes: 16_384,
});

export const listRoles = defineContract({
  service: 'policy', name: 'listRoles', method: 'GET', path: '/v1/roles', callers: READERS,
  context: 'organisation', idempotency: 'none',
  response: z.object({ roles: z.array(roleView) }),
});

const roleId = z.strictObject({ roleId: z.uuid() });

export const setRolePermissions = defineContract({
  service: 'policy', name: 'setRolePermissions', method: 'PUT', path: '/v1/roles/:roleId/permissions', callers: CALLERS,
  // The whole set replaces the last; the same set again changes nothing.
  context: 'organisation', idempotency: 'none',
  params: roleId,
  body: z.strictObject({ permissions: z.array(permissionId).max(200) }),
  response: roleView, maxBodyBytes: 16_384,
});

export const retireRole = defineContract({
  service: 'policy', name: 'retireRole', method: 'POST', path: '/v1/roles/:roleId/retire', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: roleId,
  response: roleView,
});

// ----------------------------------------------------------------------------- assignments

export const grantRole = defineContract({
  service: 'policy', name: 'grantRole', method: 'POST', path: '/v1/role-assignments', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    membershipId: z.uuid(),
    roleId: z.uuid(),
    /** The scope it applies on; absent for organisation-wide (super admins only, spec 56.7 rule 3). */
    scopeId: z.uuid().optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  }),
  response: roleAssignmentView, status: 201, maxBodyBytes: 1024,
});

export const revokeRole = defineContract({
  service: 'policy', name: 'revokeRole', method: 'POST', path: '/v1/role-assignments/:assignmentId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ assignmentId: z.uuid() }),
  response: roleAssignmentView,
});

export const listRoleAssignments = defineContract({
  service: 'policy', name: 'listRoleAssignments', method: 'GET', path: '/v1/role-assignments', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ membershipId: z.uuid() }),
  response: z.object({ assignments: z.array(roleAssignmentView) }),
});

export const listOrphanedGrants = defineContract({
  service: 'policy', name: 'listOrphanedGrants', method: 'GET', path: '/v1/role-assignments/orphans', callers: READERS,
  // Grants whose issuer lost the authority (spec 56.8), for the admins above: those issued
  // under scopes the reader administers, or every one for a super admin.
  context: 'organisation', idempotency: 'none',
  response: z.object({ assignments: z.array(roleAssignmentView) }),
});

// ----------------------------------------------------------------------------- scope memberships

export const scopeMembershipView = z.object({ id: z.uuid(), membershipId: z.uuid(), scopeId: z.uuid(), isPrimary: z.boolean(),
  inactiveSince: z.string().nullable() });

export const addScopeMember = defineContract({
  service: 'policy', name: 'addScopeMember', method: 'POST', path: '/v1/scope-memberships', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ membershipId: z.uuid(), scopeId: z.uuid(), isPrimary: z.boolean().default(false) }),
  response: scopeMembershipView, status: 201, maxBodyBytes: 512,
});

/** A scope's current members, each with the scope membership a removal names (D272). scope.manage at the scope. */
export const listScopeMembers = defineContract({
  service: 'policy', name: 'listScopeMembers', method: 'GET', path: '/v1/scopes/:scopeId/members', callers: READERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scopeId: z.uuid() }),
  response: z.object({ members: z.array(scopeMembershipView) }),
});

export const removeScopeMember = defineContract({
  service: 'policy', name: 'removeScopeMember', method: 'POST', path: '/v1/scope-memberships/:scopeMembershipId/remove',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ scopeMembershipId: z.uuid() }),
  response: scopeMembershipView,
});

// ----------------------------------------------------------------------------- members

export const listMembers = defineContract({
  service: 'policy', name: 'listMembers', method: 'GET', path: '/v1/members', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ scopeId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
  response: z.object({ members: z.array(memberView) }),
});

/**
 * The organisation's directory (U4): every member's name and state, and every live scope, for
 * any member. Sharing names a colleague or a team, and a page names who did something; both need
 * this, which listMembers and listScopes (administration) do not give an ordinary member. Names
 * only: no address, no role, no grant.
 */
export const listDirectory = defineContract({
  service: 'policy', name: 'listDirectory', method: 'GET', path: '/v1/directory', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    members: z.array(z.object({ membershipId: z.uuid(), displayName: z.string(), status: z.enum(['invited', 'active', 'suspended', 'removed']) })),
    scopes: z.array(z.object({ id: z.uuid(), name: z.string(), parentScopeId: z.uuid().nullable(), depth: z.int() })),
  }),
});

const membershipId = z.strictObject({ membershipId: z.uuid() });

/** What one lifecycle step did, in counts. */
export const lifecycleView = memberView.extend({
  grantsSilenced: z.number().int(), grantsRestored: z.number().int(), sessionsRevoked: z.number().int(),
  purposeSessionsEnded: z.number().int(),
});

export const suspendMember = defineContract({
  service: 'policy', name: 'suspendMember', method: 'POST', path: '/v1/members/:membershipId/suspend', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: membershipId,
  response: lifecycleView,
});

export const removeMember = defineContract({
  service: 'policy', name: 'removeMember', method: 'POST', path: '/v1/members/:membershipId/remove', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: membershipId,
  response: lifecycleView,
});

export const reinstateMember = defineContract({
  service: 'policy', name: 'reinstateMember', method: 'POST', path: '/v1/members/:membershipId/reinstate', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: membershipId,
  response: lifecycleView,
});
