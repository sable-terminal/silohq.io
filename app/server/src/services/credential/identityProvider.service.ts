// Identity providers in the mediator (spec 55.5, 61.3; design: iam.identity_providers).
//
// The configuration is sealed as one JSON document (kind, settings, the OIDC client
// secret, who configured it) with its own DEK, bound to the row (id, organisation, kind).
// It is opened only inside withOpened, and each open is a ledger row in the same
// transaction as nothing else: idp to configure or start a sign-in, sso_assert to verify
// an answer, with the outcome either way.
//
// Verification is the libraries' (decision 2026-11-02, "never hand-write SAML XML
// signature verification"):
// - openid-client does discovery (the issuer in the document must be the one configured),
//   the PKCE code exchange with the client secret, and the ID token checks: signature by
//   the provider's published keys (its non-repudiation checks, on: by default it trusts
//   the token endpoint's TLS instead), issuer, audience, nonce, expiry. Its HTTP goes
//   through the cell's egress (public addresses, HTTPS), as every outbound request does.
// - @node-saml checks the signature on the assertion or the response (any of the
//   configured certificates, so a rollover overlaps), the issuer, the audience, the
//   recipient, the validity window, and that InResponseTo is the request auth started.
// What is ours: reading the configured claims into a subject, an address and names, and
// refusing an answer that lacks them. Errors carry no remote text.

import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import * as oidc from 'openid-client';
import { randomBytes } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type {
  completeFederatedSignIn, FederatedIdentity, IdentityProviderView, OidcSettings, readServiceProviderMetadata, receiveSamlLogout, SamlSettings,
  startFederatedSignIn, startSamlLogout, storeIdentityProvider,
} from '../../contracts/credential/identityProvider.contract.ts';
import type { ParsedInput } from '../../contracts/endpoint.contract.ts';
import { oidcFetch, type Egress } from '../../infra/egress.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { IdentityProvider } from '../../models/iam/identityProvider.model.ts';
import { credentialUnwrapRepo, identityProviderRepo } from '../../repos/iam/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { seal, sealBindings, withOpened, type DekCache, type KeyRing } from '../../utils/envelope.util.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import type { Caller } from './connectionCredential.service.ts';

type Stored =
  | { v: 1; kind: 'oidc'; settings: OidcSettings; clientSecret?: string; configuredBy: string | null }
  | { v: 1; kind: 'saml'; settings: SamlSettings; configuredBy: string | null };

type StoreBody = ParsedInput<typeof storeIdentityProvider>['body'];
type StartBody = ParsedInput<typeof startFederatedSignIn>['body'];
type CompleteBody = ParsedInput<typeof completeFederatedSignIn>['body'];

/** The cell's SAML SP key pair, and the next during a rotation (decision 2026-11-14). */
export interface SpKeys {
  privateKey: string;
  certificate: string;
  next?: { privateKey: string; certificate: string } | undefined;
}

export interface IdentityProviderDeps {
  /** Absent: requests go unsigned and encrypted assertions cannot be read. */
  sp?: SpKeys | undefined;
  keys: KeyRing;
  cache: DekCache;
  databases: Databases;
  egress: Egress;
  logger: Logger;
  /** Development and tests only: providers on plain HTTP (CONNECT_EGRESS_ALLOW_HTTP). */
  allowInsecureRequests: boolean;
  now?: () => number;
}

export interface IdentityProviders {
  store(caller: Caller, providerId: string, body: StoreBody): Promise<{ providerId: string; kind: 'oidc' | 'saml'; version: number; active: boolean }>;
  read(caller: Caller, providerId: string): Promise<IdentityProviderView>;
  start(caller: Caller, providerId: string, body: StartBody): Promise<{ redirectUrl: string }>;
  metadata(body: ParsedInput<typeof readServiceProviderMetadata>['body']): { xml: string; signed: boolean };
  logoutStart(caller: Caller, providerId: string, body: ParsedInput<typeof startSamlLogout>['body']): Promise<{ redirectUrl: string | null }>;
  logoutReceive(caller: Caller, providerId: string, body: ParsedInput<typeof receiveSamlLogout>['body'])
    : Promise<{ kind: 'request'; nameId: string; sessionIndex: string | null; responseUrl: string } | { kind: 'response'; success: boolean }>;
  complete(caller: Caller, providerId: string, body: CompleteBody): Promise<FederatedIdentity>;
}

const notFound = (): AppError => new AppError('not_found', 'no such identity provider', { code: 'sso.provider_unknown' });
const invalidAnswer = (reason: string): AppError =>
  new AppError('unauthenticated', 'the identity provider\'s answer could not be verified', { code: 'sso.assertion_invalid', details: { reason } });

const DISCOVERY_TTL_MS = 10 * 60_000;

const clientAuthOf = (settings: OidcSettings, secret: string | undefined): oidc.ClientAuth => {
  if (settings.clientAuth === 'none') return oidc.None();
  if (secret === undefined) throw new AppError('configuration', 'this provider needs its client secret', { code: 'sso.client_secret_missing' });
  return settings.clientAuth === 'client_secret_post' ? oidc.ClientSecretPost(secret) : oidc.ClientSecretBasic(secret);
};

const stringClaim = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** The configured claims into an identity; a subject the provider did not give is refused. */
export function identityFromClaims(claims: Record<string, unknown>, settings: OidcSettings, configuredBy: string | null): FederatedIdentity {
  const parts = settings.subjectClaims.map((name) => stringClaim(claims[name]));
  if (parts.some((part) => part === null)) throw invalidAnswer('subject_missing');
  const subject = parts.join(':');
  if (subject.length > 512) throw invalidAnswer('subject_too_long');
  const email = stringClaim(claims[settings.emailClaim]);
  const verifiedClaim = settings.emailVerifiedClaim === null ? true : claims[settings.emailVerifiedClaim];
  const emailVerified = email !== null && (verifiedClaim === true || verifiedClaim === 'true');
  const amr = Array.isArray(claims['amr']) ? claims['amr'].filter((v): v is string => typeof v === 'string') : [];
  return {
    subject,
    email: email !== null && email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null,
    emailVerified,
    firstName: stringClaim(claims[settings.givenNameClaim])?.slice(0, 200) ?? null,
    lastName: stringClaim(claims[settings.familyNameClaim])?.slice(0, 200) ?? null,
    mfa: settings.trustProviderMfa && amr.some((value) => settings.mfaAmrValues.includes(value)),
    configuredBy,
  };
}

const attribute = (profile: Profile, name: string): string | null => {
  const value = profile[name];
  const first = Array.isArray(value) ? value[0] : value;
  return stringClaim(first);
};

/** The verified profile's configured attributes into an identity. The NameID is the subject. */
export function identityFromProfile(profile: Profile, settings: SamlSettings, configuredBy: string | null): FederatedIdentity {
  const subject = stringClaim(profile.nameID);
  if (subject === null || subject.length > 512) throw invalidAnswer('subject_missing');
  if (settings.nameIdFormat !== 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified' && profile.nameIDFormat !== settings.nameIdFormat) {
    throw invalidAnswer('name_id_format');
  }
  const email = attribute(profile, settings.emailAttribute) ?? stringClaim(profile.email) ?? stringClaim(profile.mail);
  // The library verified the assertion; this only reads the context class it carries.
  const contexts = [...(profile.getAssertionXml?.() ?? '').matchAll(/<(?:[A-Za-z0-9_]+:)?AuthnContextClassRef>\s*([^<\s]+)\s*</g)]
    .map((match) => match[1]!);
  return {
    subject,
    email: email !== null && email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null,
    emailVerified: email !== null && settings.emailsVerified,
    firstName: attribute(profile, settings.givenNameAttribute)?.slice(0, 200) ?? null,
    lastName: attribute(profile, settings.familyNameAttribute)?.slice(0, 200) ?? null,
    mfa: settings.trustProviderMfa && contexts.some((context) => settings.mfaAuthnContexts.includes(context)),
    configuredBy,
  };
}

/** A one-request cache: InResponseTo is valid exactly when it is the request auth started. */
function expecting(requestId: string): CacheProvider {
  return {
    saveAsync: async (_key, value) => ({ value, createdAt: Date.now() }),
    getAsync: async (key) => (key === requestId ? new Date().toISOString() : null),
    removeAsync: async (key) => key,
  };
}

function samlFor(settings: SamlSettings, sp: { acsUrl: string; spEntityId: string; sloUrl?: string | undefined }, requestId: string,
  keys?: { privateKey: string; decryptionPvk: string } | undefined): SAML {
  return new SAML({
    // Signed requests, and encrypted assertions decrypted, with the cell's SP key (spec 55.5).
    ...(keys === undefined ? {} : { privateKey: keys.privateKey, decryptionPvk: keys.decryptionPvk, signatureAlgorithm: 'sha256' as const }),
    logoutUrl: settings.sloUrl ?? settings.ssoUrl,
    ...(sp.sloUrl === undefined ? {} : { logoutCallbackUrl: sp.sloUrl }),
    entryPoint: settings.ssoUrl,
    issuer: sp.spEntityId,
    audience: sp.spEntityId,
    callbackUrl: sp.acsUrl,
    idpIssuer: settings.entityId,
    idpCert: settings.signingCertificates,
    identifierFormat: settings.nameIdFormat,
    wantAssertionsSigned: settings.wantAssertionsSigned,
    wantAuthnResponseSigned: settings.wantResponseSigned,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 30 * 60_000,
    cacheProvider: expecting(requestId),
    generateUniqueId: () => requestId,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 60_000,
    maxAssertionAgeMs: 10 * 60_000,
  });
}

export function createIdentityProviders(deps: IdentityProviderDeps): IdentityProviders {
  const control = deps.databases.pool('control');
  const now = deps.now ?? Date.now;
  const fetch = oidcFetch(deps.egress);
  const discovered = new Map<string, { at: number; server: oidc.ServerMetadata }>();

  const binding = (row: Pick<IdentityProvider, 'id' | 'organisationId' | 'kind'>) =>
    sealBindings.identityProvider({ id: row.id, organisationId: row.organisationId, kind: row.kind });

  const load = async (caller: Caller, providerId: string): Promise<IdentityProvider> => {
    const row = await inTransaction(control, caller.request, (db) => identityProviderRepo.findById(db, providerId));
    if (!row) throw notFound();
    return row;
  };

  // Opens the configuration for use, and records the open whatever happens.
  const opened = async <T>(caller: Caller, row: IdentityProvider, reason: 'idp' | 'sso_assert', use: (stored: Stored) => Promise<T>): Promise<T> => {
    let outcome: 'ok' | 'failed' = 'failed';
    let dekCacheHit = false;
    try {
      const result = await withOpened(deps.keys, {
        ciphertext: row.metadataSealed, nonce: row.nonce, dekWrapped: row.dekWrapped, keyVersionId: row.keyVersionId,
      }, binding(row), async (plaintext) => {
        const stored = JSON.parse(plaintext.toString('utf8')) as Stored;
        outcome = 'ok';
        return use(stored);
      }, deps.cache);
      dekCacheHit = result.dekCacheHit;
      return result.value;
    } finally {
      await inTransaction(control, caller.request, (db) => credentialUnwrapRepo.insert(db, {
        organisationId: row.organisationId, identityProviderId: row.id, reason, callingService: caller.caller,
        correlationId: caller.correlationId, membershipId: caller.request.membershipId ?? null, keyVersionId: row.keyVersionId,
        dekCacheHit, outcome,
      }));
    }
  };

  const serverOf = async (issuer: string, clientId: string, auth: oidc.ClientAuth): Promise<oidc.ServerMetadata> => {
    const cached = discovered.get(issuer);
    if (cached && now() - cached.at < DISCOVERY_TTL_MS) return cached.server;
    let config: oidc.Configuration;
    try {
      config = await oidc.discovery(new URL(issuer), clientId, undefined, auth, {
        [oidc.customFetch]: fetch, execute: deps.allowInsecureRequests ? [oidc.allowInsecureRequests] : [],
      });
    } catch (error) {
      throw isAppError(error) ? error : new AppError('unavailable', 'the identity provider\'s discovery document could not be read', {
        code: 'sso.discovery_failed', retryable: true,
      });
    }
    const server = { ...config.serverMetadata() } as oidc.ServerMetadata;
    discovered.set(issuer, { at: now(), server });
    return server;
  };

  const configFor = async (issuer: string, settings: OidcSettings, secret: string | undefined): Promise<oidc.Configuration> => {
    const auth = clientAuthOf(settings, secret);
    const config = new oidc.Configuration(await serverOf(issuer, settings.clientId, auth), settings.clientId, undefined, auth);
    config[oidc.customFetch] = fetch;
    if (deps.allowInsecureRequests) oidc.allowInsecureRequests(config);
    // OIDC Core 3.1.3.7 lets a client skip the ID token's signature when it came straight
    // from the token endpoint over TLS; the library does so by default. Silo checks it
    // against the provider's published keys always, so a token is the provider's own and
    // not only the transport's.
    oidc.enableNonRepudiationChecks(config);
    return config;
  };

  const viewOf = (row: IdentityProvider, stored: Stored): IdentityProviderView => ({
    providerId: row.id, issuer: row.issuer, jitProvisioning: row.jitProvisioning, defaultRoleId: row.defaultRoleId,
    defaultScopeId: row.defaultScopeId, active: row.active, version: row.version, configuredBy: stored.configuredBy,
    config: stored.kind === 'oidc'
      ? { kind: 'oidc', settings: stored.settings, hasClientSecret: stored.clientSecret !== undefined }
      : { kind: 'saml', settings: stored.settings },
  });

  const write = async (db: Queryable, existing: IdentityProvider | undefined, caller: Caller, providerId: string, body: StoreBody,
    stored: Stored): Promise<IdentityProvider> => {
    const organisationId = caller.request.organisationId!;
    const plaintext = canonicalJsonBytes(stored);
    try {
      const sealed = await seal(deps.keys, plaintext, sealBindings.identityProvider({ id: providerId, organisationId, kind: body.config.kind }));
      const columns = {
        issuer: body.issuer, metadataSealed: sealed.ciphertext, nonce: sealed.nonce, dekWrapped: sealed.dekWrapped,
        keyVersionId: sealed.keyVersionId, jitProvisioning: body.jitProvisioning, defaultRoleId: body.defaultRoleId,
        defaultScopeId: body.defaultScopeId, active: body.active,
      };
      if (existing === undefined) {
        return await identityProviderRepo.insert(db, { id: providerId, organisationId, kind: body.config.kind, ...columns });
      }
      const updated = await identityProviderRepo.updateAtVersion(db, providerId, existing.version, columns);
      if (!updated) throw new AppError('conflict', 'the provider changed since it was read', { code: 'sso.provider_stale' });
      return updated;
    } finally {
      plaintext.fill(0);
    }
  };

  return {
    async store(caller, providerId, body) {
      const existing = await inTransaction(control, caller.request, (db) => identityProviderRepo.findById(db, providerId));
      if (existing === undefined && body.expectedVersion !== null) throw notFound();
      if (existing !== undefined) {
        if (body.expectedVersion !== existing.version) {
          throw new AppError('conflict', 'the provider changed since it was read', { code: 'sso.provider_stale' });
        }
        if (existing.kind !== body.config.kind) {
          throw new AppError('validation', 'a provider keeps its kind; configure a new one instead', { code: 'sso.kind_fixed' });
        }
      }
      let stored: Stored;
      if (body.config.kind === 'oidc') {
        let secret = body.config.clientSecret;
        if (secret === undefined && existing !== undefined) {
          secret = await opened(caller, existing, 'idp', async (old) => (old.kind === 'oidc' ? old.clientSecret : undefined));
        }
        if (secret === undefined && body.config.settings.clientAuth !== 'none') {
          throw new AppError('validation', 'this client authentication needs a client secret', { code: 'sso.client_secret_missing' });
        }
        stored = { v: 1, kind: 'oidc', settings: body.config.settings, configuredBy: body.configuredBy, ...(secret === undefined ? {} : { clientSecret: secret }) };
      } else {
        stored = { v: 1, kind: 'saml', settings: body.config.settings, configuredBy: body.configuredBy };
      }
      try {
        const row = await inTransaction(control, caller.request, (db) => write(db, existing, caller, providerId, body, stored));
        return { providerId: row.id, kind: row.kind, version: row.version, active: row.active };
      } catch (error) {
        const mapped = isAppError(error) ? error : fromDatabaseError(error);
        if (mapped.category === 'conflict' && mapped.code !== 'sso.provider_stale') {
          throw new AppError('conflict', 'another provider of this organisation has that issuer', { code: 'sso.issuer_taken' });
        }
        throw mapped;
      }
    },

    async read(caller, providerId) {
      const row = await load(caller, providerId);
      return opened(caller, row, 'idp', async (stored) => viewOf(row, stored));
    },

    async start(caller, providerId, body) {
      const row = await load(caller, providerId);
      if (!row.active) throw notFound();
      if (row.kind !== body.kind) throw new AppError('validation', 'the provider is of the other kind', { code: 'sso.kind_mismatch' });
      return opened(caller, row, 'idp', async (stored) => {
        if (stored.kind === 'oidc' && body.kind === 'oidc') {
          const config = await configFor(row.issuer, stored.settings, stored.clientSecret);
          const url = oidc.buildAuthorizationUrl(config, {
            redirect_uri: body.redirectUri, scope: stored.settings.scopes.join(' '), state: body.state, nonce: body.nonce,
            code_challenge: body.codeChallenge, code_challenge_method: 'S256',
          });
          return { redirectUrl: url.href };
        }
        if (stored.kind === 'saml' && body.kind === 'saml') {
          const saml = samlFor(stored.settings, body, body.requestId, keyPair());
          return { redirectUrl: await saml.getAuthorizeUrlAsync(body.relayState, undefined, {}) };
        }
        throw new AppError('integrity', 'the sealed configuration is not of the provider\'s kind', { code: 'sso.kind_mismatch' });
      });
    },

    async complete(caller, providerId, body) {
      const row = await load(caller, providerId);
      if (!row.active) throw notFound();
      if (row.kind !== body.kind) throw new AppError('validation', 'the provider is of the other kind', { code: 'sso.kind_mismatch' });
      return opened(caller, row, 'sso_assert', async (stored) => {
        if (stored.kind === 'oidc' && body.kind === 'oidc') {
          const config = await configFor(row.issuer, stored.settings, stored.clientSecret);
          const current = new URL(body.redirectUri);
          current.search = body.callbackQuery.startsWith('?') ? body.callbackQuery : `?${body.callbackQuery}`;
          let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
          try {
            tokens = await oidc.authorizationCodeGrant(config, current, {
              expectedState: body.expectedState, expectedNonce: body.expectedNonce, pkceCodeVerifier: body.codeVerifier, idTokenExpected: true,
            });
          } catch (error) {
            if (isAppError(error)) throw error;
            if (error instanceof oidc.AuthorizationResponseError) {
              throw new AppError('unauthenticated', 'the identity provider did not sign you in', { code: 'sso.provider_refused' });
            }
            deps.logger.warn('an OIDC answer was refused', { event: 'sso.oidc_refused', resourceType: 'identity_provider', resourceId: row.id });
            throw invalidAnswer('oidc');
          }
          const claims = tokens.claims();
          if (!claims) throw invalidAnswer('id_token_missing');
          return identityFromClaims(claims as Record<string, unknown>, stored.settings, stored.configuredBy);
        }
        if (stored.kind === 'saml' && body.kind === 'saml') {
          // An encrypted assertion is required where the configuration says so; @node-saml decrypts it.
          if (stored.settings.requireEncryptedAssertions && !encryptedAssertion(body.samlResponse)) {
            deps.logger.warn('a SAML answer was refused: its assertion is not encrypted', { event: 'sso.saml_unencrypted', resourceType: 'identity_provider', resourceId: row.id });
            throw invalidAnswer('saml_unencrypted');
          }
          let profile: Profile | null = null;
          let verified = false;
          // During a rotation the assertion may be encrypted to either certificate: the current key first, then the next.
          for (const keys of decryptionKeys()) {
            try {
              ({ profile } = await samlFor(stored.settings, body, body.expectedRequestId, keys).validatePostResponseAsync({ SAMLResponse: body.samlResponse, RelayState: body.relayState }));
              verified = true;
              break;
            } catch {
              continue;
            }
          }
          if (!verified) {
            deps.logger.warn('a SAML answer was refused', { event: 'sso.saml_refused', resourceType: 'identity_provider', resourceId: row.id });
            throw invalidAnswer('saml');
          }
          if (!profile) throw invalidAnswer('saml_logout');
          return {
            ...identityFromProfile(profile, stored.settings, stored.configuredBy),
            saml: { nameId: profile.nameID, nameIdFormat: profile.nameIDFormat, sessionIndex: profile.sessionIndex ?? null },
          };
        }
        throw new AppError('integrity', 'the sealed configuration is not of the provider\'s kind', { code: 'sso.kind_mismatch' });
      });
    },

    metadata(body) {
      // Generated by the library: no SAML XML written here (decision 2026-11-02).
      const saml = new SAML({ issuer: body.spEntityId, callbackUrl: body.acsUrl, ...(body.sloUrl === undefined ? {} : { logoutCallbackUrl: body.sloUrl }), idpCert: 'unused', wantAssertionsSigned: true,
        identifierFormat: null, ...(deps.sp === undefined ? {} : { privateKey: deps.sp.privateKey, decryptionPvk: deps.sp.privateKey, signatureAlgorithm: 'sha256' as const }) });
      const certs = deps.sp === undefined ? null : [deps.sp.certificate, ...(deps.sp.next === undefined ? [] : [deps.sp.next.certificate])];
      return { xml: saml.generateServiceProviderMetadata(deps.sp?.certificate ?? null, certs), signed: deps.sp !== undefined };
    },

    async logoutStart(caller, providerId, body) {
      const row = await load(caller, providerId);
      if (row.kind !== 'saml') throw new AppError('validation', 'single logout is SAML\'s', { code: 'sso.kind_mismatch' });
      return opened(caller, row, 'idp', async (stored) => {
        if (stored.kind !== 'saml' || stored.settings.sloUrl === undefined) return { redirectUrl: null };
        const saml = samlFor(stored.settings, body, `_${randomHex(16)}`, keyPair());
        const user = { issuer: stored.settings.entityId, nameID: body.nameId, nameIDFormat: body.nameIdFormat ?? stored.settings.nameIdFormat, ...(body.sessionIndex === undefined ? {} : { sessionIndex: body.sessionIndex }) };
        return { redirectUrl: await saml.getLogoutUrlAsync(user as Profile, body.relayState, {}) };
      });
    },

    async logoutReceive(caller, providerId, body) {
      const row = await load(caller, providerId);
      if (row.kind !== 'saml') throw new AppError('validation', 'single logout is SAML\'s', { code: 'sso.kind_mismatch' });
      return opened(caller, row, 'sso_assert', async (stored) => {
        if (stored.kind !== 'saml') throw new AppError('integrity', 'the sealed configuration is not of the provider\'s kind', { code: 'sso.kind_mismatch' });
        // A LogoutResponse answers a request this cell made: InResponseTo is not tracked across processes, so it is checked when present.
        const saml = new SAML({ ...samlOptions(stored.settings, body), validateInResponseTo: ValidateInResponseTo.never });
        const message = body.message;
        let result: { profile: Profile | null; loggedOut: boolean };
        try {
          if (message.binding === 'redirect') {
            const query = new URLSearchParams(message.query);
            result = await saml.validateRedirectAsync(Object.fromEntries(query.entries()), message.query);
          } else if (message.samlRequest !== undefined) {
            result = await saml.validatePostRequestAsync({ SAMLRequest: message.samlRequest, ...(message.relayState ? { RelayState: message.relayState } : {}) });
          } else if (message.samlResponse !== undefined) {
            result = await saml.validatePostResponseAsync({ SAMLResponse: message.samlResponse, ...(message.relayState ? { RelayState: message.relayState } : {}) });
          } else {
            throw invalidAnswer('saml_logout');
          }
        } catch {
          deps.logger.warn('a SAML logout message was refused', { event: 'sso.saml_logout_refused', resourceType: 'identity_provider', resourceId: row.id });
          throw invalidAnswer('saml_logout');
        }
        if (result.profile === null) return { kind: 'response' as const, success: result.loggedOut };
        const relayState = message.binding === 'redirect' ? new URLSearchParams(message.query).get('RelayState') ?? '' : message.relayState ?? '';
        const responseUrl = await samlFor(stored.settings, body, `_${randomHex(16)}`, keyPair()).getLogoutResponseUrlAsync(result.profile, relayState, {}, true);
        return { kind: 'request' as const, nameId: result.profile.nameID, sessionIndex: result.profile.sessionIndex ?? null, responseUrl };
      });
    },
  };

  /** The current key: requests are signed with it, assertions decrypted with it first. */
  function keyPair(): { privateKey: string; decryptionPvk: string } | undefined {
    return deps.sp === undefined ? undefined : { privateKey: deps.sp.privateKey, decryptionPvk: deps.sp.privateKey };
  }

  /** The keys an encrypted assertion may be read with: the current, then the next during a rotation; none without a pair. */
  function decryptionKeys(): ({ privateKey: string; decryptionPvk: string } | undefined)[] {
    if (deps.sp === undefined) return [undefined];
    return [keyPair(), ...(deps.sp.next === undefined ? [] : [{ privateKey: deps.sp.privateKey, decryptionPvk: deps.sp.next.privateKey }])];
  }

  /** The options shared by the logout messages, with the provider's certificates to verify them. */
  function samlOptions(settings: SamlSettings, sp: { acsUrl: string; spEntityId: string; sloUrl: string }) {
    return {
      entryPoint: settings.ssoUrl, issuer: sp.spEntityId, audience: sp.spEntityId, callbackUrl: sp.acsUrl, logoutCallbackUrl: sp.sloUrl,
      logoutUrl: settings.sloUrl ?? settings.ssoUrl, idpIssuer: settings.entityId, idpCert: settings.signingCertificates,
      identifierFormat: settings.nameIdFormat, wantAssertionsSigned: settings.wantAssertionsSigned, acceptedClockSkewMs: 60_000,
      ...(deps.sp === undefined ? {} : { privateKey: deps.sp.privateKey, decryptionPvk: deps.sp.privateKey, signatureAlgorithm: 'sha256' as const }),
    };
  }
}

/** Whether a SAML response carries an EncryptedAssertion and no plain Assertion: reading only, never verifying (the library does). */
function encryptedAssertion(samlResponse: string): boolean {
  let xml: string;
  try {
    xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const document = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, processEntities: false }).parse(xml) as Record<string, Record<string, unknown> | undefined>;
  const response = document['Response'];
  return response !== undefined && response['EncryptedAssertion'] !== undefined && response['Assertion'] === undefined;
}

const randomHex = (bytes: number): string => randomBytes(bytes).toString('hex');
