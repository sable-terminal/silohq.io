import type { Request, Response } from 'express';
import * as map from '../services/map.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/**
 * §6 — maps.
 *
 * `coverage` IS IN THE RESPONSE OF BOTH OPEN AND SHARE. §6.4 — a share states
 * how much of the map is reachable by the recipient rather than leaving them to
 * discover it, and the person opening one deserves the same sentence. A number
 * that only reaches a log is the same as no number.
 */
export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json({ maps: await map.list(actorOf(req)) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof map.create>[1]>(req);
  res.status(201).json({ map: await map.create(actorOf(req), input) });
}

export async function open(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await map.open(actorOf(req), id));
}

export async function activate(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await map.activate(actorOf(req), id);
  res.status(204).end();
}

export async function archive(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await map.archive(actorOf(req), id);
  res.status(204).end();
}

export async function share(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<Parameters<typeof map.share>[2]>(req);
  res.status(201).json(await map.share(actorOf(req), id, input));
}

export async function revokeShare(req: Request, res: Response): Promise<void> {
  const { shareId } = params<{ shareId: string }>(req);
  await map.revokeShare(actorOf(req), shareId);
  res.status(204).end();
}
