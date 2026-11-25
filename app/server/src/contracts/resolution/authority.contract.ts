// Field authorities (spec 23.4): a person's statement of which system wins for a property
// of a resolvable type, for the whole type or where a CEL condition holds (over the winning
// system's row, as `object`, keyed by property api name). A declaration needs
// authority.declare and read access to every connection that maps the property, and a
// reason. Revoking is a status change, never a delete. A declaration is a statement with a
// person's name on it: every merge it decides names it.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const CALLERS = ['gateway', 'fde-orchestrator', 'admin-portal'] as const;

export const fieldAuthorityView = z.object({
  id: z.uuid(),
  objectTypeId: z.uuid(),
  propertyIdentityId: z.uuid(),
  winningConnectionId: z.uuid(),
  condition: z.string().nullable(),
  reason: z.string(),
  declaredBy: z.uuid(),
  declaredAt: z.string(),
  revokedBy: z.uuid().nullable(),
  revokedAt: z.string().nullable(),
  ontologyVersionId: z.uuid(),
});
export type FieldAuthorityView = z.infer<typeof fieldAuthorityView>;

export const declareFieldAuthority = defineContract({
  service: 'resolution', name: 'declareFieldAuthority', method: 'POST', path: '/v1/resolution/authorities', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    propertyIdentityId: z.uuid(),
    winningConnectionId: z.uuid(),
    condition: z.string().min(1).max(2000).optional(),
    reason: z.string().trim().min(1).max(2000),
  }),
  response: fieldAuthorityView,
  status: 201,
});

export const revokeFieldAuthority = defineContract({
  service: 'resolution', name: 'revokeFieldAuthority', method: 'POST', path: '/v1/resolution/authorities/:authorityId/revoke',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ authorityId: z.uuid() }),
  response: fieldAuthorityView,
});

export const listFieldAuthorities = defineContract({
  service: 'resolution', name: 'listFieldAuthorities', method: 'GET', path: '/v1/resolution/authorities',
  // The executor: the object view names the authority deciding a declared value (34.3).
  callers: [...CALLERS, 'executor'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ objectTypeId: z.uuid(), includeRevoked: z.enum(['true', 'false']).default('false') }),
  response: z.object({ authorities: z.array(fieldAuthorityView) }),
});
