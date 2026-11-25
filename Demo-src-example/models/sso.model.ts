import type { Sealed } from '../utils/envelope.util';

/**
 * A customer's directory, and one sign-in through it.
 *
 * THE SEALED SECRET IS ONE FIELD, NOT THREE. `client_secret_sealed`,
 * `client_secret_wrapped` and `client_secret_key` are only meaningful together —
 * a ciphertext without the wrapped key it was encrypted under is noise — and
 * three loose fields are three chances to hand `unseal` two of them.
 */

export interface IdentityProvider {
  id: string;
  organisationId: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  /** Still encrypted here. Opening it is the service's business, not the repo's. */
  clientSecret: Sealed;
}

/**
 * What an administrator is shown.
 *
 * A DIFFERENT TYPE BECAUSE IT CARRIES NO SECRET MATERIAL, not because it is a
 * convenience. There is no endpoint that returns a client secret — an
 * administrator who needs one rotates it — and a summary that cannot hold one
 * cannot leak one through a route that forgot to pick its fields.
 */
export interface IdentityProviderSummary {
  id: string;
  name: string;
  issuer: string;
  enabled: boolean;
  domains: string[];
}

/**
 * The purpose a provider's client secret is sealed under.
 *
 * DERIVED FROM THE ID, IN ONE PLACE. The purpose is bound into the envelope, so
 * sealing and unsealing must agree exactly; the same literal written at two call
 * sites is how a secret that was successfully written stops opening. Binding it
 * to the row is also what stops a sealed secret copied into a different
 * provider's row from working there.
 */
export function clientSecretPurpose(providerId: string): string {
  return `idp:${providerId}`;
}

/**
 * An attempt, once consumed.
 *
 * `state` IS NOT A FIELD. It is the key the attempt was read by and is already
 * in the caller's hand; carrying it back would invite a second comparison
 * against a value that came from the same place.
 */
export interface SsoAttempt {
  providerId: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string | null;
}
