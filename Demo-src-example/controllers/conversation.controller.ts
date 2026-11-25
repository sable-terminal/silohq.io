import type { Request, Response } from 'express';
import * as conversation from '../services/conversation.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';
import type { TurnKind } from '../repos/conversation.repo';

/** PRODUCT §2.2 — conversations: the words that were exchanged, kept for thirty days from last use. */

export async function mine(req: Request, res: Response): Promise<void> {
  res.status(200).json({ conversations: await conversation.mine(actorOf(req)) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = body<{ title: string }>(req);
  res.status(201).json(await conversation.create(actorOf(req), input));
}

export async function open(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await conversation.open(actorOf(req), id));
}

export async function rename(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { title } = body<{ title: string }>(req);
  res.status(200).json(await conversation.rename(actorOf(req), id, title));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await conversation.remove(actorOf(req), id));
}

export async function addTurn(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<{ asked: string; said: string; kind: TurnKind }>(req);
  res.status(201).json(await conversation.addTurn(actorOf(req), id, input));
}
