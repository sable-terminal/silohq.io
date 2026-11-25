import type { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import * as mfaService from '../services/mfa.service';
import { authConfig } from '../config/auth.config';
import { SESSION_TTL_SECONDS } from '../config/constants.config';
import { denial, invalid, otherCell, unauthenticated } from '../utils/error.util';
import { body, params } from '../middleware/validate.middleware';
import { clientIp, userAgent } from '../middleware/requestContext.middleware';
import { tokenOf } from '../middleware/authenticate.middleware';
import { presentMembership, presentOrganisation, presentSession, presentUser } from './present';
import type * as schema from '../schemas/auth.schema';

/**
 * The session endpoints.
 *
 * THE TOKEN IS RETURNED IN THE BODY *AND* SET AS A COOKIE, and the two are for
 * different clients. The web app keeps it in memory and sends a Bearer header,
 * so a cross-site script cannot read it out of storage. The cookie is `httpOnly`
 * and exists so that following a link from an email arrives signed in, which a
 * memory-held token cannot do. Both name the same session, and revoking it kills
 * both at once — which is the property that made an opaque server-side session
 * worth the round trip over a JWT.
 */

function setSessionCookie(res: Response, token: string): void {
  res.cookie(authConfig.cookie.name, token, {
    ...authConfig.cookie,
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

function contextOf(req: Request) {
  return { ip: clientIp(req), userAgent: userAgent(req) };
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = body<schema.LoginBody>(req);
  const outcome = await authService.login(email, password, contextOf(req));

  if (!outcome.ok) {
    if (outcome.reason === 'other-cell') {
      /*
       * A ROUTING ANSWER, NOT A CREDENTIAL ONE. This person's password was never
       * checked here and could not be — their rows are in another database — so
       * saying anything about credentials would be a guess presented as a fact.
       */
      throw otherCell({
        message: outcome.cellUrl
          ? 'Your organisation is hosted in a different region. Continue there.'
          : 'Your organisation is hosted in a different region.',
        code: 'other_cell.elsewhere',
        fields: outcome.cellUrl ? { signInAt: outcome.cellUrl } : {},
      });
    }

    /*
     * `locked` AND `suspended` ARE TOLD APART; `invalid-credentials` IS NOT
     * ELABORATED. Being told an account is locked is information the account
     * holder needs and an attacker already caused, so withholding it only hurts
     * the real user. Being told an address exists is information only the
     * attacker wanted.
     */
    const message =
      outcome.reason === 'locked'
        ? 'Too many failed attempts. Try again shortly, or reset your password.'
        : outcome.reason === 'suspended'
          ? 'This account has been suspended. Contact your administrator.'
          : outcome.reason === 'sso-required'
            ? /*
               * A DIFFERENT INSTRUCTION, NOT A DIFFERENT SEVERITY. This person's
               * password is correct and their account is fine; their
               * organisation has decided passwords are not how you get in. A
               * generic "does not match" would send them to reset a password
               * that was never the problem.
               */
              'Your organisation signs in with single sign-on. Use the button above.'
            : 'That email address and password do not match.';

    throw denial({ message, code: `denial.${outcome.reason.replace(/-/g, '_')}` });
  }

  setSessionCookie(res, outcome.token);

  res.status(200).json({
    token: outcome.token,
    next: outcome.next,
    session: presentSession(outcome.session),
    /*
     * THE CHOICES ARE SENT SO THE PICKER CAN BE DRAWN, and they carry the
     * organisation NAME. Sending memberships alone — which is what this did
     * first — offers somebody a choice between three uuids. Both are read
     * through the `_own` policies rather than through a tenant, because at this
     * moment no tenant has been chosen.
     */
    memberships: outcome.memberships.map(presentMembership),
    choices: outcome.choices,
  });
}

export async function register(req: Request, res: Response): Promise<void> {
  // `turnstileToken` is destructured off rather than spread through. The
  // middleware has already used it; passing it on would put a bot-check nonce
  // into a service that has no business holding one, and into whatever it logs.
  const { turnstileToken: _ignored, ...input } = body<schema.RegisterBody>(req);
  const result = await authService.register({ ...input, context: contextOf(req) });

  setSessionCookie(res, result.token);

  res.status(201).json({
    token: result.token,
    user: presentUser(result.user),
    organisation: presentOrganisation(result.organisation),
    membership: presentMembership(result.membership),
  });
}

export async function chooseOrganisation(req: Request, res: Response): Promise<void> {
  const { membershipId } = body<schema.ChooseOrganisationBody>(req);
  const result = await authService.chooseOrganisation(tokenOf(req), membershipId, contextOf(req));

  if (!result) throw unauthenticated();

  /*
   * A NEW TOKEN, NOT THE OLD ONE REPOINTED. `switchMembership` rotates it, so a
   * token captured while the user was in one organisation cannot be replayed
   * after they move to another.
   */
  setSessionCookie(res, result.token);

  res.status(200).json({ token: result.token, session: presentSession(result.session) });
}

/**
 * The organisations this session may act in.
 *
 * REACHABLE WITH A SESSION THAT HAS NO MEMBERSHIP YET, which is the entire
 * reason it exists: the picker is a page somebody can reload, and without this
 * a refresh would cost them their password.
 */
export async function organisations(req: Request, res: Response): Promise<void> {
  const choices = await authService.organisationChoices(tokenOf(req));
  if (!choices) throw unauthenticated();
  res.status(200).json({ choices });
}

/**
 * Name an organisation, as somebody who already has an account.
 *
 * REACHABLE WITH A SESSION THAT HAS NO MEMBERSHIP, which is the whole point —
 * it is the state social sign-in leaves a brand-new person in, and the only way
 * out of it besides an invitation.
 */
export async function createOrganisation(req: Request, res: Response): Promise<void> {
  const { name } = body<{ name: string }>(req);
  const result = await authService.createOrganisation({
    token: tokenOf(req),
    name,
    context: contextOf(req),
  });

  if (!result) throw unauthenticated();

  // The old session named no membership, so it is replaced rather than reused.
  setSessionCookie(res, result.token);

  res.status(201).json({
    token: result.token,
    organisation: presentOrganisation(result.organisation),
    membership: presentMembership(result.membership),
  });
}

export async function logout(req: Request, res: Response): Promise<void> {
  await authService.logout(tokenOf(req));
  res.clearCookie(authConfig.cookie.name, authConfig.cookie);
  res.status(204).end();
}

/** Where else this person is signed in. The current one says so. */
export async function sessions(req: Request, res: Response): Promise<void> {
  res.status(200).json({ sessions: await authService.sessions(tokenOf(req)) });
}

/**
 * End one of them.
 *
 * ENDING THE ONE IN YOUR HAND CLEARS THE COOKIE TOO, because the alternative is
 * a browser holding a cookie for a session the server has already forgotten,
 * which reads as "it signed me out at random" on the next page load.
 */
export async function endSession(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const outcome = await authService.endSession(tokenOf(req), id);
  if (outcome.wasCurrent) res.clearCookie(authConfig.cookie.name, authConfig.cookie);
  res.status(200).json(outcome);
}

/** Everything the client needs to draw the shell for the signed-in member. */
export async function me(req: Request, res: Response): Promise<void> {
  const auth = req.auth!;
  res.status(200).json({
    user: presentUser(auth.user),
    membership: presentMembership(auth.membership),
    organisation: presentOrganisation(auth.organisation),
    capabilities: auth.capabilities,
    session: presentSession(auth.session),
    mfaEnrolled: await mfaService.hasConfirmedFactor(auth.user.id),
  });
}

/**
 * Satisfying MFA on an existing session.
 *
 * SEPARATE FROM LOGIN because the session exists before this succeeds — it is
 * issued, it is real, and `requireAuth` refuses it while the organisation
 * requires a factor the session has not satisfied. Folding it into login would
 * mean holding a half-authenticated state somewhere outside the session table,
 * which is a second place for a session to live.
 */
export async function satisfyMfa(req: Request, res: Response): Promise<void> {
  const { code } = body<schema.SatisfyMfaBody>(req);
  const token = tokenOf(req);

  const identity = await authService.authenticate(token).catch(() => null);
  if (!identity) {
    throw unauthenticated();
  }

  const satisfied = await mfaService.satisfy({
    userId: identity.user.id,
    sessionId: identity.session.id,
    code,
  });

  if (!satisfied) {
    throw invalid({ message: 'That code is not right, or it has expired.', code: 'invalid.mfa_code' });
  }

  res.status(200).json({ mfaSatisfied: true });
}
