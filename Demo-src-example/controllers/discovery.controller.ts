import type { Request, Response } from 'express';
import * as discovery from '../services/discovery.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';

/**
 * §9's HTTP surface.
 *
 * THE AGENT IS A CALLER HERE, NOT A THING SILO RUNS. It authenticates as a
 * service principal, starts a run against an authorisation it was given, and
 * reports what it found. Everything it may do is bounded by the authorisation
 * row rather than by what it asks for.
 */

export async function setEnabled(req: Request, res: Response): Promise<void> {
  const { enabled } = body<{ enabled: boolean }>(req);
  res.status(200).json(await discovery.setEnabled(actorOf(req), enabled));
}

export async function authorise(req: Request, res: Response): Promise<void> {
  const input = body<{
    agentId: string;
    ranges: string[];
    methods: discovery.ScanMethod[];
    expiresAt: Date;
    approvalId?: string | null;
  }>(req);

  res.status(201).json(await discovery.authoriseScan(actorOf(req), input));
}

export async function revoke(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await discovery.revokeAuthorisation(actorOf(req), id);
  res.status(204).end();
}

export async function startRun(req: Request, res: Response): Promise<void> {
  const { authorisationId } = body<{ authorisationId: string }>(req);
  res.status(201).json(await discovery.startRun(actorOf(req), authorisationId));
}

export async function report(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof discovery.recordFindings>[1]>(req);
  res.status(200).json(await discovery.recordFindings(actorOf(req), input));
}

export async function findings(req: Request, res: Response): Promise<void> {
  const { runId } = query<{ runId?: string }>(req);
  res.status(200).json({ findings: await discovery.listFindings(actorOf(req), { runId }) });
}

/**
 * ONE FINDING AT A TIME. §9.4 — "An admin approves items individually." There is
 * no bulk endpoint, and that is the design: a scan of a large estate returns
 * dozens of findings, and Approve All would make the review the formality the
 * approval exists to prevent.
 */
export async function decide(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { decision } = body<{ decision: 'accepted' | 'rejected' | 'ignored' }>(req);

  res.status(200).json(await discovery.promoteFinding(actorOf(req), id, decision));
}

export async function runs(req: Request, res: Response): Promise<void> {
  res.status(200).json({ runs: await discovery.listRuns(actorOf(req)) });
}
