import { actAsUser, withTransaction, withoutTenant } from '../infra/db.infra';
import { runWithTenant, runUntenanted } from '../utils/tenantContext.util';
import { denial, invalid, notFound } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, assertCanAtScope, authorityOf, checkGrant } from './authorisation.service';
import { generateId, generatePrefixedToken } from '../utils/tokens.util';
import { hashToken } from '../utils/hash.util';
import { lastFour } from '../utils/lastFour.util';
import * as scimRepo from '../repos/scim.repo';
import * as membershipRepo from '../repos/membership.repo';
import * as sessionRepo from '../repos/session.repo';
import * as automationService from './automation.service';
import * as userRepo from '../repos/user.repo';
import * as authzRepo from '../repos/authz.repo';
import * as scopeRepo from '../repos/scope.repo';
import type { Actor } from './scope.service';

/**
 * §1 — SCIM. Accounts that exist before somebody signs in, and stop when they
 * leave.
 *
 * ── What this is for, and what SSO does not do ─────────────────────────────
 *
 * SSO answers "is this really them" and says nothing about the lifecycle around
 * it. Somebody joins and cannot sign in until an administrator remembers to add
 * them; somebody LEAVES and keeps their access until an administrator remembers
 * to remove them. The second is the one that matters — an offboarding that
 * depends on a person remembering every tool is a standard audit finding.
 *
 * The identity provider is the client here and Silo is the server.
 *
 * ── THE BOUNDARY THIS FILE EXISTS TO HOLD ──────────────────────────────────
 *
 * A DIRECTORY GROUP MUST NOT BE ABLE TO GRANT AUTHORITY. The six delegation
 * rules are checked against a GRANTER — a membership with a scope, the
 * permissions it effectively holds there, and a whitelist of roles it may hand
 * out. An identity provider is none of those things, so a group that assigned a
 * role directly would be a path around all six: whoever administers the
 * directory could make themselves a super admin without anybody in Silo
 * agreeing.
 *
 * So the MAPPING is the delegated act and the membership change is not. An
 * administrator declares once that a group carries a role at a scope, and
 * `checkGrant` runs THEN — the same check a human grant runs, not a copy of it.
 * Afterwards the provider only moves people in and out of an envelope somebody
 * was already allowed to create.
 *
 * `declaredBy` BECOMES `grantedBy` ON EVERY ASSIGNMENT THIS PRODUCES, so the
 * chain from a person's role back to a human who could grant it stays unbroken.
 * A directory never appears in it.
 */

/* ── The credential ──────────────────────────────────────────────────────── */

/**
 * Turn a bearer token into an organisation.
 *
 * UNTENANTED BY NECESSITY, exactly like the login lookup. The token is what
 * SAYS which organisation this request belongs to, so the read that finds it
 * cannot already be inside one.
 */
export async function authenticate(
  token: string,
): Promise<{ organisationId: string; tokenId: string }> {
  const found = await runUntenanted('scim-token-lookup', () =>
    withoutTenant((db) => scimRepo.ownerOf(db, hashToken(token))),
  );

  if (!found) {
    throw denial({ message: 'That SCIM token is not valid.', code: 'denial.scim_token' });
  }

  /* Support answers "is the sync running" from this, without reading a row of
     anybody's data. */
  await runWithTenant({ organisationId: found.organisationId, membershipId: null }, () =>
    withTransaction((db) => scimRepo.markUsed(db, found.tokenId)),
  );

  return found;
}

/**
 * Issue a token for the customer to paste into their provider.
 *
 * THE PLAINTEXT EXISTS IN THIS RESPONSE AND NOWHERE ELSE, like every other
 * opaque credential here. `lastFour` is kept so somebody with two configured
 * can tell which is which.
 *
 * `sso.manage` GOVERNS IT. Provisioning is the other half of connecting a
 * directory, and somebody trusted to configure the identity provider is
 * necessarily trusted to decide what it may push.
 */
export async function issueToken(
  actor: Actor,
  input: { name: string },
): Promise<{ token: string; id: string; lastFour: string }> {
  const token = generatePrefixedToken('scim');

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'sso.manage');

        const issued = await scimRepo.issueToken(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          name: input.name.trim(),
          tokenHash: hashToken(token),
          lastFour: lastFour(token) ?? '0000',
          createdBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'scim_token_issued',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { keyId: issued.id, lastFour: issued.lastFour },
        });

        return { token, id: issued.id, lastFour: issued.lastFour };
      }),
  );
}

export async function listTokens(actor: Actor): Promise<scimRepo.ScimToken[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'sso.manage');
        return scimRepo.listTokens(db);
      }),
  );
}

export async function revokeToken(actor: Actor, id: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'sso.manage');

        /*
         * REVOKING A REVOKED TOKEN IS NOT AN ERROR AND IS NOT A SUCCESS EITHER.
         * Reporting success would tell somebody they had just cut off a sync
         * that was cut off last week, which is the kind of reassurance that
         * hides a real problem.
         */
        if (!(await scimRepo.revokeToken(db, id))) {
          throw notFound({ message: 'No live token with that id.', code: 'missing.scim_token' });
        }

        await writeAudit(db, {
          event: 'scim_token_revoked',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { keyId: id },
        });
      }),
  );
}

/* ── What a directory group is allowed to carry ──────────────────────────── */

/**
 * Declare that a directory group carries a scope, a role, or both.
 *
 * ── THIS IS THE ONE AUTHORITY DECISION IN SCIM ─────────────────────────────
 *
 * `checkGrant` runs here, against the person declaring it — the same six rules
 * a human grant passes, called through the same function rather than
 * reimplemented. If they could not grant this role at this scope themselves,
 * they cannot arrange for a directory to do it for them.
 *
 * ONCE, NOT PER MEMBER. A provider pushing a thousand people must not be making
 * a thousand authority decisions; it is making none. The decision was made here
 * and the provider is filling an envelope.
 */
export async function declareGroupGrant(
  actor: Actor,
  input: { groupId: string; scopeId?: string | null; roleId?: string | null },
): Promise<scimRepo.ScimGroupGrant> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'sso.manage');

        const group = await scimRepo.findGroup(db, input.groupId);
        if (!group) throw notFound({ message: 'No such group.', code: 'missing.scim_group' });

        const scopeId = input.scopeId ?? null;
        const roleId = input.roleId ?? null;

        if (!scopeId && !roleId) {
          throw invalid({
            message: 'A mapping has to carry a scope, a role, or both.',
            code: 'invalid.empty_mapping',
          });
        }

        /*
         * A ROLE WITHOUT A SCOPE IS AN ORGANISATION-WIDE GRANT — a super admin —
         * and that is never something a directory group may confer. Refused by
         * name here and by CHECK constraint in 059, because a repository that
         * forgets to call this must not be able to write the row.
         */
        if (roleId && !scopeId) {
          throw invalid({
            message: 'A directory group cannot carry an organisation-wide role. Name a scope.',
            code: 'invalid.unscoped_group_role',
          });
        }

        const scope = scopeId ? await scopeRepo.findById(db, scopeId) : null;
        if (scopeId && !scope) {
          throw notFound({ message: 'No such scope.', code: 'missing.scope' });
        }

        /*
         * ── PLACEMENT IS AUTHORITY, AND USED NOT TO BE CHECKED ──────────────
         *
         * The whole authority decision sat inside `if (roleId)`, so a mapping
         * carrying only a scope was written after nothing but `sso.manage`.
         * That is not the safe case it was described as:
         * `effectivePermissions#reaches` makes every connection grant and every
         * scoped role bite where the subject SITS, and that comes from
         * `scope_memberships`. Putting somebody in a scope hands them
         * everything granted at or above it.
         *
         * `scope.service.addMember` has always required `scope.assign` AT the
         * scope. Arranging for a directory to do it requires the same.
         */
        if (scope) {
          assertCanAtScope(authority, 'scope.assign', scope.path);
        }

        if (roleId) {
          const permissions = await authzRepo.permissionsOfRole(db, roleId);

          const decision = await checkGrant(db, authority, {
            targetScopePath: scope?.path ?? null,
            roleId,
            permissions,
          });

          if (!decision.permitted) {
            throw denial({
              message:
                'You cannot arrange for a directory to grant something you could not grant ' +
                'yourself.',
              code: 'denial.delegation',
              detail: { failures: decision.failures },
            });
          }
        }

        const declared = await scimRepo.declareGrant(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          groupId: input.groupId,
          scopeId,
          roleId,
          declaredBy: actor.membershipId,
        });

        /*
         * ── APPLIED TO WHOEVER IS ALREADY IN THE GROUP ─────────────────────
         *
         * A mapping declared for a group the provider populated last week must
         * not sit dormant until the next sync — an administrator who says
         * "Finance Admins are scope admins in Finance" means the people in it
         * now, and an interface that showed the mapping while nobody had it
         * would be describing something that had not happened.
         */
        for (const membershipId of await scimRepo.membersOf(db, input.groupId)) {
          await apply(db, actor.organisationId, declared, membershipId);
        }

        await writeAudit(db, {
          event: 'scim_group_mapped',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { groupId: input.groupId, scopeId, roleId },
        });

        return declared;
      }),
  );
}

export async function withdrawGroupGrant(actor: Actor, id: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'sso.manage');

        /*
         * ── TAKEN BACK FROM WHOEVER HAS IT, NOT JUST DELETED ─────────────────
         *
         * Deleting the row alone left everybody who had been given the role
         * through it holding the role — so "Finance Admins are no longer scope
         * admins" changed nothing for a single person, and the interface said
         * it had.
         *
         * Withdrawn BEFORE the row goes, because the withdrawal is bounded by
         * the mapping's own `declaredBy` and needs to read it.
         */
        const mapping = await scimRepo.findGrant(db, id);
        if (!mapping) {
          throw notFound({ message: 'No such mapping.', code: 'missing.scim_mapping' });
        }

        for (const membershipId of await scimRepo.membersOf(db, mapping.groupId)) {
          await withdraw(db, mapping, membershipId);
        }

        await scimRepo.withdrawGrant(db, id);

        await writeAudit(db, {
          event: 'scim_group_unmapped',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { grantId: id },
        });
      }),
  );
}

/* ── The lifecycle the directory drives ──────────────────────────────────── */

export interface ScimUser {
  /** The provider's own id for this person. Stable across renames. */
  externalId: string;
  email: string;
  firstName: string;
  lastName: string;
  active: boolean;
}

/**
 * Create or update a person, so the account exists before they ever sign in.
 *
 * ── A USER IS GLOBAL AND A MEMBERSHIP IS NOT ───────────────────────────────
 *
 * One person with one email may belong to organisations in different tenants,
 * so provisioning matches an EXISTING user by address rather than making a
 * second one — and then gives them a membership here. Creating a duplicate user
 * would leave somebody unable to sign in to the tenant that provisioned them.
 *
 * NO PASSWORD. A provisioned account signs in through the directory that
 * provisioned it; minting a password for somebody who never chose one is an
 * unclaimed credential sitting in a row.
 *
 * ── AND NO DIRECTORY LINK WRITTEN HERE, DELIBERATELY ───────────────────────
 *
 * `sso.service` looks a returning person up by subject FIRST and falls back to
 * their address, writing the link at that moment. So a provisioned account is
 * picked up on the first sign-in without this having to guess.
 *
 * Guessing is the word: SCIM's `externalId` and OIDC's `sub` are frequently not
 * the same value, and a link written from the wrong one would send somebody to
 * a "no account" refusal while their account sat right there.
 *
 * IT ALSO ANSWERS WHAT SSO REFUSES TO DO. `sso.service` will not create an
 * account just because somebody at a configured domain arrived — that would let
 * anybody join themselves. SCIM is the authorised version of that: the
 * directory asserts membership, over a credential the customer issued.
 *
 * MARKED AS PROVISIONED, which is what later lets a deactivation know it may
 * touch this membership and not the founder's.
 */
export async function provisionUser(
  organisationId: string,
  input: ScimUser,
): Promise<{ membershipId: string; created: boolean }> {
  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      /*
       * ── FOUND WITHOUT A TENANT, BECAUSE A USER IS GLOBAL ──────────────────
       *
       * `users` is under row level security keyed on `app_user_id()`, so a
       * lookup by address cannot run as the person being looked for — nobody
       * knows who they are yet. `user_by_email` is the `SECURITY DEFINER`
       * function that exists for exactly this, and the sign-in path uses it for
       * exactly the same reason.
       */
      const existing = await runUntenanted('scim-token-lookup', () =>
        withoutTenant((outer) => userRepo.findByEmail(outer, input.email)),
      );

      const userId = existing?.id ?? generateId();

      /*
       * ACTING AS THE PERSON ABOUT TO EXIST. `users_own` is `WITH CHECK (id =
       * app_user_id())`, so a row can only be written by the user it describes
       * — which is impossible before they exist unless the context is set to
       * the id first. Registration does the same thing, and it is not a
       * loophole: nothing outside this transaction can reach a row for an id
       * that does not exist yet.
       */
      await actAsUser(db, userId);

      if (!existing) {
        await userRepo.create(db, {
          id: userId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          /* NO PASSWORD: a provisioned account signs in through the directory
             that provisioned it. */
          passwordHash: null,
        });
      }

      const already = await membershipRepo.findByUserAndOrganisation(db, userId, organisationId);

      if (already) {
        /*
         * ── A REPEAT MAY LIFT THE DIRECTORY'S OWN SUSPENSION, AND NO OTHER ──
         *
         * Providers re-send constantly. This used to reactivate ANY suspended
         * membership, so an administrator suspending somebody pending an
         * investigation — who has not left the company and is therefore still
         * active in the directory — had that reversed by the next sync, minutes
         * later, with nobody told.
         *
         * The two suspensions are different acts wearing one status. "They have
         * left" is the directory's to reverse; "their access is stopped while we
         * look into something" is a person's decision and stays.
         */
        const mine = await scimRepo.suspendedByScim(db, already.id);

        if (input.active && already.status === 'suspended' && mine) {
          await membershipRepo.setStatus(db, already.id, 'active');
          await scimRepo.setSuspendedByScim(db, already.id, false);

          await writeAudit(db, {
            event: 'scim_user_reactivated',
            organisationId,
            membershipId: already.id,
            userId: null,
            detail: { externalId: input.externalId },
          });
        }

        return { membershipId: already.id, created: false };
      }

      const membership = await membershipRepo.create(db, {
        id: generateId(),
        userId,
        organisationId,
        status: input.active ? 'active' : 'suspended',
      });

      await scimRepo.markProvisioned(db, membership.id);

      await writeAudit(db, {
        event: 'scim_user_provisioned',
        organisationId,
        membershipId: membership.id,
        userId: null,
        detail: { externalId: input.externalId },
      });

      return { membershipId: membership.id, created: true };
    }),
  );
}

/**
 * The reason enterprises insist on this.
 *
 * ── SUSPENDED, NEVER DELETED ───────────────────────────────────────────────
 *
 * `member.service` already draws this line and the reasoning holds exactly:
 * suspension SILENCES grants, leaving the rows and `granted_by` intact, so a
 * person who leaves and returns — or who was deactivated by mistake — comes
 * back to what they had. A hard delete makes an ordinary HR event
 * unrecoverable, and SCIM sends plenty of those.
 *
 * ── AND ONLY WHAT IT PROVISIONED ───────────────────────────────────────────
 *
 * A provider that starts syncing an organisation that already existed will not
 * have the founder in its directory. Letting it deactivate anybody it does not
 * recognise would lock the customer out of their own tenant on the day they
 * turned this on.
 */
export async function deactivateUser(
  organisationId: string,
  membershipId: string,
): Promise<void> {
  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      if (!(await scimRepo.isProvisioned(db, membershipId))) {
        throw denial({
          message:
            'That account was not created by this directory, so this directory may not ' +
            'deactivate it.',
          code: 'denial.not_provisioned',
        });
      }

      await membershipRepo.setStatus(db, membershipId, 'suspended');
      /* Recorded so a later sync knows this suspension is its own to lift. */
      await scimRepo.setSuspendedByScim(db, membershipId, true);

      /*
       * §8 — "SCIM deprovision sets membership status to suspended, RELEASES
       * THE SEAT, AND REVOKES SESSIONS in one transaction."
       *
       * This did the first of the three. It calls `membershipRepo.setStatus`
       * directly rather than `member.service`, which revokes sessions and
       * pauses automations — so on the enterprise path, the one that actually
       * fires when somebody leaves, a deprovisioned person kept a live session
       * until it expired, up to eight hours, and their automations went on
       * running under an identity the directory had removed.
       */
      const revoked = await sessionRepo.revokeAllForMembership(db, membershipId);

      /* Automations §9 — "On owner removal, automations pause… They do not
         continue running under a removed identity." */
      await automationService.pauseOnOwnerChange(db, {
        organisationId,
        membershipId,
        reason: 'owner_removed',
      });

      await writeAudit(db, {
        event: 'scim_user_deactivated',
        organisationId,
        membershipId,
        userId: null,
        detail: { sessionsRevoked: revoked.length },
      });
    }),
  );
}

/**
 * Put the group's members where its mapping says, and take them back out.
 *
 * ── THE ENVELOPE IS FILLED HERE; IT WAS AUTHORISED ELSEWHERE ───────────────
 *
 * Every assignment this writes names `declaredBy` as the granter — the human
 * who declared the mapping and passed `checkGrant` doing it. The directory
 * decided WHO; it did not decide WHAT, and nothing in this function consults it
 * about authority.
 */
export async function syncGroupMembers(
  organisationId: string,
  groupId: string,
  membershipIds: readonly string[],
): Promise<void> {
  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      const before = new Set(await scimRepo.membersOf(db, groupId));
      const after = new Set(membershipIds);

      const grants = await scimRepo.grantsFor(db, groupId);

      for (const membershipId of after) {
        if (before.has(membershipId)) continue;

        await scimRepo.addMember(db, {
          id: generateId(),
          organisationId,
          groupId,
          membershipId,
        });

        for (const grant of grants) await apply(db, organisationId, grant, membershipId);
      }

      for (const membershipId of before) {
        if (after.has(membershipId)) continue;

        await scimRepo.removeMember(db, { groupId, membershipId });
        for (const grant of grants) await withdraw(db, grant, membershipId);
      }
    }),
  );
}

async function apply(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  organisationId: string,
  grant: scimRepo.ScimGroupGrant,
  membershipId: string,
): Promise<void> {
  if (grant.scopeId) {
    /* Insert if absent. Upserting `is_primary` demoted somebody a person had
       deliberately placed as primary. */
    await scopeRepo.addScimMember(db, {
      id: generateId(),
      membershipId,
      scopeId: grant.scopeId,
      addedBy: grant.declaredBy,
    });
  }

  if (grant.roleId && grant.scopeId) {
    await authzRepo.assign(db, {
      id: generateId(),
      membershipId,
      roleId: grant.roleId,
      /* A mapping always targets a node in the organisation tree. */
      scopeType: 'scope',
      scopeId: grant.scopeId,
      /* THE HUMAN WHO DECLARED THE MAPPING, never the directory. */
      grantedBy: grant.declaredBy,
      grantedAtScopeId: grant.scopeId,
    });
  }
}

async function withdraw(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  grant: scimRepo.ScimGroupGrant,
  membershipId: string,
): Promise<void> {
  if (grant.roleId && grant.scopeId) {
    await authzRepo.revokeGroupAssignment(db, {
      membershipId,
      roleId: grant.roleId,
      scopeId: grant.scopeId,
      /* Only what this mapping conferred: a grant a human made for their own
         reasons is not this directory's to take away. */
      grantedBy: grant.declaredBy,
    });
  }

  if (grant.scopeId) {
    /* Only a placement the directory itself made — bounded the way the role
       half already was. */
    await scopeRepo.removeScimMember(db, { membershipId, scopeId: grant.scopeId });
  }
}

/* ── Reads the provider makes ────────────────────────────────────────────── */

export async function listGroups(organisationId: string): Promise<scimRepo.ScimGroup[]> {
  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) => scimRepo.listGroups(db)),
  );
}

export async function membersOf(organisationId: string, groupId: string): Promise<string[]> {
  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) => scimRepo.membersOf(db, groupId)),
  );
}

export async function upsertGroup(
  organisationId: string,
  input: { externalId: string; displayName: string },
): Promise<scimRepo.ScimGroup> {
  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction((db) =>
      scimRepo.upsertGroup(db, {
        id: generateId(),
        organisationId,
        externalId: input.externalId,
        displayName: input.displayName,
      }),
    ),
  );
}

/**
 * Remove a group the directory deleted.
 *
 * ITS MAPPINGS GO WITH IT, by `ON DELETE CASCADE` — but the assignments those
 * mappings produced do NOT, because they are ordinary role assignments and
 * removing them silently is not a thing a directory deletion should do. The
 * members are taken out of the group first, which withdraws exactly what the
 * mappings conferred and leaves an audit trail for each.
 */
export async function deleteGroup(organisationId: string, groupId: string): Promise<void> {
  await syncGroupMembers(organisationId, groupId, []);

  await runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      if (!(await scimRepo.deleteGroup(db, groupId))) {
        throw notFound({ message: 'No such group.', code: 'missing.scim_group' });
      }
    }),
  );
}

/**
 * The people this directory can see, optionally narrowed to one address.
 *
 * ── A PROVIDER READS BEFORE IT WRITES, AND THAT IS THE WHOLE POINT ─────────
 *
 * Okta and Entra both look a person up by `userName` BEFORE creating them, so
 * that a second sync does not make a second account. Without this endpoint a
 * directory fails at the first step of being connected — long before anybody
 * gets as far as provisioning — and the failure is an opaque 404 in somebody
 * else's user interface.
 *
 * ONE FILTER, NOT A QUERY LANGUAGE. RFC 7644 defines a whole grammar and
 * providers use one clause of it for exactly this. Accepting `userName eq "x"`
 * and answering everything else with the unfiltered list is honest: the result
 * is a superset, which a provider then matches against itself, rather than a
 * silently empty answer that would make it create duplicates.
 */
export async function listUsers(
  organisationId: string,
  filter?: string,
): Promise<Array<{ membershipId: string; email: string; firstName: string; lastName: string; active: boolean }>> {
  const wanted = emailFromFilter(filter);

  return runWithTenant({ organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      const members = await membershipRepo.listForOrganisationWithUser(db);

      return members
        .filter((one) => !wanted || one.email.toLowerCase() === wanted)
        .map((one) => ({
          membershipId: one.id,
          email: one.email,
          firstName: one.firstName,
          lastName: one.lastName,
          active: one.status === 'active',
        }));
    }),
  );
}

export async function findUser(
  organisationId: string,
  membershipId: string,
): Promise<{ membershipId: string; email: string; firstName: string; lastName: string; active: boolean } | null> {
  const everybody = await listUsers(organisationId);
  return everybody.find((one) => one.membershipId === membershipId) ?? null;
}

/**
 * The one clause of the filter grammar providers actually send.
 *
 * ANYTHING ELSE RETURNS UNDEFINED and the caller answers with the full list. A
 * filter this does not understand must not become an empty result: a provider
 * reads "no such user" as "create one", and would make a duplicate on every
 * sync.
 */
function emailFromFilter(filter?: string): string | undefined {
  if (!filter) return undefined;

  const match = /userName\s+eq\s+"([^"]+)"/i.exec(filter);
  return match?.[1]?.trim().toLowerCase();
}
