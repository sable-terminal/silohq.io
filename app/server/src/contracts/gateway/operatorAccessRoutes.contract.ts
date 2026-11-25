// The customer's side of Silo staff access (spec 13.3, 13.5, 63.6), on the Governance page:
// every break-glass session on the tenant, approving or denying one, revoking a running one,
// and requiring approval of every session. One permission states each rule.

import * as o from '../admin-portal/operatorAccess.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const view = { permission: 'org.operator_access.view' } as const;
const approve = { permission: 'org.operator_access.approve' } as const;
const sessionId = (i: { params: { sessionId: string } }) => ({ params: i.params });

export const listOperatorAccessSessions = definePublicRoute({
    name: 'listOperatorAccessSessions', method: 'GET', path: '/operator-access/sessions', session: 'complete', permission: view,
    query: o.listOperatorAccessSessions.query, response: o.listOperatorAccessSessions.response, forwards: o.listOperatorAccessSessions,
    call: (i) => ({ query: i.query }), reply: (r) => r,
  });

export const getOperatorAccessSession = definePublicRoute({
    name: 'getOperatorAccessSession', method: 'GET', path: '/operator-access/sessions/:sessionId', session: 'complete', permission: view,
    params: o.getOperatorAccessSession.params, response: o.getOperatorAccessSession.response, forwards: o.getOperatorAccessSession,
    call: sessionId, reply: (r) => r,
  });

export const decideOperatorAccessSession = definePublicRoute({
    name: 'decideOperatorAccessSession', method: 'POST', path: '/operator-access/sessions/:sessionId/decision', session: 'complete',
    permission: approve, params: o.decideOperatorAccessSession.params, body: o.decideOperatorAccessSession.body,
    response: o.decideOperatorAccessSession.response, forwards: o.decideOperatorAccessSession,
    call: (i) => ({ params: i.params, body: i.body }), reply: (r) => r,
  });

export const revokeOperatorAccessSession = definePublicRoute({
    name: 'revokeOperatorAccessSession', method: 'POST', path: '/operator-access/sessions/:sessionId/revocation', session: 'complete',
    permission: approve, params: o.revokeOperatorAccessSession.params, response: o.revokeOperatorAccessSession.response,
    forwards: o.revokeOperatorAccessSession, call: sessionId, reply: (r) => r,
  });

export const getOperatorAccessPolicy = definePublicRoute({
    name: 'getOperatorAccessPolicy', method: 'GET', path: '/operator-access/policy', session: 'complete', permission: view,
    response: o.getOperatorAccessPolicy.response, forwards: o.getOperatorAccessPolicy, call: () => ({}), reply: (r) => r,
  });

export const setOperatorAccessPolicy = definePublicRoute({
    name: 'setOperatorAccessPolicy', method: 'PUT', path: '/operator-access/policy', session: 'complete',
    permission: { permission: 'org.operator_access.policy' }, body: o.setOperatorAccessPolicy.body,
    response: o.setOperatorAccessPolicy.response, forwards: o.setOperatorAccessPolicy, call: (i) => ({ body: i.body }), reply: (r) => r,
  });

export const OPERATOR_ACCESS_ROUTES = [
  listOperatorAccessSessions,
  getOperatorAccessSession,
  decideOperatorAccessSession,
  revokeOperatorAccessSession,
  getOperatorAccessPolicy,
  setOperatorAccessPolicy,
];
