// Exports (spec 41.2): a frozen result, made by a person (or a Cron for its owner) under
// their permissions at a moment in time.
//
// render renders the document; this stores it. In one transaction: the file, its lineage
// (the artefact and its inputs, spec 59.3: an artefact cannot exist without its lineage),
// the markings it inherits from its inputs (spec 58.6), the frozen permissions of the person
// who made it (their markings, the field-policy effects it was rendered under, and their
// access to each connection it read, now), and its provenance, kept after the source goes.
// The bytes go to object-files first, under a key that is the file's id; if the
// transaction fails they are removed again.
//
// The markings printed on the document must be the ones the file carries: render asks for
// them first (preview), and a file whose markings changed in between is refused, to be
// rendered again.
//
// A lineage graph a reviewer exports (spec 59.4, 59.7) is stored the same way. It comes
// only from the lineage service, is decided on lineage.read held organisation-wide (the
// reviewer's permission, not file.export), runs no query, and is sourced to the node the
// walk began at.

import type { z } from 'zod';
import type { createExport, exportInputs } from '../../contracts/files/file.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { objectKey } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { fileMarkingRepo, filePermissionRepo, fileProvenanceRepo, fileRepo, folderRepo } from '../../repos/files/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { reportLineageWriteFailure, writeLineage } from '../lineage/writer.service.ts';
import { actorOf, demand, recordEvent, type Context, type FilesDeps } from './deps.service.ts';
import { fileViewOf } from './files.service.ts';

type Inputs = z.output<typeof exportInputs>;
type CreateInput = z.output<typeof createExport.body>;

const PREVIEW = 'files.preview_rolled_back';

/** The markings an export of these inputs carries, with names, computed and rolled back: nothing is written. */
export async function previewMarkings(deps: FilesDeps, ctx: Context, inputs: Inputs, carried: readonly string[] = []): Promise<{ markings: { id: string; name: string }[] }> {
  const actor = await actorOf(deps, ctx);
  try {
    await inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
      const written = await writeLineage(db, lineageActor(actor), { artefact: { kind: 'export', refId: uuidv7(), version: '1' }, inputs });
      const names = await fileMarkingRepo.names(db, await withCarried(db, written.markingIds, carried));
      throw new AppError('conflict', 'preview', { code: PREVIEW, details: { markings: JSON.stringify(names) } });
    });
  } catch (error) {
    if (isAppError(error) && error.code === PREVIEW) return { markings: JSON.parse(String(error.details['markings'])) as { id: string; name: string }[] };
    throw error;
  }
  throw new AppError('internal', 'the preview did not roll back', { code: 'files.preview_failed' });
}

/** The inherited markings with those carried by what is drawn: every carried one must exist here. */
async function withCarried(db: Queryable, inherited: readonly string[], carried: readonly string[]): Promise<string[]> {
  const extra = [...new Set(carried)].filter((id) => !inherited.includes(id));
  if (extra.length > 0 && (await fileMarkingRepo.names(db, extra)).length !== extra.length) {
    throw new AppError('validation', 'a carried marking does not exist', { code: 'files.marking_unknown' });
  }
  return [...inherited, ...extra];
}

const lineageActor = (actor: { organisationId: string; membershipId: string; servicePrincipalId: string | undefined }) => ({
  organisationId: actor.organisationId,
  createdBy: actor.servicePrincipalId !== undefined ? { servicePrincipalId: actor.servicePrincipalId } : { membershipId: actor.membershipId },
});

export async function createExportFile(deps: FilesDeps, ctx: Context & Pick<HandlerContext, 'caller'>, input: CreateInput) {
  const actor = await actorOf(deps, ctx);
  if (input.source.kind === 'app_package' && ctx.caller !== 'studio') {
    throw new AppError('forbidden', 'an app package is exported through Studio', { code: 'files.app_package_source_refused' });
  }
  if ((input.source.kind === 'workbook' || input.source.kind === 'report' || input.source.kind === 'process_analysis' || input.source.kind === 'notebook') && ctx.caller !== 'workspace') {
    throw new AppError('forbidden', 'a workbook is exported through its workbook', { code: 'files.workbook_source_refused' });
  }
  if (input.source.kind === 'lineage') {
    if (ctx.caller !== 'lineage') {
      throw new AppError('forbidden', 'a lineage graph is exported through the lineage service', { code: 'files.lineage_source_refused' });
    }
    await demand(deps, ctx, 'lineage.read', true);
  } else {
    await demand(deps, ctx, 'file.export');
  }
  const bytes = Buffer.from(input.content, 'base64');
  if (bytes.length > deps.config.maxExportBytes) {
    throw new AppError('bounds', `refused: the export is larger than ${deps.config.maxExportBytes} bytes`, {
      code: 'bound.export_bytes', details: { limit: deps.config.maxExportBytes },
    });
  }
  // The maker's access to each connection the export read, now: frozen with it (spec 41.2).
  const access = input.connectionIds.length === 0 ? [] : (await deps.services.call(resolveAccess, {
    body: { connections: input.connectionIds },
  }, { request: ctx.request, correlationId: ctx.correlationId })).connections;

  const fileId = uuidv7();
  const key = objectKey.organisation(actor.organisationId, 'exports', fileId);
  await deps.store.put('files', key, bytes, input.contentType);
  const now = deps.now();
  const retention = deps.config.exportRetentionDays;
  const control = deps.databases.pool('control');
  try {
    return await inTransaction(control, actor.request, async (db) => {
      if (input.folderId !== undefined && !await folderRepo.findById(db, input.folderId)) {
        throw new AppError('not_found', 'no such folder', { code: 'files.folder_not_found' });
      }
      const row = await fileRepo.insert(db, {
        id: fileId, organisationId: actor.organisationId, folderId: input.folderId ?? null, kind: 'export', name: input.name,
        objectStoreKey: key, contentType: input.contentType, size: String(bytes.length), siloFileId: null, ingestionState: null,
        status: 'available', retention: retention === undefined ? null : `${retention} days`,
        expiresAt: retention === undefined ? null : new Date(now + retention * 86_400_000).toISOString(), createdBy: actor.membershipId,
      });
      const written = await writeLineage(db, lineageActor(actor), {
        artefact: { kind: 'export', refId: fileId, version: '1' }, inputs: input.inputs,
      });
      const markingIds = await withCarried(db, written.markingIds, input.carriedMarkingIds ?? []);
      const printed = [...new Set(input.printedMarkingIds)].sort();
      if (printed.join(',') !== [...markingIds].sort().join(',')) {
        throw new AppError('conflict', 'the markings changed while the export was rendered; render it again', { code: 'files.markings_changed' });
      }
      for (const markingId of markingIds) await fileMarkingRepo.insert(db, { organisationId: actor.organisationId, fileId, markingId });
      await filePermissionRepo.insert(db, {
        organisationId: actor.organisationId, fileId, frozenAt: new Date(now).toISOString(),
        markings: markingIds,
        fieldPolicies: input.fieldPolicies.filter((f) => f.effect !== 'allow'),
        connectionGrants: access.map((c) => ({ connectionId: c.id, access: c.access })),
      });
      await fileProvenanceRepo.insert(db, {
        organisationId: actor.organisationId, fileId,
        sourceSavedViewId: input.source.kind === 'view' ? input.source.savedViewId : null,
        sourceAutomationRunId: input.source.kind === 'cron_report' ? input.source.automationRunId : null,
        sourceCanvasViewId: input.source.kind === 'canvas_view' ? input.source.canvasViewId : null,
        sourceLineageNodeId: input.source.kind === 'lineage' ? input.source.lineageNodeId : null,
        sourceAppVersionId: input.source.kind === 'app_package' ? input.source.appVersionId : null,
        sourceWorkbookId: input.source.kind === 'workbook' ? input.source.workbookId : null,
        sourceReportId: input.source.kind === 'report' ? input.source.reportId : null,
        sourceProcessAnalysisId: input.source.kind === 'process_analysis' ? input.source.processAnalysisId : null,
        sourceNotebookId: input.source.kind === 'notebook' ? input.source.notebookId : null,
        sourceFindingId: null, sourceDetectorRunId: null, sourceReceiptId: null, sourceSimulationRunId: null,
        runReference: input.runReference ?? null, producedAt: new Date(now).toISOString(),
      });
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'file_exported', resource: { type: 'file', id: fileId }, subjectMembershipId: actor.membershipId,
        detail: { source: input.source.kind, bytes: bytes.length, markings: markingIds.length },
      });
      // From a saved view, the view's own record of being exported (37.12), naming the frozen file.
      if (input.source.kind === 'view') {
        await recordEvent(db, actor, ctx.correlationId, {
          event: 'view_exported', resource: { type: 'view', id: input.source.savedViewId }, detail: { file_id: fileId, markings: markingIds.length },
        });
      }
      return fileViewOf(db, row, 'owner', true);
    });
  } catch (error) {
    await deps.store.delete('files', key).catch((cause: unknown) => {
      deps.logger.failure('an export\'s bytes could not be removed after its file was refused', cause, {
        event: 'files.orphan_object', organisationId: actor.organisationId, resourceId: fileId,
      });
    });
    if (isAppError(error) && error.code === 'lineage.write_failed') {
      await reportLineageWriteFailure(control, lineageActor(actor), { kind: 'export', refId: fileId, version: '1' }, ctx.correlationId, 'files')
        .catch(() => undefined);
    }
    throw error;
  }
}

/** A keyed retry returns the file the first request made. */
export async function exportedFile(deps: FilesDeps, ctx: Context, fileId: string) {
  const actor = await actorOf(deps, ctx);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const row = await fileRepo.findById(db, fileId);
    if (!row || row.createdBy !== actor.membershipId) throw new AppError('not_found', 'no such file', { code: 'files.file_not_found' });
    return fileViewOf(db, row, 'owner', true);
  }, { readOnly: true });
}
