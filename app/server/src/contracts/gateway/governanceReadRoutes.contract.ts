// Governance in the product, the reads and the member's own purpose sessions (spec 56 to 60):
// markings, clearances, field policies, purposes, service principals and connection grants
// as an administrator sees them, and declaring and ending a purpose session.
//
// Where policy's rule is more than one permission, policy decides and the route says why:
// a connection's grants are the owner's or a connection.grant holder's to see; clearances
// are a clearance.grant holder's, or the member's own; markings are listed in full to a
// marking.manage holder and narrowed for others. A purpose session is the member's own.

import * as dc from '../policy/declassification.contract.ts';
import * as g from '../policy/governance.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

export const listConnectionGrants = definePublicRoute({
    name: 'listConnectionGrants', method: 'GET', path: '/governance/connection-grants', session: 'complete',
    decidedByService: 'policy allows the connection\'s owner, or connection.grant at its owning scope',
    query: g.listConnectionGrants.query, response: g.listConnectionGrants.response, forwards: g.listConnectionGrants, call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const grantConnectionRoute = definePublicRoute({
    name: 'grantConnection', method: 'POST', path: '/governance/connection-grants', session: 'complete',
    decidedByService: 'policy applies the delegation rules: the connection\'s owner, or connection.grant at its owning scope, grants it (spec 56.7)',
    body: g.grantConnection.body, response: g.grantConnection.response, status: g.grantConnection.status, forwards: g.grantConnection,
    call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const revokeConnectionGrant = definePublicRoute({
    name: 'revokeConnectionGrant', method: 'POST', path: '/governance/connection-grants/:grantId/revoke', session: 'complete',
    decidedByService: 'policy applies the delegation rules: a grant is revoked by whoever could have made it (spec 56.7)',
    params: g.revokeConnectionGrant.params, response: g.revokeConnectionGrant.response, forwards: g.revokeConnectionGrant,
    call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const listMarkings = definePublicRoute({
    name: 'listMarkings', method: 'GET', path: '/governance/markings', session: 'complete',
    decidedByService: 'policy lists every marking to a marking.manage holder and narrows the list for others',
    query: g.listMarkings.query, response: g.listMarkings.response, forwards: g.listMarkings, call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const listResourceMarkings = definePublicRoute({
    name: 'listResourceMarkings', method: 'GET', path: '/governance/resource-markings', session: 'complete', permission: { permission: 'marking.manage' },
    query: g.listResourceMarkings.query, response: g.listResourceMarkings.response, forwards: g.listResourceMarkings, call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const listClearances = definePublicRoute({
    name: 'listClearances', method: 'GET', path: '/governance/clearances', session: 'complete',
    decidedByService: 'policy shows a member their own clearances, and everyone\'s to a clearance.grant holder',
    query: g.listClearances.query, response: g.listClearances.response, forwards: g.listClearances, call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const listFieldPolicies = definePublicRoute({
    name: 'listFieldPolicies', method: 'GET', path: '/governance/field-policies', session: 'complete', permission: { permission: 'marking.manage' },
    query: g.listFieldPolicies.query, response: g.listFieldPolicies.response, forwards: g.listFieldPolicies, call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const requestDeclassification = definePublicRoute({
    name: 'requestDeclassification', method: 'POST', path: '/governance/declassifications', session: 'complete',
    permission: { permission: 'marking.declassify' },
    body: dc.requestDeclassification.body, response: dc.requestDeclassification.response, status: 201, forwards: dc.requestDeclassification,
    call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const readDeclassification = definePublicRoute({
    name: 'readDeclassification', method: 'GET', path: '/governance/declassifications/:declassificationId', session: 'complete',
    decidedByService: 'policy shows a declassification to its requester, a marking.declassify holder, and anyone who satisfies the marking (who could approve it)',
    params: dc.getDeclassification.params, response: dc.getDeclassification.response, forwards: dc.getDeclassification,
    call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const listDeclassifications = definePublicRoute({
    name: 'listDeclassifications', method: 'GET', path: '/governance/declassifications', session: 'complete',
    decidedByService: 'policy lists the declassifications the member could request, approve or did request',
    query: dc.listDeclassifications.query, response: dc.listDeclassifications.response, forwards: dc.listDeclassifications,
    call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const revertDeclassification = definePublicRoute({
    name: 'revertDeclassification', method: 'POST', path: '/governance/declassifications/:declassificationId/revert', session: 'complete',
    permission: { permission: 'marking.declassify' },
    params: dc.revertDeclassification.params, response: dc.revertDeclassification.response, forwards: dc.revertDeclassification,
    call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const listServicePrincipals = definePublicRoute({
    name: 'listServicePrincipals', method: 'GET', path: '/governance/service-principals', session: 'complete',
    permission: { permission: 'service_principal.manage' },
    response: g.listServicePrincipals.response, forwards: g.listServicePrincipals, call: () => ({}), reply: (o) => o,
  });

export const removePrincipalRole = definePublicRoute({
    name: 'removePrincipalRole', method: 'POST', path: '/governance/service-principals/:servicePrincipalId/roles/:roleId/remove', session: 'complete',
    decidedByService: 'policy allows service_principal.manage where the principal sits, within the delegation rules',
    params: g.removePrincipalRole.params, response: g.removePrincipalRole.response, forwards: g.removePrincipalRole, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const listPurposeDefinitions = definePublicRoute({
    name: 'listPurposeDefinitions', method: 'GET', path: '/governance/purpose-definitions', session: 'complete',
    decidedByService: 'every member reads the organisation\'s purposes, to declare one they are eligible for (spec 58.5)',
    response: g.listPurposeDefinitions.response, forwards: g.listPurposeDefinitions, call: () => ({}), reply: (o) => o,
  });

// A purpose session is the member's own: declared, listed and ended only by them.
export const declarePurpose = definePublicRoute({
    name: 'declarePurpose', method: 'POST', path: '/purpose-sessions', session: 'complete', ownRecords: true,
    body: g.declarePurpose.body, response: g.declarePurpose.response, forwards: g.declarePurpose,
    call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const listPurposeSessions = definePublicRoute({
    name: 'listPurposeSessions', method: 'GET', path: '/purpose-sessions', session: 'complete', ownRecords: true,
    response: g.listPurposeSessions.response, forwards: g.listPurposeSessions, call: () => ({}), reply: (o) => o,
  });

export const endPurposeSession = definePublicRoute({
    name: 'endPurposeSession', method: 'POST', path: '/purpose-sessions/:purposeSessionId/end', session: 'complete', ownRecords: true,
    params: g.endPurposeSession.params, response: g.endPurposeSession.response, forwards: g.endPurposeSession, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const GOVERNANCE_READ_ROUTES = [
  listConnectionGrants,
  grantConnectionRoute,
  revokeConnectionGrant,
  listMarkings,
  listResourceMarkings,
  listClearances,
  listFieldPolicies,
  requestDeclassification,
  readDeclassification,
  listDeclassifications,
  revertDeclassification,
  listServicePrincipals,
  removePrincipalRole,
  listPurposeDefinitions,
  declarePurpose,
  listPurposeSessions,
  endPurposeSession,
] as const;
