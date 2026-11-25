import type { Request, Response } from 'express';
import * as seatService from '../services/seat.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';
import { stateOf, type Seat } from '../models/seat.model';

/**
 * Licences.
 *
 * THE COUNTS ARE THE ANSWER, AND THE ROWS ARE THE EVIDENCE. "How many seats are
 * left" is the question every one of these endpoints exists to serve, and
 * computing it in the client from a list is how two screens end up disagreeing
 * about whether a reserved seat counts as free.
 */
function present(seat: Seat) {
  return {
    id: seat.id,
    state: stateOf(seat),
    heldBy: seat.heldBy,
    heldSince: seat.heldSince?.toISOString() ?? null,
    reservedFor: seat.reservedFor,
    createdAt: seat.createdAt.toISOString(),
  };
}

export async function summary(req: Request, res: Response): Promise<void> {
  const { counts, seats } = await seatService.summary(actorOf(req));
  res.status(200).json({ counts, seats: seats.filter((s) => !s.retiredAt).map(present) });
}

export async function allocate(req: Request, res: Response): Promise<void> {
  const { membershipId } = body<{ membershipId: string }>(req);
  const seat = await seatService.allocateTo(actorOf(req), { membershipId });
  res.status(201).json({ seat: present(seat) });
}

export async function reclaim(req: Request, res: Response): Promise<void> {
  const { seatId } = params<{ seatId: string }>(req);
  const seat = await seatService.reclaim(actorOf(req), seatId);
  res.status(200).json({ seat: present(seat) });
}

export async function retire(req: Request, res: Response): Promise<void> {
  const { seatId } = params<{ seatId: string }>(req);
  await seatService.retire(actorOf(req), seatId);
  res.status(204).end();
}

export async function add(req: Request, res: Response): Promise<void> {
  const { count } = body<{ count: number }>(req);
  const seats = await seatService.addSeats(actorOf(req), count);
  res.status(201).json({ added: seats.length });
}
