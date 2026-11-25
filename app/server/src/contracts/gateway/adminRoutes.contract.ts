// Administration and governance in the browser (spec 56, 57, 58, 60.4): each route forwards
// to the policy service's contract with the same parameters, query and body, after the
// gateway's own check of the permission named here. The policy service decides again,
// precisely (the scope a member sits in, a super admin's target, the delegation rules), so
// the gateway's check is the coarse first gate of spec 57.1, never the only one.
//
// Not here yet: connection grants (an owner grants by ownership, which no route permission
// expresses) and purpose declaration (eligibility, not a role, authorises it). Both need a
// route kind whose decision is the service's alone; see the policy report.

import * as change from '../policy/changePolicy.contract.ts';
import * as inference from '../policy/inference.contract.ts';
import * as admin from '../policy/admin.contract.ts';
import * as gov from '../policy/governance.contract.ts';
import type { AnyContract, CallInput, CallOutput } from '../endpoint.contract.ts';
import { definePublicRoute, type PermissionCheck, type PublicInput, type PublicRoute, type TypedRoute } from './publicRoute.contract.ts';

type Input = PublicInput<any, any, any>;

/** A route forwarding a contract unchanged: the browser sends and gets what the contract takes and gives. */
type Forwarded<C extends AnyContract> = PublicRoute & TypedRoute<CallInput<C>, CallOutput<C>>;

/** A route that forwards a policy contract unchanged, behind a permission check. */
function forward<C extends AnyContract>(contract: C, name: string, path: `/${string}`, permission: PermissionCheck<Input>): Forwarded<C> {
  const route: PublicRoute = definePublicRoute({
    name, method: contract.method, path, session: 'complete', permission,
    params: contract.params, query: contract.query, ...(contract.method === 'GET' ? {} : { body: contract.body }),
    response: contract.response, status: contract.status,
    forwards: contract,
    call: (input: Input) => ({ params: input.params, query: input.query, body: input.body }),
    reply: (output: unknown) => output,
  } as never);
  return route as Forwarded<C>;
}

/** A route that forwards a policy contract whose decision is the policy service's alone. */
function forwardDecided<C extends AnyContract>(contract: C, name: string, path: `/${string}`, decidedByService: string): Forwarded<C> {
  const route: PublicRoute = definePublicRoute({
    name, method: contract.method, path, session: 'complete', decidedByService,
    params: contract.params, query: contract.query, ...(contract.method === 'GET' ? {} : { body: contract.body }),
    response: contract.response, status: contract.status,
    forwards: contract,
    call: (input: Input) => ({ params: input.params, query: input.query, body: input.body }),
    reply: (output: unknown) => output,
  } as never);
  return route as Forwarded<C>;
}

const scopeOf = (field: string) => (input: Input): string | undefined => (input.body as Record<string, string | undefined> | undefined)?.[field];
const paramScope = (input: Input): string | undefined => (input.params as { scopeId?: string }).scopeId;

// Inference switches (decision 2026-11-11; D71): read by members, set with org.inference.manage.
export const getInferenceSettings = forward(inference.getInferenceSettings, 'getInferenceSettings', '/admin/inference-settings', { permission: 'ontology.view' });
export const setInferenceSettings = forward(inference.setInferenceSettings, 'setInferenceSettings', '/admin/inference-settings', { permission: 'org.inference.manage' });

// Change windows and freezes (spec 11.5): read by members (the change authority among them), set with org.change_window.manage.
export const getChangePolicy = forward(change.getChangePolicy, 'getChangePolicy', '/admin/change-policy', { permission: 'ontology.view' });
export const setChangePolicy = forward(change.setChangePolicy, 'setChangePolicy', '/admin/change-policy', { permission: 'org.change_window.manage' });
export const setChangeFreeze = forward(change.setChangeFreeze, 'setChangeFreeze', '/admin/change-policy/freezes/:freezeId', { permission: 'org.change_window.manage' });
export const endChangeFreeze = forward(change.endChangeFreeze, 'endChangeFreeze', '/admin/change-policy/freezes/:freezeId/end', { permission: 'org.change_window.manage' });
export const approveFreezeException = forwardDecided(change.approveFreezeException, 'approveFreezeException', '/admin/change-policy/exceptions',
    'policy allows only the change authority the organisation named, whatever permissions they hold');

export const createScopeType = forward(admin.createScopeType, 'createScopeType', '/admin/scope-types', { permission: 'scope_type.manage' });
export const listScopeTypes = forward(admin.listScopeTypes, 'listScopeTypes', '/admin/scope-types', { permission: 'scope.manage' });
export const createScope = forward(admin.createScope, 'createScope', '/admin/scopes', { permission: 'scope.manage', scopeId: scopeOf('parentScopeId') });
export const listScopes = forward(admin.listScopes, 'listScopes', '/admin/scopes', { permission: 'scope.manage' });
export const updateScope = forward(admin.updateScope, 'updateScope', '/admin/scopes/:scopeId', { permission: 'scope.manage', scopeId: paramScope });
export const archiveScope = forward(admin.archiveScope, 'archiveScope', '/admin/scopes/:scopeId/archive', { permission: 'scope.manage', scopeId: paramScope });
export const createRole = forward(admin.createRole, 'createRole', '/admin/roles', { permission: 'admin.delegate' });
export const listRoles = forward(admin.listRoles, 'listRoles', '/admin/roles', { permission: 'admin.delegate' });
export const setRolePermissions = forward(admin.setRolePermissions, 'setRolePermissions', '/admin/roles/:roleId/permissions', { permission: 'admin.delegate' });
export const retireRole = forward(admin.retireRole, 'retireRole', '/admin/roles/:roleId/retire', { permission: 'admin.delegate' });
export const grantRole = forward(admin.grantRole, 'grantRole', '/admin/role-assignments', { permission: 'admin.delegate', scopeId: scopeOf('scopeId') });
export const revokeRole = forward(admin.revokeRole, 'revokeRole', '/admin/role-assignments/:assignmentId/revoke', { permission: 'admin.delegate' });
export const listRoleAssignments = forward(admin.listRoleAssignments, 'listRoleAssignments', '/admin/role-assignments', { permission: 'admin.delegate' });
export const listOrphanedGrants = forward(admin.listOrphanedGrants, 'listOrphanedGrants', '/admin/role-assignments/orphans', { permission: 'admin.delegate' });
export const addScopeMember = forward(admin.addScopeMember, 'addScopeMember', '/admin/scope-memberships', { permission: 'scope.manage', scopeId: scopeOf('scopeId') });
export const listScopeMembers = forward(admin.listScopeMembers, 'listScopeMembers', '/admin/scopes/:scopeId/members', { permission: 'scope.manage', scopeId: paramScope });
export const removeScopeMember = forward(admin.removeScopeMember, 'removeScopeMember', '/admin/scope-memberships/:scopeMembershipId/remove', { permission: 'scope.manage' });
export const listMembers = forward(admin.listMembers, 'listMembers', '/admin/members', { permission: 'member.invite' });
export const suspendMember = forward(admin.suspendMember, 'suspendMember', '/admin/members/:membershipId/suspend', { permission: 'member.suspend' });
export const removeMember = forward(admin.removeMember, 'removeMember', '/admin/members/:membershipId/remove', { permission: 'member.suspend' });
export const reinstateMember = forward(admin.reinstateMember, 'reinstateMember', '/admin/members/:membershipId/reinstate', { permission: 'member.suspend' });
export const createMarking = forward(gov.createMarking, 'createMarking', '/governance/markings', { permission: 'marking.manage' });
export const retireMarking = forward(gov.retireMarking, 'retireMarking', '/governance/markings/:markingId/retire', { permission: 'marking.manage' });
export const applyMarking = forward(gov.applyMarking, 'applyMarking', '/governance/resource-markings', { permission: 'marking.manage' });
export const grantClearance = forward(gov.grantClearance, 'grantClearance', '/governance/clearances', { permission: 'clearance.grant' });
export const revokeClearance = forward(gov.revokeClearance, 'revokeClearance', '/governance/clearances/:clearanceId/revoke', { permission: 'clearance.grant' });
export const createPurposeDefinition = forward(gov.createPurposeDefinition, 'createPurposeDefinition', '/governance/purpose-definitions', { permission: 'purpose.define' });
export const approvePurposeDefinition = forward(gov.approvePurposeDefinition, 'approvePurposeDefinition', '/governance/purpose-definitions/:purposeDefinitionId/approve',
    { permission: 'purpose.define' });

export const setPurposeDefinitionStatus = forward(gov.setPurposeDefinitionStatus, 'setPurposeDefinitionStatus', '/governance/purpose-definitions/:purposeDefinitionId/status',
    { permission: 'purpose.define' });

export const grantPurposeEligibility = forward(gov.grantPurposeEligibility, 'grantPurposeEligibility', '/governance/purpose-eligibility', { permission: 'clearance.grant' });
export const listPurposeEligibility = forward(gov.listPurposeEligibility, 'listPurposeEligibility', '/governance/purpose-definitions/:purposeDefinitionId/eligibility',
    { permission: 'clearance.grant' });
export const revokePurposeEligibility = forward(gov.revokePurposeEligibility, 'revokePurposeEligibility', '/governance/purpose-eligibility/:eligibilityId/revoke',
    { permission: 'clearance.grant' });

export const approvePurposeSession = forward(gov.approvePurposeSession, 'approvePurposeSession', '/governance/purpose-sessions/:purposeSessionId/approve', { permission: 'purpose.define' });
export const grantDeclassifier = forward(gov.grantDeclassifier, 'grantDeclassifier', '/governance/declassifiers', { permission: 'clearance.grant' });
export const approveDeclassifier = forward(gov.approveDeclassifier, 'approveDeclassifier', '/governance/declassifiers/:declassifierId/approve', { permission: 'clearance.grant' });
export const revokeDeclassifier = forward(gov.revokeDeclassifier, 'revokeDeclassifier', '/governance/declassifiers/:declassifierId/revoke', { permission: 'clearance.grant' });
export const listDeclassifiers = forward(gov.listDeclassifiers, 'listDeclassifiers', '/governance/declassifiers', { permission: 'clearance.grant' });
export const createFieldPolicy = forward(gov.createFieldPolicy, 'createFieldPolicy', '/governance/field-policies', { permission: 'marking.manage' });
export const retireFieldPolicy = forward(gov.retireFieldPolicy, 'retireFieldPolicy', '/governance/field-policies/:fieldPolicyId/retire', { permission: 'marking.manage' });
export const createServicePrincipal = forward(gov.createServicePrincipal, 'createServicePrincipal', '/governance/service-principals',
    { permission: 'service_principal.manage', scopeId: scopeOf('scopeId') });

export const grantPrincipalRole = forward(gov.grantPrincipalRole, 'grantPrincipalRole', '/governance/service-principals/:servicePrincipalId/roles',
    { permission: 'service_principal.manage' });

export const revokeServicePrincipal = forward(gov.revokeServicePrincipal, 'revokeServicePrincipal', '/governance/service-principals/:servicePrincipalId/revoke',
    { permission: 'service_principal.manage' });

export const ADMIN_ROUTES: readonly PublicRoute[] = [
  getInferenceSettings,
  setInferenceSettings,
  getChangePolicy,
  setChangePolicy,
  setChangeFreeze,
  endChangeFreeze,
  approveFreezeException,
  createScopeType,
  listScopeTypes,
  createScope,
  listScopes,
  updateScope,
  archiveScope,
  createRole,
  listRoles,
  setRolePermissions,
  retireRole,
  grantRole,
  revokeRole,
  listRoleAssignments,
  listOrphanedGrants,
  addScopeMember,
  listScopeMembers,
  removeScopeMember,
  listMembers,
  suspendMember,
  removeMember,
  reinstateMember,
  createMarking,
  retireMarking,
  applyMarking,
  grantClearance,
  revokeClearance,
  createPurposeDefinition,
  approvePurposeDefinition,
  setPurposeDefinitionStatus,
  grantPurposeEligibility,
  listPurposeEligibility,
  revokePurposeEligibility,
  approvePurposeSession,
  grantDeclassifier,
  approveDeclassifier,
  revokeDeclassifier,
  listDeclassifiers,
  createFieldPolicy,
  retireFieldPolicy,
  createServicePrincipal,
  grantPrincipalRole,
  revokeServicePrincipal,
];
