import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Opaque credentials: sessions, invitations, password resets, SCIM tokens.
 *
 * OPAQUE MEANS THE VALUE CARRIES NO MEANING. Not a JWT, not an encoded id, not a
 * timestamp with a signature. A token is a lookup key and nothing else, which is
 * what makes revocation possible: the server decides on every request whether the
 * row still exists, rather than trusting a claim the holder is carrying.
 *
 * 32 BYTES, WHICH IS 256 BITS. Enough that guessing is not a strategy, and short
 * enough to fit in a URL and a cookie without wrapping.
 *
 * `randomBytes`, NOT `Math.random`. The latter is a PRNG seeded from the clock
 * and is predictable from a handful of outputs; it exists for shuffling arrays.
 */

const TOKEN_BYTES = 32;

/**
 * Base64url, so a token survives a URL, a header and a cookie unescaped.
 *
 * A password-reset token goes in a link. Standard base64 contains `+` and `/`,
 * which some mail clients rewrite and some frameworks decode differently — and a
 * token that changes in transit is a reset link that silently does not work.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * A prefixed token, so a leaked one is identifiable on sight.
 *
 * `silo_inv_...` in a support ticket or a log is obviously an invitation, which
 * means it can be revoked without working out what it was. It is the same reason
 * Stripe and GitHub prefix theirs, and it costs nothing.
 *
 * THE PREFIX IS NOT A SECRET AND NOT A CLAIM. It is a label for humans and
 * scanners; the server still looks the token up rather than parsing it.
 */
export function generatePrefixedToken(prefix: 'ses' | 'inv' | 'pwr' | 'scim' | 'sk'): string {
  return `silo_${prefix}_${generateToken()}`;
}

/**
 * A primary key.
 *
 * `randomUUID` IS v4, WHICH IS RANDOM AND NOT ORDERED. Ordered ids (v7,
 * snowflake) index better because inserts land at the end of the btree rather
 * than scattered through it — but they also encode creation time, and every id
 * here appears in a URL or an API response. A v7 id tells anybody holding it when
 * the row was made and roughly how many were made around it, which is a
 * side-channel on customer growth.
 *
 * The write volume here does not need the index locality. Where it does — the
 * audit and token ledgers — those use bigserial, which is ordered and internal.
 */
export function generateId(): string {
  return randomUUID();
}
