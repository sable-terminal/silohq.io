// Object Index search (spec 69.3, 69.5): the search service's question, answered in the
// reader's own request, on each type's title property.
//
// A type is answered from the index only when all of these hold; otherwise it is named in
// notIndexed and the search service asks its sources:
//   - a live nomination holds the type's title and has completed a refresh;
//   - the reader sees the type, and sees the title in full (never matched otherwise);
//   - the reader's grants reach every connection the entries were read from (the index keeps
//     no per-object source, so it answers only where the sources would have).
// Within a type, an entry matches only when every marking it carries (the object's and the
// title's) is one the reader satisfies: deny wins, and a value a reader may not see is never
// matched, so no hit count reveals it. Every result states its refresh time; none is live.

import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { NOT_INDEXED_REASONS } from '../../contracts/index-builder/index.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { IndexDefinition, Silo } from '../../models/siloes/index.model.ts';
import { indexDefinitionRepo, siloRepo } from '../../repos/siloes/index.repo.ts';
import { searchEntries, INDEX_KEY } from '../warehouse-schema/generator/index.generator.ts';
import { nominatedProperties } from '../warehouse-schema/schema.service.ts';
import { columnFor, existingColumns, readManifest } from '../warehouse-schema/warehouse.service.ts';
import { siloesEnabled } from '../siloes-capture/deps.service.ts';
import { datasetRef, indexTableOf, type Context, type IndexDeps } from './index.service.ts';
import { markingsOf, refreshOptions } from './refresh.service.ts';

type Reason = (typeof NOT_INDEXED_REASONS)[number];

export interface IndexSearch {
  searched: { objectTypeId: string; refreshedAt: string; matches: number; exact: boolean }[];
  notIndexed: { objectTypeId: string; reason: Reason }[];
  results: { objectTypeId: string; objectId: string; title: string | null; refreshedAt: string }[];
}

export async function searchIndex(deps: IndexDeps, ctx: Context, input: { text: string; objectTypeIds: string[]; limit: number }): Promise<IndexSearch> {
  const out: IndexSearch = { searched: [], notIndexed: [], results: [] };
  // Siloes switched off: the index is unreachable, and every type goes to its sources.
  const on = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => siloesEnabled(db, ctx.request.organisationId!), { readOnly: true });
  if (!on) return { ...out, notIndexed: input.objectTypeIds.map((objectTypeId) => ({ objectTypeId, reason: 'not_indexed' as const })) };
  const limit = Math.min(input.limit, deps.maxResults);
  const manifest = await readManifest(deps, ctx);
  const pool = deps.databases.pool('control');

  // The nomination answering each type: the most recently refreshed live one holding its title.
  const candidates = await inTransaction(pool, ctx.request, async (db) => {
    const definitions = await indexDefinitionRepo.liveForTypes(db, input.objectTypeIds);
    const siloes = new Map<string, Silo>();
    const chosen: { typeId: string; definition: IndexDefinition; silo: Silo; title: { apiName: string; identityId: string } }[] = [];
    for (const typeId of new Set(input.objectTypeIds)) {
      const type = manifest.objectTypes.find((t) => t.id === typeId && t.status === 'active');
      const title = type?.properties.find((p) => p.identityId === type.titlePropertyIdentityId);
      const holding = title === undefined ? [] : definitions.filter((d) => d.objectTypeId === typeId && d.nominatedProperties.includes(title.apiName));
      if (title === undefined || holding.length === 0) {
        out.notIndexed.push({ objectTypeId: typeId, reason: 'not_indexed' });
        continue;
      }
      const refreshed = holding.find((d) => d.lastRefreshedAt !== null);
      if (refreshed === undefined) {
        out.notIndexed.push({ objectTypeId: typeId, reason: 'not_refreshed' });
        continue;
      }
      if (!siloes.has(refreshed.siloId)) siloes.set(refreshed.siloId, (await siloRepo.findById(db, refreshed.siloId))!);
      chosen.push({ typeId, definition: refreshed, silo: siloes.get(refreshed.siloId)!, title: { apiName: title.apiName, identityId: title.identityId } });
    }
    return chosen;
  }, { readOnly: true });
  if (candidates.length === 0) return out;

  // Both gates, for this reader, in one decision: types, titles, connections and every
  // marking an entry of these types can carry.
  const universe = await inTransaction(pool, ctx.request, async (db) => {
    const all = new Map<string, { object: string[]; byProperty: Map<string, string[]> }>();
    for (const c of candidates) {
      all.set(c.typeId, await markingsOf(db, c.silo, manifest, c.typeId, nominatedProperties(manifest, c.typeId, [c.title.apiName])));
    }
    return all;
  }, { readOnly: true });
  const connectionsOf = (typeId: string) => [...new Set((manifest.objectTypes.find((t) => t.id === typeId)?.contributingObjects ?? []).map((c) => c.connectionId))];
  const markingIds = [...new Set([...universe.values()].flatMap((m) => [...m.object, ...[...m.byProperty.values()].flat()]))];
  const access = await deps.services.call(resolveAccess, {
    body: {
      objectTypes: candidates.map((c) => c.typeId), properties: candidates.map((c) => c.title.identityId),
      connections: [...new Set(candidates.flatMap((c) => connectionsOf(c.typeId)))].slice(0, 500), markings: markingIds.slice(0, 500),
    },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  const visible = new Set(access.objectTypes.filter((t) => t.visible).map((t) => t.id));
  const titleEffect = new Map(access.properties.map((p) => [p.id, p.visible ? p.effect : 'deny' as const]));
  const reach = new Map(access.connections.map((c) => [c.id, c.access]));
  const satisfied = access.markings.filter((m) => m.satisfied).map((m) => m.id);

  for (const c of candidates) {
    if (access.decision !== 'allow' || !visible.has(c.typeId) || titleEffect.get(c.title.identityId) !== 'allow') {
      out.notIndexed.push({ objectTypeId: c.typeId, reason: 'withheld' });
      continue;
    }
    if (connectionsOf(c.typeId).some((id) => (reach.get(id) ?? 'none') === 'none')) {
      out.notIndexed.push({ objectTypeId: c.typeId, reason: 'no_access' });
      continue;
    }
    const ref = datasetRef(deps, c.silo);
    const table = indexTableOf(c.definition.id);
    const type = nominatedProperties(manifest, c.typeId, [c.title.apiName])[0]!.type;
    const column = columnFor(existingColumns(await deps.bigQuery.getTable({ ...ref, table })), c.title.apiName, type).name;
    const found = await deps.bigQuery.run(ref, searchEntries(ref, table, column, input.text, satisfied, limit + 1), refreshOptions(c.silo, 'index_search'));
    const rows = found.rows.slice(0, limit);
    for (const r of rows) {
      const raw = r['value'];
      let title: string | null = null;
      if (typeof raw === 'string') {
        const parsed = JSON.parse(raw) as unknown;
        title = parsed === null ? null : typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      }
      out.results.push({ objectTypeId: c.typeId, objectId: String(r[INDEX_KEY.name]), title, refreshedAt: String(r['refreshed_at'] ?? c.definition.lastRefreshedAt) });
    }
    out.searched.push({ objectTypeId: c.typeId, refreshedAt: c.definition.lastRefreshedAt!, matches: rows.length, exact: found.rows.length <= limit });
  }
  return out;
}
