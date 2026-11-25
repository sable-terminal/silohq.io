import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { denial, invalid, isAppError, notFound, policy } from '../utils/error.util';
import { assertCan, authorityOf } from './authorisation.service';
import * as conceptRepo from '../repos/concept.repo';
import * as savedViewRepo from '../repos/savedView.repo';
import * as viewTransferRepo from '../repos/viewTransfer.repo';
import * as notifications from './notification.service';
import * as organisationRepo from '../repos/organisation.repo';
import * as membershipRepo from '../repos/membership.repo';
import { log as writeAudit } from './audit.service';
import * as conceptQuery from './conceptQuery.service';
import * as render from './render.service';
import type { Archetype } from '../models/render.model';
import type { ConceptQuery } from '../engine/ontology/plan.ontology';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

/**
 * §7 — a result saved as a question that can be asked again.
 *
 * ── Re-running is free, and that is the point ──────────────────────────────
 *
 * "Compiling is metered, re-running is free. Every saved view increases account
 * value without increasing cost of goods." So `run` goes straight to the
 * deterministic engine and never near the compiler: no model call, no token
 * charged. If running a view ever started metering, the commercial argument for
 * saving one would invert.
 *
 * ── The question, never the answer ─────────────────────────────────────────
 *
 * Nothing is cached. A view holds a concept and a compiled query; asking it
 * produces a fresh answer every time. A cached result would be a copy of
 * customer data in the control plane — the one thing this architecture says it
 * does not keep — and it would go stale where nobody could see it.
 *
 * ── Shared on the terms maps are, and run as the opener ───────────────────
 *
 * AUTH rev 7: private until its owner shares it, with a named person, a scope
 * or the organisation, at one of three accesses — see it, run it, or take a
 * copy. What the organisation's sharing policy permits is the ceiling, and it
 * is the same policy and the same shapes maps use, so there is one answer to
 * "who may share what with whom" rather than two.
 *
 * AND IT RUNS AS WHOEVER OPENED IT. rev 7: "A shared view runs under the
 * opener's permissions, never the owner's." That falls out of how running
 * works — `conceptQuery.ask` resolves permissions, markings, grants and field
 * policy for the caller — so a view shared by somebody with clearance on
 * salaries answers a colleague without it minus those fields, rather than
 * leaking them.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

export type Saved = savedViewRepo.SavedView & { concept: { id: string; name: string } };

/**
 * Save a question.
 *
 * `query.run` AND NOT A PERMISSION OF ITS OWN. Saving a question you are
 * allowed to ask adds nothing you could not already do; a separate grant would
 * only stop somebody keeping their own work.
 */
export async function create(
  actor: Actor,
  input: { name: string; conceptId: string; query: ConceptQuery },
): Promise<Saved> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'query.run');

      const concept = await conceptRepo.read(db, input.conceptId);
      if (!concept) throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });

      const view = await savedViewRepo.create(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        ownerMembershipId: actor.membershipId,
        name: input.name,
        conceptId: input.conceptId,
        query: input.query,
      });

      return { ...view, concept: { id: concept.id, name: concept.name } };
    }),
  );
}

export async function mine(actor: Actor): Promise<Saved[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const views = await savedViewRepo.listOwnedBy(db, actor.membershipId);
      return Promise.all(views.map((view) => withConcept(db, view)));
    }),
  );
}

export async function read(actor: Actor, id: string): Promise<Saved & { access: savedViewRepo.ViewAccess }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const { view, access } = await mustReach(db, actor, id, 'view');
      return { ...(await withConcept(db, view)), access };
    }),
  );
}

/**
 * Ask the saved question again.
 *
 * NOT METERED, AND THE ROUTE IT TAKES IS WHY. This calls the engine directly;
 * the compiler is the thing that costs a token and it is not on this path.
 *
 * PERMISSIONS ARE RE-CHECKED AT RUN TIME, inside `ask`, against the caller as
 * they are now. A view saved while somebody could read a field does not keep
 * reading it after that grant is withdrawn — the question is stored, the
 * authority never is.
 */
/**
 * The answer and the ordering it was asked in.
 *
 * Rendering §4.1 reads two of its signals from the ordering — a series is "a
 * measure over time" and a ranking "entities ordered by magnitude" — and an
 * answer is a set of entities that does not carry the order it was asked for.
 * So a caller drawing a re-run needs the sort beside the answer.
 */
export async function runWithQuery(
  actor: Actor,
  id: string,
): Promise<{ answer: conceptQuery.ConceptAnswer; sort: ConceptQuery['sort'] }> {
  const { view } = await runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => mustReach(db, actor, id, 'run')),
  );

  /*
   * rev 7 — "A shared view runs under the opener's permissions, never the
   * owner's." Nothing here has to arrange that: `ask` resolves permissions,
   * markings, grants and field policy for whoever is asking, so a view shared
   * by somebody with clearance on salaries answers a colleague without it minus
   * those fields rather than leaking them.
   */
  return {
    answer: await conceptQuery.ask(actor, { conceptId: view.conceptId, query: view.query }),
    sort: view.query.sort,
  };
}

export async function rename(actor: Actor, id: string, name: string): Promise<Saved> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);
      const renamed = await savedViewRepo.rename(db, { id, name });
      if (!renamed) throw notFound({ message: 'That view does not exist.', code: 'missing.view' });
      return withConcept(db, renamed);
    }),
  );
}

/**
 * Delete it.
 *
 * AN INHERITED VIEW IS NOT DELETABLE, AND THE DATABASE AGREES. rev 7 — "Transfer
 * flags cannot be deleted, only resolved", and a flag whose view is gone is a
 * flag that has been deleted by another route. The foreign key refuses it; this
 * says so in words and names the answer that does what the person wanted, rather
 * than letting a constraint violation reach them as "something went wrong".
 */
export async function remove(actor: Actor, id: string): Promise<{ removed: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);

      const flags = await viewTransferRepo.countForView(db, id);
      if (flags > 0) {
        throw policy({
          message: 'This view was inherited, so it cannot be deleted. Archive it instead.',
          code: 'policy.view_transferred',
        });
      }

      return { removed: await savedViewRepo.remove(db, id) };
    }),
  );
}

/* ── AUTH rev 7: sharing ─────────────────────────────────────────────────── */

export type Grantee = { membershipId: string } | { scopeId: string } | { organisationWide: true };

/**
 * Share a view, within the organisation and no further.
 *
 * THE POLICY IS CHECKED HERE, NOT AT THE ROUTE, because which grantees are
 * legal depends on a row and a route cannot read one. The narrowest setting
 * applies where there is no organisation to read: private by default.
 *
 * `view.share` AND OWNERSHIP, NOT ONE OR THE OTHER. rev 7 — "a view cannot be
 * shared by anyone other than its current owner", and holding the permission
 * is what says this organisation lets this person share at all.
 */
export async function share(
  actor: Actor,
  id: string,
  input: { grantee: Grantee; access: savedViewRepo.ViewAccess; expiresAt?: string },
): Promise<{ id: string; access: savedViewRepo.ViewAccess }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'view.share');
      await mustOwn(db, actor, id);

      /*
       * AN INHERITED VIEW IS NOT SHAREABLE UNTIL IT HAS BEEN ANSWERED. rev 7 —
       * until the flag is reviewed the view "is visible to the receiving admin
       * alone", and that promise is only kept if the new owner cannot widen it
       * first. Answering the queue is what shares it on; the refusal says so
       * rather than reading as a bug.
       */
      const outstanding = await viewTransferRepo.outstandingForView(db, id);
      if (outstanding) {
        throw policy({
          message: 'This view was inherited. Decide what happens to it before sharing it.',
          code: 'policy.view_transfer_unreviewed',
        });
      }

      const organisation = await organisationRepo.findById(db, actor.organisationId);
      const sharingPolicy = organisation?.sharingPolicy ?? 'explicit_only';
      const grantee = input.grantee;
      const wide = 'organisationWide' in grantee;

      if (sharingPolicy === 'disabled') {
        throw policy({ message: 'Sharing is turned off for this organisation.', code: 'policy.sharing_disabled' });
      }
      if (sharingPolicy === 'explicit_only' && !('membershipId' in grantee)) {
        throw policy({
          message: 'This organisation allows sharing with named people only.',
          code: 'policy.sharing_explicit_only',
        });
      }
      if (sharingPolicy === 'scope_only' && wide) {
        throw policy({
          message: 'This organisation does not allow sharing with everybody.',
          code: 'policy.sharing_scope_only',
        });
      }

      /*
       * THE GRANTEE HAS TO BE IN THIS ORGANISATION, and tenancy alone does not
       * prove it: a membership id from another tenant is simply not found here,
       * which is the answer we want, said plainly rather than as a foreign key
       * error at the end of the transaction.
       */
      if ('membershipId' in grantee) {
        const member = await membershipRepo.findById(db, grantee.membershipId);
        if (!member || member.organisationId !== actor.organisationId) {
          throw notFound({ message: 'That person is not in this organisation.', code: 'missing.membership' });
        }
        if (grantee.membershipId === actor.membershipId) {
          throw invalid({ message: 'It is already yours.', code: 'invalid.share_with_self' });
        }
      }

      const shareId = await savedViewRepo.upsertShare(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        viewId: id,
        membershipId: 'membershipId' in grantee ? grantee.membershipId : null,
        scopeId: 'scopeId' in grantee ? grantee.scopeId : null,
        organisationWide: wide,
        access: input.access,
        sharedBy: actor.membershipId,
        expiresAt: input.expiresAt ?? null,
      });

      /*
       * A NAMED PERSON IS TOLD; A SCOPE OR THE ORGANISATION IS NOT. One share
       * with everybody would otherwise write a row per member at the moment of
       * the share, and a bell that rings for everything is a bell nobody reads.
       * A view shared widely is found where views are found.
       */
      if ('membershipId' in grantee) {
        const view = await savedViewRepo.read(db, id);
        await notifications.tell(db, {
          organisationId: actor.organisationId,
          membershipId: grantee.membershipId,
          byMembershipId: actor.membershipId,
          kind: 'view',
          title: `${view?.name ?? 'A saved view'} was shared with you`,
          body:
            input.access === 'view'
              ? 'You can read it. Running it is not part of this share.'
              : 'Open it in the Console; it runs as you, with what you can see.',
          href: '/console',
        });
      }

      await writeAudit(db, {
        event: 'view_shared',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: {
          viewId: id,
          access: input.access,
          granteeType: 'membershipId' in grantee ? 'membership' : 'scopeId' in grantee ? 'scope' : 'organisation',
          granteeId: 'membershipId' in grantee ? grantee.membershipId : 'scopeId' in grantee ? grantee.scopeId : null,
        },
      });

      return { id: shareId, access: input.access };
    }),
  );
}

/** Who a view is shared with now. The owner's question, so only the owner may ask it. */
export async function shares(actor: Actor, id: string): Promise<savedViewRepo.ViewShare[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);
      return savedViewRepo.sharesOf(db, id);
    }),
  );
}

/** Take it back. A share already revoked is not an action, so it is refused rather than moved. */
export async function revokeShare(actor: Actor, id: string, shareId: string): Promise<{ revoked: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustOwn(db, actor, id);

      const share = await savedViewRepo.findLiveShare(db, shareId);
      if (!share || share.viewId !== id) {
        throw notFound({ message: 'That share does not exist, or it has already been taken back.', code: 'missing.share' });
      }

      await savedViewRepo.revokeShare(db, shareId);

      await writeAudit(db, {
        event: 'view_share_revoked',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { viewId: id, granteeId: share.membershipId ?? share.scopeId, access: share.access },
      });

      return { revoked: true };
    }),
  );
}

/** Views somebody else shared, and what each one lets this person do. */
export async function sharedWithMe(actor: Actor): Promise<Array<Saved & { access: savedViewRepo.ViewAccess }>> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const shared = await savedViewRepo.sharedWith(db, actor.membershipId);
      return Promise.all(shared.map(async (view) => ({ ...(await withConcept(db, view)), access: view.access })));
    }),
  );
}

/**
 * The view, if it is the caller's.
 *
 * A VIEW SOMEBODY ELSE OWNS IS REFUSED AS A DENIAL, NOT AS MISSING, because
 * tenancy already stops another organisation's from being seen at all — so
 * inside one organisation the honest answer is "not yours" rather than a
 * pretence that it does not exist.
 */
/**
 * The view, if this person may reach it at all — theirs, or shared with them
 * at an access that covers what they are about to do.
 *
 * THE THREE ARE A LADDER: copy can do what run can, and run what view can.
 * Anything weaker is a denial that says what the share allows, because "not
 * found" to somebody looking at a link a colleague sent them is a bug report.
 */
async function mustReach(
  db: PoolClient,
  actor: Actor,
  id: string,
  need: savedViewRepo.ViewAccess,
): Promise<{ view: savedViewRepo.SavedView; access: savedViewRepo.ViewAccess }> {
  const view = await savedViewRepo.read(db, id);
  if (!view) throw notFound({ message: 'That view does not exist.', code: 'missing.view' });

  if (view.ownerMembershipId === actor.membershipId) return { view, access: 'copy' };

  const access = await savedViewRepo.accessFor(db, { viewId: id, membershipId: actor.membershipId });
  if (!access) {
    throw denial({ message: 'That saved view belongs to somebody else.', code: 'denial.view_not_owned' });
  }

  const ladder: savedViewRepo.ViewAccess[] = ['view', 'run', 'copy'];
  if (ladder.indexOf(access) < ladder.indexOf(need)) {
    throw denial({
      message: access === 'view' ? 'This view was shared with you to read, not to run.' : 'That is not what this share allows.',
      code: 'denial.view_access',
    });
  }

  return { view, access };
}

async function mustOwn(db: PoolClient, actor: Actor, id: string): Promise<savedViewRepo.SavedView> {
  const view = await savedViewRepo.read(db, id);
  if (!view) throw notFound({ message: 'That view does not exist.', code: 'missing.view' });

  if (view.ownerMembershipId !== actor.membershipId) {
    throw denial({
      message: 'That saved view belongs to somebody else.',
      code: 'denial.view_not_owned',
    });
  }
  return view;
}

async function withConcept(db: PoolClient, view: savedViewRepo.SavedView): Promise<Saved> {
  const concept = await conceptRepo.read(db, view.conceptId);
  return { ...view, concept: { id: view.conceptId, name: concept?.name ?? '' } };
}

/* ── Rendering §8: a view drawn small ───────────────────────────────────── */

export type Tile =
  | {
      viewId: string;
      name: string;
      state: 'ran';
      /** §8 — "Each tile is the view's chosen archetype, rendered smaller." */
      archetype: Archetype;
      /** §8 — what it falls back to where the archetype cannot be read at tile size. */
      tileArchetype: Archetype;
      answer: conceptQuery.ConceptAnswer;
      rendered: render.Rendered;
      /** §8 — "Tiles re-run on open… and state when they last did." */
      ranAt: Date;
    }
  | {
      viewId: string;
      name: string;
      /**
       * THIS TILE COULD NOT RUN, AND THE OTHERS STILL DID.
       *
       * The first version let one failure throw out of the loop, so a single
       * view over a retired concept, a revoked grant or a system that was
       * down answered the WHOLE dashboard with a 400. With twelve tiles that is
       * eleven good answers thrown away over one, and a grid that looks broken
       * when eleven twelfths of it are fine. The reason travels on the tile, in
       * the server's own words.
       */
      state: 'failed';
      message: string;
      code: string;
      ranAt: Date;
    };

/**
 * §8 — one view, run and described for a tile.
 *
 * ── "TILES RE-RUN ON OPEN, AT NO METERED COST" ────────────────────────────
 *
 * Both halves are already true and neither is this function's doing. A tile is
 * a saved view, and §7 of Billing makes re-running one free — "compiling is
 * metered, re-running is free" — because `run` goes to the query path and
 * never near the compiler.
 *
 * ── AND IT STATES WHEN ────────────────────────────────────────────────────
 *
 * "…and state when they last did." A figure on a wall with no time on it is
 * the thing somebody quotes in a meeting three weeks later. The stamp is taken
 * here rather than stored, because it belongs to this reading rather than to
 * the view.
 */
export async function tileOf(actor: Actor, view: savedViewRepo.SavedView): Promise<Tile> {
  try {
    const answer = await conceptQuery.ask(actor, { conceptId: view.conceptId, query: view.query });
    const rendered = render.describe(answer, { sort: view.query.sort });

    return {
      viewId: view.id,
      name: view.name,
      state: 'ran',
      archetype: rendered.archetype.chosen,
      tileArchetype: render.tileArchetype(rendered.archetype),
      answer,
      rendered,
      ranAt: new Date(),
    };
  } catch (error) {
    /*
     * AN APP ERROR IS THE TILE'S ANSWER; ANYTHING ELSE IS OURS. A refusal,
     * a denial or an invalid view is something the person can read and act
     * on, so it is put on the tile. An unexpected failure is rethrown, because
     * swallowing it into a tile would turn a bug in this service into a grid
     * that quietly shows "could not run" everywhere.
     */
    if (!isAppError(error)) throw error;
    return {
      viewId: view.id,
      name: view.name,
      state: 'failed',
      message: error.message,
      code: error.code,
      ranAt: new Date(),
    };
  }
}
