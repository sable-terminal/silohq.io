import type { Request, Response } from 'express';
import * as siloKeep from '../services/siloKeep.service';
import * as siloSync from '../services/siloSync.service';
import * as siloShare from '../services/siloShare.service';
import * as silo from '../services/silo.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/**
 * §10 — Siloes. The only storage in the product, and the only place it is
 * turned on.
 *
 * EVERY ROUTE BELOW IS UNREACHABLE IN A SOVEREIGN BUILD. The router is not
 * mounted, so these paths 404 like any other unknown URL rather than existing
 * and refusing — "off means unreachable, not idle."
 */

/** §11 — whether storage is on, and the disclosure to read before switching it on. */
export async function storage(req: Request, res: Response): Promise<void> {
  res.status(200).json(await silo.storage(actorOf(req)));
}

/** §3 — the master switch. `silo.enable`, super admin only, never delegable. */
export async function setStorage(req: Request, res: Response): Promise<void> {
  const input = body<{ enabled: boolean; acknowledgedDisclosure?: string }>(req);
  await silo.setStorageEnabled(actorOf(req), input);
  res.status(204).end();
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = body<{ name: string; purpose: string; retentionDays: number }>(req);
  res.status(201).json(await silo.create(actorOf(req), input));
}

/* ── Siloes (135): concepts kept whole ─────────────────────────────────── */

export async function kept(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ kept: await siloKeep.keptIn(actorOf(req), id) });
}

export async function keep(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { conceptId, history } = body<{ conceptId: string; history?: boolean }>(req);
  res.status(201).json({
    systems: await siloSync.keep(actorOf(req), { siloId: id, conceptId, ...(history === undefined ? {} : { history }) }),
  });
}

/** Make a copy now. It runs for as long as the systems take, and says how each one went. */
export async function syncKept(req: Request, res: Response): Promise<void> {
  const { conceptId } = params<{ id: string; conceptId: string }>(req);
  res.status(200).json({ systems: await siloSync.copy(actorOf(req), conceptId) });
}

export async function release(req: Request, res: Response): Promise<void> {
  const { conceptId } = params<{ id: string; conceptId: string }>(req);
  await siloSync.stop(actorOf(req), conceptId);
  res.status(204).end();
}

export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json({ siloes: await silo.list(actorOf(req)) });
}

export async function addConcept(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { conceptId, fields } = body<{ conceptId: string; fields: string[] }>(req);
  res.status(201).json(await silo.addConcept(actorOf(req), { siloId: id, conceptId, fields }));
}

/** §4 — change which fields of a nominated concept are captured. */
export async function setFields(req: Request, res: Response): Promise<void> {
  const { id, conceptId } = params<{ id: string; conceptId: string }>(req);
  const { fields } = body<{ fields: string[] }>(req);
  res.status(200).json(await silo.setFields(actorOf(req), { siloId: id, conceptId, fields }));
}

/**
 * §3 — what else could be captured, and NOTHING CASCADES.
 *
 * Related concepts are PROPOSED and each one is added by the same deliberate
 * act as the first.
 */
export async function candidates(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ candidates: await silo.candidates(actorOf(req), id) });
}

export async function setRetention(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { retentionDays } = body<{ retentionDays: number }>(req);
  await silo.setRetention(actorOf(req), { siloId: id, retentionDays });
  res.status(204).end();
}

/**
 * §9 — the wipe. Returns a receipt, and says which detectors stop working.
 *
 * 200 WITH A RECEIPT, OR 202 WITH A REQUEST. A delete that returns nothing is a
 * delete nobody can prove happened. Where the organisation requires approval,
 * nothing has been deleted yet, and 202 says exactly that.
 */
export async function purge(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const target = body<silo.PurgeRequest>(req);
  const outcome = await silo.purge(actorOf(req), { siloId: id, ...target });
  res.status(outcome.status === 'pending' ? 202 : 200).json(outcome);
}

/** §10 — bytes held and scanned. Counted from day one, because import will be large. */
export async function usage(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await silo.usage(actorOf(req), id));
}

/**
 * §4 — stop capturing a concept. `silo.manage`, and nothing is deleted.
 *
 * 200, NOT 204, because the body is the correction to the obvious assumption:
 * what was already captured is still there.
 */
export async function removeConcept(req: Request, res: Response): Promise<void> {
  const { id, conceptId } = params<{ id: string; conceptId: string }>(req);
  res.status(200).json(await silo.removeConcept(actorOf(req), { siloId: id, conceptId }));
}

/** §9 — what was deleted, and when. The proof that outlives the data. */
export async function receipts(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ receipts: await silo.receipts(actorOf(req), id) });
}

/**
 * §11 — what this Silo holds, in words somebody can forward.
 *
 * ASSEMBLED FROM THE ROWS, so a customer answering a subject access request is
 * forwarding a fact rather than a claim somebody typed into a settings page.
 */
export async function disclosure(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await silo.disclosure(actorOf(req), id));
}

/* ── Siloes (139): a Silo read by other tools ──────────────────────────── */

export async function readers(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await siloShare.readers(actorOf(req), id));
}

export async function grantReader(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { kind, email } = body<{ kind: 'user' | 'group' | 'service_account'; email: string }>(req);
  res.status(201).json(await siloShare.grant(actorOf(req), { siloId: id, kind, email }));
}

export async function revokeReader(req: Request, res: Response): Promise<void> {
  const { id, readerId } = params<{ id: string; readerId: string }>(req);
  res.status(200).json(await siloShare.revoke(actorOf(req), { siloId: id, readerId }));
}
