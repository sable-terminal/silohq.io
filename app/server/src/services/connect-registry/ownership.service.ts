// A removed member's connections (spec 55.7): each goes to the nearest admin above its owning
// scope, else a super admin, recorded as connection_ownership_transferred. One with no one to
// take it stays where it is and is counted. Grants, credentials and status are untouched: the
// new owner reaches the connection as owners do.

import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { connectionRepo } from '../../repos/connect/index.repo.ts';
import { roleAssignmentRepo } from '../../repos/iam/index.repo.ts';
import { recordConnectEvent } from './connectEvents.service.ts';

export async function transferOwnedConnections(deps: { databases: Databases; logger: Logger }, ctx: { request: { organisationId?: string | undefined }; correlationId: string },
  membershipId: string): Promise<{ transferred: { connectionId: string; toMembershipId: string }[]; kept: number }> {
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), { organisationId }, async (db) => {
    const transferred: { connectionId: string; toMembershipId: string }[] = [];
    let kept = 0;
    for (const connection of await connectionRepo.ownedBy(db, membershipId)) {
      const to = await roleAssignmentRepo.nearestAdminOf(db, connection.owningScopeId, membershipId) ?? await roleAssignmentRepo.aSuperAdmin(db, membershipId);
      if (to === undefined) {
        kept += 1;
        deps.logger.warn('a removed member\'s connection has no admin to take it', { event: 'connect.ownership_kept', organisationId, resourceId: connection.id });
        continue;
      }
      await connectionRepo.update(db, connection.id, { owningMembershipId: to });
      await recordConnectEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'connection_ownership_transferred', resourceType: 'connection', resourceId: connection.id,
        detail: { from_membership_id: membershipId, to_membership_id: to, reason: 'member_removed' },
      });
      transferred.push({ connectionId: connection.id, toMembershipId: to });
    }
    return { transferred, kept };
  });
}
