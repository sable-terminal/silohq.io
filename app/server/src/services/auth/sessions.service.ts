// Sessions (spec 60.1, 60.2): opaque, server-side, with Postgres as the record of truth
// and the revocation list, and a hot copy in redis-session.
//
// - Issued at login, bound to one membership. Switching organisation is a new login.
// - Expiry: the earlier of idle and absolute (utils/session.util.ts), with the
//   organisation's shorter timeouts if it set them. Only what the person does moves the
//   idle clock.
// - The hot copy lives until the absolute expiry, not the idle one, and carries the idle
//   deadline. Were it to vanish at the idle deadline (the design table's TTL), the next
//   request would rebuild it from Postgres, which keeps no idle clock, and an idle session
//   would come back to life. An idle session found here is revoked in Postgres instead.
//   Losing a Redis node loses the copies; they rebuild from Postgres with the idle clock
//   restarted (design: Redis keyspaces).
// - Revocation writes Postgres first, then removes the copy. A copy marked revoked or
//   missing its row is refused.

import type { MfaState, SessionView } from '../../contracts/auth/session.contract.ts';
import type { Config } from '../../config/index.config.ts';
import { membershipSessionKeys, sessionKeys } from '../../infra/keyspaces.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import { mfaFactorRepo, organisationRepo, policyVersionRepo, sessionRepo } from '../../repos/iam/index.repo.ts';
import { tenantMigrationRepo } from '../../repos/platform/tenantMigration.repo.ts';
import { constantTimeEqual } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { countsAsActivity, effectiveSessionTimeouts, type SessionEvent, type SessionTimeouts } from '../../utils/session.util.ts';

import { issueSessionToken, parseSessionToken } from '../../utils/token.util.ts';

export interface OrganisationRules {
  id: string;
  mfaRequired: boolean;
  sessionIdleMinutes: number | null;
  sessionAbsoluteMinutes: number | null;
}

// The hot copy's auth strength, which also says where the session stands on MFA.
const STRENGTH: Record<MfaState, string> = {
  satisfied: 'password_mfa',
  required: 'password_mfa_pending',
  enrolment_required: 'password_mfa_enrol',
  not_required: 'password',
};
const STATE: Record<string, MfaState> = Object.fromEntries(Object.entries(STRENGTH).map(([state, strength]) => [strength, state as MfaState]));

/**
 * A write in an organisation whose writes are paused (spec 6.4): from a tenant migration's
 * window until the directory routes it to its new cell, nothing is written that its export
 * would leave behind. Read in Postgres for each write, never from a copy, so no write slips in
 * after the window opens.
 */
export async function refuseWhilePaused(databases: Databases, organisationId: string): Promise<void> {
  const paused = await inTransaction(databases.pool('control'), { organisationId },
    (db) => tenantMigrationRepo.writesPaused(db, organisationId), { readOnly: true });
  if (paused) {
    throw new AppError('conflict', 'your organisation is moving to another Silo cell: changes are paused until the move completes, and reading goes on', {
      code: 'tenant_migrations.writes_paused', retryable: true,
    });
  }
}

export const invalidSession = (): AppError =>
  new AppError('unauthenticated', 'the session is not valid; sign in again', { code: 'auth.session_invalid' });

/** Where a person stands on MFA (spec 55.4), from their confirmed factors and the organisation's rule. */
export function mfaStateOf(satisfiedAt: string | null, confirmedFactors: number, organisationRequiresMfa: boolean): MfaState {
  if (satisfiedAt !== null) return 'satisfied';
  if (confirmedFactors > 0) return 'required';
  return organisationRequiresMfa ? 'enrolment_required' : 'not_required';
}

export interface IssueInput {
  organisation: OrganisationRules;
  userId: string;
  membershipId: string;
  /** satisfied only when the sign-in itself performed MFA (a trusted provider's, spec 55.5). */
  mfa: MfaState;
  /** Default password; synthetic for the synthetic organisation's members (spec 11.2). */
  authMethod?: 'password' | 'sso' | 'synthetic';
  /** A SAML sign-in: the provider and its session index, for single logout (spec 55.5). */
  sso?: { identityProviderId: string; sessionIndex: string | null } | undefined;
  ipHash: Buffer | undefined;
  userAgentHash: Buffer | undefined;
}

export interface IssuedSession {
  token: string;
  view: SessionView;
}

export interface Sessions {
  /** Inserts the session row inside the caller's transaction (organisation and user context). */
  issue(db: Queryable, input: IssueInput): Promise<IssuedSession & { cache(): Promise<void> }>;
  /** writes: the request writes in the organisation, refused while its writes are paused. */
  resolve(token: string, activity: SessionEvent, writes?: boolean): Promise<SessionView>;
  /** Revokes the session this token names; a token that names none changes nothing. */
  revoke(token: string): Promise<void>;
  /** Ends these sessions' hot copies (their rows already revoked). */
  dropCopies(organisationId: string, sessionIds: readonly string[]): Promise<void>;
  /** After a password reset: removes the copies of sessions Postgres has already revoked. */
  forget(sessions: readonly { id: string; organisationId: string | null }[], userId: string): Promise<void>;
  markMfaSatisfied(view: SessionView): Promise<SessionView>;
}

export interface SessionDeps {
  config: Config;
  databases: Databases;
  /** redis-session. */
  store: RedisStore;
  logger: Logger;
  now?: () => number;
}

const minutes = (n: number): number => n * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
// The idle deadline is rewritten at most once a minute per session, so a busy page does
// not write to Redis on every request.
const SLIDE_EVERY_MS = 60_000;

export function createSessions(deps: SessionDeps): Sessions {
  const control = deps.databases.pool('control');
  const now = deps.now ?? Date.now;
  const cell: SessionTimeouts = {
    idleMinutes: deps.config.security.sessionIdleMinutes,
    absoluteMinutes: deps.config.security.sessionAbsoluteHours * 60,
  };
  const timeoutsFor = (organisation: Pick<OrganisationRules, 'sessionIdleMinutes' | 'sessionAbsoluteMinutes'>): SessionTimeouts =>
    effectiveSessionTimeouts(cell, organisation);

  const keyOf = (organisationId: string, sessionId: string) => sessionKeys.key(organisationId, { sessionId });
  const ttlUntil = (deadline: string): number => Math.max(1, Math.ceil((Date.parse(deadline) - now()) / 1000));

  // The hot copy is a convenience: a Redis failure is logged and the request goes on.
  const quietly = async (what: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      deps.logger.failure(`the session hot copy could not be ${what}`, error, { event: 'session.hot_copy_failed', reason: what });
    }
  };

  const writeCopy = async (view: SessionView, tokenHash: Buffer, policyVersion: number, issuedAt: string, mfaSatisfiedAt: string | null,
    idleMinutes: number): Promise<void> => {
    const key = keyOf(view.organisationId, view.sessionId);
    await deps.store.putHash(sessionKeys, key, {
      membershipId: view.membershipId, userId: view.userId, authStrength: STRENGTH[view.mfa], policyVersionAtIssue: policyVersion,
      issuedAt, idleExpiresAt: view.idleExpiresAt, absoluteExpiresAt: view.absoluteExpiresAt, idleMinutes, revoked: false,
      tokenHash: tokenHash.toString('hex'), ...(mfaSatisfiedAt ? { mfaSatisfiedAt } : {}), authMethod: view.authMethod,
    }, { ttlSeconds: ttlUntil(view.absoluteExpiresAt) });
    await deps.store.addMembers(membershipSessionKeys, membershipSessionKeys.key(view.organisationId, { membershipId: view.membershipId }),
      [view.sessionId], { ttlSeconds: ttlUntil(view.absoluteExpiresAt) });
  };

  const policyVersionOf = async (db: Queryable, organisationId: string): Promise<number> => {
    const row = await policyVersionRepo.findByOrganisationId(db, organisationId);
    return row ? Number(row.version) : 0;
  };

  // Rebuilds a copy from Postgres, as after a Redis node was lost. The idle clock restarts.
  const rebuild = async (organisationId: string, sessionId: string, tokenHash: Buffer)
    : Promise<{ view: SessionView; idleMinutes: number } | undefined> => {
    const row = await inTransaction(control, {}, (db) => sessionRepo.resolveByTokenHash(db, tokenHash));
    if (!row || row.id !== sessionId || row.organisationId !== organisationId || !row.userId || !row.membershipId) return undefined;
    if (row.authMethod === 'agent') return undefined;
    const { view, policyVersion, idleMinutes } = await inTransaction(control, { organisationId, userId: row.userId }, async (db) => {
      const organisation = await organisationRepo.findById(db, organisationId);
      if (!organisation || organisation.status !== 'active') return { view: undefined, policyVersion: 0, idleMinutes: 0 };
      const factors = await mfaFactorRepo.countConfirmed(db, row.userId!);
      const timeouts = timeoutsFor(organisation);
      const idle = Math.min(now() + minutes(timeouts.idleMinutes), Date.parse(row.expiresAt));
      return {
        policyVersion: await policyVersionOf(db, organisationId),
        idleMinutes: timeouts.idleMinutes,
        view: {
          sessionId: row.id, userId: row.userId!, organisationId, membershipId: row.membershipId!,
          authMethod: row.authMethod as 'password' | 'sso' | 'synthetic',
          mfa: mfaStateOf(row.mfaSatisfiedAt, factors, organisation.mfaRequired),
          idleExpiresAt: iso(idle), absoluteExpiresAt: row.expiresAt,
        } satisfies SessionView,
      };
    });
    if (!view) return undefined;
    await quietly('rebuilt', () => writeCopy(view, tokenHash, policyVersion, row.issuedAt, row.mfaSatisfiedAt, idleMinutes));
    return { view, idleMinutes };
  };

  const revokeById = async (organisationId: string, sessionId: string, membershipId: string | undefined): Promise<void> => {
    await inTransaction(control, { organisationId }, (db) => sessionRepo.revoke(db, sessionId));
    await deps.store.remove(sessionKeys, keyOf(organisationId, sessionId));
    if (membershipId) {
      await deps.store.removeMembers(membershipSessionKeys, membershipSessionKeys.key(organisationId, { membershipId }), [sessionId]);
    }
  };

  return {
    async issue(db, input) {
      const sessionId = uuidv7();
      const { token, hash } = issueSessionToken(input.organisation.id, sessionId);
      const timeouts = timeoutsFor(input.organisation);
      const issued = now();
      const absolute = issued + minutes(timeouts.absoluteMinutes);
      const authMethod = input.authMethod ?? 'password';
      const view: SessionView = {
        sessionId, userId: input.userId, organisationId: input.organisation.id, membershipId: input.membershipId,
        authMethod, mfa: input.mfa,
        idleExpiresAt: iso(Math.min(issued + minutes(timeouts.idleMinutes), absolute)),
        absoluteExpiresAt: iso(absolute),
      };
      const issuedAt = iso(issued);
      const mfaSatisfiedAt = input.mfa === 'satisfied' ? issuedAt : null;
      await sessionRepo.insert(db, {
        id: sessionId, tokenHash: hash, userId: input.userId, organisationId: input.organisation.id,
        activeMembershipId: input.membershipId, issuedAt, expiresAt: view.absoluteExpiresAt,
        ipHash: input.ipHash ?? null, userAgentHash: input.userAgentHash ?? null, authMethod, mfaSatisfiedAt,
        identityProviderId: input.sso?.identityProviderId ?? null, ssoSessionIndex: input.sso?.sessionIndex ?? null,
      });
      const policyVersion = await policyVersionOf(db, input.organisation.id);
      return {
        token, view,
        cache: () => quietly('written', () => writeCopy(view, hash, policyVersion, issuedAt, mfaSatisfiedAt, timeouts.idleMinutes)),
      };
    },

    async resolve(token, activity, writes = false) {
      const parsed = parseSessionToken(token);
      if (!parsed) throw invalidSession();
      const key = keyOf(parsed.organisationId, parsed.sessionId);
      let copy: Awaited<ReturnType<typeof deps.store.readHash<string, typeof sessionKeys.schema>>> | undefined;
      try {
        copy = await deps.store.readHash(sessionKeys, key);
      } catch (error) {
        deps.logger.failure('the session hot copy could not be read; using Postgres', error, { event: 'session.hot_copy_failed' });
      }
      let view: SessionView;
      let idleMinutes: number;
      if (copy === undefined) {
        const rebuilt = await rebuild(parsed.organisationId, parsed.sessionId, parsed.hash);
        if (!rebuilt) throw invalidSession();
        ({ view, idleMinutes } = rebuilt);
      } else {
        if (!constantTimeEqual(Buffer.from(copy.tokenHash, 'hex'), parsed.hash) || copy.revoked) throw invalidSession();
        if (copy.userId === undefined || copy.membershipId === undefined) throw invalidSession();
        view = {
          sessionId: parsed.sessionId, userId: copy.userId, organisationId: parsed.organisationId, membershipId: copy.membershipId,
          authMethod: copy.authMethod ?? 'password', mfa: STATE[copy.authStrength] ?? 'required',
          idleExpiresAt: copy.idleExpiresAt, absoluteExpiresAt: copy.absoluteExpiresAt,
        };
        idleMinutes = copy.idleMinutes;
      }
      const at = now();
      if (at >= Date.parse(view.absoluteExpiresAt)) throw invalidSession();
      if (at >= Date.parse(view.idleExpiresAt)) {
        // Idle past its deadline: revoke in Postgres so no rebuild can revive it.
        await revokeById(view.organisationId, view.sessionId, view.membershipId).catch(() => undefined);
        throw invalidSession();
      }
      if (countsAsActivity(activity)) {
        const next = Math.min(at + minutes(idleMinutes), Date.parse(view.absoluteExpiresAt));
        if (next - Date.parse(view.idleExpiresAt) >= SLIDE_EVERY_MS) {
          view = { ...view, idleExpiresAt: iso(next) };
          await quietly('slid', () => deps.store.setFields(sessionKeys, key, { idleExpiresAt: view.idleExpiresAt }));
        }
      }
      if (writes) await refuseWhilePaused(deps.databases, view.organisationId);
      return view;
    },

    async revoke(token) {
      const parsed = parseSessionToken(token);
      if (!parsed) return;
      const row = await inTransaction(control, {}, (db) => sessionRepo.resolveByTokenHash(db, parsed.hash));
      if (!row || row.id !== parsed.sessionId || row.organisationId !== parsed.organisationId) return;
      await revokeById(parsed.organisationId, parsed.sessionId, row.membershipId ?? undefined);
    },

    async dropCopies(organisationId, sessionIds) {
      for (const sessionId of sessionIds) await quietly('removed', () => deps.store.remove(sessionKeys, keyOf(organisationId, sessionId)));
    },

    async forget(sessions) {
      for (const session of sessions) {
        if (session.organisationId === null) continue;
        await quietly('removed', () => deps.store.remove(sessionKeys, keyOf(session.organisationId!, session.id)));
      }
    },

    async markMfaSatisfied(view) {
      const satisfiedAt = await inTransaction(control, { organisationId: view.organisationId, userId: view.userId }, (db) =>
        sessionRepo.markMfaSatisfied(db, view.sessionId));
      if (satisfiedAt === undefined) throw invalidSession();
      await quietly('updated', () => deps.store.setFields(sessionKeys, keyOf(view.organisationId, view.sessionId), {
        authStrength: STRENGTH.satisfied, mfaSatisfiedAt: satisfiedAt,
      }));
      return { ...view, mfa: 'satisfied' };
    },
  };
}
