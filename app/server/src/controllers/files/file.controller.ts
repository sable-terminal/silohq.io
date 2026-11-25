// Thin handlers: each contract to its function in services/files.

import type {
  createExport, createFolder, deleteFile, downloadFile, getExport, getFile, listFileShares, listFiles, listFolders, previewExportMarkings,
  recordUploadsPurged, revokeFileShare, shareFile, updateFile, updateFolder, uploadFile, beginFileUpload, completeFileUpload, getFileDownloadLink,
} from '../../contracts/files/file.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { FilesDeps } from '../../services/files/deps.service.ts';
import { createExportFile, exportedFile, previewMarkings } from '../../services/files/exports.service.ts';
import * as files from '../../services/files/files.service.ts';
import * as uploads from '../../services/files/uploads.service.ts';
import type { mapTilesSource, readMapTile } from '../../contracts/files/mapTiles.contract.ts';
import { mapTilesSource as basemap, readMapTile as tileOf } from '../../services/files/mapTiles.service.ts';

export function fileController(deps: FilesDeps): {
  previewExportMarkings: RouteHandlers<typeof previewExportMarkings>;
  createExport: RouteHandlers<typeof createExport>;
  getExport: RouteHandlers<typeof getExport>;
  listFiles: RouteHandlers<typeof listFiles>;
  getFile: RouteHandlers<typeof getFile>;
  downloadFile: RouteHandlers<typeof downloadFile>;
  updateFile: RouteHandlers<typeof updateFile>;
  deleteFile: RouteHandlers<typeof deleteFile>;
  shareFile: RouteHandlers<typeof shareFile>;
  revokeFileShare: RouteHandlers<typeof revokeFileShare>;
  listFileShares: RouteHandlers<typeof listFileShares>;
  createFolder: RouteHandlers<typeof createFolder>;
  listFolders: RouteHandlers<typeof listFolders>;
  mapTilesSource: RouteHandlers<typeof mapTilesSource>;
  readMapTile: RouteHandlers<typeof readMapTile>;
  updateFolder: RouteHandlers<typeof updateFolder>;
  uploadFile: RouteHandlers<typeof uploadFile>;
  recordUploadsPurged: RouteHandlers<typeof recordUploadsPurged>;
  beginFileUpload: RouteHandlers<typeof beginFileUpload>;
  completeFileUpload: RouteHandlers<typeof completeFileUpload>;
  getFileDownloadLink: RouteHandlers<typeof getFileDownloadLink>;
} {
  return {
    previewExportMarkings: { handle: ({ body }, ctx) => previewMarkings(deps, ctx, body.inputs, body.carriedMarkingIds ?? []) },
    createExport: {
      handle: ({ body }, ctx) => createExportFile(deps, ctx, body),
      resultRef: (view) => view.id,
      replay: (ref, ctx) => exportedFile(deps, ctx, ref!),
    },
    getExport: { handle: ({ params }, ctx) => exportedFile(deps, ctx, params.fileId) },
    listFiles: { handle: ({ query }, ctx) => files.listFiles(deps, ctx, query) },
    getFile: { handle: ({ params }, ctx) => files.getFile(deps, ctx, params.fileId) },
    downloadFile: { handle: ({ params }, ctx) => files.downloadFile(deps, ctx, params.fileId) },
    updateFile: { handle: ({ params, body }, ctx) => files.updateFile(deps, ctx, params.fileId, body) },
    deleteFile: { handle: ({ params }, ctx) => files.deleteFile(deps, ctx, params.fileId) },
    shareFile: { handle: ({ params, body }, ctx) => files.shareFile(deps, ctx, params.fileId, body) },
    revokeFileShare: { handle: ({ params }, ctx) => files.revokeFileShare(deps, ctx, params.fileId, params.shareId) },
    listFileShares: { handle: async ({ params }, ctx) => ({ shares: await files.listFileShares(deps, ctx, params.fileId) }) },
    createFolder: { handle: ({ body }, ctx) => files.createFolder(deps, ctx, body) },
    listFolders: { handle: async ({ query }, ctx) => ({ folders: await files.listFolders(deps, ctx, query.parentId) }) },
    mapTilesSource: { handle: (_input, ctx) => basemap(deps, ctx) },
    readMapTile: { handle: (input, ctx) => tileOf(deps, ctx, input.params) },
    updateFolder: { handle: ({ params, body }, ctx) => files.updateFolder(deps, ctx, params.folderId, body) },
    uploadFile: {
      handle: ({ body }, ctx) => uploads.uploadFile(deps, ctx, body),
      // A retried upload answers with the entry it made: nothing is stored twice.
      resultRef: (view) => view.id,
      replay: (ref, ctx) => files.getFile(deps, ctx, ref!),
    },
    recordUploadsPurged: { handle: ({ body }, ctx) => uploads.recordUploadsPurged(deps, ctx, body) },
    beginFileUpload: { handle: ({ body }, ctx) => uploads.beginLargeUpload(deps, ctx, body) },
    completeFileUpload: {
      handle: ({ params, body }, ctx) => uploads.completeLargeUpload(deps, ctx, params.uploadId, body),
      resultRef: (view) => view.id,
      replay: (ref, ctx) => files.getFile(deps, ctx, ref!),
    },
    getFileDownloadLink: { handle: ({ params }, ctx) => files.downloadLink(deps, ctx, params.fileId) },
  };
}
