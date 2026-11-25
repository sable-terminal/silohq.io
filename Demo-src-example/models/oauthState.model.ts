import type { Sealed } from '../utils/envelope.util';

/**
 * §4.3 — the OAuth flow's own state: the browser round trip, and the two
 * secrets a connection ends up holding.
 *
 * NOTHING HERE DECIDES ANYTHING. Whether a missing pending row is an expiry, a
 * replay or a typo is one answer given in one place, and it is the service's;
 * this file only says what the rows mean.
 */

/**
 * A browser round trip that has come back.
 *
 * THE STATE ITSELF IS NOT IN IT. Only the digest is ever stored — the state
 * travels in a URL through the provider and lands in access logs on both sides —
 * and the row is consumed by digest, so nothing downstream needs the secret.
 *
 * `initiatedBy` IS PART OF THE FLOW, NOT DECORATION. Everything the callback
 * writes is written as the person who started it, because the callback arrives
 * with no session of its own.
 */
export interface PendingOAuthFlow {
  connectionId: string;
  organisationId: string;
  initiatedBy: string;
  /** PKCE. Null for a plain authorization-code flow, held server-side for both. */
  codeVerifier: string | null;
  /** What was asked for, so §4.3's scope check has something to compare against. */
  requestedScopes: string[];
}

/**
 * A connection's sealed access and refresh tokens.
 *
 * THE SEALED SECRET IS ONE FIELD, NOT THREE, for the reason `sso.model` gives:
 * a ciphertext without the key it was wrapped under is noise, and three loose
 * fields are three chances to hand `unseal` two of them.
 *
 * `expiresAt` IS OUT HERE, BESIDE THE CIPHERTEXT AND NOT INSIDE IT. Deciding
 * whether a token needs refreshing must not require opening it — a check that
 * unwrapped a secret would put the plaintext in memory on every request whether
 * or not anything was going to be refreshed.
 */
export interface StoredOAuthToken {
  sealed: Sealed;
  expiresAt: Date | null;
}

/**
 * The OAuth application a connection acts as.
 *
 * §4.4.3 — ours for a provider we ship, the customer's for one they registered
 * themselves. It carries no expiry because a client secret does not expire on a
 * schedule; it is rotated, and rotation replaces the row.
 */
export interface StoredOAuthClient {
  sealed: Sealed;
}

/**
 * Whether a token is close enough to expiry to refresh now.
 *
 * DERIVED, NEVER STORED. An `expired` column would be a second source of truth
 * beside `expires_at` that is wrong for every second between the token lapsing
 * and something updating it — and the skew makes the answer per-caller anyway:
 * the same row is "fine" to a reader and "refresh it" to a query about to spend
 * a minute talking to the provider.
 *
 * A TOKEN WITH NO EXPIRY NEVER EXPIRES. Providers that issue one say so by
 * omitting the field, and treating the absence as "expired" would refresh on
 * every single request.
 */
export function expiring(token: StoredOAuthToken, skewSeconds: number): boolean {
  return token.expiresAt !== null && token.expiresAt.getTime() - skewSeconds * 1000 <= Date.now();
}

/**
 * WHICH INSTANCE THE CONNECTION ACTUALLY REACHED, out of whatever the provider
 * volunteered.
 *
 * READ RATHER THAN ASKED FOR. Salesforce returns `instance_url`, Slack a team,
 * Xero a tenant — so the token response's unknown fields are kept, and the field
 * to read is data rather than a branch per provider.
 *
 * DERIVED HERE BECAUSE IT IS ARITHMETIC OVER A RESPONSE, not a row: the same
 * three candidates would otherwise be written out again by anything else that
 * learns an instance, and the order they are tried in is the part that matters.
 */
export function instanceIdentifier(extra: Record<string, unknown>): string | null {
  const candidate = extra.instance_url ?? extra.tenant_id ?? extra.team_id ?? null;

  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  return candidate;
}
