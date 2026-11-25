import type { Request, Response } from 'express';
import * as file from '../services/file.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params } from '../middleware/validate.middleware';

/** Files §1 — documents Silo produced, and later ones a customer uploaded. */

export async function exportView(req: Request, res: Response): Promise<void> {
  const input = body<{ viewId: string; format: 'json' | 'csv'; name?: string }>(req);
  res.status(201).json(await file.exportView(actorOf(req), input));
}

/**
 * What this person made.
 *
 * `?kind=export` IS HOW EXPORTS ASK FOR THEMSELVES. §1's two things live in two
 * rooms now: exports in Exports, uploads inside the Silo that holds them. An
 * unfiltered call still answers both, because a listing that quietly dropped
 * half its rows would be a worse default than one that says what it wants.
 */
export async function mine(req: Request, res: Response): Promise<void> {
  res.status(200).json({ files: await file.mine(actorOf(req), kindOf(req)) });
}

/** The one filter these two listings take, read the same way in both. */
const kindOf = (req: Request): 'export' | 'upload' | undefined =>
  req.query.kind === 'export' || req.query.kind === 'upload' ? req.query.kind : undefined;

export async function read(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await file.read(actorOf(req), id));
}

/*
 * A SIGNED URL RATHER THAN THE BYTES. The object store serves them directly, so
 * a large export does not travel through this process twice, and the link
 * expires — a download URL that outlived the decision to share it would be a
 * copy of the file that no revocation reaches.
 */
export async function download(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await file.download(actorOf(req), id));
}

/* §2 — folders, which arrange and do not authorise. */

export async function createFolder(req: Request, res: Response): Promise<void> {
  const input = body<{ name: string; parentId: string | null }>(req);
  res.status(201).json(await file.createFolder(actorOf(req), input));
}

/*
 * NO COUNT IN THE RESPONSE, by §2: "the folder does not state how many files it
 * holds, since a count is a disclosure". What comes back is what this caller
 * may see, and nothing about what they may not.
 */
export async function browse(req: Request, res: Response): Promise<void> {
  const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : null;
  res.status(200).json(await file.browse(actorOf(req), folderId, kindOf(req)));
}

/** §5 — the documents uploaded into one Silo, each shown to whoever may see it. */
export async function documentsOfSilo(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ files: await file.documentsOfSilo(actorOf(req), id) });
}

export async function move(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { folderId } = body<{ folderId: string | null }>(req);
  res.status(200).json(await file.move(actorOf(req), id, folderId));
}

/* §4 — sharing, and the warning that stops it failing silently. */

export async function share(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<Parameters<typeof file.shareFile>[2]>(req);
  res.status(201).json(await file.shareFile(actorOf(req), id, input));
}

export async function revokeShare(req: Request, res: Response): Promise<void> {
  const { id, shareId } = params<{ id: string; shareId: string }>(req);
  res.status(200).json(await file.revokeShare(actorOf(req), id, shareId));
}

/* §5 — uploads, which are storage and therefore require a Silo. */

export async function requestUpload(req: Request, res: Response): Promise<void> {
  const input = body<Parameters<typeof file.requestUpload>[1]>(req);
  res.status(201).json(await file.requestUpload(actorOf(req), input));
}

export async function confirmUpload(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await file.confirmUpload(actorOf(req), id));
}

/* §5 — ingestion, and §6 — deletion with a receipt. */

export async function ingest(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { sourceId } = body<{ sourceId: string }>(req);
  res.status(200).json(await file.ingest(actorOf(req), id, { sourceId }));
}

export async function remove(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await file.remove(actorOf(req), id));
}

/* §6 — the receipts, which outlive the files they describe. */
export async function deletions(req: Request, res: Response): Promise<void> {
  res.status(200).json({ deletions: await file.deletions(actorOf(req)) });
}
