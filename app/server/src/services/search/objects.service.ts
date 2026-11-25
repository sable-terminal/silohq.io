// Federated object search (spec 24.5, 33.5, 34.1). For each object type the person may see,
// the search term is pushed to each contributing system through the type's title property:
// the source must declare a native contains (or starts-with) filter on the title's field,
// which the pushdown compiler confirms before any source is called. Each source is asked for
// one more match than the bound: more is refused for that source, never truncated.
//
// Never matched for the person: a type their markings withhold (it does not exist for them),
// a title they may not see (masked, redacted or denied), a connection their grants do not
// reach. A source that cannot search is named, with the reason.
//
// Results merge by identity: within a single-source type by the source identifier. A
// resolvable type's results stay per source until resolution's identities are applied
// (mergedByIdentity false), so one object found in two systems appears twice for now.
//
// The Object Index (spec 69.3): a type an Object Index holds with its title is asked of the
// index (index-builder answers in the person's own request, through both gates) instead of
// its sources; a type the index cannot answer for this person is searched federated as
// before. Every group names its route, and every index result its refresh time.

import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import { searchObjectIndex } from '../../contracts/index-builder/index.contract.ts';
import type { StepFilter } from '../../contracts/connect/step.contract.ts';
import type { ObjectTypeView } from '../../contracts/ontology/manifest.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { explainPushdown } from '../../contracts/pushdown-compiler/pushdown.contract.ts';
import type { NOT_SEARCHED_REASONS } from '../../contracts/search/search.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { indexDefinitionRepo } from '../../repos/siloes/index.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { activeManifest, demandView, recordExplorerSearch, type Context, type SearchDeps } from './deps.service.ts';

type Reason = (typeof NOT_SEARCHED_REASONS)[number];
const FIELD = /^[a-z][a-z0-9_]{0,62}$/;
const PARALLEL = 8;

export interface ObjectQuery {
  text: string;
  objectTypeIds?: readonly string[] | undefined;
  perSourceLimit: number;
  surface: 'cmdk' | 'explorer';
}

interface SourceTask {
  type: ObjectTypeView;
  connectionId: string;
  sourceObject: string;
  identifierField: string;
  titleField: string;
}

interface SourceOutcome {
  task: SourceTask;
  rows?: { identifier: string; title: string | null }[];
  reason?: Reason;
}

export interface ObjectSearchResult {
  method: 'federated' | 'index' | 'mixed';
  ontologyVersionId: string;
  results: {
    objectTypeId: string; identifier: string; title: string | null; sources: { connectionId: string; sourceObject: string }[]; refreshedAt: string | null;
  }[];
  groups: {
    objectTypeId: string; count: number; exact: boolean; mergedByIdentity: boolean; route: 'federated' | 'index'; refreshedAt: string | null;
  }[];
  searched: { objectTypeId: string; connectionId: string; sourceObject: string; matches: number }[];
  notSearched: { objectTypeId: string; connectionId: string | null; sourceObject: string | null; reason: Reason }[];
}

async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(work)));
  return out;
}

export async function searchObjects(deps: SearchDeps, ctx: Context, q: ObjectQuery): Promise<ObjectSearchResult> {
  await demandView(deps, ctx);
  const manifest = await activeManifest(deps, ctx);
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const scope = q.objectTypeIds === undefined ? undefined : new Set(q.objectTypeIds);
  const candidates = manifest.objectTypes.filter((t) => t.status === 'active' && (scope === undefined || scope.has(t.id))).slice(0, 50);
  const titleOf = (t: ObjectTypeView) => t.properties.find((p) => p.identityId === t.titlePropertyIdentityId);
  // Properties are named to policy by identity, as everywhere (design D35, D36).
  const titleRow = (t: ObjectTypeView): string | undefined => t.titlePropertyIdentityId ?? undefined;
  const mappings = candidates.flatMap((t) => (titleOf(t)?.mappings ?? []).map((m) => ({ type: t, mapping: m })));

  const access = await deps.services.call(resolveAccess, {
    body: {
      objectTypes: candidates.map((t) => t.id),
      properties: candidates.map(titleRow).filter((id): id is string => id !== undefined),
      connections: [...new Set(mappings.map((m) => m.mapping.connectionId))].slice(0, 500),
      fields: mappings.map((m) => ({ connectionId: m.mapping.connectionId, path: m.mapping.fieldPath })).slice(0, 2000),
    },
  }, options);
  const visibleType = new Set(access.objectTypes.filter((t) => t.visible).map((t) => t.id));
  const titleEffect = new Map(access.properties.map((p) => [p.id, p.visible ? p.effect : 'deny' as const]));
  const reach = new Map(access.connections.map((c) => [c.id, c.access]));
  const fieldEffect = new Map(access.fields.map((f) => [`${f.connectionId}:${f.path}`, f.effect]));

  // The types an Object Index can answer for this person, asked of the index first.
  const indexed = await fromIndex(deps, ctx, q, candidates.filter((t) => visibleType.has(t.id)).map((t) => t.id));
  const indexedTypes = new Map(indexed.searched.map((s) => [s.objectTypeId, s]));

  const notSearched: ObjectSearchResult['notSearched'] = [];
  const tasks: SourceTask[] = [];
  const searchedTypes: ObjectTypeView[] = [];
  for (const t of candidates) {
    if (!visibleType.has(t.id)) continue;
    searchedTypes.push(t);
    if (indexedTypes.has(t.id)) continue;
    const title = titleOf(t);
    const row = titleRow(t);
    if (title === undefined || row === undefined || titleEffect.get(row) !== 'allow') {
      notSearched.push({ objectTypeId: t.id, connectionId: null, sourceObject: null, reason: 'withheld' });
      continue;
    }
    for (const m of title.mappings) {
      const source = { objectTypeId: t.id, connectionId: m.connectionId, sourceObject: m.sourceObject };
      const contributing = t.contributingObjects.find((c) => c.connectionId === m.connectionId && c.sourceObject === m.sourceObject);
      if ((reach.get(m.connectionId) ?? 'none') === 'none') notSearched.push({ ...source, reason: 'no_access' });
      else if (fieldEffect.get(`${m.connectionId}:${m.fieldPath}`) !== 'allow') notSearched.push({ ...source, reason: 'withheld' });
      else if (contributing === undefined || !FIELD.test(m.fieldPath) || !FIELD.test(contributing.identifierFieldPath)) {
        notSearched.push({ ...source, reason: 'not_mappable' });
      } else {
        tasks.push({ type: t, connectionId: m.connectionId, sourceObject: m.sourceObject, identifierField: contributing.identifierFieldPath,
          titleField: m.fieldPath });
      }
    }
  }

  const outcomes = await inBatches(tasks, PARALLEL, async (task): Promise<SourceOutcome> => {
    try {
      // The first operator the source declares natively on the title's field.
      let filter: StepFilter | undefined;
      for (const op of ['contains', 'starts_with'] as const) {
        const candidate: StepFilter = { field: task.titleField, op, value: q.text };
        const step = { object: task.sourceObject, fields: [task.identifierField, task.titleField], filters: [candidate], sort: [],
          limit: q.perSourceLimit + 1 };
        const explained = await deps.services.call(explainPushdown, { body: { connectionId: task.connectionId, step } }, options);
        if (explained.split.residual.filters.length === 0) {
          filter = candidate;
          break;
        }
      }
      if (filter === undefined) return { task, reason: 'no_search_capability' };
      const read = await deps.services.call(readObject, {
        body: {
          connectionId: task.connectionId, reason: 'query',
          step: { object: task.sourceObject, fields: [...new Set([task.identifierField, task.titleField])], filters: [filter], sort: [],
            limit: q.perSourceLimit + 1 },
        },
      }, options);
      if (read.rows.length > q.perSourceLimit) return { task, reason: 'over_bound' };
      return {
        task,
        rows: read.rows.map((r) => {
          const title = r[task.titleField];
          return { identifier: String(r[task.identifierField] ?? ''), title: typeof title === 'string' ? title : title == null ? null : String(title) };
        }).filter((r) => r.identifier.length > 0),
      };
    } catch (error) {
      deps.logger.failure('a source did not answer a search', error, {
        event: 'search.source_failed', connectionId: task.connectionId, objectTypeId: task.type.id,
      });
      return { task, reason: isAppError(error) && error.category === 'bounds' ? 'over_bound' : 'source_unreachable' };
    }
  });

  const results: ObjectSearchResult['results'] = indexed.results.map((r) => ({
    objectTypeId: r.objectTypeId, identifier: r.objectId, title: r.title, sources: [], refreshedAt: r.refreshedAt,
  }));
  const searched: ObjectSearchResult['searched'] = [];
  const merged = new Map<string, ObjectSearchResult['results'][number]>();
  for (const o of outcomes) {
    const source = { connectionId: o.task.connectionId, sourceObject: o.task.sourceObject };
    if (o.rows === undefined) {
      notSearched.push({ objectTypeId: o.task.type.id, ...source, reason: o.reason! });
      continue;
    }
    searched.push({ objectTypeId: o.task.type.id, ...source, matches: o.rows.length });
    const single = o.task.type.resolutionClass === 'single_source';
    for (const r of o.rows) {
      const key = single ? `${o.task.type.id}\u0000${r.identifier}` : `${o.task.type.id}\u0000${o.task.connectionId}\u0000${o.task.sourceObject}\u0000${r.identifier}`;
      const known = merged.get(key);
      if (known === undefined) {
        const result = { objectTypeId: o.task.type.id, identifier: r.identifier, title: r.title, sources: [source], refreshedAt: null };
        merged.set(key, result);
        results.push(result);
      } else if (!known.sources.some((s) => s.connectionId === source.connectionId && s.sourceObject === source.sourceObject)) {
        known.sources.push(source);
      }
    }
  }
  const groups = searchedTypes.map((t) => {
    const fromIndex = indexedTypes.get(t.id);
    return {
      objectTypeId: t.id,
      count: results.filter((r) => r.objectTypeId === t.id).length,
      exact: fromIndex !== undefined ? fromIndex.exact : !notSearched.some((n) => n.objectTypeId === t.id),
      // An index entry is one Silo object: merged across its sources already.
      mergedByIdentity: fromIndex !== undefined || t.resolutionClass === 'single_source',
      route: fromIndex !== undefined ? 'index' as const : 'federated' as const,
      refreshedAt: fromIndex?.refreshedAt ?? null,
    };
  });
  const routes = new Set(groups.map((g) => g.route));
  const method = routes.size > 1 ? 'mixed' as const : routes.has('index') ? 'index' as const : 'federated' as const;
  if (q.surface === 'explorer') {
    await recordExplorerSearch(deps, ctx, { method, types: searchedTypes.length, results: results.length, not_searched: notSearched.length });
  }
  return { method, ontologyVersionId: manifest.version.id, results, groups, searched, notSearched };
}

/**
 * The index's answer for the types it holds, or nothing: a type no live nomination holds is
 * never asked of it, and an index that cannot answer leaves every type to its sources.
 */
async function fromIndex(deps: SearchDeps, ctx: Context, q: ObjectQuery, typeIds: string[]): Promise<{
  searched: { objectTypeId: string; refreshedAt: string; exact: boolean }[];
  results: { objectTypeId: string; objectId: string; title: string | null; refreshedAt: string }[];
}> {
  const none = { searched: [], results: [] };
  if (typeIds.length === 0) return none;
  const held = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => indexDefinitionRepo.liveForTypes(db, typeIds), { readOnly: true });
  const ids = [...new Set(held.map((d) => d.objectTypeId))];
  if (ids.length === 0) return none;
  try {
    return await deps.services.call(searchObjectIndex, { body: { text: q.text, objectTypeIds: ids, limit: q.perSourceLimit } },
      { request: ctx.request, correlationId: ctx.correlationId });
  } catch (error) {
    deps.logger.failure('the Object Index did not answer a search; its types are searched at their sources', error, { event: 'search.index_failed' });
    return none;
  }
}
