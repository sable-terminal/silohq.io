import type { Request, Response } from 'express';
import * as simulation from '../services/simulation.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';

/** Simulation §3 and §5 — the question, and what running it reached. */

export async function save(req: Request, res: Response): Promise<void> {
  const input = body<{
    name: string;
    failedConceptId: string;
    failedEntityRefs: string[];
    maxHops?: number;
    maxPerHop?: number;
    mode?: 'deterministic' | 'probabilistic';
    horizonHours?: number;
    iterations?: number;
  }>(req);
  res.status(201).json(await simulation.save(actorOf(req), input));
}

export async function mine(req: Request, res: Response): Promise<void> {
  res.status(200).json({ scenarios: await simulation.mine(actorOf(req)) });
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await simulation.remove(actorOf(req), id));
}

export async function run(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await simulation.run(actorOf(req), id));
}

export async function runs(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ runs: await simulation.runs(actorOf(req), id) });
}

export async function read(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await simulation.read(actorOf(req), id));
}

export async function share(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { membershipId } = body<{ membershipId: string }>(req);
  res.status(200).json(await simulation.shareWith(actorOf(req), id, membershipId));
}

export async function shares(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ shares: await simulation.shares(actorOf(req), id) });
}

export async function revokeShare(req: Request, res: Response): Promise<void> {
  const { id, membershipId } = params<{ id: string; membershipId: string }>(req);
  res.status(200).json(await simulation.revokeShare(actorOf(req), id, membershipId));
}

export async function compare(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { against } = query<{ against: string }>(req);
  res.status(200).json(await simulation.compare(actorOf(req), id, against));
}
