// The Import endpoints: thin, over services/siloes-import.

import type * as c from '../../contracts/siloes/import.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { siloFileRepo } from '../../repos/siloes/index.repo.ts';
import { loadSiloView } from '../../services/siloes-capture/deps.service.ts';
import * as imports from '../../services/siloes-import/import.service.ts';
import * as processing from '../../services/siloes-import/process.service.ts';
import {
  beginFilesUpload, checkFilesSilo, completeFilesUpload, getFilesUpload, openMediaUpload, readFilesUpload, signFilesUploadRead, storedUploadOf, storeFilesUpload,
} from '../../services/siloes-import/filesUploads.service.ts';
import { AppError } from '../../utils/errors.util.ts';

type Name = 'createImportSilo' | 'acknowledgeCarveout' | 'publishDefinition' | 'draftDefinition' | 'listDefinitions' | 'listPrebuiltDefinitions' | 'createSource' | 'listSources' | 'uploadFile' | 'beginUpload'
  | 'completeUpload' | 'listFiles' | 'storeFilesUpload' | 'readFilesUpload' | 'getFilesUpload'
  | 'beginFilesUpload' | 'completeFilesUpload' | 'signFilesUploadRead' | 'checkFilesSilo' | 'openMediaUpload'
  | 'getExtraction' | 'listExtractions' | 'confirmExtraction' | 'readRecordExtractions' | 'rebuildImportSilo';

export function importController(deps: imports.ImportDeps): { [K in Name]: RouteHandlers<(typeof c)[K]> } {
  return {
    createImportSilo: {
      handle: (input, ctx) => imports.createImportSilo(deps, ctx, input.body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => loadSiloView(deps, ctx, ref!),
    },
    acknowledgeCarveout: { handle: (input, ctx) => imports.acknowledgeCarveout(deps, ctx, input.params.siloId) },
    publishDefinition: { handle: (input, ctx) => imports.publishDefinition(deps, ctx, input.params.siloId, input.body) },
    draftDefinition: { handle: (input, ctx) => imports.draftDefinition(deps, ctx, input.params.siloId, input.body.fileId) },
    listDefinitions: { handle: (input, ctx) => imports.listDefinitions(deps, ctx, input.params.siloId) },
    listPrebuiltDefinitions: { handle: async () => imports.listPrebuilt() },
    createSource: { handle: (input, ctx) => imports.createSource(deps, ctx, input.params.siloId, input.body) },
    listSources: { handle: (input, ctx) => imports.listSources(deps, ctx, input.params.siloId) },
    uploadFile: {
      handle: (input, ctx) => imports.uploadFile(deps, ctx, input.params.siloId, input.params.sourceId, input.body),
      resultRef: (out) => out.id,
      // A retried upload answers with the file it stored: nothing is stored or charged twice.
      replay: async (ref, ctx) => {
        const file = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => siloFileRepo.findById(db, ref!), { readOnly: true });
        if (file === undefined) throw new AppError('not_found', 'no such file', { code: 'import.file_not_found' });
        return imports.fileView(file);
      },
    },
    beginUpload: { handle: (input, ctx) => imports.beginUpload(deps, ctx, input.params.siloId, input.params.sourceId, input.body.sizeBytes) },
    storeFilesUpload: {
      handle: (input, ctx) => storeFilesUpload(deps, ctx, input.body),
      resultRef: (out) => out.siloFileId,
      replay: (ref, ctx) => storedUploadOf(deps, ctx, ref!),
    },
    readFilesUpload: { handle: (input, ctx) => readFilesUpload(deps, ctx, input.params.siloFileId) },
    // Files uploads larger than one reply (41.4): a signed transfer each way.
    beginFilesUpload: { handle: (input, ctx) => beginFilesUpload(deps, ctx, input.body) },
    completeFilesUpload: {
      handle: (input, ctx) => completeFilesUpload(deps, ctx, input.params.uploadId, input.body),
      resultRef: (out) => out.siloFileId,
      replay: (ref, ctx) => storedUploadOf(deps, ctx, ref!),
    },
    signFilesUploadRead: { handle: (input, ctx) => signFilesUploadRead(deps, ctx, input.params.siloFileId) },
    // Media sets (D237).
    checkFilesSilo: { handle: (input, ctx) => checkFilesSilo(deps, ctx, input.params.siloId) },
    openMediaUpload: { handle: (input, ctx) => openMediaUpload(deps, ctx, input.params.siloFileId, input.body.link) },
    getFilesUpload: { handle: (input, ctx) => getFilesUpload(deps, ctx, input.params.siloFileId) },
    completeUpload: {
      handle: (input, ctx) => imports.completeUpload(deps, ctx, input.params.siloId, input.params.sourceId, input.params.uploadId, input.body),
      resultRef: (out) => out.id,
      replay: async (ref, ctx) => {
        const file = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => siloFileRepo.findById(db, ref!), { readOnly: true });
        if (file === undefined) throw new AppError('not_found', 'no such file', { code: 'import.file_not_found' });
        return imports.fileView(file);
      },
    },
    listFiles: { handle: (input, ctx) => imports.listFiles(deps, ctx, input.params.siloId) },
    getExtraction: { handle: (input, ctx) => imports.getExtraction(deps, ctx, input.params.siloId, input.params.extractionId) },
    readRecordExtractions: { handle: (input, ctx) => imports.readRecordExtractions(deps, ctx, input.body.records) },
    listExtractions: {
      handle: (input, ctx) => imports.listExtractions(deps, ctx, input.params.siloId, { fileId: input.query.fileId, unconfirmed: input.query.unconfirmed === 'true' }),
    },
    confirmExtraction: { handle: (input, ctx) => imports.confirmExtraction(deps, ctx, input.params.siloId, input.params.extractionId) },
    rebuildImportSilo: { handle: (input, ctx) => processing.rebuildImportSilo(deps, ctx, input.params.siloId) },
  };
}
