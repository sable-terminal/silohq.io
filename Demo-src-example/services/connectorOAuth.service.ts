import { createHash } from 'node:crypto';
import { env } from '../config/env.config';
import type { Executor } from '../infra/db.infra';
import { withTransaction } from '../infra/db.infra';
import { wrapper } from '../infra/kms.infra';
import { requireTenant, runUntenanted, runWithTenant } from '../utils/tenantContext.util';
import { withoutTenant } from '../infra/db.infra';
import { seal } from '../utils/envelope.util';
import { withSecret } from '../utils/mediator.util';
import { credentialAccessLog } from '../utils/credentialAudit.util';
import { log as writeAudit } from './audit.service';
import { childLogger } from '../config/logger.config';
import { denial, invalid, notFound, upstream } from '../utils/error.util';
import { lastFour } from '../utils/lastFour.util';
import {
  codeChallengeFor,
  createCodeVerifier,
  createState,
} from '../utils/oidc.util';
import { pinConnection } from './connectionPins.service';
import * as oauthState from '../repos/oauthState.repo';
import { expiring, instanceIdentifier } from '../models/oauthState.model';
import type { StoredOAuthToken } from '../models/oauthState.model';
import * as oauth from '../infra/oauthClient.infra';
import type { AuthStrategy } from '../schemas/connectorAuth.schema';
import type { Manifest } from '../schemas/manifest.schema';
import { every, text } from '../engine/expression/evaluate.expression';
import { paramsFor } from '../engine/read/params.read';

const log = childLogger('connector-oauth');

/**
 * OAuth for connectors. One engine, every provider.
 *
 * ── The four failure modes §4.3 says are not per-provider ───────────────────
 *
 * Every one of these is built once, here, and none of them is a branch on which
 * system is being talked to.
 *
 *   Token expiry mid-query      refreshed transparently, before it bites
 *   Concurrent refresh          serialised by an advisory lock
 *   Rotated refresh tokens      the new one replaces the old atomically
 *   Refresh failure             an auth error requiring reconnection, never an
 *                               empty result
 */

export const callbackUrl = (): string => `${env.API_URL}/api/connections/oauth/callback`;

const hashState = (state: string): string => createHash('sha256').update(state).digest('hex');

/** The three OAuth strategies, narrowed out of the eleven. */
type OAuthStrategy = Extract<
  AuthStrategy,
  { strategy: 'oauth2_authorization_code' | 'oauth2_pkce' | 'oauth2_client_credentials' }
>;

/** The OAuth part of the manifest's auth, alone or inside an `all_of`. */
function oauthStrategyOf(manifest: Manifest): OAuthStrategy | null {
  const parts = manifest.auth.flatMap((a) => (a.strategy === 'all_of' ? a.parts : [a]));
  return (
    (parts.find((a) => ['oauth2_authorization_code', 'oauth2_pkce', 'oauth2_client_credentials'].includes(a.strategy)) as
      | OAuthStrategy
      | undefined) ?? null
  );
}

/**
 * The strategy's endpoints and parameters, worked out for THIS connection.
 *
 * EXPRESSIONS OVER PARAMS, because the authorisation server is per tenant for
 * the systems that most need a prebuilt connector — a region, an Okta domain, a
 * sandbox, a shop (finding F36). `authorizationParams` is how a provider that
 * issues no refresh token without `access_type=offline` keeps working after an
 * hour (F37).
 */
interface Resolved {
  authorizationUrl: string | null;
  tokenUrl: string;
  authorizationParams: Record<string, string>;
  tokenParams: Record<string, string>;
  clientAuth: 'body' | 'basic';
}

async function resolve(strategy: OAuthStrategy, manifest: Manifest, parameters: Record<string, string>): Promise<Resolved> {
  const params = paramsFor(manifest, parameters, null);
  const scope = { params };
  const required = async (source: string, what: string) => {
    const worked = await text(source, scope);
    if (!worked) throw invalid({ message: `This connection's ${what} came to nothing. Check its settings.`, code: 'invalid.oauth_endpoint' });
    return worked;
  };
  const strings = async (map: Record<string, string>) =>
    Object.fromEntries(Object.entries(await every(map, scope)).map(([k, v]) => [k, String(v)]));
  return {
    authorizationUrl: 'authorizationUrl' in strategy.endpoints ? await required(strategy.endpoints.authorizationUrl, 'authorisation address') : null,
    tokenUrl: await required(strategy.endpoints.tokenUrl, 'token address'),
    authorizationParams: 'authorizationParams' in strategy ? await strings(strategy.authorizationParams) : {},
    tokenParams: await strings(strategy.tokenParams),
    clientAuth: strategy.clientAuth,
  };
}

/* ── Starting a flow ────────────────────────────────────────────────────── */

export async function begin(input: {
  organisationId: string;
  membershipId: string;
  connectionId: string;
  manifest: Manifest;
}): Promise<{ redirectTo: string }> {
  const strategy = oauthStrategyOf(input.manifest);

  if (!strategy || strategy.strategy === 'oauth2_client_credentials') {
    /*
     * CLIENT CREDENTIALS HAS NO BROWSER STEP. There is nothing to redirect to
     * and nobody to approve — offering a redirect would send somebody to a page
     * that cannot exist.
     */
    throw invalid({
      message: 'This connector does not use a browser-based OAuth flow.',
      code: 'invalid.not_authorization_code',
    });
  }

  const state = createState();
  const verifier = createCodeVerifier();

  return runWithTenant(
    { organisationId: input.organisationId, membershipId: input.membershipId },
    async () =>
      withTransaction(async (db) => {
        await oauthState.insertPending(db, {
          // Only the hash: the state travels in a URL through the provider and
          // lands in access logs on both sides.
          stateHash: hashState(state),
          connectionId: input.connectionId,
          organisationId: input.organisationId,
          initiatedBy: input.membershipId,
          codeVerifier: strategy.strategy === 'oauth2_pkce' ? verifier : null,
          requestedScopes: strategy.scopes,
        });

        /*
         * THE CONNECTION'S OWN MANIFEST, AS STORED AND COMPILED, with its own
         * parameters: the endpoints are worked out for this connection, not for
         * whatever document the caller happened to hold.
         */
        const loaded = await oauthState.manifestFor(db, input.connectionId);
        const own = loaded ? oauthStrategyOf(loaded.manifest) : null;
        const endpoints = await resolve(own ?? strategy, loaded?.manifest ?? input.manifest, loaded?.parameters ?? {});
        const url = new URL(endpoints.authorizationUrl!);
        for (const [name, value] of Object.entries(endpoints.authorizationParams)) url.searchParams.set(name, value);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', await clientIdFor(db, input.connectionId, strategy));
        url.searchParams.set('redirect_uri', callbackUrl());
        url.searchParams.set('state', state);
        if (strategy.scopes.length > 0) url.searchParams.set('scope', strategy.scopes.join(' '));

        if (strategy.strategy === 'oauth2_pkce') {
          url.searchParams.set('code_challenge', codeChallengeFor(verifier));
          // S256 only. `plain` sends the verifier itself, which makes PKCE
          // decorative — anybody who can see the request can replay it.
          url.searchParams.set('code_challenge_method', 'S256');
        }

        /*
         * THE OUTER TRANSACTION, NOT A SECOND ONE. This opened its own
         * `withTransaction` while the enclosing one was still held, so every
         * in-flight OAuth start took TWO connections from a pool of ten. Five
         * concurrent setups exhaust it, and the sixth waits for a connection
         * that cannot be released — because the holder is itself waiting for
         * one. A deadlock rather than a queue, on a path customers hit while
         * connecting a system for the first time.
         *
         * It also made the pending state and its audit row two separate
         * transactions: a crash between them left a state nobody could explain
         * the origin of.
         */
        await writeAudit(db, {
          event: 'oauth_flow_started',
          organisationId: input.organisationId,
          membershipId: input.membershipId,
          userId: null,
          detail: {
            connectionId: input.connectionId,
            provider: input.manifest.identity.provider,
            requestedScopes: strategy.scopes,
          },
        });

        return { redirectTo: url.toString() };
      }),
  );
}

/* ── Finishing it ───────────────────────────────────────────────────────── */

export interface CompletedFlow {
  connectionId: string;
  organisationId: string;
  grantedScopes: string[];
  missingScopes: string[];
}

export async function complete(input: { state: string; code: string }): Promise<CompletedFlow> {
  /*
   * CONSUMED FIRST, AND IN ONE STATEMENT. A replayed callback finds nothing.
   * `SECURITY DEFINER` because this arrives as a browser navigation carrying
   * only a state — which organisation it belongs to is what the state tells us.
   */
  const pending = await runUntenanted('login-lookup', async () =>
    withoutTenant(async (db) => oauthState.consumePending(db, hashState(input.state))),
  );

  if (!pending) {
    // One answer for unknown, expired and already-used: telling them apart tells
    // whoever is replaying a captured callback which of those it was.
    throw invalid({
      message: 'That connection attempt has expired or was already completed. Start again.',
      code: 'invalid.oauth_state',
    });
  }

  return runWithTenant(
    { organisationId: pending.organisationId, membershipId: pending.initiatedBy },
    async () =>
      withTransaction(async (db) => {
        const { manifest, strategy, endpoints } = await manifestFor(db, pending.connectionId);

        const tokens = await withClient(db, pending.connectionId, strategy, (clientId, secret) =>
          oauth.exchangeCode({
            tokenUrl: endpoints.tokenUrl,
            clientAuth: endpoints.clientAuth,
            extra: endpoints.tokenParams,
            clientId,
            clientSecret: secret,
            code: input.code,
            redirectUri: callbackUrl(),
            codeVerifier: pending.codeVerifier,
          }),
        ).catch(translate);

        /*
         * §4.3 SCOPE VERIFICATION, IMMEDIATELY AFTER EXCHANGE. A provider that
         * granted less than was asked for produces a connector that works until
         * somebody asks the question needing the missing scope, weeks later, and
         * gets a 403 from inside a query. Reported by name, now.
         *
         * NOT FATAL. A connector missing one scope still answers everything
         * else, and §5's partial-success principle applies to permissions as
         * much as to objects.
         */
        const granted = new Set(tokens.grantedScopes);
        const missing =
          tokens.grantedScopes.length === 0
            ? []
            : pending.requestedScopes.filter((s) => !granted.has(s));

        if (missing.length > 0) {
          log.warn(
            { connectionId: pending.connectionId, missing },
            'Provider granted fewer scopes than requested',
          );

          /*
           * AUDITED, NOT JUST LOGGED. A connection short of a scope answers most
           * questions and fails one — weeks later, on a table nobody connects to
           * this moment. The trail is what connects them.
           */
          await writeAudit(db, {
            event: 'oauth_scope_missing',
            organisationId: pending.organisationId,
            membershipId: pending.initiatedBy,
            userId: null,
            detail: {
              connectionId: pending.connectionId,
              requested: pending.requestedScopes,
              granted: tokens.grantedScopes,
            },
          });
        }

        await storeTokens(db, pending.connectionId, strategy.strategy, tokens);
        await resolveInstance(db, pending.connectionId, manifest, tokens);
        /* Finishing the consent screen is the confirmation of where the token may go (§9.2). */
        await pinConnection(db, { organisationId: pending.organisationId, membershipId: pending.initiatedBy, connectionId: pending.connectionId, credential: null });

        await oauthState.markVerified(db, pending.connectionId);

        await writeAudit(db, {
          event: 'oauth_flow_completed',
          organisationId: pending.organisationId,
          membershipId: pending.initiatedBy,
          userId: null,
          detail: {
            connectionId: pending.connectionId,
            grantedScopes: tokens.grantedScopes,
            missingScopes: missing,
          },
        });

        return {
          connectionId: pending.connectionId,
          organisationId: pending.organisationId,
          grantedScopes: tokens.grantedScopes,
          missingScopes: missing,
        };
      }),
  );
}

/* ── Keeping it alive ───────────────────────────────────────────────────── */

/**
 * A usable access token, refreshing first if it is about to expire.
 *
 * ── The lock is the point of this function ──────────────────────────────────
 *
 * `pg_advisory_xact_lock` KEYED ON THE CONNECTION. Two queries against the same
 * connection arriving as a token expires both see it expiring, both refresh, and
 * for a provider that ROTATES the refresh token the second exchange invalidates
 * the first — leaving a stored token that no longer works and a connection
 * locked out until somebody reconnects it by hand.
 *
 * The lock is held for the transaction, so the second caller waits, then reads
 * the row the first one wrote and finds a fresh token. That re-read is not
 * optional: a caller that decided the token was expiring BEFORE queuing for the
 * lock and then refreshed anyway once it got in has reproduced the exact bug the
 * lock exists to prevent.
 *
 * ── Why this owns its transaction rather than borrowing the caller's ────────
 *
 * A refresh makes a network call to the provider, and `use` usually makes
 * another to the data source. Running those inside a caller's transaction pins a
 * pool connection and holds the advisory lock for the length of both. Owning a
 * short transaction, and calling `use` after it has closed, keeps the lock to
 * the refresh itself.
 *
 * It also makes the failure count survivable. Postgres has no autonomous
 * transactions, so a count incremented inside a transaction that then throws is
 * rolled back with it — a connection failing every refresh would sit at zero
 * forever and never reach the threshold that halts it. Owning the transaction
 * means the failure can be recorded, committed, and only then thrown.
 *
 * REFRESHED BEFORE EXPIRY, NOT ON FAILURE. `refreshSkewSeconds` exists so a
 * token that expires mid-flight is refreshed a minute early rather than
 * producing one failed request that has to be understood and retried.
 */
export async function accessTokenFor<T>(
  connectionId: string,
  use: (accessToken: string) => Promise<T>,
): Promise<T> {
  /*
   * The unlocked read. Nearly every call lands here, on a token with hours left,
   * and takes no lock and makes no network call.
   */
  const first = await withTransaction(async (db) => {
    const { strategy } = await manifestFor(db, connectionId);
    const skew = 'refresh' in strategy ? strategy.refresh.refreshSkewSeconds : 60;
    return { stored: await loadToken(db, connectionId), skew };
  });

  if (!expiring(first.stored, first.skew)) {
    return unsealAndUse(connectionId, first.stored, use);
  }

  const outcome = await withTransaction(async (db) => {
    await oauthState.lockForRefresh(db, connectionId);

    /*
     * RE-READ UNDER THE LOCK. Whoever held it before us may have refreshed
     * already, and using the row we read outside the lock would refresh a second
     * time against a token that has just been rotated away.
     */
    const { strategy, endpoints } = await manifestFor(db, connectionId);
    const skew = 'refresh' in strategy ? strategy.refresh.refreshSkewSeconds : 60;
    const stored = await loadToken(db, connectionId);

    if (!expiring(stored, skew)) return { refreshed: false, stored } as const;

    try {
      const tokens = await refreshNow(db, connectionId, strategy, stored, endpoints);

      await writeAudit(db, {
        event: 'token_refreshed',
        organisationId: requireTenant('token-refresh').organisationId,
        membershipId: requireTenant('token-refresh').membershipId ?? null,
        userId: null,
        detail: { connectionId, expiresAt: tokens.expiresAt?.toISOString() ?? null },
      });

      return { refreshed: true, accessToken: tokens.accessToken } as const;
    } catch (error: unknown) {
      await oauthState.countRefreshFailure(db, connectionId);

      /*
       * IN THE SAME TRANSACTION AS THE COUNT, and for the same reason it is
       * returned rather than thrown below: both have to survive, or a connection
       * failing every refresh leaves neither a count nor a trail.
       */
      await writeAudit(db, {
        event: 'token_refresh_failed',
        organisationId: requireTenant('token-refresh').organisationId,
        membershipId: requireTenant('token-refresh').membershipId ?? null,
        userId: null,
        detail: {
          connectionId,
          reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        },
      });
      /*
       * RETURNED, NOT THROWN, so the transaction commits the count. The error is
       * raised below, once it is safely recorded.
       */
      return { refreshed: false, failure: error } as const;
    }
  });

  if ('failure' in outcome) throw translate(outcome.failure);
  /*
   * THE RESULT TRAVELS, THE TOKEN DOES NOT. `use` is still the only thing that
   * ever sees the access token — this returns what the CALLER computed with it,
   * which is what lets a query be wrapped in a refresh rather than having to
   * fetch a token, hold it, and pass it around.
   */
  if (outcome.refreshed) return use(outcome.accessToken);

  return unsealAndUse(connectionId, outcome.stored, use);
}

/**
 * A connection with no token row cannot be used, and that is a decision.
 *
 * THE REPO RETURNS NULL AND THIS TURNS IT INTO A REFUSAL — "reconnect it" is an
 * answer about the caller, and whether a missing token is that or something a
 * sweeper should notice is not the same question everywhere.
 */
async function loadToken(db: Executor, connectionId: string): Promise<StoredOAuthToken> {
  const stored = await oauthState.readToken(db, connectionId);

  if (!stored) {
    throw denial({
      message: 'This connection has no token. Reconnect it.',
      code: 'denial.no_token',
    });
  }
  return stored;
}

function unsealAndUse<T>(
  connectionId: string,
  stored: StoredOAuthToken,
  use: (accessToken: string) => Promise<T>,
): Promise<T> {
  return withSecret(
    stored.sealed,
    { wrapper: wrapper(), log: accessLog },
    { reason: 'connector-request', subject: connectionId, additionalData: `connection:${connectionId}` },
    async (plaintext) => use(JSON.parse(plaintext).accessToken as string),
  );
}

async function refreshNow(
  db: Executor,
  connectionId: string,
  strategy: OAuthStrategy,
  stored: StoredOAuthToken,
  endpoints: Resolved,
): Promise<oauth.TokenSet> {
  const current = await withSecret(
    stored.sealed,
    { wrapper: wrapper(), log: accessLog },
    { reason: 'credential-rotation', subject: connectionId, additionalData: `connection:${connectionId}` },
    async (plaintext) => JSON.parse(plaintext) as { accessToken: string; refreshToken: string | null },
  );

  if (!current.refreshToken) {
    throw denial({
      message: 'This connection cannot be refreshed and must be reconnected.',
      code: 'denial.no_refresh_token',
    });
  }

  const tokens = await withClient(db, connectionId, strategy, (clientId, secret) =>
    oauth.refresh({
      tokenUrl: endpoints.tokenUrl,
      clientAuth: endpoints.clientAuth,
      extra: endpoints.tokenParams,
      clientId,
      clientSecret: secret,
      refreshToken: current.refreshToken!,
    }),
  );

  /*
   * ROTATION. A provider that issues a new refresh token invalidates the old
   * one, so the stored copy must be replaced — keeping the old one locks the
   * connection out permanently at the NEXT refresh, hours later, with nothing in
   * the logs connecting the failure to this moment.
   *
   * A provider that does NOT rotate returns no refresh token, and the old one
   * stays valid. Overwriting it with null would be the same lockout by a
   * different route, which is why the manifest declares which kind it is.
   */
  await storeTokens(db, connectionId, strategy.strategy, {
    ...tokens,
    refreshToken: tokens.refreshToken ?? current.refreshToken,
  });

  return tokens;
}


/* ── Storage ────────────────────────────────────────────────────────────── */

/**
 * OAuth opens two different secrets and both are audited. The client secret is
 * touched on every refresh and the token on every request, and a trail that
 * showed only one of them would be answering a different question from the one
 * a review asks.
 */
const audit = credentialAccessLog();

const accessLog = {
  async record(entry: Parameters<typeof audit.record>[0]) {
    log.info(
      { reason: entry.reason, connectionId: entry.subject, outcome: entry.outcome },
      'Connector credential unwrapped',
    );
    await audit.record(entry);
  },
};

async function storeTokens(
  db: Executor,
  connectionId: string,
  strategy: string,
  tokens: oauth.TokenSet,
): Promise<void> {
  /*
   * BOTH TOKENS IN ONE SEALED VALUE, and separate from the client secret. They
   * share a lifetime and are rotated together, so splitting them would mean two
   * unwraps per refresh and a window where one is new and the other is not.
   */
  const sealed = await seal(
    JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
    wrapper(),
    `connection:${connectionId}`,
  );

  await oauthState.upsertToken(db, {
    connectionId,
    strategy,
    sealed,
    lastFour: lastFour(tokens.accessToken) ?? '0000',
    grantedScopes: tokens.grantedScopes,
    expiresAt: tokens.expiresAt,
  });
}

/**
 * Use the client credentials, whether they are ours or the customer's.
 *
 * §4.4.3: for a provider we have never heard of, the customer registers an
 * application in their own account and the client is theirs. Either way the
 * secret is sealed in a `purpose = 'client'` row and reached through the
 * mediator — the engine does not know or care whose application it is acting as.
 */
async function withClient<T>(
  db: Executor,
  connectionId: string,
  strategy: OAuthStrategy,
  use: (clientId: string, clientSecret: string) => Promise<T>,
): Promise<T> {
  const stored = await oauthState.readClient(db, connectionId);

  if (!stored) {
    throw denial({
      message: 'This connection has no OAuth application configured.',
      code: 'denial.no_oauth_client',
    });
  }

  return withSecret(
    stored.sealed,
    { wrapper: wrapper(), log: accessLog },
    { reason: 'connector-request', subject: connectionId, additionalData: `client:${connectionId}` },
    async (plaintext) => {
      const { clientId, clientSecret } = JSON.parse(plaintext) as {
        clientId: string;
        clientSecret: string;
      };
      return use(clientId, clientSecret);
    },
  );
}

async function clientIdFor(
  db: Executor,
  connectionId: string,
  strategy: OAuthStrategy,
): Promise<string> {
  return withClient(db, connectionId, strategy, async (clientId) => clientId);
}

/**
 * WHICH INSTANCE THIS CONNECTION ACTUALLY REACHED.
 *
 * Read from whatever the provider volunteered rather than asked for — Salesforce
 * returns `instance_url`, Slack a `team`, Xero a tenant list. The field to read
 * is per connector rather than a branch here, which is why the token response's
 * unknown fields are kept.
 */
async function resolveInstance(
  db: Executor,
  connectionId: string,
  manifest: Manifest,
  tokens: oauth.TokenSet,
): Promise<void> {
  const candidate = instanceIdentifier(tokens.extra);

  if (candidate === null) return;

  await oauthState.recordSourceInstance(db, connectionId, candidate.slice(0, 256));
}

async function manifestFor(
  db: Executor,
  connectionId: string,
): Promise<{ manifest: Manifest; strategy: OAuthStrategy; endpoints: Resolved }> {
  const loaded = await oauthState.manifestFor(db, connectionId);

  if (!loaded) throw notFound({ message: 'No such connection.', code: 'missing.connection' });
  const manifest = loaded.manifest;

  const strategy = oauthStrategyOf(manifest);
  if (!strategy) {
    throw invalid({
      message: 'This connector does not use OAuth.',
      code: 'invalid.not_oauth',
    });
  }

  return { manifest, strategy, endpoints: await resolve(strategy, manifest, loaded.parameters) };
}

/**
 * A provider's refusal, in the taxonomy.
 *
 * §4.3: A REFRESH FAILURE IS AN AUTH ERROR REQUIRING RECONNECTION, NEVER AN
 * EMPTY RESULT. Returning nothing would look like a system with no records,
 * which is the worst possible way for an expired credential to present.
 */
function translate(error: unknown): never {
  if (!(error instanceof oauth.OAuthFailure)) {
    throw upstream({ message: 'The provider could not be reached.', code: 'upstream.oauth' });
  }

  switch (error.kind) {
    case 'invalid_grant':
      throw denial({
        message: 'This connection is no longer authorised. Reconnect it.',
        code: 'denial.reconnect_required',
      });
    case 'invalid_client':
      throw denial({
        message: 'The OAuth application for this connection was rejected. Check its credentials.',
        code: 'denial.oauth_client_rejected',
      });
    case 'rate_limited':
      throw upstream({
        message: 'The provider is rate limiting. Try again shortly.',
        code: 'upstream.oauth_rate_limited',
        detail: { retryAfterMs: error.retryAfterMs },
      });
    default:
      throw upstream({ message: error.message, code: 'upstream.oauth' });
  }
}
