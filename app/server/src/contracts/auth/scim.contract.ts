// SCIM 2.0 provisioning (RFC 7643, 7644; spec 55.5; design: iam.scim_tokens,
// iam.memberships.scim_external_id), for the gateway.
//
// The gateway serves /scim/v2 to the organisation's provisioning client and forwards each
// request whole: the bearer token, the method, the path under /scim/v2, the query and the
// body as text. auth checks the token (its organisation is the prefix, its hash under that
// organisation's row-level security), routes the request, validates the SCIM resource
// with Zod and answers in SCIM's own shape. The token is never logged.
//
// Tokens are issued and revoked by a super admin (org.sso.manage) through the API.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const SCIM_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const scimRequest = defineContract({
  service: 'auth', name: 'scimRequest', method: 'POST', path: '/v1/scim/requests', callers: ['gateway'],
  // A SCIM create may be retried by its client; a second create of the same userName or
  // externalId is refused as uniqueness, as RFC 7644 says.
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    token: z.string().min(1).max(200),
    method: z.enum(SCIM_METHODS),
    path: z.string().regex(/^\/[A-Za-z0-9/_.:-]{0,300}$/),
    query: z.string().max(4096),
    body: z.string().max(256 * 1024).optional(),
  }),
  response: z.object({
    status: z.number().int().min(200).max(599),
    body: z.string().max(4 * 1024 * 1024).optional(),
    /** A created resource's path under /scim/v2. */
    location: z.string().regex(/^\/[A-Za-z0-9/_-]{1,200}$/).optional(),
  }),
  maxBodyBytes: 300_000,
});

const mappingView = z.object({
  id: z.uuid(), groupId: z.uuid(), roleId: z.uuid(), scopeId: z.uuid().nullable(), createdBy: z.uuid(), createdAt: z.iso.datetime({ offset: true }),
});

/** org.sso.manage: the SCIM groups pushed, with their member counts and mappings (decision 2026-11-14). */
export const listScimGroups = defineContract({
  service: 'auth', name: 'listScimGroups', method: 'GET', path: '/v1/scim/groups', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    groups: z.array(z.object({
      id: z.uuid(), displayName: z.string(), externalId: z.string().nullable(), memberCount: z.number().int(), mappings: z.array(mappingView),
    })),
  }),
});

/**
 * org.sso.manage: maps a SCIM group to a role at a scope (null: organisation-wide), as a
 * role the admin could give there; its members are granted at once. Mapping what is
 * already mapped returns that mapping.
 */
export const createScimGroupMapping = defineContract({
  service: 'auth', name: 'createScimGroupMapping', method: 'POST', path: '/v1/scim/group-mappings', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ groupId: z.uuid(), roleId: z.uuid(), scopeId: z.uuid().nullable() }),
  response: z.object({ mapping: mappingView, granted: z.number().int(), refused: z.number().int() }),
  status: 201,
});

/** org.sso.manage: removes a mapping; what only it granted is revoked. */
export const removeScimGroupMapping = defineContract({
  service: 'auth', name: 'removeScimGroupMapping', method: 'DELETE', path: '/v1/scim/group-mappings/:mappingId', callers: ['gateway'],
  // Removing a removed mapping changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ mappingId: z.uuid() }),
  response: z.undefined(),
});

export const issueScimToken = defineContract({
  service: 'auth', name: 'issueScimToken', method: 'POST', path: '/v1/scim/tokens', callers: ['gateway'],
  // A new token each call, shown once.
  context: 'organisation', idempotency: 'none',
  response: z.object({ tokenId: z.uuid(), token: z.string(), createdAt: z.iso.datetime({ offset: true }) }),
  status: 201,
});

export const revokeScimToken = defineContract({
  service: 'auth', name: 'revokeScimToken', method: 'DELETE', path: '/v1/scim/tokens/:tokenId', callers: ['gateway'],
  // Revoking a revoked token changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ tokenId: z.uuid() }),
  response: z.undefined(),
});

export const listScimTokens = defineContract({
  service: 'auth', name: 'listScimTokens', method: 'GET', path: '/v1/scim/tokens', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    tokens: z.array(z.object({
      tokenId: z.uuid(), createdBy: z.uuid(), createdAt: z.iso.datetime({ offset: true }),
      lastUsedAt: z.iso.datetime({ offset: true }).nullable(), revokedAt: z.iso.datetime({ offset: true }).nullable(),
    })),
  }),
});
