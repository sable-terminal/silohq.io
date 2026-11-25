import type { Request, Response } from 'express';
import * as billing from '../services/billing.service';
import * as tokens from '../services/tokens.service';
import * as simulations from '../services/simulations.service';
import * as storageBilling from '../services/storageBilling.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body } from '../middleware/validate.middleware';
import type { Plan } from '../models/organisation.model';
import type { Term } from '../models/billing.model';

/**
 * The subscription, the seats it buys, and what they entitle.
 */

export async function summary(req: Request, res: Response): Promise<void> {
  res.status(200).json(await billing.summary(actorOf(req)));
}

export async function subscribe(req: Request, res: Response): Promise<void> {
  const input = body<{ plan: Plan; seats: number; term: Term }>(req);
  res.status(200).json(await billing.subscribe(actorOf(req), input));
}

export async function addSeats(req: Request, res: Response): Promise<void> {
  const { count } = body<{ count: number }>(req);
  res.status(200).json(await billing.addSeats(actorOf(req), count));
}

export async function releaseSeats(req: Request, res: Response): Promise<void> {
  const { count } = body<{ count: number }>(req);
  res.status(200).json(await billing.releaseSeats(actorOf(req), count));
}

export async function usage(req: Request, res: Response): Promise<void> {
  res.status(200).json(await tokens.usage(actorOf(req)));
}

export async function buyTokens(req: Request, res: Response): Promise<void> {
  const { tokens: quantity } = body<{ tokens: number }>(req);
  res.status(201).json(await tokens.purchase(actorOf(req), quantity));
}

export async function autoTopUp(req: Request, res: Response): Promise<void> {
  const { enabled } = body<{ enabled: boolean }>(req);
  res.status(200).json(await tokens.setAutoTopUp(actorOf(req), enabled));
}

export async function simulationsStanding(req: Request, res: Response): Promise<void> {
  res.status(200).json(await simulations.standing(actorOf(req)));
}

/* §5 — a price by agreement, so this always refuses and says where to go. */
export async function buySimulations(req: Request, res: Response): Promise<void> {
  await simulations.purchase(actorOf(req));
}

/* §6 — the provider's cost and the 10%, per Silo per month, not a blended rate. */
export async function storage(req: Request, res: Response): Promise<void> {
  res.status(200).json(await storageBilling.statement(actorOf(req)));
}

/**
 * BILLING §2 — the organisation's own daily ceiling on one person's spend.
 *
 * `null` MEANS "FOLLOW THE PLAN" rather than "no limit", which is why the body
 * allows it explicitly instead of treating an absent field as a clear.
 */
export async function setDailyLimit(req: Request, res: Response): Promise<void> {
  const { dailyLimit } = body<{ dailyLimit: number | null }>(req);
  res.status(200).json(await tokens.setDailyLimit(actorOf(req), dailyLimit));
}
