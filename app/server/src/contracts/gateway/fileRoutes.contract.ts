// Files in the product (spec 41): exporting a saved view's answer needs file.export (render
// decides again, and files a third time as it stores the file). Everything else reaches the
// files the member made or that are shared with them, which the files service decides per
// file for the membership the gateway puts in the context, with the marking check at every
// open. Downloads come back as base64 in JSON: the object store is never exposed.

import * as fl from '../files/file.contract.ts';
import * as lg from '../files/logo.contract.ts';
import * as md from '../files/media.contract.ts';
import { mapTilesSource as tiles, readMapTile as tile } from '../files/mapTiles.contract.ts';
import { renderExport } from '../render/render.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

export const exportToFiles = definePublicRoute({
  name: 'exportToFiles', method: 'POST', path: '/exports', session: 'complete', permission: { permission: 'file.export' },
  body: renderExport.body, response: renderExport.response, status: 201, forwards: renderExport,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listFiles = definePublicRoute({
  name: 'listFiles', method: 'GET', path: '/files', session: 'complete', ownRecords: true,
  query: fl.listFiles.query, response: fl.listFiles.response, forwards: fl.listFiles,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const readFile = definePublicRoute({
  name: 'readFile', method: 'GET', path: '/files/:fileId', session: 'complete', ownRecords: true,
  params: fl.getFile.params, response: fl.getFile.response, forwards: fl.getFile,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const uploadToFiles = definePublicRoute({
  name: 'uploadToFiles', method: 'POST', path: '/files/uploads', session: 'complete', permission: { permission: 'file.upload' },
  body: fl.uploadFile.body, response: fl.uploadFile.response, status: 201, forwards: fl.uploadFile,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

/** An upload larger than one request: a signed transfer straight to the Silo's storage, then completed (41.4). */
export const beginUploadToFiles = definePublicRoute({
  name: 'beginUploadToFiles', method: 'POST', path: '/files/upload-transfers', session: 'complete', permission: { permission: 'file.upload' },
  body: fl.beginFileUpload.body, response: fl.beginFileUpload.response, status: 201, forwards: fl.beginFileUpload,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const completeUploadToFiles = definePublicRoute({
  name: 'completeUploadToFiles', method: 'POST', path: '/files/upload-transfers/:uploadId/completion', session: 'complete',
  permission: { permission: 'file.upload' },
  params: fl.completeFileUpload.params, body: fl.completeFileUpload.body, response: fl.completeFileUpload.response, status: 201,
  forwards: fl.completeFileUpload,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

/** A signed download link for an upload too large to open in one reply, checked as opening it is. */
export const fileDownloadLink = definePublicRoute({
  name: 'fileDownloadLink', reads: true, method: 'POST', path: '/files/:fileId/download-links', session: 'complete', ownRecords: true,
  params: fl.getFileDownloadLink.params, response: fl.getFileDownloadLink.response, status: 201, forwards: fl.getFileDownloadLink,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const downloadFile = definePublicRoute({
  name: 'downloadFile', method: 'GET', path: '/files/:fileId/content', session: 'complete', ownRecords: true,
  params: fl.downloadFile.params, response: fl.downloadFile.response, forwards: fl.downloadFile,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const updateFile = definePublicRoute({
  name: 'updateFile', method: 'PATCH', path: '/files/:fileId', session: 'complete', ownRecords: true,
  params: fl.updateFile.params, body: fl.updateFile.body, response: fl.updateFile.response, forwards: fl.updateFile,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const deleteFile = definePublicRoute({
  name: 'deleteFile', method: 'DELETE', path: '/files/:fileId', session: 'complete', ownRecords: true,
  params: fl.deleteFile.params, response: fl.deleteFile.response, forwards: fl.deleteFile,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const shareFile = definePublicRoute({
  name: 'shareFile', method: 'POST', path: '/files/:fileId/shares', session: 'complete', permission: { permission: 'file.share' },
  params: fl.shareFile.params, body: fl.shareFile.body, response: fl.shareFile.response, status: 201, forwards: fl.shareFile,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const revokeFileShare = definePublicRoute({
  name: 'revokeFileShare', method: 'POST', path: '/files/:fileId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
  params: fl.revokeFileShare.params, response: fl.revokeFileShare.response, forwards: fl.revokeFileShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listFileShares = definePublicRoute({
  name: 'listFileShares', method: 'GET', path: '/files/:fileId/shares', session: 'complete', ownRecords: true,
  params: fl.listFileShares.params, response: fl.listFileShares.response, forwards: fl.listFileShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const createFolder = definePublicRoute({
  name: 'createFolder', method: 'POST', path: '/folders', session: 'complete', ownRecords: true,
  body: fl.createFolder.body, response: fl.createFolder.response, status: 201, forwards: fl.createFolder,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listFolders = definePublicRoute({
  name: 'listFolders', method: 'GET', path: '/folders', session: 'complete', ownRecords: true,
  query: fl.listFolders.query, response: fl.listFolders.response, forwards: fl.listFolders,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const updateFolder = definePublicRoute({
  name: 'updateFolder', method: 'PATCH', path: '/folders/:folderId', session: 'complete', ownRecords: true,
  params: fl.updateFolder.params, body: fl.updateFolder.body, response: fl.updateFolder.response, forwards: fl.updateFolder,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

/** clone.view: the basemap (29.3): what it is, and its tiles one at a time, read through the gateway (D227). */
export const mapTilesSource = definePublicRoute({
  name: 'mapTilesSource', method: 'GET', path: '/map-tiles', session: 'complete', permission: { permission: 'clone.view' },
  response: tiles.response, forwards: tiles, call: () => ({}), reply: (output) => output,
});

export const readMapTile = definePublicRoute({
  name: 'readMapTile', method: 'GET', path: '/map-tiles/:z/:x/:y', session: 'complete', permission: { permission: 'clone.view' },
  params: tile.params, response: tile.response, forwards: tile, call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const setOrganisationLogo = definePublicRoute({
  name: 'setOrganisationLogo', method: 'PUT', path: '/organisation/logo', session: 'complete', permission: { permission: 'org.logo.manage' },
  body: lg.setOrganisationLogo.body, response: lg.setOrganisationLogo.response, maxBodyBytes: Math.ceil(lg.LOGO_MAX_BYTES / 3) * 4 + 1_024,
  forwards: lg.setOrganisationLogo, call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const readOrganisationLogo = definePublicRoute({
  name: 'readOrganisationLogo', method: 'GET', path: '/organisation/logo', session: 'complete',
  decidedByService: 'files serves the logo to any member of the organisation, never publicly (56.2)',
  response: lg.getOrganisationLogo.response, forwards: lg.getOrganisationLogo, call: () => ({}), reply: (o) => o,
});

// Media sets (D237): images, video, audio and PDFs kept in an Import Silo, shared as files are; opened under the opener's own access.
export const createMediaSet = definePublicRoute({
  name: 'createMediaSet', method: 'POST', path: '/media-sets', session: 'complete', permission: { permission: 'file.upload' },
  body: md.createMediaSet.body, response: md.createMediaSet.response, status: 201, forwards: md.createMediaSet,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});
export const listMediaSets = definePublicRoute({
  name: 'listMediaSets', method: 'GET', path: '/media-sets', session: 'complete', ownRecords: true,
  query: md.listMediaSets.query, response: md.listMediaSets.response, forwards: md.listMediaSets,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});
export const getMediaSet = definePublicRoute({
  name: 'getMediaSet', method: 'GET', path: '/media-sets/:mediaSetId', session: 'complete', ownRecords: true,
  params: md.getMediaSet.params, response: md.getMediaSet.response, forwards: md.getMediaSet,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const saveMediaSet = definePublicRoute({
  name: 'saveMediaSet', method: 'PUT', path: '/media-sets/:mediaSetId', session: 'complete', ownRecords: true,
  params: md.saveMediaSet.params, body: md.saveMediaSet.body, response: md.saveMediaSet.response, forwards: md.saveMediaSet,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const archiveMediaSet = definePublicRoute({
  name: 'archiveMediaSet', method: 'POST', path: '/media-sets/:mediaSetId/archive', session: 'complete', ownRecords: true,
  params: md.archiveMediaSet.params, response: md.archiveMediaSet.response, forwards: md.archiveMediaSet,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listMediaItems = definePublicRoute({
  name: 'listMediaItems', method: 'GET', path: '/media-sets/:mediaSetId/items', session: 'complete', ownRecords: true,
  params: md.listMediaItems.params, query: md.listMediaItems.query, response: md.listMediaItems.response, forwards: md.listMediaItems,
  call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});
export const addMediaItem = definePublicRoute({
  name: 'addMediaItem', method: 'POST', path: '/media-sets/:mediaSetId/items', session: 'complete', permission: { permission: 'file.upload' },
  params: md.addMediaItem.params, body: md.addMediaItem.body, response: md.addMediaItem.response, status: 201, forwards: md.addMediaItem,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const beginMediaUpload = definePublicRoute({
  name: 'beginMediaUpload', method: 'POST', path: '/media-sets/:mediaSetId/uploads', session: 'complete', permission: { permission: 'file.upload' },
  params: md.beginMediaUpload.params, body: md.beginMediaUpload.body, response: md.beginMediaUpload.response, status: 201, forwards: md.beginMediaUpload,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const completeMediaUpload = definePublicRoute({
  name: 'completeMediaUpload', method: 'POST', path: '/media-sets/:mediaSetId/uploads/:uploadId/completion', session: 'complete', permission: { permission: 'file.upload' },
  params: md.completeMediaUpload.params, body: md.completeMediaUpload.body, response: md.completeMediaUpload.response, status: 201, forwards: md.completeMediaUpload,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const openMediaItem = definePublicRoute({
  name: 'openMediaItem', reads: true, method: 'POST', path: '/media-sets/:mediaSetId/items/:itemId/opens', session: 'complete', ownRecords: true,
  params: md.openMediaItem.params, body: md.openMediaItem.body, response: md.openMediaItem.response, status: 201, forwards: md.openMediaItem,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const removeMediaItem = definePublicRoute({
  name: 'removeMediaItem', method: 'POST', path: '/media-sets/:mediaSetId/items/:itemId/removal', session: 'complete', ownRecords: true,
  params: md.removeMediaItem.params, response: md.removeMediaItem.response, forwards: md.removeMediaItem,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const shareMediaSet = definePublicRoute({
  name: 'shareMediaSet', method: 'POST', path: '/media-sets/:mediaSetId/shares', session: 'complete', permission: { permission: 'file.share' },
  params: md.shareMediaSet.params, body: md.shareMediaSet.body, response: md.shareMediaSet.response, status: 201, forwards: md.shareMediaSet,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const revokeMediaSetShare = definePublicRoute({
  name: 'revokeMediaSetShare', method: 'POST', path: '/media-sets/:mediaSetId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
  params: md.revokeMediaSetShare.params, response: md.revokeMediaSetShare.response, forwards: md.revokeMediaSetShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listMediaSetShares = definePublicRoute({
  name: 'listMediaSetShares', method: 'GET', path: '/media-sets/:mediaSetId/shares', session: 'complete', ownRecords: true,
  params: md.listMediaSetShares.params, response: md.listMediaSetShares.response, forwards: md.listMediaSetShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

// Media linked to objects (D238).
export const setMediaLinkRule = definePublicRoute({
  name: 'setMediaLinkRule', method: 'PUT', path: '/media-sets/:mediaSetId/link-rule', session: 'complete', ownRecords: true,
  params: md.setMediaLinkRule.params, body: md.setMediaLinkRule.body, response: md.setMediaLinkRule.response, forwards: md.setMediaLinkRule,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const applyMediaLinkRule = definePublicRoute({
  name: 'applyMediaLinkRule', method: 'POST', path: '/media-sets/:mediaSetId/link-rule/runs', session: 'complete', ownRecords: true,
  params: md.applyMediaLinkRule.params, response: md.applyMediaLinkRule.response, status: 201, forwards: md.applyMediaLinkRule,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const linkMediaItem = definePublicRoute({
  name: 'linkMediaItem', method: 'POST', path: '/media-sets/:mediaSetId/items/:itemId/links', session: 'complete', ownRecords: true,
  params: md.linkMediaItem.params, body: md.linkMediaItem.body, response: md.linkMediaItem.response, status: 201, forwards: md.linkMediaItem,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const unlinkMediaItem = definePublicRoute({
  name: 'unlinkMediaItem', method: 'POST', path: '/media-sets/:mediaSetId/items/:itemId/links/:linkId/removal', session: 'complete', ownRecords: true,
  params: md.unlinkMediaItem.params, response: md.unlinkMediaItem.response, forwards: md.unlinkMediaItem,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listObjectMedia = definePublicRoute({
  name: 'listObjectMedia', method: 'GET', path: '/object-media', session: 'complete', ownRecords: true,
  query: md.listObjectMedia.query, response: md.listObjectMedia.response, forwards: md.listObjectMedia,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const FILE_ROUTES = [
  setOrganisationLogo, readOrganisationLogo,
  mapTilesSource, readMapTile,
  exportToFiles, uploadToFiles, beginUploadToFiles, completeUploadToFiles, fileDownloadLink, listFiles, readFile, downloadFile, updateFile, deleteFile, shareFile, revokeFileShare, listFileShares, createFolder,
  listFolders, updateFolder,
  createMediaSet, listMediaSets, getMediaSet, saveMediaSet, archiveMediaSet, listMediaItems, addMediaItem, beginMediaUpload, completeMediaUpload,
  openMediaItem, removeMediaItem, shareMediaSet, revokeMediaSetShare, listMediaSetShares,
  setMediaLinkRule, applyMediaLinkRule, linkMediaItem, unlinkMediaItem, listObjectMedia,
];
