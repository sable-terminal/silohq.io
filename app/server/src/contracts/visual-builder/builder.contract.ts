// visual-builder (catalogue; spec 16.4): the server side of building a manifest by hand,
// block by block, with the YAML view as the raw form of the same document.
//
// - validateDraft checks one step's block of a draft (transport, auth, an object's
//   records, fields, paging or pushdown, the error rules) against the manifest schema and
//   compiles its expressions for their blocks (spec 14.2), so a half-built draft shows its
//   errors where they are. A complete draft is checked as the registry will check it.
// - convertDraft turns YAML into the document and back, placing each schema error at its
//   line and column.
// - tryDraft saves the draft as a new prerelease version of the private connector
//   (<version>-draft.<n>: a version never changes once read), moves the sandbox connection
//   to it (or creates it, in draft), and reads one object as a probe through
//   connect-runtime. The rows read go back to the person and nowhere else: never stored,
//   logged or sent to a model (spec 16.3). A failure is reported by stage: a draft that is
//   not a valid manifest is refused with its issues (nothing saved), and a source that
//   refuses the read answers by meaning.
// - publishDraft saves the release version, moves the connection to it and to probing,
//   and starts the conformance suite (spec 17.1), after which the connection can be
//   confirmed (connector.verify).
// - setBuildSecrets gives the sandbox connection its first secrets, sealed by the
//   credential service; the builder never keeps them.

import { z } from 'zod';
import { pushdownSplit } from '../connect/step.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const CALLERS = ['gateway'] as const;

export const BUILD_STEPS = ['transport', 'auth', 'objects', 'records', 'fields', 'paging', 'pushdown', 'errors'] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

export const draftIssue = z.object({
  /** Where in the document, as a dot path (document.objects.0.fields.2.type). */
  path: z.string().max(500),
  code: z.string().max(100),
  message: z.string().max(500),
  /** YAML only: where the node sits in the text, 1-based. */
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
});
export type DraftIssue = z.infer<typeof draftIssue>;

const document = z.record(z.string(), z.json());

export const validateDraft = defineContract({
  service: 'visual-builder', name: 'validateDraft', method: 'POST', path: '/v1/visual-builder/validations', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    document,
    /** The block being built; the whole draft when absent. */
    step: z.enum(BUILD_STEPS).optional(),
    /** Object steps: which object (all of them when absent). */
    object: name.optional(),
  }),
  response: z.object({
    /** The whole draft is a valid manifest. */
    complete: z.boolean(),
    /** The checked part has no issues. */
    valid: z.boolean(),
    issues: z.array(draftIssue).max(200),
  }),
  maxBodyBytes: 2 * 1024 * 1024,
});

export const convertDraft = defineContract({
  service: 'visual-builder', name: 'convertDraft', method: 'POST', path: '/v1/visual-builder/conversions', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.discriminatedUnion('to', [
    z.strictObject({ to: z.literal('yaml'), document }),
    z.strictObject({ to: z.literal('json'), yaml: z.string().max(2 * 1024 * 1024) }),
  ]),
  response: z.object({
    document: document.nullable(),
    yaml: z.string().nullable(),
    issues: z.array(draftIssue).max(200),
  }),
  maxBodyBytes: 2 * 1024 * 1024 + 4_096,
});

/**
 * A draft from a service's own description (spec 14.4's discovery models): a WSDL for SOAP,
 * an introspection result or SDL for GraphQL. Compiled without a model and checked as a draft;
 * what was left out is named in the notes. Nothing is saved.
 */
export const importDraft = defineContract({
  service: 'visual-builder', name: 'importDraft', method: 'POST', path: '/v1/visual-builder/imports', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    /** wsdl: SOAP; graphql: an introspection result or SDL; odata: a service's $metadata (CSDL). */
    kind: z.enum(['wsdl', 'graphql', 'odata']),
    text: z.string().min(1).max(2 * 1024 * 1024),
    name: z.string().trim().min(1).max(200),
    provider: z.string().trim().min(1).max(200),
    /** GraphQL: the endpoint's origin; OData: the service root. Neither document says it. A WSDL names its own. */
    baseUrl: z.string().max(500).regex(/^https?:\/\/[^\s]+$/).optional(),
  }),
  response: z.object({
    document,
    notes: z.array(z.string().max(300)).max(200),
    /** The draft's issues as a whole manifest (none: it is complete). */
    issues: z.array(draftIssue).max(200),
  }),
  maxBodyBytes: 2 * 1024 * 1024 + 4_096,
});

const versionView = z.object({ id: z.uuid(), version: z.string() });
const sandboxView = z.object({ id: z.uuid(), status: z.string(), version: z.number().int() });

export const tryDraft = defineContract({
  service: 'visual-builder', name: 'tryDraft', method: 'POST', path: '/v1/visual-builder/tries', callers: CALLERS,
  // A try saves a version; a retry under the same key saves no other and reads again.
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    connectorId: z.uuid(),
    document,
    /** The sandbox connection; absent on the first try, which creates it from connection. */
    connectionId: z.uuid().optional(),
    connection: z.strictObject({
      name: z.string().trim().min(1).max(200),
      owningScopeId: z.uuid(),
      parameters: z.record(z.string(), z.string().max(1_000)).optional(),
      agentPoolId: z.uuid().optional(),
    }).optional(),
    /** The object to read. */
    object: name,
    limit: z.int().min(1).max(50).default(10),
  }).refine((b) => (b.connectionId === undefined) !== (b.connection === undefined), 'name the sandbox connection, or describe the one to create'),
  response: z.object({
    /** read: the probe returned rows. refused: the source refused, by meaning. A draft that is not a valid manifest is refused with its issues, and nothing is saved. */
    outcome: z.enum(['read', 'refused']),
    /** The probe run recorded for this read (structure and counts only). */
    probeRunId: z.uuid(),
    manifest: versionView,
    connection: sandboxView,
    /** The rows read, for the person only. Never stored. */
    rows: z.array(z.record(z.string(), z.json())).max(50),
    stats: z.object({ pages: z.number().int(), sourceRows: z.number().int(), typeMismatches: z.number().int(), retries: z.number().int() }).nullable(),
    pushdown: pushdownSplit.nullable(),
    /** The source's refusal, by code and meaning. */
    failure: z.object({ code: z.string(), meaning: z.string().nullable() }).nullable(),
  }),
  maxBodyBytes: 2 * 1024 * 1024,
});

export const publishDraft = defineContract({
  service: 'visual-builder', name: 'publishDraft', method: 'POST', path: '/v1/visual-builder/publications', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ connectorId: z.uuid(), connectionId: z.uuid(), document }),
  response: z.object({ manifest: versionView, connection: sandboxView, conformanceRunId: z.uuid() }),
  status: 202,
  maxBodyBytes: 2 * 1024 * 1024,
});

export const setBuildSecrets = defineContract({
  service: 'visual-builder', name: 'setBuildSecrets', method: 'POST', path: '/v1/visual-builder/connections/:connectionId/secrets',
  callers: CALLERS,
  // Replacing a value with itself leaves the connection as it was.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectionId: z.uuid() }),
  body: z.strictObject({ values: z.record(name, z.string().min(1).max(16_384)) }),
  response: z.object({
    fields: z.array(z.object({ name: z.string(), kind: z.enum(['secret', 'public']), lastFour: z.string().nullable() })),
  }),
  maxBodyBytes: 128 * 1024,
});
