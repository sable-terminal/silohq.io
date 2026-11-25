import type { Request, Response } from 'express';
import * as audit from '../services/audit.service';
import { actorOf } from '../middleware/authorise.middleware';
import { query } from '../middleware/validate.middleware';
import { presentAuthEvent } from './present';

/**
 * §12 — the audit trail, read back.
 *
 * THE TRAIL HAS BEEN WRITTEN SINCE THE FIRST MIGRATION AND READ BY NOTHING.
 * Every sign-in, failed attempt, lockout, grant and revocation was recorded
 * correctly, in the same transaction as the act it describes, and no customer
 * could look at one row of it — which is indistinguishable from not keeping it.
 */
export async function list(req: Request, res: Response): Promise<void> {
  const filter = query<Parameters<typeof audit.list>[1]>(req);
  const { events, next } = await audit.list(actorOf(req), filter);

  /*
   * `next` IS NULL ON THE LAST PAGE RATHER THAN ABSENT. A client walking pages
   * needs to be told it has reached the end; a missing key reads as an older
   * server that does not page, and the walk stops for the wrong reason.
   */
  res.status(200).json({ events: events.map(presentAuthEvent), next });
}
