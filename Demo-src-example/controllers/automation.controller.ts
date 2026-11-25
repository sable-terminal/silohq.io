import type { Request, Response } from 'express';
import * as automation from '../services/automation.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/** Automations §11 — the schedule, and every run of it. */

type CreateInput = Parameters<typeof automation.create>[1];

export async function create(req: Request, res: Response): Promise<void> {
  res.status(201).json(await automation.create(actorOf(req), body<CreateInput>(req)));
}

export async function mine(req: Request, res: Response): Promise<void> {
  res.status(200).json({ automations: await automation.mine(actorOf(req)) });
}

export async function read(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await automation.read(actorOf(req), id));
}

/* §11 — including the runs where the condition did not hold. */
export async function history(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ runs: await automation.history(actorOf(req), id) });
}

export async function pause(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await automation.pause(actorOf(req), id));
}

export async function resume(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await automation.resume(actorOf(req), id));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await automation.remove(actorOf(req), id));
}

/* §11 — what the caller's scheduled checks found. */
export async function fired(req: Request, res: Response): Promise<void> {
  res.status(200).json({ runs: await automation.fired(actorOf(req)) });
}

/* §4 — what is waiting on the caller, and answering it. */

export async function outstanding(req: Request, res: Response): Promise<void> {
  res.status(200).json({ escalations: await automation.outstanding(actorOf(req)) });
}

export async function acknowledge(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { note } = body<{ note: string | null }>(req);
  res.status(200).json(await automation.acknowledge(actorOf(req), id, note));
}

/* §5 — permission to write with nobody present, and withdrawing it. */

export async function authorise(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<Parameters<typeof automation.authoriseExecution>[2]>(req);
  res.status(201).json(await automation.authoriseExecution(actorOf(req), id, input));
}

export async function revokeAuthorisation(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await automation.revokeExecution(actorOf(req), id));
}
