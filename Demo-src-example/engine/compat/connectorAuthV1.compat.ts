import { z } from 'zod';

/**
 * How a connector proves identity to the system it talks to.
 *
 * A DISCRIMINATED UNION, NOT A BAG OF OPTIONAL FIELDS, and that is not a
 * stylistic preference. The visual builder's form is generated from this: pick a
 * strategy, and the form asks for exactly the fields that strategy needs. A loose
 * object with eleven optional groups would mean writing those field sets twice —
 * once here and once in React — and they drift the first time one gains a field.
 *
 * IT ALSO MAKES THE ENGINE EXHAUSTIVE. `switch (auth.strategy)` with no default
 * fails to compile when a strategy is added, which is the only mechanism that
 * reliably stops a new strategy being enumerated in the schema and silently
 * unimplemented in the executor.
 *
 * NO SECRET APPEARS HERE. Every strategy declares WHERE its values belong in a
 * request — the header name, the parameter name, the endpoint — and the values
 * themselves live sealed in `connection_credentials`, reached only through the
 * mediator.
 */

/** Where a value rides. Shared by several strategies, so named once. */
const placement = z.enum(['header', 'query']).describe('Where the value is sent');

const oauthEndpoints = z.object({
  authorizationUrl: z.string().url().describe('Where the user is sent to approve'),
  tokenUrl: z.string().url().describe('Where the code is exchanged'),
  /**
   * Optional because §4.4 can find it. When a provider publishes discovery
   * metadata the endpoints are read rather than typed, and this whole object is
   * filled in without the user seeing it.
   */
  revocationUrl: z.string().url().optional().describe('Where a token is revoked, if supported'),
});

/**
 * What a refresh is allowed to assume.
 *
 * `rotatesRefreshToken` IS THE FIELD THAT PREVENTS AN ACCOUNT LOCKOUT. Some
 * providers issue a new refresh token on every use and invalidate the old one;
 * a stale copy then locks the connection out permanently. The engine cannot
 * detect this safely by trial, so the manifest declares it.
 */
const refreshPolicy = z
  .object({
    rotatesRefreshToken: z
      .boolean()
      .default(false)
      .describe('The provider issues a new refresh token on every use'),
    refreshSkewSeconds: z
      .number()
      .int()
      .min(0)
      .max(3600)
      .default(60)
      .describe('Refresh this many seconds before expiry rather than on failure'),
  })
  .strict();

/*
 * `() => refreshPolicy.parse({})` RATHER THAN A LITERAL. Zod 4 wants a default of
 * the OUTPUT type, and the output has both fields because both have defaults of
 * their own — so `.default({})` will not compile. Writing the literal instead
 * works and creates a second copy of every default, which drifts the first time
 * one changes. Letting the schema produce its own keeps one source of truth.
 */
const refreshDefault = () => refreshPolicy.parse({});

const scopes = z.array(z.string().min(1)).default([]).describe('Scopes required for this connector');

export const authStrategy = z.discriminatedUnion('strategy', [
  z
    .object({
      strategy: z.literal('oauth2_authorization_code'),
      endpoints: oauthEndpoints,
      scopes,
      refresh: refreshPolicy.default(refreshDefault),
      /**
       * §4.4.3. When true the customer registers the application in their own
       * provider account, so the client id and secret are theirs rather than
       * ours and the redirect URI for their cell is displayed to copy.
       */
      bringYourOwnClient: z.boolean().default(false),
    })
    .strict(),

  z
    .object({
      // PKCE is a separate strategy rather than a flag, because the request it
      // builds differs and the form asks for nothing extra — so the user's
      // choice is between two named things, not a checkbox they must understand.
      strategy: z.literal('oauth2_pkce'),
      endpoints: oauthEndpoints,
      scopes,
      refresh: refreshPolicy.default(refreshDefault),
      bringYourOwnClient: z.boolean().default(false),
    })
    .strict(),

  z
    .object({
      // Machine to machine: no browser, no user approval, no redirect URI.
      strategy: z.literal('oauth2_client_credentials'),
      endpoints: oauthEndpoints.pick({ tokenUrl: true }),
      scopes,
      refresh: refreshPolicy.default(refreshDefault),
    })
    .strict(),

  /*
   * TWO STRATEGIES, NOT ONE WITH A PLACEMENT FIELD. `connector_auth_strategies`
   * enumerates `api_key_header` and `api_key_query` separately, and one source
   * of truth beats a shape that has to be translated at the boundary. It also
   * makes the builder's dropdown say what will happen rather than making
   * somebody pick twice.
   */
  z
    .object({
      strategy: z.literal('api_key_header'),
      name: z.string().min(1).max(128).describe('Header name'),
      /**
       * Some providers want `Token abc`, some want the bare value. Declared
       * rather than guessed, because guessing wrong produces a 401 that looks
       * like a bad key.
       */
      prefix: z.string().max(32).optional().describe('Text before the key, if any'),
    })
    .strict(),

  z
    .object({
      strategy: z.literal('api_key_query'),
      name: z.string().min(1).max(128).describe('Query parameter name'),
    })
    .strict(),

  z.object({ strategy: z.literal('bearer') }).strict(),

  z.object({ strategy: z.literal('basic') }).strict(),

  z
    .object({
      strategy: z.literal('jwt_bearer_assertion'),
      tokenUrl: z.string().url(),
      issuer: z.string().min(1),
      audience: z.string().min(1),
      algorithm: z.enum(['RS256', 'ES256']).default('RS256'),
      scopes,
    })
    .strict(),

  z.object({ strategy: z.literal('mtls') }).strict(),

  z
    .object({
      strategy: z.literal('session_cookie'),
      loginUrl: z.string().url(),
      usernameField: z.string().min(1).default('username'),
      passwordField: z.string().min(1).default('password'),
      cookieName: z.string().min(1).describe('The cookie that carries the session'),
    })
    .strict(),

  z
    .object({
      strategy: z.literal('hmac_signed'),
      /**
       * ENUMERATED, NEVER ARBITRARY. Canonicalisation is where a signing scheme
       * differs between providers, and allowing a free-form expression here
       * would be the customer-authored code path the whole design excludes.
       * A provider outside this list is a ticket.
       */
      /*
       * A NAME, NOT AN ENUM. v1 listed signing schemes by provider and executed
       * none of them; this legacy reader accepts whatever an old document says,
       * and `compileV1` carries over the one scheme that is a specification.
       */
      canonicalisation: z.string().min(1).max(64).describe('Named signing scheme'),
      keyIdPlacement: placement.default('header'),
      keyIdName: z.string().min(1).max(128),
      signatureName: z.string().min(1).max(128),
    })
    .strict(),
]);

export type AuthStrategy = z.infer<typeof authStrategy>;

/**
 * The strategies a user picks from, in the order the form should list them.
 *
 * `oauth2_refresh` IS ABSENT DELIBERATELY. §4.1 lists it as a strategy, but it
 * is never something a user chooses — it is what the engine does when a token
 * expires, and its configuration is `refresh` on the three OAuth strategies
 * above. Offering it as a twelfth option would be offering a choice nobody can
 * answer.
 */

