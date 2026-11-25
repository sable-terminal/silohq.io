import type { Sealed } from '../utils/envelope.util';

/**
 * Second factors.
 *
 * THE SEALED SECRET IS ONE FIELD, NOT THREE, for the reason `sso.model` gives
 * about a client secret: a ciphertext, the data key it was encrypted under and
 * the reference to the key that wrapped that are only meaningful together, and
 * three loose fields are three chances to hand `unseal` two of them.
 *
 * ONLY TOTP IS MODELLED. The table's `kind` check allows `webauthn` too, and
 * nothing enrols one yet — a `WebauthnFactor` written now would be a guess at
 * which columns it needs, and the guess would be in the one file every other
 * layer takes its shape from.
 *
 * AN UNCONFIRMED FACTOR SATISFIES NOTHING, which is why `confirmedAt` is a field
 * and not an inference from whether a secret exists. Somebody who starts
 * enrolling and abandons it leaves a row behind; treating that as a factor would
 * let a user appear to have MFA they never finished setting up, and then be
 * locked out by an organisation that requires it.
 */

export type MfaKind = 'totp' | 'webauthn';

export interface TotpFactor {
  id: string;
  userId: string;
  kind: 'totp';
  /** Still sealed. Opening it is the service's business, not the repo's. */
  secret: Sealed;
  confirmedAt: Date | null;
  createdAt: Date;
}

/**
 * The purpose a factor's secret is sealed under.
 *
 * DERIVED FROM THE ID, IN ONE PLACE. The purpose is authenticated by the
 * envelope, so sealing and unsealing must agree exactly; the same literal
 * written at three call sites — which is what this replaced — is how a secret
 * that was successfully written stops opening. Binding it to the row is also
 * what stops a sealed secret copied into another user's factor from working
 * there.
 */
export function secretPurpose(factorId: string): string {
  return `mfa:${factorId}`;
}
