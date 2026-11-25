// The auth service (spec 55, 60): password login with lockout and rate limits, sessions,
// MFA by TOTP through the credential service, password resets and invitations, federated
// sign-in by OIDC and SAML (the credential service holds and verifies the providers).

import { keysWithoutTtlGauge } from '../../infra/signals.infra.ts';
import { domainController } from '../../controllers/auth/domain.controller.ts';
import { addDomain, listDomains, removeDomain, verifyDomain } from '../../contracts/auth/domain.contract.ts';
import { systemTxtResolver, type TxtResolver } from '../../infra/dns.infra.ts';
import { signupController } from '../../controllers/auth/signup.controller.ts';
import { completeSignup, startSignup } from '../../contracts/auth/signup.contract.ts';
import { sendSignupEmail } from '../../contracts/notify/authEmail.contract.ts';
import { allocateSeatPool, assignSeat, listSeats, releaseSeat, unassignSeat } from '../../contracts/auth/seats.contract.ts';
import { seatsController } from '../../controllers/auth/seats.controller.ts';
import { acceptInvitation, createInvitation } from '../../contracts/auth/invitation.contract.ts';
import { issueClientSession, resolveClientSession } from '../../contracts/auth/clientSession.contract.ts';
import { issueSyntheticSession, provisionSyntheticTenant } from '../../contracts/auth/synthetic.contract.ts';
import {
  confirmTotpEnrolment, listIdentities, listMfaFactors, removeMfaFactor, startTotpEnrolment, unlinkIdentity, verifyMfa,
} from '../../contracts/auth/mfa.contract.ts';
import { accountController } from '../../controllers/auth/account.controller.ts';
import { requestPasswordReset, resetPassword } from '../../contracts/auth/password.contract.ts';
import {
  createScimGroupMapping, issueScimToken, listScimGroups, listScimTokens, removeScimGroupMapping, revokeScimToken, scimRequest,
} from '../../contracts/auth/scim.contract.ts';
import { listMyMemberships, login, readOwnProfile, resolveSession, revokeSession, switchMembership } from '../../contracts/auth/session.contract.ts';
import {
  completeOidcSignIn, completeSamlSignIn, configureIdentityProvider, listIdentityProviders, listSignInOptions, readIdentityProviderConfig,
  beginSingleLogout, readSamlMetadata, receiveSamlLogoutMessage, receiveSamlResponse, startSso, startSsoLink,
} from '../../contracts/auth/sso.contract.ts';
import type { CallInput } from '../../contracts/endpoint.contract.ts';
import { sendAuthEmail } from '../../contracts/notify/authEmail.contract.ts';
import { authController } from '../../controllers/auth/auth.controller.ts';
import { scimController } from '../../controllers/auth/scim.controller.ts';
import { webauthnController } from '../../controllers/auth/webauthn.controller.ts';
import {
  changePassword, confirmWebauthnRegistration, startWebauthnAssertion, startWebauthnRegistration, verifyWebauthnAssertion,
} from '../../contracts/auth/webauthn.contract.ts';
import { ssoController } from '../../controllers/auth/sso.controller.ts';
import { createDirectoryRegistrar } from '../../services/auth/directory.service.ts';
import { directoryRetryWorker } from '../../workers/auth/directoryRetry.worker.ts';
import { createBreachList } from '../../infra/breachList.infra.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import type { AuthDeps, InvitationDelivery, ResetDelivery, SignupDelivery } from '../../services/auth/deps.service.ts';
import { createGuard } from '../../services/auth/guard.service.ts';
import { createSessions } from '../../services/auth/sessions.service.ts';
import { base64url, randomBytes } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { PasswordHasher } from '../../utils/password.util.ts';

export interface AuthOptions {
  /** Where reset and invitation links go. Default: the notify service. */
  resetDelivery?: ResetDelivery;
  invitationDelivery?: InvitationDelivery;
  signupDelivery?: SignupDelivery;
  /** DNS TXT lookups for domain verification. Default: the system resolver. */
  dns?: TxtResolver;
}

export function createAuthService(options: AuthOptions = {}): ServiceDefinition {
  return defineService({
    name: 'auth',
    needs: { postgres: ['control'], redis: ['session', 'data'] },
    async create(deps) {
      const { config, logger } = deps;
      const identifierKey = config.security.identifierHashKey;
      if (identifierKey === undefined) throw new AppError('configuration', 'auth needs IDENTIFIER_HASH_KEY', { code: 'config.security' });
      const hasher = new PasswordHasher(config.security.argon2, config.security.argon2Limits, (durationMs) => {
        logger.debug('password hashed', { event: 'password.hashed', durationMs });
      });
      const decoyHash = await hasher.hash(base64url(randomBytes(24)));
      const sessions = createSessions({ config, databases: deps.databases, store: deps.redis.session!, logger });
      // Keys without a TTL in redis-session and redis-data page (13.2; D252).
      deps.signals.gauge('redis_session_keys_without_ttl', keysWithoutTtlGauge(() => deps.redis.session!.auditKeys()));
      deps.signals.gauge('redis_data_keys_without_ttl', keysWithoutTtlGauge(() => deps.redis.data!.auditKeys()));
      // The links go to the notify service over mTLS, with the token for that one email. A
      // failure is logged, never returned: a reset request answers the same whether or not
      // the account exists, and an invitation is already stored (it can be revoked and sent
      // again). The token cannot be resent later, because nothing keeps it.
      const viaNotify = async (organisationId: string, body: CallInput<typeof sendAuthEmail>['body'], reason: string, correlationId: string)
        : Promise<void> => {
        try {
          await deps.services.call(sendAuthEmail, { body }, { request: { organisationId }, correlationId });
        } catch (error) {
          logger.failure('an auth email could not be handed to notify', error, { event: `${reason}.undelivered`, organisationId });
        }
      };
      // Not awaited: a reset request must take as long whether or not the account exists
      // (spec 55.3), and waiting on the mail relay would make a real account slower.
      const resetDelivery: ResetDelivery = options.resetDelivery ?? {
        async deliver(reset) {
          void viaNotify(reset.organisationId,
            { kind: 'password_reset', to: reset.email, token: reset.token, expiresAt: reset.expiresAt }, 'password_reset', reset.correlationId);
        },
      };
      const invitationDelivery: InvitationDelivery = options.invitationDelivery ?? {
        deliver: (invitation) => viaNotify(invitation.organisationId, {
          kind: 'invitation', to: invitation.email, token: invitation.token, expiresAt: invitation.expiresAt, invitationId: invitation.invitationId,
        }, 'invitation', invitation.correlationId),
      };
      // There is no organisation yet: notify's sign-up email takes no organisation context.
      const signupDelivery: SignupDelivery = options.signupDelivery ?? {
        async deliver(signup) {
          try {
            await deps.services.call(sendSignupEmail, {
              body: { to: signup.email, token: signup.token, expiresAt: signup.expiresAt, organisationName: signup.organisationName },
            }, { correlationId: signup.correlationId });
          } catch (error) {
            logger.failure('a sign-up email could not be handed to notify', error, { event: 'signup.undelivered' });
          }
        },
      };
      const directory = createDirectoryRegistrar({ config, services: deps.services, logger, databases: deps.databases });
      const authDeps: AuthDeps = {
        config, databases: deps.databases, logger, hasher, decoyHash, breachList: createBreachList(config.security.breachListDir),
        guard: createGuard(identifierKey, deps.redis.data!), sessions, services: deps.services, resetDelivery, invitationDelivery, signupDelivery,
        dns: options.dns ?? systemTxtResolver,
        flows: deps.redis.data!, directory,
      };
      const controller = authController(authDeps);
      const federation = ssoController(authDeps);
      const provisioning = scimController(authDeps);
      const keys = webauthnController(authDeps);
      const seats = seatsController(authDeps);
      const account = accountController(authDeps);
      const signups = signupController(authDeps);
      const domains = domainController(authDeps);
      return {
        // Registrations the directory missed, tried again (D69); none where the cell has no directory.
        workers: directory.enabled ? [directoryRetryWorker(directory, (config.sso?.directoryRetrySeconds ?? 300) * 1000, logger)] : [],
        routes: [
          route(login, controller.login),
          route(resolveSession, controller.resolveSession),
          route(revokeSession, controller.revokeSession),
          route(verifyMfa, controller.verifyMfa),
          route(startTotpEnrolment, controller.startTotpEnrolment),
          route(confirmTotpEnrolment, controller.confirmTotpEnrolment),
          route(requestPasswordReset, controller.requestPasswordReset),
          route(resetPassword, controller.resetPassword),
          route(createInvitation, controller.createInvitation),
          route(acceptInvitation, controller.acceptInvitation),
          route(listSignInOptions, federation.listSignInOptions),
          route(startSso, federation.startSso),
          route(startSsoLink, federation.startSsoLink),
          route(completeOidcSignIn, federation.completeOidcSignIn),
          route(receiveSamlResponse, federation.receiveSamlResponse),
          route(completeSamlSignIn, federation.completeSamlSignIn),
          route(readSamlMetadata, federation.readSamlMetadata), route(beginSingleLogout, federation.beginSingleLogout),
          route(receiveSamlLogoutMessage, federation.receiveSamlLogoutMessage),
          route(listIdentityProviders, federation.listIdentityProviders),
          route(readIdentityProviderConfig, federation.readIdentityProviderConfig),
          route(configureIdentityProvider, federation.configureIdentityProvider),
          route(startSignup, signups.startSignup), route(completeSignup, signups.completeSignup),
          route(listDomains, domains.listDomains), route(addDomain, domains.addDomain), route(verifyDomain, domains.verifyDomain),
          route(removeDomain, domains.removeDomain),
          route(scimRequest, provisioning.scimRequest),
          route(listScimGroups, provisioning.listScimGroups),
          route(createScimGroupMapping, provisioning.createScimGroupMapping),
          route(removeScimGroupMapping, provisioning.removeScimGroupMapping),
          route(issueScimToken, provisioning.issueScimToken),
          route(listScimTokens, provisioning.listScimTokens),
          route(revokeScimToken, provisioning.revokeScimToken),
          route(startWebauthnRegistration, keys.startWebauthnRegistration),
          route(confirmWebauthnRegistration, keys.confirmWebauthnRegistration),
          route(startWebauthnAssertion, keys.startWebauthnAssertion),
          route(verifyWebauthnAssertion, keys.verifyWebauthnAssertion),
          route(changePassword, keys.changePassword),
          route(listSeats, seats.listSeats), route(assignSeat, seats.assignSeat), route(unassignSeat, seats.unassignSeat),
          route(releaseSeat, seats.releaseSeat), route(allocateSeatPool, seats.allocateSeatPool),
          route(readOwnProfile, account.readOwnProfile), route(listMyMemberships, account.listMyMemberships), route(switchMembership, account.switchMembership),
          route(listMfaFactors, account.listMfaFactors), route(removeMfaFactor, account.removeMfaFactor),
          route(listIdentities, account.listIdentities), route(unlinkIdentity, account.unlinkIdentity),
          route(issueClientSession, account.issueClientSession), route(resolveClientSession, account.resolveClientSession),
          route(provisionSyntheticTenant, account.provisionSyntheticTenant), route(issueSyntheticSession, account.issueSyntheticSession),
        ],
      };
    },
  });
}

export const service = createAuthService();
