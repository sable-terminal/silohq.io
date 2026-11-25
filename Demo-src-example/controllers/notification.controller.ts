import type { Request, Response } from 'express';
import * as notifications from '../services/notification.service';
import { actorOf } from '../middleware/authorise.middleware';
import { params } from '../middleware/validate.middleware';

/** The bell: what happened that this person did not do. */

export async function mine(req: Request, res: Response): Promise<void> {
  res.status(200).json(await notifications.mine(actorOf(req)));
}

export async function markRead(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await notifications.markRead(actorOf(req), id));
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  res.status(200).json(await notifications.markAllRead(actorOf(req)));
}
