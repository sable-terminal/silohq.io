// Recognition in the product (spec 38): the detector registry and each type's
// configuration, on-demand runs, findings with their panel on an object view, organisation
// dispositions, ranking, the member's own Lenses, outcomes and association analysis, and
// investigation. The gateway decides the route's
// permission first; the recognition service decides again where the type is the resource,
// and applies the reader's visibility to every finding.

import * as a from '../recognition/association.contract.ts';
import * as d from '../recognition/detector.contract.ts';
import * as f from '../recognition/finding.contract.ts';
import * as l from '../recognition/lens.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const view = { permission: 'ontology.view' };
const run = { permission: 'recognition.run' };

export const listRecognitionDetectors = definePublicRoute({
  name: 'listRecognitionDetectors', method: 'GET', path: '/recognition/detectors', session: 'complete', permission: run,
  response: d.listDetectors.response, forwards: d.listDetectors, call: () => ({}), reply: (output) => output,
});

export const configureRecognitionDetector = definePublicRoute({
  name: 'configureRecognitionDetector', method: 'PUT', path: '/recognition/object-types/:objectTypeId/detectors/:detector', session: 'complete',
  permission: { permission: 'recognition.configure', resource: (input: { params: { objectTypeId: string } }) => ({ type: 'object_type' as const, id: input.params.objectTypeId }) },
  params: d.configureDetector.params, body: d.configureDetector.body, response: d.configureDetector.response, forwards: d.configureDetector,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const listRecognitionConfigurations = definePublicRoute({
  name: 'listRecognitionConfigurations', method: 'GET', path: '/recognition/object-types/:objectTypeId/detectors', session: 'complete', permission: view,
  params: d.listConfigurations.params, response: d.listConfigurations.response, forwards: d.listConfigurations,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const runRecognitionDetectors = definePublicRoute({
  name: 'runRecognitionDetectors', method: 'POST', path: '/recognition/runs', session: 'complete', permission: run,
  body: d.runDetectors.body, response: d.runDetectors.response, forwards: d.runDetectors,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const readRecognitionRun = definePublicRoute({
  name: 'readRecognitionRun', method: 'GET', path: '/recognition/runs/:runId', session: 'complete', permission: view,
  params: d.getRun.params, response: d.getRun.response, forwards: d.getRun, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listRecognitionFindings = definePublicRoute({
  name: 'listRecognitionFindings', method: 'GET', path: '/recognition/findings', session: 'complete', permission: view,
  query: f.listFindings.query, response: f.listFindings.response, forwards: f.listFindings,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const readRecognitionFinding = definePublicRoute({
  name: 'readRecognitionFinding', method: 'GET', path: '/recognition/findings/:findingId', session: 'complete', permission: view,
  params: f.getFinding.params, query: f.getFinding.query, response: f.getFinding.response, forwards: f.getFinding,
  call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});

export const listObjectFindings = definePublicRoute({
  name: 'listObjectFindings', method: 'GET', path: '/recognition/object-types/:objectTypeId/objects/:objectId/findings', session: 'complete',
  permission: view, params: f.listObjectFindings.params, query: f.listObjectFindings.query, response: f.listObjectFindings.response,
  forwards: f.listObjectFindings, call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});

export const dispositionRecognitionFinding = definePublicRoute({
  name: 'dispositionRecognitionFinding', method: 'POST', path: '/recognition/findings/:findingId/disposition', session: 'complete',
  permission: { permission: 'finding.disposition' }, params: f.dispositionFinding.params, body: f.dispositionFinding.body,
  response: f.dispositionFinding.response, forwards: f.dispositionFinding,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const rankRecognitionFindings = definePublicRoute({
  name: 'rankRecognitionFindings', reads: true, method: 'POST', path: '/recognition/rankings', session: 'complete', permission: run,
  body: f.rankFindings.body, response: f.rankFindings.response, forwards: f.rankFindings,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const createRecognitionLens = definePublicRoute({
  name: 'createRecognitionLens', method: 'POST', path: '/recognition/lenses', session: 'complete', ownRecords: true,
  body: l.createLens.body, response: l.createLens.response, status: 201, forwards: l.createLens,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listRecognitionLenses = definePublicRoute({
  name: 'listRecognitionLenses', method: 'GET', path: '/recognition/lenses', session: 'complete', ownRecords: true,
  response: l.listLenses.response, forwards: l.listLenses, call: () => ({}), reply: (output) => output,
});

export const updateRecognitionLens = definePublicRoute({
  name: 'updateRecognitionLens', method: 'PATCH', path: '/recognition/lenses/:lensId', session: 'complete', ownRecords: true,
  params: l.updateLens.params, body: l.updateLens.body, response: l.updateLens.response, forwards: l.updateLens,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const recordRecognitionLensDisposition = definePublicRoute({
  name: 'recordRecognitionLensDisposition', method: 'PUT', path: '/recognition/lenses/:lensId/dispositions/:findingId', session: 'complete',
  ownRecords: true, params: l.recordLensDisposition.params, body: l.recordLensDisposition.body, response: l.recordLensDisposition.response,
  forwards: l.recordLensDisposition, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

const LENS_DECIDES = 'recognition decides: the Lens owner shares it, and a recipient opens it under their own access (decision 2026-11-14)';

export const shareRecognitionLens = definePublicRoute({
  name: 'shareRecognitionLens', method: 'POST', path: '/recognition/lenses/:lensId/shares', session: 'complete',
  permission: { permission: 'lens.share' }, params: l.shareLens.params, body: l.shareLens.body, response: l.shareLens.response, status: 201,
  forwards: l.shareLens, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const listRecognitionLensShares = definePublicRoute({
  name: 'listRecognitionLensShares', method: 'GET', path: '/recognition/lenses/:lensId/shares', session: 'complete', ownRecords: true,
  params: l.listLensShares.params, response: l.listLensShares.response, forwards: l.listLensShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const revokeRecognitionLensShare = definePublicRoute({
  name: 'revokeRecognitionLensShare', method: 'DELETE', path: '/recognition/lens-shares/:shareId', session: 'complete', ownRecords: true,
  params: l.revokeLensShare.params, response: l.revokeLensShare.response, forwards: l.revokeLensShare,
  call: (input) => ({ params: input.params }), reply: () => undefined,
});

export const openRecognitionLens = definePublicRoute({
  name: 'openRecognitionLens', method: 'GET', path: '/recognition/lenses/:lensId', session: 'complete', decidedByService: LENS_DECIDES,
  params: l.openLens.params, response: l.openLens.response, forwards: l.openLens, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listSharedRecognitionLenses = definePublicRoute({
  name: 'listSharedRecognitionLenses', method: 'GET', path: '/recognition/shared-lenses', session: 'complete', decidedByService: LENS_DECIDES,
  response: l.listSharedLenses.response, forwards: l.listSharedLenses, call: () => ({}), reply: (output) => output,
});

export const copyRecognitionLens = definePublicRoute({
  name: 'copyRecognitionLens', method: 'POST', path: '/recognition/lenses/:lensId/copy', session: 'complete', decidedByService: LENS_DECIDES,
  params: l.copyLens.params, body: l.copyLens.body, response: l.copyLens.response, status: 201, forwards: l.copyLens,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const designateRecognitionOutcome = definePublicRoute({
  name: 'designateRecognitionOutcome', method: 'POST', path: '/recognition/outcomes', session: 'complete',
  permission: { permission: 'outcome.designate', resource: (input: { body: { objectTypeId: string } }) => ({ type: 'object_type' as const, id: input.body.objectTypeId }) },
  body: a.designateOutcome.body, response: a.designateOutcome.response, status: 201, forwards: a.designateOutcome,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const revokeRecognitionOutcome = definePublicRoute({
  name: 'revokeRecognitionOutcome', method: 'POST', path: '/recognition/outcomes/:outcomeId/revoke', session: 'complete',
  permission: { permission: 'outcome.designate' }, params: a.revokeOutcome.params, response: a.revokeOutcome.response, forwards: a.revokeOutcome,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listRecognitionOutcomes = definePublicRoute({
  name: 'listRecognitionOutcomes', method: 'GET', path: '/recognition/outcomes', session: 'complete', permission: view,
  query: a.listOutcomes.query, response: a.listOutcomes.response, forwards: a.listOutcomes,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const computeRecognitionAssociations = definePublicRoute({
  name: 'computeRecognitionAssociations', method: 'POST', path: '/recognition/associations/computations', session: 'complete', permission: run,
  response: a.computeAssociations.response, status: 201, forwards: a.computeAssociations, call: () => ({}), reply: (output) => output,
});

export const listRecognitionAssociations = definePublicRoute({
  name: 'listRecognitionAssociations', method: 'GET', path: '/recognition/associations', session: 'complete', permission: view,
  query: a.listAssociations.query, response: a.listAssociations.response, forwards: a.listAssociations,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const investigateRecognition = definePublicRoute({
  name: 'investigateRecognition', reads: true, method: 'POST', path: '/recognition/investigations', session: 'complete', permission: run,
  body: a.investigate.body, response: a.investigate.response, forwards: a.investigate,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const RECOGNITION_ROUTES = [
  listRecognitionDetectors, configureRecognitionDetector, listRecognitionConfigurations, runRecognitionDetectors, readRecognitionRun,
  listRecognitionFindings, readRecognitionFinding, listObjectFindings, dispositionRecognitionFinding, rankRecognitionFindings,
  createRecognitionLens, listRecognitionLenses, updateRecognitionLens, recordRecognitionLensDisposition,
  shareRecognitionLens, listRecognitionLensShares, revokeRecognitionLensShare, openRecognitionLens, listSharedRecognitionLenses, copyRecognitionLens,
  designateRecognitionOutcome, revokeRecognitionOutcome, listRecognitionOutcomes, computeRecognitionAssociations, listRecognitionAssociations,
  investigateRecognition,
] as const;
