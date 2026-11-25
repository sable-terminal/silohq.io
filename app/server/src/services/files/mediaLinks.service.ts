// Media linked to objects (D238). A link holds an object's Silo id (spec 24.7), never a record
// value: a person makes one on the object's page, where that id is known; a set's rule makes them
// from filenames. The rule is a filename template, not a regular expression: one {key}, taking as
// much of the name as lets the rest match, and at most two * (anything, as little as it can), so a
// filename can never make matching slow. The key each name gives is matched against
// the rule's property among the objects of its type that whoever applies the rule may read now,
// through the executor as them, a thousand keys to a plan; at most five objects per key.
//
// An object shows the items linked to it to those who may see their set, as the set's own reader
// would: an item whose markings they lack is listed, not opened.

import { readResultPage, runPlan, type ResultObject } from '../../contracts/executor/result.contract.ts';
import type { LinkRule, MediaItemView } from '../../contracts/files/media.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import { PLAN_SCHEMA_VERSION } from '../../contracts/planner/plan.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { MediaItem, MediaLink, MediaSet } from '../../models/files/index.model.ts';
import { fileMarkingRepo, mediaItemRepo, mediaLinkRepo, mediaSetRepo } from '../../repos/files/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { memberOf, recordEvent, satisfiesAll, type Actor, type Context, type FilesDeps } from './deps.service.ts';
import { heldOn, itemNotFound, itemViewOf, linkViewOf, liveItem, owned, reachable, ruleOf, summaryOf } from './media.service.ts';

/** Keys of these types are matched by equality: a key is text, or a number where the property is one. */
const KEYED_TYPES = new Set(['string', 'enum', 'integer', 'decimal']);
const KEYS_PER_PLAN = 1_000;
const OBJECTS_PER_KEY = 5;
const MAX_ITEMS_APPLIED = 5_000;

/** The template as an anchored expression: literal text escaped, {key} the longest run with no slash, * the shortest run of anything. */
export function templateOf(pattern: string): RegExp {
  const source = pattern.split(/(\{key\}|\*)/).map((part) => (part === '{key}' ? '([^/\\\\]+)' : part === '*' ? '.*?' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${source}$`, 'i');
}

/** The key a filename gives under the template, or none. */
export function keyOf(pattern: RegExp, filename: string): string | undefined {
  const m = pattern.exec(filename);
  const key = m?.[1]?.trim();
  return key === undefined || key === '' ? undefined : key;
}

async function ruleTarget(deps: FilesDeps, ctx: Context, rule: LinkRule) {
  const manifest = await deps.services.call(getManifest, { query: {} }, { request: ctx.request, correlationId: ctx.correlationId });
  const type = manifest.objectTypes.find((t) => t.id === rule.objectTypeId);
  const property = type?.properties.find((p) => p.identityId === rule.propertyId);
  return { versionId: manifest.version.id, type, property };
}

/** A key as the property holds values: a number for a numeric property, else text; none when it cannot be one. */
function valueOf(dataType: string, key: string): string | number | undefined {
  if (dataType === 'integer') return /^-?\d{1,15}$/.test(key) ? Number(key) : undefined;
  if (dataType === 'decimal') return /^-?\d{1,15}(\.\d{1,12})?$/.test(key) ? Number(key) : undefined;
  return key;
}

export async function setMediaLinkRule(deps: FilesDeps, ctx: Context, id: string, rule: LinkRule | null) {
  const actor = await memberOf(deps, ctx);
  if (rule !== null) {
    const { type, property } = await ruleTarget(deps, ctx, rule);
    if (type === undefined || property === undefined) {
      throw new AppError('validation', 'the rule names a type or property the ontology does not have', { code: 'files.link_rule_unknown' });
    }
    if (!KEYED_TYPES.has(property.dataType)) {
      throw new AppError('validation', 'a key is matched against a text, number or choice property', { code: 'files.link_rule_property_type', details: { dataType: property.dataType } });
    }
  }
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const set = await owned(db, actor, id);
    if (set.archivedAt !== null) throw new AppError('conflict', 'an archived media set is not edited', { code: 'files.media_set_archived' });
    const saved = (await mediaSetRepo.update(db, id, {
      linkObjectTypeId: rule?.objectTypeId ?? null, linkPropertyId: rule?.propertyId ?? null, linkPattern: rule?.pattern ?? null, lockVersion: set.lockVersion + 1,
    }))!;
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'media_link_rule_set', resource: { type: 'media_set', id }, detail: { object_type_id: rule?.objectTypeId ?? null, property_id: rule?.propertyId ?? null, cleared: rule === null },
    });
    return summaryOf(db, saved, 'owner');
  });
}

/**
 * Links items by the rule, as the actor: each name's key matched against the property of the
 * objects they may read. Answers with the links made now and how many items gave a key; a read the
 * executor refuses links nothing and says why.
 */
export async function linkByRule(deps: FilesDeps, ctx: Context, actor: Actor, set: MediaSet, rule: LinkRule, items: { item: MediaItem; name: string }[])
  : Promise<{ keyed: number; links: MediaLink[]; refused: string | null }> {
  const template = templateOf(rule.pattern);
  const { versionId, type, property } = await ruleTarget(deps, ctx, rule);
  if (type === undefined || property === undefined) return { keyed: 0, links: [], refused: 'the rule\'s type or property is no longer in the ontology' };
  const keyed = items.flatMap(({ item, name }) => {
    const key = keyOf(template, name);
    const value = key === undefined ? undefined : valueOf(property.dataType, key);
    return value === undefined ? [] : [{ item, value }];
  });
  const objectsFor = new Map<string, string[]>();
  const call = { request: actor.request, correlationId: ctx.correlationId };
  const distinct = [...new Map(keyed.map((k) => [String(k.value), k.value])).values()];
  for (let i = 0; i < distinct.length; i += KEYS_PER_PLAN) {
    const batch = distinct.slice(i, i + KEYS_PER_PLAN);
    let out;
    try {
      out = await deps.services.call(runPlan, {
        body: {
          plan: {
            schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: versionId, hops: [], sort: [],
            nodes: [{ objectTypeId: type.id, filters: [{ property: property.identityId, op: 'in', value: { param: 'p0' } }] }],
            select: [{ node: 0, property: property.identityId }], limit: Math.min(100_000, batch.length * OBJECTS_PER_KEY),
          },
          parameters: { p0: batch }, trigger: 'structured', useCache: false,
        },
      }, { ...call, timeoutMs: 120_000 });
    } catch (error) {
      if (isAppError(error) && (error.category === 'forbidden' || error.category === 'not_found')) return { keyed: keyed.length, links: [], refused: error.message };
      throw error;
    }
    if (out.outcome === 'refusal') return { keyed: keyed.length, links: [], refused: out.refusal.reason };
    const objects: ResultObject[] = [...out.result.page.objects];
    for (let page = 1; page < out.result.page.count; page++) {
      objects.push(...(await deps.services.call(readResultPage, { params: { queryId: out.result.queryId, page } }, call)).objects);
    }
    for (const o of objects) {
      // A value the reader may not see matches nothing.
      if (o.masked.includes(property.apiName) || o.redacted.includes(property.apiName)) continue;
      const v = o.values[property.apiName];
      if (v === null || v === undefined) continue;
      const found = objectsFor.get(String(v)) ?? [];
      if (found.length < OBJECTS_PER_KEY && !found.includes(o.id)) objectsFor.set(String(v), [...found, o.id]);
    }
  }
  const links = await inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const made: MediaLink[] = [];
    for (const { item, value } of keyed) {
      for (const objectId of objectsFor.get(String(value)) ?? []) {
        const link = await mediaLinkRepo.insertOnce(db, {
          id: uuidv7(), organisationId: actor.organisationId, mediaItemId: item.id, objectTypeId: type.id, objectId, madeBy: 'rule', linkedBy: actor.membershipId,
        });
        if (link !== undefined) made.push(link);
      }
    }
    if (made.length > 0 && items.length === 1) {
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'media_item_linked', resource: { type: 'media_set', id: set.id }, detail: { item_id: items[0]!.item.id, made_by: 'rule', objects: made.length },
      });
    }
    return made;
  });
  return { keyed: keyed.length, links, refused: null };
}

export async function applyMediaLinkRule(deps: FilesDeps, ctx: Context, id: string) {
  const actor = await memberOf(deps, ctx);
  const set = await inTransaction(deps.databases.pool('control'), actor.request, (db) => mediaSetRepo.findById(db, id), { readOnly: true });
  if (set === undefined || set.ownerMembershipId !== actor.membershipId) throw new AppError('not_found', 'no such media set', { code: 'files.media_set_not_found' });
  const rule = ruleOf(set);
  if (rule === null) throw new AppError('conflict', 'the media set has no link rule', { code: 'files.link_rule_missing' });
  const items: { item: MediaItem; name: string }[] = [];
  for (let after: string | undefined; items.length < MAX_ITEMS_APPLIED;) {
    const page = await inTransaction(deps.databases.pool('control'), actor.request, (db) => mediaItemRepo.page(db, id, { after, limit: 500 }), { readOnly: true });
    items.push(...page);
    if (page.length < 500) break;
    after = page.at(-1)!.item.id;
  }
  const out = await linkByRule(deps, ctx, actor, set, rule, items);
  await inTransaction(deps.databases.pool('control'), actor.request, (db) => recordEvent(db, actor, ctx.correlationId, {
    event: 'media_links_applied', resource: { type: 'media_set', id }, detail: { items: items.length, keyed: out.keyed, linked: out.links.length, refused: out.refused !== null },
  }));
  return { items: items.length, keyed: out.keyed, linked: out.links.length, refused: out.refused };
}

async function mayLink(deps: FilesDeps, actor: Actor, id: string): Promise<MediaSet> {
  const { set, held } = await reachable(deps, actor, id);
  if (held === 'view') throw new AppError('forbidden', 'this media set is shared with you to view, not to link', { code: 'files.media_set_view_only' });
  if (set.archivedAt !== null) throw new AppError('conflict', 'an archived media set is not changed', { code: 'files.media_set_archived' });
  return set;
}

export async function linkMediaItem(deps: FilesDeps, ctx: Context, id: string, itemId: string, input: { objectTypeId: string; objectId: string }) {
  const actor = await memberOf(deps, ctx);
  await mayLink(deps, actor, id);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const live = await liveItem(db, id, itemId);
    if (live === undefined) throw itemNotFound();
    const made = await mediaLinkRepo.insertOnce(db, {
      id: uuidv7(), organisationId: actor.organisationId, mediaItemId: itemId, objectTypeId: input.objectTypeId, objectId: input.objectId, madeBy: 'person', linkedBy: actor.membershipId,
    });
    const link = made ?? (await mediaLinkRepo.listLiveForItems(db, [itemId])).find((l) => l.objectTypeId === input.objectTypeId && l.objectId === input.objectId)!;
    if (made !== undefined) {
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'media_item_linked', resource: { type: 'media_set', id }, detail: { item_id: itemId, made_by: 'person', objects: 1, object_type_id: input.objectTypeId },
      });
    }
    return linkViewOf(link);
  });
}

export async function unlinkMediaItem(deps: FilesDeps, ctx: Context, id: string, itemId: string, linkId: string) {
  const actor = await memberOf(deps, ctx);
  await mayLink(deps, actor, id);
  return inTransaction(deps.databases.pool('control'), actor.request, async (db) => {
    const link = await mediaLinkRepo.findById(db, linkId);
    if (link === undefined || link.mediaItemId !== itemId || link.removedAt !== null || (await liveItem(db, id, itemId)) === undefined) {
      throw new AppError('not_found', 'no such link', { code: 'files.media_link_not_found' });
    }
    await mediaLinkRepo.update(db, linkId, { removedAt: new Date(deps.now()).toISOString(), removedBy: actor.membershipId });
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'media_item_unlinked', resource: { type: 'media_set', id }, detail: { item_id: itemId, link_id: linkId, made_by: link.madeBy },
    });
    return { removed: true as const };
  });
}

/** The items linked to an object that the caller may see through their sets, each as its set's reader sees it. */
export async function listObjectMedia(deps: FilesDeps, ctx: Context, query: { objectTypeId: string; objectId: string; limit: number })
  : Promise<{ items: (MediaItemView & { mediaSetName: string })[] }> {
  const actor = await memberOf(deps, ctx);
  const control = deps.databases.pool('control');
  const found = await inTransaction(control, actor.request, async (db) => {
    const rows = await mediaLinkRepo.listForObject(db, query.objectTypeId, query.objectId, 500);
    const sets = new Map<string, { set: MediaSet; visible: boolean }>();
    const shown: { item: MediaItem; name: string; setName: string }[] = [];
    for (const row of rows) {
      if (shown.length >= query.limit || shown.some((s) => s.item.id === row.itemId)) continue;
      if (!sets.has(row.mediaSetId)) {
        const set = await mediaSetRepo.findById(db, row.mediaSetId);
        sets.set(row.mediaSetId, { set: set!, visible: set !== undefined && set.archivedAt === null && (await heldOn(db, set, actor)) !== undefined });
      }
      const entry = sets.get(row.mediaSetId)!;
      if (!entry.visible) continue;
      const item = await mediaItemRepo.findById(db, row.itemId);
      if (item !== undefined) shown.push({ item, name: row.fileName, setName: entry.set.name });
    }
    return {
      shown, labels: await fileMarkingRepo.labelsFor(db, shown.map((s) => s.item.fileId)),
      links: await mediaLinkRepo.listLiveForItems(db, shown.map((s) => s.item.id)),
    };
  }, { readOnly: true });
  const held = new Map<string, boolean>();
  for (const markingId of new Set(found.labels.map((l) => l.id))) held.set(markingId, await satisfiesAll(deps, ctx, [markingId]));
  return {
    items: found.shown.map(({ item, name, setName }) => {
      const markings = found.labels.filter((l) => l.fileId === item.fileId).map((l) => ({ id: l.id, name: l.name }));
      return { ...itemViewOf(item, name, markings, markings.every((m) => held.get(m.id) === true), found.links), mediaSetName: setName };
    }),
  };
}
