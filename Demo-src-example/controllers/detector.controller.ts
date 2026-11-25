import type { Request, Response } from 'express';
import * as detector from '../services/detector.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';

/**
 * §3 — detectors and what they found.
 *
 * `detectors` IS IN EVERY RUN RESPONSE, naming what each of the ten did: ran,
 * not configured, still accumulating a baseline, or unavailable with a specific
 * reason. The product must say this at the point somebody asks rather than
 * silently returning fewer findings — a short list with no explanation reads as
 * "nothing is wrong here", which is the one conclusion none of those states
 * supports.
 *
 * IT REPLACED A LIST OF THREE NAMES. The old response said timing deviation,
 * drift and recurrence were unavailable whenever Siloes were off — which was
 * wrong every time the customer's own system held the history, and that is the
 * common case.
 */
export async function run(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof detector.run>[1]>(req);
  res.status(200).json(await detector.run(actorOf(req), input));
}

export async function list(req: Request, res: Response): Promise<void> {
  const { includeDecided } = query<{ includeDecided?: boolean }>(req);

  /*
   * NO DETECTOR STATUS HERE, AND THAT IS DELIBERATE. Whether a detector could
   * run depends on the concept it was pointed at and what that concept's
   * connections declare — questions only a run can answer. Reporting a guess
   * beside a list of stored findings would be reporting it about no concept in
   * particular.
   */
  res.status(200).json({
    findings: await detector.list(actorOf(req), { includeDecided }),
  });
}

export async function decide(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<Omit<Parameters<typeof detector.decide>[1], 'findingId'>>(req);

  await detector.decide(actorOf(req), { findingId: id, ...input });
  res.status(204).end();
}
