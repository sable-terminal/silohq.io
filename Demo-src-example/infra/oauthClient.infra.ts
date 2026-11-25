import { childLogger } from '../config/logger.config';
import { parseRetryAfter } from '../utils/backoff.util';
import { request, HttpError, type HttpResult } from './httpClient.infra';

const log = childLogger('oauth-client');
const TIMEOUT_MS = 8_000;

/**
 * The network half of connector OAuth.
 *
 * ONE IMPLEMENTATION SERVES EVERY PROVIDER. §4.3 — Salesforce OAuth and Sage
 * OAuth are the same code path with different endpoint values in the manifest.
 * Nothing in this file names a provider.
 *
 * SEPARATE FROM `oidc.infra`, WHICH IS FOR SIGNING IN. That one verifies an
 * `id_token` to establish who a person is; this one obtains and refreshes an
 * ACCESS token to act on a system. Sharing the file would put a token that
 * grants access to a customer's data through the same path as one that only
 * asserts identity, and the two have different failure modes and different
 * things worth logging.
 */

export interface TokenSet {
  accessToken: string;
  /** Absent on a client-credentials grant, and on refresh when not rotated. */
  refreshToken: string | null;
  expiresAt: Date | null;
  /** What the provider actually granted, which may be less than was asked for. */
  grantedScopes: string[];
  /** Anything the provider volunteered that identifies the instance reached. */
  extra: Record<string, unknown>;
}

export class OAuthFailure extends Error {
  constructor(
    readonly kind: 'invalid_grant' | 'invalid_client' | 'rate_limited' | 'unreachable' | 'other',
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'OAuthFailure';
  }
}

/**
 * `scope` COMES BACK AS A SPACE-DELIMITED STRING, sometimes comma-delimited, and
 * sometimes not at all. Absent means "what you asked for" by the specification
 * and means "we quietly gave you less" in practice, which is why §4.3 checks the
 * granted set explicitly rather than assuming.
 */
function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(/[\s,]+/).filter(Boolean);
}

function readTokenResponse(body: Record<string, unknown>): TokenSet {
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;

  const {
    access_token: _a,
    refresh_token: _r,
    expires_in: _e,
    scope: _s,
    token_type: _t,
    id_token: _i,
    ...extra
  } = body;

  return {
    accessToken: String(body.access_token ?? ''),
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000),
    grantedScopes: parseScopes(body.scope),
    /*
     * WHAT IS LEFT OVER IS WHERE THE INSTANCE HIDES. Salesforce returns
     * `instance_url`, Xero a tenant list, Slack a `team`. Keeping the unknown
     * fields rather than discarding them is what lets instance resolution be
     * per-connector configuration instead of a per-provider branch here.
     */
    extra,
  };
}

/**
 * Every token-endpoint call goes through `httpClient`, and never through `fetch`
 * directly.
 *
 * THE TOKEN URL COMES FROM A MANIFEST, and a manifest can be customer-authored.
 * That makes it exactly the customer-supplied URL `httpClient`'s SSRF guard
 * exists for — a token endpoint of `http://169.254.169.254/` would otherwise ask
 * a cloud metadata server for Silo's own credentials, and a permitted host
 * answering `302` to the same would get there by the back door.
 *
 * NOTHING HERE IS RETRIED (`maxAttempts: 1`). Both calls that use this are
 * single-use against a provider that rotates: an authorisation code is spent by
 * the first attempt, and so is a refresh token. A retry after a 5xx from a
 * provider that actually processed the request comes back `invalid_grant`, which
 * we would read as "this connection needs reconnecting" while the truth is that
 * the provider rotated the token and we threw the new one away. Retrying to
 * survive a blip would cause the exact permanent lockout the rest of this engine
 * is built to avoid.
 */
/**
 * How the client proves itself at the token endpoint. `body` puts the id and
 * secret in the form; `basic` puts them in an Authorization header, which some
 * providers require and reject the other way.
 */
export interface ClientProof {
  clientAuth?: 'body' | 'basic';
  /** The connector's `tokenParams`, already worked out: an audience, a resource. */
  extra?: Record<string, string>;
}

function withClient(body: URLSearchParams, input: { clientId: string; clientSecret: string } & ClientProof): Record<string, string> {
  for (const [name, value] of Object.entries(input.extra ?? {})) body.set(name, value);
  if (input.clientAuth === 'basic') {
    body.delete('client_id');
    body.delete('client_secret');
    return { authorization: `Basic ${Buffer.from(`${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.clientSecret)}`).toString('base64')}` };
  }
  return {};
}

async function post(url: string, body: URLSearchParams, headers: Record<string, string> = {}): Promise<TokenSet> {
  let response: HttpResult;

  try {
    response = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...headers,
      },
      body: body.toString(),
      timeoutMs: TIMEOUT_MS,
      maxAttempts: 1,
    });
  } catch (error) {
    if (error instanceof HttpError && error.kind === 'blocked') {
      throw new OAuthFailure('other', error.message);
    }
    if (error instanceof HttpError && error.status === 429) {
      throw new OAuthFailure('rate_limited', 'The provider is rate limiting token requests.');
    }
    throw new OAuthFailure('unreachable', 'The provider could not be reached.');
  }

  if (response.status === 429) {
    // A provider that says how long to wait is more reliable than our guess.
    const after = parseRetryAfter(response.headers['retry-after'] ?? null);
    throw new OAuthFailure('rate_limited', 'The provider is rate limiting token requests.', after);
  }

  let body_: Record<string, unknown>;
  try {
    body_ = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    throw new OAuthFailure('other', `The provider returned something that is not JSON (${response.status}).`);
  }

  if (response.status < 200 || response.status >= 300) {
    const code = String(body_.error ?? '');

    /*
     * `invalid_grant` IS THE ONE THAT MATTERS AND IT IS TERMINAL. It means the
     * refresh token is dead — revoked, expired, or already rotated away — and
     * retrying will fail identically forever. §4.3: surfaced as an auth error
     * requiring reconnection, never as an empty result, and never retried.
     */
    if (code === 'invalid_grant') {
      throw new OAuthFailure('invalid_grant', 'The provider rejected the stored token.');
    }
    if (code === 'invalid_client') {
      throw new OAuthFailure('invalid_client', 'The provider rejected the client credentials.');
    }

    log.warn({ status: response.status, error: code }, 'Token endpoint refused');
    throw new OAuthFailure('other', `The provider refused the request (${code || response.status}).`);
  }

  const tokens = readTokenResponse(body_);
  if (!tokens.accessToken) {
    throw new OAuthFailure('other', 'The provider returned no access token.');
  }
  return tokens;
}

export async function exchangeCode(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string | null;
} & ClientProof): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  if (input.codeVerifier) body.set('code_verifier', input.codeVerifier);

  const headers = withClient(body, input);
  return post(input.tokenUrl, body, headers);
}

export async function refresh(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
} & ClientProof): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const headers = withClient(body, input);
  return post(input.tokenUrl, body, headers);
}

export async function clientCredentials(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
} & ClientProof): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  if (input.scopes.length > 0) body.set('scope', input.scopes.join(' '));

  const headers = withClient(body, input);
  return post(input.tokenUrl, body, headers);
}

/**
 * §4.4.2 — dynamic client registration.
 *
 * A FAST PATH ATTEMPTED AND FALLEN BACK FROM, NEVER A DEPENDENCY. Coverage of
 * RFC 7591 is patchy, so a failure here is expected and unremarkable: it means
 * the customer registers the application themselves, which is §4.4.3 and the
 * answer an enterprise IT team prefers anyway.
 */
/**
 * §4.4 path 1 — DISCOVERY METADATA. An OIDC discovery document or an OAuth
 * authorisation server metadata document gives the endpoints, the flows and the
 * scopes with nothing typed by hand.
 *
 * THREE WELL-KNOWN LOCATIONS, BECAUSE THE TWO SPECIFICATIONS DISAGREE. OIDC
 * appends the suffix to the issuer, and RFC 8414 inserts it after the host and
 * puts the issuer's path last. Providers implement one, the other, or both, and
 * which one is not knowable in advance — so all three are tried and the first
 * that answers wins.
 *
 * Returns null rather than throwing: a provider without a discovery document is
 * the ordinary case that falls through to path 2, not an error.
 */
export interface AuthServerMetadata {
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl: string | null;
  revocationUrl: string | null;
  scopesSupported: string[];
  supportsPkce: boolean;
  supportsRefreshToken: boolean;
  discoveredFrom: string;
}

function metadataUrls(issuer: URL): string[] {
  const base = `${issuer.origin}`;
  const path = issuer.pathname.replace(/\/$/, '');
  return [
    `${base}${path}/.well-known/openid-configuration`,
    `${base}${path}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/oauth-authorization-server${path}`,
  ];
}

function readMetadata(body: Record<string, unknown>, from: string): AuthServerMetadata | null {
  const authorizationUrl = typeof body.authorization_endpoint === 'string' ? body.authorization_endpoint : null;
  const tokenUrl = typeof body.token_endpoint === 'string' ? body.token_endpoint : null;

  // Without both of these the document describes something we cannot drive.
  if (!authorizationUrl || !tokenUrl) return null;

  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

  return {
    issuer: typeof body.issuer === 'string' ? body.issuer : from,
    authorizationUrl,
    tokenUrl,
    registrationUrl: typeof body.registration_endpoint === 'string' ? body.registration_endpoint : null,
    revocationUrl: typeof body.revocation_endpoint === 'string' ? body.revocation_endpoint : null,
    scopesSupported: list(body.scopes_supported),
    /*
     * ABSENT IS NOT "NO". Plenty of providers support S256 and never say so, so
     * this reports what the document claims and the caller treats a false as
     * "unconfirmed" rather than "must not". PKCE is sent regardless; a provider
     * that ignores the parameter is no worse off than one that never saw it.
     */
    supportsPkce: list(body.code_challenge_methods_supported).includes('S256'),
    supportsRefreshToken: list(body.grant_types_supported).includes('refresh_token'),
    discoveredFrom: from,
  };
}

export async function discover(issuerUrl: string): Promise<AuthServerMetadata | null> {
  let issuer: URL;
  try {
    issuer = new URL(issuerUrl);
  } catch {
    return null;
  }

  /*
   * HTTPS ONLY. A discovery document fetched over plain HTTP can be rewritten in
   * flight, and everything downstream — where tokens get posted — comes out of
   * it. `httpClient` blocks the private ranges; this blocks the other half.
   */
  if (issuer.protocol !== 'https:') return null;

  for (const url of metadataUrls(issuer)) {
    try {
      const response = await request(url, {
        headers: { accept: 'application/json' },
        timeoutMs: TIMEOUT_MS,
        maxAttempts: 1,
      });
      if (response.status !== 200) continue;

      const metadata = readMetadata(JSON.parse(response.body) as Record<string, unknown>, url);
      if (metadata) return metadata;
    } catch {
      // A location that does not answer is the normal case; try the next.
    }
  }

  return null;
}

/**
 * §4.4 path 2 — DYNAMIC CLIENT REGISTRATION (RFC 7591).
 *
 * A FAST PATH, NOT A DEPENDENCY. Coverage is patchy, so every failure returns
 * null and the caller falls through to path 3 — bring your own client — which
 * always works.
 */
export async function registerClient(input: {
  registrationUrl: string;
  redirectUri: string;
  clientName: string;
}): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const response = await request(input.registrationUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: input.clientName,
        redirect_uris: [input.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
      timeoutMs: TIMEOUT_MS,
      maxAttempts: 1,
    });

    if (response.status !== 200 && response.status !== 201) return null;

    const body = JSON.parse(response.body) as { client_id?: string; client_secret?: string };
    if (!body.client_id || !body.client_secret) return null;

    /*
     * A PUBLIC CLIENT IS NO USE HERE. Some servers register without a secret,
     * and a connector acting on a customer's data from a server cannot be one —
     * fall through to a client the customer registers and owns.
     */
    return { clientId: body.client_id, clientSecret: body.client_secret };
  } catch {
    return null;
  }
}
