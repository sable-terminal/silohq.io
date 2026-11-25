// Managing a connection in the product (spec 14.9, 15.3, 17.1): the connectors to choose
// from, the organisation's connections, and everything after creation that makes one
// usable: its name, parameters and secrets, the OAuth sign-in, conformance runs and its
// status moves.
//
// Pickers and lists ask connection.create, which everyone who connects a system holds. The
// rest are "the connection's owner, or a permission at its owning scope": the policy service
// cannot state that as one permission, so connect-registry, conformance and oauth decide,
// each with the rule named on the route.
//
// The OAuth callback: the provider returns the browser to the client's callback page, which
// posts the state and code here. The session cookie is SameSite=Strict, so it rides on that
// same-site post and never on the provider's cross-site redirect; the flow completes only in
// the session that started it.

import * as agents from '../connect-registry/agent.contract.ts';
import { startChangeStreamClass } from '../conformance/changeStreamClass.contract.ts';
import * as ow from '../connect-registry/outboundWebhook.contract.ts';
import * as ind from '../connect-registry/industrial.contract.ts';
import * as wp from '../connect-registry/writablePoint.contract.ts';
import { getConformanceRun, listConformanceRuns, startConformanceRun } from '../conformance/conformance.contract.ts';
import {
  changeConnectionStatus, setConnectionPolicyAuthority, getConnection, listConnections, renameConnection, setConnectionParameters, setConnectionSecrets,
} from '../connect-registry/connection.contract.ts';
import { getConnector, getConnectorSetup, listConnectors } from '../connect-registry/connector.contract.ts';
import { listPrivateLinks } from '../connect-registry/privateLink.contract.ts';
import { completeOAuthFlow, startOAuthFlow } from '../oauth/oauth.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const OWNER_OR_MANAGE = 'connect-registry allows the connection\'s owner, or connection.manage at its owning scope';
const OWNER_OR_ROTATE = 'connect-registry allows the connection\'s owner, or connection.credential.rotate at its owning scope';
const STATUS_RULES = 'connect-registry decides each status move by its own rule: the owner for some, a scoped permission for others';
const OWNER_OR_VERIFY = 'conformance allows the connection\'s owner, or connector.verify at its owning scope';
const create = { permission: 'connection.create' };

const OUTBOUND = 'connect-registry checks webhook.outbound.manage at the connection\'s owning scope (spec 20.8)';
const INDUSTRIAL = 'connect-registry checks industrial.connect at the connection\'s owning scope, and industrial.declare_writable for a policy None exception (spec 20.8)';

// Industrial endpoints (spec 20.1 to 20.3): an MQTT broker or OPC UA server, reached through the agent.
export const createIndustrialEndpoint = definePublicRoute({
    name: 'createIndustrialEndpoint', method: 'POST', path: '/connect/connections/:connectionId/industrial-endpoints', session: 'complete',
    decidedByService: INDUSTRIAL, params: ind.createIndustrialEndpoint.params, body: ind.createIndustrialEndpoint.body,
    response: ind.createIndustrialEndpoint.response, status: 201, forwards: ind.createIndustrialEndpoint,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

// An OPC UA endpoint's verification: the agent connects; the endpoint is active once the server trusts its application.
export const verifyIndustrialEndpoint = definePublicRoute({
    name: 'verifyIndustrialEndpoint', method: 'POST', path: '/connect/connections/:connectionId/industrial-endpoints/:endpointId/verifications', session: 'complete',
    decidedByService: 'connect-registry checks industrial.connect at the connection\'s owning scope (spec 20.8)',
    params: ind.verifyIndustrialEndpoint.params, response: ind.verifyIndustrialEndpoint.response, forwards: ind.verifyIndustrialEndpoint,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

const WRITABLE = 'connect-registry checks industrial.declare_writable at the connection\'s owning scope (spec 20.8)';

// Writable points (spec 20.3, 20.5, 20.7).
export const declareWritablePoint = definePublicRoute({
    name: 'declareWritablePoint', method: 'POST', path: '/connect/connections/:connectionId/writable-points', session: 'complete',
    decidedByService: WRITABLE, params: wp.declareWritablePoint.params, body: wp.declareWritablePoint.body,
    response: wp.declareWritablePoint.response, status: 201, forwards: wp.declareWritablePoint,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const listWritablePoints = definePublicRoute({
    name: 'listWritablePoints', method: 'GET', path: '/connect/connections/:connectionId/writable-points', session: 'complete',
    permission: { permission: 'connection.create' }, params: wp.listWritablePoints.params, query: wp.listWritablePoints.query,
    response: wp.listWritablePoints.response, forwards: wp.listWritablePoints,
    call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
  });

export const raiseWritablePointRisk = definePublicRoute({
    name: 'raiseWritablePointRisk', method: 'POST', path: '/connect/writable-points/:pointId/risk', session: 'complete',
    decidedByService: WRITABLE, params: wp.raiseWritablePointRisk.params, body: wp.raiseWritablePointRisk.body,
    response: wp.raiseWritablePointRisk.response, forwards: wp.raiseWritablePointRisk,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const setWritablePointTestSafe = definePublicRoute({
    name: 'setWritablePointTestSafe', method: 'POST', path: '/connect/writable-points/:pointId/test-safe', session: 'complete',
    decidedByService: WRITABLE, params: wp.setWritablePointTestSafe.params, body: wp.setWritablePointTestSafe.body,
    response: wp.setWritablePointTestSafe.response, forwards: wp.setWritablePointTestSafe,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const retireWritablePoint = definePublicRoute({
    name: 'retireWritablePoint', method: 'POST', path: '/connect/writable-points/:pointId/retire', session: 'complete',
    decidedByService: WRITABLE, params: wp.retireWritablePoint.params, response: wp.retireWritablePoint.response,
    forwards: wp.retireWritablePoint, call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const listIndustrialEndpoints = definePublicRoute({
    name: 'listIndustrialEndpoints', method: 'GET', path: '/connect/connections/:connectionId/industrial-endpoints', session: 'complete',
    decidedByService: INDUSTRIAL, params: ind.listIndustrialEndpoints.params, response: ind.listIndustrialEndpoints.response,
    forwards: ind.listIndustrialEndpoints, call: (input) => ({ params: input.params }), reply: (output) => output,
  });

// Silo Agent pools and enrolment (spec 10.2, 10.9).
export const createAgentPool = definePublicRoute({
    name: 'createAgentPool', method: 'POST', path: '/connect/agent-pools', session: 'complete', permission: { permission: 'agent.enrol' },
    body: agents.createAgentPool.body, response: agents.createAgentPool.response, status: 201, forwards: agents.createAgentPool,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const listAgentPools = definePublicRoute({
    name: 'listAgentPools', method: 'GET', path: '/connect/agent-pools', session: 'complete', permission: { permission: 'agent.view' },
    response: agents.listAgentPools.response, forwards: agents.listAgentPools, call: () => ({}), reply: (output) => output,
  });

export const issueAgentEnrolmentToken = definePublicRoute({
    name: 'issueAgentEnrolmentToken', method: 'POST', path: '/connect/agent-pools/:poolId/enrolment-tokens', session: 'complete',
    permission: { permission: 'agent.enrol' }, params: agents.issueAgentEnrolmentToken.params, response: agents.issueAgentEnrolmentToken.response,
    status: 201, forwards: agents.issueAgentEnrolmentToken, call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const revokeAgent = definePublicRoute({
    name: 'revokeAgent', method: 'POST', path: '/connect/agents/:agentId/revoke', session: 'complete', permission: { permission: 'agent.manage' },
    params: agents.revokeAgent.params, response: agents.revokeAgent.response, forwards: agents.revokeAgent,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

// Updates through Fleet (spec 10.7, 11.4).
export const setAgentPoolUpdatePolicy = definePublicRoute({
    name: 'setAgentPoolUpdatePolicy', method: 'PUT', path: '/connect/agent-pools/:poolId/update-policy', session: 'complete',
    permission: { permission: 'agent.manage' }, params: agents.setAgentPoolUpdatePolicy.params, body: agents.setAgentPoolUpdatePolicy.body,
    response: agents.setAgentPoolUpdatePolicy.response, forwards: agents.setAgentPoolUpdatePolicy,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const approveAgentPoolUpdate = definePublicRoute({
    name: 'approveAgentPoolUpdate', method: 'PUT', path: '/connect/agent-pools/:poolId/approved-version', session: 'complete',
    permission: { permission: 'agent.manage' }, params: agents.approveAgentPoolUpdate.params, body: agents.approveAgentPoolUpdate.body,
    response: agents.approveAgentPoolUpdate.response, forwards: agents.approveAgentPoolUpdate,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const listAgentReleases = definePublicRoute({
    name: 'listAgentReleases', method: 'GET', path: '/connect/agent-releases', session: 'complete', permission: { permission: 'agent.view' },
    response: agents.listAgentReleases.response, forwards: agents.listAgentReleases, call: () => ({}), reply: (output) => output,
  });

export const registerOutboundWebhook = definePublicRoute({
    name: 'registerOutboundWebhook', method: 'POST', path: '/connect/connections/:connectionId/outbound-webhooks', session: 'complete',
    decidedByService: OUTBOUND, params: ow.registerOutboundWebhook.params, body: ow.registerOutboundWebhook.body,
    response: ow.registerOutboundWebhook.response, status: 201, forwards: ow.registerOutboundWebhook,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const listOutboundWebhooks = definePublicRoute({
    name: 'listOutboundWebhooks', method: 'GET', path: '/connect/connections/:connectionId/outbound-webhooks', session: 'complete',
    decidedByService: OUTBOUND, params: ow.listOutboundWebhooks.params, response: ow.listOutboundWebhooks.response, forwards: ow.listOutboundWebhooks,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const revokeOutboundWebhook = definePublicRoute({
    name: 'revokeOutboundWebhook', method: 'POST', path: '/connect/outbound-webhooks/:endpointId/revoke', session: 'complete',
    decidedByService: OUTBOUND, params: ow.revokeOutboundWebhook.params, response: ow.revokeOutboundWebhook.response, forwards: ow.revokeOutboundWebhook,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const listConnectorsRoute = definePublicRoute({
    name: 'listConnectors', method: 'GET', path: '/connect/connectors', session: 'complete', permission: create,
    query: listConnectors.query, response: listConnectors.response, forwards: listConnectors, call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const getConnectorRoute = definePublicRoute({
    name: 'getConnector', method: 'GET', path: '/connect/connectors/:connectorId', session: 'complete', permission: create,
    params: getConnector.params, response: getConnector.response, forwards: getConnector, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const getConnectorSetupRoute = definePublicRoute({
    name: 'getConnectorSetup', method: 'GET', path: '/connect/connectors/:connectorId/setup', session: 'complete', permission: create,
    params: getConnectorSetup.params, query: getConnectorSetup.query, response: getConnectorSetup.response, forwards: getConnectorSetup,
    call: (i) => ({ params: i.params, query: i.query }), reply: (o) => o,
  });

export const listConnectionsRoute = definePublicRoute({
    name: 'listConnections', method: 'GET', path: '/connect/connections', session: 'complete', permission: create,
    query: listConnections.query, response: listConnections.response, forwards: listConnections, call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const getConnectionRoute = definePublicRoute({
    name: 'getConnection', method: 'GET', path: '/connect/connections/:connectionId', session: 'complete', permission: create,
    params: getConnection.params, response: getConnection.response, forwards: getConnection, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const renameConnectionRoute = definePublicRoute({
    name: 'renameConnection', method: 'PATCH', path: '/connect/connections/:connectionId', session: 'complete', decidedByService: OWNER_OR_MANAGE,
    params: renameConnection.params, body: renameConnection.body, response: renameConnection.response, forwards: renameConnection,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const setConnectionParametersRoute = definePublicRoute({
    name: 'setConnectionParameters', method: 'PUT', path: '/connect/connections/:connectionId/parameters', session: 'complete',
    decidedByService: OWNER_OR_MANAGE, params: setConnectionParameters.params, body: setConnectionParameters.body,
    response: setConnectionParameters.response, forwards: setConnectionParameters, call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const setConnectionSecretsRoute = definePublicRoute({
    name: 'setConnectionSecrets', method: 'POST', path: '/connect/connections/:connectionId/secrets', session: 'complete',
    decidedByService: OWNER_OR_ROTATE, params: setConnectionSecrets.params, body: setConnectionSecrets.body, response: setConnectionSecrets.response,
    forwards: setConnectionSecrets, call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const setConnectionPolicyAuthorityRoute = definePublicRoute({
    name: 'setConnectionPolicyAuthority', method: 'PUT', path: '/connect/connections/:connectionId/policy-authority', session: 'complete',
    decidedByService: 'connect-registry checks connection.policy_authority organisation-wide: a super admin\'s decision (14.7, 44.4)',
    params: setConnectionPolicyAuthority.params, body: setConnectionPolicyAuthority.body, response: setConnectionPolicyAuthority.response,
    forwards: setConnectionPolicyAuthority, call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const changeConnectionStatusRoute = definePublicRoute({
    name: 'changeConnectionStatus', method: 'POST', path: '/connect/connections/:connectionId/status', session: 'complete',
    decidedByService: STATUS_RULES, params: changeConnectionStatus.params, body: changeConnectionStatus.body, response: changeConnectionStatus.response,
    forwards: changeConnectionStatus, call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const startConformanceRunRoute = definePublicRoute({
    name: 'startConformanceRun', method: 'POST', path: '/connect/conformance-runs', session: 'complete', decidedByService: OWNER_OR_VERIFY,
    body: startConformanceRun.body, response: startConformanceRun.response, status: 202, forwards: startConformanceRun,
    call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const startChangeStreamClassRoute = definePublicRoute({
    name: 'startChangeStreamClass', method: 'POST', path: '/connect/connections/:connectionId/change-stream-class', session: 'complete',
    decidedByService: OWNER_OR_VERIFY, params: startChangeStreamClass.params, body: startChangeStreamClass.body,
    response: startChangeStreamClass.response, status: 202, forwards: startChangeStreamClass,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const getConformanceRunRoute = definePublicRoute({
    name: 'getConformanceRun', method: 'GET', path: '/connect/conformance-runs/:runId', session: 'complete', decidedByService: OWNER_OR_VERIFY,
    params: getConformanceRun.params, response: getConformanceRun.response, forwards: getConformanceRun, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const listConformanceRunsRoute = definePublicRoute({
    name: 'listConformanceRuns', method: 'GET', path: '/connect/connections/:connectionId/conformance-runs', session: 'complete',
    decidedByService: OWNER_OR_VERIFY, params: listConformanceRuns.params, query: listConformanceRuns.query, response: listConformanceRuns.response,
    forwards: listConformanceRuns, call: (i) => ({ params: i.params, query: i.query }), reply: (o) => o,
  });

export const startOAuthFlowRoute = definePublicRoute({
    name: 'startOAuthFlow', method: 'POST', path: '/connect/oauth/flows', session: 'complete',
    decidedByService: 'oauth allows the creator of a draft connection, its owner, or connection.reconnect at its owning scope',
    body: startOAuthFlow.body, response: startOAuthFlow.response, forwards: startOAuthFlow, call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const completeOAuthFlowRoute = definePublicRoute({
    name: 'completeOAuthFlow', method: 'POST', path: '/connect/oauth/callback', session: 'complete',
    decidedByService: 'oauth completes a flow only in the session that started it, by its single-use state',
    body: completeOAuthFlow.body, response: completeOAuthFlow.response, forwards: completeOAuthFlow, call: (i) => ({ body: i.body }), reply: (o) => o,
  });

// The private networks Silo reaches for this organisation's connections (an Enterprise
// VPC-to-VPC link); Silo staff add and remove them in the admin portal.
export const listPrivateLinksRoute = definePublicRoute({
    name: 'listPrivateLinks', method: 'GET', path: '/connect/private-links', session: 'complete', permission: { permission: 'connection.manage' },
    query: listPrivateLinks.query, response: listPrivateLinks.response, forwards: listPrivateLinks, call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const CONNECTION_ROUTES = [
  setConnectionPolicyAuthorityRoute,
  createAgentPool,
  listAgentPools,
  issueAgentEnrolmentToken,
  revokeAgent,
  setAgentPoolUpdatePolicy,
  approveAgentPoolUpdate,
  listAgentReleases,
  registerOutboundWebhook,
  listOutboundWebhooks,
  revokeOutboundWebhook,
  createIndustrialEndpoint,
  listIndustrialEndpoints,
  verifyIndustrialEndpoint,
  declareWritablePoint,
  listWritablePoints,
  raiseWritablePointRisk,
  setWritablePointTestSafe,
  retireWritablePoint,
  listConnectorsRoute,
  getConnectorRoute, getConnectorSetupRoute,
  listConnectionsRoute,
  getConnectionRoute,
  renameConnectionRoute,
  setConnectionParametersRoute,
  setConnectionSecretsRoute,
  changeConnectionStatusRoute,
  startConformanceRunRoute,
  startChangeStreamClassRoute,
  getConformanceRunRoute,
  listConformanceRunsRoute,
  startOAuthFlowRoute,
  completeOAuthFlowRoute,
  listPrivateLinksRoute,
] as const;
