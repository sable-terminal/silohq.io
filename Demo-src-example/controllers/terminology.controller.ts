import type { Request, Response } from 'express';
import * as terminology from '../services/terminology.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/**
 * §12 — what this organisation calls a concept, and what the caller calls it.
 *
 * `list` ANSWERS FOR THE CALLER, not for the organisation. Two people can get
 * different words from the same route, which is what a per-user lens is.
 */

export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json({ concepts: await terminology.list(actorOf(req)) });
}

export async function setSkin(req: Request, res: Response): Promise<void> {
  const input = body<{ conceptId: string; term: string }>(req);
  res.status(200).json(await terminology.setSkin(actorOf(req), input));
}

export async function clearSkin(req: Request, res: Response): Promise<void> {
  const { conceptId } = params<{ conceptId: string }>(req);
  res.status(200).json(await terminology.clearSkin(actorOf(req), conceptId));
}

export async function setLens(req: Request, res: Response): Promise<void> {
  const input = body<{ conceptId: string; term: string }>(req);
  res.status(200).json(await terminology.setLens(actorOf(req), input));
}

export async function clearLens(req: Request, res: Response): Promise<void> {
  const { conceptId } = params<{ conceptId: string }>(req);
  res.status(200).json(await terminology.clearLens(actorOf(req), conceptId));
}
