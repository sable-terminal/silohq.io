import { env } from '../config/env.config';
import { withoutTenant, withTransaction, actAsUser } from '../infra/db.infra';
import { wrapper } from '../infra/kms.infra';
import * as oidc from '../infra/oidc.infra';
import { runUntenanted, runWithTenant } from '../utils/tenantContext.util';
import { seal } from '../utils/envelope.util';
import { withSecret } from '../utils/mediator.util';
import { secretAccessLog } from '../utils/credentialAudit.util';
import { denial, invalid, upstream } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import {
  codeChallengeFor,
  createCodeVerifier,
  createNonce,
  createState,
  domainOf,
  safeReturnTo,
  TokenRejected,
  verifyIdToken,
} from '../utils/oidc.util';
import { clientSecretPurpose, type IdentityProvider } from '../models/sso.model';
import * as ssoRepo from '../repos/sso.repo';
import * as userRepo from '../repos/user.repo';
import * as membershipRepo from '../repos/membership.repo';
import * as sessionService from './session.service';
import { assertCan, authorityOf } from './authorisation.service';
import type { Actor } from './scope.service';
import { log } from './audit.service';

/**
 * Signing in with somebody else's directory.
 *
 * ── Why the flow looks like this ────────────────────────────────────────────
 *
 * THE ATTEMPT IS A ROW, NOT A COOKIE. A `state` the server does not remember is
 * a `state` the server cannot check — it can confirm the value came back
 * unchanged and nothing more. Holding it here binds the nonce, the PKCE verifier
 * and the provider to one attempt, and lets the attempt be consumed exactly
 * once, in the same statement that reads it.
 *
 * THE ENDPOINTS COME FROM THE ROW, NOT FROM DISCOVERY AT SIGN-IN TIME.
 * Re-reading the discovery document on every login would let a directory that
 * changes it silently redirect an existing tenant's sign-ins somewhere new.
 * Discovery runs once, when an administrator configures the provider.
 *
 * THE DOMAIN IS CHECKED AGAINST THE PROVIDER'S ALLOW-LIST AFTER VERIFICATION.
 * Without it, a customer who configures their own provider can mint a token for
 * any address they like — including one belonging to a member of a different
 * organisation — and be linked to that person's account.
 */

const ATTEMPT_TTL_MS = 10 * 60 * 1000;

/**
 * Where the directory sends the browser back.
 *
 * `API_URL`, NOT `APP_URL`, for the same reason as social sign-in: the code has
 * to be exchanged with a client secret that lives on this side, and the cookie
 * is set here. The first version pointed at the app, which serves no such route.
 */
export const redirectUri = (): string => `${env.API_URL}/api/sso/callback`;

async function openSecret(provider: IdentityProvider): Promise<string> {
  /*
   * §14.4 — THROUGH THE MEDIATOR. This returned the plaintext from a direct
   * `unseal`, which is the one shape `withSecret` exists to prevent: the
   * secret escapes the callback and nothing records that it was opened. An
   * identity provider belongs to an organisation, so this one can write the
   * same `credential_unwrapped` row a connector credential writes.
   */
  return withSecret(
    provider.clientSecret,
    { wrapper: wrapper(), log: secretAccessLog(provider.organisationId) },
    {
      reason: 'idp-metadata-load',
      subject: provider.id,
      additionalData: clientSecretPurpose(provider.id),
    },
    async (secret: string) => secret,
  );
}

/* ── Configuration, by an administrator ─────────────────────────────────── */

export async function configure(
  actor: Actor,
  input: { name: string; issuer: string; clientId: string; clientSecret: string; domains: string[] },
) {
  /*
   * DISCOVERY HAPPENS BEFORE THE TRANSACTION and its result is stored. Doing it
   * inside would hold a database transaction open across a network call to a
   * third party, which is how a slow provider becomes a lock nobody can explain.
   */
  const discovered = await oidc.discover(input.issuer).catch((error: unknown) => {
    throw upstream({
      message: error instanceof Error ? error.message : 'The provider could not be reached.',
      code: 'upstream.discovery',
    });
  });

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'sso.manage');

        const id = generateId();
        // Bound to the row: a sealed secret lifted into a different provider's
        // row will not open, so a database write cannot move a credential.
        const sealed = await seal(input.clientSecret, wrapper(), clientSecretPurpose(id));

        await ssoRepo.create(db, {
          id,
          organisationId: actor.organisationId,
          name: input.name,
          issuer: discovered.issuer,
          authorizationEndpoint: discovered.authorization_endpoint,
          tokenEndpoint: discovered.token_endpoint,
          jwksUri: discovered.jwks_uri,
          clientId: input.clientId,
          clientSecret: sealed,
          createdBy: actor.membershipId,
        });

        for (const domain of input.domains) {
          await ssoRepo.addDomain(db, { providerId: id, domain: domain.toLowerCase() });
        }

        await log(db, {
          event: 'provider_configured',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { providerId: id, issuer: discovered.issuer, domains: input.domains },
        });

        return { id, name: input.name, issuer: discovered.issuer, domains: input.domains };
      }),
  );
}

export async function list(actor: Actor) {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'sso.manage');

        // The secret is not selected, here or anywhere. There is no endpoint
        // that returns it: an administrator who needs a new one rotates it.
        return ssoRepo.listSummaries(db);
      }),
  );
}

/* ── Signing in ─────────────────────────────────────────────────────────── */

/**
 * Begin: find the directory for an address and build the redirect.
 *
 * NOTHING ABOUT THE ANSWER REVEALS WHETHER THE PERSON HAS AN ACCOUNT. The lookup
 * is by domain, not by user — an address at a configured domain gets a redirect
 * whether or not anybody by that name exists, which is what stops this becoming
 * a membership oracle for a customer's staff list.
 */
export async function begin(input: {
  email: string;
  returnTo?: string | null;
}): Promise<{ redirectTo: string } | null> {
  const domain = domainOf(input.email);
  if (!domain) return null;

  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const provider = await ssoRepo.findForDomain(db, domain);
      if (!provider) return null;

      const state = createState();
      const nonce = createNonce();
      const verifier = createCodeVerifier();

      await ssoRepo.createAttempt(db, {
        state,
        providerId: provider.id,
        nonce,
        codeVerifier: verifier,
        returnTo: safeReturnTo(input.returnTo),
        expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS),
      });

      const url = new URL(provider.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', provider.clientId);
      url.searchParams.set('redirect_uri', redirectUri());
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', codeChallengeFor(verifier));
      // S256 only. `plain` sends the verifier itself, which makes PKCE
      // decorative — anybody who can see the request can replay it.
      url.searchParams.set('code_challenge_method', 'S256');
      /*
       * `login_hint` SAVES A RETYPE AND NOTHING ELSE. It is never trusted: the
       * address that matters is the one in the verified token.
       */
      url.searchParams.set('login_hint', input.email);

      return { redirectTo: url.toString() };
    }),
  );
}

export interface SsoOutcome {
  token: string;
  returnTo: string | null;
  next: 'ready' | 'no-membership';
}

/**
 * Finish: verify what came back and turn it into a session.
 *
 * THE ORDER HERE IS THE SECURITY. The attempt is consumed first, so a replayed
 * callback finds nothing. The token's signature is verified before any claim is
 * read. The domain is checked against the provider's allow-list before the
 * address is used to find anybody. Only then does a session exist.
 */
export async function complete(input: { state: string; code: string }): Promise<SsoOutcome> {
  const attempt = await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      const spent = await ssoRepo.consumeAttempt(db, input.state);
      if (!spent) return null;

      const provider = await ssoRepo.findById(db, spent.providerId);
      return provider ? { ...spent, provider } : null;
    }),
  );

  if (!attempt) {
    /*
     * ONE ANSWER FOR UNKNOWN, EXPIRED AND ALREADY-USED. Telling them apart tells
     * somebody replaying a captured callback which of those it was.
     */
    throw invalid({
      message: 'That sign-in has expired or was already used. Start again.',
      code: 'invalid.sso_state',
    });
  }

  const provider = attempt.provider;
  const secret = await openSecret(provider);

  const tokens = await oidc.exchangeCode({
    tokenEndpoint: provider.tokenEndpoint,
    clientId: provider.clientId,
    clientSecret: secret,
    code: input.code,
    redirectUri: redirectUri(),
    codeVerifier: attempt.codeVerifier,
  });

  if (!tokens.id_token) {
    throw upstream({
      message: 'The identity provider returned no identity token.',
      code: 'upstream.no_id_token',
    });
  }

  let keys = await oidc.fetchJwks(provider.jwksUri);
  let claims;
  try {
    claims = verifyIdToken(tokens.id_token, {
      issuer: provider.issuer,
      audience: provider.clientId,
      nonce: attempt.nonce,
      keys,
    });
  } catch (error) {
    /*
     * A ROTATED SIGNING KEY LOOKS EXACTLY LIKE A FORGERY, so the key set is
     * refetched once before the token is rejected. Without it, every sign-in
     * fails for up to the cache lifetime each time a provider rotates — which
     * they do on their own schedule and do not announce.
     */
    if (error instanceof TokenRejected && error.reason === 'no matching signing key') {
      keys = await oidc.fetchJwks(provider.jwksUri, { force: true });
      claims = verifyIdToken(tokens.id_token, {
        issuer: provider.issuer,
        audience: provider.clientId,
        nonce: attempt.nonce,
        keys,
      });
    } else {
      throw denial({
        message: 'The identity provider’s response could not be trusted.',
        code: 'denial.sso_token',
        detail: { reason: error instanceof TokenRejected ? error.reason : 'unknown' },
      });
    }
  }

  const email = claims.email?.toLowerCase();
  if (!email) {
    throw denial({
      message: 'The identity provider did not tell us an email address.',
      code: 'denial.sso_no_email',
    });
  }

  const domain = domainOf(email);

  return runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => {
      /*
       * THE DOMAIN CHECK. A provider may only assert addresses at the domains it
       * was configured for. Without it, a customer's own directory can mint a
       * token for anybody's address and take over their account.
       */
      const allowed = await ssoRepo.domainIsAllowed(db, { providerId: provider.id, domain });

      if (!allowed) {
        throw denial({
          message: 'That address is not one this directory is allowed to sign in.',
          code: 'denial.sso_domain',
        });
      }

      // Linked before matched: the `sub` is stable and an address is not.
      let userId = await ssoRepo.findUserIdForSubject(db, {
        providerId: provider.id,
        subject: claims.sub,
      });

      if (!userId) {
        userId = (await userRepo.findByEmail(db, email))?.id ?? null;
      }

      if (!userId) {
        /*
         * JUST-IN-TIME PROVISIONING IS NOT DONE HERE. A verified token proves
         * who somebody is and says nothing about whether they should be a member
         * of this organisation — that is an invitation's job, and creating the
         * account automatically would let anybody at a configured domain join
         * themselves. They are told to ask for an invitation.
         */
        throw denial({
          message: 'You do not have a Silo account yet. Ask a colleague to invite you.',
          code: 'denial.sso_no_account',
        });
      }

      await actAsUser(db, userId);
      await ssoRepo.linkIdentity(db, {
        id: generateId(),
        userId,
        providerId: provider.id,
        subject: claims.sub,
        email,
      });

      const memberships = await membershipRepo.listForUser(db, userId);
      const membership = memberships.find(
        (m) => m.organisationId === provider.organisationId && m.status === 'active',
      );

      if (!membership) {
        throw denial({
          message: 'You are not an active member of that organisation.',
          code: 'denial.sso_not_a_member',
        });
      }

      await userRepo.markEmailVerified(db, userId);

      const { token } = await sessionService.issue({
        db,
        userId,
        activeMembershipId: membership.id,
        authMethod: 'sso',
        // A directory that asserted this person has already authenticated them,
        // to whatever standard the customer configured. Requiring our own second
        // factor on top is the thing SSO was bought to remove.
        mfaSatisfied: true,
      });

      await ssoRepo.actAsOrganisation(db, provider.organisationId);
      await log(db, {
        event: 'login',
        organisationId: provider.organisationId,
        membershipId: membership.id,
        userId,
        detail: { method: 'sso', providerId: provider.id },
      });

      return { token, returnTo: attempt.returnTo, next: 'ready' as const };
    }),
  );
}
