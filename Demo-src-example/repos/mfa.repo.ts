import type { Executor } from '../infra/db.infra';
import type { Sealed } from '../utils/envelope.util';
import type { TotpFactor } from '../models/mfa.model';

/**
 * Second factors.
 *
 * NOTHING HERE OPENS A SECRET AND NOTHING HERE SHOULD BE ABLE TO. Rows come out
 * sealed; the envelope is made and broken by the service, against a purpose
 * bound to the id the row is stored under. A repo that unsealed would need the
 * KMS wrapper, and every read of this table would then be a network round trip
 * whether or not the caller wanted the plaintext.
 *
 * `mfa_factors_own` GOVERNS EVERY STATEMENT BELOW, keyed on `app_user_id()`. The
 * caller sets that with `actAsUser` before calling in; without it these read and
 * write nothing, which reads as "no factor enrolled" rather than as a failure.
 *
 * THE WRAPPED DATA KEY IS STORED IN `credential_id`, WHICH IS NOT WHAT THAT
 * COLUMN IS FOR. 002 describes it as the WebAuthn credential id, "which is not a
 * secret". Moved here as it was found; see the note the caller of this file
 * carries.
 */

/**
 * One list, reused, so the four statements cannot drift apart on projection.
 * `created_at` is selected by every read even though only enrolment cares —
 * a partial model is a model whose fields depend on which function returned it.
 */
const COLUMNS = `
  id, user_id, kind, secret_sealed, secret_key_ref, credential_id,
  confirmed_at, created_at
`;

interface Row {
  id: string;
  user_id: string;
  kind: 'totp' | 'webauthn';
  secret_sealed: Buffer | null;
  secret_key_ref: string | null;
  credential_id: string | null;
  confirmed_at: Date | null;
  created_at: Date;
}

/**
 * A row into a factor.
 *
 * IT THROWS ON A ROW IT CANNOT OPEN, and that is a mapping failure rather than a
 * decision about the caller. A `totp` row missing its ciphertext, its key
 * reference or its wrapped key is not a factor somebody is being kept away from
 * — it is bytes that cannot become a `TotpFactor`, and returning null would lose
 * why. The alternative, passing the nulls through, fails inside `unseal` several
 * frames later with nothing naming the row.
 */
function map(row: Row): TotpFactor {
  if (row.kind !== 'totp' || !row.secret_sealed || !row.secret_key_ref || !row.credential_id) {
    throw new Error(`mfa_factors ${row.id} holds no openable TOTP secret`);
  }

  return {
    id: row.id,
    userId: row.user_id,
    kind: 'totp',
    secret: {
      ciphertext: row.secret_sealed,
      wrappedKey: Buffer.from(row.credential_id, 'base64'),
      keyReference: row.secret_key_ref,
    },
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  };
}

/**
 * Store a new, unconfirmed TOTP factor.
 *
 * TWO STATEMENTS, AND THE SECOND IS THE ODD ONE. The wrapped data key goes into
 * `credential_id` by a separate UPDATE rather than in the INSERT's column list.
 * Both run inside the caller's transaction, so no reader ever sees the row
 * between them.
 */
export async function createTotp(
  db: Executor,
  input: { id: string; userId: string; secret: Sealed },
): Promise<void> {
  await db.query(
    `INSERT INTO mfa_factors (id, user_id, kind, secret_sealed, secret_key_ref)
     VALUES ($1, $2, 'totp', $3, $4)`,
    [input.id, input.userId, input.secret.ciphertext, input.secret.keyReference],
  );

  // The wrapped key rides with the ciphertext; stored together so a rewrap has
  // one row to touch.
  await db.query(`UPDATE mfa_factors SET credential_id = $2 WHERE id = $1`, [
    input.id,
    input.secret.wrappedKey.toString('base64'),
  ]);
}

/**
 * The factor an enrolment is being confirmed against.
 *
 * `confirmed_at IS NULL` IS THERE FOR CORRECTNESS, NOT ACCESS. Confirmation
 * proves the secret reached the authenticator app, and re-running it against an
 * already-confirmed factor would prove nothing about the code just typed — the
 * secret has been usable since the first time. The predicate is what makes this
 * the enrolment lookup rather than a general read.
 *
 * `user_id = $2` ALONGSIDE THE ID IS BELT-AND-BRACES, and deliberately so.
 * `mfa_factors_own` already restricts this to the acting user, so the pair can
 * only ever narrow to nothing; what it costs is a parameter and what it buys is
 * that a factor id lifted from another account still confirms nothing if the
 * policy is ever dropped.
 */
export async function findUnconfirmedTotp(
  db: Executor,
  input: { factorId: string; userId: string },
): Promise<TotpFactor | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM mfa_factors
      WHERE id = $1 AND user_id = $2 AND kind = 'totp' AND confirmed_at IS NULL`,
    [input.factorId, input.userId],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function markConfirmed(db: Executor, factorId: string): Promise<void> {
  await db.query(`UPDATE mfa_factors SET confirmed_at = now() WHERE id = $1`, [factorId]);
}

/**
 * Every factor a presented code could belong to.
 *
 * ALL OF THEM, BECAUSE THE CODE DOES NOT SAY WHICH FACTOR IT CAME FROM. Somebody
 * with a phone and a tablet enrolled has two secrets, either of which is a valid
 * answer; the caller tries each. `confirmed_at IS NOT NULL` is correctness
 * again — an abandoned enrolment holds a secret nobody ever proved they had.
 */
export async function listConfirmedTotp(db: Executor, userId: string): Promise<TotpFactor[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM mfa_factors
      WHERE user_id = $1 AND kind = 'totp' AND confirmed_at IS NOT NULL`,
    [userId],
  );
  return rows.map(map);
}

/**
 * How many confirmed factors this user has.
 *
 * COUNTED IN THE DATABASE RATHER THAN BY LENGTH OF A LIST, because the only
 * caller asks whether MFA is set up at all — reading the rows would unseal
 * nothing and decode nothing, but it would carry every secret this user has into
 * the process to answer a yes-or-no question.
 *
 * NOT NARROWED TO `totp`, unlike the reads above. The question is whether any
 * second factor exists, and a WebAuthn one would count.
 */
export async function countConfirmed(db: Executor, userId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM mfa_factors
      WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}
