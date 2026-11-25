import { createHash, createPublicKey, createVerify, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Verifying what an identity provider says.
 *
 * THIS IS AN AUTHORISATION DECISION THAT HAPPENS TO PARSE JSON, which is why it
 * lives in utils rather than beside the HTTP calls that fetch the token. Every
 * check below is the difference between "this directory vouched for this person"
 * and "somebody sent us a string".
 *
 * ── The four ways this goes wrong ───────────────────────────────────────────
 *
 * `alg: "none"`. The original JWT footgun: a token that says it needs no
 * signature, accepted by a verifier that believes the token about itself. The
 * algorithm is pinned here and the header's claim is only ever compared against
 * it, never followed.
 *
 * ALGORITHM CONFUSION. A verifier that picks its algorithm from the header can
 * be handed `HS256` and an RSA public key — which is public — as the HMAC
 * secret, and will happily verify a token the attacker signed. Pinning RS256
 * closes it.
 *
 * THE UNCHECKED `iss`. Signature validity proves a key signed the token, not
 * that it was the right directory. Without an issuer check, a token from any
 * provider the attacker can register with is a valid login.
 *
 * THE UNCHECKED `nonce`. Without it a token captured from one sign-in can be
 * replayed into another, because nothing ties the token to the request that
 * asked for it.
 */

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
}

export class TokenRejected extends Error {
  constructor(readonly reason: string) {
    super(`The identity provider's token was rejected: ${reason}`);
    this.name = 'TokenRejected';
  }
}

const b64urlDecode = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const b64urlEncode = (value: Buffer): string =>
  value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier: high-entropy, and never leaves this server. */
export function createCodeVerifier(): string {
  return b64urlEncode(randomBytes(32));
}

/**
 * The challenge the provider sees.
 *
 * S256 ONLY. The `plain` method sends the verifier itself, which makes PKCE
 * decorative — anybody who can see the authorization request can replay it.
 */
export function codeChallengeFor(verifier: string): string {
  return b64urlEncode(createHash('sha256').update(verifier).digest());
}

export function createState(): string {
  return b64urlEncode(randomBytes(32));
}

export function createNonce(): string {
  return b64urlEncode(randomBytes(32));
}

/** Constant-time, and length-checked first so the comparison cannot throw. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verify a compact JWS and return its claims.
 *
 * THE SIGNATURE IS CHECKED BEFORE ANYTHING ELSE IS BELIEVED. The payload is
 * parsed first only because the header names which key to use — nothing read out
 * of it is acted on until the bytes are proven.
 */
export function verifyIdToken(
  idToken: string,
  expected: {
    /**
     * The exact issuer, or a pattern for the providers whose issuer is not
     * fixed.
     *
     * A PATTERN IS NOT A WILDCARD AND MUST NEVER BECOME ONE. Microsoft's
     * `common` endpoint mints tokens whose `iss` names the signing-in user's own
     * tenant guid, so no literal ever matches — but "accept anything" would
     * accept a token from a directory the attacker controls. The pattern is
     * anchored and names the guid's shape, so it admits Microsoft tenants and
     * nothing else.
     */
    issuer: string | RegExp;
    audience: string;
    nonce: string;
    keys: readonly Jwk[];
    now?: Date;
  },
): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new TokenRejected('not a compact JWS');

  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: { alg?: string; kid?: string; typ?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(b64urlDecode(headerPart).toString('utf8')) as typeof header;
    claims = JSON.parse(b64urlDecode(payloadPart).toString('utf8')) as IdTokenClaims;
  } catch {
    throw new TokenRejected('malformed');
  }

  /*
   * PINNED, NOT READ. `alg: "none"` and the HS256-with-an-RSA-public-key
   * confusion both depend on a verifier that takes its instructions from the
   * token. This compares and refuses.
   */
  if (header.alg !== 'RS256') {
    throw new TokenRejected(`unsupported algorithm ${header.alg ?? 'none'}`);
  }

  const candidates = expected.keys.filter(
    (key) =>
      key.kty === 'RSA' &&
      (key.use === undefined || key.use === 'sig') &&
      (header.kid === undefined || key.kid === undefined || key.kid === header.kid),
  );

  if (candidates.length === 0) throw new TokenRejected('no matching signing key');

  const signature = b64urlDecode(signaturePart);
  const signed = Buffer.from(`${headerPart}.${payloadPart}`, 'ascii');

  const verified = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      return createVerify('RSA-SHA256').update(signed).verify(key, signature);
    } catch {
      // A malformed key in the set must not abort the others.
      return false;
    }
  });

  if (!verified) throw new TokenRejected('signature does not verify');

  // ── Only now is anything in the payload believed ──────────────────────────

  const issuerOk =
    expected.issuer instanceof RegExp
      ? expected.issuer.test(claims.iss)
      : claims.iss === expected.issuer;

  if (!issuerOk) {
    throw new TokenRejected('issued by a different directory');
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) {
    // A token minted for a different client, replayed at ours.
    throw new TokenRejected('not addressed to this application');
  }

  if (!claims.nonce || !equals(claims.nonce, expected.nonce)) {
    throw new TokenRejected('nonce does not match this sign-in');
  }

  const now = Math.floor((expected.now?.getTime() ?? Date.now()) / 1000);
  // 60 seconds, for clock skew between us and the provider. Generous enough to
  // stop spurious failures and far short of useful for a replay.
  const leeway = 60;

  if (typeof claims.exp !== 'number' || claims.exp + leeway < now) {
    throw new TokenRejected('expired');
  }
  if (typeof claims.iat === 'number' && claims.iat - leeway > now) {
    throw new TokenRejected('issued in the future');
  }
  if (!claims.sub) throw new TokenRejected('no subject');

  return claims;
}

/**
 * The domain an address belongs to.
 *
 * SPLIT ON THE LAST `@`, not the first. An address may legally contain a quoted
 * local part with an `@` in it, and taking the first one hands back a domain
 * that is really part of somebody's name — which is then matched against the
 * provider allow-list.
 */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Where to send somebody after signing in.
 *
 * A LOCAL PATH OR NOTHING. `return_to` arrives from the browser, and an
 * unchecked one turns the sign-in endpoint into an open redirect that borrows
 * this domain's credibility to land on somebody else's. `//evil.example` is the
 * case that catches naive checks: it starts with a slash and is not local.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}
