// The administration endpoints: contracts to the admin and member services.

import type * as admin from '../../contracts/policy/admin.contract.ts';
import type * as change from '../../contracts/policy/changePolicy.contract.ts';
import type { getInferenceSettings, setInferenceSettings } from '../../contracts/policy/inference.contract.ts';
import * as changePolicy from '../../services/policy/changePolicy.service.ts';
import * as inference from '../../services/policy/inference.service.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as scopes from '../../services/policy/admin.service.ts';
import type { AdminDeps } from '../../services/policy/deps.service.ts';
import * as members from '../../services/policy/members.service.ts';

const scopeMembership = (row: { id: string; membershipId: string; scopeId: string; isPrimary: boolean; inactiveSince: string | null }) =>
  ({ id: row.id, membershipId: row.membershipId, scopeId: row.scopeId, isPrimary: row.isPrimary, inactiveSince: row.inactiveSince });

export function adminController(deps: AdminDeps): {
  createScopeType: RouteHandlers<typeof admin.createScopeType>;
  listScopeTypes: RouteHandlers<typeof admin.listScopeTypes>;
  createScope: RouteHandlers<typeof admin.createScope>;
  listScopes: RouteHandlers<typeof admin.listScopes>;
  listDirectory: RouteHandlers<typeof admin.listDirectory>;
  updateScope: RouteHandlers<typeof admin.updateScope>;
  archiveScope: RouteHandlers<typeof admin.archiveScope>;
  createRole: RouteHandlers<typeof admin.createRole>;
  listRoles: RouteHandlers<typeof admin.listRoles>;
  setRolePermissions: RouteHandlers<typeof admin.setRolePermissions>;
  retireRole: RouteHandlers<typeof admin.retireRole>;
  grantRole: RouteHandlers<typeof admin.grantRole>;
  revokeRole: RouteHandlers<typeof admin.revokeRole>;
  listRoleAssignments: RouteHandlers<typeof admin.listRoleAssignments>;
  listOrphanedGrants: RouteHandlers<typeof admin.listOrphanedGrants>;
  addScopeMember: RouteHandlers<typeof admin.addScopeMember>;
  removeScopeMember: RouteHandlers<typeof admin.removeScopeMember>;
  listScopeMembers: RouteHandlers<typeof admin.listScopeMembers>;
  listMembers: RouteHandlers<typeof admin.listMembers>;
  suspendMember: RouteHandlers<typeof admin.suspendMember>;
  removeMember: RouteHandlers<typeof admin.removeMember>;
  reinstateMember: RouteHandlers<typeof admin.reinstateMember>;
  getInferenceSettings: RouteHandlers<typeof getInferenceSettings>;
  setInferenceSettings: RouteHandlers<typeof setInferenceSettings>;
  getChangePolicy: RouteHandlers<typeof change.getChangePolicy>;
  setChangePolicy: RouteHandlers<typeof change.setChangePolicy>;
  setChangeFreeze: RouteHandlers<typeof change.setChangeFreeze>;
  endChangeFreeze: RouteHandlers<typeof change.endChangeFreeze>;
  approveFreezeException: RouteHandlers<typeof change.approveFreezeException>;
  listChangePoliciesForFleet: RouteHandlers<typeof change.listChangePoliciesForFleet>;
} {
  return {
    getInferenceSettings: { handle: (_input, ctx) => inference.getInferenceSettings(deps, ctx) },
    setInferenceSettings: { handle: (input, ctx) => inference.setInferenceSettings(deps, ctx, input.body) },
    getChangePolicy: { handle: (_input, ctx) => changePolicy.getChangePolicy(deps, ctx) },
    setChangePolicy: { handle: (input, ctx) => changePolicy.setChangePolicy(deps, ctx, input.body) },
    setChangeFreeze: { handle: (input, ctx) => changePolicy.setChangeFreeze(deps, ctx, input.params.freezeId, input.body) },
    endChangeFreeze: { handle: (input, ctx) => changePolicy.endChangeFreeze(deps, ctx, input.params.freezeId) },
    approveFreezeException: { handle: (input, ctx) => changePolicy.approveFreezeException(deps, ctx, input.body) },
    listChangePoliciesForFleet: { handle: () => changePolicy.listChangePoliciesForFleet(deps) as never },
    createScopeType: { handle: (input, ctx) => scopes.createScopeType(deps, ctx, input.body) },
    listScopeTypes: { handle: async (_input, ctx) => ({ scopeTypes: await scopes.listScopeTypes(deps, ctx) }) },
    createScope: { handle: (input, ctx) => scopes.createScope(deps, ctx, input.body) },
    listScopes: { handle: async (input, ctx) => ({ scopes: await scopes.listScopes(deps, ctx, input.query.includeArchived === 'true') }) },
    updateScope: { handle: (input, ctx) => scopes.updateScope(deps, ctx, input.params.scopeId, input.body) },
    archiveScope: { handle: (input, ctx) => scopes.archiveScope(deps, ctx, input.params.scopeId, input.body.version) },
    createRole: { handle: (input, ctx) => scopes.createRole(deps, ctx, input.body) },
    listRoles: { handle: async (_input, ctx) => ({ roles: await scopes.listRoles(deps, ctx) }) },
    setRolePermissions: { handle: (input, ctx) => scopes.setRolePermissions(deps, ctx, input.params.roleId, input.body.permissions) },
    retireRole: { handle: (input, ctx) => scopes.retireRole(deps, ctx, input.params.roleId) },
    grantRole: { handle: (input, ctx) => scopes.grantRole(deps, ctx, input.body) },
    revokeRole: { handle: (input, ctx) => scopes.revokeRole(deps, ctx, input.params.assignmentId) },
    listRoleAssignments: {
      handle: async (input, ctx) => ({ assignments: await scopes.listRoleAssignments(deps, ctx, input.query.membershipId) }),
    },
    listOrphanedGrants: { handle: async (_input, ctx) => ({ assignments: await scopes.listOrphanedGrants(deps, ctx) }) },
    addScopeMember: { handle: async (input, ctx) => scopeMembership(await scopes.addScopeMember(deps, ctx, input.body)) },
    removeScopeMember: { handle: async (input, ctx) => scopeMembership(await scopes.removeScopeMember(deps, ctx, input.params.scopeMembershipId)) },
    listScopeMembers: { handle: async (input, ctx) => ({ members: (await scopes.listScopeMembers(deps, ctx, input.params.scopeId)).map(scopeMembership) }) },
    listMembers: { handle: async (input, ctx) => ({ members: await members.listMembers(deps, ctx, input.query) }) },
    listDirectory: { handle: async (_input, ctx) => members.directory(deps, ctx) },
    suspendMember: { handle: (input, ctx) => members.changeMember(deps, ctx, input.params.membershipId, 'suspend') },
    removeMember: { handle: (input, ctx) => members.changeMember(deps, ctx, input.params.membershipId, 'remove') },
    reinstateMember: { handle: (input, ctx) => members.changeMember(deps, ctx, input.params.membershipId, 'reinstate') },
  };
}
