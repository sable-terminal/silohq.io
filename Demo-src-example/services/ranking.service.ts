import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { childLogger } from '../config/logger.config';
import { assertCan, authorityOf } from './authorisation.service';
import { ModelUnavailable, modelVersion, rankFindings } from '../infra/model.infra';
import {
  RankingRejected,
  summarise,
  validate,
  type FindingRow,
  type Ranking,
} from '../engine/analysis/ranking.analysis';
import * as associationRepo from '../repos/association.repo';
import * as findingRepo from '../repos/finding.repo';
import * as mapService from './map.service';
import * as rankingRepo from '../repos/ranking.repo';
import type { Actor } from './scope.service';

const log = childLogger('ranking');

/**
 * §5 — AI ranking.
 *
 * ── The order of operations is the architecture ─────────────────────────────
 *
 * Read the findings. Build a summary that cannot contain a value. Send it.
 * Validate what comes back against the findings that exist. Store it. Every one
 * of those steps is somewhere the claim could break, and each is in a place
 * where it can be read:
 *
 *   the summary — `engine/ranking.summarise`, tested without a network
 *   the send    — `infra/model.infra.rankFindings`, one function
 *   the check   — `engine/ranking.validate`, tested without a model
 *
 * NOTHING HERE REORDERS ANYTHING ITSELF. If the model is unavailable this
 * refuses and says so. A deterministic fallback ordering would be a different
 * product decision wearing the same endpoint — and the person reading it would
 * have no way to tell which they got.
 */

export type StoredRanking = Ranking & {
  id: string;
  modelVersion: string;
  createdAt: string;
};

/**
 * The most findings one ranking may cover.
 *
 * A BOUND BECAUSE THIS COSTS MONEY AND ATTENTION. §5.4 calls it a compile-class
 * operation and says it will be run repeatedly during exploration. Past a few
 * hundred findings the summary stops fitting a prompt usefully and the output
 * stops being something a person reads — narrowing to a concept is the answer,
 * not a longer list.
 */
const MOST_FINDINGS = 300;

/**
 * The most associations one ranking may be told about.
 *
 * ENOUGH TO EXPLAIN THE FINDINGS, NOT A SECOND REPORT. Associations are context
 * for an ordering — the strongest are what change where a finding belongs, and
 * the tail of weak ones spends prompt on pairs that would not move anything.
 */
const MOST_ASSOCIATIONS = 100;

/**
 * Rank what has been detected.
 *
 * §5.1 — AFTER DETECTION AND ASSOCIATION, and it does not run either. A ranking
 * over stale findings is a real risk and the honest fix is that the caller runs
 * the detectors; silently running them here would make one endpoint reach every
 * connected system as a side effect of asking for an ordering.
 */
export async function rank(
  actor: Actor,
  input: { conceptIds?: string[]; question?: string; investigationRef?: string } = {},
): Promise<StoredRanking & { findingsRead: number }> {
  const { findings, associations, outcomes, dismissals, weights } = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'query.run');

        const narrowed = input.conceptIds?.length ? input.conceptIds : null;

        /*
         * DECIDED FINDINGS ARE LEFT OUT, which `forRanking` does in its join.
         * §6.6 — a disposition is silenced for the person who made it, and a
         * ranking is that person's view. Somebody who has already judged a
         * finding does not need it ordered for them again, and it would crowd
         * out the ones they have not seen.
         */
        const found = await findingRepo.forRanking(db, {
          membershipId: actor.membershipId,
          conceptIds: narrowed,
          limit: MOST_FINDINGS,
        });

        const related = await associationRepo.forRanking(db, {
          conceptIds: narrowed,
          limit: MOST_ASSOCIATIONS,
        });

        const designated = await associationRepo.liveDesignations(db);

        /*
         * §5.5 — THE FEEDBACK SIGNAL, AS A RATE. Which conditions this
         * organisation keeps setting aside. It feeds the ranking layer and
         * never the detectors: detection stays deterministic, judgement learns,
         * and that separation is what keeps findings explainable while
         * relevance improves.
         */
        const dismissals = await findingRepo.dismissalRates(db);

        /*
         * §5.5 — WHAT THIS MAP HAS LEARNED, which `recordDisposition` has been
         * accumulating since maps existed and nothing has ever read. A map
         * could watch somebody dismiss the same detector forty times and go on
         * ordering it exactly as it did on the first day.
         *
         * SCOPED TO THE READER'S ACTIVE MAP, not to the organisation: two teams
         * looking at one estate can reasonably weigh the same detector
         * differently, and that is what a map is for.
         */
        const weights = await mapService.detectorWeights(db, actor);

        return {
          findings: found.map(
            (finding): FindingRow => ({
              ...finding,
              /* The model reads ISO strings; a repo hands back the Date it
                 read, and this is the only place the two meet. */
              occurredAt: finding.occurredAt?.toISOString() ?? null,
            }),
          ),
          /* Named rather than spread: the stored row carries an id and a
             strength figure that the summary has no use for. */
          associations: related.map((association) => ({
            a: association.a,
            b: association.b,
            coOccurrence: association.coOccurrence,
            sampleSize: association.sampleSize,
            lift: association.lift,
            temporalOrder: association.temporalOrder,
            structuralDirection: association.structuralDirection,
          })),
          outcomes: designated.map((designation) => ({
            conceptId: designation.conceptId,
            fieldPath: designation.fieldPath,
            direction: designation.direction,
            label: designation.label,
          })),
          dismissals,
          weights,
        };
      }),
  );

  if (findings.length === 0) {
    throw invalid({
      message: 'There is nothing to rank. Run the detectors first.',
      code: 'invalid.nothing_to_rank',
    });
  }

  /*
   * BUILT HERE, SO THE ONLY THING THE MODEL CAN BE SENT IS WHAT `summarise`
   * RETURNS. There is no path in this function from a database row to a prompt
   * that does not go through it, and that is the whole of §5.2's first
   * constraint.
   */
  const summary = summarise({ findings, associations, outcomes, dismissals, weights });

  let result;
  try {
    result = await rankFindings({
      summary: JSON.stringify(summary),
      question: input.question,
    });
  } catch (error) {
    if (error instanceof ModelUnavailable) {
      /*
       * A REFUSAL, NOT A FALLBACK. Ordering these deterministically would be a
       * different feature returning from the same endpoint, and nobody reading
       * the result could tell which one they got.
       */
      throw refusal({
        message:
          'Ranking needs the model and this deployment has none configured. The findings are all here, strongest deviation first.',
        code: 'refusal.model_unavailable',
      });
    }
    throw error;
  }

  if (!result.ok || !result.raw) {
    throw refusal({
      message: result.refusal ?? 'The model did not return a ranking.',
      code: 'refusal.ranking_declined',
    });
  }

  let ranking: Ranking;
  try {
    ranking = validate(JSON.parse(result.raw), findings);
  } catch (error) {
    if (error instanceof RankingRejected || error instanceof SyntaxError) {
      /*
       * §5.2 — REJECTED RATHER THAN REPAIRED. Nothing is patched, nothing is
       * partially kept. A ranking that cited a finding nobody computed is not a
       * ranking with one bad row in it.
       */
      log.warn({ err: error }, 'Ranking rejected');

      throw refusal({
        message:
          error instanceof RankingRejected
            ? `That ranking was not usable: ${error.reason}`
            : 'The model returned something that is not a ranking.',
        code: 'refusal.ranking_rejected',
        detail: error instanceof RankingRejected ? error.detail : {},
      });
    }
    throw error;
  }

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const version = modelVersion();

        const id = await rankingRepo.insert(db, {
          organisationId: actor.organisationId,
          investigationRef: input.investigationRef ?? null,
          modelVersion: version,
          ordered: ranking.ordered,
          groupings: ranking.groupings,
          omitted: ranking.omitted,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          createdBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'findings_ranked',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            rankingId: id,
            modelVersion: version,
            findingsRead: findings.length,
            ranked: ranking.ordered.length,
            omitted: ranking.omitted.length,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
        });

        /*
         * §3.4 — THE SYSTEM TUNES ITSELF HERE, and this is the "AI stage" the
         * spec means. The model does not choose the numbers: the adjustment
         * comes from what people did with what each detector raised, because a
         * threshold decides whether a finding EXISTS and a number a model
         * picked could not be explained to somebody asking why an exception
         * stopped appearing.
         *
         * AFTER THE RANKING, NOT BEFORE. A ranking that failed says nothing
         * about whether a threshold is wrong.
         */
        const tuned = await mapService.tuneThresholds(db, actor);

        log.info(
          {
            rankingId: id,
            findingsRead: findings.length,
            ranked: ranking.ordered.length,
            omitted: ranking.omitted.length,
            thresholdsTuned: tuned,
          },
          'Findings ranked',
        );

        return {
          ...ranking,
          id,
          modelVersion: version,
          createdAt: new Date().toISOString(),
          findingsRead: findings.length,
        };
      }),
  );
}

/**
 * A ranking somebody was shown, as they were shown it.
 *
 * §5.2 — "A user challenging a ranking is shown the computation, not an
 * assertion." Re-running would answer a different question: the findings will
 * have moved and the model may have changed underneath. This returns the row.
 */
export async function read(actor: Actor, rankingId: string): Promise<StoredRanking> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const stored = await rankingRepo.read(db, rankingId);

        if (!stored) {
          throw notFound({ message: 'That ranking does not exist.', code: 'missing.ranking' });
        }

        return { ...stored, createdAt: stored.createdAt.toISOString() };
      }),
  );
}
