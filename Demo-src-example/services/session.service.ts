import type { PoolClient } from 'pg';
import { actAsUser } from '../infra/db.infra';
import { authConfig } from '../config/auth.config';
import { SESSION_CACHE_TTL_SECONDS } from '../config/constants.config';
import * as cache from '../infra/cache.infra';
import { hashIdentifier, hashToken } from '../utils/hash.util';
import { generateId, generatePrefixedToken } from '../utils/tokens.util';
import { defaultExpiry, isUsable, pendingReason, type Session } from '../models/session.model';
import type { AuthMethod } from '../models/session.model';
import * as sessionRepo from '../repos/session.repo';

/**
 * Issuing, resolving and revoking sessions.
 *
 * THE PLAINTEXT TOKEN EXISTS FOR THE LENGTH OF ONE FUNCTION AND IS RETURNED
 * ONCE. It is never stored, never logged and cannot be recovered — a session
 * token is a bearer credential, so a database holding the plaintext is a database
 * holding live logins.
 *
 * REDIS IS A CACHE, POSTGRES IS THE TRUTH. Every revocation writes to Postgres
 * first and deletes the cache entry second, in that order. The reverse leaves a
 * window where the cache is empty, the database not yet updated, and a
 * concurrent request repopulates the cache with the session that was just
 * revoked.
 */

export interface IssueInput {
  db: PoolClient;
  userId: string;
  activeMembershipId: string | null;
  authMethod: AuthMethod;
  ip?: string | null;
  userAgent?: string | null;
  mfaSatisfied?: boolean;
}

export interface IssuedSession {
  session: Session;
  /** Returned once. There is no way to obtain it again. */
  token: string;
}

export async function issue(input: IssueInput): Promise<IssuedSession> {
  // `sessions_own` governs the insert: without this the WITH CHECK refuses, and
  // minting a session for a user is exactly the write that must be governed.
  await actAsUser(input.db, input.userId);
  const token = generatePrefixedToken('ses');
  const now = new Date();

  const session = await sessionRepo.create(input.db, {
    id: generateId(),
    userId: input.userId,
    activeMembershipId: input.activeMembershipId,
    tokenHash: hashToken(token),
    expiresAt: defaultExpiry(now),
    ipHash: input.ip ? hashIdentifier(input.ip, authConfig.ipHashSecret) : null,
    userAgentHash: input.userAgent ? hashIdentifier(input.userAgent, authConfig.ipHashSecret) : null,
    authMethod: input.authMethod,
    mfaSatisfiedAt: input.mfaSatisfied ? now : null,
  });

  return { session, token };
}

/**
 * Resolve a presented token.
 *
 * THE CACHE HOLDS THE SESSION ROW, NOT A DECISION. Caching "this token is valid"
 * would mean a revocation is invisible until the entry expires; caching the row
 * lets `isUsable` be re-evaluated on every request against fresh clocks, and the
 * revocation is visible the moment the row changes because the delete removes it.
 *
 * `SESSION_CACHE_TTL_SECONDS` IS 60 AND THAT IS THE BACKSTOP. If a revocation's
 * cache delete fails — the one operation in `cache.infra` that logs at error —
 * the stale entry survives at most a minute rather than the session's lifetime.
 */
export async function resolve(
  db: PoolClient,
  token: string,
): Promise<{ session: Session; fromCache: boolean } | null> {
  const tokenHash = hashToken(token);

  const cached = await cache.get<Session>({
    plane: 'control',
    kind: 'session',
    parts: [tokenHash],
  });

  if (cached) {
    // Dates arrive from JSON as strings.
    const session: Session = {
      ...cached,
      issuedAt: new Date(cached.issuedAt),
      expiresAt: new Date(cached.expiresAt),
      revokedAt: cached.revokedAt ? new Date(cached.revokedAt) : null,
      lastSeenAt: cached.lastSeenAt ? new Date(cached.lastSeenAt) : null,
      mfaSatisfiedAt: cached.mfaSatisfiedAt ? new Date(cached.mfaSatisfiedAt) : null,
    };
    if (isUsable(session)) return { session, fromCache: true };
    // Stale and unusable. Fall through to the database rather than trusting it.
  }

  const session = await sessionRepo.findByTokenHash(db, tokenHash);
  if (!session) return null;

  /*
   * AN UNUSABLE SESSION IS RETURNED AS `null` HERE BUT WAS FOUND. The caller
   * cannot distinguish a revoked session from a forged token through this
   * function, and that is deliberate for the response; the difference is
   * recorded by whoever writes the audit row, which has the session in hand.
   */
  if (!isUsable(session)) return null;

  /*
   * ── `last_seen_at` MOVES HERE, AND ONLY HERE ──────────────────────────────
   *
   * It was set once at sign-in and never again, because `touch` had no caller.
   * `listActiveForUser` orders "what am I signed in on" by it, so that screen
   * has been ordering by issue time wearing another column's name.
   *
   * THE CACHE IS THE THROTTLE AND IT COSTS NOTHING. A cached resolve returns
   * above this line without touching the database at all; only a miss gets
   * here, which is at most once per session per `SESSION_CACHE_TTL_SECONDS`.
   * Touching on every authenticated request would turn every read into a write,
   * take a row lock on the session, and serialise one user's concurrent
   * requests behind each other — for a value that is approximate by nature.
   *
   * THE PREDICATE IN THE STATEMENT IS THE BELT TO THAT BRACES. If the cache is
   * cold, shared, or the TTL is lowered, the write still only happens when the
   * column is actually stale, and it is one statement rather than a read
   * followed by a write with a window in between.
   *
   * NOT AWAITED ON THE CRITICAL PATH would be the next optimisation and is
   * deliberately not taken: an unawaited query on a pooled client can outlive
   * the transaction that owns it, and a background write that fails silently is
   * how a column starts lying again.
   */
  await sessionRepo.touch(
    db,
    session.id,
    new Date(Date.now() - SESSION_CACHE_TTL_SECONDS * 1000),
  );

  await cache.set({ plane: 'control', kind: 'session', parts: [tokenHash] }, session, SESSION_CACHE_TTL_SECONDS);

  return { session, fromCache: false };
}

/**
 * Switch which organisation a session is acting in.
 *
 * A NEW SESSION, NEVER A MUTATION OF THE OLD ONE. Changing
 * `active_membership_id` in place would alter the authority of a session while
 * requests are running under it — a query that passed a permission check in one
 * tenant could return rows in another. Issuing a new one means every request
 * carries the tenant it was authorised for, and an audit row naming a session
 * names one organisation.
 */
export async function switchMembership(
  db: PoolClient,
  current: Session,
  membershipId: string,
  context: { ip?: string | null; userAgent?: string | null },
): Promise<IssuedSession> {
  const issued = await issue({
    db,
    userId: current.userId,
    activeMembershipId: membershipId,
    authMethod: current.authMethod,
    ip: context.ip,
    userAgent: context.userAgent,
    // Carried over: the person has already satisfied MFA in this browser, and
    // asking again on every organisation switch is friction with no gain.
    mfaSatisfied: current.mfaSatisfiedAt !== null,
  });

  await revoke(db, current);
  return issued;
}

export async function revoke(db: PoolClient, session: Session): Promise<void> {
  await actAsUser(db, session.userId);
  // Database first. See the header.
  await sessionRepo.revoke(db, session.id);
  await cache.del({ plane: 'control', kind: 'session', parts: [session.tokenHash] });
}

/**
 * Every session for a user.
 *
 * THE CACHE ENTRIES ARE KEYED BY TOKEN HASH, WHICH THIS DOES NOT HAVE. Revoking
 * in bulk returns session ids, not hashes, so the individual keys cannot be
 * deleted — which is precisely why `SESSION_CACHE_TTL_SECONDS` is a minute. A
 * bulk revocation is fully effective within it, and the alternative — storing a
 * reverse index of user to token hashes — is a second thing to keep consistent
 * for a one-minute improvement.
 */
export async function revokeAllForUser(db: PoolClient, userId: string): Promise<number> {
  await actAsUser(db, userId);
  const ids = await sessionRepo.revokeAllForUser(db, userId);
  return ids.length;
}

export async function revokeAllForMembership(db: PoolClient, membershipId: string): Promise<number> {
  const ids = await sessionRepo.revokeAllForMembership(db, membershipId);
  return ids.length;
}

export { pendingReason };
