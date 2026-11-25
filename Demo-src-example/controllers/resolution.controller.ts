import type { Request, Response } from 'express';
import * as resolution from '../services/resolution.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';

/**
 * §2.6 — the questions the exact matcher could not answer.
 *
 * THE RATIONALE TRAVELS WITH THE PROPOSAL. A person is being asked to agree
 * that two records are one thing; "the model is 0.86 confident" is not
 * something anybody can agree or disagree with, and what makes it reviewable is
 * the sentence saying what in the two references is the same.
 */
export async function open(req: Request, res: Response): Promise<void> {
  const { conceptId } = query<{ conceptId?: string }>(req);
  res.status(200).json({ questions: await resolution.open(actorOf(req), { conceptId }) });
}

export async function propose(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { candidates } = body<{ candidates: string[] }>(req);
  res.status(200).json(await resolution.propose(actorOf(req), { pairId: id, candidates }));
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(201).json(await resolution.confirm(actorOf(req), id));
}

export async function reject(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await resolution.reject(actorOf(req), id);
  res.status(204).end();
}
