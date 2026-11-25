import type { Request, Response } from 'express';
import * as association from '../services/association.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/**
 * §4 — associations and outcome designations.
 *
 * THE RESPONSE CARRIES THE POPULATION IT MEASURED AGAINST. §4.1 says sample
 * size is stated always, and an association read without knowing how many
 * entities were examined is a ratio with no denominator — which is every
 * correlation anybody has ever been misled by.
 */
export async function compute(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof association.compute>[1]>(req);
  res.status(200).json(await association.compute(actorOf(req), input));
}

export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json({ associations: await association.list(actorOf(req)) });
}

export async function designate(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof association.designate>[1]>(req);
  res.status(201).json({ designation: await association.designate(actorOf(req), input) });
}

export async function designations(req: Request, res: Response): Promise<void> {
  res.status(200).json({ designations: await association.designations(actorOf(req)) });
}

export async function retire(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await association.retire(actorOf(req), id);
  res.status(204).end();
}
