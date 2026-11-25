// Siloes in the product (spec 66 to 70): the switch (silo.enable), the Siloes page, Capture,
// retention, wipes and their receipts, the history read, and Import: sources, definitions,
// the carve-out, uploads and the extraction flag. Each service decides again; the gateway's
// permission is the first gate.

import * as im from '../siloes/import.contract.ts';
import * as l from '../siloes/captureLedger.contract.ts';
import * as s from '../siloes/siloes.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const perm = (permission: string) => ({ permission });

export const getSiloesSetting = definePublicRoute({
    name: 'getSiloesSetting', method: 'GET', path: '/siloes/setting', session: 'complete', permission: perm('silo.manage'),
    response: s.getSiloesSetting.response, forwards: s.getSiloesSetting, call: () => ({}), reply: (o) => o,
  });

export const setSiloesEnabled = definePublicRoute({
    name: 'setSiloesEnabled', method: 'POST', path: '/siloes/setting', session: 'complete', permission: perm('silo.enable'),
    body: s.setSiloesEnabled.body, response: s.setSiloesEnabled.response, forwards: s.setSiloesEnabled, call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const listSiloes = definePublicRoute({
    name: 'listSiloes', method: 'GET', path: '/siloes', session: 'complete', permission: perm('silo.manage'),
    query: s.listSiloes.query, response: s.listSiloes.response, forwards: s.listSiloes, call: (i) => ({ query: i.query }), reply: (o) => o,
  });

export const getSiloesWeb = definePublicRoute({
    name: 'getSiloesWeb', method: 'GET', path: '/siloes/web', session: 'complete', permission: perm('silo.manage'),
    response: s.getSiloesWeb.response, forwards: s.getSiloesWeb, call: () => ({}), reply: (o) => o,
  });

export const getSilo = definePublicRoute({
    name: 'getSilo', method: 'GET', path: '/siloes/:siloId', session: 'complete', permission: perm('silo.manage'),
    params: s.getSilo.params, response: s.getSilo.response, forwards: s.getSilo, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const createCaptureSilo = definePublicRoute({
    name: 'createCaptureSilo', method: 'POST', path: '/siloes/capture', session: 'complete', permission: perm('silo.create'),
    body: s.createCaptureSilo.body, response: s.createCaptureSilo.response, status: 201, forwards: s.createCaptureSilo, call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const addCaptureType = definePublicRoute({
    name: 'addCaptureType', method: 'POST', path: '/siloes/:siloId/types', session: 'complete', permission: perm('silo.manage'),
    params: s.addCaptureType.params, body: s.addCaptureType.body, response: s.addCaptureType.response, status: 201, forwards: s.addCaptureType,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const changeCaptureProperties = definePublicRoute({
    name: 'changeCaptureProperties', method: 'POST', path: '/siloes/:siloId/types/:objectTypeId/properties', session: 'complete', permission: perm('silo.manage'),
    params: s.changeCaptureProperties.params, body: s.changeCaptureProperties.body, response: s.changeCaptureProperties.response,
    forwards: s.changeCaptureProperties, call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const removeCaptureType = definePublicRoute({
    name: 'removeCaptureType', method: 'POST', path: '/siloes/:siloId/types/:objectTypeId/remove', session: 'complete', permission: perm('silo.manage'),
    params: s.removeCaptureType.params, response: s.removeCaptureType.response, forwards: s.removeCaptureType, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

// Lengthening needs silo.manage, shortening silo.purge: the service decides which.
export const changeRetention = definePublicRoute({
    name: 'changeRetention', method: 'POST', path: '/siloes/:siloId/retention', session: 'complete', permission: perm('silo.manage'),
    params: s.changeRetention.params, body: s.changeRetention.body, response: s.changeRetention.response, forwards: s.changeRetention,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const requestPurge = definePublicRoute({
    name: 'requestPurge', method: 'POST', path: '/siloes/:siloId/purges', session: 'complete', permission: perm('silo.purge'),
    params: s.requestPurge.params, body: s.requestPurge.body, response: s.requestPurge.response, status: 201, forwards: s.requestPurge,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const previewPurge = definePublicRoute({
    name: 'previewPurge', reads: true, method: 'POST', path: '/siloes/:siloId/purge-previews', session: 'complete', permission: perm('silo.purge'),
    params: s.previewPurge.params, body: s.previewPurge.body, response: s.previewPurge.response, forwards: s.previewPurge,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const getPurge = definePublicRoute({
    name: 'getPurge', method: 'GET', path: '/siloes/:siloId/purges/:purgeId', session: 'complete', permission: perm('silo.purge'),
    params: s.getPurge.params, response: s.getPurge.response, forwards: s.getPurge, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const listPurges = definePublicRoute({
    name: 'listPurges', method: 'GET', path: '/siloes/:siloId/purges', session: 'complete', permission: perm('silo.purge'),
    params: s.listPurges.params, query: s.listPurges.query, response: s.listPurges.response, forwards: s.listPurges,
    call: (i) => ({ params: i.params, query: i.query }), reply: (o) => o,
  });

export const createImportSilo = definePublicRoute({
    name: 'createImportSilo', method: 'POST', path: '/import-siloes', session: 'complete', permission: perm('silo.create'),
    body: im.createImportSilo.body, response: im.createImportSilo.response, status: 201, forwards: im.createImportSilo, call: (i) => ({ body: i.body }), reply: (o) => o,
  });

export const acknowledgeCarveout = definePublicRoute({
    name: 'acknowledgeCarveout', method: 'POST', path: '/import-siloes/:siloId/carveout', session: 'complete', permission: perm('silo.enable'),
    params: im.acknowledgeCarveout.params, response: im.acknowledgeCarveout.response, forwards: im.acknowledgeCarveout, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const draftSiloDefinition = definePublicRoute({
    name: 'draftSiloDefinition', method: 'POST', path: '/import-siloes/:siloId/definition-drafts', session: 'complete', permission: perm('silo.manage'),
    params: im.draftDefinition.params, body: im.draftDefinition.body, response: im.draftDefinition.response, forwards: im.draftDefinition,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const listPrebuiltDefinitions = definePublicRoute({
    name: 'listPrebuiltDefinitions', method: 'GET', path: '/import-definitions/prebuilt', session: 'complete', permission: perm('silo.manage'),
    response: im.listPrebuiltDefinitions.response, forwards: im.listPrebuiltDefinitions, call: () => ({}), reply: (o) => o,
  });

export const publishSiloDefinition = definePublicRoute({
    name: 'publishSiloDefinition', method: 'POST', path: '/import-siloes/:siloId/definitions', session: 'complete', permission: perm('silo.manage'),
    params: im.publishDefinition.params, body: im.publishDefinition.body, response: im.publishDefinition.response, status: 201, forwards: im.publishDefinition,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const listSiloDefinitions = definePublicRoute({
    name: 'listSiloDefinitions', method: 'GET', path: '/import-siloes/:siloId/definitions', session: 'complete', permission: perm('silo.import'),
    params: im.listDefinitions.params, response: im.listDefinitions.response, forwards: im.listDefinitions, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const createSiloSource = definePublicRoute({
    name: 'createSiloSource', method: 'POST', path: '/import-siloes/:siloId/sources', session: 'complete', permission: perm('silo.import'),
    params: im.createSource.params, body: im.createSource.body, response: im.createSource.response, status: 201, forwards: im.createSource,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const listSiloSources = definePublicRoute({
    name: 'listSiloSources', method: 'GET', path: '/import-siloes/:siloId/sources', session: 'complete', permission: perm('silo.import'),
    params: im.listSources.params, response: im.listSources.response, forwards: im.listSources, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const uploadSiloFile = definePublicRoute({
    name: 'uploadSiloFile', method: 'POST', path: '/import-siloes/:siloId/sources/:sourceId/files', session: 'complete', permission: perm('silo.import'),
    params: im.uploadFile.params, body: im.uploadFile.body, response: im.uploadFile.response, status: 201, forwards: im.uploadFile,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const beginSiloUpload = definePublicRoute({
    name: 'beginSiloUpload', method: 'POST', path: '/import-siloes/:siloId/sources/:sourceId/uploads', session: 'complete', permission: perm('silo.import'),
    params: im.beginUpload.params, body: im.beginUpload.body, response: im.beginUpload.response, status: 201, forwards: im.beginUpload,
    call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const completeSiloUpload = definePublicRoute({
    name: 'completeSiloUpload', method: 'POST', path: '/import-siloes/:siloId/sources/:sourceId/uploads/:uploadId/completion', session: 'complete',
    permission: perm('silo.import'), params: im.completeUpload.params, body: im.completeUpload.body, response: im.completeUpload.response, status: 201,
    forwards: im.completeUpload, call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
  });

export const listSiloFiles = definePublicRoute({
    name: 'listSiloFiles', method: 'GET', path: '/import-siloes/:siloId/files', session: 'complete', permission: perm('silo.import'),
    params: im.listFiles.params, response: im.listFiles.response, forwards: im.listFiles, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const listSiloExtractions = definePublicRoute({
    name: 'listSiloExtractions', method: 'GET', path: '/import-siloes/:siloId/extractions', session: 'complete', permission: perm('silo.import'),
    params: im.listExtractions.params, query: im.listExtractions.query, response: im.listExtractions.response, forwards: im.listExtractions,
    call: (i) => ({ params: i.params, query: i.query }), reply: (o) => o,
  });

export const getSiloExtraction = definePublicRoute({
    name: 'getSiloExtraction', method: 'GET', path: '/import-siloes/:siloId/extractions/:extractionId', session: 'complete', permission: perm('silo.import'),
    params: im.getExtraction.params, response: im.getExtraction.response, forwards: im.getExtraction, call: (i) => ({ params: i.params }), reply: (o) => o,
  });

export const confirmSiloExtraction = definePublicRoute({
    name: 'confirmSiloExtraction', method: 'POST', path: '/import-siloes/:siloId/extractions/:extractionId/confirm', session: 'complete',
    permission: perm('silo.import'), params: im.confirmExtraction.params, response: im.confirmExtraction.response, forwards: im.confirmExtraction,
    call: (i) => ({ params: i.params }), reply: (o) => o,
  });

/** The object view's timeline, observed changes (34.4): Capture decides what the reader may see. */
export const readObjectChanges = definePublicRoute({
  name: 'readObjectChanges', reads: true, method: 'POST', path: '/siloes/object-changes', session: 'complete', permission: perm('ontology.view'),
  body: s.readObjectChanges.body, response: s.readObjectChanges.response, forwards: s.readObjectChanges,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

// The Action ledger in a Capture Silo, where the cell has no Warehouse (48.2; D205): switched by
// silo.enable with its disclosure, read by silo.manage through the reader's own access.
export const setCaptureActionLedger = definePublicRoute({
  name: 'setCaptureActionLedger', method: 'POST', path: '/siloes/:siloId/action-ledger', session: 'complete', permission: perm('silo.enable'),
  params: l.setCaptureActionLedger.params, body: l.setCaptureActionLedger.body, response: l.setCaptureActionLedger.response,
  forwards: l.setCaptureActionLedger, call: (i) => ({ params: i.params, body: i.body }), reply: (o) => o,
});

export const listCaptureLedger = definePublicRoute({
  name: 'listCaptureLedger', method: 'GET', path: '/siloes/:siloId/action-ledger', session: 'complete', permission: perm('silo.manage'),
  params: l.listCaptureLedger.params, query: l.listCaptureLedger.query, response: l.listCaptureLedger.response,
  forwards: l.listCaptureLedger, call: (i) => ({ params: i.params, query: i.query }), reply: (o) => o,
});

const routes = [
  setCaptureActionLedger,
  listCaptureLedger,
  getSiloesSetting,
  setSiloesEnabled,
  listSiloes,
  getSiloesWeb,
  getSilo,
  createCaptureSilo,
  addCaptureType,
  changeCaptureProperties,
  removeCaptureType,
  changeRetention,
  requestPurge,
  previewPurge,
  getPurge,
  listPurges,
  createImportSilo,
  acknowledgeCarveout,
  draftSiloDefinition,
  publishSiloDefinition,
  listSiloDefinitions,
  listPrebuiltDefinitions,
  createSiloSource,
  listSiloSources,
  uploadSiloFile,
  beginSiloUpload,
  completeSiloUpload,
  listSiloFiles,
  listSiloExtractions,
  getSiloExtraction,
  confirmSiloExtraction,
  readObjectChanges,
] as const;

export const SILOES_ROUTES = routes;
