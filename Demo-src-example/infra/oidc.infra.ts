import { childLogger } from '../config/logger.config';
import type { Jwk } from '../utils/oidc.util';

const log = childLogger('oidc');

/**
 * The network half of OpenID Connect.
 *
 * THE SOCKET IS HERE AND THE JUDGEMENT IS IN `utils/oidc`. Fetching a key set is
 * infrastructure; deciding whether a token is acceptable is an authorisation
 * decision, and keeping them apart is what lets the decision be attacked
 * exhaustively in tests with no network at all.
 *
 * KEY SETS ARE CACHED, AND THE CACHE IS SMALL AND SHORT. A provider rotates
 * signing keys on its own schedule and does not tell us; caching for hours means
 * every sign-in fails until the entry expires. Caching for nothing means an HTTP
 * round trip inside every login. Five minutes, plus a forced refetch when a
 * token names a key we have not seen, is the shape that survives a rotation
 * without hammering.
 */

const JWKS_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5_000;

interface CachedKeys {
  keys: Jwk[];
  fetchedAt: number;
}

const jwksCache = new Map<string, CachedKeys>();

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/**
 * Read a provider's own description of itself.
 *
 * USED WHEN CONFIGURING, NOT WHEN SIGNING IN. The endpoints are copied into the
 * provider row at setup and read from there afterwards — so a directory that
 * changes its discovery document cannot silently redirect an existing tenant's
 * sign-ins somewhere new.
 */
export async function discover(issuer: string): Promise<Discovery> {
  const base = issuer.replace(/\/$/, '');
  const url = `${base}/.well-known/openid-configuration`;

  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`The provider's discovery document could not be read (${response.status}).`);
  }

  const document = (await response.json()) as Partial<Discovery>;

  /*
   * THE DOCUMENT MUST AGREE WITH THE URL IT CAME FROM. A discovery document
   * naming a different issuer than the one fetched is the setup for a mix-up
   * attack, where tokens from one provider are accepted as another's.
   */
  if (document.issuer?.replace(/\/$/, '') !== base) {
    throw new Error('The provider’s discovery document names a different issuer.');
  }

  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    const value = document[field];
    if (!value || !value.startsWith('https://')) {
      throw new Error(`The provider’s ${field} is missing or is not HTTPS.`);
    }
  }

  return document as Discovery;
}

export async function fetchJwks(uri: string, options: { force?: boolean } = {}): Promise<Jwk[]> {
  const cached = jwksCache.get(uri);
  if (!options.force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }

  const response = await fetch(uri, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    if (cached) {
      // A provider that is briefly unreachable should not sign everybody out.
      log.warn({ uri, status: response.status }, 'Key set unreachable; using the cached one');
      return cached.keys;
    }
    throw new Error(`The provider’s key set could not be read (${response.status}).`);
  }

  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache.set(uri, { keys, fetchedAt: Date.now() });
  return keys;
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
}

/**
 * Exchange the authorization code.
 *
 * THE SECRET GOES IN THE BODY OVER TLS AND NEVER IN A URL. A query string ends
 * up in access logs, proxy logs and browser history; a body does not.
 */
export async function exchangeCode(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });

  const response = await fetch(input.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    log.warn({ status: response.status, detail: detail.slice(0, 200) }, 'Code exchange refused');
    throw new Error('The identity provider refused the sign-in.');
  }

  return (await response.json()) as TokenResponse;
}

/** For tests and for a forced rotation. */
export function clearJwksCache(): void {
  jwksCache.clear();
}
