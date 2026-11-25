import { authConfig } from '../config/auth.config';
import {
  CLIENT_ROUTES,
  PASSWORD_RESETS_PER_TTL,
  PASSWORD_RESET_TTL_SECONDS,
} from '../config/constants.config';
import { env } from '../config/env.config';
import { actAsUser, withoutTenant } from '../infra/db.infra';
import { runUntenanted } from '../utils/tenantContext.util';
import { denial, invalid } from '../utils/error.util';
import { hashIdentifier, hashPassword, hashToken, verifyPassword } from '../utils/hash.util';
import { generateId, generatePrefixedToken } from '../utils/tokens.util';
import { expiresIn } from '../utils/expiry.util';
import * as userRepo from '../repos/user.repo';
import * as resetRepo from '../repos/passwordReset.repo';
import * as sessionRepo from '../repos/session.repo';
import * as sessionService from './session.service';
import { assertPasswordAcceptable } from './auth.service';
import * as mailer from '../infra/mailer.infra';

/**
 * Changing and resetting a password.
 *
 * BOTH PATHS REVOKE EVERY SESSION, AND THAT IS THE POINT OF BOTH. A password
 * change is what somebody does when they believe their account is compromised.
 * Leaving the attacker's existing session alive is the one outcome that must not
 * happen, and it is the failure people are most surprised by — they changed the
 * password and the intruder stayed logged in.
 */

/**
 * Change a known password.
 *
 * THE CURRENT PASSWORD IS REQUIRED EVEN THOUGH THE SESSION IS AUTHENTICATED. A
 * session token can be stolen; the password cannot be read back from anywhere. It
 * is the difference between "somebody has this browser" and "somebody is this
 * person", and changing a password is a change of the second kind.
 */
export async function change(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  /**
   * The caller's own session, which is replaced rather than kept. See below.
   */
  keepSessionId?: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ sessionsRevoked: number; token: string | null }> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      // The caller already proved this session; the policies still need telling.
      await actAsUser(db, input.userId);

      const user = await userRepo.findById(db, input.userId);
      if (!user) throw denial({ message: 'Not permitted.', code: 'denial.no_user' });

      const correct = await verifyPassword(user.passwordHash, input.currentPassword);
      if (!correct) {
        throw denial({
          message: 'That is not your current password.',
          code: 'denial.wrong_password',
        });
      }

      if (input.newPassword === input.currentPassword) {
        throw invalid({
          message: 'The new password must be different from the current one.',
          code: 'invalid.password_unchanged',
        });
      }

      /*
       * READ BEFORE REVOKING. The replacement session has to continue in the
       * same organisation the caller was working in; after the revocation there
       * is nothing left to read that from, and defaulting to "no membership"
       * would drop them back to the organisation picker.
       */
      const current = input.keepSessionId
        ? (await sessionRepo.listActiveForUser(db, user.id)).find(
            (session) => session.id === input.keepSessionId,
          )
        : undefined;

      // The same rule registration applies. A password chosen later must not be
      // weaker than one chosen at signup.
      assertPasswordAcceptable(input.newPassword, user.email);

      await userRepo.updatePasswordHash(db, user.id, await hashPassword(input.newPassword));

      const revoked = await sessionRepo.revokeAllForUser(db, user.id);

      /*
       * EVERY SESSION DIES, INCLUDING THE CALLER'S, AND THEN THE CALLER GETS A
       * NEW ONE. Sparing a session would mean the revocation is not "all", and
       * the spared one is exactly the session an attacker who is already inside
       * would be holding. Re-issuing gives the same outcome the user wants —
       * they are not signed out of the tab they did it in — while making every
       * token that existed before the change worthless, that one included.
       *
       * THE FIRST VERSION FILTERED THE RETURNED COUNT AND ISSUED NOTHING, so the
       * comment above it described a re-issue that did not happen and
       * `keepSessionId` changed only a number. It was found by changing a
       * password over HTTP and watching the next request come back 401.
       */
      const replacement = current
        ? await sessionService.issue({
            db,
            userId: user.id,
            activeMembershipId: current.activeMembershipId,
            authMethod: current.authMethod,
            ip: input.ip,
            userAgent: input.userAgent,
            // Carried across: the person has just proved they know the password,
            // and making them re-satisfy a factor they satisfied minutes ago
            // punishes the action we want them to take.
            mfaSatisfied: current.mfaSatisfiedAt !== null,
          })
        : null;

      return {
        sessionsRevoked: revoked.length,
        token: replacement?.token ?? null,
      };
    }),
  );
}

/**
 * Request a reset.
 *
 * IT ALWAYS REPORTS SUCCESS, WHATEVER HAPPENED. Saying "no account with that
 * address" turns the reset form into a user-enumeration oracle that needs no
 * password and no rate limit to exploit. The person who typed their address
 * wrongly sees the same message and finds no email, which is a recoverable
 * confusion; the alternative leaks the customer list.
 */
export async function requestReset(input: {
  email: string;
  ip?: string | null;
}): Promise<void> {
  await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const user = await userRepo.findByEmail(db, input.email);
      if (!user || user.status !== 'active') return;

      /*
       * AN SSO-ONLY ACCOUNT GETS NO RESET. There is no password to reset, and
       * sending one would let somebody with access to the mailbox set a password
       * on an account the organisation deliberately made SSO-only — bypassing
       * their identity provider entirely.
       */
      if (!user.passwordHash) return;

      const token = generatePrefixedToken('pwr');

      // `password_resets_own` governs the insert, and `user_by_email` above
      // bypassed the policy only to find who this is.
      await actAsUser(db, user.id);

      /*
       * ── ONE MAILBOX, HOWEVER MANY ADDRESSES ASKED ──────────────────────────
       *
       * The route is rate limited per ADDRESS, which is the right key for
       * guessing. It does nothing about a distributed sender pointing many
       * addresses at ONE person: every request is valid, nothing is being
       * guessed, and the damage is the flood — an inbox of genuine reset links,
       * among which a phishing copy is very hard to spot.
       *
       * RETURNS SILENTLY, LIKE EVERY OTHER PATH HERE. This endpoint answers
       * identically whether or not the address exists, and saying "too many
       * resets" would turn it into the account-enumeration oracle the rest of
       * the function is carefully built to avoid.
       *
       * Tokens already issued stay valid, so this stops mail rather than
       * stopping the reset.
       */
      const recent = await resetRepo.countRecentForUser(
        db,
        user.id,
        new Date(Date.now() - PASSWORD_RESET_TTL_SECONDS * 1000),
      );

      if (recent >= PASSWORD_RESETS_PER_TTL) return;

      await resetRepo.create(db, {
        id: generateId(),
        userId: user.id,
        tokenHash: hashToken(token),
        requestedIpHash: input.ip ? hashIdentifier(input.ip, authConfig.ipHashSecret) : null,
        expiresAt: expiresIn(PASSWORD_RESET_TTL_SECONDS),
      });

      const link = `${env.APP_URL}${CLIENT_ROUTES.resetPassword}?token=${encodeURIComponent(token)}`;

      await mailer.send({
        to: user.email,
        subject: 'Reset your Silo password',
        text:
          `Hello ${user.firstName},\n\n` +
          `Somebody asked to reset the password for this account. If it was you, use the link below. ` +
          `It works once and expires in an hour.\n\n${link}\n\n` +
          `If it was not you, nothing has changed and you can ignore this. ` +
          `Your password has not been altered and nobody has been signed in.\n\n—\nSilo\nsilohq.io`,
      });
    }),
  );
}

/**
 * Consume a reset token and set the new password.
 *
 * ONE TRANSACTION: CONSUME, SET, REVOKE. If the revocation were a separate
 * transaction and failed, the password would be changed and the attacker's
 * session would survive — which is the precise failure this exists to prevent.
 */
export async function consumeReset(input: {
  token: string;
  newPassword: string;
}): Promise<{ userId: string; sessionsRevoked: number }> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const consumed = await resetRepo.consume(db, hashToken(input.token));

      if (!consumed) {
        /*
         * ONE MESSAGE FOR WRONG, USED AND EXPIRED. Distinguishing them says
         * whether a token ever existed, and "already used" in particular tells
         * an attacker holding a leaked link that somebody beat them to it —
         * which is a signal about the account, not about the token.
         */
        throw invalid({
          message: 'That reset link is not valid. Request a new one.',
          code: 'invalid.reset_token',
        });
      }

      /*
       * The person holding the link has no session, so nothing has established
       * who they are. `consume_password_reset` just did, atomically, and
       * everything below is an ordinary write on that user's rows.
       */
      await actAsUser(db, consumed.userId);

      /*
       * THE RULE APPLIES ON THE RESET PATH TOO, and this is the one where it is
       * easiest to forget: the caller supplied only a token and a new password,
       * so the address has to be looked up before it can be compared.
       */
      const resetting = await userRepo.findById(db, consumed.userId);
      if (resetting) assertPasswordAcceptable(input.newPassword, resetting.email);

      await userRepo.updatePasswordHash(db, consumed.userId, await hashPassword(input.newPassword));

      /*
       * THE ACCOUNT IS UNLOCKED. Somebody who forgot their password has usually
       * tried several times and locked themselves out, and leaving the lock in
       * place means the reset appears not to have worked.
       */
      await userRepo.clearFailedAttempts(db, consumed.userId);

      const revoked = await sessionRepo.revokeAllForUser(db, consumed.userId);

      return { userId: consumed.userId, sessionsRevoked: revoked.length };
    }),
  );
}
