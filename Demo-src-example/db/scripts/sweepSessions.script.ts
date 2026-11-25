/**
 * Delete session rows whose expiry has passed.
 *
 * ── Why this is a script and not a route ───────────────────────────────────
 *
 * Sessions are scoped per USER, not per organisation: `sessions_own` in 007 is
 * the policy, and a sweeper acts for nobody, so under row level security it
 * would match no rows and report success having deleted nothing. That is why
 * `delete_expired_sessions` is a SECURITY DEFINER function.
 *
 * Which makes a sweep inherently cross-tenant, and 049 already settled what to
 * do about that for inbound events: a cell-wide sweep returning one total lets
 * a member difference two calls into an activity signal for other customers, so
 * it is "an operator's job against the function directly, not an endpoint a
 * member can press". Sessions are the same shape and worse — they span every
 * organisation on the cell rather than one.
 *
 * ── What it does not do ────────────────────────────────────────────────────
 *
 * IT DOES NOT ENFORCE EXPIRY. Nothing trusts a row's absence: `resolve` checks
 * `expires_at` and `revoked_at` on every lookup, and `listActiveForUser`
 * excludes them in its predicate. An expired session is unusable the moment it
 * expires, whether or not this has run. This reclaims space, so a sweep that
 * fails to run is a storage problem rather than a security one.
 *
 * ── Driven from outside the process ────────────────────────────────────────
 *
 * Cloud Run scales to zero and an in-process interval fires only when an
 * instance happens to be alive, which is exactly when there is least to clean
 * up. A scheduler invoking `npm run sweep:sessions` runs whether or not anybody
 * is signed in.
 */
import 'dotenv/config';
import { Client } from 'pg';
import * as sessionRepo from '../../repos/session.repo';

/**
 * How long an expired session is kept before the row goes.
 *
 * NOT ZERO, DELIBERATELY. A row deleted the instant it expires takes with it
 * the ability to answer "was this token ever valid, and when did it lapse" for
 * somebody investigating an incident the same afternoon. The audit trail
 * records the sign-in and any revocation, so this is a convenience rather than
 * the record — a week is long enough to be useful and short enough that the
 * table does not become one.
 */
const GRACE_DAYS = 7;

async function main(): Promise<void> {
  /*
   * `DATABASE_MIGRATION_URL` IS THE NAME, and this file had it the other way
   * round -- `MIGRATION_DATABASE_URL`, which is set nowhere and validated
   * nowhere, so this has always fallen through to `DATABASE_URL`. It worked
   * anyway, because `delete_expired_sessions` is SECURITY DEFINER and runs as
   * its owner whichever role calls it. The fallback stays for that reason; the
   * name is corrected so the preference actually applies.
   */
  const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('Set DATABASE_URL (or DATABASE_MIGRATION_URL) before sweeping.');
    process.exitCode = 1;
    return;
  }

  const before = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);
  const client = new Client({ connectionString });

  await client.connect();
  try {
    /*
     * THROUGH THE REPO, NOT A DELETE WRITTEN HERE. `deleteExpiredBefore` already
     * calls the SECURITY DEFINER function for the reason at the top of this
     * file, and a script with its own copy of the statement is a second
     * definition of what "expired" means — waiting to disagree with the first.
     * A `pg.Client` satisfies `Executor`, which is the whole of what the repo
     * asks for.
     */
    const removed = await sessionRepo.deleteExpiredBefore(client, before);
    console.log(`  swept ${removed} session${removed === 1 ? '' : 's'} expired before ${before.toISOString()}`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('Session sweep failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
