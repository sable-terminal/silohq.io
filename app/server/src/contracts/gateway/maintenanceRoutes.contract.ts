// Connector maintenance in the product (spec 17.3 to 17.5): asking for a re-check, reading
// re-checks and heal proposals, and deciding one awaiting review.
//
// Each route's permission is the one the forwarded service starts from: connector.verify to
// ask for a re-check, connector.heal_review to read and decide. The service then decides at
// the connection's owning scope, where the connection's owner may act without either; an
// owner without them reaches these through the service, not the gateway, until policy can
// decide "the owner, or the permission at the owning scope" (as for Connect's owner routes).

import {
  decideHealProposal as decide, getHealProposal as getProposal, getRecheck as get, listHealProposals as listProposals,
  listRechecks as list, requestRecheck as request,
} from '../connector-maintenance/maintenance.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

export const requestRecheck = definePublicRoute({
  name: 'requestRecheck', method: 'POST', path: '/connect/connections/:connectionId/rechecks', session: 'complete',
  permission: { permission: 'connector.verify', resource: (input) => ({ type: 'connection', id: input.params.connectionId }) },
  params: request.params,
  response: request.response,
  status: 202,
  forwards: request,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const listRechecks = definePublicRoute({
  name: 'listRechecks', method: 'GET', path: '/connect/connections/:connectionId/rechecks', session: 'complete',
  permission: { permission: 'connector.heal_review', resource: (input) => ({ type: 'connection', id: input.params.connectionId }) },
  params: list.params,
  query: list.query,
  response: list.response,
  forwards: list,
  call: (input) => ({ params: input.params, query: input.query }),
  reply: (output) => output,
});

export const getRecheck = definePublicRoute({
  name: 'getRecheck', method: 'GET', path: '/connect/rechecks/:recheckId', session: 'complete',
  permission: { permission: 'connector.heal_review' },
  params: get.params,
  response: get.response,
  forwards: get,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const listHealProposals = definePublicRoute({
  name: 'listHealProposals', method: 'GET', path: '/connect/heal-proposals', session: 'complete',
  permission: { permission: 'connector.heal_review' },
  query: listProposals.query,
  response: listProposals.response,
  forwards: listProposals,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const getHealProposal = definePublicRoute({
  name: 'getHealProposal', method: 'GET', path: '/connect/heal-proposals/:proposalId', session: 'complete',
  permission: { permission: 'connector.heal_review' },
  params: getProposal.params,
  response: getProposal.response,
  forwards: getProposal,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const decideHealProposal = definePublicRoute({
  name: 'decideHealProposal', method: 'POST', path: '/connect/heal-proposals/:proposalId/decision', session: 'complete',
  permission: { permission: 'connector.heal_review' },
  params: decide.params,
  body: decide.body,
  response: decide.response,
  status: 202,
  forwards: decide,
  call: (input) => ({ params: input.params, body: input.body }),
  reply: (output) => output,
});

export const MAINTENANCE_ROUTES = [
  requestRecheck, listRechecks, getRecheck, listHealProposals, getHealProposal, decideHealProposal,
] as const;
