import type { Request, Response } from 'express';
import * as dashboard from '../services/dashboard.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/** Rendering §8 — dashboards: named grids of saved views, re-run when opened. */

export async function mine(req: Request, res: Response): Promise<void> {
  res.status(200).json({ dashboards: await dashboard.mine(actorOf(req)) });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = body<{ name: string }>(req);
  res.status(201).json(await dashboard.create(actorOf(req), input));
}

/** Every widget re-run — free, because a saved view never goes near the compiler. */
export async function open(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await dashboard.open(actorOf(req), id));
}

export async function rename(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { name } = body<{ name: string }>(req);
  res.status(200).json(await dashboard.rename(actorOf(req), id, name));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await dashboard.remove(actorOf(req), id));
}

export async function addWidget(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { viewId } = body<{ viewId: string }>(req);
  res.status(201).json(await dashboard.addWidget(actorOf(req), id, viewId));
}

export async function removeWidget(req: Request, res: Response): Promise<void> {
  const { id, widgetId } = params<{ id: string; widgetId: string }>(req);
  res.status(200).json(await dashboard.removeWidget(actorOf(req), id, widgetId));
}

export async function arrange(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { widgets } = body<{ widgets: Array<{ id: string; width: number | null; height: number | null }> }>(req);
  res.status(200).json(await dashboard.arrange(actorOf(req), id, widgets));
}
