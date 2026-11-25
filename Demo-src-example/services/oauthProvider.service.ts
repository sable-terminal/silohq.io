import * as oauth from '../infra/oauthClient.infra';
import { withTransaction } from '../infra/db.infra';
import { seal } from '../utils/envelope.util';
import { wrapper } from '../infra/kms.infra';
import * as credentialRepo from '../repos/oauthProvider.repo';
import { lastFour } from '../utils/lastFour.util';
import { invalid } from '../utils/error.util';
import { callbackUrl } from './connectorOAuth.service';
import { childLogger } from '../config/logger.config';

const log = childLogger('oauth-provider');

/**
 * §4.4 — connecting an OAuth application Silo has no prebuilt connector for.
 *
 * THREE PATHS, TRIED IN ORDER, and the third always works:
 *
 *   1. Discovery metadata      endpoints, flows and scopes with nothing typed
 *   2. Dynamic client          RFC 7591, where the provider implements it
 *   3. Bring your own client   the customer registers the app themselves
 *
 * Path 3 is the honest enterprise answer rather than the booby prize. An IT team
 * would rather own the OAuth client acting on their tenant, because they can see
 * it and revoke it without asking us. It needs provider admin rights, which puts
 * it outside the non-technical user — who was never going to connect an unknown
 * SaaS tool unaided anyway.
 *
 * NOTHING HERE NAMES A PROVIDER. The same code reaches Salesforce, Sage and a
 * customer's internal authorisation server.
 */

/* ── Path 1: what the provider will tell us ─────────────────────────────── */

export interface ProviderInspection {
  found: boolean;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  revocationUrl: string | null;
  scopesSupported: string[];
  supportsPkce: boolean;
  supportsRefreshToken: boolean;
  /** Whether path 2 is even worth attempting. */
  supportsDynamicRegistration: boolean;
  redirectUri: string;
  guidance: string;
}

/**
 * Read-only, and deliberately returns no secret, so it is safe to put behind a
 * builder screen that anyone configuring a connector can call.
 *
 * A PROVIDER THAT PUBLISHES NOTHING IS NOT AN ERROR. Most do not. `found: false`
 * means the builder asks for the two endpoints instead of pre-filling them, and
 * the connection is no less workable for it.
 */
export async function inspectProvider(issuerUrl: string): Promise<ProviderInspection> {
  const redirectUri = callbackUrl();
  const metadata = await oauth.discover(issuerUrl);

  if (!metadata) {
    return {
      found: false,
      authorizationUrl: null,
      tokenUrl: null,
      revocationUrl: null,
      scopesSupported: [],
      supportsPkce: false,
      supportsRefreshToken: false,
      supportsDynamicRegistration: false,
      redirectUri,
      guidance:
        'This provider does not publish its OAuth configuration, which is common. ' +
        'Find the authorisation and token URLs in its API documentation, then register ' +
        `an application there with ${redirectUri} as the redirect URI.`,
    };
  }

  return {
    found: true,
    authorizationUrl: metadata.authorizationUrl,
    tokenUrl: metadata.tokenUrl,
    revocationUrl: metadata.revocationUrl,
    scopesSupported: metadata.scopesSupported,
    supportsPkce: metadata.supportsPkce,
    supportsRefreshToken: metadata.supportsRefreshToken,
    supportsDynamicRegistration: metadata.registrationUrl !== null,
    redirectUri,
    guidance: metadata.registrationUrl
      ? 'This provider can register an application automatically. You can also register ' +
        `one yourself and supply its credentials, using ${redirectUri} as the redirect URI.`
      : `Register an application with this provider using ${redirectUri} as the redirect URI, ` +
        'then supply its client ID and secret.',
  };
}

/* ── Paths 2 and 3: getting a client the connection can use ─────────────── */

export type ClientSource = 'registered' | 'bring-your-own';

export interface ProvisionResult {
  source: ClientSource;
  clientId: string;
  /** Set when path 2 was attempted and did not work, so the UI can say why. */
  registrationFailed: boolean;
}

/**
 * Give a connection an OAuth client, by whichever of paths 2 and 3 is available.
 *
 * THE SECRET NEVER LEAVES THIS FUNCTION. It is sealed into a `purpose = 'client'`
 * row on the way in and returned to nobody — not to the caller, not to the
 * builder screen, not in the result. A client secret that has been displayed
 * once has been pasted somewhere, and §4.2 is explicit that credentials are
 * write-only after entry.
 *
 * WHEN THE CUSTOMER SUPPLIES ONE, THAT WINS. Registering a second application
 * behind the back of an IT team that has already made one is how a provider ends
 * up with orphaned clients nobody will admit to owning.
 */
export async function provisionClient(input: {
  connectionId: string;
  clientName: string;
  /** Path 3, when the customer already has an application. */
  supplied?: { clientId: string; clientSecret: string };
  /** Path 2, from `inspectProvider`. Ignored when `supplied` is present. */
  issuerUrl?: string;
}): Promise<ProvisionResult> {
  if (input.supplied) {
    const { clientId, clientSecret } = input.supplied;
    if (!clientId.trim() || !clientSecret.trim()) {
      throw invalid({
        message: 'Both the client ID and the client secret are needed.',
        code: 'invalid.client_incomplete',
      });
    }
    await storeClient(input.connectionId, clientId.trim(), clientSecret.trim());
    return { source: 'bring-your-own', clientId: clientId.trim(), registrationFailed: false };
  }

  if (!input.issuerUrl) {
    throw invalid({
      message: 'Supply the OAuth application credentials, or an issuer URL to register one against.',
      code: 'invalid.no_client_source',
    });
  }

  const metadata = await oauth.discover(input.issuerUrl);
  const registered = metadata?.registrationUrl
    ? await oauth.registerClient({
        registrationUrl: metadata.registrationUrl,
        redirectUri: callbackUrl(),
        clientName: input.clientName,
      })
    : null;

  /*
   * PATH 2 FAILING IS THE ORDINARY OUTCOME, not an error. Coverage of RFC 7591
   * is patchy and a provider may advertise a registration endpoint that refuses
   * unauthenticated callers. The caller is told it did not work so the builder
   * can ask for a client instead — the flow continues at path 3.
   */
  if (!registered) {
    log.info({ connectionId: input.connectionId }, 'Dynamic registration unavailable, falling back');
    throw invalid({
      message:
        'This provider would not register an application automatically. Register one yourself ' +
        `using ${callbackUrl()} as the redirect URI, then supply its client ID and secret.`,
      code: 'invalid.registration_unavailable',
    });
  }

  await storeClient(input.connectionId, registered.clientId, registered.clientSecret);
  return { source: 'registered', clientId: registered.clientId, registrationFailed: false };
}

async function storeClient(
  connectionId: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const sealed = await seal(
    JSON.stringify({ clientId, clientSecret }),
    wrapper(),
    `client:${connectionId}`,
  );

  await withTransaction(async (db) => {
    await credentialRepo.upsertClient(db, {
      connectionId,
      sealed,
      // `0000` rather than a null: a secret too short to take four characters
      // from still needs a row, and a screen still needs something to print.
      lastFour: lastFour(clientSecret) ?? '0000',
    });
  });
}
