import type { Request, Response } from 'express';
import * as savedView from '../services/savedView.service';
import * as viewTransfer from '../services/viewTransfer.service';
import * as render from '../services/render.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';
import type { ConceptQuery } from '../engine/ontology/plan.ontology';

/** §7 — saved views: the question, kept, and asked again for nothing. */

export async function create(req: Request, res: Response): Promise<void> {
  const input = body<{ name: string; conceptId: string; query: ConceptQuery }>(req);
  res.status(201).json(await savedView.create(actorOf(req), input));
}

export async function mine(req: Request, res: Response): Promise<void> {
  res.status(200).json({ views: await savedView.mine(actorOf(req)) });
}

export async function read(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await savedView.read(actorOf(req), id));
}

export async function run(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const actor = actorOf(req);
  const { answer, sort } = await savedView.runWithQuery(actor, id);

  /*
   * Rendering §2 — "The user's choice persists PER VIEW", so a re-run opens in
   * whichever representation this person last chose for this view, and —
   * if they never chose — in §2's default for its shape. That is the one place a saved
   * view and an unsaved answer differ in how they draw.
   */
  res.status(200).json({
    ...answer,
    render: render.describe(answer, {
      sort,
      representation: await render.preferenceOf(actor, id),
    }),
  });
}

export async function rename(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { name } = body<{ name: string }>(req);
  res.status(200).json(await savedView.rename(actorOf(req), id, name));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await savedView.remove(actorOf(req), id));
}

/* ── AUTH rev 7: sharing ─────────────────────────────────────────────────── */

/** Views somebody else shared with this person, and what each one lets them do. */
export async function sharedWithMe(req: Request, res: Response): Promise<void> {
  res.status(200).json({ views: await savedView.sharedWithMe(actorOf(req)) });
}

export async function share(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<Parameters<typeof savedView.share>[2]>(req);
  res.status(201).json(await savedView.share(actorOf(req), id, input));
}

export async function shares(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ shares: await savedView.shares(actorOf(req), id) });
}

export async function revokeShare(req: Request, res: Response): Promise<void> {
  const { id, shareId } = params<{ id: string; shareId: string }>(req);
  res.status(200).json(await savedView.revokeShare(actorOf(req), id, shareId));
}

/* ── AUTH rev 7: views inherited from somebody who left ──────────────────── */

/** The receiving admin's queue: what they inherited, and what came with it. */
export async function inherited(req: Request, res: Response): Promise<void> {
  res.status(200).json({ inherited: await viewTransfer.inherited(actorOf(req)) });
}

export async function review(req: Request, res: Response): Promise<void> {
  const { flagId } = params<{ flagId: string }>(req);
  const { decision } = body<{ decision: 'shared' | 'retained' | 'archived' }>(req);
  res.status(200).json(await viewTransfer.review(actorOf(req), flagId, decision));
}

/**
 * rev 7's second act, as its own endpoint.
 *
 * NOT A FIELD ON THE REVIEW. "Reviewing the view does not resume the cron; that
 * is a second action" — and a `resumeCrons: true` in the review body would be
 * one request doing both, which is the same thing with a different shape.
 */
export async function resumeCron(req: Request, res: Response): Promise<void> {
  const { flagId, automationId } = params<{ flagId: string; automationId: string }>(req);
  res.status(200).json(await viewTransfer.resumeCron(actorOf(req), flagId, automationId));
}
