// Thin handlers: each media set contract (D237) to its function in services/files/media.service.ts.

import type * as m from '../../contracts/files/media.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { FilesDeps } from '../../services/files/deps.service.ts';
import * as media from '../../services/files/media.service.ts';
import * as links from '../../services/files/mediaLinks.service.ts';

type Name = 'createMediaSet' | 'listMediaSets' | 'getMediaSet' | 'saveMediaSet' | 'archiveMediaSet' | 'listMediaItems' | 'addMediaItem'
  | 'beginMediaUpload' | 'completeMediaUpload' | 'openMediaItem' | 'removeMediaItem' | 'shareMediaSet' | 'revokeMediaSetShare' | 'listMediaSetShares'
  | 'setMediaLinkRule' | 'applyMediaLinkRule' | 'linkMediaItem' | 'unlinkMediaItem' | 'listObjectMedia';

export function mediaController(deps: FilesDeps): { [K in Name]: RouteHandlers<(typeof m)[K]> } {
  return {
    createMediaSet: {
      handle: ({ body }, ctx) => media.createMediaSet(deps, ctx, body), resultRef: (out) => out.id, replay: (ref, ctx) => media.getMediaSet(deps, ctx, ref!),
    },
    listMediaSets: { handle: ({ query }, ctx) => media.listMediaSets(deps, ctx, query.filter, query.limit) },
    getMediaSet: { handle: ({ params }, ctx) => media.getMediaSet(deps, ctx, params.mediaSetId) },
    saveMediaSet: { handle: ({ params, body }, ctx) => media.saveMediaSet(deps, ctx, params.mediaSetId, body) },
    archiveMediaSet: { handle: ({ params }, ctx) => media.archiveMediaSet(deps, ctx, params.mediaSetId) },
    listMediaItems: { handle: ({ params, query }, ctx) => media.listMediaItems(deps, ctx, params.mediaSetId, query) },
    addMediaItem: {
      handle: ({ params, body }, ctx) => media.addMediaItem(deps, ctx, params.mediaSetId, body),
      resultRef: (out) => `${out.mediaSetId}.${out.id}`, replay: (ref, ctx) => media.mediaItem(deps, ctx, ref!),
    },
    beginMediaUpload: { handle: ({ params, body }, ctx) => media.beginMediaUpload(deps, ctx, params.mediaSetId, body.sizeBytes) },
    completeMediaUpload: {
      handle: ({ params, body }, ctx) => media.completeMediaUpload(deps, ctx, params.mediaSetId, params.uploadId, body.name),
      resultRef: (out) => `${out.mediaSetId}.${out.id}`, replay: (ref, ctx) => media.mediaItem(deps, ctx, ref!),
    },
    openMediaItem: { handle: ({ params, body }, ctx) => media.openMediaItem(deps, ctx, params.mediaSetId, params.itemId, body.link) },
    removeMediaItem: { handle: ({ params }, ctx) => media.removeMediaItem(deps, ctx, params.mediaSetId, params.itemId) },
    shareMediaSet: { handle: ({ params, body }, ctx) => media.shareMediaSet(deps, ctx, params.mediaSetId, body) },
    revokeMediaSetShare: { handle: ({ params }, ctx) => media.revokeMediaSetShare(deps, ctx, params.mediaSetId, params.shareId) },
    listMediaSetShares: { handle: ({ params }, ctx) => media.listMediaSetShares(deps, ctx, params.mediaSetId) },
    // Links to objects (D238).
    setMediaLinkRule: { handle: ({ params, body }, ctx) => links.setMediaLinkRule(deps, ctx, params.mediaSetId, body.rule) },
    applyMediaLinkRule: { handle: ({ params }, ctx) => links.applyMediaLinkRule(deps, ctx, params.mediaSetId) },
    linkMediaItem: { handle: ({ params, body }, ctx) => links.linkMediaItem(deps, ctx, params.mediaSetId, params.itemId, body) },
    unlinkMediaItem: { handle: ({ params }, ctx) => links.unlinkMediaItem(deps, ctx, params.mediaSetId, params.itemId, params.linkId) },
    listObjectMedia: { handle: ({ query }, ctx) => links.listObjectMedia(deps, ctx, query) },
  };
}
