import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { denial, invalid, notFound, policy, refusal } from '../utils/error.util';
import * as grantRepo from '../repos/connectionGrant.repo';
import { granteeIdOf, granteeTypeOf, type GrantTarget } from '../models/connection.model';
import { log as writeAudit } from './audit.service';
import * as connectorService from './connector.service';
import * as scopeRepo from '../repos/scope.repo';
import { assertCan, assertCanAtScope, authorityOf, type Authority } from './authorisation.service';
import type { PoolClient } from 'pg';
import type { Actor } from './scope.service';

/**
 * §6 rule 1 — which authority this grant is being made under, or a refusal.
 *
 * "Subtree containment. A grant is rejected unless the target scope path is
 * contained by the granting admin's scope path. An admin in one tree cannot
 * create an admin in another. IMPOSSIBLE, NOT MERELY HIDDEN."
 *
 * ── WHAT `null` MEANS, AND WHY IT IS NOT A GAP ────────────────────────────
 *
 * A super admin acts organisation-wide and has no containing subtree, so the
 * grant records none. Revision 5's revocation rule then leaves such a grant to
 * its issuer or another super admin, which is correct: no subtree contains the
 * whole organisation except the whole organisation.
 *
 * ── ORGANISATION-WIDE NEEDS ORGANISATION-WIDE AUTHORITY ───────────────────
 *
 * Granting a connection to everybody is not a scoped act and cannot be made
 * inside a subtree. A scope admin who could do it would have escaped their
 * subtree with one request, which is precisely what rule 1 forbids.
 */
async function scopeOfGrant(
  db: PoolClient,
  authority: Authority,
  grantee: Grantee,
): Promise<{ id: string; path: string } | null> {
  assertCan(authority, 'connection.grant');

  if (authority.isSuperAdmin) return null;

  if (grantee.kind === 'organisation' || grantee.kind === 'principal') {
    /*
     * A service principal belongs to the organisation rather than to a place
     * in it, so handing one a connection reaches as widely as an
     * organisation-wide grant and is held to the same bar.
     */
    throw denial({
      message:
        grantee.kind === 'organisation'
          ? 'Granting a connection to the whole organisation is not something a scope admin does.'
          : 'Granting a connection to a service principal is not something a scope admin does.',
      code: 'denial.outside_subtree',
      detail: { granteeType: grantee.kind, adminPaths: authority.adminPaths },
    });
  }

  const target =
    grantee.kind === 'scope'
      ? await scopeRepo.findById(db, grantee.scopeId)
      : /* A membership sits in one or more scopes; the grant is made at the
           narrowest one the granter administers, and refused if none. */
        (await scopeRepo.pathsForMembership(db, grantee.membershipId))
          .map((path) => ({ id: '', path }))
          .find((one) => authority.adminPaths.some((admin) => one.path.startsWith(admin))) ?? null;

  if (!target) {
    throw denial({
      message: 'That is outside the part of the organisation you administer.',
      code: 'denial.outside_subtree',
      detail: { granteeType: grantee.kind, adminPaths: authority.adminPaths },
    });
  }

  assertCanAtScope(authority, 'connection.grant', target.path);

  /* A membership's scope id is resolved from its path, because
     `pathsForMembership` answers in paths. */
  const resolved =
    target.id === ''
      ? ((await scopeRepo.listAll(db)).find((scope) => scope.path === target.path) ?? null)
      : target;

  return resolved ? { id: resolved.id, path: resolved.path } : null;
}

/**
 * Who reaches a connection.
 *
 * ── The two shapes, and why nothing structural distinguishes them ───────────
 *
 * A SHARED KEY is one connection, one credential, granted to a scope or to the
 * whole organisation. Everyone queries through it and nobody ever sees the
 * credential: a Salesforce service account, a shared Sage login, a read-only
 * database user. This is the default and the normal case.
 *
 * INDIVIDUAL CREDENTIALS are many connections against the SAME manifest, each
 * with its own credential, each granted to the one person it belongs to. Ten
 * people with their own Jira tokens is ten connections, one manifest, ten grants
 * of one membership each.
 *
 * Nothing changes structurally between them. The manifest is reused, the
 * credential belongs to the connection, and the grant decides who reaches it.
 *
 * ── The one thing that is enforced ──────────────────────────────────────────
 *
 * A `per_user` MANIFEST CANNOT BE SHARED. Where the source system's key carries
 * the person's own permissions, sharing one credential means the source is
 * applying somebody else's access rules underneath ours — and the source's
 * answer was the one with the authority. That is not a trade-off an admin should
 * be able to make by accident, so the manifest declares it and this refuses.
 */

export type Grantee =
  | { kind: 'organisation' }
  | { kind: 'scope'; scopeId: string; includeDescendants?: boolean }
  | { kind: 'membership'; membershipId: string }
  | { kind: 'principal'; principalId: string };

export interface GrantRecord {
  id: string;
  granteeType: 'organisation' | 'scope' | 'membership' | 'principal';
  granteeId: string | null;
  canRead: boolean;
  canWrite: boolean;
  includeDescendants: boolean;
  grantedAt: string;
  expiresAt: string | null;
}

export async function grant(
  actor: Actor,
  input: {
    connectionId: string;
    grantee: Grantee;
    canRead?: boolean;
    canWrite?: boolean;
    expiresAt?: Date | null;
  },
): Promise<{ grantId: string }> {
  const connection = await connectorService.manageableConnection(actor, input.connectionId);

  /*
   * THE MANIFEST DECIDES WHETHER SHARING IS EVEN LEGAL. Checked here rather than
   * left to an admin's judgement, because the failure is invisible: a shared key
   * on a per-user system answers perfectly and quietly returns rows the source
   * would have refused the person asking.
   */
  const shared = input.grantee.kind === 'organisation' || input.grantee.kind === 'scope';

  if (shared && connection.manifest.credentialSharing === 'per_user') {
    throw policy({
      message:
        `${connection.name} uses credentials that carry each person's own permissions, so one ` +
        `credential cannot serve a group. Each person connects their own account.`,
      code: 'policy.sharing_unsafe',
      detail: { connectionId: input.connectionId, credentialSharing: 'per_user' },
    });
  }

  const canWrite = input.canWrite ?? false;

  /*
   * WRITING IS NOT IMPLIED BY READING. Most people who should be able to ask a
   * system a question should not be able to change it, and a single flag would
   * make those one decision.
   */
  if (canWrite && !connection.writesEnabled) {
    throw refusal({
      message:
        `Writes are not enabled for ${connection.name}. Verify the connector against a test ` +
        `record before granting anybody write access.`,
      code: 'refusal.writes_disabled',
    });
  }

  /*
   * THE UNION IS FLATTENED INTO 016's FOUR COLUMNS ONCE, HERE. `one_grantee`
   * demands exactly one of them, and the row and the audit entry have to name
   * the same grantee — two readings of the same union is how they come to
   * disagree.
   */
  const target: GrantTarget = {
    organisationWide: input.grantee.kind === 'organisation',
    scopeId: input.grantee.kind === 'scope' ? input.grantee.scopeId : null,
    membershipId: input.grantee.kind === 'membership' ? input.grantee.membershipId : null,
    principalId: input.grantee.kind === 'principal' ? input.grantee.principalId : null,
  };

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);

        /*
         * §6 — THE SIX DELEGATION RULES APPLIED HERE, BECAUSE NOTHING ELSE
         * APPLIES THEM.
         *
         * The router's `requirePermission('connection.grant')` is deliberately
         * not scope-aware — the middleware says so — on the premise that the
         * service asks the precise question. This service asked none of it: it
         * loaded no authority at all. `connection.grant` is scopeable and sits
         * on the Admin role, so a scope admin could grant any connection in the
         * organisation, including ones they could not themselves read, to
         * anybody, including organisation-wide.
         *
         * Rule 1 is "Subtree containment… IMPOSSIBLE, NOT MERELY HIDDEN", and
         * the role-assignment path had it right all along. This is the same
         * question asked of connections.
         */
        const grantedAtScopePath = await scopeOfGrant(db, authority, input.grantee);

        /*
         * §6 rule 6 — "Connection subset. An admin may pass on access only to
         * connections they themselves hold at that scope."
         *
         * A super admin holds everything, so the question does not arise for
         * them. For everybody else, passing on what you cannot reach yourself
         * is the escalation this rule exists to stop.
         */
        if (!authority.isSuperAdmin) {
          const held = await connectorService.readableIds(db, actor, [input.connectionId]);
          if (!held.has(input.connectionId)) {
            throw denial({
              message: 'You can only pass on a connection you hold yourself.',
              code: 'denial.connection_subset',
              detail: { connectionId: input.connectionId },
            });
          }
        }

        const grantId = await grantRepo.insert(db, {
          connectionId: input.connectionId,
          ...target,
          canRead: input.canRead ?? true,
          canWrite,
          /*
           * DESCENDANTS DEFAULT TO TRUE FOR A SCOPE AND ARE IMPOSSIBLE FOR
           * ANYTHING ELSE. Granting Engineering usually means Engineering and
           * everything under it, and 016 refuses the flag on a grantee with no
           * subtree to descend — so the column's own default cannot be the one
           * that applies here.
           */
          includeDescendants:
            input.grantee.kind === 'scope' ? (input.grantee.includeDescendants ?? true) : false,
          grantedBy: actor.membershipId,
          /* Revision 5 — the authority the granter acted under, which is what
             makes revocation answerable later. */
          grantedAtScopeId: grantedAtScopePath?.id ?? null,
          expiresAt: input.expiresAt ?? null,
        });

        await writeAudit(db, {
          event: 'connection_granted',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            connectionId: input.connectionId,
            granteeType: input.grantee.kind,
            granteeId: granteeIdOf(target),
            grantedAtScopePath: grantedAtScopePath?.path ?? null,
            canWrite,
          },
        });

        return { grantId };
      }),
  );
}

export async function revoke(actor: Actor, grantId: string): Promise<void> {
  await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'connection.grant');

        /*
         * Revision 5 — "Not by any admin the user happens to sit under. An
         * Engineering admin cannot revoke access issued by the Falcon admin."
         *
         * The authority goes into the statement rather than into a check above
         * it, the way `revokeAssignment` does it for role assignments. This had
         * no authority predicate at all: any holder of `connection.grant` could
         * withdraw any grant in the organisation, including a peer's.
         */
        const revoked = await grantRepo.revoke(db, {
          grantId,
          revokedBy: actor.membershipId,
          revokerScopePaths: authority.adminPaths,
          isSuperAdmin: authority.isSuperAdmin,
        });

        /*
         * ALREADY REVOKED READS AS MISSING. A second revocation changed nothing,
         * and telling somebody it succeeded would put an event in the trail for
         * an act that did not happen.
         */
        /*
         * NOT FOUND COVERS "NOT YOURS TO WITHDRAW" TOO, and deliberately.
         * Telling a scope admin that a grant exists but belongs to a peer
         * confirms both the grant and the peer's reach; the role path answers
         * the same way for the same reason.
         */
        if (!revoked) {
          throw notFound({
            message: 'That grant does not exist, was already revoked, or is not yours to withdraw.',
            code: 'missing.grant',
          });
        }

        await writeAudit(db, {
          event: 'connection_revoked',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            connectionId: revoked.connectionId,
            granteeType: granteeTypeOf(revoked),
            granteeId: granteeIdOf(revoked),
          },
        });
      }),
  );
}

/**
 * Who currently reaches this connection.
 *
 * REVOKED AND EXPIRED ROWS ARE INCLUDED AND LABELLED. "Who can see this" and
 * "who could see this last month" are both questions somebody asks, and a list
 * that silently drops the second cannot answer it.
 */
export async function list(actor: Actor, connectionId: string): Promise<GrantRecord[]> {
  await connectorService.manageableConnection(actor, connectionId);

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const grants = await grantRepo.list(db, connectionId);

        return grants
          .filter((grant) => grant.revokedAt === null)
          .map((grant) => ({
            id: grant.id,
            granteeType: granteeTypeOf(grant),
            granteeId: granteeIdOf(grant),
            canRead: grant.canRead,
            canWrite: grant.canWrite,
            includeDescendants: grant.includeDescendants,
            grantedAt: grant.grantedAt.toISOString(),
            expiresAt: grant.expiresAt?.toISOString() ?? null,
          }));
      }),
  );
}


/* ── Who can actually reach it ──────────────────────────────────────────── */

export interface Reach {
  membershipId: string;
  name: string;
  email: string;
  canWrite: boolean;
  /** How they got here, which is not always the grant somebody remembers making. */
  via: 'organisation' | 'scope' | 'membership';
  viaName: string | null;
}

/**
 * The effective list: everyone who can currently reach this connection.
 *
 * NOT THE GRANTS ISSUED, WHICH IS A DIFFERENT LIST AND DIVERGES THE MOMENT
 * SCOPES NEST. A grant on Engineering with descendants reaches everybody in
 * Platform and Data too, and an admin looking at "who can see our payroll
 * system" needs the people, not the three rows somebody typed. Reading the
 * grants and doing the arithmetic in your head is exactly the step that gets
 * skipped.
 *
 * REVOKED AND EXPIRED GRANTS ARE EXCLUDED HERE, so this answers "now" rather
 * than "ever" — `list` above is where the history is.
 */
export async function reach(actor: Actor, connectionId: string): Promise<Reach[]> {
  await connectorService.manageableConnection(actor, connectionId);

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const entries = await grantRepo.reach(db, {
          connectionId,
          organisationId: actor.organisationId,
        });

        return entries.map((entry) => ({
          membershipId: entry.membershipId,
          /*
           * JOINED HERE AND NOT STORED JOINED. The two halves are separate
           * columns because they are separately editable, and a screen that
           * wants "Priya Raman" should not be the reason the database keeps a
           * third copy of the pair.
           */
          name: `${entry.firstName} ${entry.lastName}`.trim(),
          email: entry.email,
          canWrite: entry.canWrite,
          via: entry.via,
          viaName: entry.viaName,
        }));
      }),
  );
}
