// Results in the data plane (spec 8.5, 24.6, 27.4): redis-data, persistence disabled, a TTL.
//
// - A result is a header (columns, coverage, lineage, periods: no values) and pages of
//   objects or groups (values), each kept 15 minutes and re-armed on every page read.
// - Only the actor whose result it is reads its pages.
// - The cache maps a plan hash, the ontology version, the period resolution and the
//   permission fingerprint to a complete result (spec 24.6), for 5 minutes: the same plan,
//   for the same permissions, against the same definition and the same period. A hit is
//   never metered. A hit needs the result's keys to still exist, else it is a miss.
// - Change epochs (spec 24.6): the hash of the epochs of every source object a plan reads is
//   taken before the run and kept with the cache entry; a hit whose epochs have moved since
//   (change-stream bumped one) is a miss, so a cached result never outlives a change.
// - Concurrency: plans running per organisation are leases in a sorted set, as the model
//   gateway's, so a replica that dies frees its slot when the lease ends.

import type { QueryResult, ResultGroup, ResultObject } from '../../contracts/executor/result.contract.ts';
import {
  executorSlotKeys, readChangeEpochs, resultCacheKeys, resultHeadKeys, resultMetaKeys, resultPageKeys, type SourceObjectRef,
} from '../../infra/keyspaces.infra.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';

/** Under the page keyspace's 1 MiB: the encoded page stays below it. */
const PAGE_BYTES = 768 * 1024;
const PAGE_ITEMS = 500;

export type Header = Omit<QueryResult, 'page' | 'cached'> & { pageCount: number };
type Item = ResultObject | ResultGroup;

export interface CacheParts {
  planHash: string;
  ontologyVersion: string;
  periodResolution: string;
  permissionFingerprint: string;
  /** The hash of the read source objects' change epochs before the run. */
  epochs: string;
}

function paginate(items: readonly Item[]): Item[][] {
  const pages: Item[][] = [];
  let page: Item[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (page.length > 0 && (page.length >= PAGE_ITEMS || bytes + size > PAGE_BYTES)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(item);
    bytes += size;
  }
  pages.push(page);
  return pages;
}

export const pageOf = (kind: QueryResult['kind'], index: number, count: number, items: Item[]): QueryResult['page'] => ({
  index, count, objects: kind === 'objects' ? items as ResultObject[] : [], groups: kind === 'groups' ? items as ResultGroup[] : [],
});

export function createResults(store: RedisStore) {
  const cacheKey = (organisationId: string, parts: CacheParts) => resultCacheKeys.key(organisationId, parts);

  return {
    /** Keeps a complete result; returns it as the caller receives it, the first page inline. */
    async keep(request: RequestContext, header: Omit<Header, 'pageCount'>, items: readonly Item[], cache: CacheParts | undefined): Promise<QueryResult> {
      const organisationId = request.organisationId!;
      const pages = paginate(items);
      const full: Header = { ...header, pageCount: pages.length };
      const { queryId } = header;
      for (const [index, page] of pages.entries()) {
        await store.put(resultPageKeys, resultPageKeys.key(organisationId, { queryId, page: index }), page);
      }
      await store.put(resultHeadKeys, resultHeadKeys.key(organisationId, { queryId }), full as unknown as Record<string, unknown>);
      await store.putHash(resultMetaKeys, resultMetaKeys.key(organisationId, { queryId }), {
        planHash: header.planHash, permissionFingerprint: cache?.permissionFingerprint ?? header.planHash,
        ...(request.membershipId === undefined ? {} : { membershipId: request.membershipId }),
        ...(request.servicePrincipalId === undefined ? {} : { servicePrincipalId: request.servicePrincipalId }),
        status: 'complete', pageCount: pages.length, rowCount: items.length, createdAt: header.computedAt,
      });
      if (cache !== undefined) await store.put(resultCacheKeys, cacheKey(organisationId, cache), { queryId, computedAt: header.computedAt, epochs: cache.epochs });
      return { ...header, cached: false, page: pageOf(header.kind, 0, pages.length, pages[0]!) };
    },

    async cached(request: RequestContext, parts: CacheParts): Promise<QueryResult | undefined> {
      const organisationId = request.organisationId!;
      const entry = await store.read(resultCacheKeys, cacheKey(organisationId, parts));
      if (entry === undefined || entry.epochs !== parts.epochs) return undefined;
      const read = await this.page(request, entry.queryId, 0);
      if (read === undefined) return undefined;
      const { pageCount: _count, ...header } = read.header;
      return { ...header, cached: true, page: pageOf(header.kind, 0, read.header.pageCount, read.items) };
    },

    /** A page of a result, for its own actor; re-arms the result's keys. Undefined when gone. */
    async page(request: RequestContext, queryId: string, index: number): Promise<{ header: Header; items: Item[] } | undefined> {
      const organisationId = request.organisationId!;
      const metaKey = resultMetaKeys.key(organisationId, { queryId });
      const meta = await store.readHash(resultMetaKeys, metaKey);
      if (meta === undefined || meta.status !== 'complete') return undefined;
      const mine = meta.membershipId !== undefined ? meta.membershipId === request.membershipId
        : meta.servicePrincipalId !== undefined && meta.servicePrincipalId === request.servicePrincipalId;
      if (!mine || index >= meta.pageCount) return undefined;
      const headKey = resultHeadKeys.key(organisationId, { queryId });
      const pageKey = resultPageKeys.key(organisationId, { queryId, page: index });
      const [header, items] = await Promise.all([store.read(resultHeadKeys, headKey), store.read(resultPageKeys, pageKey)]);
      if (header === undefined || items === undefined) return undefined;
      await Promise.all([store.touch(resultMetaKeys, metaKey), store.touch(resultHeadKeys, headKey), store.touch(resultPageKeys, pageKey)]);
      return { header: header as unknown as Header, items: items as Item[] };
    },

    /** The hash of the change epochs of these source objects now, in a stable order. */
    async epochs(organisationId: string, refs: readonly SourceObjectRef[]): Promise<string> {
      const unique = [...new Map(refs.map((r) => [`${r.connectionId}\u0000${r.sourceObject}`, r])).entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      const counts = await readChangeEpochs(store, organisationId, unique.map(([, r]) => r));
      return sha256(canonicalJsonBytes(unique.map(([k], i) => [k, counts[i]]))).toString('hex');
    },

    /** A lease on one of the organisation's concurrent plans, or undefined when they are all taken. */
    async slot(organisationId: string, queryId: string, limit: number, leaseMs: number): Promise<{ release(): Promise<void> } | undefined> {
      const key = executorSlotKeys.key(organisationId);
      const now = Date.now();
      await store.removeScoredUpTo(executorSlotKeys, key, now);
      await store.addScored(executorSlotKeys, key, [{ member: queryId, score: now + leaseMs }]);
      const give = async () => {
        await store.addScored(executorSlotKeys, key, [{ member: queryId, score: 0 }]);
        await store.removeScoredUpTo(executorSlotKeys, key, 0);
      };
      if (await store.countScored(executorSlotKeys, key, now, Number.POSITIVE_INFINITY) > limit) {
        await give();
        return undefined;
      }
      return { release: give };
    },
  };
}

export type Results = ReturnType<typeof createResults>;
