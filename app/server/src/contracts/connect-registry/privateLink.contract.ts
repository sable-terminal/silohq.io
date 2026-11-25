// connect-registry: private links (decision 2026-11-09). An Enterprise organisation whose
// systems sit in its own cloud network can have that network linked to the cell's,
// VPC to VPC (VPC peering, or a Private Service Connect endpoint in the cell's network).
// Its connections then reach those systems from the cell, without the Silo Agent, and no
// other organisation's connections can: the egress lets a connection reach a private
// address only inside its own organisation's live links (infra/egress.infra.ts).
//
// The network link itself is infrastructure, set up by Silo; these records say which
// address ranges it carries. Silo staff add and remove them from the admin portal; the
// organisation's admins see them through the gateway.
//
// Rules: Enterprise plan only; a range is private (RFC 1918, shared address space, or IPv6
// unique local) and never overlaps the cell's own networks; two organisations' live links
// never overlap, so a private address belongs to one organisation at most.

import { z } from 'zod';
import { privateLinkSchema } from '../../schemas/connect/privateLink.schema.ts';
import { defineContract } from '../endpoint.contract.ts';

export const PRIVATE_LINK_KINDS = ['vpc_peering', 'private_service_connect'] as const;

export const privateLinkView = privateLinkSchema.pick({
  id: true, name: true, linkKind: true, network: true, status: true, createdAt: true, removedAt: true, version: true,
});
export type PrivateLinkView = z.infer<typeof privateLinkView>;

export const listPrivateLinks = defineContract({
  service: 'connect-registry', name: 'listPrivateLinks', method: 'GET', path: '/v1/private-links', callers: ['gateway', 'admin-portal'],
  context: 'organisation', idempotency: 'none',
  /** includeRemoved=true lists removed links too. */
  query: z.strictObject({ includeRemoved: z.enum(['true', 'false']).optional() }),
  response: z.object({ privateLinks: z.array(privateLinkView) }),
});

export const addPrivateLink = defineContract({
  service: 'connect-registry', name: 'addPrivateLink', method: 'POST', path: '/v1/private-links', callers: ['admin-portal'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    name: z.string().trim().min(1).max(100),
    linkKind: z.enum(PRIVATE_LINK_KINDS),
    /** CIDR notation, such as 10.20.0.0/16 or fd00:1234::/48. */
    network: z.string().trim().min(3).max(64),
    /** The member of staff, from their portal session. */
    operatorId: z.uuid(),
  }),
  response: privateLinkView,
  status: 201,
  maxBodyBytes: 2_048,
});

export const removePrivateLink = defineContract({
  service: 'connect-registry', name: 'removePrivateLink', method: 'POST', path: '/v1/private-links/:linkId/remove', callers: ['admin-portal'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ linkId: z.uuid() }),
  body: z.strictObject({ operatorId: z.uuid(), version: z.int().min(1) }),
  response: privateLinkView,
  maxBodyBytes: 1_024,
});
