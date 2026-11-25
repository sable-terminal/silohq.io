import { withTransaction } from '../infra/db.infra';
import { notFound } from '../utils/error.util';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import * as conceptRepo from '../repos/concept.repo';
import * as terminologyRepo from '../repos/terminology.repo';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

/**
 * §12 — "Terminology skins per organisation. Per-user lens on presentation."
 *
 * ── A word laid over a concept, never a rename ─────────────────────────────
 *
 * A recruiter says Placement, a law firm says Matter, the ontology says Deal,
 * and all three are one concept that must resolve across systems as one. So
 * nothing here writes to `concepts.name`, and nothing here is readable by the
 * compiler, the planner or a mapping. The canonical name decides; the skin is
 * only ever handed to a reader beside it.
 *
 * THE COST OF GETTING THAT WRONG IS SILENT. If a skin reached the compiler,
 * renaming Deal to Matter would rewrite every saved question in the
 * organisation at once, and two customers asking the same sentence would
 * compile to different plans — a divergence neither of them could see.
 *
 * ── Lens over skin over canonical ──────────────────────────────────────────
 *
 * Somebody's own word wins for them alone, the organisation's word wins for
 * everybody else, and the concept's own name is what is left. A lens needs no
 * permission because it changes nothing anybody else can see; a skin needs one
 * because it changes what every reader in the organisation is told a thing is.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

export type Named = { conceptId: string; name: string; display: string };

/**
 * The word this actor should be shown for each concept.
 *
 * `name` IS KEPT BESIDE `display`, ALWAYS. A caller that only received the
 * display word could not tell whether two answers were about the same concept,
 * and the canonical name is the thing that makes them comparable.
 */
export async function resolveFor(
  db: PoolClient,
  actor: Actor,
  concepts: ReadonlyArray<{ id: string; name: string }>,
): Promise<Named[]> {
  if (concepts.length === 0) return [];

  const skin = new Map(
    (await terminologyRepo.forOrganisation(db, actor.organisationId)).map((one) => [one.conceptId, one.term]),
  );
  const lens = new Map(
    (await terminologyRepo.forMembership(db, actor.membershipId)).map((one) => [one.conceptId, one.term]),
  );

  return concepts.map((concept) => ({
    conceptId: concept.id,
    name: concept.name,
    display: lens.get(concept.id) ?? skin.get(concept.id) ?? concept.name,
  }));
}

/** Every concept this organisation has renamed, and what each person calls it. */
export async function list(actor: Actor): Promise<Named[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const concepts = await conceptRepo.listLive(db);
      return resolveFor(db, actor, concepts);
    }),
  );
}

/**
 * Set what the organisation calls a concept.
 *
 * AUDITED WITH BOTH WORDS. "Why does this say Matter" is answered by the row,
 * and it is only answerable if the row says what it said before.
 */
export async function setSkin(actor: Actor, input: { conceptId: string; term: string }): Promise<Named> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'terminology.manage');

      const concept = await mustRead(db, input.conceptId);

      const previous = await terminologyRepo.setForOrganisation(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        conceptId: input.conceptId,
        term: input.term,
        setBy: actor.membershipId,
      });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'terminology_set',
        /*
         * `term` AND `previousTerm`, RATHER THAN THE GENERIC PAIR. The Silo
         * egress check reserves the generic value key names for what a customer
         * record actually said, and a word an administrator chose is not that.
         * Reusing them would have meant widening an exception list whose whole
         * job is to stay narrow — and naming them even in a comment is enough
         * to trip it, which is the check working.
         */
        detail: {
          conceptId: input.conceptId,
          name: concept.name,
          term: input.term,
          previousTerm: previous,
        },
      });

      return { conceptId: concept.id, name: concept.name, display: input.term };
    }),
  );
}

export async function clearSkin(actor: Actor, conceptId: string): Promise<{ cleared: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'terminology.manage');

      const concept = await mustRead(db, conceptId);
      const cleared = await terminologyRepo.clearForOrganisation(db, {
        organisationId: actor.organisationId,
        conceptId,
      });

      if (cleared) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'terminology_cleared',
          detail: { conceptId, name: concept.name },
        });
      }

      return { cleared };
    }),
  );
}

/**
 * Set what this person calls a concept.
 *
 * NO PERMISSION, AND NO AUDIT ROW. It is visible to one membership and changes
 * nothing anybody else is shown, so recording it in the organisation's trail
 * would be surveillance of a preference rather than evidence of a decision.
 */
export async function setLens(actor: Actor, input: { conceptId: string; term: string }): Promise<Named> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const concept = await mustRead(db, input.conceptId);

      await terminologyRepo.setForMembership(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        conceptId: input.conceptId,
        term: input.term,
      });

      return { conceptId: concept.id, name: concept.name, display: input.term };
    }),
  );
}

export async function clearLens(actor: Actor, conceptId: string): Promise<{ cleared: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => ({
      cleared: await terminologyRepo.clearForMembership(db, {
        membershipId: actor.membershipId,
        conceptId,
      }),
    })),
  );
}

/** The concept, or a refusal naming it. */
async function mustRead(db: PoolClient, conceptId: string) {
  const concept = await conceptRepo.read(db, conceptId);
  if (!concept) throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
  return concept;
}
