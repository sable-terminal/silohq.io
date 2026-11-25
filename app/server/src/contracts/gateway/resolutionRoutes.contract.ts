// Entity resolution in the product (spec 23): runs over a type, the review queue of
// resolution proposals with a live preview of the pairs, confirming and rejecting, proposing
// pairs and splits, and field authorities. The gateway decides the route's permission first;
// the resolution service decides again with the type as the resource, checks read access to
// every connection involved, and refuses a proposer confirming their own proposal.

import * as au from '../resolution/authority.contract.ts';
import * as pr from '../resolution/proposal.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const view = { permission: 'ontology.view' };
const onType = (permission: string) => ({ permission, resource: (input: { body: { objectTypeId: string } }) => ({ type: 'object_type' as const, id: input.body.objectTypeId }) });

export const startResolutionRun = definePublicRoute({
  name: 'startResolutionRun', method: 'POST', path: '/resolution/runs', session: 'complete', permission: onType('ontology.propose'),
  body: pr.startResolutionRun.body, response: pr.startResolutionRun.response, status: 202, forwards: pr.startResolutionRun,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const readResolutionRun = definePublicRoute({
  name: 'readResolutionRun', method: 'GET', path: '/resolution/runs/:runId', session: 'complete', permission: view,
  params: pr.getResolutionRun.params, response: pr.getResolutionRun.response, forwards: pr.getResolutionRun,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listResolutionProposals = definePublicRoute({
  name: 'listResolutionProposals', method: 'GET', path: '/resolution/proposals', session: 'complete', permission: view,
  query: pr.listResolutionProposals.query, response: pr.listResolutionProposals.response, forwards: pr.listResolutionProposals,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const readResolutionProposal = definePublicRoute({
  name: 'readResolutionProposal', method: 'GET', path: '/resolution/proposals/:proposalId', session: 'complete', permission: view,
  params: pr.getResolutionProposal.params, response: pr.getResolutionProposal.response, forwards: pr.getResolutionProposal,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const previewResolutionProposal = definePublicRoute({
  name: 'previewResolutionProposal', reads: true, method: 'POST', path: '/resolution/proposals/:proposalId/preview', session: 'complete', permission: view,
  params: pr.previewResolutionProposal.params, body: pr.previewResolutionProposal.body, response: pr.previewResolutionProposal.response,
  forwards: pr.previewResolutionProposal,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const proposeResolutionPairs = definePublicRoute({
  name: 'proposeResolutionPairs', method: 'POST', path: '/resolution/pair-proposals', session: 'complete', permission: onType('ontology.propose'),
  body: pr.proposePairs.body, response: pr.proposePairs.response, status: 201, forwards: pr.proposePairs,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const proposeResolutionSplit = definePublicRoute({
  name: 'proposeResolutionSplit', method: 'POST', path: '/resolution/split-proposals', session: 'complete',
  permission: { permission: 'ontology.propose' },
  body: pr.proposeSplit.body, response: pr.proposeSplit.response, status: 201, forwards: pr.proposeSplit,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const confirmResolutionProposal = definePublicRoute({
  name: 'confirmResolutionProposal', method: 'POST', path: '/resolution/proposals/:proposalId/confirm', session: 'complete',
  permission: { permission: 'resolution.confirm' },
  params: pr.confirmResolutionProposal.params, response: pr.confirmResolutionProposal.response, forwards: pr.confirmResolutionProposal,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const rejectResolutionProposal = definePublicRoute({
  name: 'rejectResolutionProposal', method: 'POST', path: '/resolution/proposals/:proposalId/reject', session: 'complete',
  permission: { permission: 'resolution.confirm' },
  params: pr.rejectResolutionProposal.params, response: pr.rejectResolutionProposal.response, forwards: pr.rejectResolutionProposal,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const declareFieldAuthority = definePublicRoute({
  name: 'declareFieldAuthority', method: 'POST', path: '/resolution/authorities', session: 'complete', permission: onType('authority.declare'),
  body: au.declareFieldAuthority.body, response: au.declareFieldAuthority.response, status: 201, forwards: au.declareFieldAuthority,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const revokeFieldAuthority = definePublicRoute({
  name: 'revokeFieldAuthority', method: 'POST', path: '/resolution/authorities/:authorityId/revoke', session: 'complete',
  permission: { permission: 'authority.declare' },
  params: au.revokeFieldAuthority.params, response: au.revokeFieldAuthority.response, forwards: au.revokeFieldAuthority,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listFieldAuthorities = definePublicRoute({
  name: 'listFieldAuthorities', method: 'GET', path: '/resolution/authorities', session: 'complete', permission: view,
  query: au.listFieldAuthorities.query, response: au.listFieldAuthorities.response, forwards: au.listFieldAuthorities,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const RESOLUTION_ROUTES = [
  startResolutionRun, readResolutionRun, listResolutionProposals, readResolutionProposal, previewResolutionProposal, proposeResolutionPairs,
  proposeResolutionSplit, confirmResolutionProposal, rejectResolutionProposal, declareFieldAuthority, revokeFieldAuthority, listFieldAuthorities,
] as const;
