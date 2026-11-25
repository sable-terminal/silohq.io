// Federated sign-in (spec 55.5; design: iam.identity_providers, iam.user_identities, review
// D1). The credential service holds each provider's configuration and verifies its
// answers; this decides who the person is, and signs them in.
//
// The flow is bound to the browser that started it. startSso returns a binding the app
// keeps for the tab; auth stores only its hash, and the PKCE verifier is an HMAC of the
// state under the binding, so neither the flow store nor a stolen callback URL can finish
// the flow. Every flow, ticket and state is used once.
//
// Linking (review D1), never by address, because a provider's tenant admins can set any
// address (the Entra "nOAuth" class):
// - an existing link (provider, subject) names the user;
// - otherwise the flow proves one: an invitation (its token proved the address, and the
//   provider's verified address must be the invited one), the signed-in person linking
//   their own account (MFA complete), or just-in-time creation of a new person when the
//   provider allows it and no user in the cell has the address. When one does, the person
//   must sign in their usual way and link: nothing links silently.
// Just-in-time joining grants the provider's default role and scope only (spec 55.5), as
// granted by the member who configured the provider, under the delegation trigger.

import { grantAfterAssignment, seatOnJoin } from './seats.service.ts';
import type { z } from 'zod';
import type { SessionView } from '../../contracts/auth/session.contract.ts';
import {
  completeFederatedSignIn, readIdentityProvider, readServiceProviderMetadata, receiveSamlLogout as receiveSamlLogoutCredential, startFederatedSignIn,
  startSamlLogout, storeIdentityProvider, type FederatedIdentity, type IdentityProviderView,
} from '../../contracts/credential/identityProvider.contract.ts';
import type { receiveSamlLogoutMessage } from '../../contracts/auth/sso.contract.ts';
import { parseSessionToken } from '../../utils/token.util.ts';
import type { ParsedInput } from '../../contracts/endpoint.contract.ts';
import type { configureIdentityProvider } from '../../contracts/auth/sso.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { ssoFlowKeys, ssoTicketKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Organisation } from '../../models/iam/organisation.model.ts';
import {
  identityProviderRepo, invitationRepo, membershipRepo, mfaFactorRepo, organisationRepo, roleAssignmentRepo, scopeMembershipRepo,
  sessionRepo, userIdentityRepo, userRepo,
} from '../../repos/iam/index.repo.ts';
import type { PublicIdentityProvider } from '../../repos/iam/identityProvider.repo.ts';
import { base64url, constantTimeEqual, hmacSha256, randomBytes, sha256 } from '../../utils/crypto.util.ts';
import { normaliseEmail } from '../../utils/email.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { hashToken } from '../../utils/token.util.ts';
import { recordAuthEvent } from './authEvents.service.ts';
import type { AuthDeps } from './deps.service.ts';
import { asInviterRefusal, joinByInvitation, openInvitation } from './invitations.service.ts';
import { parseSamlMetadata } from './samlMetadata.service.ts';
import { mfaStateOf } from './sessions.service.ts';

type FlowRecord = z.infer<typeof ssoFlowKeys.schema>;
type Client = { address?: string | undefined; userAgent?: string | undefined } | undefined;
export type SignedIn = SessionView & { sessionToken: string };

const hex = (bytes: Buffer): string => bytes.toString('hex');
const handleOf = (organisationId: string): string => `${organisationId}.${base64url(randomBytes(32))}`;
const organisationOf = (handle: string): string => handle.slice(0, handle.indexOf('.'));

/** The PKCE verifier for a flow: an HMAC of its state under the browser's binding, so only that browser can finish it. */
export function codeVerifierOf(binding: string, state: string): string {
  return base64url(hmacSha256(Buffer.from(binding, 'utf8'), Buffer.from(`silo.sso.pkce.v1\u0000${state}`, 'utf8')));
}
const challengeOf = (verifier: string): string => base64url(sha256(Buffer.from(verifier, 'ascii')));

const expired = (): AppError =>
  new AppError('unauthenticated', 'this sign-in has expired or was already used; start again', { code: 'sso.flow_invalid' });
const notLinked = (): AppError =>
  new AppError('forbidden', 'this identity is not linked to anyone here; accept an invitation, or sign in and link it', { code: 'sso.not_linked' });

/** Where the app and the gateway are reached: the public origin (GATEWAY_PUBLIC_ORIGIN). */
export function ssoAddresses(deps: Pick<AuthDeps, 'config'>): { origin: string; oidcRedirectUri: string; acsUrl: string; spEntityId: string } {
  const origin = deps.config.gateway.publicOrigin;
  if (origin === undefined) {
    throw new AppError('configuration', 'SSO needs the public origin (GATEWAY_PUBLIC_ORIGIN)', { code: 'config.sso.origin' });
  }
  return {
    origin,
    oidcRedirectUri: deps.config.sso.oidcRedirectUri ?? `${origin}/sso/callback`,
    acsUrl: `${origin}/api/v1/sso/saml/acs`,
    spEntityId: deps.config.sso.samlEntityId ?? `${origin}/api/v1/sso/saml/metadata`,
  };
}

const summaryOf = (p: PublicIdentityProvider) => ({
  providerId: p.id, kind: p.kind, issuer: p.issuer, active: p.active, jitProvisioning: p.jitProvisioning,
  defaultRoleId: p.defaultRoleId, defaultScopeId: p.defaultScopeId, version: p.version,
});

// ----------------------------------------------------------------------------- configuration

async function demand(deps: AuthDeps, ctx: HandlerContext, permission: string): Promise<void> {
  const decision = await deps.services.call(authorise, { body: { permission } }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow') {
    throw new AppError('forbidden', 'you may not manage this organisation\'s sign-in', { code: 'auth.not_permitted', details: { reason: decision.reason } });
  }
}

export async function listProviders(deps: AuthDeps, ctx: HandlerContext) {
  await demand(deps, ctx, 'org.sso.manage');
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request, (db) =>
    identityProviderRepo.listPublic(db, ctx.request.organisationId!));
  return { providers: rows.map(summaryOf) };
}

export async function readProvider(deps: AuthDeps, ctx: HandlerContext, providerId: string): Promise<IdentityProviderView> {
  await demand(deps, ctx, 'org.sso.manage');
  return deps.services.call(readIdentityProvider, { params: { providerId } }, { request: ctx.request, correlationId: ctx.correlationId });
}

export async function configureProvider(deps: AuthDeps, ctx: HandlerContext, providerId: string,
  body: ParsedInput<typeof configureIdentityProvider>['body']): Promise<IdentityProviderView> {
  await demand(deps, ctx, 'org.sso.manage');
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined) throw new AppError('forbidden', 'a provider is configured by a member', { code: 'auth.not_permitted' });
  const control = deps.databases.pool('control');
  const before = await inTransaction(control, ctx.request, (db) => identityProviderRepo.listPublic(db, ctx.request.organisationId!));
  let config: Parameters<typeof deps.services.call<typeof storeIdentityProvider>>[1]['body']['config'];
  let issuer: string;
  if (body.config.kind === 'oidc') {
    issuer = body.config.issuer;
    config = { kind: 'oidc', settings: body.config.settings, ...(body.config.clientSecret === undefined ? {} : { clientSecret: body.config.clientSecret }) };
  } else {
    if ((body.config.settings === undefined) === (body.config.metadataXml === undefined)) {
      throw new AppError('validation', 'give the SAML settings or the provider\'s metadata, one of them', { code: 'sso.saml_settings_required' });
    }
    const settings = body.config.settings ?? { ...parseSamlMetadata(body.config.metadataXml!), ...(body.config.overrides ?? {}) };
    issuer = settings.entityId;
    config = { kind: 'saml', settings };
  }
  const stored = await deps.services.call(storeIdentityProvider, {
    params: { providerId },
    body: {
      issuer, jitProvisioning: body.jitProvisioning, defaultRoleId: body.defaultRoleId, defaultScopeId: body.defaultScopeId,
      active: body.active, expectedVersion: body.expectedVersion, configuredBy: membershipId, config,
    },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  await inTransaction(control, ctx.request, (db) => recordAuthEvent(db, {
    organisationId: ctx.request.organisationId!, correlationId: ctx.correlationId, event: 'provider_configured', membershipId,
    detail: { provider_id: stored.providerId, kind: stored.kind, active: stored.active, created: !before.some((p) => p.id === providerId) },
  }));
  return readProvider(deps, ctx, providerId);
}

// ----------------------------------------------------------------------------- sign-in options

export async function signInOptions(deps: AuthDeps, organisationSlug: string) {
  const control = deps.databases.pool('control');
  const organisation = await inTransaction(control, {}, (db) => organisationRepo.findForLogin(db, organisationSlug));
  if (!organisation || organisation.status !== 'active') return { ssoRequired: false, providers: [] };
  const providers = await inTransaction(control, { organisationId: organisation.id }, (db) =>
    identityProviderRepo.listPublic(db, organisation.id));
  return {
    ssoRequired: organisation.ssoRequired,
    providers: providers.filter((p) => p.active).map((p) => ({ providerId: p.id, kind: p.kind })),
  };
}

// ----------------------------------------------------------------------------- start

export interface StartInput {
  organisationSlug: string;
  providerId: string;
  invitationToken?: string | undefined;
}

const unknownProvider = (): AppError => new AppError('not_found', 'no such provider', { code: 'sso.provider_unknown' });

export async function startSso(deps: AuthDeps, input: StartInput, correlationId: string)
  : Promise<{ redirectUrl: string; binding: string; expiresAt: string }> {
  const control = deps.databases.pool('control');
  const organisation = await inTransaction(control, {}, (db) => organisationRepo.findForLogin(db, input.organisationSlug));
  if (!organisation || organisation.status !== 'active') throw unknownProvider();
  return begin(deps, organisation.id, input.providerId, { invitationToken: input.invitationToken }, correlationId);
}

/** The signed-in person links a provider identity to their own account; the gateway sent a complete session's context. */
export async function startLink(deps: AuthDeps, ctx: HandlerContext, providerId: string)
  : Promise<{ redirectUrl: string; binding: string; expiresAt: string }> {
  const { organisationId, userId } = ctx.request;
  if (organisationId === undefined || userId === undefined) {
    throw new AppError('forbidden', 'linking is for a signed-in person', { code: 'auth.not_permitted' });
  }
  return begin(deps, organisationId, providerId, { linkUserId: userId }, ctx.correlationId);
}

async function begin(deps: AuthDeps, organisationId: string, providerId: string,
  purposeOf: { invitationToken?: string | undefined; linkUserId?: string | undefined }, correlationId: string)
  : Promise<{ redirectUrl: string; binding: string; expiresAt: string }> {
  const addresses = ssoAddresses(deps);
  const control = deps.databases.pool('control');
  const provider = (await inTransaction(control, { organisationId }, (db) => identityProviderRepo.listPublic(db, organisationId)))
    .find((p) => p.id === providerId && p.active);
  if (!provider) throw unknownProvider();

  let purpose: FlowRecord['purpose'] = 'sign_in';
  let linkUserId: string | undefined;
  let invitationId: string | undefined;
  if (purposeOf.linkUserId !== undefined) {
    purpose = 'link';
    linkUserId = purposeOf.linkUserId;
  } else if (purposeOf.invitationToken !== undefined) {
    const input = { invitationToken: purposeOf.invitationToken };
    const invitation = openInvitation(await inTransaction(control, { organisationId }, (db) =>
      invitationRepo.findByTokenHash(db, { organisationId, tokenHash: hashToken(input.invitationToken!) })));
    if (!invitation) throw new AppError('unauthenticated', 'this invitation is not valid; ask for a new one', { code: 'auth.invitation_invalid' });
    purpose = 'invitation';
    invitationId = invitation.id;
  }

  const state = handleOf(organisationId);
  const binding = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const samlRequestId = `_${hex(randomBytes(32))}`;
  const flow: FlowRecord = {
    providerId: provider.id, kind: provider.kind, bindingHash: hex(sha256(Buffer.from(binding, 'utf8'))), purpose,
    ...(provider.kind === 'oidc' ? { nonce } : { samlRequestId }),
    ...(linkUserId === undefined ? {} : { linkUserId }),
    ...(invitationId === undefined ? {} : { invitationId }),
  };
  const ttl = deps.config.sso.flowSeconds;
  await deps.flows.put(ssoFlowKeys, ssoFlowKeys.key(organisationId, { stateHash: hex(sha256(Buffer.from(state, 'utf8'))) }), flow, { ttlSeconds: ttl });
  const { redirectUrl } = await deps.services.call(startFederatedSignIn, {
    params: { providerId: provider.id },
    body: provider.kind === 'oidc'
      ? { kind: 'oidc', redirectUri: addresses.oidcRedirectUri, state, nonce, codeChallenge: challengeOf(codeVerifierOf(binding, state)) }
      : { kind: 'saml', acsUrl: addresses.acsUrl, spEntityId: addresses.spEntityId, relayState: state, requestId: samlRequestId },
  }, { request: { organisationId }, correlationId });
  return { redirectUrl, binding, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
}

/** Reads a flow and removes it: only the caller whose removal took it may go on. */
async function takeFlow(deps: AuthDeps, organisationId: string, stateHash: string): Promise<FlowRecord> {
  const key = ssoFlowKeys.key(organisationId, { stateHash });
  const flow = await deps.flows.read(ssoFlowKeys, key);
  if (flow === undefined || await deps.flows.remove(ssoFlowKeys, key) !== 1) throw expired();
  return flow;
}

const bindingMatches = (binding: string, bindingHash: string): boolean =>
  constantTimeEqual(sha256(Buffer.from(binding, 'utf8')), Buffer.from(bindingHash, 'hex'));

// ----------------------------------------------------------------------------- OIDC

export async function completeOidc(deps: AuthDeps, input: { callbackQuery: string; binding: string; client?: Client }, correlationId: string)
  : Promise<SignedIn> {
  const query = new URLSearchParams(input.callbackQuery.startsWith('?') ? input.callbackQuery.slice(1) : input.callbackQuery);
  const state = query.get('state');
  if (state === null || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(state)) throw expired();
  const organisationId = organisationOf(state);
  const flow = await takeFlow(deps, organisationId, hex(sha256(Buffer.from(state, 'utf8'))));
  if (flow.kind !== 'oidc' || flow.nonce === undefined || !bindingMatches(input.binding, flow.bindingHash)) throw expired();
  const identity = await deps.services.call(completeFederatedSignIn, {
    params: { providerId: flow.providerId },
    body: {
      kind: 'oidc', redirectUri: ssoAddresses(deps).oidcRedirectUri, callbackQuery: query.toString(), expectedState: state,
      expectedNonce: flow.nonce, codeVerifier: codeVerifierOf(input.binding, state),
    },
  }, { request: { organisationId }, correlationId });
  return finish(deps, organisationId, flow, identity, input.client, correlationId);
}

// ----------------------------------------------------------------------------- SAML

export async function receiveSaml(deps: AuthDeps, input: { samlResponse: string; relayState: string }, correlationId: string)
  : Promise<{ ticket: string }> {
  const organisationId = organisationOf(input.relayState);
  const stateHash = hex(sha256(Buffer.from(input.relayState, 'utf8')));
  const flow = await takeFlow(deps, organisationId, stateHash);
  if (flow.kind !== 'saml' || flow.samlRequestId === undefined) throw expired();
  const addresses = ssoAddresses(deps);
  const identity = await deps.services.call(completeFederatedSignIn, {
    params: { providerId: flow.providerId },
    body: {
      kind: 'saml', acsUrl: addresses.acsUrl, spEntityId: addresses.spEntityId, samlResponse: input.samlResponse,
      relayState: input.relayState, expectedRequestId: flow.samlRequestId,
    },
  }, { request: { organisationId }, correlationId });
  const ticket = handleOf(organisationId);
  await deps.flows.put(ssoTicketKeys, ssoTicketKeys.key(organisationId, { ticketHash: hex(sha256(Buffer.from(ticket, 'utf8'))) }), {
    flow, identity,
  }, { ttlSeconds: 120 });
  return { ticket };
}

export async function completeSaml(deps: AuthDeps, input: { ticket: string; binding: string; client?: Client }, correlationId: string)
  : Promise<SignedIn> {
  const organisationId = organisationOf(input.ticket);
  const key = ssoTicketKeys.key(organisationId, { ticketHash: hex(sha256(Buffer.from(input.ticket, 'utf8'))) });
  const held = await deps.flows.read(ssoTicketKeys, key);
  if (held === undefined || await deps.flows.remove(ssoTicketKeys, key) !== 1) throw expired();
  if (!bindingMatches(input.binding, held.flow.bindingHash)) throw expired();
  return finish(deps, organisationId, held.flow, held.identity, input.client, correlationId);
}

// ----------------------------------------------------------------------------- who it is

type OrganisationRow = Pick<Organisation, 'id' | 'status' | 'mfaRequired' | 'ssoRequired' | 'sessionIdleMinutes' | 'sessionAbsoluteMinutes'>;

async function finish(deps: AuthDeps, organisationId: string, flow: FlowRecord, identity: FederatedIdentity, client: Client,
  correlationId: string): Promise<SignedIn> {
  const control = deps.databases.pool('control');
  const ipHash = deps.guard.addressHash(client?.address);
  const userAgentHash = deps.guard.userAgentHash(client?.userAgent);
  const { organisation, provider, link } = await inTransaction(control, { organisationId }, async (db) => ({
    organisation: await organisationRepo.findById(db, organisationId) as OrganisationRow | undefined,
    provider: (await identityProviderRepo.listPublic(db, organisationId)).find((p) => p.id === flow.providerId),
    link: await userIdentityRepo.findLive(db, { organisationId, identityProviderId: flow.providerId, subject: identity.subject }),
  }));
  if (!organisation || organisation.status !== 'active' || !provider || !provider.active) throw expired();

  const refuse = async (reason: string, error: AppError, userId: string | null = null): Promise<never> => {
    await inTransaction(control, { organisationId }, (db) => recordAuthEvent(db, {
      organisationId, correlationId, event: 'login_failed', userId, ipHash, detail: { reason, method: 'sso', provider_id: provider.id },
    }));
    throw error;
  };

  let userId: string;
  let created = false;
  let linkedVia: 'invitation' | 'jit' | 'existing_session' | undefined;
  if (link !== undefined) {
    if (flow.purpose === 'link' && link.userId !== flow.linkUserId) {
      return refuse('linked_elsewhere', new AppError('conflict', 'this identity is linked to someone else here', { code: 'sso.identity_linked_elsewhere' }));
    }
    userId = link.userId;
  } else if (flow.purpose === 'link') {
    userId = flow.linkUserId!;
    linkedVia = 'existing_session';
  } else if (flow.purpose === 'invitation') {
    const joined = await joinFromInvitation(deps, organisationId, flow, identity, correlationId).catch((error: unknown) => {
      throw asInviterRefusal(error);
    });
    userId = joined.userId;
    created = joined.created;
    linkedVia = 'invitation';
  } else if (provider.jitProvisioning) {
    if (identity.email === null || !identity.emailVerified) {
      return refuse('email_unverified', new AppError('forbidden', 'the identity provider gave no verified address', { code: 'sso.email_unverified' }));
    }
    const existing = await inTransaction(control, {}, (db) => userRepo.findForLogin(db, identity.email!));
    if (existing) {
      return refuse('link_required', new AppError('forbidden',
        'an account with this address exists: sign in your usual way, then link this identity', { code: 'sso.link_required' }));
    }
    userId = await joinJustInTime(deps, organisationId, provider, identity, correlationId);
    created = true;
    linkedVia = 'jit';
  } else {
    return refuse('not_linked', notLinked());
  }

  const issued = await inTransaction(control, { organisationId, userId }, async (db) => {
    const user = await userRepo.findById(db, userId);
    const membership = await membershipRepo.findByUserId(db, { userId, organisationId });
    if (!user || user.status !== 'active' || !membership || membership.status !== 'active') return undefined;
    if (linkedVia !== undefined) {
      await userIdentityRepo.insert(db, {
        id: uuidv7(), organisationId, identityProviderId: provider.id, userId, subject: identity.subject,
        emailAtLink: identity.email ?? user.email, linkedVia, lastLoginAt: new Date().toISOString(),
      });
    } else {
      await userIdentityRepo.markLogin(db, link!.id);
    }
    const mfa = identity.mfa ? 'satisfied' as const
      : mfaStateOf(null, await mfaFactorRepo.countConfirmed(db, userId), organisation.mfaRequired);
    await userRepo.recordLogin(db, userId);
    const session = await deps.sessions.issue(db, {
      organisation, userId, membershipId: membership.id, mfa, authMethod: 'sso', ipHash, userAgentHash,
      // A SAML session at the provider, for single logout (spec 55.5).
      ...(identity.saml === undefined ? {} : { sso: { identityProviderId: provider.id, sessionIndex: identity.saml.sessionIndex } }),
    });
    await recordAuthEvent(db, {
      organisationId, correlationId, event: 'login', userId, membershipId: membership.id, ipHash,
      detail: { method: 'sso', provider_id: provider.id, mfa, ...(linkedVia === undefined ? {} : { linked_via: linkedVia }) },
    });
    return session;
  }).catch((error: unknown) => {
    if (error instanceof AppError && error.category === 'conflict' && linkedVia !== undefined) {
      throw new AppError('conflict', 'this identity or person was linked meanwhile; sign in again', { code: 'sso.link_conflict' });
    }
    throw error;
  });
  if (!issued) return refuse('account', notLinked(), userId);
  await issued.cache();
  if (created && identity.email !== null) await deps.directory.registerIdentity({ userId, email: identity.email }, correlationId);
  return { ...issued.view, sessionToken: issued.token };
}

/** The invited person joins: the provider's verified address must be the one invited. */
async function joinFromInvitation(deps: AuthDeps, organisationId: string, flow: FlowRecord, identity: FederatedIdentity,
  correlationId: string): Promise<{ userId: string; created: boolean }> {
  const control = deps.databases.pool('control');
  const invitation = openInvitation(await inTransaction(control, { organisationId }, (db) => invitationRepo.findById(db, flow.invitationId!)));
  if (!invitation) throw new AppError('unauthenticated', 'this invitation is not valid; ask for a new one', { code: 'auth.invitation_invalid' });
  if (identity.email === null || !identity.emailVerified || normaliseEmail(identity.email) !== normaliseEmail(invitation.email)) {
    throw new AppError('forbidden', 'sign in to the identity provider as the address that was invited', { code: 'sso.invitation_address_mismatch' });
  }
  const existing = await inTransaction(control, {}, (db) => userRepo.findForLogin(db, invitation.email));
  const userId = existing?.id ?? uuidv7();
  const membershipId = await inTransaction(control, { organisationId, userId }, async (db) => {
    if (!existing) await insertSsoUser(db, userId, invitation.email, identity);
    return joinByInvitation(db, invitation, userId, { correlationId, newAccount: !existing, via: 'sso' });
  });
  await grantAfterAssignment(deps, organisationId, membershipId, correlationId);
  return { userId, created: !existing };
}

async function insertSsoUser(db: Queryable, userId: string, email: string, identity: FederatedIdentity): Promise<void> {
  const local = email.slice(0, email.indexOf('@'));
  await userRepo.insert(db, {
    id: userId, firstName: identity.firstName ?? local, lastName: identity.lastName ?? '-', email, passwordHash: null, ssoOnly: true,
    emailVerifiedAt: identity.emailVerified ? new Date().toISOString() : null,
  });
}

/** A new person, just in time (spec 55.5): the default role and scope only, granted as the member who configured the provider. */
async function joinJustInTime(deps: AuthDeps, organisationId: string, provider: PublicIdentityProvider, identity: FederatedIdentity,
  correlationId: string): Promise<string> {
  const granter = identity.configuredBy;
  if (granter === null || provider.defaultRoleId === null) {
    throw new AppError('forbidden', 'this provider cannot add people yet; ask an administrator', { code: 'sso.jit_unavailable' });
  }
  const userId = uuidv7();
  const membershipId = uuidv7();
  const joinedAt = new Date().toISOString();
  try {
    await inTransaction(deps.databases.pool('control'), { organisationId, userId }, async (db) => {
      await insertSsoUser(db, userId, identity.email!, identity);
      await membershipRepo.insert(db, { id: membershipId, userId, organisationId, status: 'active', invitedBy: granter, invitedAt: joinedAt, joinedAt });
      const actedAt = provider.defaultScopeId === null ? null : await roleAssignmentRepo.actingScope(db, organisationId, granter, provider.defaultScopeId);
      await roleAssignmentRepo.insert(db, {
        id: uuidv7(), organisationId, membershipId, roleId: provider.defaultRoleId!, onScopeId: provider.defaultScopeId,
        grantedBy: granter, grantedAtScopeId: actedAt,
      });
      if (provider.defaultScopeId !== null) {
        await scopeMembershipRepo.insert(db, {
          id: uuidv7(), organisationId, membershipId, scopeId: provider.defaultScopeId, isPrimary: true, addedBy: granter,
        });
      }
      await recordAuthEvent(db, {
        organisationId, correlationId, event: 'member_joined', userId, membershipId,
        detail: { new_account: true, method: 'sso_jit', provider_id: provider.id },
      });
      await seatOnJoin(db, { organisationId, membershipId }, correlationId, membershipId, provider.defaultScopeId);
    });
    await grantAfterAssignment(deps, organisationId, membershipId, correlationId);
  } catch (error) {
    const refused = asInviterRefusal(error);
    if (refused !== error) {
      throw new AppError('forbidden', 'the member who configured this provider can no longer give its default role', { code: 'sso.jit_granter_lacks_authority' });
    }
    throw error;
  }
  return userId;
}


// ----------------------------------------------------------------------------- single logout (spec 55.5)

/** The gateway's single logout address for one provider: an IdP-initiated message names it. */
export const sloUrlOf = (deps: Pick<AuthDeps, 'config'>, organisationId: string, providerId: string): string =>
  `${ssoAddresses(deps).origin}/api/v1/sso/saml/slo/${organisationId}/${providerId}`;

export async function samlMetadata(deps: AuthDeps, query: { organisationId?: string | undefined; providerId?: string | undefined }, correlationId: string)
  : Promise<{ xml: string }> {
  const addresses = ssoAddresses(deps);
  const sloUrl = query.organisationId !== undefined && query.providerId !== undefined ? sloUrlOf(deps, query.organisationId, query.providerId) : undefined;
  const { xml } = await deps.services.call(readServiceProviderMetadata, {
    body: { spEntityId: addresses.spEntityId, acsUrl: addresses.acsUrl, ...(sloUrl === undefined ? {} : { sloUrl }) },
  }, { correlationId });
  return { xml };
}

export async function beginSingleLogout(deps: AuthDeps, sessionToken: string, correlationId: string): Promise<{ logoutUrl: string | null }> {
  const parsed = parseSessionToken(sessionToken);
  if (!parsed) return { logoutUrl: null };
  const control = deps.databases.pool('control');
  const organisationId = parsed.organisationId;
  const live = await inTransaction(control, {}, (db) => sessionRepo.resolveByTokenHash(db, parsed.hash));
  const origin = live !== undefined && live.id === parsed.sessionId && live.organisationId === organisationId
    ? await inTransaction(control, { organisationId }, (db) => sessionRepo.ssoOf(db, parsed.sessionId), { readOnly: true }) : undefined;
  // The session ends here first, whatever the provider does.
  await deps.sessions.revoke(sessionToken);
  if (origin === undefined || origin.identityProviderId === null) return { logoutUrl: null };
  const link = await inTransaction(control, { organisationId }, (db) => userIdentityRepo.findLiveForUser(db, origin.identityProviderId!, origin.userId), { readOnly: true });
  if (link === undefined) return { logoutUrl: null };
  const addresses = ssoAddresses(deps);
  const { redirectUrl } = await deps.services.call(startSamlLogout, {
    params: { providerId: origin.identityProviderId },
    body: {
      spEntityId: addresses.spEntityId, acsUrl: addresses.acsUrl, sloUrl: sloUrlOf(deps, organisationId, origin.identityProviderId),
      nameId: link.subject, ...(origin.ssoSessionIndex === null ? {} : { sessionIndex: origin.ssoSessionIndex }), relayState: hex(randomBytes(16)),
    },
  }, { request: { organisationId }, correlationId }).catch(() => ({ redirectUrl: null }));
  await inTransaction(control, { organisationId }, (db) => recordAuthEvent(db, {
    organisationId, correlationId, event: 'single_logout', userId: origin.userId,
    detail: { provider_id: origin.identityProviderId!, initiated_by: 'silo', sessions: 1, provider_told: redirectUrl !== null },
  }));
  return { logoutUrl: redirectUrl };
}

export async function receiveSamlLogout(deps: AuthDeps, input: z.output<typeof receiveSamlLogoutMessage.body>, correlationId: string)
  : Promise<{ redirectUrl: string }> {
  const { organisationId, providerId } = input;
  const addresses = ssoAddresses(deps);
  const verified = await deps.services.call(receiveSamlLogoutCredential, {
    params: { providerId },
    body: { spEntityId: addresses.spEntityId, acsUrl: addresses.acsUrl, sloUrl: sloUrlOf(deps, organisationId, providerId), message: input.message },
  }, { request: { organisationId }, correlationId });
  if (verified.kind === 'response') return { redirectUrl: `${addresses.origin}/sign-in?signed_out=1` };
  // The provider's LogoutRequest: the person it names, their sessions from it (that one, where it names a session index).
  const control = deps.databases.pool('control');
  const link = await inTransaction(control, { organisationId }, (db) => userIdentityRepo.findLive(db, { organisationId, identityProviderId: providerId, subject: verified.nameId }), { readOnly: true });
  if (link !== undefined) {
    const ended = await inTransaction(control, { organisationId }, async (db) => {
      const ids = await sessionRepo.revokeForProvider(db, link.userId, providerId, verified.sessionIndex);
      await recordAuthEvent(db, {
        organisationId, correlationId, event: 'single_logout', userId: link.userId,
        detail: { provider_id: providerId, initiated_by: 'provider', sessions: ids.length },
      });
      return ids;
    });
    await deps.sessions.dropCopies(organisationId, ended);
  }
  return { redirectUrl: verified.responseUrl };
}
