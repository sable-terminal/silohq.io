// The OAuth engine (catalogue: oauth; spec 15.3, 15.4). One implementation for every provider.
//
// Start: the state is 32 random bytes, single use, short-lived and bound to the initiating
//   session; only its hash is stored, against the pending connection, organisation,
//   connector and membership. With PKCE, the verifier is sealed by the credential service
//   into the pending flow. The authorisation URL comes from the manifest.
// Callback: one per cell, encoding nothing about connector or tenant. The flow is found and
//   consumed in one statement by the state's hash; the session must be the one that
//   started it. The credential service exchanges the code, checks the scopes and seals the
//   tokens; this service never sees them.
// Refresh: serialised per connection by a lock in redis-data (lock:{org}:oauth:<id>). A
//   caller that waited for another refresh uses its result rather than refreshing again,
//   so a provider that rotates refresh tokens never sees a stale one.
// Clients (spec 15.4): the organisation's own client for the connector first; otherwise the
//   cell's Silo-registered client, held by the system organisation, whose secret the
//   credential service opens in that organisation.

import { discoverOAuthMetadata, registerOAuthDynamicClient, revokeOAuthClientSecret, type OAuthMetadata } from '../../contracts/credential/oauthCredential.contract.ts';
import { exchangeAuthorisationCode, refreshAccessToken, sealOAuthVerifier, storeOAuthClientSecret, type OAuthClientRef } from '../../contracts/credential/oauthCredential.contract.ts';
import { manifestSchema, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import type { ConnectConfig } from '../../config/connect.config.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { lockKeys } from '../../infra/keyspaces.infra.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { Connection } from '../../models/connect/connection.model.ts';
import type { OauthClient } from '../../models/connect/oauthClient.model.ts';
import { connectionCredentialRepo, connectionRepo, connectorManifestRepo, connectorRepo, oauthClientRepo, oauthPendingFlowRepo } from '../../repos/connect/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { base64url, randomBytes, sha256 } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { sleep } from '../../utils/time.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';

export interface OAuthDeps {
  databases: Databases;
  services: ServiceClient;
  /** redis-data: the refresh locks. */
  data: RedisStore;
  config: Pick<ConnectConfig, 'oauthRedirectUri' | 'oauthFlowSeconds'>;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

const LOCK_SECONDS = 30;

// One form for a timestamp, whether it came from the database or was just computed.
const iso = (at: string | null): string | null => (at === null ? null : new Date(at).toISOString());
const LOCK_WAIT_MS = 20_000;

function redirectUri(deps: OAuthDeps): string {
  if (deps.config.oauthRedirectUri === undefined) {
    throw new AppError('configuration', 'the cell has no OAuth callback configured', { code: 'config.oauth_redirect_uri' });
  }
  return deps.config.oauthRedirectUri;
}

async function loadConnection(deps: OAuthDeps, request: RequestContext, connectionId: string): Promise<{ connection: Connection; manifest: Manifest }> {
  return inTransaction(deps.databases.pool('control'), request, async (db) => {
    const connection = await connectionRepo.findById(db, connectionId);
    if (!connection) throw new AppError('not_found', 'no such connection', { code: 'connection.not_found' });
    const row = await connectorManifestRepo.findById(db, connection.manifestId);
    if (!row) throw new AppError('integrity', 'the connection names a missing manifest', { code: 'connection.manifest_missing' });
    return { connection, manifest: manifestSchema.parse(row.document) };
  }, { readOnly: true });
}

const clientRef = (row: OauthClient): OAuthClientRef => ({
  id: row.id, organisationId: row.organisationId, clientId: row.clientId, secretCredentialId: row.clientSecretCredentialId,
});

async function systemOrganisation(deps: OAuthDeps): Promise<string | undefined> {
  return inTransaction(deps.databases.pool('control'), {}, (db) => organisationRepo.systemOrganisationId(db), { readOnly: true });
}

/**
 * The organisation's own client for the connector, else the cell's Silo-registered one; for a
 * provider the catalogue does not know (15.4), its discovery document then dynamic registration
 * where it implements it, a fast path attempted and fallen back from: failing it, the
 * organisation brings its own client.
 */
async function resolveClient(deps: OAuthDeps, request: RequestContext, connectorId: string,
  dynamic?: { auth: Manifest['auth']; correlationId: string }): Promise<OAuthClientRef> {
  const control = deps.databases.pool('control');
  const own = await inTransaction(control, request, (db) => oauthClientRepo.activeForConnector(db, connectorId), { readOnly: true });
  if (own) return clientRef(own);
  const system = await systemOrganisation(deps);
  const silo = system === undefined ? undefined
    : await inTransaction(control, { organisationId: system }, (db) => oauthClientRepo.siloRegisteredForConnector(db, connectorId), { readOnly: true });
  if (silo) return clientRef(silo);
  const metadataUrl = dynamic?.auth.endpoints?.metadata;
  if (metadataUrl !== undefined && request.membershipId !== undefined) {
    const registered = await registerDynamically(deps, request, connectorId, metadataUrl, dynamic!.auth, dynamic!.correlationId);
    if (registered !== undefined) return clientRef(registered);
  }
  throw new AppError('configuration', 'no OAuth client is registered for this connector; register your own client first', { code: 'oauth.client_missing' });
}

/** Discovery, then RFC 7591 registration, recorded; undefined where the provider does not register clients or refuses. */
async function registerDynamically(deps: OAuthDeps, request: RequestContext, connectorId: string, metadataUrl: string, auth: Manifest['auth'],
  correlationId: string): Promise<OauthClient | undefined> {
  const call = { request, correlationId };
  let registration;
  try {
    const metadata = await deps.services.call(discoverOAuthMetadata, { body: { url: metadataUrl } }, call);
    await event(deps, request, correlationId, 'oauth_metadata_discovered', 'connector', connectorId, {
      registration: metadata.registrationEndpoint !== null, scopes: metadata.scopesSupported.length,
    });
    if (metadata.registrationEndpoint === null) return undefined;
    registration = await deps.services.call(registerOAuthDynamicClient, { body: {
      registrationEndpoint: metadata.registrationEndpoint, clientName: 'Silo', redirectUri: redirectUri(deps), scopes: auth.scopes,
      tokenEndpointAuthMethod: auth.clientAuthentication,
    } }, call);
  } catch (error) {
    if (isAppError(error) && error.category !== 'unavailable' && error.category !== 'validation' && error.category !== 'not_found') throw error;
    return undefined;
  }
  return inTransaction(deps.databases.pool('control'), request, async (db) => {
    const row = await oauthClientRepo.insert(db, {
      id: uuidv7(), organisationId: request.organisationId!, connectorId, origin: 'dynamic_registration', clientId: registration.clientId,
      clientSecretCredentialId: registration.clientSecretCredentialId, registrationAccessTokenCredentialId: registration.registrationTokenCredentialId,
      metadataUrl, redirectUri: redirectUri(deps), createdBy: request.membershipId!,
    });
    await recordConnectEvent(db, { service: 'oauth',
      organisationId: row.organisationId, correlationId, event: 'oauth_client_registered', membershipId: request.membershipId, resourceType: 'oauth_client',
      resourceId: row.id, detail: { connector_id: connectorId, origin: row.origin, confidential: row.clientSecretCredentialId !== null },
    });
    return row;
  });
}

/** A provider's discovery document for a person writing a manifest (15.4 step 1), recorded as discovered. */
export async function discoverProvider(deps: OAuthDeps, ctx: Context, url: string): Promise<OAuthMetadata> {
  if (ctx.request.membershipId === undefined || !await allowed(deps, ctx, 'oauth_client.manage')) {
    throw new AppError('forbidden', 'you may not discover OAuth providers', { code: 'connect.not_permitted', details: { permission: 'oauth_client.manage' } });
  }
  const metadata = await deps.services.call(discoverOAuthMetadata, { body: { url } }, { request: ctx.request, correlationId: ctx.correlationId });
  await inTransaction(deps.databases.pool('control'), ctx.request, (db) => recordConnectEvent(db, { service: 'oauth',
    organisationId: ctx.request.organisationId!, correlationId: ctx.correlationId, event: 'oauth_metadata_discovered', membershipId: ctx.request.membershipId,
    resourceType: 'connector', resourceId: ctx.request.organisationId!,
    detail: { registration: metadata.registrationEndpoint !== null, scopes: metadata.scopesSupported.length, by_person: true },
  }));
  return metadata;
}

async function event(deps: OAuthDeps, request: RequestContext, correlationId: string, name: Parameters<typeof recordConnectEvent>[1]['event'],
  resourceType: 'connection' | 'oauth_client' | 'connector', resourceId: string, detail: Record<string, string | number | boolean> = {}): Promise<void> {
  await inTransaction(deps.databases.pool('control'), request, (db) => recordConnectEvent(db, { service: 'oauth',
    organisationId: request.organisationId!, correlationId, event: name, membershipId: request.membershipId, resourceType, resourceId, detail,
  }));
}

async function allowed(deps: OAuthDeps, ctx: Context, permission: string, scopeId?: string): Promise<boolean> {
  const decision = await deps.services.call(authorise, { body: { permission, ...(scopeId === undefined ? {} : { scopeId }) } },
    { request: ctx.request, correlationId: ctx.correlationId });
  return decision.decision === 'allow';
}

export async function startFlow(deps: OAuthDeps, ctx: Context, connectionId: string): Promise<{ authorisationUrl: string; expiresAt: string }> {
  const { organisationId, membershipId, sessionId } = ctx.request;
  if (membershipId === undefined || sessionId === undefined) {
    throw new AppError('forbidden', 'an OAuth flow is started by a signed-in member', { code: 'oauth.member_required' });
  }
  const { connection, manifest } = await loadConnection(deps, ctx.request, connectionId);
  const { auth } = manifest;
  if (auth.strategy !== 'oauth2_code' && auth.strategy !== 'oauth2_code_pkce') {
    throw new AppError('validation', 'the connection does not use an authorisation code strategy', { code: 'oauth.strategy' });
  }
  if (connection.status === 'revoked' || connection.status === 'halted') {
    throw new AppError('conflict', `a ${connection.status} connection cannot be connected`, { code: 'oauth.connection_unavailable' });
  }
  // The person creating the connection connects it; reconnecting is connection.reconnect (spec 15.6).
  const creating = connection.status === 'draft' && connection.createdBy === membershipId;
  if (!creating && connection.owningMembershipId !== membershipId && !await allowed(deps, ctx, 'connection.reconnect', connection.owningScopeId)) {
    throw new AppError('forbidden', 'you may not reconnect this connection', { code: 'connect.not_permitted', details: { permission: 'connection.reconnect' } });
  }
  const client = await resolveClient(deps, ctx.request, connection.connectorId, { auth, correlationId: ctx.correlationId });
  const redirect = redirectUri(deps);

  const state = base64url(randomBytes(32));
  const stateHash = sha256(state);
  let challenge: string | undefined;
  let sealed: Buffer | null = null;
  if (auth.strategy === 'oauth2_code_pkce') {
    const verifier = base64url(randomBytes(32));
    challenge = base64url(sha256(verifier));
    sealed = Buffer.from((await deps.services.call(sealOAuthVerifier, { body: { stateHash: stateHash.toString('hex'), verifier } },
      { request: ctx.request, correlationId: ctx.correlationId })).sealed, 'base64');
  }
  const expiresAt = new Date(Date.now() + deps.config.oauthFlowSeconds * 1000).toISOString();
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    await oauthPendingFlowRepo.insert(db, {
      stateHash, organisationId: organisationId!, connectionId, connectorId: connection.connectorId, membershipId, sessionId,
      pkceVerifierSealed: sealed, expiresAt,
    });
    await recordConnectEvent(db, { service: 'oauth',
      organisationId: organisationId!, correlationId: ctx.correlationId, event: 'oauth_flow_started', membershipId, resourceType: 'connection',
      resourceId: connectionId, detail: { pkce: sealed !== null, oauth_client_id: client.id },
    });
  });

  const url = new URL(auth.endpoints!.authorise!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirect);
  if (auth.scopes.length > 0) url.searchParams.set('scope', auth.scopes.join(auth.scopeSeparator));
  url.searchParams.set('state', state);
  if (challenge !== undefined) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return { authorisationUrl: url.toString(), expiresAt };
}

export async function completeFlow(deps: OAuthDeps, ctx: Context, input: { state: string; code?: string | undefined; error?: string | undefined })
  : Promise<{ organisationId: string; connectionId: string; grantedScopes: string[] }> {
  const invalid = new AppError('unauthenticated', 'this sign-in link is not valid; start connecting again', { code: 'oauth.state_invalid' });
  const stateHash = sha256(input.state);
  const consumed = await inTransaction(deps.databases.pool('control'), {}, (db) => oauthPendingFlowRepo.consume(db, stateHash));
  if (!consumed) throw invalid;
  if (consumed.sessionId !== ctx.request.sessionId) {
    // Bound to the session that started it (spec 15.3): another browser cannot complete it.
    throw new AppError('forbidden', 'this sign-in was started in another session', { code: 'oauth.session_mismatch' });
  }
  const flow = await inTransaction(deps.databases.pool('control'), { organisationId: consumed.organisationId },
    (db) => oauthPendingFlowRepo.findByKey(db, { organisationId: consumed.organisationId, stateHash }), { readOnly: true });
  if (!flow) throw invalid;
  const request: RequestContext = { organisationId: flow.organisationId, membershipId: flow.membershipId, sessionId: flow.sessionId };
  if (input.error !== undefined || input.code === undefined) {
    const error = /^[a-z_]{1,40}$/.test(input.error ?? '') ? input.error! : 'unknown';
    await event(deps, request, ctx.correlationId, 'oauth_flow_completed', 'connection', flow.connectionId, { outcome: 'provider_error', error });
    throw new AppError('forbidden', 'the provider did not authorise the connection', { code: 'oauth.provider_error', details: { error } });
  }
  const client = await resolveClient(deps, request, flow.connectorId);
  const result = await deps.services.call(exchangeAuthorisationCode, {
    body: {
      connectionId: flow.connectionId, code: input.code, redirectUri: redirectUri(deps), stateHash: stateHash.toString('hex'),
      verifierSealed: flow.pkceVerifierSealed === null ? null : flow.pkceVerifierSealed.toString('base64'), client,
    },
  }, { request, correlationId: ctx.correlationId });
  await event(deps, request, ctx.correlationId, 'oauth_flow_completed', 'connection', flow.connectionId, {
    outcome: 'connected', scopes: result.grantedScopes.length,
  });
  return { organisationId: flow.organisationId, connectionId: flow.connectionId, grantedScopes: result.grantedScopes };
}

export async function refreshToken(deps: OAuthDeps, ctx: Context, connectionId: string): Promise<{ expiresAt: string | null }> {
  const organisationId = ctx.request.organisationId!;
  const requestedAt = Date.now();
  const { connection, manifest } = await loadConnection(deps, ctx.request, connectionId);
  const key = lockKeys.key(organisationId, { purpose: 'oauth', resourceId: connectionId });
  let token = await deps.data.acquireLock(lockKeys, key, LOCK_SECONDS);
  while (token === undefined) {
    if (Date.now() - requestedAt > LOCK_WAIT_MS) {
      throw new AppError('unavailable', 'another refresh of this connection is taking too long', { code: 'oauth.refresh_busy', retryable: true, retryAfterSeconds: 1 });
    }
    await sleep(50);
    token = await deps.data.acquireLock(lockKeys, key, LOCK_SECONDS);
  }
  try {
    // A refresh that finished while this one waited is the answer.
    const access = (await inTransaction(deps.databases.pool('control'), ctx.request, (db) => connectionCredentialRepo.liveMetadata(db, connectionId),
      { readOnly: true })).find((m) => m.fieldName === 'access_token');
    if (access?.refreshedAt != null && Date.parse(access.refreshedAt) > requestedAt) return { expiresAt: iso(access.expiresAt) };

    const client = manifest.auth.strategy === 'oauth2_client_credentials' ? null : await resolveClient(deps, ctx.request, connection.connectorId);
    try {
      const out = await deps.services.call(refreshAccessToken, { body: { connectionId, client } }, { request: ctx.request, correlationId: ctx.correlationId });
      await event(deps, ctx.request, ctx.correlationId, 'token_refreshed', 'connection', connectionId, { rotated: out.rotated });
      return { expiresAt: iso(out.expiresAt) };
    } catch (error) {
      if (isAppError(error)) {
        await event(deps, ctx.request, ctx.correlationId, 'token_refresh_failed', 'connection', connectionId, { reason: error.code.slice(0, 64) });
      }
      throw error;
    }
  } finally {
    await deps.data.releaseLock(lockKeys, key, token);
  }
}

export async function registerClient(deps: OAuthDeps, ctx: Context, input: { connectorId: string; clientId: string; clientSecret?: string | undefined })
  : Promise<OauthClient> {
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined || !await allowed(deps, ctx, 'oauth_client.manage')) {
    throw new AppError('forbidden', 'you may not register OAuth clients', { code: 'connect.not_permitted', details: { permission: 'oauth_client.manage' } });
  }
  const connector = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => connectorRepo.findById(db, input.connectorId), { readOnly: true });
  if (!connector) throw new AppError('not_found', 'no such connector', { code: 'connector.not_found' });
  const secretCredentialId = input.clientSecret === undefined ? null
    : (await deps.services.call(storeOAuthClientSecret, { body: { secret: input.clientSecret } }, { request: ctx.request, correlationId: ctx.correlationId })).credentialId;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const row = await oauthClientRepo.insert(db, {
      id: uuidv7(), organisationId: ctx.request.organisationId!, connectorId: connector.id, origin: 'bring_your_own', clientId: input.clientId,
      clientSecretCredentialId: secretCredentialId, redirectUri: redirectUri(deps), createdBy: membershipId,
    });
    await recordConnectEvent(db, { service: 'oauth',
      organisationId: row.organisationId, correlationId: ctx.correlationId, event: 'oauth_client_registered', membershipId, resourceType: 'oauth_client',
      resourceId: row.id, detail: { connector_id: connector.id, origin: row.origin, confidential: secretCredentialId !== null },
    });
    return row;
  });
}

/** The organisation's OAuth clients, newest first (D260): live ones, or the revoked too. */
export async function listClients(deps: OAuthDeps, ctx: Context, includeRevoked: boolean): Promise<OauthClient[]> {
  if (ctx.request.membershipId === undefined || !await allowed(deps, ctx, 'oauth_client.manage')) {
    throw new AppError('forbidden', 'you may not see OAuth clients', { code: 'connect.not_permitted', details: { permission: 'oauth_client.manage' } });
  }
  return inTransaction(deps.databases.pool('control'), ctx.request, (db) => oauthClientRepo.listForOrganisation(db, includeRevoked), { readOnly: true });
}

/**
 * Revokes an organisation's own OAuth client (spec 15.6): it is no longer used to start a
 * sign-in, and its sealed secret is shredded. Silo's own clients are Silo's to withdraw.
 */
export async function revokeClient(deps: OAuthDeps, ctx: Context, id: string): Promise<{ revoked: boolean }> {
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined || !await allowed(deps, ctx, 'oauth_client.manage')) {
    throw new AppError('forbidden', 'you may not revoke OAuth clients', { code: 'connect.not_permitted', details: { permission: 'oauth_client.manage' } });
  }
  const row = await getClient(deps, ctx, id);
  if (row.revokedAt !== null) return { revoked: false };
  if (row.clientSecretCredentialId !== null) {
    await deps.services.call(revokeOAuthClientSecret, { params: { credentialId: row.clientSecretCredentialId } }, { request: ctx.request, correlationId: ctx.correlationId });
  }
  await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    await oauthClientRepo.update(db, row.id, { revokedAt: new Date().toISOString() });
    await recordConnectEvent(db, { service: 'oauth',
      organisationId: row.organisationId, correlationId: ctx.correlationId, event: 'oauth_client_revoked', membershipId, resourceType: 'oauth_client',
      resourceId: row.id, detail: { connector_id: row.connectorId, origin: row.origin },
    });
  });
  return { revoked: true };
}

/**
 * Sign-ins started and never finished (spec 15.3): each pending flow past its expiry is marked
 * expired and recorded once (oauth_flow_expired), in its organisation. Returns how many.
 */
export async function expireFlows(deps: Pick<OAuthDeps, 'databases'>, limit = 200): Promise<number> {
  const control = deps.databases.pool('control');
  const due = await inTransaction(control, {}, (db) => oauthPendingFlowRepo.expiredAcross(db, limit), { readOnly: true });
  let expired = 0;
  for (const flow of due) {
    await inTransaction(control, { organisationId: flow.organisationId }, async (db) => {
      const marked = await oauthPendingFlowRepo.markExpired(db, flow.stateHash);
      if (marked === undefined) return;
      expired += 1;
      await recordConnectEvent(db, { service: 'oauth', organisationId: flow.organisationId, correlationId: uuidv7(), event: 'oauth_flow_expired',
        resourceType: 'connection', resourceId: marked.connectionId, detail: { connector_id: marked.connectorId, started_by: marked.membershipId } });
    });
  }
  return expired;
}

export async function getClient(deps: OAuthDeps, ctx: Context, id: string): Promise<OauthClient> {
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => oauthClientRepo.findById(db, id), { readOnly: true });
  if (!row) throw new AppError('not_found', 'no such OAuth client', { code: 'oauth.client_not_found' });
  return row;
}

/**
 * Silo's own client for a catalogue connector (spec 15.4, 15.5), registered by a Silo operator
 * through admin-portal. It belongs to the system organisation, as does its sealed secret.
 */
export async function registerSiloClient(deps: OAuthDeps, ctx: Pick<HandlerContext, 'correlationId'>, input: {
  operatorId: string; connectorId: string; clientId: string; clientSecret?: string | undefined;
}): Promise<OauthClient> {
  const system = await systemOrganisation(deps);
  if (system === undefined) throw new AppError('configuration', 'the cell has no system organisation', { code: 'oauth.system_organisation_missing' });
  const request: RequestContext = { organisationId: system };
  const control = deps.databases.pool('control');
  const connector = await inTransaction(control, request, (db) => connectorRepo.findById(db, input.connectorId), { readOnly: true });
  if (!connector || connector.organisationId !== null) {
    throw new AppError('not_found', 'Silo registers clients for catalogue connectors only', { code: 'oauth.catalogue_connector_required' });
  }
  const secretCredentialId = input.clientSecret === undefined ? null
    : (await deps.services.call(storeOAuthClientSecret, { body: { secret: input.clientSecret } }, { request, correlationId: ctx.correlationId })).credentialId;
  return inTransaction(control, request, async (db) => {
    const row = await oauthClientRepo.insert(db, {
      id: uuidv7(), organisationId: system, connectorId: connector.id, origin: 'silo_registered', clientId: input.clientId,
      clientSecretCredentialId: secretCredentialId, redirectUri: redirectUri(deps),
    });
    await recordConnectEvent(db, {
      service: 'oauth', organisationId: system, correlationId: ctx.correlationId, event: 'oauth_client_registered', resourceType: 'oauth_client',
      resourceId: row.id, detail: { connector_id: connector.id, origin: row.origin, confidential: secretCredentialId !== null, operator_id: input.operatorId },
    });
    return row;
  });
}
