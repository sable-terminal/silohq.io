import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound, policy, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { childLogger } from '../config/logger.config';
import { assertCan, authorityOf } from './authorisation.service';
import { ModelUnavailable, proposeResolution } from '../infra/model.infra';
import * as tokens from './tokens.service';
import * as conceptRepo from '../repos/concept.repo';
import * as resolutionRepo from '../repos/resolution.repo';
import { stateOf, type UnresolvedPair } from '../models/resolution.model';
import type { Actor } from './scope.service';

const log = childLogger('resolution');

/**
 * §2.6 — where the exact matcher fails.
 *
 * ── Why this is its own service ────────────────────────────────────────────
 *
 * IT IS THE ONLY PLACE INFERENCE TOUCHES IDENTITY. Everywhere else in this
 * product, two rows are the same entity because their agreed match keys are
 * equal — arithmetic, no judgement, no threshold to tune. Here the matcher has
 * failed, a model is asked to guess, and a person decides.
 *
 * Keeping that in one file with one door is what makes the boundary auditable.
 * A reviewer asking "where does the AI affect what counts as the same customer"
 * can be handed this file and told: here, and nowhere else.
 *
 * ── The shape of the promise ───────────────────────────────────────────────
 *
 * The resolver records a question. The model fills in half of it and says why.
 * A person confirms or rejects. On confirmation the pair becomes an exact
 * mapping in `confirmed_resolutions` and is NEVER INFERRED AGAIN — every
 * resolution afterwards reads it as fact.
 *
 * So inference happens once, in front of somebody, and everything downstream of
 * that moment is arithmetic. That is the sentence this service exists to make
 * true.
 */

export type OpenQuestion = UnresolvedPair & {
  conceptName: string;
  state: ReturnType<typeof stateOf>;
};

/**
 * The questions waiting for a person.
 *
 * SCOPED TO WHAT THEY CAN REACH IS THE CALLER'S JOB, not this one's — the pairs
 * carry connection ids and the concept view already filters by them. What this
 * refuses to do is hide a question because it is inconvenient: a queue that
 * looks empty while somebody else waits for a decision is worse than a long one.
 */
export async function open(
  actor: Actor,
  options: { conceptId?: string } = {},
): Promise<OpenQuestion[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const pairs = await resolutionRepo.openPairs(db, options);
        if (pairs.length === 0) return [];

        const concepts = await conceptRepo.listLive(db);
        const named = new Map(concepts.map((concept) => [concept.id, concept.name]));

        return pairs.map((pair) => ({
          ...pair,
          conceptName: named.get(pair.conceptId) ?? 'a retired concept',
          state: stateOf(pair),
        }));
      }),
  );
}

/**
 * Ask the model whether an unmatched reference is one of the candidates.
 *
 * IT WRITES A PROPOSAL, NOT A DECISION. `confirmed_at` is untouched; the row
 * gains a candidate and a rationale, and it is still an open question. Somebody
 * has to agree with the reasoning before anything resolves.
 *
 * THE CANDIDATES ARE THE OTHER SIDE'S OWN UNMATCHED REFERENCES, and that bound
 * matters: the model is choosing among references that already failed to match,
 * not searching a customer's estate. A reference that matched something else is
 * not a candidate for this, because it is already resolved.
 *
 * A REFUSAL WHERE THE MODEL IS ABSENT, NOT A FALLBACK. Guessing without it —
 * by edit distance, say — would be the fuzzy matching §2.6 spends a paragraph
 * refusing, reintroduced at the one point nobody would look for it.
 */
export async function propose(
  actor: Actor,
  input: { pairId: string; candidates: string[] },
): Promise<{ match: string | null; rationale: string }> {
  const { pair, conceptName, matchKeys } = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        const found = await resolutionRepo.readPair(db, input.pairId);
        if (!found) {
          throw notFound({ message: 'That question does not exist.', code: 'missing.pair' });
        }
        if (stateOf(found) !== 'open') {
          throw policy({
            message: `That question was already ${stateOf(found)}.`,
            code: 'policy.pair_decided',
          });
        }

        const concept = await conceptRepo.read(db, found.conceptId);
        if (!concept || concept.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        return {
          pair: found,
          conceptName: concept.name,
          /* Field NAMES, so the model knows what the systems agreed to match on
             without being shown what any record holds in them. */
          matchKeys: [...new Set(concept.objects.flatMap((object) => object.matchKeys))],
        };
      }),
  );

  /* Refused before the model runs, as every metered operation is. */
  await tokens.afford(actor, 'repair_proposal');

  let result;
  try {
    result = await proposeResolution({
      concept: conceptName,
      reference: pair.valueRefA,
      candidates: input.candidates,
      matchKeys,
    });
  } catch (error) {
    if (error instanceof ModelUnavailable) {
      throw refusal({
        message:
          'Proposing a match needs the model and this deployment has none. The question stays open for somebody to decide by hand.',
        code: 'refusal.model_unavailable',
      });
    }
    throw error;
  }

  if (!result.ok || !result.raw) {
    throw refusal({
      message: result.refusal ?? 'The model did not answer.',
      code: 'refusal.proposal_declined',
    });
  }

  /* Billing §4 — a repair proposal is two tokens, charged once the model answered. */
  await tokens.spend(actor, 'repair_proposal');

  let answer: { match?: unknown; rationale?: unknown };
  try {
    answer = JSON.parse(result.raw) as typeof answer;
  } catch {
    throw refusal({
      message: 'The model returned something that is not a proposal.',
      code: 'refusal.proposal_rejected',
    });
  }

  const rationale = typeof answer.rationale === 'string' ? answer.rationale.trim() : '';
  const match = typeof answer.match === 'string' ? answer.match : null;

  /*
   * §2.6 — A MATCH THE MODEL INVENTED IS REJECTED, NOT REPAIRED. The candidates
   * were given to it; anything else is a reference nobody read out of a source,
   * and confirming one would write a mapping to a row that may not exist. Same
   * rule §5.2 applies to rankings, for the same reason.
   */
  if (match !== null && !input.candidates.includes(match)) {
    log.warn({ pairId: input.pairId }, 'Model proposed a reference it was not given');
    throw refusal({
      message: 'That proposal named a record nobody read. It was not applied.',
      code: 'refusal.proposal_rejected',
    });
  }

  if (rationale === '') {
    throw refusal({
      message: 'The model gave no reason, so there is nothing for anybody to agree with.',
      code: 'refusal.proposal_rejected',
    });
  }

  if (match === null) {
    log.info({ pairId: input.pairId }, 'Model declined to propose a match');
    return { match: null, rationale };
  }

  await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        await resolutionRepo.attachProposal(db, {
          id: input.pairId,
          valueRefB: match,
          rationale,
        });

        await writeAudit(db, {
          event: 'unresolved_pair_proposed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            pairId: input.pairId,
            conceptId: pair.conceptId,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
        });
      }),
  );

  return { match, rationale };
}

/**
 * A person agrees: these two are one entity.
 *
 * THE MAPPING IS WRITTEN AND THE QUESTION IS CLOSED, IN ONE TRANSACTION. A
 * confirmation that recorded the decision without writing the mapping would
 * leave resolution behaving exactly as it did before, and the person would be
 * asked again next week — which is the specific thing §2.6 promises will not
 * happen.
 */
export async function confirm(actor: Actor, pairId: string): Promise<{ resolutionId: string }> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        const pair = await resolutionRepo.readPair(db, pairId);
        if (!pair) {
          throw notFound({ message: 'That question does not exist.', code: 'missing.pair' });
        }
        if (stateOf(pair) !== 'open') {
          throw policy({
            message: `That question was already ${stateOf(pair)}.`,
            code: 'policy.pair_decided',
          });
        }

        /*
         * A QUESTION WITH ONLY ONE SIDE CANNOT BE CONFIRMED. "This invoice has
         * no counterpart in Sage" is a finding, not a mapping — there is nothing
         * to map it TO until either the model or a person names the other row.
         */
        if (pair.valueRefB.trim() === '') {
          throw invalid({
            message: 'Nothing has been proposed as the other half of that pair yet.',
            code: 'invalid.pair_incomplete',
          });
        }

        const resolutionId = await resolutionRepo.confirmResolution(db, {
          organisationId: actor.organisationId,
          conceptId: pair.conceptId,
          connectionA: pair.connectionA,
          valueRefA: pair.valueRefA,
          connectionB: pair.connectionB,
          valueRefB: pair.valueRefB,
          pairId: pair.id,
          confirmedBy: actor.membershipId,
        });

        await resolutionRepo.markConfirmed(db, { id: pair.id, by: actor.membershipId });

        await writeAudit(db, {
          event: 'unresolved_pair_confirmed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            pairId: pair.id,
            conceptId: pair.conceptId,
            proposedBy: pair.proposedBy,
            connections: [pair.connectionA, pair.connectionB],
          },
        });

        log.info(
          { pairId: pair.id, conceptId: pair.conceptId, proposedBy: pair.proposedBy },
          'Resolution confirmed — this pair is exact from now on',
        );

        return { resolutionId };
      }),
  );
}

/**
 * A person disagrees.
 *
 * KEPT AS A DECISION, NOT DELETED. How often the model's proposals are rejected
 * is the only measure of whether asking it is worth the tokens, and a queue that
 * forgets what was turned down cannot produce that number. It also stops the
 * same pair being re-proposed on the next detector run.
 */
export async function reject(actor: Actor, pairId: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        const pair = await resolutionRepo.readPair(db, pairId);
        if (!pair) {
          throw notFound({ message: 'That question does not exist.', code: 'missing.pair' });
        }
        if (stateOf(pair) !== 'open') {
          throw policy({
            message: `That question was already ${stateOf(pair)}.`,
            code: 'policy.pair_decided',
          });
        }

        await resolutionRepo.markRejected(db, pairId);

        await writeAudit(db, {
          event: 'unresolved_pair_rejected',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { pairId, conceptId: pair.conceptId, proposedBy: pair.proposedBy },
        });
      }),
  );
}
