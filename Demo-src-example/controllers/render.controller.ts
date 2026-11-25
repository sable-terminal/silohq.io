import type { Request, Response } from 'express';
import * as render from '../services/render.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

export async function record(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof render.record>[1]>(req);
  res.status(201).json(await render.record(actorOf(req), input));
}

export async function override(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof render.override>[1]>(req);
  await render.override(actorOf(req), input);
  res.status(204).end();
}

/**
 * §7.3 — where the precedence is being argued with.
 *
 * THE ONLY REASON THE TABLE EXISTS. Nothing reads it to choose an archetype;
 * somebody reads it to decide whether the fixed order is wrong, and then changes
 * the order in code for everybody.
 */
export async function overrideRates(req: Request, res: Response): Promise<void> {
  res.status(200).json({ archetypes: await render.overrideRates(actorOf(req)) });
}

/**
 * §2 — which of the three this person wants for this view.
 *
 * PER VIEW, NOT GLOBALLY. "Someone who prefers rows for one thing may want the
 * picture for another", which is the ordinary case rather than the rare one.
 */
export async function preferRepresentation(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof render.preferRepresentation>[1]>(req);
  await render.preferRepresentation(actorOf(req), input);
  res.status(204).end();
}

export async function representationFor(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ representation: await render.representationFor(actorOf(req), id) });
}

/**
 * §5 — the second of the three moves every archetype supports.
 *
 * THE RECORDS ARE NOT FETCHED HERE. Drilling in means asking the query layer
 * for them with the reader's own permissions, exactly as any other question.
 * This is the trail: §5 makes drilling universal across the archetypes, and a
 * product that cannot say whether anybody uses it is guessing about its shape.
 */
export async function recordDrill(req: Request, res: Response): Promise<void> {
  await render.recordDrill(actorOf(req), body<Parameters<typeof render.recordDrill>[1]>(req));
  res.status(204).end();
}

export async function recordFlagOpened(req: Request, res: Response): Promise<void> {
  await render.recordFlagOpened(
    actorOf(req),
    body<Parameters<typeof render.recordFlagOpened>[1]>(req),
  );
  res.status(204).end();
}
