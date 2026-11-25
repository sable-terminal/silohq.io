// Connection grants (spec 57.3, 56.7 rule 6, 56.8): default deny, so a connection is
// unreachable until granted. Who may grant, to whom and from where is the database's rule
// (iam.check_connection_grant, applied by the delegation trigger on every insert):
// - a super admin, from anywhere;
// - otherwise from a scope the granter acts under (granted_at_scope_id), where they hold
//   connection.grant or which lies within the connection's owning scope they own, to a
//   grantee within that subtree, and only for a connection they themselves hold there
//   with at least that access;
// - a role spans the organisation, so only a super admin grants a connection to one.
// Revocation is by the issuer, an admin over the scope it was issued under, or a super
// admin, never merely an admin above the grantee.

import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { connectionGrantRepo, roleAssignmentRepo, scopeMembershipRepo, servicePrincipalRepo } from '../../repos/iam/index.repo.ts';
import type { ConnectionGrant } from '../../models/iam/connectionGrant.model.ts';
import type { Grantee } from '../../contracts/policy/governance.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  auditActorOf, contextOf, demand, isInsufficientPrivilege, isUniqueViolation, may, membershipOf, recordPolicyEvent, requireActor,
  type AdminDeps,
} from './deps.service.ts';
import type { Subject } from './policy.service.ts';

const tx = <T>(deps: AdminDeps, subject: Subject, work: (db: Queryable) => Promise<T>): Promise<T> =>
  inTransaction(deps.databases.pool('control'), contextOf(subject.actor), work);

const granteeColumns = (grantee: Grantee) => ({
  granteeMembershipId: grantee.kind === 'membership' ? grantee.id : null,
  granteeScopeId: grantee.kind === 'scope' ? grantee.id : null,
  granteeRoleId: grantee.kind === 'role' ? grantee.id : null,
  granteeServicePrincipalId: grantee.kind === 'service_principal' ? grantee.id : null,
});

/** The scope a grant is issued from: null for a super admin; else the nearest place the granter grants from that covers the grantee. */
async function grantedFrom(db: Queryable, organisationId: string, granter: string, connectionId: string, grantee: Grantee)
  : Promise<string | null> {
  if (await roleAssignmentRepo.isSuperAdmin(db, organisationId, granter)) return null;
  const targets: string[] = [];
  if (grantee.kind === 'scope') targets.push(grantee.id);
  if (grantee.kind === 'membership') targets.push(...(await scopeMembershipRepo.activeScopes(db, grantee.id)).map((s) => s.scopeId));
  if (grantee.kind === 'service_principal') {
    const principal = await servicePrincipalRepo.findById(db, grantee.id);
    if (principal?.scopeId) targets.push(principal.scopeId);
  }
  for (const target of targets) {
    const scope = await connectionGrantRepo.actingScope(db, granter, connectionId, target);
    if (scope !== null) return scope;
  }
  return null;
}

export async function grantConnection(deps: AdminDeps, ctx: HandlerContext, input: { connectionId: string; grantee: Grantee;
  access: 'read' | 'write'; includeDescendants: boolean; expiresAt?: string | undefined }): Promise<ConnectionGrant> {
  const subject = await requireActor(deps, ctx);
  const granter = membershipOf(subject);
  const organisationId = subject.actor.organisationId;
  const columns = granteeColumns(input.grantee);
  try {
    return await tx(deps, subject, async (db) => {
      const facts = await connectionGrantRepo.connectionFacts(db, input.connectionId);
      if (!facts || facts.status === 'revoked') throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
      // One live grant per grantee and connection: the same grant again changes nothing.
      const live = (await connectionGrantRepo.listForConnection(db, input.connectionId, false)).find((g) =>
        g.granteeMembershipId === columns.granteeMembershipId && g.granteeScopeId === columns.granteeScopeId
        && g.granteeRoleId === columns.granteeRoleId && g.granteeServicePrincipalId === columns.granteeServicePrincipalId);
      if (live) {
        if (live.access === input.access && live.includeDescendants === input.includeDescendants) return live;
        throw new AppError('conflict', 'that grantee already holds a grant on this connection; revoke it first', { code: 'connection_grant.exists' });
      }
      const grantedAtScopeId = await grantedFrom(db, organisationId, granter, input.connectionId, input.grantee);
      const grant = { organisationId, grantedBy: granter, connectionId: input.connectionId, access: input.access, ...columns, grantedAtScopeId };
      const refusal = await connectionGrantRepo.refusal(db, grant);
      if (refusal !== null) throw new AppError('forbidden', `that connection cannot be granted there: ${refusal}`, { code: 'connection_grant.refused' });
      const row = await connectionGrantRepo.insert(db, {
        id: uuidv7(), ...grant, includeDescendants: input.includeDescendants, expiresAt: input.expiresAt ?? null,
      });
      // Who opened which system to whom, at which scope, with which access (spec 14.10).
      await recordPolicyEvent(db, {
        organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor), event: 'connection_granted',
        subjectMembershipId: columns.granteeMembershipId, scopeId: grantedAtScopeId, resource: { type: 'connection', id: input.connectionId },
        detail: { grant_id: row.id, grantee_kind: input.grantee.kind, grantee_id: input.grantee.id, access: input.access,
          include_descendants: input.includeDescendants },
      });
      return row;
    });
  } catch (error) {
    if (isInsufficientPrivilege(error)) throw new AppError('forbidden', 'the delegation rules refuse that grant (spec 56.7)', { code: 'connection_grant.refused' });
    if (isUniqueViolation(error)) throw new AppError('conflict', 'that grantee already holds a grant on this connection', { code: 'connection_grant.exists' });
    throw error;
  }
}

export async function revokeConnectionGrant(deps: AdminDeps, ctx: HandlerContext, grantId: string): Promise<ConnectionGrant> {
  const subject = await requireActor(deps, ctx);
  const revoker = membershipOf(subject);
  try {
    return await tx(deps, subject, async (db) => {
      const before = await connectionGrantRepo.findById(db, grantId);
      if (!before) throw new AppError('not_found', 'no such connection grant', { code: 'connection_grant.not_found' });
      if (before.revokedAt !== null) return before;
      const row = (await connectionGrantRepo.update(db, grantId, { revokedAt: new Date().toISOString(), revokedBy: revoker }))!;
      await recordPolicyEvent(db, {
        organisationId: subject.actor.organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor),
        event: 'connection_grant_revoked', subjectMembershipId: before.granteeMembershipId, scopeId: before.grantedAtScopeId,
        resource: { type: 'connection', id: before.connectionId }, detail: { grant_id: grantId, granted_by: before.grantedBy },
      });
      return row;
    });
  } catch (error) {
    if (isInsufficientPrivilege(error)) {
      throw new AppError('forbidden', 'only the issuer, an admin over the scope it was issued under, or a super admin may revoke this',
        { code: 'connection_grant.revoke_refused' });
    }
    throw error;
  }
}

/** The grants on a connection: for its owner, an admin of its owning scope, or a super admin. */
export async function listConnectionGrants(deps: AdminDeps, ctx: HandlerContext, connectionId: string, includeEnded: boolean)
  : Promise<ConnectionGrant[]> {
  const subject = await requireActor(deps, ctx);
  const facts = await tx(deps, subject, (db) => connectionGrantRepo.connectionFacts(db, connectionId));
  if (!facts) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
  if (facts.owningMembershipId !== subject.actor.membershipId && !await may(deps, subject, 'connection.grant', { scopeId: facts.owningScopeId })) {
    await demand(deps, ctx, subject, 'connection.grant', { organisationWide: true });
  }
  return tx(deps, subject, (db) => connectionGrantRepo.listForConnection(db, connectionId, includeEnded));
}
