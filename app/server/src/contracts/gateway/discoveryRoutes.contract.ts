// Agent discovery in the product (spec 19): the switch, scan authorisations and runs, and
// reviewing findings. A scan's approval is an approval chain, decided through the approvals
// routes like any other. Each route's permission is the one the service starts from; the
// service decides the rest (discovery.manage organisation-wide for the switch; nothing at
// all while discovery is off).

import {
  getDiscoverySettings as getSettings, getFinding as finding, getScanAuthorisation as getAuthorisation, getScanRun as getRun,
  listFindings as findings, listScanAuthorisations as listAuthorisations, listScanRuns as listRuns, requestScanAuthorisation as requestAuthorisation,
  reviewFinding as review, revokeScanAuthorisation as revokeAuthorisation, setDiscoveryEnabled as setEnabled, startScan as start,
} from '../discovery/discovery.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

export const getDiscoverySettings = definePublicRoute({
  name: 'getDiscoverySettings', method: 'GET', path: '/discovery/settings', session: 'complete',
  permission: { permission: 'discovery.review' },
  response: getSettings.response,
  forwards: getSettings,
  call: () => ({}),
  reply: (output) => output,
});

export const setDiscoveryEnabled = definePublicRoute({
  name: 'setDiscoveryEnabled', method: 'PUT', path: '/discovery/settings', session: 'complete',
  permission: { permission: 'discovery.manage' },
  body: setEnabled.body,
  response: setEnabled.response,
  forwards: setEnabled,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const requestScanAuthorisation = definePublicRoute({
  name: 'requestScanAuthorisation', method: 'POST', path: '/discovery/authorisations', session: 'complete',
  permission: { permission: 'discovery.authorise' },
  body: requestAuthorisation.body,
  response: requestAuthorisation.response,
  status: 201,
  forwards: requestAuthorisation,
  call: (input) => ({ body: input.body }),
  reply: (output) => output,
});

export const listScanAuthorisations = definePublicRoute({
  name: 'listScanAuthorisations', method: 'GET', path: '/discovery/authorisations', session: 'complete',
  permission: { permission: 'discovery.authorise' },
  query: listAuthorisations.query,
  response: listAuthorisations.response,
  forwards: listAuthorisations,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const getScanAuthorisation = definePublicRoute({
  name: 'getScanAuthorisation', method: 'GET', path: '/discovery/authorisations/:authorisationId', session: 'complete',
  permission: { permission: 'discovery.authorise' },
  params: getAuthorisation.params,
  response: getAuthorisation.response,
  forwards: getAuthorisation,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const revokeScanAuthorisation = definePublicRoute({
  name: 'revokeScanAuthorisation', method: 'POST', path: '/discovery/authorisations/:authorisationId/revoke', session: 'complete',
  permission: { permission: 'discovery.authorise' },
  params: revokeAuthorisation.params,
  response: revokeAuthorisation.response,
  forwards: revokeAuthorisation,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const startScan = definePublicRoute({
  name: 'startScan', method: 'POST', path: '/discovery/authorisations/:authorisationId/runs', session: 'complete',
  permission: { permission: 'discovery.authorise' },
  params: start.params,
  response: start.response,
  status: 202,
  forwards: start,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const getScanRun = definePublicRoute({
  name: 'getScanRun', method: 'GET', path: '/discovery/runs/:runId', session: 'complete',
  permission: { permission: 'discovery.authorise' },
  params: getRun.params,
  response: getRun.response,
  forwards: getRun,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const listScanRuns = definePublicRoute({
  name: 'listScanRuns', method: 'GET', path: '/discovery/authorisations/:authorisationId/runs', session: 'complete',
  permission: { permission: 'discovery.authorise' },
  params: listRuns.params, query: listRuns.query, response: listRuns.response, forwards: listRuns,
  call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});

export const listFindings = definePublicRoute({
  name: 'listFindings', method: 'GET', path: '/discovery/findings', session: 'complete',
  permission: { permission: 'discovery.review' },
  query: findings.query,
  response: findings.response,
  forwards: findings,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const getFinding = definePublicRoute({
  name: 'getFinding', method: 'GET', path: '/discovery/findings/:findingId', session: 'complete',
  permission: { permission: 'discovery.review' },
  params: finding.params,
  response: finding.response,
  forwards: finding,
  call: (input) => ({ params: input.params }),
  reply: (output) => output,
});

export const reviewFinding = definePublicRoute({
  name: 'reviewFinding', method: 'POST', path: '/discovery/findings/:findingId/review', session: 'complete',
  permission: { permission: 'discovery.review' },
  params: review.params,
  body: review.body,
  response: review.response,
  forwards: review,
  call: (input) => ({ params: input.params, body: input.body }),
  reply: (output) => output,
});

export const DISCOVERY_ROUTES = [
  getDiscoverySettings, setDiscoveryEnabled, requestScanAuthorisation, listScanAuthorisations, getScanAuthorisation,
  revokeScanAuthorisation, startScan, getScanRun, listScanRuns, listFindings, getFinding, reviewFinding,
] as const;
