// Self-serve sign-up (decision 2026-11-14; D78). Standard and Business; Enterprise stays
// on contract, and the sovereign build has no self-serve sign-up.
//
// Start: the address and the organisation's name, slug, plan, term and seats. A link with a
// one-time token goes to the address; the answer is the same whether or not the address has
// an account. Requests are limited per client address and per address, like resets.
//
// Complete: the token verifies the address. In one transaction: the organisation (on this
// cell, with the plan), the person when the cell has none with the address (verified now),
// their membership, and the founding super admin grant (a definer function, as provisioning
// makes it), the sign-up marked done and organisation_signed_up recorded. Then the slug and
// the new person are registered with the directory, the founder is signed in, and the
// subscription's checkout is started as them. Until the provider's verified webhook writes
// the subscription, the organisation has no entitlement: billing's own routes take it on.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { domainOf } from './domains.service.ts';
import { startCheckout } from '../../contracts/billing/subscription.contract.ts';
import { SIGNUP_HOURS } from '../../contracts/auth/signup.contract.ts';
import type { SessionView } from '../../contracts/auth/session.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { membershipRepo, organisationDomainRepo, organisationRepo, roleAssignmentRepo, signupRepo, userRepo } from '../../repos/iam/index.repo.ts';
import { normaliseEmail } from '../../utils/email.util.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { hashToken, issueToken } from '../../utils/token.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';
import { login } from './login.service.ts';
import { checkNewPassword } from './passwordReset.service.ts';

/** Sign-ups per address an hour. */
export const SIGNUPS_PER_EMAIL = 5;

type Client = { address?: string | undefined; userAgent?: string | undefined } | undefined;

function available(deps: AuthDeps): void {
  if (deps.config.cell.buildTarget === 'sovereign') {
    throw new AppError('forbidden', 'the sovereign deployment is on contract: there is no self-serve sign-up', { code: 'signup.unavailable' });
  }
}

export async function startSignup(deps: AuthDeps, input: {
  email: string; organisationName: string; organisationSlug: string; plan: 'standard' | 'business'; term: 'monthly' | 'annual'; seats: number;
  client?: Client;
}, correlationId: string): Promise<{ expiresAt: string }> {
  available(deps);
  const { security } = deps.config;
  const ipHash = deps.guard.addressHash(input.client?.address);
  if (ipHash) await deps.guard.limit('login_address', ipHash, security.rateLimits.loginAttemptsPerAddress, security.rateLimits.windowSeconds);
  await deps.guard.limit('signup_email', deps.guard.emailHash(input.email), SIGNUPS_PER_EMAIL, 3600);
  const control = deps.databases.pool('control');
  const email = normaliseEmail(input.email);
  if (await inTransaction(control, {}, (db) => organisationRepo.findForLogin(db, input.organisationSlug), { readOnly: true }) !== undefined) {
    throw new AppError('conflict', 'that organisation address is taken; choose another', { code: 'signup.slug_taken' });
  }
  // A domain an organisation here has verified is claimed (D79): its people are invited, not signed up apart.
  if (await inTransaction(control, {}, (db) => organisationDomainRepo.claimed(db, domainOf(email)), { readOnly: true })) {
    throw new AppError('conflict', 'your company\'s organisation on Silo has claimed this email domain: ask its administrator to invite you', {
      code: 'signup.domain_claimed',
    });
  }
  const { token, hash } = issueToken('signup');
  const expiresAt = new Date(Date.now() + SIGNUP_HOURS * 3_600_000).toISOString();
  await inTransaction(control, {}, async (db) => {
    await signupRepo.purgeExpired(db);
    await signupRepo.insert(db, {
      id: uuidv7(), email, organisationName: input.organisationName, organisationSlug: input.organisationSlug, plan: input.plan,
      term: input.term, seats: input.seats, tokenHash: hash, expiresAt,
    });
  });
  await deps.signupDelivery.deliver({ email, organisationName: input.organisationName, token, expiresAt, correlationId });
  return { expiresAt };
}

export async function completeSignup(deps: AuthDeps, input: {
  token: string; password: string; firstName?: string | undefined; lastName?: string | undefined; timeZone?: string | undefined; client?: Client;
}, correlationId: string): Promise<SessionView & { sessionToken: string; checkoutUrl: string | null }> {
  available(deps);
  const control = deps.databases.pool('control');
  const invalid = new AppError('unauthenticated', 'this sign-up link is not valid; sign up again', { code: 'signup.invalid' });
  const signup = await inTransaction(control, {}, (db) => signupRepo.findLiveByTokenHash(db, hashToken(input.token)), { readOnly: true });
  if (signup === undefined) throw invalid;

  const existing = await inTransaction(control, {}, (db) => userRepo.findForLogin(db, signup.email), { readOnly: true });
  let userId: string;
  let newUser: { passwordHash: string } | undefined;
  if (existing) {
    // The account exists: its owner proves it with their current password.
    if (existing.status !== 'active' || existing.passwordHash === null || !await deps.hasher.verify(input.password, existing.passwordHash)) {
      throw new AppError('unauthenticated', 'the password is not right for this account', { code: 'auth.login_failed' });
    }
    userId = existing.id;
  } else {
    if (input.firstName === undefined || input.lastName === undefined) {
      throw new AppError('validation', 'a new account needs a first and last name', { code: 'signup.name_required' });
    }
    await checkNewPassword(deps, input.password);
    userId = uuidv7();
    newUser = { passwordHash: await deps.hasher.hash(input.password) };
  }

  const organisationId = uuidv7();
  const membershipId = uuidv7();
  try {
    await inTransaction(control, { organisationId, userId }, async (db) => {
      await organisationRepo.insert(db, {
        id: organisationId, name: signup.organisationName, slug: signup.organisationSlug, plan: signup.plan, cellId: deps.config.cell.id,
        calendarTimeZone: input.timeZone ?? 'Europe/London',
      });
      if (newUser) {
        await userRepo.insert(db, {
          id: userId, firstName: input.firstName!, lastName: input.lastName!, email: signup.email, passwordHash: newUser.passwordHash,
          emailVerifiedAt: new Date().toISOString(),
        });
      }
      await membershipRepo.insert(db, { id: membershipId, userId, organisationId, status: 'active', joinedAt: new Date().toISOString() });
      await roleAssignmentRepo.grantFoundingSuperAdmin(db, organisationId, membershipId);
      if (!await signupRepo.complete(db, signup.id, organisationId)) throw invalid;
      await recordAuthEvent(db, {
        organisationId, correlationId, event: 'organisation_signed_up', userId, membershipId,
        detail: { plan: signup.plan, term: signup.term, seats: signup.seats, new_account: newUser !== undefined },
      });
      // tenant_placed (6.7): the organisation's data lives in this cell from now on; read beside a later migration's events.
      await outboxRepo.insert(db, {
        id: uuidv7(), organisationId, topic: auditEventMessage.topic, orderingKey: organisationId, event: auditEventMessage.name,
        schemaVersion: auditEventMessage.version, correlationId,
        payload: auditEventMessage.schema.parse({
          event: 'tenant_placed', actor: { kind: 'membership', membershipId }, subjectMembershipId: null, scopeId: null,
          resource: { type: 'organisation', id: organisationId }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
          detail: { cell_id: deps.config.cell.id, plan: signup.plan, route: 'signup' },
        }),
      });
    });
  } catch (error) {
    const mapped = isAppError(error) ? error : fromDatabaseError(error);
    if (mapped.category === 'conflict' && mapped.code !== 'signup.invalid') {
      throw new AppError('conflict', 'that organisation address was taken meanwhile; sign up again with another', { code: 'signup.slug_taken' });
    }
    if (mapped.details['sqlstate'] === '22023' || mapped.code === 'db.22023') {
      throw new AppError('validation', 'that is not a time zone', { code: 'signup.time_zone' });
    }
    throw error;
  }
  await deps.directory.registerOrganisation(signup.organisationSlug, correlationId);
  if (newUser) await deps.directory.registerIdentity({ userId, email: signup.email }, correlationId);
  const session = await login(deps, { organisationSlug: signup.organisationSlug, email: signup.email, password: input.password, client: input.client },
    correlationId);
  let checkoutUrl: string | null = null;
  try {
    const checkout = await deps.services.call(startCheckout, { body: { plan: signup.plan, term: signup.term, seats: signup.seats } }, {
      request: { organisationId, membershipId, userId }, correlationId, idempotencyKey: `signup-${signup.id}`,
    });
    checkoutUrl = checkout.checkoutUrl;
  } catch (error) {
    deps.logger.failure('the checkout could not be started at sign-up; billing starts it again', error, { event: 'signup.checkout_deferred', organisationId });
  }
  return { ...session, checkoutUrl };
}
