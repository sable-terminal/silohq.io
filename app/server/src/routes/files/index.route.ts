// files (spec 41): exports with frozen permissions and provenance, uploads into an Import
// Silo, folders, sharing, opening under the access and marking checks of 41.3, deletion with
// its receipt, and the export retention sweep.

import { replayFilePurges } from '../../contracts/platform/purgeLedger.contract.ts';
import { replayFileDeletions } from '../../services/files/files.service.ts';
import { getOrganisationLogo, setOrganisationLogo } from '../../contracts/files/logo.contract.ts';
import { logoController } from '../../controllers/files/logo.controller.ts';
import { mapTilesSource, readMapTile } from '../../contracts/files/mapTiles.contract.ts';
import {
  createExport, createFolder, deleteFile, downloadFile, getExport, getFile, listFileShares, listFiles, listFolders, previewExportMarkings,
  recordUploadsPurged, revokeFileShare, shareFile, updateFile, updateFolder, uploadFile, beginFileUpload, completeFileUpload, getFileDownloadLink,
} from '../../contracts/files/file.contract.ts';
import { fileController } from '../../controllers/files/file.controller.ts';
import * as m from '../../contracts/files/media.contract.ts';
import { mediaController } from '../../controllers/files/media.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { createObjectStore, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { AppError } from '../../utils/errors.util.ts';
import { retentionWorker } from '../../workers/files/retention.worker.ts';

export function createFilesService(options: { store?: ObjectStore; now?: () => number } = {}) {
  return defineService({
    name: 'files',
    // redis-data: idempotency keys of the keyed operations (an export render retried).
    needs: { postgres: ['control'], redis: ['data'] },
    async create(deps) {
      const storage = deps.config.objectStorage;
      if (options.store === undefined && storage === undefined) {
        throw new AppError('configuration', 'files needs object storage (OBJECT_STORE)', { code: 'config.files.storage' });
      }
      const store = options.store ?? await createObjectStore(storage!);
      const files = {
        databases: deps.databases, services: deps.services, logger: deps.logger, store, config: deps.config.files, now: options.now ?? Date.now,
        tilesConfigured: options.store !== undefined || storage?.tilesBucket !== undefined,
      };
      const c = fileController(files);
      const logo = logoController(files);
      const media = mediaController(files);
      return {
        routes: [
          // After a restore, before traffic (8.2, 12.5; D251).
          route(replayFilePurges, { handle: (input) => replayFileDeletions(files, input.body.entries) }),
          route(setOrganisationLogo, logo.set), route(getOrganisationLogo, logo.get),
          route(previewExportMarkings, c.previewExportMarkings), route(createExport, c.createExport), route(getExport, c.getExport),
          route(listFiles, c.listFiles),
          route(getFile, c.getFile), route(downloadFile, c.downloadFile), route(updateFile, c.updateFile), route(deleteFile, c.deleteFile), route(uploadFile, c.uploadFile), route(recordUploadsPurged, c.recordUploadsPurged),
          // Larger than one request: signed transfers (41.4).
          route(beginFileUpload, c.beginFileUpload), route(completeFileUpload, c.completeFileUpload), route(getFileDownloadLink, c.getFileDownloadLink),
          route(shareFile, c.shareFile), route(revokeFileShare, c.revokeFileShare), route(listFileShares, c.listFileShares),
          route(createFolder, c.createFolder), route(listFolders, c.listFolders), route(updateFolder, c.updateFolder),
          route(mapTilesSource, c.mapTilesSource), route(readMapTile, c.readMapTile),
          // Media sets (D237).
          route(m.createMediaSet, media.createMediaSet), route(m.listMediaSets, media.listMediaSets), route(m.getMediaSet, media.getMediaSet),
          route(m.saveMediaSet, media.saveMediaSet), route(m.archiveMediaSet, media.archiveMediaSet), route(m.listMediaItems, media.listMediaItems),
          route(m.addMediaItem, media.addMediaItem), route(m.beginMediaUpload, media.beginMediaUpload), route(m.completeMediaUpload, media.completeMediaUpload),
          route(m.openMediaItem, media.openMediaItem), route(m.removeMediaItem, media.removeMediaItem), route(m.shareMediaSet, media.shareMediaSet),
          route(m.revokeMediaSetShare, media.revokeMediaSetShare), route(m.listMediaSetShares, media.listMediaSetShares),
          route(m.setMediaLinkRule, media.setMediaLinkRule), route(m.applyMediaLinkRule, media.applyMediaLinkRule), route(m.linkMediaItem, media.linkMediaItem),
          route(m.unlinkMediaItem, media.unlinkMediaItem), route(m.listObjectMedia, media.listObjectMedia),
        ],
        workers: [retentionWorker(files)],
      };
    },
  });
}

export const service = createFilesService();
