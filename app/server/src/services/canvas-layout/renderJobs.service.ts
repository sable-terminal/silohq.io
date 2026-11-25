// PNG export (spec 29.10; D88, D225). The exporter's own browser draws the image: the canvas
// it already shows, printed with when it was drawn, each source's state age, the markings,
// the flags and how many objects are not placed. The server decides what must be printed:
// beginning the export runs the set as a PDF export does and records the markings the image
// must carry; the image comes back to the job, and is filed as the exporter's export, under
// the Files rules, only if the canvas's inputs then carry no marking it does not print. A job
// not completed within the hour expires. No headless browser opens a canvas as anyone.

import type { RenderJob } from '../../models/clone/renderJob.model.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { renderJobRepo } from '../../repos/clone/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { rasterSize } from '../../utils/spatialAsset.util.ts';
import { exportCanvas, type ExportStamp } from './canvasExport.service.ts';
import { member, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';
import type { SpatialDeps } from './spatial.service.ts';

export const RENDER_JOB_MINUTES = 60;

export const renderJobView = (j: RenderJob) => ({
  id: j.id, canvasViewId: j.canvasViewId, format: 'png' as const, width: j.width, height: j.height, scale: Number(j.scale),
  status: (j.status === 'queued' && Date.parse(j.expiresAt) <= Date.now() ? 'expired' : j.status) as RenderJob['status'],
  fileId: j.fileId, failureCode: j.failureCode, requestedAt: j.requestedAt, completedAt: j.completedAt, expiresAt: j.expiresAt,
});

const stampView = (s: ExportStamp) => ({ markings: s.markings.map((m) => m.name), computedAt: s.computedAt, sources: s.sources, flags: s.flags });

/** Begins an image export: what the image must print, and the job its image comes back to. */
export async function beginImageExport(deps: SpatialDeps, ctx: Context, canvasViewId: string,
  input: { folderId?: string | undefined; width?: number | undefined; height?: number | undefined; scale?: number | undefined; drawn?: Drawn | undefined }) {
  const me = member(ctx);
  if (ctx.request.sessionId === undefined) {
    throw new AppError('forbidden', 'an image is exported by a person signed in', { code: 'canvas.render_needs_session' });
  }
  const stamp = await exportCanvas(deps, ctx, canvasViewId, { format: 'png', stampOnly: true, drawn: input.drawn });
  if (stamp.outcome === 'refused') return stamp;
  if (stamp.outcome !== 'stamp') throw new AppError('integrity', 'the export answered a stamp with a file', { code: 'canvas.stamp_unexpected' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const job = await renderJobRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, canvasViewId, requestedBy: me.membershipId, sessionId: ctx.request.sessionId!, format: 'png',
      width: input.width ?? 1600, height: input.height ?? 1000, scale: String(input.scale ?? 1), folderId: input.folderId ?? null,
      printedMarkingIds: stamp.markings.map((m) => m.id), drawnPlanId: input.drawn?.planId ?? null, drawnAssetModelId: input.drawn?.assetModelId ?? null, expiresAt: new Date(Date.now() + RENDER_JOB_MINUTES * 60_000).toISOString(),
    });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'canvas_exported', resource: { type: 'canvas_view', id: canvasViewId }, detail: { format: 'png', render_job_id: job.id, queued: true },
    });
    return { outcome: 'awaiting_image' as const, job: renderJobView(job), stamp: stampView(stamp) };
  });
}

/** A job begun earlier, as its exporter sees it now, with what its image must print (a keyed retry's answer). */
export async function awaitingImage(deps: SpatialDeps, ctx: Context, jobId: string) {
  const job = await ownJob(deps, ctx, jobId);
  const stamp = await exportCanvas(deps, ctx, job.canvasViewId, { format: 'png', stampOnly: true, drawn: drawnOf(job) });
  if (stamp.outcome === 'refused') return stamp;
  return { outcome: 'awaiting_image' as const, job: renderJobView(job), stamp: stampView(stamp as ExportStamp) };
}

type Drawn = { planId?: string | undefined; assetModelId?: string | undefined };
const drawnOf = (job: RenderJob): Drawn | undefined =>
  (job.drawnPlanId !== null ? { planId: job.drawnPlanId } : job.drawnAssetModelId !== null ? { assetModelId: job.drawnAssetModelId } : undefined);

async function ownJob(deps: CanvasDeps, ctx: Context, jobId: string): Promise<RenderJob> {
  const me = member(ctx);
  const job = await inTransaction(deps.databases.pool('control'), me.request, (db) => renderJobRepo.findById(db, jobId), { readOnly: true });
  if (!job || job.requestedBy !== me.membershipId) throw new AppError('not_found', 'no such image export', { code: 'canvas.render_job_not_found' });
  return job;
}

export async function getRenderJob(deps: CanvasDeps, ctx: Context, jobId: string) {
  return renderJobView(await ownJob(deps, ctx, jobId));
}

/**
 * The exporter's image: a PNG within the job's size, filed as their export (a PDF's path, the
 * image in place of the drawing) if the canvas's inputs carry no marking it does not print.
 */
export async function completeImageExport(deps: SpatialDeps, ctx: Context, jobId: string, content: string) {
  const job = await ownJob(deps, ctx, jobId);
  const view = renderJobView(job);
  if (view.status !== 'queued') throw new AppError('conflict', `the export is ${view.status}`, { code: 'canvas.render_job_closed' });
  const png = Buffer.from(content, 'base64');
  const size = rasterSize(png);
  // The canvas at its size and scale, with room for the stamp printed above and the legend below it.
  if (size?.format !== 'png' || size.width > Math.ceil(job.width * Number(job.scale)) + 64 || size.height > 8_192) {
    throw new AppError('validation', 'the image is not a PNG of the size the export was begun for', { code: 'canvas.image_invalid' });
  }
  const out = await exportCanvas(deps, ctx, job.canvasViewId, {
    format: 'png', folderId: job.folderId ?? undefined, rendered: { png, jobId: job.id, printedMarkingIds: job.printedMarkingIds }, drawn: drawnOf(job),
  });
  const organisationId = ctx.request.organisationId!;
  await inTransaction(deps.databases.pool('control'), { organisationId }, (db) =>
    renderJobRepo.finish(db, jobId, out.outcome === 'exported' ? { fileId: out.file.id } : { failureCode: out.outcome === 'refused' ? out.code : 'canvas.render_filing_failed' }));
  const finished = renderJobView((await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => renderJobRepo.findById(db, jobId), { readOnly: true }))!);
  if (out.outcome === 'exported') return { outcome: 'exported' as const, file: out.file, job: finished };
  return { outcome: 'refused' as const, code: out.outcome === 'refused' ? out.code : 'canvas.render_filing_failed', reason: out.outcome === 'refused' ? out.reason : 'it could not be filed', job: finished };
}
