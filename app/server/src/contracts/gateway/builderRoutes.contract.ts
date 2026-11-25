// The build routes in the product (spec 16.3, 16.4, 16.6): the AI builder, the visual builder
// with its YAML view, and probing a connection's structure.
//
// Each route asks connector.build, which every member holds by default (spec 16.6). The
// services then apply the finer rules themselves: the registry's connector.edit and
// connection.create, and the sandbox's owner (or connection.manage where it is owned) for
// probing, previewing and confirming. Verifying a build needs connector.verify, decided by the
// registry when the person confirms.

import {
  confirmBuild as confirm, draftConnector as draft, getBuild as get, previewBuild as preview, probeBuild as probe,
} from '../connector-builder/build.contract.ts';
import { getOwnManifestDocument as ownDocument, listManifestVersions as versions } from '../connect-registry/connector.contract.ts';
import { inferConnection as infer } from '../schema-inference/inference.contract.ts';
import {
  convertDraft as convert, importDraft as importing, publishDraft as publish, setBuildSecrets as secrets, tryDraft as attempt, validateDraft as validate,
} from '../visual-builder/builder.contract.ts';
import { z } from 'zod';
import { definePublicRoute } from './publicRoute.contract.ts';

const build = { permission: 'connector.build' } as const;

export const draftConnector = definePublicRoute({
  name: 'draftConnector', method: 'POST', path: '/connect/builds', session: 'complete', permission: build,
  body: draft.body, response: draft.response, status: 201,
  forwards: draft, call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const probeBuild = definePublicRoute({
  name: 'probeBuild', method: 'POST', path: '/connect/builds/:connectionId/probes', session: 'complete', permission: build,
  params: probe.params, response: probe.response, status: 202,
  forwards: probe, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const getBuild = definePublicRoute({
  name: 'getBuild', method: 'GET', path: '/connect/builds/:connectionId', session: 'complete', permission: build,
  params: get.params, response: get.response,
  forwards: get, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const previewBuild = definePublicRoute({
  name: 'previewBuild', reads: true, method: 'POST', path: '/connect/builds/:connectionId/previews', session: 'complete', permission: build,
  params: preview.params, body: preview.body, response: preview.response,
  forwards: preview, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const confirmBuild = definePublicRoute({
  name: 'confirmBuild', method: 'POST', path: '/connect/builds/:connectionId/confirmations', session: 'complete', permission: build,
  params: confirm.params, body: confirm.body, response: confirm.response,
  forwards: confirm, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const validateDraft = definePublicRoute({
  name: 'validateDraft', reads: true, method: 'POST', path: '/connect/builder/validations', session: 'complete', permission: build,
  body: validate.body, response: validate.response,
  forwards: validate, call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const convertDraft = definePublicRoute({
  name: 'convertDraft', reads: true, method: 'POST', path: '/connect/builder/conversions', session: 'complete', permission: build,
  body: convert.body, response: convert.response,
  forwards: convert, call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const importDraft = definePublicRoute({
  name: 'importDraft', reads: true, method: 'POST', path: '/connect/builder/imports', session: 'complete', permission: build,
  body: importing.body, response: importing.response,
  forwards: importing, call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const tryDraft = definePublicRoute({
  name: 'tryDraft', method: 'POST', path: '/connect/builder/tries', session: 'complete', permission: build,
  body: attempt.body, response: attempt.response,
  forwards: attempt, call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const publishDraft = definePublicRoute({
  name: 'publishDraft', method: 'POST', path: '/connect/builder/publications', session: 'complete', permission: build,
  body: publish.body, response: publish.response, status: 202,
  forwards: publish, call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const setBuildSecrets = definePublicRoute({
  name: 'setBuildSecrets', method: 'POST', path: '/connect/builder/connections/:connectionId/secrets', session: 'complete', permission: build,
  params: secrets.params, body: secrets.body, response: secrets.response,
  forwards: secrets, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

const inferBody = infer.body.omit({ connectionId: true });

export const inferConnection = definePublicRoute({
  name: 'inferConnection', method: 'POST', path: '/connect/connections/:connectionId/inferences', session: 'complete', permission: build,
  params: z.strictObject({ connectionId: z.uuid() }), body: inferBody, response: infer.response,
  forwards: infer, call: (input) => ({ body: { ...input.body, connectionId: input.params.connectionId } }), reply: (output) => output,
});

/** A connector's versions, newest first: releases and the drafts tried on the way. */
export const listConnectorVersions = definePublicRoute({
  name: 'listConnectorVersions', method: 'GET', path: '/connect/connectors/:connectorId/versions', session: 'complete', permission: build,
  params: versions.params, response: versions.response, forwards: versions, call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** A version's document, of the organisation's own connector only, for the visual builder to open (D262). */
export const getConnectorDocument = definePublicRoute({
  name: 'getConnectorDocument', method: 'GET', path: '/connect/connectors/:connectorId/versions/:versionId/document', session: 'complete', permission: build,
  params: ownDocument.params, response: ownDocument.response, forwards: ownDocument, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const BUILDER_ROUTES = [
  draftConnector, probeBuild, getBuild, previewBuild, confirmBuild, validateDraft, convertDraft, importDraft, tryDraft, publishDraft, setBuildSecrets,
  inferConnection, listConnectorVersions, getConnectorDocument,
] as const;
