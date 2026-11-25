// Media sets (D237): images, video, audio and PDFs kept in one Import Silo, with the facts their
// bytes give. Each item is a Files upload (uploads.service.ts catalogues it, siloes-import keeps
// the bytes and decides the Silo's rules), so it carries the Silo's retention and markings and is
// purged with it; this keeps the set, its items' facts, and who it is shared with.
//
// Who may do what:
// - make a set: file.upload, and the Silo's own checks (silo.import on it, its markings, open);
// - see a set and its items: its owner, or a member a live share reaches (the membership, a
//   scope whose subtree holds one of theirs, or the organisation); an archived set, its owner;
// - open an item: as seeing it, and every marking on it now, and the Silo open. Not silo.import:
//   that is for putting data into a Silo. A refusal is answered plainly and recorded;
// - add an item: the owner or a contributor, with file.upload, and the Silo's checks as any
//   upload: what is not media is refused before anything is stored;
// - remove an item: the owner, or whoever added it; the upload stays in Files;
// - share it: its owner, holding file.share; with everyone only where the organisation permits;
// - link an item to an object (D238): the owner or a contributor, on the object's page; or the
//   set's rule, its owner's, applied as whoever adds an item or applies it (mediaLinks.service.ts).

import {
  beginFilesUpload, checkFilesSilo, completeFilesUpload, openMediaUpload, storeFilesUpload, type StoredUploadView,
} from '../../contracts/siloes/import.contract.ts';
import type { LinkRule, MediaItemView, MediaSetSummary } from '../../contracts/files/media.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { MediaItem, MediaLink, MediaSet, MediaSetShare } from '../../models/files/index.model.ts';
import { fileMarkingRepo, fileRepo, mediaItemRepo, mediaLinkRepo, mediaSetRepo, mediaSetShareRepo } from '../../repos/files/index.repo.ts';
import { membershipRepo, organisationRepo, scopeMembershipRepo, scopeRepo } from '../../repos/iam/index.repo.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { derivedKey } from '../visual-builder/versions.service.ts';
import { demand, memberOf, recordEvent, satisfiesAll, type Actor, type Context, type FilesDeps } from './deps.service.ts';
import { catalogue } from './uploads.service.ts';
import { linkByRule } from './mediaLinks.service.ts';

export type Held = 'owner' | 'view' | 'contribute';
type Keyed = Context & { idempotencyKey?: string | undefined };
const call = (actor: Actor, ctx: Context) => ({ request: actor.request, correlationId: ctx.correlationId });
const notFound = () => new AppError('not_found', 'no such media set', { code: 'files.media_set_not_found' });
export const itemNotFound = () => new AppError('not_found', 'no such item', { code: 'files.media_item_not_found' });

export async function heldOn(db: Queryable, set: MediaSet, actor: Actor): Promise<Held | undefined> {
  if (set.ownerMembershipId === actor.membershipId) return 'owner';
  if (set.archivedAt !== null) return undefined;
  const shares = await mediaSetShareRepo.liveReaching(db, set.id, actor.membershipId, await scopeMembershipRepo.activeScopePaths(db, actor.membershipId));
  return shares.some((s) => s.access === 'contribute') ? 'contribute' : shares.length > 0 ? 'view' : undefined;
}

async function summaryOf(db: Queryable, set: MediaSet, held: Held): Promise<MediaSetSummary> {
  const counts = await mediaItemRepo.countLive(db, [set.id]);
  return {
    id: set.id, name: set.name, description: set.description, siloId: set.siloId, ownerMembershipId: set.ownerMembershipId, access: held,
    itemCount: counts.get(set.id) ?? 0, linkRule: ruleOf(set), createdAt: set.createdAt, updatedAt: set.updatedAt, archivedAt: set.archivedAt, lockVersion: set.lockVersion,
  };
}

export const ruleOf = (set: MediaSet): LinkRule | null =>
  set.linkObjectTypeId === null || set.linkPropertyId === null || set.linkPattern === null ? null
    : { objectTypeId: set.linkObjectTypeId, propertyId: set.linkPropertyId, pattern: set.linkPattern };

/** The set, if the caller may see it, with what they hold on it. */
export async function reachable(deps: FilesDeps, actor: Actor, id: string): Promise<{ set: MediaSet; held: Held }> {
  const found = await inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const set = await mediaSetRepo.findById(db, id);
    const held = set === undefined ? undefined : await heldOn(db, set, actor);
    return set === undefined || held === undefined ? undefined : { set, held };
  }, { readOnly: true });
  if (found === undefined) throw notFound();
  return found;
}

export async function createMediaSet(deps: FilesDeps, ctx: Context, input: { name: string; description: string; siloId: string }): Promise<MediaSetSummary> {
  const actor = await memberOf(deps, ctx);
  await demand(deps, ctx, 'file.upload');
  // The Silo's own checks, now: an open Import Silo the person may put data into and is cleared for.
  await deps.services.call(checkFilesSilo, { params: { siloId: input.siloId } }, call(actor, ctx));
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const set = await mediaSetRepo.insert(db, {
      id: uuidv7(), organisationId: actor.organisationId, ownerMembershipId: actor.membershipId, name: input.name, description: input.description, siloId: input.siloId,
    });
    await recordEvent(db, actor, ctx.correlationId, { event: 'media_set_created', resource: { type: 'media_set', id: set.id }, detail: { silo_id: input.siloId } });
    return summaryOf(db, set, 'owner');
  });
}

export async function listMediaSets(deps: FilesDeps, ctx: Context, filter: 'mine' | 'shared' | 'archived', limit: number) {
  const actor = await memberOf(deps, ctx);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const sets = filter === 'shared'
      ? await mediaSetRepo.listByIds(db, await mediaSetShareRepo.setsReaching(db, actor.membershipId, await scopeMembershipRepo.activeScopePaths(db, actor.membershipId)), limit)
      : await mediaSetRepo.listMine(db, actor.membershipId, filter === 'archived', limit);
    const counts = await mediaItemRepo.countLive(db, sets.map((s) => s.id));
    const out: MediaSetSummary[] = [];
    for (const set of sets) {
      const held = await heldOn(db, set, actor);
      if (held === undefined || (filter === 'shared') === (held === 'owner')) continue;
      out.push({ ...(await summaryOf(db, set, held)), itemCount: counts.get(set.id) ?? 0 });
    }
    return { mediaSets: out };
  }, { readOnly: true });
}

export { summaryOf };

export async function getMediaSet(deps: FilesDeps, ctx: Context, id: string): Promise<MediaSetSummary> {
  const actor = await memberOf(deps, ctx);
  const { set, held } = await reachable(deps, actor, id);
  return inTransaction(deps.databases.pool('control'), actor.request, (db) => summaryOf(db, set, held), { readOnly: true });
}

export async function owned(db: Queryable, actor: Actor, id: string): Promise<MediaSet> {
  const set = await mediaSetRepo.findForUpdate(db, id);
  if (set === undefined || set.ownerMembershipId !== actor.membershipId) throw notFound();
  return set;
}

export async function saveMediaSet(deps: FilesDeps, ctx: Context, id: string, input: { name: string; description: string; lockVersion: number }) {
  const actor = await memberOf(deps, ctx);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const set = await owned(db, actor, id);
    if (set.archivedAt !== null) throw new AppError('conflict', 'an archived media set is not edited', { code: 'files.media_set_archived' });
    if (set.lockVersion !== input.lockVersion) throw new AppError('conflict', 'the media set changed since you read it', { code: 'files.media_set_stale' });
    const saved = (await mediaSetRepo.update(db, id, { name: input.name, description: input.description, lockVersion: set.lockVersion + 1 }))!;
    await recordEvent(db, actor, ctx.correlationId, { event: 'media_set_saved', resource: { type: 'media_set', id }, detail: {} });
    return summaryOf(db, saved, 'owner');
  });
}

export async function archiveMediaSet(deps: FilesDeps, ctx: Context, id: string) {
  const actor = await memberOf(deps, ctx);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const set = await owned(db, actor, id);
    const done = set.archivedAt !== null ? set : (await mediaSetRepo.update(db, id, { archivedAt: new Date(deps.now()).toISOString(), lockVersion: set.lockVersion + 1 }))!;
    if (set.archivedAt === null) await recordEvent(db, actor, ctx.correlationId, { event: 'media_set_archived', resource: { type: 'media_set', id }, detail: {} });
    return summaryOf(db, done, 'owner');
  });
}

// ----------------------------------------------------------------------------- items

export const linkViewOf = (l: MediaLink) => ({ id: l.id, objectTypeId: l.objectTypeId, objectId: l.objectId, madeBy: l.madeBy, linkedBy: l.linkedBy, linkedAt: l.linkedAt });

export function itemViewOf(item: MediaItem, name: string, markings: { id: string; name: string }[], canOpen: boolean, links: MediaLink[]): MediaItemView {
  return {
    id: item.id, mediaSetId: item.mediaSetId, fileId: item.fileId, name, kind: item.kind, contentType: item.contentType, sizeBytes: Number(item.sizeBytes),
    width: item.width, height: item.height, durationMs: item.durationMs === null ? null : Number(item.durationMs), pages: item.pages, capturedAt: item.capturedAt,
    addedBy: item.addedBy, addedAt: item.addedAt, markings, canOpen, links: links.filter((l) => l.mediaItemId === item.id).map(linkViewOf),
  };
}

export async function listMediaItems(deps: FilesDeps, ctx: Context, id: string, query: { kind?: MediaItem['kind'] | undefined; after?: string | undefined; limit: number }) {
  const actor = await memberOf(deps, ctx);
  await reachable(deps, actor, id);
  const control = deps.databases.pool('control');
  const page = await inTransaction(control, actor.request, async (db) => {
    const rows = await mediaItemRepo.page(db, id, { kind: query.kind, after: query.after, limit: query.limit + 1 });
    const labels = await fileMarkingRepo.labelsFor(db, rows.map((r) => r.item.fileId));
    return { rows, labels, links: await mediaLinkRepo.listLiveForItems(db, rows.map((r) => r.item.id)) };
  }, { readOnly: true });
  // One marking decision per marking on the page, as Files' own listing makes it.
  const held = new Map<string, boolean>();
  for (const markingId of new Set(page.labels.map((l) => l.id))) held.set(markingId, await satisfiesAll(deps, ctx, [markingId]));
  const shown = page.rows.slice(0, query.limit);
  return {
    items: shown.map(({ item, name }) => {
      const markings = page.labels.filter((l) => l.fileId === item.fileId).map((l) => ({ id: l.id, name: l.name }));
      return itemViewOf(item, name, markings, markings.every((m) => held.get(m.id) === true), page.links);
    }),
    next: page.rows.length > query.limit ? shown.at(-1)!.item.id : null,
  };
}

async function mayAdd(deps: FilesDeps, ctx: Context, actor: Actor, id: string): Promise<MediaSet> {
  const { set, held } = await reachable(deps, actor, id);
  if (held === 'view') throw new AppError('forbidden', 'this media set is shared with you to view, not to add to', { code: 'files.media_set_view_only' });
  if (set.archivedAt !== null) throw new AppError('conflict', 'an archived media set takes no new item', { code: 'files.media_set_archived' });
  await demand(deps, ctx, 'file.upload');
  return set;
}

async function addStored(deps: FilesDeps, ctx: Context, actor: Actor, set: MediaSet, name: string, stored: StoredUploadView): Promise<MediaItemView> {
  // siloes-import refuses what is not media before storing it; this is its answer's guarantee.
  if (stored.media === null) throw new AppError('internal', 'a media upload came back without its facts', { code: 'files.media_facts_missing' });
  const fileId = uuidv7();
  await catalogue(deps, ctx, actor, fileId, { siloId: set.siloId, name }, stored);
  const added = await inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const m = stored.media!;
    let item: MediaItem;
    try {
      item = await mediaItemRepo.insert(db, {
        id: uuidv7(), organisationId: actor.organisationId, mediaSetId: set.id, fileId, kind: m.kind, contentType: m.contentType, sizeBytes: String(stored.sizeBytes),
        width: m.width ?? null, height: m.height ?? null, durationMs: m.durationMs === undefined ? null : String(m.durationMs), pages: m.pages ?? null,
        capturedAt: m.capturedAt ?? null, addedBy: actor.membershipId,
      });
    } catch (error) {
      throw fromDatabaseError(error);
    }
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'media_item_added', resource: { type: 'media_set', id: set.id }, subjectMembershipId: actor.membershipId,
      detail: { item_id: item.id, file_id: fileId, kind: m.kind, bytes: stored.sizeBytes },
    });
    return item;
  });
  // The set's rule, as the person adding it: a key that names no object they may read links nothing; the item stays.
  const rule = ruleOf(set);
  const links = rule === null ? [] : await linkByRule(deps, ctx, actor, set, rule, [{ item: added, name }]).then((r) => r.links, () => []);
  const markings = await inTransaction(deps.databases.pool('control'), actor.request, (db) => fileMarkingRepo.labelsFor(db, [fileId]), { readOnly: true });
  return itemViewOf(added, name, markings.map((l) => ({ id: l.id, name: l.name })), true, links);
}

export async function addMediaItem(deps: FilesDeps, ctx: Keyed, id: string, input: { name: string; contentBase64: string }): Promise<MediaItemView> {
  const actor = await memberOf(deps, ctx);
  const set = await mayAdd(deps, ctx, actor, id);
  const size = Buffer.byteLength(input.contentBase64, 'base64');
  if (size > deps.config.maxExportBytes) {
    throw new AppError('bounds', 'the file is larger than one request may be: send it as a transfer', { code: 'files.upload_too_large', details: { bound: 'bytes', limit: deps.config.maxExportBytes } });
  }
  const stored = await deps.services.call(storeFilesUpload, {
    body: { siloId: set.siloId, filename: input.name, contentBase64: input.contentBase64, media: true },
  }, { ...call(actor, ctx), idempotencyKey: derivedKey(ctx.idempotencyKey ?? uuidv7(), 'silo') });
  return addStored(deps, ctx, actor, set, input.name, stored);
}

export async function beginMediaUpload(deps: FilesDeps, ctx: Context, id: string, sizeBytes: number) {
  const actor = await memberOf(deps, ctx);
  const set = await mayAdd(deps, ctx, actor, id);
  return deps.services.call(beginFilesUpload, { body: { siloId: set.siloId, sizeBytes } }, call(actor, ctx));
}

export async function completeMediaUpload(deps: FilesDeps, ctx: Keyed, id: string, uploadId: string, name: string): Promise<MediaItemView> {
  const actor = await memberOf(deps, ctx);
  const set = await mayAdd(deps, ctx, actor, id);
  const stored = await deps.services.call(completeFilesUpload, {
    params: { uploadId }, body: { siloId: set.siloId, filename: name, media: true },
  }, { ...call(actor, ctx), idempotencyKey: derivedKey(ctx.idempotencyKey ?? uploadId, 'silo') });
  return addStored(deps, ctx, actor, set, name, stored);
}

/** The live item of the set, with its upload's entry: gone once the upload is deleted. */
export async function liveItem(db: Queryable, setId: string, itemId: string) {
  const item = await mediaItemRepo.findById(db, itemId);
  if (item === undefined || item.mediaSetId !== setId || item.removedAt !== null) return undefined;
  const file = await fileRepo.findById(db, item.fileId);
  return file === undefined || file.status !== 'available' ? undefined : { item, file };
}

/** One item as its set's reader sees it: a retried add's answer. */
export async function mediaItem(deps: FilesDeps, ctx: Context, ref: string): Promise<MediaItemView> {
  const [setId, itemId] = ref.split('.') as [string, string];
  const actor = await memberOf(deps, ctx);
  await reachable(deps, actor, setId);
  const found = await inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const live = await liveItem(db, setId, itemId);
    return live === undefined ? undefined : {
      ...live, markings: (await fileMarkingRepo.labelsFor(db, [live.file.id])).map((l) => ({ id: l.id, name: l.name })),
      links: await mediaLinkRepo.listLiveForItems(db, [live.item.id]),
    };
  }, { readOnly: true });
  if (found === undefined) throw itemNotFound();
  return itemViewOf(found.item, found.file.name, found.markings, await satisfiesAll(deps, ctx, found.markings.map((m) => m.id)), found.links);
}

export async function openMediaItem(deps: FilesDeps, ctx: Context, id: string, itemId: string, link: boolean) {
  const actor = await memberOf(deps, ctx);
  await reachable(deps, actor, id);
  const control = deps.databases.pool('control');
  const found = await inTransaction(control, actor.request, async (db) => {
    const live = await liveItem(db, id, itemId);
    return live === undefined ? undefined : { ...live, markings: await fileMarkingRepo.labelsFor(db, [live.file.id]) };
  }, { readOnly: true });
  if (found === undefined) throw itemNotFound();
  const refuse = async (reason: string): Promise<never> => {
    await inTransaction(control, actor.request, (db) => recordEvent(db, actor, ctx.correlationId, {
      event: 'file_download_refused', resource: { type: 'file', id: found.file.id }, subjectMembershipId: found.file.createdBy, detail: { reason, media_set_id: id },
    }));
    throw new AppError('forbidden', 'you cannot open this item', { code: 'files.cannot_open', details: { reason } });
  };
  if (!await satisfiesAll(deps, ctx, found.markings.map((m) => m.id))) return refuse('marking_unsatisfied');
  let opened;
  try {
    opened = await deps.services.call(openMediaUpload, { params: { siloFileId: found.file.siloFileId! }, body: { link } }, call(actor, ctx));
  } catch (error) {
    if (isAppError(error) && (error.category === 'forbidden' || error.category === 'not_found')) return refuse('silo_access');
    throw error;
  }
  await inTransaction(control, actor.request, (db) => recordEvent(db, actor, ctx.correlationId, {
    event: 'file_opened', resource: { type: 'file', id: found.file.id }, subjectMembershipId: found.file.createdBy,
    detail: { bytes: Number(found.item.sizeBytes), link: opened.kind === 'link', media_set_id: id },
  }));
  return opened;
}

export async function removeMediaItem(deps: FilesDeps, ctx: Context, id: string, itemId: string) {
  const actor = await memberOf(deps, ctx);
  const { set } = await reachable(deps, actor, id);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const item = await mediaItemRepo.findById(db, itemId);
    if (item === undefined || item.mediaSetId !== id || item.removedAt !== null) throw itemNotFound();
    if (set.ownerMembershipId !== actor.membershipId && item.addedBy !== actor.membershipId) {
      throw new AppError('forbidden', 'only the set\'s owner, or whoever added it, removes an item', { code: 'files.media_item_not_yours' });
    }
    await mediaItemRepo.update(db, itemId, { removedAt: new Date(deps.now()).toISOString(), removedBy: actor.membershipId });
    await recordEvent(db, actor, ctx.correlationId, { event: 'media_item_removed', resource: { type: 'media_set', id }, subjectMembershipId: item.addedBy, detail: { item_id: itemId, file_id: item.fileId } });
    return { removed: true as const };
  });
}

// ----------------------------------------------------------------------------- sharing (41.3, as a file is shared)

function shareViewOf(row: MediaSetShare) {
  return {
    id: row.id, mediaSetId: row.mediaSetId, granteeMembershipId: row.granteeMembershipId, granteeScopeId: row.granteeScopeId,
    granteeWholeOrganisation: row.granteeWholeOrganisation === true, access: row.access, sharedBy: row.sharedBy, expiresAt: row.expiresAt,
    revokedAt: row.revokedAt, createdAt: row.createdAt,
  };
}

export async function shareMediaSet(deps: FilesDeps, ctx: Context, id: string, input: {
  grantee: { membershipId: string } | { scopeId: string } | { organisation: true }; access: 'view' | 'contribute'; expiresAt?: string | undefined;
}) {
  const actor = await memberOf(deps, ctx);
  await demand(deps, ctx, 'file.share');
  const grantee = input.grantee;
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const set = await owned(db, actor, id);
    if (set.archivedAt !== null) throw new AppError('conflict', 'an archived media set is not shared', { code: 'files.media_set_archived' });
    if ('membershipId' in grantee) {
      if (grantee.membershipId === actor.membershipId) throw new AppError('validation', 'a media set is not shared with its owner', { code: 'files.share_self' });
      if ((await membershipRepo.findById(db, grantee.membershipId))?.status !== 'active') throw new AppError('not_found', 'no such member', { code: 'files.grantee_unknown' });
    }
    if ('scopeId' in grantee && !await scopeRepo.findById(db, grantee.scopeId)) throw new AppError('not_found', 'no such scope', { code: 'files.grantee_unknown' });
    if ('organisation' in grantee && !(await organisationRepo.findById(db, actor.organisationId))?.orgWideSharingPermitted) {
      throw new AppError('forbidden', 'this organisation does not permit sharing with everyone', { code: 'files.org_wide_sharing_off' });
    }
    const live = (await mediaSetShareRepo.listForSet(db, id)).find((s) => s.revokedAt === null
      && ('membershipId' in grantee ? s.granteeMembershipId === grantee.membershipId : 'scopeId' in grantee ? s.granteeScopeId === grantee.scopeId : s.granteeWholeOrganisation === true));
    let row: MediaSetShare;
    try {
      row = live !== undefined
        ? (await mediaSetShareRepo.update(db, live.id, { access: input.access, expiresAt: input.expiresAt ?? null }))!
        : await mediaSetShareRepo.insert(db, {
          id: uuidv7(), organisationId: actor.organisationId, mediaSetId: id, access: input.access, sharedBy: actor.membershipId, expiresAt: input.expiresAt ?? null,
          granteeMembershipId: 'membershipId' in grantee ? grantee.membershipId : null, granteeScopeId: 'scopeId' in grantee ? grantee.scopeId : null,
          granteeWholeOrganisation: 'organisation' in grantee ? true : null,
        });
    } catch (error) {
      throw fromDatabaseError(error);
    }
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'media_set_shared', resource: { type: 'media_set', id }, subjectMembershipId: 'membershipId' in grantee ? grantee.membershipId : null,
      detail: { access: input.access, grantee: 'membershipId' in grantee ? 'membership' : 'scopeId' in grantee ? 'scope' : 'organisation' },
    });
    return shareViewOf(row);
  });
}

export async function revokeMediaSetShare(deps: FilesDeps, ctx: Context, id: string, shareId: string) {
  const actor = await memberOf(deps, ctx);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    await owned(db, actor, id);
    const share = await mediaSetShareRepo.findById(db, shareId);
    if (share === undefined || share.mediaSetId !== id) throw new AppError('not_found', 'no such share', { code: 'files.share_not_found' });
    const updated = share.revokedAt !== null ? share
      : (await mediaSetShareRepo.update(db, shareId, { revokedAt: new Date(deps.now()).toISOString(), revokedBy: actor.membershipId }))!;
    if (share.revokedAt === null) {
      await recordEvent(db, actor, ctx.correlationId, { event: 'media_set_share_revoked', resource: { type: 'media_set', id }, subjectMembershipId: share.granteeMembershipId });
    }
    return shareViewOf(updated);
  });
}

export async function listMediaSetShares(deps: FilesDeps, ctx: Context, id: string) {
  const actor = await memberOf(deps, ctx);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const set = await mediaSetRepo.findById(db, id);
    if (set === undefined || set.ownerMembershipId !== actor.membershipId) throw notFound();
    return { shares: (await mediaSetShareRepo.listForSet(db, id)).map(shareViewOf) };
  }, { readOnly: true });
}
