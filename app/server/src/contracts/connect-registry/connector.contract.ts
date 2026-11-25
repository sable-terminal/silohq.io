// connect-registry: connectors and their immutable manifest versions (spec 14.3, 14.8, 16).
// A tenant creates private connectors only; global catalogue rows arrive by Fleet release
// or the Silo promotion review (catalogue reference rule, design doc).

import { z } from 'zod';
import { connectorSchema } from '../../schemas/connect/connector.schema.ts';
import { AUTH_STRATEGIES } from '../connect/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

// discovery: an approved finding promoted to a private connector and a draft connection (spec 19.4).
const CALLERS = ['gateway', 'connector-builder', 'visual-builder', 'conformance', 'connector-maintenance', 'discovery'] as const;

export const connectorView = connectorSchema.pick({
  id: true, organisationId: true, kind: true, slug: true, name: true, provider: true, description: true, trustTier: true,
  sourceRoute: true, status: true, createdAt: true, version: true,
}).extend({ currentManifestId: z.uuid().nullable() });
export type ConnectorView = z.infer<typeof connectorView>;

export const manifestVersionView = z.object({
  id: z.uuid(),
  connectorId: z.uuid(),
  version: z.string(),
  schemaVersion: z.string(),
  /** SHA-256 of the canonical document, hex. */
  documentHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourceRoute: z.enum(['catalogue', 'ai', 'visual', 'silo']),
  parentVersionId: z.uuid().nullable(),
  firstUsedAt: z.string().nullable(),
  createdAt: z.string(),
  supersededAt: z.string().nullable(),
});
export type ManifestVersionView = z.infer<typeof manifestVersionView>;

export const createConnector = defineContract({
  service: 'connect-registry', name: 'createConnector', method: 'POST', path: '/v1/connectors', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    name: z.string().trim().min(1).max(200),
    provider: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    sourceRoute: z.enum(['ai', 'visual']),
  }),
  response: connectorView,
  status: 201,
  maxBodyBytes: 8_192,
});

export const listConnectors = defineContract({
  service: 'connect-registry', name: 'listConnectors', method: 'GET', path: '/v1/connectors', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
  response: z.object({ connectors: z.array(connectorView) }),
});

export const getConnector = defineContract({
  service: 'connect-registry', name: 'getConnector', method: 'GET', path: '/v1/connectors/:connectorId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectorId: z.uuid() }),
  response: connectorView,
});

export const createManifestVersion = defineContract({
  service: 'connect-registry', name: 'createManifestVersion', method: 'POST', path: '/v1/connectors/:connectorId/versions',
  callers: CALLERS, context: 'organisation', idempotency: 'keyed',
  params: z.strictObject({ connectorId: z.uuid() }),
  body: z.strictObject({
    /** The manifest. Validated by the schema, the protocol engine and the expression evaluator. */
    document: z.record(z.string(), z.json()),
    parentVersionId: z.uuid().optional(),
  }),
  response: manifestVersionView,
  status: 201,
  maxBodyBytes: 2 * 1024 * 1024,
});

export const listManifestVersions = defineContract({
  service: 'connect-registry', name: 'listManifestVersions', method: 'GET', path: '/v1/connectors/:connectorId/versions',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectorId: z.uuid() }),
  response: z.object({ versions: z.array(manifestVersionView) }),
});

export const getManifestVersion = defineContract({
  service: 'connect-registry', name: 'getManifestVersion', method: 'GET', path: '/v1/connectors/:connectorId/versions/:versionId',
  callers: [...CALLERS, 'canvas-layout', 'fde-orchestrator'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectorId: z.uuid(), versionId: z.uuid() }),
  response: manifestVersionView.extend({ document: z.record(z.string(), z.json()) }),
});

/**
 * A version's document, for the visual builder to open (spec 16.4: a half-built connector
 * stays a draft the visual builder can open; D262): only the organisation's own private
 * connectors. A certified connector's manifest stays with the services.
 */
export const getOwnManifestDocument = defineContract({
  service: 'connect-registry', name: 'getOwnManifestDocument', method: 'GET', path: '/v1/connectors/:connectorId/versions/:versionId/document',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectorId: z.uuid(), versionId: z.uuid() }),
  response: manifestVersionView.extend({ document: z.record(z.string(), z.json()) }),
});

/**
 * What a person fills in to connect with a connector version (spec 14.9; W7): the parameters it
 * declares and the auth fields its strategy takes, by name, kind and label, never a value; the
 * objects it reads, by name; and whether it runs through the Silo Agent, which then needs a pool.
 * The manifest itself (its endpoints, mappings and expressions) stays with the services.
 */
export const connectorSetupView = z.object({
  connectorId: z.uuid(),
  manifestId: z.uuid(),
  version: z.string(),
  protocol: z.string(),
  viaAgent: z.boolean(),
  params: z.array(z.object({ name: z.string(), label: z.string(), required: z.boolean(), pattern: z.string().nullable() })),
  auth: z.object({
    strategy: z.enum(AUTH_STRATEGIES),
    fields: z.array(z.object({ name: z.string(), kind: z.enum(['secret', 'public']), label: z.string(), role: z.string() })),
  }),
  objects: z.array(z.object({ name: z.string(), label: z.string().nullable() })),
});
export type ConnectorSetupView = z.infer<typeof connectorSetupView>;

export const getConnectorSetup = defineContract({
  service: 'connect-registry', name: 'getConnectorSetup', method: 'GET', path: '/v1/connectors/:connectorId/setup', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectorId: z.uuid() }),
  /** Default: the connector's current version. */
  query: z.strictObject({ manifestId: z.uuid().optional() }),
  response: connectorSetupView,
});
