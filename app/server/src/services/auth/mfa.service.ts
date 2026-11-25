// MFA by TOTP (spec 55.4; decisions 2026-10-29).
//
// - The credential service opens the factor and checks the code; auth then accepts the
//   step by compare-and-set on last_used_step, so a code works once, even when two
//   requests race with it.
// - A new factor may be enrolled only by someone with no confirmed factor, or whose session
//   has already satisfied MFA. Otherwise a stolen password could add the thief's factor.
// - Attempts are rate limited per session.

import { verifyTotp as verifyTotpContract, enrolTotp as enrolTotpContract, type SealedSecretWire } from '../../contracts/credential/totp.contract.ts';
import type { SessionView } from '../../contracts/auth/session.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { MfaFactor } from '../../models/iam/mfaFactor.model.ts';
import { mfaFactorRepo, userRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';

const ISSUER = 'Silo';

const wrongCode = (): AppError => new AppError('unauthenticated', 'that code is not right; try the current one', { code: 'auth.mfa_failed' });

const sealedOf = (factor: MfaFactor): SealedSecretWire => {
  if (!factor.secretSealed || !factor.nonce || !factor.dekWrapped || !factor.keyVersionId) {
    throw new AppError('integrity', 'a TOTP factor is missing its sealed secret', { code: 'mfa.factor_incomplete' });
  }
  return {
    secretSealed: factor.secretSealed.toString('base64'), nonce: factor.nonce.toString('base64'),
    dekWrapped: factor.dekWrapped.toString('base64'), keyVersionId: factor.keyVersionId,
  };
};

async function checkCode(deps: AuthDeps, view: SessionView, factor: MfaFactor, code: string, correlationId: string): Promise<number | null> {
  const { step } = await deps.services.call(verifyTotpContract, {
    body: {
      factorId: factor.id, sealed: sealedOf(factor), code,
      lastUsedStep: factor.lastUsedStep === null ? null : Number(factor.lastUsedStep),
    },
  }, { request: { userId: view.userId, organisationId: view.organisationId }, correlationId });
  return step;
}

const rateLimit = (deps: AuthDeps, view: SessionView): Promise<void> =>
  deps.guard.limit('mfa_session', view.sessionId, deps.config.security.rateLimits.mfaAttemptsPerSession, deps.config.security.rateLimits.windowSeconds);

export async function verifyMfa(deps: AuthDeps, sessionToken: string, code: string, correlationId: string): Promise<SessionView> {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  if (view.mfa === 'satisfied') return view;
  if (view.mfa !== 'required') {
    throw new AppError('validation', 'there is no factor to verify; enrol one first', { code: 'mfa.not_enrolled' });
  }
  await rateLimit(deps, view);
  const control = deps.databases.pool('control');
  const factors = await inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.listUsableTotp(db, view.userId));
  for (const factor of factors) {
    const step = await checkCode(deps, view, factor, code, correlationId);
    if (step === null) continue;
    const accepted = await inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.acceptStep(db, factor.id, step));
    if (!accepted) break;
    const satisfied = await deps.sessions.markMfaSatisfied(view);
    await inTransaction(control, { organisationId: view.organisationId }, (db) => recordAuthEvent(db, {
      organisationId: view.organisationId, correlationId, event: 'mfa_satisfied', userId: view.userId, membershipId: view.membershipId,
      detail: { factor: 'totp' },
    }));
    return satisfied;
  }
  await inTransaction(control, { organisationId: view.organisationId }, (db) => recordAuthEvent(db, {
    organisationId: view.organisationId, correlationId, event: 'login_failed', userId: view.userId, membershipId: view.membershipId,
    detail: { reason: 'mfa_code' },
  }));
  throw wrongCode();
}

// Enrolment is open to a person with no confirmed factor, or whose session satisfied MFA.
function mayEnrol(view: SessionView): void {
  if (view.mfa === 'required') {
    throw new AppError('forbidden', 'verify an existing factor before adding another', { code: 'mfa.verify_first' });
  }
}

export async function startTotpEnrolment(deps: AuthDeps, sessionToken: string, correlationId: string)
  : Promise<{ factorId: string; otpauthUri: string }> {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  mayEnrol(view);
  const control = deps.databases.pool('control');
  const user = await inTransaction(control, { userId: view.userId }, (db) => userRepo.findById(db, view.userId));
  if (!user) throw new AppError('unauthenticated', 'the session is not valid; sign in again', { code: 'auth.session_invalid' });
  const factorId = uuidv7();
  const { sealed, otpauthUri } = await deps.services.call(enrolTotpContract, {
    body: { factorId, accountName: user.email, issuer: ISSUER },
  }, { request: { userId: view.userId, organisationId: view.organisationId }, correlationId });
  await inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.insert(db, {
    id: factorId, userId: view.userId, kind: 'totp', secretSealed: Buffer.from(sealed.secretSealed, 'base64'),
    nonce: Buffer.from(sealed.nonce, 'base64'), dekWrapped: Buffer.from(sealed.dekWrapped, 'base64'), keyVersionId: sealed.keyVersionId,
  }));
  return { factorId, otpauthUri };
}

export async function confirmTotpEnrolment(deps: AuthDeps, sessionToken: string, factorId: string, code: string, correlationId: string)
  : Promise<SessionView> {
  const view = await deps.sessions.resolve(sessionToken, 'http_request');
  mayEnrol(view);
  await rateLimit(deps, view);
  const control = deps.databases.pool('control');
  const factor = await inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.findById(db, factorId));
  if (!factor || factor.userId !== view.userId || factor.kind !== 'totp' || factor.revokedAt !== null) {
    throw new AppError('not_found', 'no such factor', { code: 'mfa.factor_not_found' });
  }
  if (factor.confirmedAt !== null) throw new AppError('conflict', 'this factor is already confirmed', { code: 'mfa.already_confirmed' });
  const step = await checkCode(deps, view, factor, code, correlationId);
  if (step === null) throw wrongCode();
  const confirmed = await inTransaction(control, { userId: view.userId }, (db) => mfaFactorRepo.confirm(db, factor.id, step));
  if (!confirmed) throw new AppError('conflict', 'this factor is already confirmed', { code: 'mfa.already_confirmed' });
  const satisfied = await deps.sessions.markMfaSatisfied(view);
  await inTransaction(control, { organisationId: view.organisationId }, async (db) => {
    await recordAuthEvent(db, {
      organisationId: view.organisationId, correlationId, event: 'mfa_enrolled', userId: view.userId, membershipId: view.membershipId,
      detail: { factor: 'totp' },
    });
    await recordAuthEvent(db, {
      organisationId: view.organisationId, correlationId, event: 'mfa_satisfied', userId: view.userId, membershipId: view.membershipId,
      detail: { factor: 'totp' },
    });
  });
  return satisfied;
}
