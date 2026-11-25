import { Pool } from 'pg';
import { createHmac } from 'node:crypto';
import { env, isProd } from '../config/env.config';
import { cellConfig } from '../config/cell.config';
import { childLogger } from '../config/logger.config';

const log = childLogger('directory');

/**
 * The directory tier: which cell a person's data lives in.
 *
 * ITS OWN POOL, ON PURPOSE. Every other query in this process goes through
 * `db.infra`, which refuses to run without a tenant — correctly, because
 * everything it touches belongs to one. The directory is the exception that
 * proves the rule: it is consulted BEFORE any cell is chosen, let alone any
 * tenant, and routing it through a wrapper that demands a tenant would mean
 * either weakening that wrapper or lying to it.
 *
 * A SEPARATE CONNECTION IS THE SEPARATION. In production `DIRECTORY_DATABASE_URL`
 * points at a database no cell owns; in development it is unset and falls back
 * to the product database, because standing up a second Postgres to run the
 * tests is a cost with no lesson in it. Nothing else in the codebase may touch
 * `directory_entries`, which is what keeps that fallback from becoming an
 * assumption.
 *
 * IT HOLDS A KEYED HASH AND A CELL NAME AND NOTHING ELSE. This is the one
 * component every cell can reach, so it is the one whose compromise would be
 * global — which is why it must not be worth compromising. A bare SHA-256 of an
 * email is reversible in practice, since the space of real addresses is small
 * enough to enumerate, so the digest is keyed.
 */

let pool: Pool | null = null;

function connection(): Pool {
  if (pool) return pool;

  const url = env.DIRECTORY_DATABASE_URL ?? env.DATABASE_URL;

  if (!env.DIRECTORY_DATABASE_URL && isProd) {
    /*
     * Not fatal, because a single-cell deployment is a legitimate shape and
     * this is exactly what it looks like. Loud, because the difference between
     * "one cell on purpose" and "the directory was never configured" is
     * invisible from the outside and matters enormously the day a second cell
     * appears.
     */
    log.error(
      'DIRECTORY_DATABASE_URL is not set in production. The directory lives inside this cell, ' +
        'so it can only ever route to this cell.',
    );
  }

  pool = new Pool({ connectionString: url, max: 4 });
  return pool;
}

/**
 * The directory's key for an address.
 *
 * EXPORTED SO IT CAN BE TESTED AND OPERATED, not because callers should reach
 * for it. A support question of the form "which cell is this customer in" has to
 * be answerable without the directory storing the address, and a test that wants
 * to move somebody between cells needs the same key the writer used — otherwise
 * it guesses at a row and silently asserts nothing.
 */
export function addressKey(email: string): string {
  return hashAddress(email);
}

function hashAddress(email: string): string {
  const secret = env.DIRECTORY_HASH_SECRET ?? env.SESSION_SECRET;
  return createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Which cell holds this person, or null if nobody has heard of them.
 *
 * NULL IS NOT AN ERROR AND MUST NOT BE TREATED AS ONE. An address nobody has
 * registered is the overwhelmingly common case at a sign-in form — it is every
 * typo and every stranger — and the caller's job is to carry on as if the
 * person belongs here, so that "unknown address" and "wrong password" remain
 * indistinguishable.
 */
export async function cellFor(email: string): Promise<string | null> {
  try {
    const { rows } = await connection().query<{ cell_id: string }>(
      'SELECT cell_id FROM directory_entries WHERE email_hash = $1',
      [hashAddress(email)],
    );
    return rows[0]?.cell_id ?? null;
  } catch (error) {
    /*
     * A DIRECTORY OUTAGE MUST NOT BE A TOTAL OUTAGE. Failing closed here would
     * mean nobody can sign in anywhere because one shared component is down.
     * Answering null sends everybody to the cell they are already talking to,
     * which is right for the great majority and merely unhelpful for the rest.
     */
    log.error({ err: error }, 'Directory unreachable; treating the address as local');
    return null;
  }
}

/**
 * Record where somebody lives. Called when an account is created.
 *
 * THE FIRST ANSWER WINS. An invitation into an organisation in another cell must
 * not silently move an existing person's data; the upsert touches only
 * `updated_at`, and somebody who genuinely needs to move is a migration
 * performed deliberately.
 */
export async function record(email: string): Promise<string> {
  const { rows } = await connection().query<{ directory_record: string }>(
    'SELECT directory_record($1, $2)',
    [hashAddress(email), cellConfig.id],
  );
  return rows[0]?.directory_record ?? cellConfig.id;
}

/** For the readiness probe. */
export async function ping(): Promise<{ separate: boolean; reachable: boolean }> {
  const separate = Boolean(env.DIRECTORY_DATABASE_URL);
  try {
    await connection().query('SELECT 1');
    return { separate, reachable: true };
  } catch {
    return { separate, reachable: false };
  }
}

export async function close(): Promise<void> {
  await pool?.end();
  pool = null;
}
