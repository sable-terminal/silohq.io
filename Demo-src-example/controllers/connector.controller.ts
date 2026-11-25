import type { Request, Response } from 'express';
import * as builder from '../services/connectorBuilder.service';
import { probe as runProbe } from '../services/connectorProbe.service';
import * as build from '../services/connectorBuild.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';

/**
 * The builder's endpoints.
 *
 * A DRAFT IS NEVER REFUSED FOR BEING INCOMPLETE. Every response that carries a
 * draft carries its validation beside it, so the screen shows what is left to do
 * without a separate round trip and without the save having failed.
 */

function present(draft: Awaited<ReturnType<typeof builder.createDraft>>) {
  return {
    id: draft.id,
    name: draft.name,
    document: draft.document,
    sourceRoute: draft.sourceRoute,
    failedStage: draft.failedStage,
    publishedManifestId: draft.publishedManifestId,
    publishedAt: draft.publishedAt?.toISOString() ?? null,
    updatedAt: draft.updatedAt.toISOString(),
  };
}

/**
 * What the dropdowns are made of, read from the enumeration tables.
 *
 * SERVED RATHER THAN SHIPPED so the client holds no second copy to drift from.
 */
export async function vocabulary(req: Request, res: Response): Promise<void> {
  const { route } = query<{ route: 'ai' | 'visual' }>(req);
  res.status(200).json(await builder.vocabularyFor(actorOf(req), route));
}

export async function expandPreset(req: Request, res: Response): Promise<void> {
  actorOf(req);
  const input = body<Parameters<typeof builder.expand>[0]>(req);
  res.status(200).json({ fragment: builder.expand(input) });
}

export async function validate(req: Request, res: Response): Promise<void> {
  actorOf(req);
  const { document } = body<{ document: Record<string, unknown> }>(req);
  res.status(200).json(builder.validate(document));
}

export async function list(req: Request, res: Response): Promise<void> {
  const drafts = await builder.listDrafts(actorOf(req));
  res.status(200).json({ drafts: drafts.map(present) });
}

export async function open(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { draft, validation } = await builder.openDraft(actorOf(req), id);
  res.status(200).json({ draft: present(draft), validation });
}

export async function create(req: Request, res: Response): Promise<void> {
  const input = body<{
    name: string;
    document?: Record<string, unknown>;
    sourceRoute?: 'ai' | 'visual';
    failedStage?: string | null;
  }>(req);

  const draft = await builder.createDraft(actorOf(req), input);
  res.status(201).json({ draft: present(draft), validation: builder.validate(draft.document) });
}

export async function save(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const patch = body<{ name?: string; document?: Record<string, unknown> }>(req);

  const { draft, validation } = await builder.saveDraft(actorOf(req), id, patch);
  res.status(200).json({ draft: present(draft), validation });
}

export async function upgrade(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { draft, validation } = await builder.upgradeDraft(actorOf(req), id);
  res.status(200).json({ draft: present(draft), validation });
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  await builder.deleteDraft(actorOf(req), id);
  res.status(204).end();
}

export async function publish(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(201).json(await builder.publishDraft(actorOf(req), id));
}

/**
 * The live test panel.
 *
 * A FAILED PROBE IS A 200. It ran, and what came back is the answer — the person
 * needs to see which field caused it, and an error status would put that behind
 * whatever the client does with failures.
 */
export async function probe(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<{ connectionId: string; object: string; limit: number; checkPaging: boolean }>(req);

  res.status(200).json(await runProbe(actorOf(req), { draftId: id, ...input }));
}

/* ── A build: the AI finishes and tests the connector, then the person looks ── */

export async function startBuild(req: Request, res: Response): Promise<void> {
  res.status(201).json(await build.start(actorOf(req), body<Parameters<typeof build.start>[1]>(req)));
}

export async function getBuild(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await build.get(actorOf(req), id));
}

export async function buildCredential(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await build.giveCredential(actorOf(req), id, body<Parameters<typeof build.giveCredential>[2]>(req)));
}

/** Signed in on the build's connection — a consent page, or the agent and a key — so testing can start. */
export async function buildSignedIn(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await build.signedIn(actorOf(req), id));
}

/** Carry on after the build stopped: a busy model service, or rounds that ran out. */
export async function retryBuild(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await build.retry(actorOf(req), id));
}

/** One round of reading and repairing. The client asks again while the answer says `testing`. */
export async function advanceBuild(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await build.advance(actorOf(req), id));
}

export async function buildFeedback(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { text } = body<{ text: string }>(req);
  res.status(200).json(await build.advance(actorOf(req), id, text));
}

/** Real records, read now for the person to recognise, and kept nowhere. */
export async function previewBuild(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await build.preview(actorOf(req), id));
}

export async function connectBuild(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(201).json(await build.connect(actorOf(req), id, body<{ name?: string; without?: string[] }>(req)));
}
