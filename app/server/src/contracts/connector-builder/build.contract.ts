// connector-builder (catalogue; spec 16.3): the AI route to a connector.
//
// Stages, each recorded in connect.probe_runs against the sandbox connection, structure only:
// - parse: an OpenAPI document, a WSDL, a GraphQL introspection result or SDL, or an OData
//   $metadata document is compiled without a model; pasted documentation goes to
//   the model gateway's connector_generation role as documentation written for the schema,
//   never a record value (spec 62.1). The model chooses structure (paths, records, fields,
//   identifier, paging style, filter parameters); the builder writes every expression from
//   those choices. Output that does not match is refused, never repaired. The draft becomes
//   a private connector, its first version and a sandbox connection in draft. Generation is
//   charged (metering's connector_generation, keyed) only when a model call drafted it.
// - probe: each object read whole through schema-inference (records, envelope, paging); an
//   object a typed description declared (SOAP, GraphQL, OData) is read as declared, a sample
//   of its records, and the description stays the record of its structure.
// - reconcile: documented against observed, the probe the source of truth; at most one
//   more model round for objects the source does not know, then a draft every object of
//   which reads, or the object is left out and named.
// - conform: the conformance suite on that version; a failing pushdown is removed and the
//   suite runs again on the version without it.
// - propose_mapping: each object to an object type, its identifier and properties, and
//   foreign keys to proposed link types, each with its confidence.
// - confirm and verify: the person accepts or corrects each object (mapping_confirmed names
//   them); a holder of connector.verify then moves the connection to verified, private
//   tier, writes off.
// Failure is reported by the stage that failed; a half-built connector stays a draft the
// visual builder can open (spec 16.4).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const CALLERS = ['gateway'] as const;

export const BUILD_STAGES = ['parse', 'probe', 'reconcile', 'conform', 'propose_mapping', 'confirm', 'verify'] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];

export const documentation = z.discriminatedUnion('kind', [
  /** An OpenAPI 3 document, JSON or YAML. Compiled without a model. */
  z.strictObject({ kind: z.literal('openapi'), text: z.string().min(1).max(2 * 1024 * 1024) }),
  /** Documentation pasted by the person, written for the schema. Sent to the model; never a record. */
  z.strictObject({ kind: z.literal('text'), title: z.string().trim().min(1).max(200), text: z.string().min(1).max(20_000) }),
  /**
   * A service's own description (spec 14.4's discovery models): a WSDL (SOAP), a GraphQL
   * introspection result or SDL, or an OData service's $metadata. Compiled without a model,
   * as the visual builder imports it; GraphQL and OData need the base URL, which they do not say.
   */
  z.strictObject({ kind: z.literal('wsdl'), text: z.string().min(1).max(2 * 1024 * 1024) }),
  z.strictObject({ kind: z.literal('graphql'), text: z.string().min(1).max(2 * 1024 * 1024) }),
  z.strictObject({ kind: z.literal('odata'), text: z.string().min(1).max(2 * 1024 * 1024) }),
  /**
   * Email fallback (spec 14.4, 16.1): sample notifications of a system with no API, whole
   * messages. Drafted in the cell with no model (62.5: their values never reach one); only
   * counts are kept, never a sample.
   */
  z.strictObject({ kind: z.literal('email'), samples: z.array(z.string().min(1).max(128 * 1024)).min(1).max(10) }),
  /**
   * A specification or documentation URL (16.3 inputs 1 and 2): read by the cell, recognised
   * (OpenAPI, WSDL, OData $metadata, GraphQL, or documentation for people) and drafted as that.
   */
  z.strictObject({ kind: z.literal('url'), url: z.url({ protocol: /^https?$/ }).max(2_000) }),
  /** The base URL alone (16.3 input 3): its well-known description addresses are tried; a live credential follows at the probe. */
  z.strictObject({ kind: z.literal('base_url') }),
]);
export type Documentation = z.infer<typeof documentation>;

const confidence = z.number().min(0).max(1);

export const mappingProposal = z.object({
  object: name,
  objectType: z.string().max(200),
  confidence,
  identifier: z.array(name).max(8),
  properties: z.array(z.object({ field: name, property: z.string().max(200), type: z.string(), confidence })).max(2_000),
  links: z.array(z.object({ field: name, targetObject: name, targetField: name, confidence })).max(100),
});
export type MappingProposal = z.infer<typeof mappingProposal>;

export const buildStage = z.object({
  stage: z.enum(['parse', 'probe', 'reconcile', 'conform', 'propose_mapping', 'confirm', 'verify', 'recheck']),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  /** Structure and counts only. */
  findings: z.json().nullable(),
  errors: z.json().nullable(),
});

export const buildView = z.object({
  connectorId: z.uuid(),
  connectionId: z.uuid(),
  connectionStatus: z.string(),
  manifest: z.object({ id: z.uuid(), version: z.string() }),
  /** Where the build stands: the last stage and its status. */
  stage: z.enum(['parse', 'probe', 'reconcile', 'conform', 'propose_mapping', 'confirm', 'verify', 'recheck']),
  status: z.enum(['running', 'completed', 'failed']),
  /** Stages are still being worked on (a probe started and not yet ended). */
  running: z.boolean(),
  stages: z.array(buildStage),
  proposals: z.array(mappingProposal),
  conformanceRunId: z.uuid().nullable(),
});
export type BuildView = z.infer<typeof buildView>;

/** The gateway for a person; fde-orchestrator for an engagement's Integration principal, from the documentation the organisation gave it (51.4). */
export const draftConnector = defineContract({
  service: 'connector-builder', name: 'draftConnector', method: 'POST', path: '/v1/connector-builds', callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    name: z.string().trim().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    provider: z.string().trim().min(1).max(200),
    documentation,
    /** The system's base URL, when the documentation does not give it or gives another. */
    baseUrl: z.string().max(500).regex(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/).optional(),
    sandbox: z.strictObject({
      name: z.string().trim().min(1).max(200),
      owningScopeId: z.uuid(),
      parameters: z.record(z.string(), z.string().max(1_000)).optional(),
    }),
  }),
  response: buildView,
  status: 201,
  maxBodyBytes: 2 * 1024 * 1024 + 16_384,
});

const connectionId = z.strictObject({ connectionId: z.uuid() });

export const probeBuild = defineContract({
  service: 'connector-builder', name: 'probeBuild', method: 'POST', path: '/v1/connector-builds/:connectionId/probes', callers: [...CALLERS, 'fde-orchestrator'],
  // Probe, reconcile, conform and propose run after the reply; read the build to follow them.
  context: 'organisation', idempotency: 'keyed',
  params: connectionId,
  response: buildView,
  status: 202,
});

export const getBuild = defineContract({
  service: 'connector-builder', name: 'getBuild', method: 'GET', path: '/v1/connector-builds/:connectionId', callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  response: buildView,
});

export const previewBuild = defineContract({
  service: 'connector-builder', name: 'previewBuild', method: 'POST', path: '/v1/connector-builds/:connectionId/previews', callers: CALLERS,
  // A probe read: the person sees their own records, which nobody keeps (spec 16.3).
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({ object: name, limit: z.int().min(1).max(20).default(10) }),
  response: z.object({ rows: z.array(z.record(z.string(), z.json())).max(20) }),
  maxBodyBytes: 1_024,
});

export const confirmBuild = defineContract({
  service: 'connector-builder', name: 'confirmBuild', method: 'POST', path: '/v1/connector-builds/:connectionId/confirmations',
  callers: [...CALLERS, 'fde-orchestrator'],
  context: 'organisation', idempotency: 'keyed',
  params: connectionId,
  body: z.strictObject({
    decisions: z.array(z.strictObject({
      object: name,
      accept: z.boolean(),
      /** A correction: the object type this object is, in the organisation's words. */
      objectType: z.string().trim().min(1).max(200).optional(),
      identifier: z.array(name).min(1).max(8).optional(),
      properties: z.array(z.strictObject({ field: name, property: z.string().trim().min(1).max(200) })).max(2_000).optional(),
    })).min(1).max(500),
  }),
  response: buildView,
  maxBodyBytes: 512 * 1024,
});
