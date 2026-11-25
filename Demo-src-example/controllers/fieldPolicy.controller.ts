import type { Request, Response } from 'express';
import * as fieldPolicy from '../services/fieldPolicy.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/**
 * Field policies: which fields of a connection each person may see.
 */

export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json({ policies: await fieldPolicy.list(actorOf(req)) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof fieldPolicy.create>[1]>(req);
  res.status(201).json({ policies: await fieldPolicy.create(actorOf(req), input) });
}

export async function revoke(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await fieldPolicy.revoke(actorOf(req), id);
  res.status(204).end();
}
