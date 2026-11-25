import type { KeyWrapper, Sealed } from './envelope.util';
import { unseal } from './envelope.util';

/**
 * The only way plaintext credentials are reachable.
 *
 * IT HANDS THE VALUE TO A CALLBACK RATHER THAN RETURNING IT. A function that
 * returns a secret puts it in a variable the caller owns — which ends up in a
 * closure, an error object, a retry captured by a logger, or a request context
 * that gets serialised. Scoping it to a callback does not make that impossible,
 * but it makes the lifetime visible and short, and it means "where can this
 * value be" has a readable answer.
 *
 * EVERY UNWRAP IS LOGGED WITH A REASON FROM A CLOSED SET. Free text would be
 * written once and then copy-pasted, and the audit question "why was this
 * credential read 4,000 times last night" would have 4,000 different answers.
 */

export type AccessReason =
  | 'connector-request'
  | 'connection-verify'
  | 'credential-rotation'
  | 'mfa-verify'
  | 'idp-metadata-load'
  | 'scim-request'
  | 'watch-pickup';

export interface AccessLog {
  /*
   * MAY RETURN A PROMISE, AND `withSecret` AWAITS IT. The record for a credential
   * open belongs in the audit trail rather than in a log line, and that is a
   * write — a synchronous signature would force it to be fired and forgotten,
   * which means a failure to record an access is invisible. §11's stance is that
   * an unrecorded privileged action should fail rather than quietly succeed.
   */
  record(entry: {
    reason: AccessReason;
    subject: string;
    at: Date;
    outcome: 'used' | 'failed';
  }): void | Promise<void>;
}

export interface MediatorOptions {
  wrapper: KeyWrapper;
  log: AccessLog;
}

/**
 * Open a secret, use it, and let it go.
 *
 * THE CALLBACK'S RESULT IS RETURNED, THE PLAINTEXT IS NOT. A caller that wants to
 * keep the secret has to work at it — returning the plaintext from the callback
 * is possible and obvious in review, which is the point.
 *
 * A THROW IS RECORDED AS `failed` AND RETHROWN — from the unsealing as well as
 * from the callback. Recording only successes means an attacker probing with a
 * stolen sealed value leaves no trace.
 *
 * THE UNSEALING USED TO SIT OUTSIDE THE `try`, which left exactly the hole this
 * paragraph describes: a tampered ciphertext, a wrong additional-data binding or
 * a refusal from the key service threw before anything was written, so the one
 * attempt worth seeing in a trail was the only one that produced no row. The
 * comment was right and the code was not.
 */
export async function withSecret<T>(
  sealed: Sealed,
  options: MediatorOptions,
  context: { reason: AccessReason; subject: string; additionalData?: string },
  use: (plaintext: string) => Promise<T>,
): Promise<T> {
  try {
    const plaintext = await unseal(sealed, options.wrapper, context.additionalData);
    const result = await use(plaintext);
    await options.log.record({
      reason: context.reason,
      subject: context.subject,
      at: new Date(),
      outcome: 'used',
    });
    return result;
  } catch (error) {
    await options.log.record({
      reason: context.reason,
      subject: context.subject,
      at: new Date(),
      outcome: 'failed',
    });
    throw error;
  }
}
