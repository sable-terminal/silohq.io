// connect-registry: connections (spec 14.7, 14.8). A configured instance of a connector for
// one organisation, owned by a scope and a membership, default deny until granted.
//
// Status moves (spec 14.7): draft -> probing -> verified -> active -> halted -> active, and
// any -> revoked. Probing needs every required parameter; confirming (probing to verified)
// needs a conformance run on the connection's version that passed the read, pagination and
// error classes (spec 17.1, 17.2), and the authorising connector.verify.
//
// Parameters (a tenant subdomain, a region) are public and live on the connection; secrets
// are sealed by the credential service through setConnectionSecrets.

import { z } from 'zod';
import { connectionSchema } from '../../schemas/connect/connection.schema.ts';
import { connectionParameters } from '../connect/parameters.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

// discovery: an approved finding promoted to a private connector and a draft connection (spec 19.4).
const CALLERS = ['gateway', 'connector-builder', 'visual-builder', 'conformance', 'connector-maintenance', 'discovery'] as const;

export const connectionView = connectionSchema.pick({
  id: true, connectorId: true, manifestId: true, name: true, provider: true, trustTier: true, owningScopeId: true,
  owningMembershipId: true, policyAuthority: true, status: true, writesEnabled: true, agentPoolId: true, credentialCustody: true, createdAt: true,
  lastHealthyAt: true, haltedReason: true, haltedAt: true, revokedAt: true, version: true,
}).extend({ parameters: connectionParameters });
export type ConnectionView = z.infer<typeof connectionView>;

const connectionId = z.strictObject({ connectionId: z.uuid() });

export const createConnection = defineContract({
  service: 'connect-registry', name: 'createConnection', method: 'POST', path: '/v1/connections', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    connectorId: z.uuid(),
    /** Default: the connector's current version. */
    manifestId: z.uuid().optional(),
    name: z.string().trim().min(1).max(200),
    owningScopeId: z.uuid(),
    /** Required when the manifest runs through the Silo Agent. */
    agentPoolId: z.uuid().optional(),
    /**
     * Through the Silo Agent (spec 10.7): cell (the default) keeps the login sealed in the cell,
     * passed to the agent for one call at a time; agent keeps it on the agent's host, and the
     * cell holds none. Fixed for the connection's life.
     */
    credentialCustody: z.enum(['cell', 'agent']).default('cell'),
    /** Declared parameters, by name. Required ones may follow before probing. */
    parameters: connectionParameters.optional(),
  }),
  response: connectionView,
  status: 201,
  maxBodyBytes: 8_192,
});

export const listConnections = defineContract({
  service: 'connect-registry', name: 'listConnections', method: 'GET', path: '/v1/connections', callers: [...CALLERS, 'canvas-layout', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
  response: z.object({ connections: z.array(connectionView) }),
});

export const getConnection = defineContract({
  service: 'connect-registry', name: 'getConnection', method: 'GET', path: '/v1/connections/:connectionId', callers: [...CALLERS, 'canvas-layout', 'fde-orchestrator'],
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  response: connectionView,
});

export const renameConnection = defineContract({
  service: 'connect-registry', name: 'renameConnection', method: 'PATCH', path: '/v1/connections/:connectionId', callers: CALLERS,
  // Setting a name to the value it already has changes nothing.
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({ name: z.string().trim().min(1).max(200), version: z.int().min(1) }),
  response: connectionView,
  maxBodyBytes: 4_096,
});

export const setConnectionParameters = defineContract({
  service: 'connect-registry', name: 'setConnectionParameters', method: 'PUT', path: '/v1/connections/:connectionId/parameters',
  callers: CALLERS,
  // The whole set replaces the last, at the version read; the same set again changes nothing.
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({ parameters: connectionParameters, version: z.int().min(1) }),
  response: connectionView,
  maxBodyBytes: 16_384,
});

export const CONNECTION_MOVES = ['probe', 'confirm', 'activate', 'halt', 'resume', 'revoke'] as const;

/**
 * The connection's policy authority (spec 14.7, 44.4), set by a super admin
 * (connection.policy_authority): owner_set (the owner sets approval policy), delegated (one
 * named admin does), or locked (only a super admin). The database already holds approval
 * policies to it. Revoking a delegation does not revert policies already written.
 */
export const setConnectionPolicyAuthority = defineContract({
  service: 'connect-registry', name: 'setConnectionPolicyAuthority', method: 'PUT', path: '/v1/connections/:connectionId/policy-authority',
  callers: CALLERS, context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({
    mode: z.enum(['owner_set', 'delegated', 'locked']),
    /** delegated only: the admin who holds the connection's policy authority. */
    delegateMembershipId: z.uuid().optional(),
    version: z.int().min(1),
  }),
  response: connectionView,
});

export const changeConnectionStatus = defineContract({
  service: 'connect-registry', name: 'changeConnectionStatus', method: 'POST', path: '/v1/connections/:connectionId/status',
  callers: CALLERS,
  // A move names the status it starts from (by version), so a repeat is refused, not reapplied.
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({
    move: z.enum(CONNECTION_MOVES),
    version: z.int().min(1),
    /** halt only: why, in words a reviewer reads. No record values. */
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  response: connectionView,
  maxBodyBytes: 4_096,
});

export const setConnectionSecrets = defineContract({
  service: 'connect-registry', name: 'setConnectionSecrets', method: 'POST', path: '/v1/connections/:connectionId/secrets',
  callers: CALLERS,
  // Replacing a value with itself leaves the connection as it was.
  context: 'organisation', idempotency: 'none',
  params: connectionId,
  body: z.strictObject({
    /** Auth fields the manifest declares, by name. Parameters are set on the connection. */
    values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.string().min(1).max(16_384)),
  }),
  response: z.object({
    fields: z.array(z.object({ name: z.string(), kind: z.enum(['secret', 'public']), lastFour: z.string().nullable() })),
  }),
  maxBodyBytes: 128 * 1024,
});

/** The cell's live connections, for its Fleet agent to report to the directory (spec 6.3; D203). A count only. */
export const cellConnectionCount = defineContract({
  service: 'connect-registry', name: 'cellConnectionCount', method: 'GET', path: '/v1/cell/connection-count', callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  response: z.object({ connections: z.int().min(0) }),
});
