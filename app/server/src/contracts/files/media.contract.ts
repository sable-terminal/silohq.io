// Media sets (D237; beyond the spec: the unstructured media of the Foundry-comparison
// features). A media set is a named collection of images, video, audio and PDFs kept in one
// Import Silo: each item is a Files upload into that Silo (so it carries the Silo's retention and
// markings, sits inside the Siloes disclosure and is purged with it), with the facts its own
// bytes give (kind, type, size, frame size, duration, pages, when a photo was taken), read
// without decoding it (services/siloes-import/mediaFacts.service.ts).
//
// Its owner shares it as a file is shared (41.3: file.share; with everyone only where the
// organisation permits it): to view (see and open its items) or to contribute (also add to them).
// Opening an item needs a live share or ownership, every marking on the Silo, and the Silo open;
// it does not need silo.import, which is for putting data into a Silo. Making a set and adding to
// it does, with file.upload, as any upload into Files does (both grantable on that one Silo). An item opens in one reply up to the reply bound, and through a
// signed, short-lived link above it, so video can seek. Removing an item from a set leaves the
// upload in Files; deleting the upload there removes it from the set.
//
// Links to objects (D238): an item is linked to an object by a person on the object's page (its
// Silo id known there), or by the set's link rule: a filename pattern with one {key} (and up to
// two * for anything), whose key is matched against a property of the rule's type among the
// objects whoever adds the item, or applies the rule, may read. A link holds the object's Silo id,
// never a record value. An object shows the items linked to it to those who may see their set.

import { z } from 'zod';
import { MAX_EXPORT_BYTES } from '../../config/files.config.ts';
import { recordValue } from '../../utils/recordValue.util.ts';
import { defineContract } from '../endpoint.contract.ts';

const CALLERS = ['gateway'] as const;
const MAX_BASE64 = Math.ceil(MAX_EXPORT_BYTES / 3) * 4;
export const MEDIA_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

const name = z.string().trim().min(1).max(200).refine((n) => !/[\u0000-\u001f/\\]/.test(n), 'a name has no control characters or slashes');
const access = z.enum(['owner', 'view', 'contribute']);

/** A filename with one {key} and up to two *: the text where {key} stands is the key. */
export const linkPattern = z.string().trim().min(1).max(200).refine((p) => p.split('{key}').length === 2 && (p.match(/\*/g)?.length ?? 0) <= 2 && !/[/\\]/.test(p),
  'a pattern has one {key}, at most two *, and no slashes');
export const linkRule = z.strictObject({ objectTypeId: z.uuid(), propertyId: z.uuid(), pattern: linkPattern });
export type LinkRule = z.infer<typeof linkRule>;

export const mediaLinkView = z.object({
  id: z.uuid(), objectTypeId: z.uuid(), objectId: z.uuid(), madeBy: z.enum(['person', 'rule']), linkedBy: z.uuid(), linkedAt: z.string(),
});

export const mediaSetSummary = z.object({
  id: z.uuid(), name: z.string(), description: z.string(), siloId: z.uuid(), ownerMembershipId: z.uuid(), access, itemCount: z.int(),
  linkRule: linkRule.nullable(),
  createdAt: z.string(), updatedAt: z.string(), archivedAt: z.string().nullable(), lockVersion: z.int(),
});
export type MediaSetSummary = z.infer<typeof mediaSetSummary>;

export const mediaItemView = z.object({
  id: z.uuid(), mediaSetId: z.uuid(), fileId: z.uuid(),
  /** As uploaded: shown to people, never used in a key or a path. */
  name: z.string(),
  kind: z.enum(MEDIA_KINDS), contentType: z.string(), sizeBytes: z.int(),
  width: z.int().nullable(), height: z.int().nullable(), durationMs: z.int().nullable(), pages: z.int().nullable(),
  /** When a photo was taken, as its camera wrote it: local time, no zone. */
  capturedAt: z.string().nullable(),
  addedBy: z.uuid(), addedAt: z.string(),
  markings: z.array(z.object({ id: z.uuid(), name: z.string() })),
  /** Whether the caller may open it now: every marking on its Silo. */
  canOpen: z.boolean(),
  /** The objects it is linked to (D238). */
  links: z.array(mediaLinkView),
});
export type MediaItemView = z.infer<typeof mediaItemView>;

export const mediaSetShareView = z.object({
  id: z.uuid(), mediaSetId: z.uuid(), granteeMembershipId: z.uuid().nullable(), granteeScopeId: z.uuid().nullable(), granteeWholeOrganisation: z.boolean(),
  access: z.enum(['view', 'contribute']), sharedBy: z.uuid(), expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), createdAt: z.string(),
});
const grantee = z.union([z.strictObject({ membershipId: z.uuid() }), z.strictObject({ scopeId: z.uuid() }), z.strictObject({ organisation: z.literal(true) })]);

const params = z.strictObject({ mediaSetId: z.uuid() });
const itemParams = z.strictObject({ mediaSetId: z.uuid(), itemId: z.uuid() });

export const createMediaSet = defineContract({
  service: 'files', name: 'createMediaSet', method: 'POST', path: '/v1/media-sets', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({ name, description: z.string().trim().max(2_000).default(''), siloId: z.uuid() }),
  response: mediaSetSummary, status: 201,
});

export const listMediaSets = defineContract({
  service: 'files', name: 'listMediaSets', method: 'GET', path: '/v1/media-sets', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ filter: z.enum(['mine', 'shared', 'archived']).default('mine'), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: z.object({ mediaSets: z.array(mediaSetSummary) }),
});

export const getMediaSet = defineContract({
  service: 'files', name: 'getMediaSet', method: 'GET', path: '/v1/media-sets/:mediaSetId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: mediaSetSummary,
});

export const saveMediaSet = defineContract({
  service: 'files', name: 'saveMediaSet', method: 'PUT', path: '/v1/media-sets/:mediaSetId', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ name, description: z.string().trim().max(2_000), lockVersion: z.int().min(1) }),
  response: mediaSetSummary,
});

export const archiveMediaSet = defineContract({
  service: 'files', name: 'archiveMediaSet', method: 'POST', path: '/v1/media-sets/:mediaSetId/archive', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: mediaSetSummary,
});

/** Its items, newest first, a page at a time; filtered by kind. */
export const listMediaItems = defineContract({
  service: 'files', name: 'listMediaItems', method: 'GET', path: '/v1/media-sets/:mediaSetId/items', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  query: z.strictObject({
    kind: z.enum(MEDIA_KINDS).optional(),
    /** The last item of the previous page. */
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
  }),
  response: z.object({ items: z.array(mediaItemView), next: z.uuid().nullable() }),
});

/** An item added in one request: the owner's or a contributor's, with silo.import on the set's Silo and its markings. */
export const addMediaItem = defineContract({
  service: 'files', name: 'addMediaItem', method: 'POST', path: '/v1/media-sets/:mediaSetId/items', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params,
  body: z.strictObject({ name, contentBase64: recordValue(z.base64().min(4).max(MAX_BASE64)) }),
  response: mediaItemView, status: 201, maxBodyBytes: MAX_BASE64 + 4096,
});

/** A larger item: a signed transfer straight to the Silo's storage, then completed into the set. */
export const beginMediaUpload = defineContract({
  service: 'files', name: 'beginMediaUpload', method: 'POST', path: '/v1/media-sets/:mediaSetId/uploads', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, body: z.strictObject({ sizeBytes: z.int().min(1) }),
  response: z.object({
    uploadId: z.uuid(), url: z.string(), method: z.enum(['PUT', 'POST']), headers: z.record(z.string(), z.string()), expiresAt: z.string(), maxBytes: z.int(),
  }),
  status: 201,
});

export const completeMediaUpload = defineContract({
  service: 'files', name: 'completeMediaUpload', method: 'POST', path: '/v1/media-sets/:mediaSetId/uploads/:uploadId/completion', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed', params: z.strictObject({ mediaSetId: z.uuid(), uploadId: z.uuid() }),
  body: z.strictObject({ name }), response: mediaItemView, status: 201,
});

/** An item's bytes for the person opening it: in the reply up to the reply bound, else a signed, short-lived link. Recorded as opened. */
export const openMediaItem = defineContract({
  service: 'files', name: 'openMediaItem', method: 'POST', path: '/v1/media-sets/:mediaSetId/items/:itemId/opens', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: itemParams,
  body: z.strictObject({ link: z.boolean().default(false) }),
  response: z.union([
    z.object({ kind: z.literal('content'), contentType: z.string(), content: recordValue(z.base64()) }),
    z.object({ kind: z.literal('link'), contentType: z.string(), url: z.string(), expiresAt: z.string() }),
  ]),
  status: 201,
});

/** Out of the set; the upload stays in Files. The owner, or whoever added it. */
export const removeMediaItem = defineContract({
  service: 'files', name: 'removeMediaItem', method: 'POST', path: '/v1/media-sets/:mediaSetId/items/:itemId/removal', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: itemParams, response: z.object({ removed: z.literal(true) }),
});

export const shareMediaSet = defineContract({
  service: 'files', name: 'shareMediaSet', method: 'POST', path: '/v1/media-sets/:mediaSetId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  body: z.strictObject({ grantee, access: z.enum(['view', 'contribute']).default('view'), expiresAt: z.iso.datetime({ offset: true }).optional() }),
  response: mediaSetShareView, status: 201,
});

export const revokeMediaSetShare = defineContract({
  service: 'files', name: 'revokeMediaSetShare', method: 'POST', path: '/v1/media-sets/:mediaSetId/shares/:shareId/revoke', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ mediaSetId: z.uuid(), shareId: z.uuid() }), response: mediaSetShareView,
});

export const listMediaSetShares = defineContract({
  service: 'files', name: 'listMediaSetShares', method: 'GET', path: '/v1/media-sets/:mediaSetId/shares', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, response: z.object({ shares: z.array(mediaSetShareView) }),
});

// ----------------------------------------------------------------------------- links to objects (D238)

/** The set's link rule, its owner's: checked against the ontology (a string, integer, decimal or enum property of the type). Null clears it. */
export const setMediaLinkRule = defineContract({
  service: 'files', name: 'setMediaLinkRule', method: 'PUT', path: '/v1/media-sets/:mediaSetId/link-rule', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params, body: z.strictObject({ rule: linkRule.nullable() }), response: mediaSetSummary,
});

/** The rule applied to every item now, as its owner: what each key matched, linked; nothing linked twice. */
export const applyMediaLinkRule = defineContract({
  service: 'files', name: 'applyMediaLinkRule', method: 'POST', path: '/v1/media-sets/:mediaSetId/link-rule/runs', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params,
  response: z.object({
    /** Items read; items whose name gave a key; links made now. */
    items: z.int(), keyed: z.int(), linked: z.int(),
    /** Why the objects could not be read, when they could not. */
    refused: z.string().nullable(),
  }),
  status: 201,
});

/** An item linked to an object by a person (on the object's page): the set's owner or a contributor. */
export const linkMediaItem = defineContract({
  service: 'files', name: 'linkMediaItem', method: 'POST', path: '/v1/media-sets/:mediaSetId/items/:itemId/links', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: itemParams,
  body: z.strictObject({ objectTypeId: z.uuid(), objectId: z.uuid() }), response: mediaLinkView, status: 201,
});

export const unlinkMediaItem = defineContract({
  service: 'files', name: 'unlinkMediaItem', method: 'POST', path: '/v1/media-sets/:mediaSetId/items/:itemId/links/:linkId/removal', callers: CALLERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ mediaSetId: z.uuid(), itemId: z.uuid(), linkId: z.uuid() }),
  response: z.object({ removed: z.literal(true) }),
});

/** The items linked to an object that the caller may see through their sets, newest link first. */
export const listObjectMedia = defineContract({
  service: 'files', name: 'listObjectMedia', method: 'GET', path: '/v1/object-media', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ objectTypeId: z.uuid(), objectId: z.uuid(), limit: z.coerce.number().int().min(1).max(200).default(60) }),
  response: z.object({ items: z.array(mediaItemView.extend({ mediaSetName: z.string() })) }),
});
