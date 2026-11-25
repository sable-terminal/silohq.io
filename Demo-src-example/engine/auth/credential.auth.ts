import type { AuthStrategyV2 } from '../../schemas/connectorAuth.schema';

/**
 * A credential, opened, for the length of one request.
 *
 * ITS OWN TYPE, AND NOTHING THAT TAKES A `Scope` TAKES ONE. The evaluator's
 * `Scope` has no member this could be assigned to, so TypeScript refuses to let
 * a credential reach an expression — the first of the guards MANIFEST-V2 §2.2
 * lists, made structural rather than remembered.
 *
 * A BAG OF NAMED FIELDS. AWS-style signing wants an access key id and a secret;
 * a login wants a username and a password; mTLS wants a certificate and a key.
 * It is still one sealed blob per connection — a JSON object — opened whole
 * through the mediator.
 */
export interface Credential {
  /** The strategy the connection was set up with: which of the manifest's alternatives. */
  strategy: string;
  fields: Record<string, string>;
}

/**
 * The plaintext of a sealed credential, as a bag.
 *
 * READS EVERY CONNECTION THAT ALREADY EXISTS WITHOUT RE-SEALING IT. v1 sealed one
 * string per connection; that string is the strategy's single default field —
 * `token` for a bearer, `key` for an API key, `username:password` split on the
 * FIRST colon for Basic, because a password may contain a colon and a username
 * may not.
 */
export function credentialFrom(plaintext: string, strategy: string): Credential {
  const trimmed = plaintext.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') fields[key] = value;
      }
      return { strategy, fields };
    } catch {
      /* not JSON after all — a legacy secret that happens to start with a brace */
    }
  }

  switch (strategy) {
    case 'ssh_key': {
      /* A key or a password, told apart by its shape: a PEM block is a key. */
      const at = plaintext.indexOf(':');
      const user = at === -1 ? '' : plaintext.slice(0, at);
      const secret = at === -1 ? plaintext : plaintext.slice(at + 1);
      return { strategy, fields: { username: user, ...(secret.includes('PRIVATE KEY') ? { private_key: secret } : { password: secret }) } };
    }
    case 'basic':
    case 'session':
    case 'ws_security':
    case 'ntlm': {
      const at = plaintext.indexOf(':');
      return at === -1
        ? { strategy, fields: { password: plaintext } }
        : { strategy, fields: { username: plaintext.slice(0, at), password: plaintext.slice(at + 1) } };
    }
    case 'bearer':
      return { strategy, fields: { token: plaintext } };
    case 'api_key_header':
    case 'api_key_query':
      return { strategy, fields: { key: plaintext } };
    case 'jwt_assertion':
      return { strategy, fields: { private_key: plaintext } };
    default:
      return { strategy, fields: { secret: plaintext } };
  }
}

/** An OAuth access token, already refreshed by the OAuth service, as a credential. */
export const accessTokenCredential = (strategy: string, accessToken: string): Credential => ({
  strategy,
  fields: { access_token: accessToken },
});

/**
 * Which of the manifest's alternatives a connection uses.
 *
 * BY NAME, AND WHEN TWO ALTERNATIVES SHARE A NAME — two `all_of` combinations —
 * BY WHICH ONE THE CREDENTIAL CAN SATISFY. The connection records the strategy
 * it was connected with; the bag says which fields it has.
 */
export function chooseAlternative(
  auth: AuthStrategyV2[],
  credential: Credential | null,
  fieldsOf: (strategy: AuthStrategyV2) => string[],
): AuthStrategyV2 | null {
  if (!credential) return auth.find((one) => one.strategy === 'none') ?? null;
  const named = auth.filter((one) => one.strategy === credential.strategy);
  if (named.length <= 1) return named[0] ?? null;
  return named.find((one) => fieldsOf(one).every((field) => field in credential.fields)) ?? named[0]!;
}

/**
 * The value of a credential field under the name the strategy knows it by.
 *
 * `fields` ON A STRATEGY RENAMES, so the two parts of an `all_of` that both read
 * `username` can be given `gateway_user` and `idp_user`.
 */
export function field(credential: Credential | null, strategy: { fields?: Record<string, string> }, name: string): string | undefined {
  if (!credential) return undefined;
  const declared = strategy.fields?.[name] ?? name;
  return credential.fields[declared];
}
