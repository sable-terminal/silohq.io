// Password login (spec 55.2, 55.3, 60.1), per organisation.
//
// Every failure answers the same, so a caller cannot tell an unknown organisation, an
// unknown address, a wrong password, a locked account or a missing membership apart;
// where no stored hash is checked, a decoy hash is, so timing does not tell either. The
// one exception is an organisation that requires SSO, which is no secret.
//
// A wrong password counts towards lockout (10 by default, then 15 minutes locked); a
// locked account's password is not checked at all, so lockout is not an oracle. A correct
// password clears the counter and, when the hashing parameters changed, rehashes.

import type { SessionView } from '../../contracts/auth/session.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { membershipRepo, mfaFactorRepo, organisationRepo, userRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';
import { mfaStateOf } from './sessions.service.ts';

export interface LoginInput {
  organisationSlug: string;
  email: string;
  password: string;
  client?: { address?: string | undefined; userAgent?: string | undefined } | undefined;
}

const failed = (): AppError => new AppError('unauthenticated', 'the email address or password is not right', { code: 'auth.login_failed' });

export async function login(deps: AuthDeps, input: LoginInput, correlationId: string): Promise<SessionView & { sessionToken: string }> {
  const { security } = deps.config;
  const control = deps.databases.pool('control');
  const ipHash = deps.guard.addressHash(input.client?.address);
  const userAgentHash = deps.guard.userAgentHash(input.client?.userAgent);
  const window = security.rateLimits.windowSeconds;
  if (ipHash) await deps.guard.limit('login_address', ipHash, security.rateLimits.loginAttemptsPerAddress, window);
  await deps.guard.limit('login_email', deps.guard.emailHash(input.email), security.rateLimits.loginAttemptsPerEmail, window);

  const [organisation, user] = await inTransaction(control, {}, async (db) => [
    await organisationRepo.findForLogin(db, input.organisationSlug),
    await userRepo.findForLogin(db, input.email),
  ] as const);

  const fail = async (reason: string, userId: string | null = null): Promise<never> => {
    if (organisation?.status === 'active') {
      await inTransaction(control, { organisationId: organisation.id }, (db) =>
        recordAuthEvent(db, { organisationId: organisation.id, correlationId, event: 'login_failed', userId, ipHash, detail: { reason } }));
    }
    throw failed();
  };

  if (!organisation || organisation.status !== 'active') {
    await deps.hasher.verify(input.password, deps.decoyHash);
    return fail('organisation');
  }
  if (organisation.ssoRequired) {
    throw new AppError('forbidden', 'this organisation signs in through its identity provider', { code: 'auth.sso_required' });
  }
  if (!user || user.status !== 'active' || user.ssoOnly || user.passwordHash === null) {
    await deps.hasher.verify(input.password, deps.decoyHash);
    return fail('account', user?.id ?? null);
  }
  if (user.lockedUntil !== null && Date.parse(user.lockedUntil) > Date.now()) return fail('locked', user.id);

  if (!await deps.hasher.verify(input.password, user.passwordHash)) {
    await inTransaction(control, { organisationId: organisation.id, userId: user.id }, async (db) => {
      const result = await userRepo.recordFailedLogin(db, user.id, security.lockoutThreshold, security.lockoutMinutes);
      await recordAuthEvent(db, { organisationId: organisation.id, correlationId, event: 'login_failed', userId: user.id, ipHash, detail: { reason: 'password' } });
      if (result.locked) {
        await recordAuthEvent(db, { organisationId: organisation.id, correlationId, event: 'lockout', userId: user.id, ipHash, detail: {} });
      }
    });
    throw failed();
  }

  const rehashed = deps.hasher.needsRehash(user.passwordHash) ? await deps.hasher.hash(input.password) : undefined;
  const issued = await inTransaction(control, { organisationId: organisation.id, userId: user.id }, async (db) => {
    const membership = await membershipRepo.findByUserId(db, { userId: user.id, organisationId: organisation.id });
    if (!membership || membership.status !== 'active') return undefined;
    const mfa = mfaStateOf(null, await mfaFactorRepo.countConfirmed(db, user.id), organisation.mfaRequired);
    await userRepo.recordLogin(db, user.id, rehashed);
    const session = await deps.sessions.issue(db, { organisation, userId: user.id, membershipId: membership.id, mfa, ipHash, userAgentHash });
    await recordAuthEvent(db, {
      organisationId: organisation.id, correlationId, event: 'login', userId: user.id, membershipId: membership.id, ipHash,
      detail: { method: 'password', mfa },
    });
    return session;
  });
  if (!issued) return fail('membership', user.id);
  await issued.cache();
  return { ...issued.view, sessionToken: issued.token };
}
