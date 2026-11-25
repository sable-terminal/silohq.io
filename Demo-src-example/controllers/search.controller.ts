import type { Request, Response } from 'express';
import * as search from '../services/search.service';
import { actorOf } from '../middleware/authorise.middleware';
import { query } from '../middleware/validate.middleware';
import { unauthenticated } from '../utils/error.util';

/** Finding a saved view, a file, a connection, a Silo, a concept, a cron or a person by name. */

export async function find(req: Request, res: Response): Promise<void> {
  const { q } = query<{ q: string }>(req);

  /*
   * THE BILLING STATE COMES OFF THE REQUEST, NOT OUT OF A SECOND LOOKUP.
   * `requireAuth` has already resolved it, and the routers for views, crons and
   * files each gate on it — so search asks the same question from the same
   * answer rather than a fresher one that could disagree with the page it is
   * about to link to.
   */
  const capabilities = req.auth?.capabilities;
  if (!capabilities) throw unauthenticated();

  res.status(200).json(await search.search(actorOf(req), { query: q, capabilities }));
}
