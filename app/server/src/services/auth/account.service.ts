// A person's own sessions and factors (spec 55.4, 60.2).
//
// - Memberships: the organisations the person belongs to in this cell (an invitation not
//   yet accepted included), through iam.list_user_memberships, since RLS shows one
//   organisation at a time.
// - Switching the active membership issues a new session for the other organisation and
//   revokes the one it replaces; nothing is mutated in place (60.2). The other
//   organisation's rules apply from the first request: one that requires SSO is reached
//   through its own identity provider, never by switching; its MFA requirement applies,
//   and a second factor already verified in this session carries over (the same person,
//   the same sign-in). Both organisations record the switch.
// - Factors: listed without their secrets; removing a confirmed one needs a session that
//   verified a second factor, and the last confirmed factor of a person whose organisation
//   requires MFA cannot be removed. An unconfirmed (abandoned) enrolment can be removed by
//   any session that may enrol.

import type { SessionView } from '../../contracts/auth/session.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { MfaFactor } from '../../models/iam/mfaFactor.model.ts';
import { membershipRepo, mfaFactorRepo, organisationRepo, userIdentityRepo, userRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';
import { mfaStateOf } from './sessions.service.ts';

const pending = (view: SessionView): boolean => view.mfa === 'required' || view.mfa === 'enrolment_required';

/** The person's own name and email: a session whose second factor is still pending may read them too. */
export async function readOwnProfile(deps: AuthDeps, sessionToken: string) {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  const user = await inTransaction(deps.databases.pool('control'), { userId: view.userId }, (db) => userRepo.findById(db, view.userId), { readOnly: true });
  if (!user) throw new AppError('unauthenticated', 'the session names no person', { code: 'auth.session_invalid' });
  return { userId: user.id, firstName: user.firstName, lastName: user.lastName, email: String(user.email) };
}

export async function listMyMemberships(deps: AuthDeps, sessionToken: string) {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  const rows = await inTransaction(deps.databases.pool('control'), { userId: view.userId }, (db) => membershipRepo.listForUser(db, view.userId),
    { readOnly: true });
  return { memberships: rows.map((r) => ({ ...r, current: r.membershipId === view.membershipId })) };
}

export async function switchMembership(deps: AuthDeps, input: {
  sessionToken: string; organisationId: string; client?: { address?: string | undefined; userAgent?: string | undefined } | undefined;
}, correlationId: string): Promise<SessionView & { sessionToken: string }> {
  const view = await deps.sessions.resolve(input.sessionToken, 'http_request');
  if (pending(view)) throw new AppError('forbidden', 'verify your second factor first', { code: 'auth.mfa_required' });
  if (input.organisationId === view.organisationId) {
    throw new AppError('validation', 'that organisation is already the active one', { code: 'auth.switch_same' });
  }
  const control = deps.databases.pool('control');
  const notMember = () => new AppError('not_found', 'you have no active membership in that organisation', { code: 'auth.membership_not_found' });
  const listed = await inTransaction(control, { userId: view.userId }, (db) => membershipRepo.listForUser(db, view.userId), { readOnly: true });
  if (!listed.some((m) => m.organisationId === input.organisationId && m.status === 'active')) throw notMember();
  const organisation = await inTransaction(control, { organisationId: input.organisationId }, (db) => organisationRepo.findById(db, input.organisationId),
    { readOnly: true });
  if (!organisation || organisation.status !== 'active') throw notMember();
  if (organisation.ssoRequired) {
    throw new AppError('forbidden', 'that organisation signs in through its identity provider', { code: 'auth.sso_required' });
  }
  const ipHash = deps.guard.addressHash(input.client?.address);
  const userAgentHash = deps.guard.userAgentHash(input.client?.userAgent);
  const issued = await inTransaction(control, { organisationId: organisation.id, userId: view.userId }, async (db) => {
    const membership = await membershipRepo.findByUserId(db, { userId: view.userId, organisationId: organisation.id });
    if (!membership || membership.status !== 'active') return undefined;
    const mfa = view.mfa === 'satisfied' ? 'satisfied' as const
      : mfaStateOf(null, await mfaFactorRepo.countConfirmed(db, view.userId), organisation.mfaRequired);
    const session = await deps.sessions.issue(db, {
      organisation, userId: view.userId, membershipId: membership.id, mfa, authMethod: view.authMethod, ipHash, userAgentHash,
    });
    await recordAuthEvent(db, {
      organisationId: organisation.id, correlationId, event: 'membership_switched', userId: view.userId, membershipId: membership.id, ipHash,
      detail: { direction: 'in', mfa },
    });
    return session;
  });
  if (!issued) throw notMember();
  await issued.cache();
  // The session it replaces ends: switching never mutates a session (60.2).
  await deps.sessions.revoke(input.sessionToken);
  await inTransaction(control, { organisationId: view.organisationId }, (db) => recordAuthEvent(db, {
    organisationId: view.organisationId, correlationId, event: 'membership_switched', userId: view.userId, membershipId: view.membershipId, ipHash,
    detail: { direction: 'out' },
  }));
  return { ...issued.view, sessionToken: issued.token };
}

/** The person's identities in the session's organisation, and what else signs them in. */
export async function listIdentities(deps: AuthDeps, sessionToken: string) {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  return inTransaction(deps.databases.pool('control'), { organisationId: view.organisationId, userId: view.userId }, async (db) => {
    const [identities, user, organisation] = await Promise.all([
      userIdentityRepo.listLiveForUser(db, view.userId), userRepo.findById(db, view.userId), organisationRepo.findById(db, view.organisationId),
    ]);
    return {
      identities: identities.map((i) => ({
        id: i.id, identityProviderId: i.identityProviderId, providerKind: i.providerKind, issuer: i.issuer, linkedVia: i.linkedVia,
        linkedAt: i.linkedAt, lastLoginAt: i.lastLoginAt,
      })),
      password: user !== undefined && user.passwordHash !== null && !user.ssoOnly,
      ssoRequired: organisation?.ssoRequired === true,
    };
  }, { readOnly: true });
}

/**
 * Unlinks an identity (decision 2026-11-14): refused while the organisation enforces SSO,
 * and refused where it is the last way to sign in. A session verified with a second factor
 * where the person has one, since unlinking changes how the account is reached.
 */
export async function unlinkIdentity(deps: AuthDeps, sessionToken: string, identityId: string, correlationId: string) {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  if (view.mfa === 'required') throw new AppError('forbidden', 'verify a second factor first', { code: 'mfa.verify_first' });
  await inTransaction(deps.databases.pool('control'), { organisationId: view.organisationId, userId: view.userId }, async (db) => {
    const live = await userIdentityRepo.listLiveForUser(db, view.userId);
    const identity = live.find((i) => i.id === identityId);
    if (identity === undefined) throw new AppError('not_found', 'no such identity', { code: 'identity.not_found' });
    const organisation = await organisationRepo.findById(db, view.organisationId);
    if (organisation?.ssoRequired === true) {
      throw new AppError('conflict', 'your organisation requires single sign-on, so its identity stays linked', { code: 'identity.sso_enforced' });
    }
    const user = await userRepo.findById(db, view.userId);
    const password = user !== undefined && user.passwordHash !== null && !user.ssoOnly;
    if (!password && live.length <= 1) {
      throw new AppError('conflict', 'this is your only way to sign in: set a password or link another identity first', { code: 'identity.last_method' });
    }
    if (!await userIdentityRepo.revoke(db, identity.id, view.membershipId)) {
      throw new AppError('not_found', 'no such identity', { code: 'identity.not_found' });
    }
    await recordAuthEvent(db, {
      organisationId: view.organisationId, correlationId, event: 'identity_unlinked', userId: view.userId, membershipId: view.membershipId,
      detail: { provider_kind: identity.providerKind, linked_via: identity.linkedVia, remaining: live.length - 1, password },
    });
  });
  return listIdentities(deps, sessionToken);
}

const factorView = (f: MfaFactor) => ({ id: f.id, kind: f.kind, confirmedAt: f.confirmedAt, lastUsedAt: f.lastUsedAt, createdAt: f.createdAt });

export async function listMfaFactors(deps: AuthDeps, sessionToken: string) {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  const factors = await inTransaction(deps.databases.pool('control'), { userId: view.userId }, (db) => mfaFactorRepo.listLive(db, view.userId),
    { readOnly: true });
  return { factors: factors.map(factorView) };
}

export async function removeMfaFactor(deps: AuthDeps, sessionToken: string, factorId: string, correlationId: string) {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  const control = deps.databases.pool('control');
  const factor = await inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.findById(db, factorId), { readOnly: true });
  if (!factor || factor.userId !== view.userId || factor.revokedAt !== null) {
    throw new AppError('not_found', 'no such factor', { code: 'mfa.factor_not_found' });
  }
  if (factor.confirmedAt !== null) {
    if (view.mfa !== 'satisfied') throw new AppError('forbidden', 'verify a second factor before removing one', { code: 'mfa.verify_first' });
    const [confirmed, organisation] = await Promise.all([
      inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.countConfirmed(db, view.userId), { readOnly: true }),
      inTransaction(control, { organisationId: view.organisationId }, (db) => organisationRepo.findById(db, view.organisationId), { readOnly: true }),
    ]);
    if (confirmed <= 1 && organisation?.mfaRequired === true) {
      throw new AppError('conflict', 'your organisation requires a second factor: add another before removing this one', { code: 'mfa.last_factor' });
    }
  } else if (view.mfa === 'required') {
    throw new AppError('forbidden', 'verify a second factor first', { code: 'mfa.verify_first' });
  }
  await inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.update(db, factor.id, { revokedAt: new Date().toISOString() }));
  await inTransaction(control, { organisationId: view.organisationId }, (db) => recordAuthEvent(db, {
    organisationId: view.organisationId, correlationId, event: 'mfa_factor_removed', userId: view.userId, membershipId: view.membershipId,
    detail: { factor: factor.kind, confirmed: factor.confirmedAt !== null },
  }));
  return listMfaFactors(deps, sessionToken);
}
