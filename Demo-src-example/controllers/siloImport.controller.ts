import type { Request, Response } from 'express';
import * as siloImport from '../services/siloImport.service';
import * as siloWatch from '../services/siloWatch.service';
import { actorOf } from '../middleware/authorise.middleware';
import { body, params, query } from '../middleware/validate.middleware';

/**
 * Siloes — Import. Sources, the files that arrive, and the definitions that
 * structure them.
 */

export async function createSource(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const { name } = body<{ name: string }>(req);
  res.status(201).json(await siloImport.createSource(actorOf(req), { siloId: id, name }));
}

export async function sources(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ sources: await siloImport.sources(actorOf(req), id) });
}

/** 201 with the file row and where to put its bytes. The bytes never come here. */
export async function requestUpload(req: Request, res: Response): Promise<void> {
  const { sourceId } = params<{ sourceId: string }>(req);
  const input = body<{ filename: string; contentType: string; bytes: number }>(req);
  res.status(201).json(await siloImport.requestUpload(actorOf(req), { sourceId, ...input }));
}

export async function markReceived(req: Request, res: Response): Promise<void> {
  const { fileId } = params<{ fileId: string }>(req);
  res.status(200).json(await siloImport.markReceived(actorOf(req), fileId));
}

export async function files(req: Request, res: Response): Promise<void> {
  const { sourceId } = params<{ sourceId: string }>(req);
  res.status(200).json({ files: await siloImport.files(actorOf(req), sourceId) });
}

export async function draftFromFile(req: Request, res: Response): Promise<void> {
  const { sourceId } = params<{ sourceId: string }>(req);
  const input = body<{ fileId: string; name?: string }>(req);
  res.status(201).json(await siloImport.draftFromFile(actorOf(req), { sourceId, ...input }));
}

export async function adoptPrebuilt(req: Request, res: Response): Promise<void> {
  const { sourceId } = params<{ sourceId: string }>(req);
  const { definitionId } = body<{ definitionId: string }>(req);
  res.status(201).json(await siloImport.adoptPrebuilt(actorOf(req), { sourceId, definitionId }));
}

export async function prebuilt(req: Request, res: Response): Promise<void> {
  res.status(200).json({ definitions: await siloImport.prebuilt(actorOf(req)) });
}

export async function definitions(req: Request, res: Response): Promise<void> {
  const { sourceId } = params<{ sourceId: string }>(req);
  res.status(200).json({ definitions: await siloImport.definitions(actorOf(req), sourceId) });
}

export async function saveDraft(req: Request, res: Response): Promise<void> {
  const { definitionId } = params<{ definitionId: string }>(req);
  const input = body<{ name?: string; document: Record<string, unknown> }>(req);
  res.status(200).json(await siloImport.saveDraft(actorOf(req), { definitionId, ...input }));
}

export async function probe(req: Request, res: Response): Promise<void> {
  const { definitionId } = params<{ definitionId: string }>(req);
  const { fileId } = body<{ fileId: string }>(req);
  res.status(200).json(await siloImport.probe(actorOf(req), { definitionId, fileId }));
}

export async function publish(req: Request, res: Response): Promise<void> {
  const { definitionId } = params<{ definitionId: string }>(req);
  res.status(200).json(await siloImport.publish(actorOf(req), definitionId));
}

/** §5 — confirm a flagged value: certain, permanently, for that value. */
export async function confirmFlag(req: Request, res: Response): Promise<void> {
  const { fileId } = params<{ fileId: string }>(req);
  const flag = body<{ object: string; row: string; field: string }>(req);
  res.status(200).json(
    await siloImport.confirmExtraction(actorOf(req), { fileId, object: flag.object, rowRef: flag.row, field: flag.field }),
  );
}

/* ── Reading documents with a model ──────────────────────────────────────── */

export async function documentModel(req: Request, res: Response): Promise<void> {
  res.status(200).json(await siloImport.documentModel(actorOf(req)));
}

export async function setDocumentModel(req: Request, res: Response): Promise<void> {
  await siloImport.setDocumentModel(actorOf(req), body<{ enabled: boolean; acknowledgedDisclosure?: string }>(req));
  res.status(204).end();
}

export async function draftFromDocuments(req: Request, res: Response): Promise<void> {
  const { sourceId } = params<{ sourceId: string }>(req);
  const input = body<{ fileIds: string[]; name?: string }>(req);
  res.status(201).json(await siloImport.draftFromDocuments(actorOf(req), { sourceId, ...input }));
}

/** §5 — the flagged values in one file, as a queue: unconfirmed first. */
export async function flagged(req: Request, res: Response): Promise<void> {
  const { fileId } = params<{ fileId: string }>(req);
  res.status(200).json(await siloImport.flagged(actorOf(req), fileId));
}

/** §5 — what a flag shows: how the value was read, where, and the text it was read from. */
export async function explainFlag(req: Request, res: Response): Promise<void> {
  const { fileId } = params<{ fileId: string }>(req);
  const flag = query<{ object: string; row: string; field: string }>(req);
  res.status(200).json(
    await siloImport.explain(actorOf(req), { fileId, object: flag.object, rowRef: flag.row, field: flag.field }),
  );
}

/* ── Watched locations ───────────────────────────────────────────────────── */

export async function fingerprint(req: Request, res: Response): Promise<void> {
  const input = body<{ host: string; port: number }>(req);
  res.status(200).json(await siloWatch.fingerprint(actorOf(req), input));
}

/** 201 with the source. The credential is never returned, in this response or any other. */
export async function configureWatched(req: Request, res: Response): Promise<void> {
  const { id } = params<{ id: string }>(req);
  const input = body<Omit<Parameters<typeof siloWatch.configure>[1], 'siloId'>>(req);
  res.status(201).json(await siloWatch.configure(actorOf(req), { siloId: id, ...input }));
}

export async function pollNow(req: Request, res: Response): Promise<void> {
  const { sourceId } = params<{ sourceId: string }>(req);
  res.status(200).json(await siloWatch.pollNow(actorOf(req), sourceId));
}

export async function stopWatching(req: Request, res: Response): Promise<void> {
  const { sourceId } = params<{ sourceId: string }>(req);
  await siloWatch.stop(actorOf(req), sourceId);
  res.status(204).end();
}

/** The local object store's upload endpoint. No session: the token is the credential. */
export async function localUpload(req: Request, res: Response): Promise<void> {
  const { token } = params<{ token: string }>(req);
  await siloImport.acceptLocalUpload({
    token,
    contentType: req.header('content-type'),
    body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
  });
  res.status(200).json({ stored: true });
}
