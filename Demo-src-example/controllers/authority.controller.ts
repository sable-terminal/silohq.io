import type { Request, Response } from 'express';
import * as authority from '../services/authority.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';

/**
 * §2.8 — which system is right about a field.
 *
 * THE ANSWER TO "WHY IS THIS NUMBER WHAT IT IS". Without a declaration a field
 * two systems disagree about has NO merged value at all — `merge` returns
 * `disputed` and no figure — so this is not a refinement of an answer, it is
 * what makes one exist.
 */
export async function list(req: Request, res: Response): Promise<void> {
  const { conceptId } = query<{ conceptId?: string }>(req);
  res.status(200).json({ authorities: await authority.list(actorOf(req), conceptId) });
}

export async function declare(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof authority.declare>[1]>(req);
  res.status(201).json({ authority: await authority.declare(actorOf(req), input) });
}

export async function retire(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await authority.retire(actorOf(req), id);
  res.status(204).send();
}

/**
 * §2.3 — what this organisation calls a column.
 *
 * SAID ONCE PER SYSTEM. Every concept confirmed over that connection afterwards
 * inherits it, which is the difference between mapping an ERP once and mapping
 * it again for every concept somebody builds over it.
 */
export async function corrections(req: Request, res: Response): Promise<void> {
  const { connectionId } = query<{ connectionId: string }>(req);
  res.status(200).json({ corrections: await authority.listCorrections(actorOf(req), connectionId) });
}

export async function correctField(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof authority.correctField>[1]>(req);
  res.status(201).json({ correction: await authority.correctField(actorOf(req), input) });
}

export async function removeCorrection(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await authority.removeCorrection(actorOf(req), id);
  res.status(204).send();
}

/**
 * §7.3 — which fields of a concept are times.
 *
 * WITHOUT ONE, NO PERIOD CAN BE APPLIED AT ALL. "Last quarter's invoices" has
 * no meaning until something says which column a quarter is measured against,
 * and most concepts have several that would each give a different answer.
 */
export async function timeFields(req: Request, res: Response): Promise<void> {
  const { conceptId } = query<{ conceptId: string }>(req);
  res.status(200).json({ timeFields: await authority.timeFields(actorOf(req), conceptId) });
}

export async function declareTimeField(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof authority.declareTimeField>[1]>(req);
  res.status(201).json({ timeField: await authority.declareTimeField(actorOf(req), input) });
}

export async function removeTimeField(req: Request, res: Response): Promise<void> {
  const input = body<{ conceptId: string; fieldPath: string }>(req);
  await authority.removeTimeField(actorOf(req), input);
  res.status(204).send();
}
