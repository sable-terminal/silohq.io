// WebAuthn as an MFA factor (spec 55.4), and changing a password while signed in (spec 55.3).
//
// WebAuthn: @simplewebauthn/server builds the options and verifies the answers: the
// challenge (issued here, kept in redis-data for the session, used once), the origin, the
// relying party (the public origin's host), user presence, and the signature over the
// authenticator data. A registration is a confirmed factor at once: its public key and
// counter are stored, never a secret, so the credential service has no part in it. An
// assertion is accepted only by moving the stored counter forward with a compare-and-set
// (or both staying 0, for authenticators that do not count), so two requests racing with
// one assertion cannot both succeed and a cloned authenticator shows itself.
//
// Changing a password: the current password is checked as at login (a wrong one counts
// towards lockout), the new one as any new password is, and every other session of the
// person is revoked with the change, this one kept.

import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { SessionView } from '../../contracts/auth/session.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { webauthnChallengeKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { MfaFactor } from '../../models/iam/mfaFactor.model.ts';
import { mfaFactorRepo, sessionRepo, userRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';
import { checkNewPassword } from './passwordReset.service.ts';

type Ceremony = 'register' | 'assert';

function relyingParty(deps: AuthDeps): { origin: string; rpID: string; rpName: string } {
  const origin = deps.config.gateway.publicOrigin;
  if (origin === undefined) throw new AppError('configuration', 'WebAuthn needs the public origin (GATEWAY_PUBLIC_ORIGIN)', { code: 'config.webauthn.origin' });
  return { origin, rpID: new URL(origin).hostname, rpName: deps.config.sso.webauthnRpName };
}

const challengeKey = (view: SessionView, ceremony: Ceremony) =>
  webauthnChallengeKeys.key(view.organisationId, { sessionId: view.sessionId, ceremony });

async function takeChallenge(deps: AuthDeps, view: SessionView, ceremony: Ceremony): Promise<string> {
  const key = challengeKey(view, ceremony);
  const held = await deps.flows.read(webauthnChallengeKeys, key);
  if (held === undefined || await deps.flows.remove(webauthnChallengeKeys, key) !== 1) {
    throw new AppError('validation', 'start the ceremony again', { code: 'webauthn.challenge_missing' });
  }
  return held.challenge;
}

const refused = (): AppError => new AppError('unauthenticated', 'the security key\'s answer could not be verified', { code: 'webauthn.failed' });
const credentialIdOf = (factor: MfaFactor): string => factor.credentialId!.toString('base64url');

const rateLimit = (deps: AuthDeps, view: SessionView): Promise<void> =>
  deps.guard.limit('mfa_session', view.sessionId, deps.config.security.rateLimits.mfaAttemptsPerSession, deps.config.security.rateLimits.windowSeconds);

// --------------------------------------------------------------------- registration

export async function startRegistration(deps: AuthDeps, sessionToken: string): Promise<{ options: Record<string, unknown> & { challenge: string } }> {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  if (view.mfa === 'required') throw new AppError('forbidden', 'verify an existing factor before adding another', { code: 'mfa.verify_first' });
  const rp = relyingParty(deps);
  const control = deps.databases.pool('control');
  const { user, factors } = await inTransaction(control, { userId: view.userId }, async (db) => ({
    user: await userRepo.findById(db, view.userId),
    factors: await mfaFactorRepo.listUsableWebauthn(db, view.userId),
  }));
  if (!user) throw new AppError('unauthenticated', 'the session is not valid; sign in again', { code: 'auth.session_invalid' });
  const options = await generateRegistrationOptions({
    rpName: rp.rpName, rpID: rp.rpID, userName: user.email, userDisplayName: `${user.firstName} ${user.lastName}`,
    userID: Buffer.from(view.userId.replaceAll('-', ''), 'hex'), attestationType: 'none',
    excludeCredentials: factors.map((f) => ({ id: credentialIdOf(f) })),
    authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
  });
  await deps.flows.put(webauthnChallengeKeys, challengeKey(view, 'register'), { challenge: options.challenge }, { ttlSeconds: 300 });
  return { options: options as unknown as Record<string, unknown> & { challenge: string } };
}

export async function confirmRegistration(deps: AuthDeps, sessionToken: string, response: RegistrationResponseJSON, correlationId: string)
  : Promise<SessionView> {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  if (view.mfa === 'required') throw new AppError('forbidden', 'verify an existing factor before adding another', { code: 'mfa.verify_first' });
  await rateLimit(deps, view);
  const rp = relyingParty(deps);
  const expectedChallenge = await takeChallenge(deps, view, 'register');
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false,
    });
  } catch {
    throw refused();
  }
  if (!verified.verified) throw refused();
  const { credential } = verified.registrationInfo;
  const control = deps.databases.pool('control');
  try {
    await inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.insert(db, {
      id: uuidv7(), userId: view.userId, kind: 'webauthn', credentialId: Buffer.from(credential.id, 'base64url'),
      webauthnPublicKey: Buffer.from(credential.publicKey), signCount: String(credential.counter), confirmedAt: new Date().toISOString(),
    }));
  } catch (error) {
    if (error instanceof AppError && error.category === 'conflict') {
      throw new AppError('conflict', 'this security key is already registered', { code: 'webauthn.already_registered' });
    }
    throw error;
  }
  const satisfied = await deps.sessions.markMfaSatisfied(view);
  await inTransaction(control, { organisationId: view.organisationId }, async (db) => {
    for (const event of ['mfa_enrolled', 'mfa_satisfied'] as const) {
      await recordAuthEvent(db, {
        organisationId: view.organisationId, correlationId, event, userId: view.userId, membershipId: view.membershipId, detail: { factor: 'webauthn' },
      });
    }
  });
  return satisfied;
}

// --------------------------------------------------------------------- assertion

export async function startAssertion(deps: AuthDeps, sessionToken: string): Promise<{ options: Record<string, unknown> & { challenge: string } }> {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  if (view.mfa !== 'required') throw new AppError('validation', 'there is no factor to verify', { code: 'mfa.not_enrolled' });
  const rp = relyingParty(deps);
  const factors = await inTransaction(deps.databases.pool('control'), { userId: view.userId }, (db) => mfaFactorRepo.listUsableWebauthn(db, view.userId));
  if (factors.length === 0) throw new AppError('validation', 'no security key is registered', { code: 'webauthn.not_enrolled' });
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID, allowCredentials: factors.map((f) => ({ id: credentialIdOf(f) })), userVerification: 'preferred',
  });
  await deps.flows.put(webauthnChallengeKeys, challengeKey(view, 'assert'), { challenge: options.challenge }, { ttlSeconds: 300 });
  return { options: options as unknown as Record<string, unknown> & { challenge: string } };
}

export async function verifyAssertion(deps: AuthDeps, sessionToken: string, response: AuthenticationResponseJSON, correlationId: string)
  : Promise<SessionView> {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  if (view.mfa === 'satisfied') return view;
  if (view.mfa !== 'required') throw new AppError('validation', 'there is no factor to verify', { code: 'mfa.not_enrolled' });
  await rateLimit(deps, view);
  const rp = relyingParty(deps);
  const expectedChallenge = await takeChallenge(deps, view, 'assert');
  const control = deps.databases.pool('control');
  const fail = async (reason: string): Promise<never> => {
    await inTransaction(control, { organisationId: view.organisationId }, (db) => recordAuthEvent(db, {
      organisationId: view.organisationId, correlationId, event: 'login_failed', userId: view.userId, membershipId: view.membershipId,
      detail: { reason },
    }));
    throw refused();
  };
  const factor = (await inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.listUsableWebauthn(db, view.userId)))
    .find((f) => credentialIdOf(f) === response.id);
  if (!factor) return fail('mfa_webauthn_unknown');
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false,
      credential: { id: credentialIdOf(factor), publicKey: new Uint8Array(factor.webauthnPublicKey!), counter: Number(factor.signCount) },
    });
  } catch {
    return fail('mfa_webauthn');
  }
  if (!verified.verified) return fail('mfa_webauthn');
  const moved = await inTransaction(control, { userId: view.userId }, (db) =>
    mfaFactorRepo.acceptCounter(db, factor.id, Number(factor.signCount), verified.authenticationInfo.newCounter));
  if (!moved) return fail('mfa_webauthn_counter');
  const satisfied = await deps.sessions.markMfaSatisfied(view);
  await inTransaction(control, { organisationId: view.organisationId }, (db) => recordAuthEvent(db, {
    organisationId: view.organisationId, correlationId, event: 'mfa_satisfied', userId: view.userId, membershipId: view.membershipId,
    detail: { factor: 'webauthn' },
  }));
  return satisfied;
}

// --------------------------------------------------------------------- password change

export async function changePassword(deps: AuthDeps, ctx: HandlerContext, input: { currentPassword: string; newPassword: string })
  : Promise<{ otherSessionsRevoked: number }> {
  const { userId, sessionId, organisationId, membershipId } = ctx.request;
  if (userId === undefined || sessionId === undefined || organisationId === undefined) {
    throw new AppError('forbidden', 'a password is changed by the signed-in person', { code: 'auth.not_permitted' });
  }
  const { security } = deps.config;
  const control = deps.databases.pool('control');
  const user = await inTransaction(control, { userId }, (db) => userRepo.findById(db, userId));
  const wrong = new AppError('unauthenticated', 'the current password is not right', { code: 'auth.password_wrong' });
  if (!user || user.status !== 'active') throw wrong;
  if (user.ssoOnly || user.passwordHash === null) {
    throw new AppError('validation', 'this account signs in through its identity provider', { code: 'auth.sso_only' });
  }
  if (user.lockedUntil !== null && Date.parse(user.lockedUntil) > Date.now()) throw wrong;
  if (!await deps.hasher.verify(input.currentPassword, user.passwordHash)) {
    await inTransaction(control, { organisationId, userId }, async (db) => {
      await userRepo.recordFailedLogin(db, userId, security.lockoutThreshold, security.lockoutMinutes);
      await recordAuthEvent(db, {
        organisationId, correlationId: ctx.correlationId, event: 'login_failed', userId, membershipId: membershipId ?? null,
        detail: { reason: 'password_change' },
      });
    });
    throw wrong;
  }
  if (input.newPassword === input.currentPassword) {
    throw new AppError('validation', 'choose a password different from the current one', { code: 'password.unchanged' });
  }
  await checkNewPassword(deps, input.newPassword);
  const hash = await deps.hasher.hash(input.newPassword);
  const revoked = await inTransaction(control, { organisationId, userId }, async (db) => {
    await userRepo.setPassword(db, userId, hash);
    const others = await sessionRepo.revokeOthersOfUser(db, userId, sessionId);
    await recordAuthEvent(db, {
      organisationId, correlationId: ctx.correlationId, event: 'password_changed', userId, membershipId: membershipId ?? null,
      detail: { method: 'change', sessions_revoked: others.length },
    });
    return others;
  });
  await deps.sessions.forget(revoked, userId);
  return { otherSessionsRevoked: revoked.length };
}
