// Password resets (spec 55.3).
//
// - A request answers the same whether or not the address has an account, and is rate
//   limited per address and per client.
// - The link is single use and expires after 30 minutes by default. Only its hash is
//   stored; the token goes to the delivery (the notify service, once built) and nowhere
//   else.
// - Consuming it sets the new password and revokes every session of the person in one
//   statement, then removes the sessions' hot copies.
// - A new password is at least PASSWORD_MIN_LENGTH characters and not on the breach list,
//   checked when it is set, never at login.

import { inTransaction } from '../../infra/postgres.infra.ts';
import { membershipRepo, organisationRepo, passwordResetRepo, sessionRepo, userRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { hashToken, issueToken } from '../../utils/token.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';

/** Refuses a password that is too short or known to be breached. */
export async function checkNewPassword(deps: AuthDeps, password: string): Promise<void> {
  const length = [...password.normalize('NFC')].length;
  if (length < deps.config.security.passwordMinLength) {
    throw new AppError('validation', `a password has at least ${deps.config.security.passwordMinLength} characters`, {
      code: 'password.too_short', details: { minimum: deps.config.security.passwordMinLength },
    });
  }
  if (!deps.breachList.configured) {
    deps.logger.warn('no breach list is configured; a new password was not checked', { event: 'password.breach_list_missing' });
  } else if (await deps.breachList.contains(password)) {
    throw new AppError('validation', 'this password appears in known breaches; choose another', { code: 'password.breached' });
  }
}

export async function requestPasswordReset(
  deps: AuthDeps, input: { organisationSlug: string; email: string; client?: { address?: string | undefined } | undefined }, correlationId: string,
): Promise<void> {
  const { security } = deps.config;
  const ipHash = deps.guard.addressHash(input.client?.address);
  if (ipHash) await deps.guard.limit('login_address', ipHash, security.rateLimits.loginAttemptsPerAddress, security.rateLimits.windowSeconds);
  await deps.guard.limit('reset_email', deps.guard.emailHash(input.email), security.rateLimits.resetRequestsPerEmail, 3600);

  const control = deps.databases.pool('control');
  const [organisation, user] = await inTransaction(control, {}, async (db) => [
    await organisationRepo.findForLogin(db, input.organisationSlug),
    await userRepo.findForLogin(db, input.email),
  ] as const);
  if (!organisation || organisation.status !== 'active' || !user || user.status !== 'active' || user.ssoOnly) return;

  const { token, hash } = issueToken('password_reset');
  const expiresAt = new Date(Date.now() + security.passwordResetMinutes * 60_000).toISOString();
  const issued = await inTransaction(control, { organisationId: organisation.id, userId: user.id }, async (db) => {
    const membership = await membershipRepo.findByUserId(db, { userId: user.id, organisationId: organisation.id });
    if (!membership || membership.status !== 'active') return false;
    await passwordResetRepo.insert(db, { id: uuidv7(), userId: user.id, tokenHash: hash, requestedFromIpHash: ipHash ?? null, expiresAt });
    await recordAuthEvent(db, {
      organisationId: organisation.id, correlationId, event: 'password_reset_requested', userId: user.id, membershipId: membership.id,
      ipHash, detail: {},
    });
    return true;
  });
  if (issued) await deps.resetDelivery.deliver({ organisationId: organisation.id, userId: user.id, email: input.email, token, expiresAt, correlationId });
}

export async function resetPassword(
  deps: AuthDeps, input: { organisationSlug: string; token: string; newPassword: string }, correlationId: string,
): Promise<void> {
  await checkNewPassword(deps, input.newPassword);
  const control = deps.databases.pool('control');
  const organisation = await inTransaction(control, {}, (db) => organisationRepo.findForLogin(db, input.organisationSlug));
  const invalid = new AppError('unauthenticated', 'this reset link is not valid; ask for a new one', { code: 'auth.reset_invalid' });
  if (!organisation || organisation.status !== 'active') throw invalid;

  const passwordHash = await deps.hasher.hash(input.newPassword);
  const consumed = await inTransaction(control, {}, (db) => passwordResetRepo.consume(db, hashToken(input.token), passwordHash));
  if (!consumed) throw invalid;

  const revoked = await inTransaction(control, { userId: consumed.userId }, (db) => sessionRepo.organisationsOf(db, consumed.revokedSessionIds));
  await deps.sessions.forget(revoked, consumed.userId);
  await inTransaction(control, { organisationId: organisation.id, userId: consumed.userId }, async (db) => {
    const membership = await membershipRepo.findByUserId(db, { userId: consumed.userId, organisationId: organisation.id });
    await recordAuthEvent(db, {
      organisationId: organisation.id, correlationId, event: 'password_reset_consumed', userId: consumed.userId,
      membershipId: membership?.id ?? null, detail: { sessions_revoked: consumed.revokedSessionIds.length },
    });
  });
}
