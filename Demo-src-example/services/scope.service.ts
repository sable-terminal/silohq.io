import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound, policy } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { contains } from '../utils/path.util';
import { canNest, toTree, type Scope, type ScopeNode, type ScopeType } from '../models/scope.model';
import * as scopeRepo from '../repos/scope.repo';
import * as membershipRepo from '../repos/membership.repo';
import * as authzRepo from '../repos/authz.repo';
import { assertCan, assertCanAtScope, authorityOf, type Authority } from './authorisation.service';
import { log } from './audit.service';

/**
 * Creating and moving scopes.
 *
 * EVERY OPERATION HERE CHANGES WHO ADMINISTERS WHAT, which is why each one is
 * permission-checked against the subtree and each one writes an audit row naming
 * both the before and the after. A scope move in particular is the change a
 * reviewer will ask you to evidence: it silently alters the authority of every
 * admin above and below it.
 */

export interface Actor {
  organisationId: string;
  membershipId: string;
}

async function withAuthority<T>(
  actor: Actor,
  fn: (db: Parameters<Parameters<typeof withTransaction>[0]>[0], authority: Authority) => Promise<T>,
): Promise<T> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        return fn(db, authority);
      }),
  );
}

/* ── Scope types ─────────────────────────────────────────────────────────── */

export async function createType(
  actor: Actor,
  input: { name: string; icon?: string | null; colour?: string | null },
): Promise<ScopeType> {
  return withAuthority(actor, async (db, authority) => {
    /*
     * SCOPE TYPES ARE SUPER ADMIN ONLY. A type is organisation-wide vocabulary —
     * every admin sees it and can use it — so an admin creating one changes
     * something outside their own subtree.
     */
    if (!authority.isSuperAdmin) {
      throw policy({
        message: 'Only a super admin can define scope types.',
        code: 'policy.scope_type_super_admin_only',
      });
    }

    const type = await scopeRepo.createType(db, {
      id: generateId(),
      organisationId: actor.organisationId,
      name: input.name,
      icon: input.icon,
      colour: input.colour,
    });

    await log(db, {
      event: 'scope_type_created',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { scopeTypeId: type.id, name: type.name },
    });

    return type;
  });
}

export async function listTypes(actor: Actor): Promise<ScopeType[]> {
  return withAuthority(actor, (db) => scopeRepo.listTypes(db));
}

/* ── Scopes ──────────────────────────────────────────────────────────────── */

export async function create(
  actor: Actor,
  input: { name: string; scopeTypeId: string; parentId: string | null },
): Promise<Scope> {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'scope.create');

    if (input.parentId === null) {
      /*
       * A TOP-LEVEL SCOPE IS OUTSIDE EVERY ADMIN'S SUBTREE BY DEFINITION, so
       * only a super admin can create one. Without this an admin could create a
       * sibling root and appoint themselves over it, which is delegation rule 1
       * defeated by a `null`.
       */
      if (!authority.isSuperAdmin) {
        throw policy({
          message: 'Only a super admin can create a top-level scope.',
          code: 'policy.root_scope_super_admin_only',
        });
      }
    } else {
      const parent = await scopeRepo.findById(db, input.parentId);
      if (!parent) throw notFound({ message: 'No such parent scope.', code: 'missing.scope' });

      assertCanAtScope(authority, 'scope.create', parent.path);

      if (!canNest(parent.depth)) {
        throw invalid({
          message: 'That is as deep as scopes may nest.',
          code: 'invalid.scope_depth',
        });
      }
    }

    const scope = await scopeRepo.create(db, {
      id: generateId(),
      organisationId: actor.organisationId,
      scopeTypeId: input.scopeTypeId,
      name: input.name,
      parentId: input.parentId,
      createdBy: actor.membershipId,
    });

    await log(db, {
      event: 'scope_created',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { scopeId: scope.id, name: scope.name, path: scope.path, parentId: input.parentId },
    });

    return scope;
  });
}

/**
 * The tree this actor can see.
 *
 * A SUPER ADMIN SEES ALL OF IT; AN ADMIN SEES THEIR SUBTREES; A MEMBER SEES THE
 * SCOPES THEY BELONG TO. Filtered here rather than by RLS because the policy is
 * about authority within a tenant, not about the tenant boundary — and expressing
 * "beneath a path this membership administers" as a policy would put the whole
 * permission model into SQL.
 */
export async function tree(actor: Actor): Promise<ScopeNode[]> {
  return withAuthority(actor, async (db, authority) => {
    const all = await scopeRepo.listAll(db);

    if (authority.isSuperAdmin) return toTree(all);

    const visible = all.filter(
      (scope) =>
        authority.adminPaths.some((admin) => contains(admin, scope.path)) ||
        authority.scopePaths.some((own) => contains(scope.path, own) || contains(own, scope.path)),
    );

    return toTree(visible);
  });
}

/**
 * Move a scope.
 *
 * BOTH ENDS ARE CHECKED. Authority over the node being moved is not authority
 * over where it is going — moving Platform out of Engineering and into Operations
 * removes it from the Engineering admin's reach, so an admin who held only the
 * source could give away a subtree.
 */
export async function move(
  actor: Actor,
  input: { scopeId: string; newParentId: string | null },
): Promise<Scope> {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'scope.move');

    const scope = await scopeRepo.findById(db, input.scopeId);
    if (!scope) throw notFound({ message: 'No such scope.', code: 'missing.scope' });

    assertCanAtScope(authority, 'scope.move', scope.path);

    if (input.newParentId === null) {
      if (!authority.isSuperAdmin) {
        throw policy({
          message: 'Only a super admin can move a scope to the top level.',
          code: 'policy.root_scope_super_admin_only',
        });
      }
    } else {
      const parent = await scopeRepo.findById(db, input.newParentId);
      if (!parent) throw notFound({ message: 'No such parent scope.', code: 'missing.scope' });

      assertCanAtScope(authority, 'scope.move', parent.path);

      /*
       * MOVING OUT OF YOUR OWN SUBTREE IS REFUSED FOR EVERYONE BUT A SUPER ADMIN.
       * The spec leaves this open; refusing is the answer a regulated customer
       * needs, and it is the safer default to relax later. Permitting it means an
       * admin can hand authority over a subtree to somebody else — which is a
       * privilege transfer with no approval step.
       */
      if (!authority.isSuperAdmin && !authority.adminPaths.some((p) => contains(p, parent.path))) {
        throw policy({
          message: 'A scope cannot be moved outside the part of the organisation you administer.',
          code: 'policy.move_outside_subtree',
        });
      }
    }

    const oldPath = scope.path;
    const moved = await scopeRepo.move(db, input.scopeId, input.newParentId);
    if (!moved) throw notFound({ message: 'No such scope.', code: 'missing.scope' });

    /*
     * BOTH PATHS ARE RECORDED. Moving a node silently changes who administers
     * everything beneath it, and that is precisely the change a reviewer will ask
     * to be evidenced. Without the old path there is no way to reconstruct what
     * the tree looked like when a grant was issued.
     */
    await log(db, {
      event: 'scope_moved',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { scopeId: moved.id, oldPath, newPath: moved.path },
    });

    return moved;
  });
}

/**
 * Archive.
 *
 * REASSIGNMENT FIRST, ALWAYS. A scope archived with memberships or live grants
 * still attached leaves people holding access through a node that appears in no
 * interface and is administered by nobody — access that is invisible and still
 * effective.
 */
export async function archive(actor: Actor, scopeId: string): Promise<void> {
  await withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'scope.archive');

    const scope = await scopeRepo.findById(db, scopeId);
    if (!scope) throw notFound({ message: 'No such scope.', code: 'missing.scope' });

    assertCanAtScope(authority, 'scope.archive', scope.path);

    const refs = await scopeRepo.referencesTo(db, scopeId);
    if (refs.children > 0 || refs.memberships > 0 || refs.assignments > 0) {
      throw policy({
        message:
          `That scope still has ${refs.children} child scope(s), ${refs.memberships} member(s) ` +
          `and ${refs.assignments} live grant(s). Move or remove them first.`,
        code: 'policy.scope_in_use',
        detail: refs,
      });
    }

    await scopeRepo.archive(db, scopeId);

    await log(db, {
      event: 'scope_archived',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { scopeId, path: scope.path },
    });
  });
}

/* ── Scope membership ────────────────────────────────────────────────────── */

export async function addMember(
  actor: Actor,
  input: { membershipId: string; scopeId: string; isPrimary?: boolean },
): Promise<void> {
  await withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'scope.assign');

    const scope = await scopeRepo.findById(db, input.scopeId);
    if (!scope) throw notFound({ message: 'No such scope.', code: 'missing.scope' });

    assertCanAtScope(authority, 'scope.assign', scope.path);

    const target = await membershipRepo.findById(db, input.membershipId);
    if (!target) throw notFound({ message: 'No such member.', code: 'missing.membership' });

    await scopeRepo.addMember(db, {
      id: generateId(),
      membershipId: input.membershipId,
      scopeId: input.scopeId,
      isPrimary: input.isPrimary ?? false,
      addedBy: actor.membershipId,
    });

    await log(db, {
      event: 'scope_membership_added',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { targetMembershipId: input.membershipId, scopeId: input.scopeId, path: scope.path },
    });
  });
}

/**
 * Who is in a scope, and who holds a role at it.
 *
 * ── You could put somebody in a scope and never see them again ─────────────
 *
 * `addMember` and `removeMember` have existed since the tree did; nothing could
 * LIST what they had done. An administrator could add a person to Engineering
 * and had no way to answer "who is in Engineering" except by asking each person
 * in turn.
 *
 * `scope.assign` RATHER THAN MEMBERSHIP ALONE, and checked AT THE SCOPE. Who is
 * in a scope and who can act there is the administrative picture of one corner
 * of the organisation — it is what somebody needs to decide a grant, and it is
 * exactly what somebody with no authority over that corner has no business
 * enumerating.
 */
export async function members(
  actor: Actor,
  scopeId: string,
): Promise<{
  members: Awaited<ReturnType<typeof scopeRepo.membersOf>>;
  assignments: Awaited<ReturnType<typeof authzRepo.listAssignmentsForScope>>;
}> {
  return withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'scope.assign');

    const scope = await scopeRepo.findById(db, scopeId);
    if (!scope) throw notFound({ message: 'No such scope.', code: 'missing.scope' });

    assertCanAtScope(authority, 'scope.assign', scope.path);

    /*
     * BOTH HALVES, BECAUSE THEY ANSWER DIFFERENT QUESTIONS AND LOOK ALIKE.
     * Being IN a scope is where your work sits; holding a role AT it is what you
     * may do there. Somebody can be either without the other, and an interface
     * showing one of them under a heading like "people" would be wrong in a way
     * nobody notices until a permission review.
     */
    return {
      members: await scopeRepo.membersOf(db, scopeId),
      assignments: await authzRepo.listAssignmentsForScope(db, scopeId),
    };
  });
}

export async function removeMember(
  actor: Actor,
  input: { membershipId: string; scopeId: string },
): Promise<void> {
  await withAuthority(actor, async (db, authority) => {
    assertCan(authority, 'scope.assign');

    const scope = await scopeRepo.findById(db, input.scopeId);
    if (!scope) throw notFound({ message: 'No such scope.', code: 'missing.scope' });

    assertCanAtScope(authority, 'scope.assign', scope.path);
    await scopeRepo.removeMember(db, input.membershipId, input.scopeId);

    await log(db, {
      event: 'scope_membership_removed',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: { targetMembershipId: input.membershipId, scopeId: input.scopeId },
    });
  });
}
