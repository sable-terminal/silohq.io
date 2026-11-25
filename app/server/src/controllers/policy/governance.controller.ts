// The governance endpoints: contracts to connection grants, markings, clearances, purposes,
// field policies and service principals.

import * as declassifiers from '../../services/policy/declassifiers.service.ts';
import type * as gov from '../../contracts/policy/governance.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as grants from '../../services/policy/connectionGrants.service.ts';
import type { AdminDeps } from '../../services/policy/deps.service.ts';
import * as governance from '../../services/policy/governance.service.ts';
import * as principals from '../../services/policy/principals.service.ts';
import * as purposes from '../../services/policy/purposes.service.ts';

export function governanceController(deps: AdminDeps): {
  grantConnection: RouteHandlers<typeof gov.grantConnection>;
  revokeConnectionGrant: RouteHandlers<typeof gov.revokeConnectionGrant>;
  listConnectionGrants: RouteHandlers<typeof gov.listConnectionGrants>;
  createMarking: RouteHandlers<typeof gov.createMarking>;
  listMarkings: RouteHandlers<typeof gov.listMarkings>;
  retireMarking: RouteHandlers<typeof gov.retireMarking>;
  applyMarking: RouteHandlers<typeof gov.applyMarking>;
  listResourceMarkings: RouteHandlers<typeof gov.listResourceMarkings>;
  grantClearance: RouteHandlers<typeof gov.grantClearance>;
  revokeClearance: RouteHandlers<typeof gov.revokeClearance>;
  listClearances: RouteHandlers<typeof gov.listClearances>;
  createPurposeDefinition: RouteHandlers<typeof gov.createPurposeDefinition>;
  approvePurposeDefinition: RouteHandlers<typeof gov.approvePurposeDefinition>;
  setPurposeDefinitionStatus: RouteHandlers<typeof gov.setPurposeDefinitionStatus>;
  listPurposeDefinitions: RouteHandlers<typeof gov.listPurposeDefinitions>;
  grantPurposeEligibility: RouteHandlers<typeof gov.grantPurposeEligibility>;
  revokePurposeEligibility: RouteHandlers<typeof gov.revokePurposeEligibility>;
  listPurposeEligibility: RouteHandlers<typeof gov.listPurposeEligibility>;
  declarePurpose: RouteHandlers<typeof gov.declarePurpose>;
  approvePurposeSession: RouteHandlers<typeof gov.approvePurposeSession>;
  grantDeclassifier: RouteHandlers<typeof gov.grantDeclassifier>;
  approveDeclassifier: RouteHandlers<typeof gov.approveDeclassifier>;
  revokeDeclassifier: RouteHandlers<typeof gov.revokeDeclassifier>;
  listDeclassifiers: RouteHandlers<typeof gov.listDeclassifiers>;
  endPurposeSession: RouteHandlers<typeof gov.endPurposeSession>;
  listPurposeSessions: RouteHandlers<typeof gov.listPurposeSessions>;
  createFieldPolicy: RouteHandlers<typeof gov.createFieldPolicy>;
  retireFieldPolicy: RouteHandlers<typeof gov.retireFieldPolicy>;
  listFieldPolicies: RouteHandlers<typeof gov.listFieldPolicies>;
  createServicePrincipal: RouteHandlers<typeof gov.createServicePrincipal>;
  grantPrincipalRole: RouteHandlers<typeof gov.grantPrincipalRole>;
  removePrincipalRole: RouteHandlers<typeof gov.removePrincipalRole>;
  revokeServicePrincipal: RouteHandlers<typeof gov.revokeServicePrincipal>;
  listServicePrincipals: RouteHandlers<typeof gov.listServicePrincipals>;
} {
  return {
    grantConnection: { handle: (input, ctx) => grants.grantConnection(deps, ctx, input.body) },
    revokeConnectionGrant: { handle: (input, ctx) => grants.revokeConnectionGrant(deps, ctx, input.params.grantId) },
    listConnectionGrants: {
      handle: async (input, ctx) => ({
        grants: await grants.listConnectionGrants(deps, ctx, input.query.connectionId, input.query.includeEnded === 'true'),
      }),
    },
    createMarking: { handle: (input, ctx) => governance.createMarking(deps, ctx, input.body) },
    listMarkings: { handle: async (input, ctx) => ({ markings: await governance.listMarkings(deps, ctx, input.query.includeRetired === 'true') }) },
    retireMarking: { handle: (input, ctx) => governance.retireMarking(deps, ctx, input.params.markingId) },
    applyMarking: { handle: (input, ctx) => governance.applyMarking(deps, ctx, input.body) },
    listResourceMarkings: { handle: async (input, ctx) => ({ markingIds: await governance.listResourceMarkings(deps, ctx, input.query) }) },
    grantClearance: { handle: (input, ctx) => governance.grantClearance(deps, ctx, input.body) },
    revokeClearance: { handle: (input, ctx) => governance.revokeClearance(deps, ctx, input.params.clearanceId) },
    listClearances: { handle: async (input, ctx) => ({ clearances: await governance.listClearances(deps, ctx, input.query) }) },
    createPurposeDefinition: { handle: (input, ctx) => purposes.createPurposeDefinition(deps, ctx, input.body) },
    approvePurposeDefinition: {
      handle: (input, ctx) => purposes.approvePurposeDefinition(deps, ctx, input.params.purposeDefinitionId, input.body),
    },
    setPurposeDefinitionStatus: {
      handle: (input, ctx) => purposes.setPurposeDefinitionStatus(deps, ctx, input.params.purposeDefinitionId, input.body),
    },
    listPurposeDefinitions: { handle: async (_input, ctx) => ({ purposeDefinitions: await purposes.listPurposeDefinitions(deps, ctx) }) },
    grantPurposeEligibility: { handle: (input, ctx) => purposes.grantPurposeEligibility(deps, ctx, input.body) },
    revokePurposeEligibility: { handle: (input, ctx) => purposes.revokePurposeEligibility(deps, ctx, input.params.eligibilityId) },
    listPurposeEligibility: {
      handle: async (input, ctx) => ({ eligibility: await purposes.listPurposeEligibility(deps, ctx, input.params.purposeDefinitionId) }),
    },
    declarePurpose: { handle: (input, ctx) => purposes.declarePurpose(deps, ctx, input.body) },
    approvePurposeSession: { handle: (input, ctx) => purposes.approvePurposeSession(deps, ctx, input.params.purposeSessionId) },
    grantDeclassifier: { handle: (input, ctx) => declassifiers.grantDeclassifier(deps, ctx, input.body) },
    approveDeclassifier: { handle: (input, ctx) => declassifiers.approveDeclassifier(deps, ctx, input.params.declassifierId) },
    revokeDeclassifier: { handle: (input, ctx) => declassifiers.revokeDeclassifier(deps, ctx, input.params.declassifierId) },
    listDeclassifiers: { handle: (input, ctx) => declassifiers.listDeclassifiers(deps, ctx, input.query.markingId) },
    endPurposeSession: { handle: (input, ctx) => purposes.endPurposeSession(deps, ctx, input.params.purposeSessionId) },
    listPurposeSessions: { handle: async (_input, ctx) => ({ purposeSessions: await purposes.listPurposeSessions(deps, ctx) }) },
    createFieldPolicy: { handle: (input, ctx) => governance.createFieldPolicy(deps, ctx, input.body) },
    retireFieldPolicy: { handle: (input, ctx) => governance.retireFieldPolicy(deps, ctx, input.params.fieldPolicyId) },
    listFieldPolicies: { handle: async (input, ctx) => ({ fieldPolicies: await governance.listFieldPolicies(deps, ctx, input.query) }) },
    createServicePrincipal: { handle: (input, ctx) => principals.createServicePrincipal(deps, ctx, input.body) },
    grantPrincipalRole: { handle: (input, ctx) => principals.grantPrincipalRole(deps, ctx, input.params.servicePrincipalId, input.body.roleId) },
    removePrincipalRole: {
      handle: (input, ctx) => principals.removePrincipalRole(deps, ctx, input.params.servicePrincipalId, input.params.roleId),
    },
    revokeServicePrincipal: { handle: (input, ctx) => principals.revokeServicePrincipal(deps, ctx, input.params.servicePrincipalId) },
    listServicePrincipals: { handle: async (_input, ctx) => ({ servicePrincipals: await principals.listServicePrincipals(deps, ctx) }) },
  };
}
