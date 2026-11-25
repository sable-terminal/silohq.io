// Private links (contracts/connect-registry/privateLink.contract.ts): the private address
// ranges an Enterprise organisation's VPC-to-VPC link carries into the cell.
//
// Adding one is refused unless: the organisation is on the Enterprise plan; the range is
// a network in CIDR notation inside private space (RFC 1918, shared address space, IPv6
// unique local) and no wider than a /8 (IPv4) or /16 (IPv6); it shares no address with the
// cell's own networks (CONNECT_CELL_NETWORKS); and it overlaps no other live link, the
// organisation's or anyone's (the database's exclusion constraint, so two staff adding at
// once cannot both win). Removing one takes effect on the next request: the credential
// service reads the live links on every request it places.
//
// Staff act from the admin portal, which names them; the audit event's actor is this
// service, with the member of staff in its detail, as for every staff operation outside
// a break-glass session.

import type { addPrivateLink, PrivateLinkView } from '../../contracts/connect-registry/privateLink.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { PrivateLink } from '../../models/connect/privateLink.model.ts';
import { privateLinkRepo } from '../../repos/connect/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { cidrsOverlap, isPrivateLinkRange, parseCidr, type Cidr } from '../../utils/network.util.ts';
import { recordConnectEvent } from './connectEvents.service.ts';

export interface PrivateLinkDeps {
  databases: Databases;
  /** The cell's own networks, which no link may overlap. */
  cellNetworks: readonly Cidr[];
}

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;
type AddInput = (typeof addPrivateLink)['body']['_output'];

const MIN_PREFIX = { 4: 8, 6: 16 } as const;

export const viewOfLink = (link: PrivateLink): PrivateLinkView => ({
  id: link.id, name: link.name, linkKind: link.linkKind, network: link.network, status: link.status, createdAt: link.createdAt,
  removedAt: link.removedAt, version: link.version,
});

/** The range as a network the cell may link to, or a refusal saying why not. */
export function checkLinkRange(text: string, cellNetworks: readonly Cidr[]): Cidr {
  const network = parseCidr(text);
  if (network === undefined) {
    throw new AppError('validation', 'give the range in CIDR notation, with the host bits zero (10.20.0.0/16)', { code: 'private_link.network_invalid' });
  }
  if (!isPrivateLinkRange(network)) {
    throw new AppError('validation', 'a private link carries private addresses only: 10/8, 172.16/12, 192.168/16, 100.64/10 or fc00::/7', {
      code: 'private_link.not_private',
    });
  }
  if (network.prefix < MIN_PREFIX[network.family]) {
    throw new AppError('validation', `a private link is at most a /${MIN_PREFIX[network.family]}`, { code: 'private_link.too_wide' });
  }
  if (cellNetworks.some((cell) => cidrsOverlap(cell, network))) {
    throw new AppError('conflict', 'the range overlaps the cell\'s own networks', { code: 'private_link.overlaps_cell' });
  }
  return network;
}

export function createPrivateLinks(deps: PrivateLinkDeps) {
  const control = deps.databases.pool('control');
  const organisationOf = (ctx: Context): string => ctx.request.organisationId!;

  return {
    async list(ctx: Context, includeRemoved: boolean): Promise<{ privateLinks: PrivateLinkView[] }> {
      const links = await inTransaction(control, ctx.request, (db) => privateLinkRepo.list(db, { includeRemoved }), { readOnly: true });
      return { privateLinks: links.map(viewOfLink) };
    },

    async add(ctx: Context, input: AddInput): Promise<PrivateLinkView> {
      const network = checkLinkRange(input.network, deps.cellNetworks);
      const organisationId = organisationOf(ctx);
      try {
        return await inTransaction(control, ctx.request, async (db) => {
          const organisation = await organisationRepo.findById(db, organisationId);
          if (organisation === undefined) throw new AppError('not_found', 'no such organisation', { code: 'organisation.not_found' });
          if (organisation.plan !== 'enterprise') {
            throw new AppError('forbidden', 'private links are part of the Enterprise plan', { code: 'private_link.enterprise_only' });
          }
          const link = await privateLinkRepo.insert(db, {
            id: uuidv7(), organisationId, name: input.name, linkKind: input.linkKind, network: network.text, addedByOperatorId: input.operatorId,
          });
          await recordConnectEvent(db, {
            service: 'connect-registry', organisationId, correlationId: ctx.correlationId, event: 'private_link_added',
            resourceType: 'private_link', resourceId: link.id,
            detail: { operator_id: input.operatorId, link_kind: input.linkKind, family: network.family, prefix_length: network.prefix },
          });
          return viewOfLink(link);
        });
      } catch (error) {
        // 23P01: the exclusion constraint private_links_no_overlap.
        if (fromDatabaseError(error).code === 'db.23P01') {
          throw new AppError('conflict', 'the range overlaps a live private link', { code: 'private_link.overlaps' });
        }
        throw error;
      }
    },

    async remove(ctx: Context, linkId: string, input: { operatorId: string; version: number }): Promise<PrivateLinkView> {
      const organisationId = organisationOf(ctx);
      return inTransaction(control, ctx.request, async (db) => {
        const link = await privateLinkRepo.findById(db, linkId);
        if (link === undefined) throw new AppError('not_found', 'no such private link', { code: 'private_link.not_found' });
        if (link.status === 'removed') throw new AppError('conflict', 'the private link is already removed', { code: 'private_link.removed' });
        const removed = await privateLinkRepo.remove(db, linkId, input.version, input.operatorId);
        if (removed === undefined) throw new AppError('conflict', 'the private link changed; reload it', { code: 'private_link.version' });
        await recordConnectEvent(db, {
          service: 'connect-registry', organisationId, correlationId: ctx.correlationId, event: 'private_link_removed',
          resourceType: 'private_link', resourceId: linkId, detail: { operator_id: input.operatorId },
        });
        return viewOfLink(removed);
      });
    },
  };
}

export type PrivateLinks = ReturnType<typeof createPrivateLinks>;
