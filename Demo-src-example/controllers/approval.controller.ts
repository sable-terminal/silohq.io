import type { Request, Response } from 'express';
import * as approval from '../services/approval.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';
import type { ApprovalAction, ApprovalStatus } from '../repos/approval.repo';

/**
 * The approval chain: which actions need a second person, and deciding them.
 */

export async function policies(req: Request, res: Response): Promise<void> {
  res.status(200).json({ policies: await approval.policies(actorOf(req)) });
}

export async function setPolicy(req: Request, res: Response): Promise<void> {
  const { action } = params<{ action: ApprovalAction }>(req);
  const { approvalsRequired } = body<{ approvalsRequired: number }>(req);
  res.status(200).json(await approval.setPolicy(actorOf(req), { action, approvalsRequired }));
}

export async function removePolicy(req: Request, res: Response): Promise<void> {
  const { action } = params<{ action: ApprovalAction }>(req);
  await approval.removePolicy(actorOf(req), action);
  res.status(204).end();
}

export async function requests(req: Request, res: Response): Promise<void> {
  const { status } = query<{ status?: ApprovalStatus }>(req);
  res.status(200).json({ requests: await approval.requests(actorOf(req), { status }) });
}

export async function approve(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { reason } = body<{ reason?: string }>(req);
  res.status(200).json(await approval.decide(actorOf(req), id, { decision: 'approve', reason }));
}

export async function reject(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { reason } = body<{ reason: string }>(req);
  res.status(200).json(await approval.decide(actorOf(req), id, { decision: 'reject', reason }));
}
