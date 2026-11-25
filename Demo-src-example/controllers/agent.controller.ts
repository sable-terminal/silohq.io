import type { Request, Response } from 'express';
import * as agents from '../services/agent.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/**
 * Agents: installing, listing and revoking them; routing a connection through
 * one; and the one call an agent makes before it has a token.
 */

export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json({ agents: await agents.list(actorOf(req)) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const { name } = body<{ name: string }>(req);
  res.status(201).json(await agents.create(actorOf(req), name));
}

export async function revoke(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await agents.revoke(actorOf(req), id);
  res.status(204).end();
}

export async function assign(req: Request, res: Response): Promise<void> {
  const { connectionId } = params<{ connectionId: string }>(req);
  const input = body<Parameters<typeof agents.assign>[2]>(req);
  res.status(200).json({ hosts: await agents.assign(actorOf(req), connectionId, input) });
}

export async function route(req: Request, res: Response): Promise<void> {
  const { connectionId } = params<{ connectionId: string }>(req);
  res.status(200).json(await agents.routeOf(actorOf(req), connectionId));
}

export async function enrol(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof agents.enrol>[0]>(req);
  res.status(201).json(await agents.enrol(input));
}
