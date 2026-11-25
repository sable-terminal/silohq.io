// Service principals (spec 60.4 to 60.7): created, given roles and revoked by a holder of
// service_principal.manage at the principal's bounding scope (organisation-wide for an
// unbounded one). A principal executes but never authorises: a role holding an
// authorising permission is refused here and by the database's deferred check, and the
// attempt is audited (principal_authorising_permission_refused). Giving a role also obeys
// the delegation rules: no one gives a principal what they could not give a person there.
// Only automations and API clients are created here: agents enrol through connect, fde
// principals come from fde-orchestrator. An API client's secret is shown once and stored as
// its hash.

import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import {
  membershipRepo, roleAssignmentRepo, roleRepo, servicePrincipalRepo, servicePrincipalRoleRepo,
} from '../../repos/iam/index.repo.ts';
import type { ServicePrincipal } from '../../models/iam/servicePrincipal.model.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { issueToken } from '../../utils/token.util.ts';
import {
  auditActorOf, contextOf, demand, isInsufficientPrivilege, membershipOf, recordPolicyEvent, requireActor, type AdminDeps,
} from './deps.service.ts';
import type { Subject } from './policy.service.ts';

export type PrincipalView = ServicePrincipal & { roleIds: string[] };

const tx = <T>(deps: AdminDeps, subject: Subject, work: (db: Queryable) => Promise<T>): Promise<T> =>
  inTransaction(deps.databases.pool('control'), contextOf(subject.actor), work);

const where = (principal: { scopeId: string | null }) => (principal.scopeId === null ? { organisationWide: true } : { scopeId: principal.scopeId });

async function view(db: Queryable, principal: ServicePrincipal): Promise<PrincipalView> {
  return { ...principal, roleIds: (await servicePrincipalRoleRepo.grantsFor(db, principal.id)).map((r) => r.roleId) };
}

async function load(deps: AdminDeps, subject: Subject, id: string): Promise<ServicePrincipal> {
  const principal = await tx(deps, subject, (db) => servicePrincipalRepo.findById(db, id));
  if (!principal) throw new AppError('not_found', 'no such service principal', { code: 'service_principal.not_found' });
  return principal;
}

export async function createServicePrincipal(deps: AdminDeps, ctx: HandlerContext, input: { kind: 'automation' | 'api_client'; name: string;
  scopeId?: string | undefined; ownerMembershipId?: string | undefined; expiresAt?: string | undefined }): Promise<PrincipalView & { secret?: string }> {
  const subject = await requireActor(deps, ctx);
  const creator = membershipOf(subject);
  await demand(deps, ctx, subject, 'service_principal.manage', where({ scopeId: input.scopeId ?? null }));
  const secret = input.kind === 'api_client' ? issueToken('api_client_secret') : undefined;
  const created = await tx(deps, subject, async (db) => {
    const owner = input.ownerMembershipId ?? creator;
    if ((await membershipRepo.findById(db, owner))?.status !== 'active') {
      throw new AppError('not_found', 'the accountable owner is not an active member', { code: 'service_principal.owner_invalid' });
    }
    const row = await servicePrincipalRepo.insert(db, {
      id: uuidv7(), organisationId: subject.actor.organisationId, kind: input.kind, name: input.name, scopeId: input.scopeId ?? null,
      ownerMembershipId: owner, secretHash: secret?.hash ?? null, expiresAt: input.expiresAt ?? null, createdBy: creator,
    });
    await recordPolicyEvent(db, {
      organisationId: subject.actor.organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor),
      event: 'service_principal_created', subjectMembershipId: owner, scopeId: row.scopeId, resource: { type: 'service_principal', id: row.id },
      detail: { kind: row.kind },
    });
    return view(db, row);
  });
  return secret === undefined ? created : { ...created, secret: secret.token };
}

export async function grantPrincipalRole(deps: AdminDeps, ctx: HandlerContext, servicePrincipalId: string, roleId: string): Promise<PrincipalView> {
  const subject = await requireActor(deps, ctx);
  const granter = membershipOf(subject);
  const principal = await load(deps, subject, servicePrincipalId);
  if (principal.revokedAt !== null) throw new AppError('conflict', 'a revoked principal takes no roles', { code: 'service_principal.revoked' });
  await demand(deps, ctx, subject, 'service_principal.manage', where(principal));
  const base = {
    organisationId: subject.actor.organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor),
    subjectMembershipId: principal.ownerMembershipId, resource: { type: 'service_principal', id: servicePrincipalId },
  };
  const refuse = async (): Promise<never> => {
    // The evidence a reviewer asks for that invariant 9 holds (spec 60.8), in its own transaction.
    await tx(deps, subject, (db) => recordPolicyEvent(db, { ...base, event: 'principal_authorising_permission_refused', detail: { role_id: roleId } }))
      .catch(() => undefined);
    throw new AppError('forbidden', 'a service principal executes but never authorises (spec 60.6)', { code: 'service_principal.authorising_refused' });
  };
  const role = (await tx(deps, subject, (db) => roleRepo.listWithPermissions(db))).find((r) => r.id === roleId);
  if (!role || role.retiredAt !== null) throw new AppError('not_found', 'no such role', { code: 'role.not_found' });
  if (role.permissions.some((p) => deps.catalogue.get(p) === 'authorising')) return refuse();
  try {
    return await tx(deps, subject, async (db) => {
      const refusal = await roleAssignmentRepo.grantRefusal(db, subject.actor.organisationId, granter, roleId, principal.scopeId);
      if (refusal !== null) throw new AppError('forbidden', `that role cannot be given there: ${refusal}`, { code: 'role.grant_refused' });
      if (!await servicePrincipalRoleRepo.findByKey(db, { organisationId: subject.actor.organisationId, servicePrincipalId, roleId })) {
        await servicePrincipalRoleRepo.insert(db, { organisationId: subject.actor.organisationId, servicePrincipalId, roleId, grantedBy: granter });
        await recordPolicyEvent(db, { ...base, event: 'service_principal_role_granted', detail: { role_id: roleId } });
      }
      return view(db, principal);
    });
  } catch (error) {
    // The database's deferred check, at commit: a role that gained an authorising permission meanwhile.
    if (isInsufficientPrivilege(error)) return refuse();
    throw error;
  }
}

export async function removePrincipalRole(deps: AdminDeps, ctx: HandlerContext, servicePrincipalId: string, roleId: string): Promise<PrincipalView> {
  const subject = await requireActor(deps, ctx);
  const principal = await load(deps, subject, servicePrincipalId);
  await demand(deps, ctx, subject, 'service_principal.manage', where(principal));
  return tx(deps, subject, async (db) => {
    if (await servicePrincipalRoleRepo.remove(db, { organisationId: subject.actor.organisationId, servicePrincipalId, roleId })) {
      await recordPolicyEvent(db, {
        organisationId: subject.actor.organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor),
        event: 'service_principal_role_removed', resource: { type: 'service_principal', id: servicePrincipalId }, detail: { role_id: roleId },
      });
    }
    return view(db, principal);
  });
}

export async function revokeServicePrincipal(deps: AdminDeps, ctx: HandlerContext, servicePrincipalId: string): Promise<PrincipalView> {
  const subject = await requireActor(deps, ctx);
  const principal = await load(deps, subject, servicePrincipalId);
  await demand(deps, ctx, subject, 'service_principal.manage', where(principal));
  if (principal.revokedAt !== null) return tx(deps, subject, (db) => view(db, principal));
  return tx(deps, subject, async (db) => {
    const row = (await servicePrincipalRepo.update(db, servicePrincipalId, { revokedAt: new Date().toISOString() }))!;
    await recordPolicyEvent(db, {
      organisationId: subject.actor.organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor),
      event: 'service_principal_revoked', subjectMembershipId: principal.ownerMembershipId, resource: { type: 'service_principal', id: servicePrincipalId },
    });
    return view(db, row);
  });
}

export async function listServicePrincipals(deps: AdminDeps, ctx: HandlerContext): Promise<PrincipalView[]> {
  const subject = await requireActor(deps, ctx);
  await demand(deps, ctx, subject, 'service_principal.manage');
  return tx(deps, subject, async (db) => Promise.all((await servicePrincipalRepo.list(db, false)).map((p) => view(db, p))));
}
