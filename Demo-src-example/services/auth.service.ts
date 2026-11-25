import { authConfig } from '../config/auth.config';
import { actAsUser, withTransaction, withoutTenant, type Executor } from '../infra/db.infra';
import { runUntenanted, runWithTenant } from '../utils/tenantContext.util';
import { denial, invalid, notFound, unauthenticated } from '../utils/error.util';
import { hashIdentifier, hashPassword, needsRehash, verifyPassword } from '../utils/hash.util';
import { generateId } from '../utils/tokens.util';
import { canAttemptLogin, isLocked, type User } from '../models/user.model';
import { capabilitiesFor, type Organisation } from '../models/organisation.model';
import type { Membership } from '../models/membership.model';
import type { Session } from '../models/session.model';
import * as userRepo from '../repos/user.repo';
import * as membershipRepo from '../repos/membership.repo';
import * as organisationRepo from '../repos/organisation.repo';
/*
 * `actAsOrganisation` IS IMPORTED FROM `sso.repo` RATHER THAN DUPLICATED. It is
 * the sibling of `actAsUser` and belongs beside it in `infra/db`; until it moves
 * there, one definition shared is better than two that can drift on the third
 * argument to `set_config` — which is the argument that decides whether a tenant
 * id outlives the transaction on a pooled connection.
 */
import { actAsOrganisation } from '../repos/sso.repo';
import * as sessionService from './session.service';
import * as sessionRepo from '../repos/session.repo';
import { log } from './audit.service';
import * as directory from '../infra/directory.infra';
import { cellConfig } from '../config/cell.config';
import { childLogger } from '../config/logger.config';
import { seedSystemRoles } from './role.service';
import { provisionIncluded } from './seat.service';
import { INCLUDED_SEATS } from '../config/constants.config';

/**
 * Registration and login.
 *
 * LOGIN IS UNTENANTED BY NECESSITY. It has an email and nothing else — the tenant
 * is what it is trying to establish. `runUntenanted('login-lookup', …)` declares
 * that, so "what runs without a tenant" has a countable answer rather than being
 * a grep for a function name.
 *
 * IT NEVER SAYS WHY IT FAILED. No such user, wrong password, locked, suspended —
 * all one message. Distinguishing them hands an attacker a user-enumeration
 * oracle, and the person who genuinely mistyped is helped by none of it.
 */

const cellLog = childLogger('cell');

export interface LoginContext {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * A membership with enough about its organisation to be rendered.
 *
 * THE NAME IS THE WHOLE POINT. A picker listing `organisationId` is a picker
 * asking somebody to choose between three uuids. Reading it needs the
 * `organisations_own` policy from migration 006, because at this moment in the
 * flow no tenant has been chosen and `organisations_tenant` cannot match.
 */
export interface OrganisationChoice {
  membershipId: string;
  organisationId: string;
  name: string;
  slug: string;
  /** Password sign-in is refused for this one. See `login`. */
  ssoRequired: boolean;
}

export type LoginOutcome =
  | {
      ok: true;
      token: string;
      session: Session;
      memberships: Membership[];
      choices: OrganisationChoice[];
      next: 'choose-organisation' | 'ready';
    }
  | { ok: false; reason: 'invalid-credentials' | 'locked' | 'suspended' | 'sso-required' }
  /**
   * Their data is in a different cell.
   *
   * `cellUrl` MAY BE NULL, when the directory names a cell this process has
   * never been told the address of. That is a misconfiguration rather than a
   * user error, and saying "your account is in another region" without saying
   * which is still better than "your password is wrong".
   */
  | { ok: false; reason: 'other-cell'; cellUrl: string | null };

/**
 * The organisations a session's user may act in.
 *
 * SEPARATE FROM `login` BECAUSE A PAGE RELOAD MUST NOT COST A PASSWORD. The
 * picker is a real screen somebody can land on with a valid session and no
 * chosen membership; without this, refreshing it would strand them with no way
 * forward but signing in again.
 */
export async function organisationChoices(token: string): Promise<OrganisationChoice[] | null> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const found = await sessionService.resolve(db, token);
      if (!found) return null;

      await actAsUser(db, found.session.userId);
      const memberships = await membershipRepo.listForUser(db, found.session.userId);
      return choicesFor(db, memberships.filter((m) => m.status === 'active'));
    }),
  );
}

/**
 * Attach organisation names to a set of memberships.
 *
 * ONE QUERY, NOT ONE PER MEMBERSHIP. Three round trips for three organisations
 * is invisible at this size and is the shape that becomes a problem later,
 * inside a loop nobody revisits.
 */
async function choicesFor(
  db: Executor,
  memberships: Membership[],
): Promise<OrganisationChoice[]> {
  if (memberships.length === 0) return [];

  const organisations = await organisationRepo.listNamesByIds(
    db,
    memberships.map((m) => m.organisationId),
  );
  const byId = new Map(organisations.map((organisation) => [organisation.id, organisation]));

  return memberships.flatMap((m) => {
    const organisation = byId.get(m.organisationId);
    // A membership whose organisation the policy will not show is omitted
    // rather than rendered nameless. It cannot be chosen usefully anyway.
    return organisation
      ? [{
          membershipId: m.id,
          organisationId: m.organisationId,
          name: organisation.name,
          slug: organisation.slug,
          ssoRequired: organisation.ssoRequired,
        }]
      : [];
  });
}

export async function login(
  email: string,
  password: string,
  context: LoginContext = {},
): Promise<LoginOutcome> {
  /*
   * THE DIRECTORY IS CONSULTED BEFORE THE PASSWORD, and answers only "which
   * cell". A person whose data lives in another cell cannot be authenticated
   * here — the rows are not in this database — so without this they are told
   * their password is wrong, which is untrue and unfixable by them.
   *
   * AN UNKNOWN ADDRESS IS NOT AN ERROR. It is every typo and every stranger, and
   * the flow must continue exactly as if the person were local so that "we have
   * never heard of you" stays indistinguishable from "wrong password".
   */
  const cell = await directory.cellFor(email);
  if (cell && !cellConfig.owns(cell)) {
    return { ok: false, reason: 'other-cell' as const, cellUrl: cellConfig.urlFor(cell) };
  }

  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const user = await userRepo.findByEmail(db, email);

      /*
       * A PASSWORD IS VERIFIED EVEN WHEN THERE IS NO USER. Returning early here
       * makes the no-such-user path measurably faster than the wrong-password
       * path, and that timing difference is a working enumeration oracle.
       * `verifyPassword(null, …)` burns the same Argon2 cost and returns false.
       */
      if (!user) {
        await verifyPassword(null, password);
        return { ok: false, reason: 'invalid-credentials' as const };
      }

      /*
       * FROM HERE THE CALLER IS THIS USER. `user_by_email` bypassed the policy to
       * find them; recording a failed attempt, clearing the counter and issuing a
       * session are all ordinary writes that `users_own` and `sessions_own` must
       * govern.
       */
      await actAsUser(db, user.id);

      if (isLocked(user)) {
        /*
         * AN ATTEMPT AGAINST A LOCKED ACCOUNT IS STILL AN ATTEMPT.
         *
         * No password is checked here and the counter is not touched — the lock
         * already did its job — so nothing was recorded, and an attacker
         * hammering an account for the whole lockout window added not one row.
         * A reviewer would see the burst that caused the lock and then silence,
         * and read the silence as the attacker giving up.
         *
         * `attempt` reports the count as it stands rather than incrementing it:
         * this is an observation, not a further failure, and inflating the
         * counter here would extend the lock on every probe, which is a way to
         * keep somebody locked out indefinitely.
         */
        await recordFailure(
          db,
          user,
          { failedAttemptCount: user.failedAttemptCount, locked: true, duringLock: true },
          context,
        );
        return { ok: false, reason: 'locked' as const };
      }
      if (!canAttemptLogin(user)) return { ok: false, reason: 'suspended' as const };

      const correct = await verifyPassword(user.passwordHash, password);

      if (!correct) {
        const attempt = await userRepo.recordFailedAttempt(
          db,
          user.id,
          authConfig.maxFailedAttempts,
          authConfig.lockoutSeconds,
        );
        await recordFailure(db, user, attempt, context);
        return { ok: false, reason: 'invalid-credentials' as const };
      }

      /*
       * REHASHED ON SUCCESSFUL LOGIN, WHICH IS THE ONLY MOMENT IT CAN BE. The
       * plaintext is in hand exactly here. Raising the Argon2 parameters without
       * this leaves every existing account on the old cost forever.
       */
      if (user.passwordHash && needsRehash(user.passwordHash)) {
        await userRepo.updatePasswordHash(db, user.id, await hashPassword(password));
      }

      await userRepo.clearFailedAttempts(db, user.id);

      /*
       * THE MEMBERSHIP LOOKUP NEEDS `app.user_id` AND NO TENANT. This is what
       * `memberships_own` exists for — reading your own rows across
       * organisations, before one has been chosen.
       */
      await actAsUser(db, user.id);
      const memberships = await membershipRepo.listForUser(db, user.id);
      const active = memberships.filter((m) => m.status === 'active');

      /*
       * `sso_required` FINALLY MEANS SOMETHING.
       *
       * It has been a column since the first migration and nothing read it, so
       * an organisation that had turned it on was still reachable with a
       * password — the entire thing it was turned on to prevent.
       *
       * FILTERED RATHER THAN REFUSED OUTRIGHT, because somebody may belong to
       * one organisation that requires SSO and another that does not. Blocking
       * their password sign-in altogether would lock them out of the second for
       * a policy set by the first; instead they sign in and are simply not
       * offered the one that needs a directory.
       *
       * DECIDED BEFORE THE SESSION IS ISSUED, and that ordering is the whole
       * repair. Filtering afterwards produced two bugs: a person whose only
       * organisation required SSO got a live session row with that membership
       * active before being told no, and a person with one SSO organisation and
       * one password organisation was told `ready` while holding a session with
       * no membership at all — which then 401s on the very next request and
       * reads as "it does not keep me logged in".
       */
      const choices = await choicesFor(db, active);
      const passwordAllowed = choices.filter((choice) => !choice.ssoRequired);

      if (active.length > 0 && passwordAllowed.length === 0) {
        return { ok: false, reason: 'sso-required' as const };
      }

      const allowedIds = new Set(passwordAllowed.map((choice) => choice.membershipId));
      const usable = active.filter((membership) => allowedIds.has(membership.id));

      /*
       * A SESSION IS ISSUED EVEN WITH NO MEMBERSHIPS. The person authenticated;
       * they simply belong to nothing yet — an invited user who has not accepted,
       * or one whose only membership was removed. Refusing the login would tell
       * them their password is wrong, which it is not.
       */
      const only = usable.length === 1 ? usable[0]! : null;

      const { session, token } = await sessionService.issue({
        db,
        userId: user.id,
        activeMembershipId: only?.id ?? null,
        authMethod: 'password',
        ip: context.ip,
        userAgent: context.userAgent,
      });

      if (only) {
        await runWithTenant({ organisationId: only.organisationId, membershipId: only.id }, async () => {
          await actAsOrganisation(db, only.organisationId);
          await log(db, {
            event: 'login',
            organisationId: only.organisationId,
            membershipId: only.id,
            userId: user.id,
            detail: { method: 'password' },
            ipHash: context.ip ? hashIdentifier(context.ip, authConfig.ipHashSecret) : null,
          });
        });
      }

      return {
        ok: true as const,
        choices: passwordAllowed,
        token,
        session,
        // The memberships offered are the ones that can actually be entered.
        memberships: usable,
        next: only ? ('ready' as const) : ('choose-organisation' as const),
      };
    }),
  );
}

/**
 * Leave a trace of a failed sign-in.
 *
 * THE TRAIL RECORDED ONLY THE HALF THAT DOES NOT MATTER. `login_failed` and
 * `lockout` have been in the closed set since the table existed and nothing ever
 * wrote either, so a run of credential stuffing incremented the counter, locked
 * the account, and left `auth_events` empty — a security review querying for it
 * concluded no attack had happened.
 *
 * ONE ROW PER ORGANISATION THE PERSON BELONGS TO, because `auth_events` is
 * tenant-scoped and `organisation_id` is NOT NULL: there is no tenant-less place
 * to put this, and a failure against a shared account is genuinely every
 * tenant's business. A person with no membership, and an address with no
 * account, therefore leave no row — which is also what keeps the table from
 * becoming a list of which addresses are registered.
 *
 * `membershipId` IS NULL, as migration 002 says it is on a failed login: nothing
 * was authenticated, so no membership acted. `user_id` is what names the account
 * under attack.
 *
 * IT DOES NOT SAY WHAT WAS TRIED. No address, no submitted password — an audit
 * row about a wrong password must not be where the wrong password is kept, since
 * the next one typed is somebody's real password for another site.
 */
async function recordFailure(
  db: Executor,
  user: User,
  attempt: { failedAttemptCount: number; locked: boolean; duringLock?: boolean },
  context: LoginContext,
): Promise<void> {
  const memberships = await membershipRepo.listForUser(db, user.id);
  const ipHash = context.ip ? hashIdentifier(context.ip, authConfig.ipHashSecret) : null;

  for (const membership of memberships.filter((m) => m.status === 'active')) {
    await runWithTenant(
      { organisationId: membership.organisationId, membershipId: membership.id },
      async () => {
        await actAsOrganisation(db, membership.organisationId);

        await log(db, {
          event: 'login_failed',
          organisationId: membership.organisationId,
          membershipId: null,
          userId: user.id,
          detail: {
            method: 'password',
            attempt: attempt.failedAttemptCount,
            /*
             * A PROBE AGAINST AN ALREADY-LOCKED ACCOUNT IS A DIFFERENT FACT
             * from the attempt that locked it. Both belong in the trail —
             * continued pressure during a lock is the signal that somebody is
             * working through a list rather than mistyping — and conflating
             * them would make the attempt count read as though the lock were
             * not holding.
             */
            duringLock: attempt.duringLock === true,
          },
          ipHash,
        });

        /*
         * THE LOCKOUT IS A SEPARATE ROW, NOT A FLAG ON THE FAILURE. It is the
         * moment the account stopped being usable by its owner, which is the
         * event an investigation and a support ticket both start from, and a
         * detail key on a high-volume event is not something anybody filters on.
         *
         * EXACTLY ONCE PER LOCK, WHICH IS WHY `duringLock` IS EXCLUDED HERE.
         * Attempts made while the lock holds are now recorded — they were
         * silent, and an attacker hammering an account for the whole window
         * added not one row — but they did not lock anything. Emitting a
         * lockout for each would turn one event into a burst and make "when did
         * this account lock" unanswerable from the trail.
         */
        if (attempt.locked && attempt.duringLock !== true) {
          await log(db, {
            event: 'lockout',
            organisationId: membership.organisationId,
            membershipId: null,
            userId: user.id,
            detail: {
              method: 'password',
              attempts: attempt.failedAttemptCount,
              lockoutSeconds: authConfig.lockoutSeconds,
            },
            ipHash,
          });
        }
      },
    );
  }
}

/**
 * Register a new organisation and its first member.
 *
 * THE FIRST MEMBER IS THE SUPER ADMIN, AND THERE IS NO OTHER WAY TO CREATE ONE.
 * Every subsequent admin is delegated by somebody, under the subtree rules; this
 * is the root of that chain and the only place it can begin.
 *
 * ONE TRANSACTION. A user without an organisation, or an organisation with no
 * member, is a state nothing in the product can recover from — the second has no
 * one who can invite anybody.
 */
export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organisationName: string;
  context?: LoginContext;
}

/**
 * The one composition rule worth having.
 *
 * LENGTH IS THE POLICY AND THIS IS THE EXCEPTION. Requiring a symbol and a
 * digit produces `Password1!` and pushes people toward the substitutions a
 * cracker tries first, which is why there is no such rule. But a password
 * containing the local part of its own email address is guessable by somebody
 * who has done no work at all — the address is on the sign-in form they are
 * already looking at.
 *
 * FOUR CHARACTERS, so short locals like `ops@` or `it@` do not ban a perfectly
 * good passphrase that happens to contain them.
 *
 * ENFORCED HERE BECAUSE THE BROWSER'S COPY IS ADVICE. `lib/password.ts` runs
 * the same check at the keystroke so the message arrives while somebody is
 * still typing; this is what makes it true.
 */
export function assertPasswordAcceptable(password: string, email: string): void {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) {
    throw invalid({
      message: 'Your password cannot contain your email address.',
      code: 'invalid.password_contains_email',
      fields: { password: 'Your password cannot contain your email address.' },
    });
  }
}

export async function register(input: RegisterInput): Promise<{
  organisation: Organisation;
  membership: Membership;
  user: User;
  token: string;
}> {
  const slug = slugify(input.organisationName);

  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const existing = await userRepo.findByEmail(db, input.email);
      if (existing) {
        /*
         * THIS IS AN ENUMERATION ORACLE AND IT IS ACCEPTED HERE, unlike at
         * login. Registration cannot avoid it: the address either can or cannot
         * be registered, and any design that hides which — silently sending a
         * "you already have an account" email — makes signing up a guessing
         * game. The mitigation is rate limiting, not ambiguity.
         */
        throw invalid({
          message: 'An account already exists for that email address.',
          code: 'invalid.email_taken',
        });
      }

      const taken = await organisationRepo.findBySlug(db, slug);
      if (taken) {
        throw invalid({
          message: `The name "${input.organisationName}" is already in use.`,
          code: 'invalid.slug_taken',
        });
      }

      /*
       * THE ID IS GENERATED FIRST SO THE POLICY CAN BE SATISFIED BY THE INSERT
       * THAT CREATES IT. `users_own` checks `id = app_user_id()`, and a user
       * being created has no session and no identity — so the context is set to
       * the id we are about to write, in the same transaction. It is the same
       * chicken-and-egg the organisation insert below solves the same way, and
       * it is not a loophole: nothing outside this transaction can reach a row
       * for an id that does not exist yet.
       */
      assertPasswordAcceptable(input.password, input.email);

      const userId = generateId();
      await actAsUser(db, userId);

      const user = await userRepo.create(db, {
        id: userId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        passwordHash: await hashPassword(input.password),
      });

      /*
       * THE TENANT CONTEXT IS SET TO AN ORGANISATION THAT DOES NOT EXIST YET, and
       * that is not a trick — it is the only order that works.
       *
       * `organisations` is under RLS with `WITH CHECK (id = app_org_id())`, so an
       * insert from outside any tenant is rejected: you cannot create a tenant
       * while not in one, and you cannot be in one that does not exist. Found by
       * the first test that tried to register, which failed with
       * `new row violates row-level security policy`.
       *
       * The id is generated here rather than by the database precisely so this is
       * possible. Setting the context to it first means the row being inserted
       * belongs to the tenant doing the inserting, which is true — the
       * organisation being created IS the tenant.
       *
       * IT STAYS IN ONE TRANSACTION. Splitting the untenanted user creation from
       * a tenanted organisation creation would leave an orphaned user whenever
       * the second half failed, and `set_config(..., true)` applies for the rest
       * of this transaction and is discarded at COMMIT.
       */
      const organisationId = generateId();
      /*
       * THE CELL IS STAMPED AT CREATION and never changes. It is what lets a
       * process refuse to serve a tenant that was restored into the wrong place
       * or reached through a misconfigured connection string.
       */
      await actAsOrganisation(db, organisationId);

      const organisation = await organisationRepo.create(db, {
        id: organisationId,
        name: input.organisationName,
        slug,
      });

      const membership = await membershipRepo.create(db, {
        id: generateId(),
        userId: user.id,
        organisationId: organisation.id,
        status: 'active',
      });

      /*
       * THE ROLES ARE SEEDED IN THE SAME TRANSACTION, and the founder is made
       * super admin here. An organisation without them has nobody who can create
       * a super admin, because the permission to do it belongs to the role that
       * does not exist — an unrecoverable state, reachable by this transaction
       * failing halfway.
       */
      await seedSystemRoles(db, organisation.id, membership.id);

      /*
       * SEATS EXIST FROM THE FIRST SECOND, and the founder is sitting in one.
       * An organisation created with an empty pool refuses its very first
       * invitation for lack of capacity, which reads as the product being
       * broken rather than as a limit.
       */
      /*
       * RECORDED AFTER THE ACCOUNT EXISTS, not before. A directory entry
       * pointing at a cell that has no such person routes their next sign-in
       * here and then fails — which is worse than not being in the directory at
       * all, because the fallback for an unknown address is "assume local".
       */
      await directory.record(input.email);

      await provisionIncluded(db, {
        organisationId: organisation.id,
        count: INCLUDED_SEATS[organisation.plan],
        founderMembershipId: membership.id,
      });

      const { token } = await sessionService.issue({
        db,
        userId: user.id,
        activeMembershipId: membership.id,
        authMethod: 'password',
        ip: input.context?.ip,
        userAgent: input.context?.userAgent,
      });

      await log(db, {
        event: 'member_joined',
        organisationId: organisation.id,
        membershipId: membership.id,
        userId: user.id,
        detail: { role: 'founder', method: 'registration' },
      });

      return { organisation, membership, user, token };
    }),
  );
}

/**
 * Resolve a request's session into everything an authorisation decision needs.
 *
 * IT RETURNS THE ORGANISATION, NOT ONLY THE IDS, because the caller needs
 * `mfaRequired` to decide whether the session is authorised at all and
 * `billingStatus` to decide what it may do. Fetching those separately means three
 * round trips per request and three chances to forget one.
 */
export interface AuthenticatedRequest {
  session: Session;
  user: User;
  membership: Membership;
  organisation: Organisation;
  capabilities: ReturnType<typeof capabilitiesFor>;
}

/**
 * Found an organisation as somebody who already has an account.
 *
 * SEPARATE FROM `register`, WHICH ALWAYS CREATES A USER TOO. Social sign-in
 * produces exactly the state `register` cannot serve: a real, verified person
 * who belongs to nothing. Without this they land in the app with a session that
 * has no membership, every page 401s, and the only way forward is to abandon
 * the account they just made.
 *
 * IT IS THE ONLY WAY TO GAIN A MEMBERSHIP BESIDES AN INVITATION, and it creates
 * a NEW organisation every time. Nothing here lets somebody attach themselves to
 * an existing one: signing in with Google proves who you are and says nothing
 * about where you belong.
 */
export async function createOrganisation(input: {
  token: string;
  name: string;
  context?: LoginContext;
}): Promise<{ organisation: Organisation; membership: Membership; token: string } | null> {
  const identity = await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const found = await sessionService.resolve(db, input.token);
      if (!found) return null;

      await actAsUser(db, found.session.userId);
      const user = await userRepo.findById(db, found.session.userId);
      return user && user.status === 'active' ? { session: found.session, user } : null;
    }),
  );

  if (!identity) return null;

  const slug = slugify(input.name);
  const organisationId = generateId();

  return runWithTenant({ organisationId, userId: identity.user.id }, async () =>
    withTransaction(async (db) => {
      await actAsUser(db, identity.user.id);

      const taken = await organisationRepo.findBySlug(db, slug);
      if (taken) {
        throw invalid({
          message: `The name “${input.name}” is already taken. Try another.`,
          code: 'invalid.slug_taken',
        });
      }

      const organisation = await organisationRepo.create(db, {
        id: organisationId,
        name: input.name,
        slug,
      });

      const membership = await membershipRepo.create(db, {
        id: generateId(),
        userId: identity.user.id,
        organisationId,
        status: 'active',
        invitedBy: null,
      });

      // The founder is the super admin, in the same transaction — an
      // organisation whose first member holds no role is one nobody can
      // administer, including to fix that.
      await seedSystemRoles(db, organisationId, membership.id);
      await provisionIncluded(db, {
        organisationId,
        count: INCLUDED_SEATS[organisation.plan],
        founderMembershipId: membership.id,
      });

      /*
       * A NEW SESSION NAMING THE NEW MEMBERSHIP. The one they arrived with has
       * none, and `authenticate` refuses a session with no active membership —
       * so returning the old token would leave them exactly as stuck as before.
       */
      const issued = await sessionService.issue({
        db,
        userId: identity.user.id,
        activeMembershipId: membership.id,
        authMethod: identity.session.authMethod,
        ip: input.context?.ip,
        userAgent: input.context?.userAgent,
        mfaSatisfied: identity.session.mfaSatisfiedAt !== null,
      });

      await log(db, {
        event: 'member_joined',
        organisationId,
        membershipId: membership.id,
        userId: identity.user.id,
        detail: { via: 'founded' },
      });

      return { organisation, membership, token: issued.token };
    }),
  );
}

export async function authenticate(token: string): Promise<AuthenticatedRequest | null> {
  /*
   * TWO PHASES, AND THE SPLIT IS THE POINT.
   *
   * The first is untenanted because it cannot be anything else: a token names a
   * session, a session names a user, and neither is scoped to an organisation.
   * The membership is read through `memberships_own`, which is why `app.user_id`
   * is set — it is the same policy the login picker uses.
   *
   * The second runs under the tenant the session named, so everything from there
   * is read under that tenant's policies. A session naming a membership that no
   * longer exists, or an organisation that was deleted, simply finds nothing
   * rather than being caught by a check somebody has to remember to write.
   *
   * THE FIRST VERSION CALLED `withoutTenant` FOR THE SECOND PHASE WITHOUT
   * DECLARING A REASON, and the guard in `db.infra` refused it. That is the guard
   * doing its job on its author.
   */
  const identity = await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const found = await sessionService.resolve(db, token);
      if (!found) return null;

      /*
       * SET BEFORE THE USER IS READ, not after. `session_by_token` bypassed the
       * policy to find the session; reading the user it names is an ordinary
       * `SELECT` that `users_own` governs, so doing this afterwards returns no row
       * and signs everybody out. It also serves `memberships_own` below.
       */
      await actAsUser(db, found.session.userId);

      const user = await userRepo.findById(db, found.session.userId);
      if (!user || user.status !== 'active') return null;
      if (!found.session.activeMembershipId) return null;
      const memberships = await membershipRepo.listForUser(db, user.id);
      const membership = memberships.find(
        (m) => m.id === found.session.activeMembershipId && m.status === 'active',
      );

      return membership ? { session: found.session, user, membership } : null;
    }),
  );

  if (!identity) return null;

  return runWithTenant(
    {
      organisationId: identity.membership.organisationId,
      membershipId: identity.membership.id,
      userId: identity.user.id,
    },
    async () =>
      withTransaction(async (db) => {
        const organisation = await organisationRepo.findById(db, identity.membership.organisationId);
        if (!organisation) return null;

        /*
         * THE CELL CHECK, ON EVERY AUTHENTICATED REQUEST.
         *
         * `cell.config` has described this boundary since the first week and
         * nothing consulted it — `CELL_ID` was validated at boot and then never
         * read. This is the single chokepoint every request passes through, so
         * it is where a tenant that is not ours stops.
         *
         * IT REFUSES ON MISSING AS WELL AS ON MISMATCH. A row with no cell is
         * not a row that belongs everywhere; it is one written by something that
         * did not know about cells, which is the bug this exists to surface.
         */
        if (!cellConfig.owns(organisation.cellId)) {
          // `log` in this file is the audit writer, not a logger.
          cellLog.error(
            { organisationId: organisation.id, theirs: organisation.cellId, ours: cellConfig.id },
            'Refused a tenant belonging to another cell',
          );
          return null;
        }

        return {
          session: identity.session,
          user: identity.user,
          membership: identity.membership,
          organisation,
          capabilities: capabilitiesFor(organisation.billingStatus),
        };
      }),
  );
}

/**
 * Where else this person is signed in, and how to end one of those sessions.
 *
 * ── THE LIST EXISTED AND NOTHING SHOWED IT ────────────────────────────────
 *
 * `listActiveForUser` has been in the session repo since the beginning, and the
 * only caller was the password change, which uses it to find the session doing
 * the changing. Meanwhile the security page told people changing a password
 * ends their other sessions — a claim nobody could check, about sessions nobody
 * could see.
 *
 * ── WHAT IT SAYS AND WHAT IT CANNOT ───────────────────────────────────────
 *
 * The address and the browser are stored HASHED and keyed, deliberately, so
 * "where from" cannot be answered here and is not pretended to be. What a
 * person can tell one session from another by is when it started, when it was
 * last used, how it signed in, and which one they are using now.
 */
export async function sessions(
  token: string,
): Promise<Array<{ id: string; current: boolean; issuedAt: Date; lastSeenAt: Date | null; expiresAt: Date; authMethod: string }>> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const found = await sessionService.resolve(db, token);
      if (!found) throw unauthenticated({ message: 'Sign in again.', code: 'unauthenticated.session' });

      /*
       * SESSIONS ARE UNDER A ROW POLICY KEYED TO THE ACTING USER, not to a
       * tenant — a session belongs to a person rather than an organisation. A
       * connection acting for nobody matches no rows and would report, quite
       * calmly, that somebody is signed in nowhere.
       */
      await actAsUser(db, found.session.userId);
      const live = await sessionRepo.listActiveForUser(db, found.session.userId);

      return live.map((session: Session) => ({
        id: session.id,
        current: session.id === found.session.id,
        issuedAt: session.issuedAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        authMethod: session.authMethod,
      }));
    }),
  );
}

/**
 * End one of them.
 *
 * ONLY YOUR OWN, AND THE CHECK IS THE USER'S ID RATHER THAN THE SESSION'S.
 * Anything else would let anybody holding a session end anybody else's by
 * naming an id, which is a denial of service behind one parameter.
 *
 * ENDING THE ONE IN YOUR HAND IS ALLOWED, and is the same as signing out. It
 * would be strange to refuse the act the list makes obvious.
 */
export async function endSession(token: string, sessionId: string): Promise<{ ended: boolean; wasCurrent: boolean }> {
  const ended = await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const found = await sessionService.resolve(db, token);
      if (!found) throw unauthenticated({ message: 'Sign in again.', code: 'unauthenticated.session' });

      await actAsUser(db, found.session.userId);
      const live = await sessionRepo.listActiveForUser(db, found.session.userId);
      const ending = live.find((session: Session) => session.id === sessionId);
      if (!ending) {
        throw notFound({ message: 'That session has already ended.', code: 'missing.session' });
      }

      await sessionService.revoke(db, ending);
      return { ending, wasCurrent: ending.id === found.session.id, userId: found.session.userId };
    }),
  );

  /*
   * THE TRAIL IS WRITTEN AFTERWARDS, IN THE TENANT'S OWN TRANSACTION, because
   * the two tables live under different policies: a session belongs to a person
   * and is read acting as them, while `auth_events` belongs to an organisation
   * and is written acting for it. One connection cannot be both.
   *
   * THE ACT IS THE REVOCATION, AND IT HAS ALREADY HAPPENED. A session that
   * never chose an organisation has no tenant to write to, and the row is
   * simply not written rather than invented somewhere it does not belong.
   */
  if (ended.ending.activeMembershipId) {
    const membership = await runUntenanted('login-lookup', async () =>
      withoutTenant(async (db) => {
        await actAsUser(db, ended.userId);
        return membershipRepo.findById(db, ended.ending.activeMembershipId!);
      }),
    );

    if (membership) {
      await runWithTenant({ organisationId: membership.organisationId, membershipId: membership.id }, () =>
        withTransaction((db) =>
          log(db, {
            event: 'session_revoked',
            organisationId: membership.organisationId,
            membershipId: membership.id,
            userId: ended.userId,
            detail: { sessionId, reason: 'ended_by_owner' },
          }),
        ),
      );
    }
  }

  return { ended: true, wasCurrent: ended.wasCurrent };
}

export async function logout(token: string): Promise<void> {
  await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const found = await sessionService.resolve(db, token);
      if (found) await sessionService.revoke(db, found.session);
    }),
  );
}

/**
 * Choose which organisation to act in.
 *
 * THE MEMBERSHIP IS RE-CHECKED AGAINST THE SESSION'S USER, not taken on trust
 * from the request. Without it, anybody holding a valid session could switch into
 * any organisation by naming a membership id — which is a complete tenant bypass
 * behind one parameter.
 */
export async function chooseOrganisation(
  token: string,
  membershipId: string,
  context: LoginContext = {},
): Promise<{ token: string; session: Session } | null> {
  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const found = await sessionService.resolve(db, token);
      if (!found) return null;

      await actAsUser(db, found.session.userId);
      const memberships = await membershipRepo.listForUser(db, found.session.userId);
      const chosen = memberships.find((m) => m.id === membershipId && m.status === 'active');

      if (!chosen) {
        throw denial({
          message: 'You are not a member of that organisation.',
          code: 'denial.not_a_member',
        });
      }

      const issued = await sessionService.switchMembership(db, found.session, chosen.id, context);

      await actAsOrganisation(db, chosen.organisationId);
      await log(db, {
        event: 'login',
        organisationId: chosen.organisationId,
        membershipId: chosen.id,
        userId: found.session.userId,
        detail: { method: 'organisation-switch' },
      });

      return { token: issued.token, session: issued.session };
    }),
  );
}

/**
 * A URL-safe name.
 *
 * COLLISIONS ARE REPORTED, NOT AUTO-SUFFIXED. "Acme Ltd" and "Acme Limited" both
 * become `acme`, and quietly handing the second customer `acme-2` gives them a
 * URL they did not choose and cannot guess. Telling them the name is taken lets
 * them pick.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

  if (slug.length < 2) {
    throw invalid({
      message: 'That organisation name cannot be used as a web address.',
      code: 'invalid.slug_unusable',
    });
  }
  return slug;
}

export { notFound };
