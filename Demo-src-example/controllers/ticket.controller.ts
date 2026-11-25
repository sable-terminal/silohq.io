import type { Request, Response } from 'express';
import * as tickets from '../services/ticket.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';
import type { TicketKind } from '../repos/ticket.repo';

/** Tickets: what somebody asked us for, and how far it has got. */

export async function raise(req: Request, res: Response): Promise<void> {
  const input = body<{ kind: TicketKind; body: string }>(req);
  res.status(201).json(await tickets.raise(actorOf(req), input));
}

export async function mine(req: Request, res: Response): Promise<void> {
  res.status(200).json(await tickets.mine(actorOf(req)));
}

export async function open(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await tickets.open(actorOf(req), id));
}
