import type { Executor } from '../infra/db.infra';
import type { Sealed } from '../utils/envelope.util';
import { generateId } from '../utils/tokens.util';

/**
 * The OAuth application a connection acts as — §4.4's paths 2 and 3.
 *
 * ONE STATEMENT, AND IT IS THE `purpose = 'client'` ROW. Since 021 an OAuth
 * connection holds two credentials with very different lifetimes: the client
 * secret, which changes almost never, and the token, which rotates hourly. The
 * token row is written by the connector OAuth flow and read through
 * `connector.repo`; this file only ever touches the other one.
 */

/**
 * Store the client id and secret a connection will authenticate as.
 *
 * THE SECRET ARRIVES SEALED, as it does for identity providers. Nothing here
 * can open an envelope and nothing here should be able to.
 *
 * UPSERT ON `(connection_id, auth_strategy, purpose)`, WHICH IS THE CONSTRAINT
 * 021 ADDED. Re-running provisioning — a customer correcting a mistyped secret,
 * or replacing a rotated one — must land on the row already there. An INSERT
 * would fail against a unique violation that says nothing about what to do
 * next, and a second client row would make "which application is this acting
 * as" unanswerable.
 *
 * `last_four` IS FOR RECOGNITION AND NEVER FOR AUTHENTICATION — it is how an
 * administrator tells which credential is in which environment. The column
 * accepts null; what to put there when a secret is too short to take four
 * characters from is the caller's decision, not this file's.
 */
export async function upsertClient(
  db: Executor,
  input: {
    connectionId: string;
    sealed: Sealed;
    lastFour: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO connection_credentials
       (id, connection_id, auth_strategy, purpose, sealed, wrapped_key, key_reference, last_four)
     VALUES ($1, $2, 'oauth2_pkce', 'client', $3, $4, $5, $6)
     ON CONFLICT (connection_id, auth_strategy, purpose)
     DO UPDATE SET sealed = EXCLUDED.sealed,
                   wrapped_key = EXCLUDED.wrapped_key,
                   key_reference = EXCLUDED.key_reference,
                   last_four = EXCLUDED.last_four`,
    [
      generateId(),
      input.connectionId,
      input.sealed.ciphertext,
      input.sealed.wrappedKey,
      input.sealed.keyReference,
      input.lastFour,
    ],
  );
}
