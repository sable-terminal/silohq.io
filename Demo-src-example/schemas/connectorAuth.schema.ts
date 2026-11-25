import { z } from 'zod';
import { expression, identifierName, place, placeFrom, tree } from './manifestPrimitives.schema';

/**
 * How a v2 connector proves identity, and the one place a secret is ever placed.
 *
 * A DISCRIMINATED UNION, FOR THE FORM AND FOR EXHAUSTIVENESS. The builder asks
 * for exactly the fields the chosen strategy needs, and `switch (strategy)` with
 * no default fails to compile when one is added.
 *
 * THE HARD RULE, RESTATED WHERE IT IS ENFORCED. An expression never sees a
 * credential. A strategy that needs an expression — a signed request's canonical
 * string, a JWT's claims, an OAuth endpoint that differs per tenant — has the
 * expression build TEXT from `params` and the transport apply the KEY. A session
 * handshake is a strategy rather than a pipeline step for the same reason: the
 * token it produces is a secret, and it is read and placed by the transport
 * without ever being bound into a scope.
 *
 * `auth` ON A MANIFEST IS A LIST OF ALTERNATIVES. The connecting person picks
 * one. An alternative that needs several things at once — a client certificate
 * AND an OAuth token AND a gateway key — is `all_of` (MANIFEST-V2 §9.1).
 */

/* ── Shared pieces ──────────────────────────────────────────────────────── */

/**
 * OAuth endpoints, as expressions over `params`.
 *
 * NOT LITERAL URLS, because the authorisation server is per tenant for exactly
 * the systems a prebuilt connector most needs to serve: a Zoho account's
 * region, an Okta domain, a Salesforce sandbox, a Shopify shop. A literal means
 * one manifest per customer (MANIFEST-V2 §9.1, finding F36).
 */
const oauthEndpoints = z
  .object({
    authorizationUrl: expression,
    tokenUrl: expression,
    revocationUrl: expression.optional(),
  })
  .strict();

const refreshPolicy = z
  .object({
    rotatesRefreshToken: z.boolean().default(false),
    refreshSkewSeconds: z.number().int().min(0).max(3_600).default(60),
  })
  .strict();
const refreshDefault = () => refreshPolicy.parse({});

const scopes = z.array(z.string().min(1).max(256)).max(100).default([]);

/** Where an obtained token is sent. Every token-producing strategy shares this. */
const tokenPlacement = z
  .object({
    place: place.default('header:authorization'),
    prefix: z.string().max(32).default('Bearer '),
  })
  .strict();
const bearerPlacement = () => tokenPlacement.parse({});

/**
 * The OAuth parameters providers disagree about.
 *
 * `authorizationParams` IS WHY GMAIL KEEPS WORKING AFTER AN HOUR. Google issues
 * no refresh token without `access_type=offline` and `prompt=consent`, so a
 * connector that cannot say them connects, answers for one hour, and then fails
 * every read until somebody reconnects it — daily, for ever (finding F37).
 * `clientAuth: 'basic'` is how Xero and Zoom want the client authenticated at
 * the token endpoint.
 */
const oauthOptions = {
  authorizationParams: z.record(z.string().min(1).max(64), expression).default({}),
  tokenParams: z.record(z.string().min(1).max(64), expression).default({}),
  clientAuth: z.enum(['body', 'basic']).default('body'),
};

/**
 * Every strategy may rename the credential fields it reads, so two parts of an
 * `all_of` that both read `username` are declared as `gateway_user` and
 * `idp_user` and cannot collide in the one sealed bag.
 */
const common = {
  fields: z.record(identifierName, identifierName).optional().describe('Default field name → declared credential name'),
};

/* ── The strategies ─────────────────────────────────────────────────────── */

const none = z.object({ strategy: z.literal('none'), ...common }).strict();

const oauth2AuthorizationCode = z
  .object({
    strategy: z.literal('oauth2_authorization_code'),
    endpoints: oauthEndpoints,
    scopes,
    refresh: refreshPolicy.default(refreshDefault),
    bringYourOwnClient: z.boolean().default(false),
    token: tokenPlacement.default(bearerPlacement),
    ...oauthOptions,
    ...common,
  })
  .strict();

const oauth2Pkce = z
  .object({
    strategy: z.literal('oauth2_pkce'),
    endpoints: oauthEndpoints,
    scopes,
    refresh: refreshPolicy.default(refreshDefault),
    bringYourOwnClient: z.boolean().default(false),
    token: tokenPlacement.default(bearerPlacement),
    ...oauthOptions,
    ...common,
  })
  .strict();

const oauth2ClientCredentials = z
  .object({
    strategy: z.literal('oauth2_client_credentials'),
    endpoints: z.object({ tokenUrl: expression }).strict(),
    scopes,
    refresh: refreshPolicy.default(refreshDefault),
    token: tokenPlacement.default(bearerPlacement),
    tokenParams: oauthOptions.tokenParams,
    clientAuth: oauthOptions.clientAuth,
    ...common,
  })
  .strict();

/**
 * The OAuth password grant.
 *
 * STILL HOW MOST ON-PREM IDENTITY SERVERS HAND AN INTEGRATION A TOKEN —
 * Keycloak, ADFS, PingFederate in front of an internal API — and it could not
 * be said at all, because a login could place two credential fields and this
 * needs four (finding F11). Refresh, rotation and skew are the OAuth service's,
 * unchanged.
 */
const oauth2Password = z
  .object({
    strategy: z.literal('oauth2_password'),
    endpoints: z.object({ tokenUrl: expression }).strict(),
    scopes,
    refresh: refreshPolicy.default(refreshDefault),
    token: tokenPlacement.default(bearerPlacement),
    tokenParams: oauthOptions.tokenParams,
    clientAuth: oauthOptions.clientAuth,
    ...common,
  })
  .strict();

const apiKeyHeader = z
  .object({
    strategy: z.literal('api_key_header'),
    name: z.string().min(1).max(128),
    prefix: z.string().max(32).optional(),
    ...common,
  })
  .strict();

const apiKeyQuery = z
  .object({ strategy: z.literal('api_key_query'), name: z.string().min(1).max(128), ...common })
  .strict();

const bearer = z
  .object({
    strategy: z.literal('bearer'),
    prefix: z.string().max(32).default('Bearer '),
    header: z.string().min(1).max(128).default('authorization'),
    ...common,
  })
  .strict();

const basic = z.object({ strategy: z.literal('basic'), ...common }).strict();

/** SFTP, FTP, SMB: a username and a key, or a username and a password — on the socket. */
const sshKey = z.object({ strategy: z.literal('ssh_key'), ...common }).strict();

/** The marker that the socket is the proof. Requires `transport.tls.clientCertificate`. */
const mtls = z.object({ strategy: z.literal('mtls'), ...common }).strict();

/**
 * Any number of declared credential fields, each placed where it goes, on every
 * request.
 *
 * WHAT API KEYS AND BASIC AUTH COULD NOT SAY. Sage Intacct wants five values in
 * the XML body, two of them the application's and three the user's; a gateway
 * wants a key in one header and a tenant secret in another (findings F40, F43).
 */
const placed = z
  .object({
    strategy: z.literal('placed'),
    places: z.record(identifierName, place).describe('Credential field → where it goes'),
    ...common,
  })
  .strict();

/**
 * A HANDSHAKE: a request that yields a token — and often cookies — used on the
 * requests after it.
 *
 * A STRATEGY, NOT A PIPELINE STEP, because the token is a secret. The transport
 * builds this request, places the credential fields by name (never by
 * expression), reads the tokens out of the response, seeds the connection's
 * cookie jar, and discards the response. Nothing about it enters a scope.
 *
 * ONE SHAPE FOR THREE THINGS the first design could not tell apart: a login
 * that returns a bearer token; a session that returns several cookies plus a
 * load-balancer affinity cookie (finding F10); and SAP's `X-CSRF-Token: Fetch`,
 * which is only needed before a write (`appliesTo: 'writes'`, finding F1).
 *
 * `singleSession` IS FOR SYSTEMS THAT ALLOW ONE SESSION PER USER. Without it,
 * two Silo instances log in in turn, each killing the other's session, for ever
 * (finding F15).
 */
const session = z
  .object({
    strategy: z.literal('session'),
    request: z
      .object({
        method: z.enum(['POST', 'GET']).default('POST'),
        /** Joins under a REST connection's base address, as every request path does; from the origin for GraphQL and SOAP. */
        path: expression.optional(),
        url: expression.optional().describe('An absolute login URL — elsewhere on this host, or on another pinned origin such as an SSO server'),
        headers: z.record(z.string().min(1).max(128), expression).default({}),
        query: z.record(z.string().min(1).max(128), expression).default({}),
        /** Literals and `{{ params.… }}` only — the manifest refuses anything else here. */
        body: tree.optional(),
        contentType: z.enum(['json', 'form', 'xml']).default('json'),
      })
      .strict(),
    credentialPlacement: z.union([z.literal('basic'), z.record(identifierName, place)]).default('basic'),
    tokens: z
      .array(
        z
          .object({
            from: placeFrom,
            place,
            prefix: z.string().max(32).default(''),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    cookies: z.union([z.enum(['none', 'all']), z.array(z.string().min(1).max(256)).max(32)]).default('all'),
    expiresIn: placeFrom.optional(),
    /** Capped at an hour so a revoked password stops working within one (finding F28). */
    ttlSeconds: z.number().int().min(30).max(3_600).default(1_800),
    singleSession: z.boolean().default(false),
    appliesTo: z.enum(['all', 'writes']).default('all'),
    ...common,
  })
  .strict();

/** Claims the transport sets, last. A manifest naming one could make an assertion that never expires. */
export const TRANSPORT_CLAIMS = ['exp', 'iat', 'nbf', 'jti'] as const;

/**
 * A JWT the connector signs and exchanges for an access token (RFC 7523), or
 * presents as the bearer itself.
 *
 * CLAIMS ARE EXPRESSIONS OVER `params` AND NOTHING SECRET. `iat`, `exp`, `nbf`
 * and `jti` belong to the transport (finding F30) — the clock is not an
 * expression's to read — and `aud` must be the exchange's own origin unless the
 * provider's audience is an opaque string, declared as such.
 */
const jwtAssertion = z
  .object({
    strategy: z.literal('jwt_assertion'),
    algorithm: z.enum(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256', 'HS256', 'EdDSA']).default('RS256'),
    claims: z.record(z.string().min(1).max(64), expression),
    lifetimeSeconds: z.number().int().min(30).max(3_600).default(300),
    audienceIsOpaque: z.boolean().default(false),
    exchange: z
      .object({
        tokenUrl: expression,
        grantType: z.string().max(200).default('urn:ietf:params:oauth:grant-type:jwt-bearer'),
        assertionParam: z.string().min(1).max(64).default('assertion'),
        extra: z.record(z.string().min(1).max(64), expression).default({}),
        accessTokenPath: z.string().max(128).default('access_token'),
        expiresInPath: z.string().max(128).default('expires_in'),
      })
      .strict()
      .optional(),
    token: tokenPlacement.default(bearerPlacement),
    ...common,
  })
  .strict();

/**
 * A SIGNED REQUEST. The expression builds the canonical string; the transport
 * applies the key.
 *
 * THREE ALGORITHMS ARE SPECIFICATIONS, AND THEREFORE CODE. SigV4 — the signing
 * scheme S3-compatible storage speaks, not one company's — and OAuth 1.0a in its
 * two hash variants each have a canonicalisation, a derived key and a header
 * layout nobody should be asked to transcribe (finding F41). They ignore
 * `canonical`. Everything else is `hmac_*`, `rsa_sha256` or `ed25519` over the
 * connector's own canonical expression, which may read only `request.*` and
 * `params.*` (§9.1), so the key can only ever sign a description of the request
 * actually being sent.
 */
export const SIGNING_ALGORITHMS = [
  'sigv4',
  'oauth1_hmac_sha1',
  'oauth1_hmac_sha256',
  'hmac_sha1',
  'hmac_sha256',
  'hmac_sha512',
  'rsa_sha256',
  'ed25519',
] as const;

/** Algorithms whose canonical form is a specification rather than the connector's expression. */
export const SPEC_SIGNING = new Set<string>(['sigv4', 'oauth1_hmac_sha1', 'oauth1_hmac_sha256']);

const signed = z
  .object({
    strategy: z.literal('signed'),
    algorithm: z.enum(SIGNING_ALGORITHMS),
    /* sigv4 */
    service: expression.optional(),
    region: expression.optional(),
    /* oauth1 — the realm is public and differs per account (NetSuite's is the account id). */
    realm: expression.optional(),
    /* everything else */
    canonical: expression.optional().describe('Over request.{method,path,query,queryString,headers,body,timestamp,nonce} and params'),
    encoding: z.enum(['hex', 'base64', 'base64url']).default('hex'),
    place: place.optional(),
    prefix: z.string().max(64).default(''),
    timestamp: z
      .object({
        place,
        format: z.enum(['unix_seconds', 'unix_millis', 'iso8601', 'rfc7231']).default('unix_seconds'),
      })
      .strict()
      .optional(),
    nonce: z.object({ place, bytes: z.number().int().min(8).max(64).default(16) }).strict().optional(),
    /** Where the non-secret credential field `key_id` goes. Placed AFTER signing. */
    keyId: z.object({ place, prefix: z.string().max(32).default('') }).strict().optional(),
    ...common,
  })
  .strict();

/**
 * WS-Security UsernameToken, in the SOAP header.
 *
 * THE PRIMARY API OF WORKDAY, SAP PI/PO, ORACLE EBS AND MOST ON-PREM ESBs, and it
 * could not be reached: there was no SOAP header slot and no way to place a
 * credential inside the envelope (findings F3, F40). The digest — base64 of the
 * SHA-1 of nonce, created and password — is computed by the transport.
 */
const wsSecurity = z
  .object({
    strategy: z.literal('ws_security'),
    passwordType: z.enum(['text', 'digest']).default('text'),
    ...common,
  })
  .strict();

/**
 * NTLM: a challenge and response bound to one TCP connection, which is why it
 * can only run where the connection is — in the customer's agent (finding F2).
 */
const ntlm = z
  .object({
    strategy: z.literal('ntlm'),
    domain: expression.optional(),
    workstation: expression.optional(),
    ...common,
  })
  .strict();

/**
 * Kerberos / SPNEGO. A ticket from the customer's own KDC, which Silo can never
 * reach — so it runs in the agent, and `useAgentIdentity` means the agent's own
 * domain identity is used and no credential leaves Silo at all.
 */
const negotiate = z
  .object({
    strategy: z.literal('negotiate'),
    useAgentIdentity: z.boolean().default(true),
    servicePrincipal: expression.optional().describe('HTTP/host.corp.example — defaults to the target host'),
    ...common,
  })
  .strict();

/** Every strategy that is one thing. */
export const singleStrategy = z.discriminatedUnion('strategy', [
  none,
  oauth2AuthorizationCode,
  oauth2Pkce,
  oauth2ClientCredentials,
  oauth2Password,
  apiKeyHeader,
  apiKeyQuery,
  bearer,
  basic,
  sshKey,
  mtls,
  placed,
  session,
  jwtAssertion,
  signed,
  wsSecurity,
  ntlm,
  negotiate,
]);

/**
 * Several strategies applied together, in order, to every request.
 *
 * WHAT THE FIRST DESIGN COULD NOT DO AT ALL: exactly one strategy was applied
 * per request. Open Banking is mTLS plus OAuth plus a signature; every internal
 * API behind Apigee or APIM is a gateway key plus an identity-provider token;
 * Trello is a key and a token as two query parameters (finding F1). Parts may
 * not be `all_of` themselves — one level says everything these systems need.
 */
const allOf = z
  .object({
    strategy: z.literal('all_of'),
    parts: z.array(singleStrategy).min(2).max(4),
  })
  .strict();

export const authStrategy = z.discriminatedUnion('strategy', [
  none,
  oauth2AuthorizationCode,
  oauth2Pkce,
  oauth2ClientCredentials,
  oauth2Password,
  apiKeyHeader,
  apiKeyQuery,
  bearer,
  basic,
  sshKey,
  mtls,
  placed,
  session,
  jwtAssertion,
  signed,
  wsSecurity,
  ntlm,
  negotiate,
  allOf,
]);

export type AuthStrategyV2 = z.infer<typeof authStrategy>;
export type AuthStrategy = AuthStrategyV2;
export type SingleStrategyV2 = z.infer<typeof singleStrategy>;
export type StrategyName = AuthStrategyV2['strategy'];

/** Strategies that can only run inside the customer's network. */
export const AGENT_ONLY_STRATEGIES = new Set<StrategyName>(['ntlm', 'negotiate']);

/**
 * The credential fields each strategy reads, before any `fields` rename.
 *
 * ONE TABLE, READ BY THE CONNECT FORM AND BY THE TRANSPORT. A `?` suffix means
 * optional. `placed` reads exactly the names its `places` map lists, so it has no
 * fixed row; `all_of` reads the union of its parts.
 */
export const DEFAULT_CREDENTIAL_FIELDS: Record<Exclude<StrategyName, 'all_of' | 'placed'>, readonly string[]> = {
  none: [],
  oauth2_authorization_code: ['client_id?', 'client_secret?'],
  oauth2_pkce: ['client_id?'],
  oauth2_client_credentials: ['client_id', 'client_secret'],
  oauth2_password: ['client_id?', 'client_secret?', 'username', 'password'],
  api_key_header: ['key'],
  api_key_query: ['key'],
  bearer: ['token'],
  basic: ['username', 'password'],
  ssh_key: ['username', 'private_key?', 'passphrase?', 'password?'],
  mtls: ['certificate', 'private_key'],
  session: ['username?', 'password?'],
  jwt_assertion: ['private_key', 'key_id?'],
  signed: ['secret?', 'key_id?', 'access_key_id?', 'secret_access_key?', 'session_token?', 'private_key?', 'consumer_key?', 'consumer_secret?', 'token?', 'token_secret?'],
  ws_security: ['username', 'password'],
  ntlm: ['username?', 'password?'],
  negotiate: ['username?', 'password?'],
};

/** The declared credential names a strategy reads, after its `fields` rename. */
export function credentialFieldsOf(strategy: AuthStrategyV2): string[] {
  if (strategy.strategy === 'all_of') return [...new Set(strategy.parts.flatMap(credentialFieldsOf))];
  if (strategy.strategy === 'placed') return Object.keys(strategy.places);
  const defaults = DEFAULT_CREDENTIAL_FIELDS[strategy.strategy];
  const rename = strategy.fields ?? {};
  const extra =
    strategy.strategy === 'session' && strategy.credentialPlacement !== 'basic'
      ? Object.keys(strategy.credentialPlacement)
      : [];
  return [...new Set([...defaults.map((one) => one.replace(/\?$/, '')).map((one) => rename[one] ?? one), ...extra])];
}

export const USER_FACING_STRATEGIES = [
  'oauth2_authorization_code',
  'oauth2_pkce',
  'oauth2_client_credentials',
  'oauth2_password',
  'api_key_header',
  'api_key_query',
  'bearer',
  'basic',
  'ssh_key',
  'placed',
  'session',
  'jwt_assertion',
  'signed',
  'ws_security',
  'mtls',
  'ntlm',
  'negotiate',
  'all_of',
  'none',
] as const satisfies readonly StrategyName[];
