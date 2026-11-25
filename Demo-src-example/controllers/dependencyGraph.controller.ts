import type { Request, Response } from 'express';
import * as graph from '../services/dependencyGraph.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';
import type { EdgeJudgement } from '../services/dependencyGraph.service';

/** Simulation §2 — the graph of what waits on what. */

export async function derive(req: Request, res: Response): Promise<void> {
  res.status(200).json(await graph.derive(actorOf(req)));
}

export async function observe(req: Request, res: Response): Promise<void> {
  res.status(200).json(await graph.observe(actorOf(req)));
}

export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json(await graph.graph(actorOf(req)));
}

export async function confirm(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await graph.confirm(actorOf(req), id, body<EdgeJudgement>(req)));
}

export async function state(req: Request, res: Response): Promise<void> {
  const input = body<{ fromConceptId: string; toConceptId: string } & EdgeJudgement>(req);
  res.status(201).json(await graph.state(actorOf(req), input));
}

export async function revise(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await graph.revise(actorOf(req), id, body<EdgeJudgement & { reason: string }>(req)));
}

export async function retire(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { reason } = body<{ reason: string }>(req);
  res.status(200).json(await graph.retire(actorOf(req), id, reason));
}

export async function history(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ revisions: await graph.history(actorOf(req), id) });
}
