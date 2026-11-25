import type { Request, Response } from 'express';
import * as mutation from '../services/mutation.service';
import * as approval from '../services/mutationApproval.service';
import * as execution from '../services/mutationExecution.service';
import * as revert from '../services/mutationRevert.service';
import * as compiler from '../services/mutationCompile.service';
import * as retention from '../services/mutationRetention.service';
import * as policy from '../services/mutationPolicy.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';
import type { MutationManifest } from '../engine/mutation/resolve.mutation';
import type { PolicyTerms } from '../engine/mutation/policy.mutation';
import type { MutationStatus } from '../repos/mutation.repo';
import type { PolicyAuthority } from '../repos/mutationPolicy.repo';
import type { ConflictChoice } from '../engine/mutation/revert.mutation';

/**
 * Mutations: propose a change, read its preview, ask for and give approval, and
 * set who must give it.
 */

export async function propose(req: Request, res: Response): Promise<void> {
  const input = body<{ intent: string; manifest: MutationManifest }>(req);
  res.status(201).json(await mutation.propose(actorOf(req), input));
}

export async function list(req: Request, res: Response): Promise<void> {
  const input = query<{ limit: number; status?: MutationStatus }>(req);
  res.status(200).json({ mutations: await mutation.list(actorOf(req), input) });
}

export async function read(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await mutation.read(actorOf(req), id));
}

export async function changes(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const page = query<{ offset: number; limit: number }>(req);
  res.status(200).json({ changes: await mutation.changes(actorOf(req), id, page) });
}

export async function submit(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await approval.submit(actorOf(req), id));
}

export async function approve(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { comment } = body<{ comment?: string }>(req);
  res.status(200).json(await approval.decide(actorOf(req), id, { decision: 'approve', comment: comment ?? null }));
}

export async function reject(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { comment } = body<{ comment: string }>(req);
  res.status(200).json(await approval.decide(actorOf(req), id, { decision: 'reject', comment }));
}

export async function policies(req: Request, res: Response): Promise<void> {
  res.status(200).json(await policy.overview(actorOf(req)));
}

export async function setDefaultPolicy(req: Request, res: Response): Promise<void> {
  const { terms } = body<{ terms: PolicyTerms }>(req);
  res.status(200).json(await policy.setPolicy(actorOf(req), { connectionId: null, scopeId: null, terms }));
}

export async function removeDefaultPolicy(req: Request, res: Response): Promise<void> {
  await policy.removePolicy(actorOf(req), { connectionId: null, scopeId: null });
  res.status(204).end();
}

export async function setConnectionPolicy(req: Request, res: Response): Promise<void> {
  const { connectionId } = params<{ connectionId: string }>(req);
  const { scopeId, terms } = body<{ scopeId: string | null; terms: PolicyTerms }>(req);
  res.status(200).json(await policy.setPolicy(actorOf(req), { connectionId, scopeId, terms }));
}

export async function removeConnectionPolicy(req: Request, res: Response): Promise<void> {
  const { connectionId } = params<{ connectionId: string }>(req);
  const { scopeId } = query<{ scopeId?: string }>(req);
  await policy.removePolicy(actorOf(req), { connectionId, scopeId: scopeId ?? null });
  res.status(204).end();
}

export async function setFloor(req: Request, res: Response): Promise<void> {
  const { connectionId } = params<{ connectionId: string }>(req);
  const { terms } = body<{ terms: PolicyTerms }>(req);
  res.status(200).json(await policy.setFloor(actorOf(req), { connectionId, terms }));
}

export async function removeFloor(req: Request, res: Response): Promise<void> {
  const { connectionId } = params<{ connectionId: string }>(req);
  await policy.removeFloor(actorOf(req), connectionId);
  res.status(204).end();
}

export async function setAuthority(req: Request, res: Response): Promise<void> {
  const { connectionId } = params<{ connectionId: string }>(req);
  const input = body<{ authority: PolicyAuthority; grantedTo: string | null }>(req);
  res.status(200).json(await policy.setAuthority(actorOf(req), { connectionId, ...input }));
}

export async function execute(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(202).json(await execution.execute(actorOf(req), id));
}

export async function confirmCanary(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(202).json(await execution.confirmCanary(actorOf(req), id));
}

export async function haltCanary(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await execution.haltCanary(actorOf(req), id));
}

export async function receipt(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await execution.receipt(actorOf(req), id));
}

export async function inspectRevert(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await revert.inspect(actorOf(req), id));
}

export async function requestRevert(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<{ intent: string; choices: ConflictChoice[] }>(req);
  res.status(201).json(await revert.request(actorOf(req), id, input));
}

export async function compile(req: Request, res: Response): Promise<void> {
  const input = body<{ intent: string; history?: Array<{ role: 'user' | 'model'; text: string }> }>(req);
  const outcome = await compiler.compileChange(actorOf(req), input);
  res.status(outcome.outcome === 'previewed' ? 201 : 200).json(outcome);
}

export async function retentionOf(req: Request, res: Response): Promise<void> {
  res.status(200).json(await retention.retention(actorOf(req)));
}

export async function setRetention(req: Request, res: Response): Promise<void> {
  const { receiptDays } = body<{ receiptDays: number }>(req);
  res.status(200).json(await retention.setRetention(actorOf(req), receiptDays));
}

export async function purge(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const outcome = await retention.purge(actorOf(req), id);
  res.status(outcome.status === 'pending' ? 202 : 200).json(outcome);
}
