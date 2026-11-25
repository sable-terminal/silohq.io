import type { Request, Response } from 'express';
import { ask, askComplete, queryableConnections } from '../services/connector.service';
import type { SourceOutcome } from '../engine/execution/fanout.execution';
import { actorOf } from '../middleware/authorise.middleware';
import { body } from '../middleware/validate.middleware';
import { toResponse } from '../utils/error.util';
import type { Query } from '../engine/execution/query.execution';

/**
 * Asking a question of every connected system at once.
 *
 * THE SHAPE OF THE ANSWER IS THE POINT. Rows come back grouped by the source
 * that produced them, never merged into one list — two systems with a `Customer`
 * each hold different customers, and concatenating them produces a number that
 * is confidently wrong. Merging is the ontology's job and the ontology does not
 * exist yet, so this does not pretend.
 *
 * WHAT REACHED THE SOURCE IS REPORTED. §6 declares pushdown per connector, and
 * the caller has to know which half of its question the source answered and
 * which half was applied here — that difference decides whether the count it is
 * looking at is the whole truth or a page.
 */

function present(outcome: SourceOutcome) {
  return {
    connectionId: outcome.connectionId,
    source: outcome.name,
    rows: outcome.result?.rows ?? [],
    /*
     * `fetched` BESIDE `rows.length`, because they differ whenever a filter
     * could not be pushed down — and a caller seeing four rows out of nine
     * thousand read is looking at a very different query from one where the
     * source did the work.
     */
    fetched: outcome.result?.fetched ?? 0,
    pushedDown: outcome.result
      ? {
          filters: outcome.result.pushedDown.filters.map((f) => f.field),
          sort: outcome.result.pushedDown.sort,
          limit: outcome.result.pushedDown.limit,
        }
      : null,
    durationMs: outcome.result?.durationMs ?? 0,
  };
}

function presentFailure(outcome: SourceOutcome) {
  const response = toResponse(outcome.error);
  return {
    connectionId: outcome.connectionId,
    source: outcome.name,
    error: response.body.error,
  };
}

export async function run(req: Request, res: Response): Promise<void> {
  const input = body<
    Query & { connectionIds?: string[]; allowPartial: boolean }
  >(req);

  const { allowPartial, connectionIds, ...query } = input;
  const actor = actorOf(req);

  /*
   * THE DEFAULT PATH REFUSES A PARTIAL ANSWER AND SAYS WHICH SOURCE FAILED.
   * `askComplete` throws, and it throws for the right reason: an answer missing
   * a system is not a smaller answer.
   */
  if (!allowPartial) {
    const answered = await askComplete({ actor, connectionIds, query });
    res.status(200).json({
      complete: true,
      sources: answered.map(present),
      failed: [],
    });
    return;
  }

  const outcome = await ask({ actor, connectionIds, query });

  /*
   * PARTIAL WAS ASKED FOR, SO IT IS RETURNED — AND SAID SO IN THE BODY. A caller
   * that opted in still has to be able to tell, and `complete: false` beside the
   * list of what failed is harder to ignore than an absence.
   */
  res.status(200).json({
    complete: outcome.failed.length === 0,
    sources: outcome.answered.map(present),
    failed: outcome.failed.map(presentFailure),
    durationMs: outcome.durationMs,
  });
}

/**
 * What could be asked, and of what.
 *
 * A CATALOGUE RATHER THAN A SCHEMA DUMP. Somebody about to ask a question needs
 * to know which objects exist and which fields can be filtered at the source;
 * the rest of the manifest is the builder's business.
 */
export async function catalogue(req: Request, res: Response): Promise<void> {
  res.status(200).json({ connections: await queryableConnections(actorOf(req)) });
}
