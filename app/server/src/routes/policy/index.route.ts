// The policy service (spec 7.7, 56, 57, 58, 60.4): the single authorisation decision point,
// and the administration and governance that change what it decides.

import { getInferenceSettings, setInferenceSettings } from '../../contracts/policy/inference.contract.ts';
import * as change from '../../contracts/policy/changePolicy.contract.ts';
import * as admin from '../../contracts/policy/admin.contract.ts';
import { authorise, declassificationDecision, listHeldPermissions, listMyPermissions, listPermittedScopes, readMarkingBanner, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import * as declass from '../../contracts/policy/declassification.contract.ts';
import * as gov from '../../contracts/policy/governance.contract.ts';
import { declassificationController } from '../../controllers/policy/declassification.controller.ts';
import { adminController } from '../../controllers/policy/admin.controller.ts';
import { decisionController } from '../../controllers/policy/decision.controller.ts';
import { governanceController } from '../../controllers/policy/governance.controller.ts';
import { route, type RouteBinding } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { permissionRepo } from '../../repos/iam/index.repo.ts';
import { transferViews } from '../../contracts/workspace/transfer.contract.ts';
import { transferApps } from '../../contracts/studio/transfer.contract.ts';
import { transferOwnedConnections } from '../../contracts/connect-registry/ownership.contract.ts';
import type { AdminDeps } from '../../services/policy/deps.service.ts';
import { createPolicy } from '../../services/policy/policy.service.ts';

export const service = defineService({
  name: 'policy',
  needs: { postgres: ['control'], redis: ['session'] },
  async create(deps) {
    const catalogue = new Map((await inTransaction(deps.databases.pool('control'), {}, (db) => permissionRepo.listCatalogue(db)))
      .map((p) => [p.id, p.category] as const));
    const policy = createPolicy({ databases: deps.databases, sessions: deps.redis.session!, logger: deps.logger, catalogue });
    const shared: AdminDeps = {
      databases: deps.databases, sessions: deps.redis.session!, logger: deps.logger, policy, catalogue, cellKind: deps.config.cell.kind,
      transferViews: async (request, correlationId, membershipId, reason) => {
        await deps.services.call(transferViews, { body: { membershipId, reason } }, { request, correlationId });
      },
      transferConnections: async (request, correlationId, membershipId) => {
        await deps.services.call(transferOwnedConnections, { body: { membershipId } }, { request, correlationId });
      },
      transferApps: async (request, correlationId, membershipId, reason) => {
        await deps.services.call(transferApps, { body: { membershipId, reason } }, { request, correlationId });
      },
    };
    const decisions = decisionController(shared);
    const a = adminController(shared);
    const g = governanceController(shared);
    const d = declassificationController(shared);
    const routes: RouteBinding[] = [
      route(authorise, decisions.authorise), route(listHeldPermissions, decisions.listHeldPermissions), route(listPermittedScopes, decisions.listPermittedScopes), route(listMyPermissions, decisions.listMyPermissions), route(resolveAccess, decisions.resolveAccess),
      route(declassificationDecision, decisions.declassificationDecision), route(readMarkingBanner, decisions.readMarkingBanner),
      route(getInferenceSettings, a.getInferenceSettings), route(setInferenceSettings, a.setInferenceSettings),
      route(change.getChangePolicy, a.getChangePolicy), route(change.setChangePolicy, a.setChangePolicy),
      route(change.setChangeFreeze, a.setChangeFreeze), route(change.endChangeFreeze, a.endChangeFreeze),
      route(change.approveFreezeException, a.approveFreezeException), route(change.listChangePoliciesForFleet, a.listChangePoliciesForFleet),
      route(admin.createScopeType, a.createScopeType), route(admin.listScopeTypes, a.listScopeTypes),
      route(admin.createScope, a.createScope), route(admin.listScopes, a.listScopes), route(admin.listDirectory, a.listDirectory), route(admin.updateScope, a.updateScope),
      route(admin.archiveScope, a.archiveScope),
      route(admin.createRole, a.createRole), route(admin.listRoles, a.listRoles), route(admin.setRolePermissions, a.setRolePermissions),
      route(admin.retireRole, a.retireRole),
      route(admin.grantRole, a.grantRole), route(admin.revokeRole, a.revokeRole), route(admin.listRoleAssignments, a.listRoleAssignments),
      route(admin.listOrphanedGrants, a.listOrphanedGrants),
      route(admin.addScopeMember, a.addScopeMember), route(admin.removeScopeMember, a.removeScopeMember), route(admin.listScopeMembers, a.listScopeMembers),
      route(admin.listMembers, a.listMembers), route(admin.suspendMember, a.suspendMember), route(admin.removeMember, a.removeMember),
      route(admin.reinstateMember, a.reinstateMember),
      route(gov.grantConnection, g.grantConnection), route(gov.revokeConnectionGrant, g.revokeConnectionGrant),
      route(gov.listConnectionGrants, g.listConnectionGrants),
      route(gov.createMarking, g.createMarking), route(gov.listMarkings, g.listMarkings), route(gov.retireMarking, g.retireMarking),
      route(gov.applyMarking, g.applyMarking), route(gov.listResourceMarkings, g.listResourceMarkings),
      route(gov.grantClearance, g.grantClearance), route(gov.revokeClearance, g.revokeClearance), route(gov.listClearances, g.listClearances),
      route(gov.createPurposeDefinition, g.createPurposeDefinition), route(gov.approvePurposeDefinition, g.approvePurposeDefinition),
      route(gov.setPurposeDefinitionStatus, g.setPurposeDefinitionStatus), route(gov.listPurposeDefinitions, g.listPurposeDefinitions),
      route(gov.grantPurposeEligibility, g.grantPurposeEligibility), route(gov.revokePurposeEligibility, g.revokePurposeEligibility),
      route(gov.listPurposeEligibility, g.listPurposeEligibility),
      route(gov.declarePurpose, g.declarePurpose), route(gov.endPurposeSession, g.endPurposeSession),
      route(gov.approvePurposeSession, g.approvePurposeSession),
      route(gov.grantDeclassifier, g.grantDeclassifier), route(gov.approveDeclassifier, g.approveDeclassifier),
      route(gov.revokeDeclassifier, g.revokeDeclassifier), route(gov.listDeclassifiers, g.listDeclassifiers),
      route(gov.listPurposeSessions, g.listPurposeSessions),
      route(gov.createFieldPolicy, g.createFieldPolicy), route(gov.retireFieldPolicy, g.retireFieldPolicy),
      route(gov.listFieldPolicies, g.listFieldPolicies),
      route(gov.createServicePrincipal, g.createServicePrincipal), route(gov.grantPrincipalRole, g.grantPrincipalRole),
      route(gov.removePrincipalRole, g.removePrincipalRole), route(gov.revokeServicePrincipal, g.revokeServicePrincipal),
      route(gov.listServicePrincipals, g.listServicePrincipals),
      route(declass.requestDeclassification, d.requestDeclassification), route(declass.getDeclassification, d.getDeclassification),
      route(declass.listDeclassifications, d.listDeclassifications), route(declass.executeDeclassification, d.executeDeclassification),
      route(declass.revertDeclassification, d.revertDeclassification),
    ];
    return { routes };
  },
});
