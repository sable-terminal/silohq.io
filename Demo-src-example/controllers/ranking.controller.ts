import type { Request, Response } from 'express';
import * as ranking from '../services/ranking.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/**
 * §5 — ranking.
 *
 * THE OMITTED FINDINGS ARE IN THE RESPONSE, NOT BEHIND A SECOND CALL. §5.3 says
 * they remain visible on request; making the request a separate round trip is
 * how "visible" becomes "technically available" and then becomes a screen that
 * quietly shows less than was computed.
 */
export async function rank(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof ranking.rank>[1]>(req);
  res.status(200).json(await ranking.rank(actorOf(req), input));
}

export async function read(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ ranking: await ranking.read(actorOf(req), id) });
}
