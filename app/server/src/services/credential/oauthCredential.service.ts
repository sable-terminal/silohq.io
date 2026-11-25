// OAuth inside the mediator (spec 15.3): the token exchange and the refresh. The client
// secret, the PKCE verifier, the authorisation code's tokens and the refresh token are
// opened and sealed here and never returned. A token request goes to the manifest's token
// endpoint only, through the cell's egress.
//
// - Scopes are checked against the manifest's required scopes immediately after the
//   exchange; a missing scope is refused by name and nothing is stored (spec 15.3).
// - A refresh seals the new access token, and the new refresh token where the provider
//   rotates it, in one transaction, revoking the old rows; the OAuth engine holds the lock
//   around the call, so two refreshes never race with a stale refresh token.
// - A refused refresh counts a failure on the refresh token and surfaces as reconnect,
//   never as an empty result.

import { z } from 'zod';
import type { OAuthClientRef, OAuthMetadata } from '../../contracts/credential/oauthCredential.contract.ts';
import type { Egress } from '../../infra/egress.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import type { ConnectionCredential } from '../../models/connect/connectionCredential.model.ts';
import { connectionCredentialRepo } from '../../repos/connect/index.repo.ts';
import { zeroise } from '../../utils/crypto.util.ts';
import { lastFour, seal, sealBindings, withOpened, type DekCache, type KeyRing, type SealBinding, type SealedSecret } from '../../utils/envelope.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import type { Caller, ConnectionCredentials } from './connectionCredential.service.ts';

export interface OAuthCredentialDeps {
  keys: KeyRing;
  cache: DekCache;
  databases: Databases;
  egress: Egress;
  credentials: ConnectionCredentials;
}

const TOKEN_TIMEOUT_MS = 10_000;

// The PKCE verifier's binding: its pending flow, by organisation and state hash.
const verifierBinding = (organisationId: string, stateHash: string): SealBinding =>
  ({ table: 'connect.oauth_pending_flows', organisation_id: organisationId, state_hash: stateHash });

// A sealed verifier as one blob for oauth_pending_flows.pkce_verifier_sealed:
// version 1 | key version id (16) | nonce (12) | wrapped DEK length (2) | wrapped DEK | ciphertext.
function pack(sealed: SealedSecret): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(sealed.dekWrapped.length);
  return Buffer.concat([Buffer.from([1]), Buffer.from(sealed.keyVersionId.replaceAll('-', ''), 'hex'), sealed.nonce, length, sealed.dekWrapped, sealed.ciphertext]);
}

function unpack(blob: Buffer): SealedSecret {
  if (blob.length < 31 || blob[0] !== 1) throw new AppError('integrity', 'the sealed verifier is malformed', { code: 'oauth.verifier_malformed' });
  const hex = blob.subarray(1, 17).toString('hex');
  const keyVersionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const nonce = blob.subarray(17, 29);
  const wrappedLength = blob.readUInt16BE(29);
  const dekWrapped = blob.subarray(31, 31 + wrappedLength);
  return { keyVersionId, nonce, dekWrapped, ciphertext: blob.subarray(31 + wrappedLength) };
}

const tokenResponse = z.object({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().max(40).optional(),
  expires_in: z.union([z.number(), z.string().regex(/^\d{1,10}$/)]).optional(),
  refresh_token: z.string().min(1).max(16_384).optional(),
  scope: z.string().max(8_192).optional(),
});

interface Tokens {
  access: string;
  refresh: string | undefined;
  expiresAt: string | null;
  scopes: string[];
}

export function createOAuthCredentials(deps: OAuthCredentialDeps) {
  const control = deps.databases.pool('control');

  /** A client's own secret or registration token, sealed with no connection (its purpose binds it). */
  async function storeSealed(caller: Caller, value: string, purpose: 'oauth_client_secret' | 'oauth_registration_token', fieldName: string): Promise<string> {
    const organisationId = caller.request.organisationId!;
    const id = uuidv7();
    const plaintext = Buffer.from(value, 'utf8');
    let sealed: SealedSecret;
    try {
      sealed = await seal(deps.keys, plaintext, sealBindings.connectionCredential({ id, organisationId, connectionId: null, fieldName, purpose }));
    } finally {
      zeroise(plaintext);
    }
    await inTransaction(control, caller.request, (db) => connectionCredentialRepo.insert(db, {
      id, organisationId, connectionId: null, purpose, fieldName, custody: 'cell',
      ciphertext: sealed.ciphertext, nonce: sealed.nonce, dekWrapped: sealed.dekWrapped, keyVersionId: sealed.keyVersionId,
      lastFour: lastFour(value), authStrategy: 'oauth2',
    }));
    return id;
  }

  async function tokenRequest(endpoint: string, form: Record<string, string>, client: { clientId: string; secret: Buffer | undefined },
    authentication: 'client_secret_basic' | 'client_secret_post', requested: readonly string[], separator: string): Promise<Tokens> {
    const body = new URLSearchParams(form);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (client.secret !== undefined && authentication === 'client_secret_basic') {
      // RFC 6749 2.3.1: each part form-encoded before Basic.
      const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.secret.toString('utf8'))}`;
      headers['authorization'] = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
    } else {
      body.set('client_id', client.clientId);
      if (client.secret !== undefined) body.set('client_secret', client.secret.toString('utf8'));
    }
    const response = await deps.egress.send({ url: new URL(endpoint), method: 'POST', headers, body: body.toString(), timeoutMs: TOKEN_TIMEOUT_MS });
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString('utf8'));
    } catch {
      parsed = undefined;
    }
    zeroise(response.body);
    if (response.status !== 200) {
      const error = typeof (parsed as { error?: unknown })?.error === 'string' ? (parsed as { error: string }).error : '';
      const code = /^[a-z_]{1,40}$/.test(error) ? error : 'unknown';
      if (response.status === 400 || response.status === 401) {
        throw new AppError('unauthenticated', 'the provider refused the grant; reconnect the connection', { code: 'oauth.grant_refused', details: { error: code } });
      }
      throw new AppError('upstream', 'the provider\'s token endpoint failed', { code: 'oauth.token_endpoint_failed', details: { status: response.status } });
    }
    const tokens = tokenResponse.safeParse(parsed);
    if (!tokens.success) throw new AppError('upstream', 'the token response is not an OAuth token response', { code: 'oauth.token_response_invalid' });
    const expiresIn = tokens.data.expires_in === undefined ? undefined : Number(tokens.data.expires_in);
    return {
      access: tokens.data.access_token,
      refresh: tokens.data.refresh_token,
      expiresAt: expiresIn === undefined ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
      // RFC 6749 5.1: an absent scope means the scope requested.
      scopes: tokens.data.scope === undefined ? [...requested] : tokens.data.scope.split(/[\s,]+/).filter(Boolean),
    };
  }

  /** Seals the tokens and replaces the live rows, in one transaction. */
  async function storeTokens(caller: Caller, connectionId: string, strategy: string, tokens: Tokens): Promise<void> {
    const organisationId = caller.request.organisationId!;
    const rows: { id: string; field: string; sealed: SealedSecret; expiresAt: string | null }[] = [];
    for (const [field, value, expiresAt] of [['access_token', tokens.access, tokens.expiresAt], ['refresh_token', tokens.refresh, null]] as const) {
      if (value === undefined) continue;
      const id = uuidv7();
      const plaintext = Buffer.from(value, 'utf8');
      try {
        rows.push({ id, field, expiresAt, sealed: await seal(deps.keys, plaintext, sealBindings.connectionCredential({ id, organisationId, connectionId, fieldName: field, purpose: 'connection_auth' })) });
      } finally {
        zeroise(plaintext);
      }
    }
    await inTransaction(control, caller.request, async (db) => {
      for (const row of rows) {
        await connectionCredentialRepo.revokeLive(db, connectionId, row.field);
        await connectionCredentialRepo.insert(db, {
          id: row.id, organisationId, connectionId, purpose: 'connection_auth', fieldName: row.field, custody: 'cell',
          ciphertext: row.sealed.ciphertext, nonce: row.sealed.nonce, dekWrapped: row.sealed.dekWrapped, keyVersionId: row.sealed.keyVersionId,
          authStrategy: strategy, grantedScopes: tokens.scopes, expiresAt: row.expiresAt, refreshedAt: new Date().toISOString(),
        });
      }
    });
  }

  /** Opens the client secret (its own organisation's row) for use, or gives undefined to a public client. */
  async function withClientSecret<T>(caller: Caller, client: OAuthClientRef, reason: 'connect' | 'refresh', use: (secret: Buffer | undefined) => Promise<T>): Promise<T> {
    if (client.secretCredentialId === null) return use(undefined);
    const clientCaller: Caller = { ...caller, request: { organisationId: client.organisationId } };
    const row = await inTransaction(control, clientCaller.request, (db) => connectionCredentialRepo.findById(db, client.secretCredentialId!), { readOnly: true });
    if (!row || row.revokedAt !== null || row.purpose !== 'oauth_client_secret') {
      throw new AppError('configuration', 'the OAuth client has no live secret', { code: 'oauth.client_secret_missing' });
    }
    return deps.credentials.open(clientCaller, [row], reason, async (values) => use(values.get(row.fieldName)));
  }

  return {
    async sealVerifier(caller: Caller, stateHash: string, verifier: string): Promise<Buffer> {
      const plaintext = Buffer.from(verifier, 'utf8');
      try {
        return pack(await seal(deps.keys, plaintext, verifierBinding(caller.request.organisationId!, stateHash)));
      } finally {
        zeroise(plaintext);
      }
    },

    async exchange(caller: Caller, input: {
      connectionId: string; code: string; redirectUri: string; stateHash: string; verifierSealed: Buffer | null; client: OAuthClientRef;
    }): Promise<{ grantedScopes: string[]; expiresAt: string | null }> {
      const { manifest, connection } = await deps.credentials.load(caller, input.connectionId);
      const { auth } = manifest;
      if (auth.strategy !== 'oauth2_code' && auth.strategy !== 'oauth2_code_pkce') {
        throw new AppError('validation', 'the connection does not use an authorisation code strategy', { code: 'oauth.strategy' });
      }
      if (connection.status === 'revoked') throw new AppError('forbidden', 'the connection is revoked', { code: 'connection.revoked' });
      const form: Record<string, string> = { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri };
      const exchangeWith = (verifier: Buffer | undefined) => withClientSecret(caller, input.client, 'connect', (secret) => {
        if (verifier !== undefined) form['code_verifier'] = verifier.toString('utf8');
        return tokenRequest(auth.endpoints!.token!, form, { clientId: input.client.clientId, secret }, auth.clientAuthentication, auth.scopes, auth.scopeSeparator);
      });
      const tokens = input.verifierSealed === null ? await exchangeWith(undefined)
        : (await withOpened(deps.keys, unpack(input.verifierSealed), verifierBinding(caller.request.organisationId!, input.stateHash),
          (verifier) => exchangeWith(verifier), deps.cache)).value;
      const missing = auth.scopes.filter((s) => !tokens.scopes.includes(s));
      if (missing.length > 0) {
        await inTransaction(control, caller.request, (db) => recordConnectEvent(db, { service: 'credential',
          organisationId: caller.request.organisationId!, correlationId: caller.correlationId, event: 'oauth_scope_missing',
          membershipId: caller.request.membershipId, resourceType: 'connection', resourceId: input.connectionId,
          detail: { missing: missing.join(' ').slice(0, 200) },
        }));
        throw new AppError('forbidden', 'the provider did not grant every scope the connector needs', {
          code: 'oauth.scope_missing', details: { missing: missing.join(' ').slice(0, 500) },
        });
      }
      await storeTokens(caller, input.connectionId, auth.strategy, tokens);
      return { grantedScopes: tokens.scopes, expiresAt: tokens.expiresAt };
    },

    async refresh(caller: Caller, connectionId: string, client: OAuthClientRef | null): Promise<{ expiresAt: string | null; rotated: boolean }> {
      const { manifest, connection, rows } = await deps.credentials.load(caller, connectionId);
      const { auth } = manifest;
      if (connection.status === 'revoked') throw new AppError('forbidden', 'the connection is revoked', { code: 'connection.revoked' });
      const byRole = (role: string): ConnectionCredential | undefined => {
        const field = auth.fields.find((f) => f.role === role);
        return field === undefined ? undefined : rows.find((r) => r.fieldName === field.name);
      };
      let tokens: Tokens;
      let refreshRow: ConnectionCredential | undefined;
      try {
        if (auth.strategy === 'oauth2_client_credentials') {
          // The connection's own client id and secret, as its manifest names them.
          const id = byRole('client_id');
          const secret = byRole('client_secret');
          if (id === undefined || secret === undefined) throw new AppError('unauthenticated', 'the connection has no client credentials; reconnect it', { code: 'credential.missing' });
          tokens = await deps.credentials.open(caller, [id, secret], 'refresh', (values) => tokenRequest(auth.endpoints!.token!,
            { grant_type: 'client_credentials', ...(auth.scopes.length > 0 ? { scope: auth.scopes.join(auth.scopeSeparator) } : {}) },
            { clientId: values.get(id.fieldName)!.toString('utf8'), secret: values.get(secret.fieldName) }, auth.clientAuthentication, auth.scopes, auth.scopeSeparator));
        } else {
          refreshRow = rows.find((r) => r.fieldName === 'refresh_token');
          if (refreshRow === undefined) throw new AppError('unauthenticated', 'the connection has no refresh token; reconnect it', { code: 'credential.missing' });
          if (client === null) throw new AppError('configuration', 'no OAuth client for this connector', { code: 'oauth.client_missing' });
          const row = refreshRow;
          tokens = await withClientSecret(caller, client, 'refresh', (secret) => deps.credentials.open(caller, [row], 'refresh', (values) =>
            tokenRequest(auth.endpoints!.token!, { grant_type: 'refresh_token', refresh_token: values.get('refresh_token')!.toString('utf8') },
              { clientId: client.clientId, secret }, auth.clientAuthentication, auth.scopes, auth.scopeSeparator)));
        }
      } catch (error) {
        if (refreshRow !== undefined && error instanceof AppError && error.code === 'oauth.grant_refused') {
          await inTransaction(control, caller.request, (db) => connectionCredentialRepo.recordRefreshFailure(db, refreshRow!.id));
        }
        throw error;
      }
      // A provider that does not rotate keeps the refresh token it has.
      const rotated = tokens.refresh !== undefined;
      await storeTokens(caller, connectionId, auth.strategy, tokens);
      return { expiresAt: tokens.expiresAt, rotated };
    },

    /**
     * Discovery (15.4 step 1): the document at the URL given, or, for an issuer, its RFC 8414
     * address then its OIDC one. Endpoints must be on the issuer's origin's scheme; the issuer is
     * on the same origin as the document. Fetched by the cell's egress (public addresses only).
     */
    async discover(caller: Caller, url: string): Promise<OAuthMetadata> {
      const given = new URL(url);
      const path = given.pathname.replace(/\/$/, '');
      const candidates = given.pathname.includes('/.well-known/') ? [given]
        : [new URL(`/.well-known/oauth-authorization-server${path}`, given.origin), new URL(`${given.origin}${path}/.well-known/openid-configuration`)];
      for (const candidate of candidates) {
        const response = await deps.egress.send({ url: candidate, method: 'GET', headers: { accept: 'application/json' }, timeoutMs: TOKEN_TIMEOUT_MS });
        if (response.status === 404) continue;
        if (response.status !== 200) throw new AppError('unavailable', 'the provider\'s discovery document could not be read', { code: 'oauth.discovery_failed', details: { status: response.status } });
        let doc: Record<string, unknown>;
        try {
          doc = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
        } catch {
          throw new AppError('validation', 'the discovery document is not JSON', { code: 'oauth.discovery_invalid' });
        }
        const text = (k: string): string | null => (typeof doc[k] === 'string' && (doc[k] as string).length <= 500 ? doc[k] as string : null);
        const list = (k: string): string[] => (Array.isArray(doc[k]) ? (doc[k] as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 200) : []);
        const sameScheme = (u: string | null) => u === null || (/^https?:\/\//.test(u) && new URL(u).protocol === candidate.protocol);
        const issuer = text('issuer');
        const token = text('token_endpoint');
        if (issuer === null || token === null || new URL(issuer).origin !== candidate.origin
          || ![token, text('authorization_endpoint'), text('registration_endpoint'), text('revocation_endpoint')].every(sameScheme)) {
          throw new AppError('validation', 'the discovery document does not name its issuer and token endpoint as RFC 8414 requires', { code: 'oauth.discovery_invalid' });
        }
        return {
          issuer, authorizationEndpoint: text('authorization_endpoint'), tokenEndpoint: token, registrationEndpoint: text('registration_endpoint'),
          revocationEndpoint: text('revocation_endpoint'), scopesSupported: list('scopes_supported'), grantTypesSupported: list('grant_types_supported'),
          codeChallengeMethodsSupported: list('code_challenge_methods_supported'), metadataUrl: candidate.toString(),
        };
      }
      throw new AppError('not_found', 'the provider publishes no discovery document there', { code: 'oauth.discovery_missing' });
    },

    /** Dynamic registration (15.4 step 2, RFC 7591): the client id; its secret and registration token sealed. */
    async registerDynamic(caller: Caller, input: { registrationEndpoint: string; clientName: string; redirectUri: string; scopes: string[];
      tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post' }): Promise<{ clientId: string; clientSecretCredentialId: string | null; registrationTokenCredentialId: string | null }> {
      const body = JSON.stringify({
        client_name: input.clientName, redirect_uris: [input.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: input.tokenEndpointAuthMethod, ...(input.scopes.length === 0 ? {} : { scope: input.scopes.join(' ') }),
      });
      const response = await deps.egress.send({ url: new URL(input.registrationEndpoint), method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' }, body, timeoutMs: TOKEN_TIMEOUT_MS });
      let doc: Record<string, unknown> | undefined;
      try {
        doc = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
      } catch {
        doc = undefined;
      }
      zeroise(response.body);
      if ((response.status !== 201 && response.status !== 200) || typeof doc?.['client_id'] !== 'string') {
        throw new AppError('unavailable', 'the provider did not register Silo as a client', { code: 'oauth.registration_refused', details: { status: response.status } });
      }
      const sealValue = async (value: unknown, purpose: 'oauth_client_secret' | 'oauth_registration_token', fieldName: string): Promise<string | null> =>
        typeof value === 'string' && value.length > 0 && value.length <= 4_096 ? storeSealed(caller, value, purpose, fieldName) : null;
      return {
        clientId: (doc['client_id'] as string).slice(0, 500),
        clientSecretCredentialId: await sealValue(doc['client_secret'], 'oauth_client_secret', 'client_secret'),
        registrationTokenCredentialId: await sealValue(doc['registration_access_token'], 'oauth_registration_token', 'registration_access_token'),
      };
    },

    async revokeClientSecret(caller: Caller, credentialId: string): Promise<boolean> {
      return inTransaction(control, caller.request, (db) => connectionCredentialRepo.revokeClientSecret(db, credentialId));
    },

    async storeClientSecret(caller: Caller, secret: string): Promise<string> {
      return storeSealed(caller, secret, 'oauth_client_secret', 'client_secret');
    },
  };
}

export type OAuthCredentials = ReturnType<typeof createOAuthCredentials>;
