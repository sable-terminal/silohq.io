// Model routing for model-gateway (spec 7.8, 62.7). Routes are Fleet configuration
// (spec 11.1), delivered as a JSON file, and "never leave the residency".
//
// Commercial cells use zero-retention endpoints only: "the gateway refuses any endpoint
// not registered as zero-retention". The sovereign cell uses a self-hosted open-weight
// model on UK infrastructure: no model call leaves the cell.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseSection, read, zPositiveInt, type Env } from './env.config.ts';

// The callers of model-gateway (spec 7.5) and the request types (spec 62.3, 62.5).
export const MODEL_ROLES = ['compile', 'compile_advanced', 'resolution', 'recognition', 'fde', 'connector_generation', 'document_extraction', 'embedding'] as const;

export const DOCUMENT_MEDIA_TYPES = ['text/plain', 'application/pdf', 'image/png', 'image/jpeg'] as const;

// How the gateway authenticates to the endpoint. workload_identity: an access token from
// the cell's metadata server (Vertex AI on GKE). bearer_file: a token read from a mounted
// file (a self-hosted model). none: the endpoint is reachable only inside the cell.
const routeAuth = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('workload_identity') }),
  z.object({ kind: z.literal('bearer_file'), file: z.string().min(1) }),
]);

const route = z.object({
  role: z.enum(MODEL_ROLES),
  provider: z.enum(['vertex_ai', 'self_hosted']),
  endpoint: z.url(),
  model: z.string().min(1).max(200),
  region: z.string().min(1),
  zeroRetention: z.boolean(),
  /** The Fleet route name recorded with every call (platform.model_calls.model_route). Default: the role. */
  name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/).optional(),
  /** Vertex AI: the Google Cloud project that holds the endpoint. */
  project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/).optional(),
  auth: routeAuth.default({ kind: 'none' }),
  /** A CA bundle for an endpoint signed by the cell's own CA. */
  caFile: z.string().min(1).optional(),
  /** Per call; below HTTP_REQUEST_TIMEOUT_MS, which the service checks at start. */
  timeoutMs: zPositiveInt(10 * 60_000).default(25_000),
  /** The most output tokens a caller may ask for on this route. */
  maxOutputTokens: zPositiveInt(1_000_000).default(8192),
  /** document_extraction: the file types this route's model reads. */
  documentMediaTypes: z.array(z.enum(DOCUMENT_MEDIA_TYPES)).min(1).default(['text/plain']),
  /** embedding: the length of each vector (the cell's pgvector column holds 1536), asked of the model and checked on every reply. */
  dimensions: zPositiveInt(8192).default(1536),
  /** embedding: texts in one request to the endpoint (some models take one at a time). */
  embedBatch: zPositiveInt(250).default(1),
  /**
   * What the provider charges on this route, in pounds per million tokens: input, and output
   * (thinking is charged as output). Recorded per call (platform.model_calls.provider_cost) for
   * the margin calculator and the engagement cost report; without it a call is unpriced.
   */
  pricing: z.object({
    inputPerMillion: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/),
    outputPerMillion: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/),
  }).optional(),
}).transform((r) => ({ ...r, name: r.name ?? r.role }));

const schema = z.object({
  routes: z.array(route).min(1).superRefine((routes, ctx) => {
    const roles = routes.map((r) => r.role);
    if (new Set(roles).size !== roles.length) ctx.addIssue({ code: 'custom', message: 'each role has exactly one route' });
    const names = routes.map((r) => r.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'route names are unique' });
  }),
  maxRequestBytes: zPositiveInt().default(256 * 1024),
  /** document_extraction: the largest document sent to a model. */
  maxDocumentBytes: zPositiveInt(64 * 1024 * 1024).default(10 * 1024 * 1024),
  perOrganisationConcurrency: zPositiveInt(1000).default(8),
  /** Model calls in flight across every gateway replica of the cell. */
  cellConcurrency: zPositiveInt(10_000).default(64),
  /** The metadata server that issues workload identity tokens (GCE_METADATA_HOST). */
  metadataHost: z.string().regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/).default('metadata.google.internal'),
});

export type ModelRole = (typeof MODEL_ROLES)[number];
export type DocumentMediaType = (typeof DOCUMENT_MEDIA_TYPES)[number];
export type ModelRoute = z.output<typeof route>;
export type ModelConfig = z.output<typeof schema>;

export function loadModelConfig(env: Env, problems: string[]): ModelConfig | undefined {
  const file = read(env, 'MODEL_ROUTES_FILE');
  if (file === undefined) return undefined;
  let routes: unknown;
  try {
    routes = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    problems.push('MODEL_ROUTES_FILE: cannot read the file as JSON');
    return undefined;
  }
  return parseSection(schema, {
    routes,
    maxRequestBytes: read(env, 'MODEL_MAX_REQUEST_BYTES'),
    maxDocumentBytes: read(env, 'MODEL_MAX_DOCUMENT_BYTES'),
    perOrganisationConcurrency: read(env, 'MODEL_PER_ORGANISATION_CONCURRENCY'),
    cellConcurrency: read(env, 'MODEL_CELL_CONCURRENCY'),
    metadataHost: read(env, 'GCE_METADATA_HOST'),
  }, {
    routes: 'MODEL_ROUTES_FILE', maxRequestBytes: 'MODEL_MAX_REQUEST_BYTES', maxDocumentBytes: 'MODEL_MAX_DOCUMENT_BYTES',
    perOrganisationConcurrency: 'MODEL_PER_ORGANISATION_CONCURRENCY', cellConcurrency: 'MODEL_CELL_CONCURRENCY',
    metadataHost: 'GCE_METADATA_HOST',
  }, problems);
}
