// The entity graph (spec 23.3, 24.7, 24.8; design: ontology.match_keys, object_redirects):
// which keyed-hashed source records belong to which Silo object. One transaction per batch,
// serialised per type (an advisory lock), so two writers never give one key two objects.
//
// For each record (its source identifier hash and match key hash):
// - its live entry has the same key: it is that entry's object (touched as seen);
// - otherwise the objects holding the key are its object (several of them, which only a
//   race or a newly confirmed rule can leave, are merged into the oldest);
// - its live entry has another key (the record's key changed): the old entry is superseded
//   and a new one added under the object the new key resolves to; if no object holds the
//   new key, the record keeps its object, unless other records still hold that object, in
//   which case it becomes a new object. An object left with no records redirects to where
//   its record went (match_key_remapped, object_merged_redirect);
// - no live entry and no object with the key: a new object, its id derived (UUIDv5) and
//   recorded once.
// A merge moves the losing object's entries to the winner (superseded and re-added, so the
// history stays) and redirects the loser's id to the winner: references never break, and a
// read of the old id answers with the target and says it was redirected. Redirect chains are
// followed to a depth of 8.

import type { Queryable } from '../../infra/postgres.infra.ts';
import type { MatchKey, NewMatchKey } from '../../models/ontology/matchKey.model.ts';
import { matchKeyRepo, objectRedirectRepo } from '../../repos/ontology/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { deriveSiloObjectId } from './identity.service.ts';

export interface GraphRecord {
  connectionId: string;
  sourceObject: string;
  identifierHash: string;
  keyHash: string;
  /**
   * What a new object's id derives from when it is not the key hash: the plain source
   * identifier hash of a record keyed by its source identifier (single-source types,
   * unkeyed records), so every service derives the same id without the organisation key
   * (utils/siloObjectId.util.ts).
   */
  idSeed?: string | undefined;
}

export interface GraphContext {
  organisationId: string;
  objectTypeId: string;
  /** The organisation key the hashes were made under. */
  keyVersionId: string;
  /** Set when a confirmed proposal is being applied: what it places is a confirmed mapping. */
  proposalId?: string | undefined;
  /** always: a complete run marks every row it read; hourly: the answering path. */
  touch: 'always' | 'hourly';
}

export interface GraphStats {
  added: number;
  remapped: number;
  merged: number;
}

export interface Merge {
  from: string;
  to: string;
  redirectId: string;
  moved: string[];
  superseded: string[];
}

export interface GraphOutcome {
  /** Per record, its object (after redirects). */
  objects: string[];
  /** Per record, the merged id it resolved through, if any. */
  redirectedFrom: (string | undefined)[];
  stats: GraphStats;
  merges: Merge[];
}

interface Entry {
  id: string;
  siloObjectId: string;
  connectionId: string;
  sourceObject: string;
  identifierHash: string;
  keyHash: string;
  origin: 'exact' | 'confirmed_mapping';
  resolutionProposalId: string | null;
  /** The organisation key its hashes were made under: a moved entry keeps its own. */
  keyVersionId: string;
  firstSeenAt: number;
  /** Added in this transaction, not yet written. */
  pending: boolean;
}

const MAX_REDIRECT_DEPTH = 8;
const hex = (b: Buffer) => b.toString('hex');
const bytes = (h: string) => Buffer.from(h, 'hex');
const sourceSlot = (e: { connectionId: string; sourceObject: string; identifierHash: string }) =>
  `${e.connectionId}\u0000${e.sourceObject}\u0000${e.identifierHash}`;

const fromRow = (r: MatchKey): Entry => ({
  id: r.id, siloObjectId: r.siloObjectId, connectionId: r.connectionId, sourceObject: r.sourceObject,
  identifierHash: hex(r.sourceIdentifierHash), keyHash: hex(r.matchKeyHash), origin: r.origin, resolutionProposalId: r.resolutionProposalId,
  keyVersionId: r.hmacKeyVersionId, firstSeenAt: Date.parse(r.firstSeenAt), pending: false,
});

/** One batch's view of the graph: what it loaded, what it changed, written at flush. */
export class GraphBatch {
  private readonly entries = new Map<string, Entry>();
  private readonly bySource = new Map<string, string>();
  private readonly byKey = new Map<string, Set<string>>();
  private readonly byObject = new Map<string, Set<string>>();
  private readonly loadedObjects = new Set<string>();
  private readonly superseded = new Set<string>();
  private readonly redirects: { id: string; from: string; to: string; proposalId: string | null }[] = [];
  private readonly redirectCache = new Map<string, string | null>();
  private readonly seen = new Set<string>();
  readonly stats: GraphStats = { added: 0, remapped: 0, merged: 0 };
  readonly merges: Merge[] = [];

  private readonly db: Queryable;
  private readonly ctx: GraphContext;

  constructor(db: Queryable, ctx: GraphContext) {
    this.db = db;
    this.ctx = ctx;
  }

  private index(e: Entry): void {
    this.entries.set(e.id, e);
    this.bySource.set(sourceSlot(e), e.id);
    (this.byKey.get(e.keyHash) ?? this.byKey.set(e.keyHash, new Set()).get(e.keyHash)!).add(e.id);
    (this.byObject.get(e.siloObjectId) ?? this.byObject.set(e.siloObjectId, new Set()).get(e.siloObjectId)!).add(e.id);
  }

  private learn(rows: readonly MatchKey[]): void {
    for (const row of rows) {
      if (!this.entries.has(row.id) && !this.superseded.has(row.id)) this.index(fromRow(row));
    }
  }

  private remove(id: string): Entry {
    const e = this.entries.get(id)!;
    this.entries.delete(id);
    if (this.bySource.get(sourceSlot(e)) === id) this.bySource.delete(sourceSlot(e));
    this.byKey.get(e.keyHash)?.delete(id);
    this.byObject.get(e.siloObjectId)?.delete(id);
    this.seen.delete(id);
    if (!e.pending) this.superseded.add(id);
    return e;
  }

  private add(e: Omit<Entry, 'id' | 'pending'>): Entry {
    const entry: Entry = { ...e, id: uuidv7(), pending: true };
    this.index(entry);
    return entry;
  }

  /** Loads the live entries of these records and keys. Call once per batch before resolving. */
  async load(records: readonly GraphRecord[]): Promise<void> {
    await matchKeyRepo.lockType(this.db, this.ctx.objectTypeId);
    const groups = new Map<string, { connectionId: string; sourceObject: string; hashes: Set<string> }>();
    for (const r of records) {
      const slot = `${r.connectionId}\u0000${r.sourceObject}`;
      const group = groups.get(slot) ?? groups.set(slot, { connectionId: r.connectionId, sourceObject: r.sourceObject, hashes: new Set() }).get(slot)!;
      group.hashes.add(r.identifierHash);
    }
    for (const g of groups.values()) {
      this.learn(await matchKeyRepo.liveBySourceRecords(this.db, this.ctx.objectTypeId, g.connectionId, g.sourceObject, [...g.hashes].map(bytes)));
    }
    this.learn(await matchKeyRepo.liveByKeys(this.db, this.ctx.objectTypeId, [...new Set(records.map((r) => r.keyHash))].map(bytes)));
  }

  /** Every live entry of an object, loading the ones not yet known. */
  private async objectEntries(siloObjectId: string): Promise<Entry[]> {
    if (!this.loadedObjects.has(siloObjectId)) {
      this.learn(await matchKeyRepo.liveByObjects(this.db, this.ctx.objectTypeId, [siloObjectId]));
      this.loadedObjects.add(siloObjectId);
    }
    return [...this.byObject.get(siloObjectId) ?? []].map((id) => this.entries.get(id)!);
  }

  private async age(siloObjectId: string): Promise<number> {
    const entries = await this.objectEntries(siloObjectId);
    return entries.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...entries.map((e) => e.firstSeenAt));
  }

  /** Moves the loser's entries to the winner and redirects the loser's id. */
  async mergeObject(from: string, to: string, proposalId = this.ctx.proposalId): Promise<Merge> {
    if (from === to) throw new AppError('validation', 'an object cannot be merged into itself', { code: 'resolution.merge_self' });
    const moved: string[] = [];
    const superseded: string[] = [];
    for (const e of await this.objectEntries(from)) {
      this.remove(e.id);
      superseded.push(e.id);
      const placed = this.add({
        siloObjectId: to, connectionId: e.connectionId, sourceObject: e.sourceObject, identifierHash: e.identifierHash, keyHash: e.keyHash,
        origin: proposalId === undefined ? e.origin : 'confirmed_mapping', resolutionProposalId: proposalId ?? e.resolutionProposalId,
        keyVersionId: e.keyVersionId, firstSeenAt: e.firstSeenAt,
      });
      this.seen.add(placed.id);
      moved.push(placed.id);
    }
    const redirect = { id: uuidv7(), from, to, proposalId: proposalId ?? null };
    this.redirects.push(redirect);
    this.redirectCache.set(from, to);
    this.stats.merged += 1;
    const merge = { from, to, redirectId: redirect.id, moved, superseded };
    this.merges.push(merge);
    return merge;
  }

  /** Merges objects into the oldest; returns it. */
  private async mergeAll(siloObjectIds: readonly string[]): Promise<string> {
    const ranked = await Promise.all([...new Set(siloObjectIds)].map(async (id) => ({ id, age: await this.age(id) })));
    ranked.sort((a, b) => a.age - b.age || a.id.localeCompare(b.id));
    const [winner, ...losers] = ranked;
    for (const loser of losers) await this.mergeObject(loser.id, winner!.id);
    return winner!.id;
  }

  /**
   * A new object's id: derived from its key, or with a counter when that id belongs to another
   * object. An id is free when nothing ever named it, or when it once held this very key and
   * nothing holds or redirects from it now (the same object coming back).
   */
  private async newObjectId(keyHash: string, idSeed: string | undefined): Promise<string> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = deriveSiloObjectId(this.ctx.organisationId, this.ctx.objectTypeId, [idSeed ?? keyHash], attempt);
      if ((this.byObject.get(id)?.size ?? 0) > 0 || this.redirects.some((r) => r.from === id)) continue;
      const live = await matchKeyRepo.liveByObjects(this.db, this.ctx.objectTypeId, [id]);
      if (live.some((r) => !this.superseded.has(r.id))) continue;
      const history = new Set((await matchKeyRepo.historyOf(this.db, this.ctx.objectTypeId, id)).map(hex));
      if (history.size === 0) return id;
      if (history.has(keyHash) && (await objectRedirectRepo.liveFrom(this.db, [id])).length === 0) return id;
    }
    throw new AppError('integrity', 'no free object id could be derived', { code: 'resolution.id_exhausted' });
  }

  private async follow(siloObjectId: string): Promise<{ target: string; via: string | undefined }> {
    let current = siloObjectId;
    for (let depth = 0; depth < MAX_REDIRECT_DEPTH; depth += 1) {
      let next = this.redirectCache.get(current);
      if (next === undefined) {
        const live = await objectRedirectRepo.liveFrom(this.db, [current]);
        next = live[0]?.toSiloObjectId ?? null;
        this.redirectCache.set(current, next);
      }
      if (next === null) break;
      current = next;
    }
    return { target: current, via: current === siloObjectId ? undefined : siloObjectId };
  }

  /** Resolves one record; its object, after redirects. */
  async resolve(r: GraphRecord): Promise<{ object: string; redirectedFrom: string | undefined }> {
    const liveId = this.bySource.get(sourceSlot(r));
    const live = liveId === undefined ? undefined : this.entries.get(liveId);
    const holdersOf = (except?: string) =>
      [...new Set([...this.byKey.get(r.keyHash) ?? []].filter((id) => id !== except).map((id) => this.entries.get(id)!.siloObjectId))];

    let target: string;
    if (live !== undefined && live.keyHash === r.keyHash) {
      this.seen.add(live.id);
      const holders = holdersOf();
      target = holders.length > 1 ? await this.mergeAll(holders) : live.siloObjectId;
    } else {
      const holders = holdersOf(live?.id);
      let resolved = holders.length === 0 ? undefined : holders.length === 1 ? holders[0]! : await this.mergeAll(holders);
      if (live !== undefined) {
        this.remove(live.id);
        this.stats.remapped += 1;
        const rest = await this.objectEntries(live.siloObjectId);
        if (resolved === undefined) {
          resolved = rest.length > 0 ? await this.newObjectId(r.keyHash, r.idSeed) : live.siloObjectId;
        } else if (rest.length === 0 && resolved !== live.siloObjectId) {
          // The record's old object has no records left: its id now leads to where the record went.
          const redirect = { id: uuidv7(), from: live.siloObjectId, to: resolved, proposalId: this.ctx.proposalId ?? null };
          this.redirects.push(redirect);
          this.redirectCache.set(live.siloObjectId, resolved);
          this.stats.merged += 1;
          this.merges.push({ from: live.siloObjectId, to: resolved, redirectId: redirect.id, moved: [], superseded: [live.id] });
        }
      } else {
        this.stats.added += 1;
        resolved ??= await this.newObjectId(r.keyHash, r.idSeed);
      }
      const placed = this.add({
        siloObjectId: resolved, connectionId: r.connectionId, sourceObject: r.sourceObject, identifierHash: r.identifierHash, keyHash: r.keyHash,
        origin: this.ctx.proposalId === undefined ? 'exact' : 'confirmed_mapping', resolutionProposalId: this.ctx.proposalId ?? null,
        keyVersionId: this.ctx.keyVersionId, firstSeenAt: live?.firstSeenAt ?? Date.now(),
      });
      this.seen.add(placed.id);
      target = resolved;
    }
    const followed = await this.follow(target);
    return { object: followed.target, redirectedFrom: followed.via };
  }

  /** Writes what the batch changed: supersessions first (the live source index), then entries, then redirects. */
  async flush(): Promise<void> {
    await matchKeyRepo.supersede(this.db, [...this.superseded]);
    const rows: NewMatchKey[] = [...this.entries.values()].filter((e) => e.pending).map((e) => ({
      id: e.id, organisationId: this.ctx.organisationId, objectTypeId: this.ctx.objectTypeId, siloObjectId: e.siloObjectId,
      connectionId: e.connectionId, sourceObject: e.sourceObject, sourceIdentifierHash: bytes(e.identifierHash), matchKeyHash: bytes(e.keyHash),
      hmacKeyVersionId: e.keyVersionId, origin: e.origin, resolutionProposalId: e.resolutionProposalId,
    }));
    await matchKeyRepo.insertMany(this.db, rows);
    for (const r of this.redirects) {
      await objectRedirectRepo.insert(this.db, {
        id: r.id, organisationId: this.ctx.organisationId, objectTypeId: this.ctx.objectTypeId, fromSiloObjectId: r.from, toSiloObjectId: r.to,
        resolutionProposalId: r.proposalId,
      });
    }
    await matchKeyRepo.touch(this.db, [...this.seen].filter((id) => !this.entries.get(id)?.pending), this.ctx.touch === 'always');
    for (const e of this.entries.values()) e.pending = false;
    this.superseded.clear();
    this.redirects.length = 0;
  }
}

/** Resolves records into the graph in one transaction's batch. */
export async function resolveIntoGraph(db: Queryable, ctx: GraphContext, records: readonly GraphRecord[]): Promise<GraphOutcome> {
  const batch = new GraphBatch(db, ctx);
  await batch.load(records);
  const objects: string[] = [];
  const redirectedFrom: (string | undefined)[] = [];
  for (const record of records) {
    const resolved = await batch.resolve(record);
    objects.push(resolved.object);
    redirectedFrom.push(resolved.redirectedFrom);
  }
  // A merge later in the batch may have moved an object an earlier record resolved to.
  const movedTo = new Map(batch.merges.map((m) => [m.from, m.to]));
  for (let i = 0; i < objects.length; i += 1) {
    let current = objects[i]!;
    for (let depth = 0; depth < MAX_REDIRECT_DEPTH && movedTo.has(current); depth += 1) current = movedTo.get(current)!;
    if (current !== objects[i]) {
      redirectedFrom[i] ??= objects[i];
      objects[i] = current;
    }
  }
  await batch.flush();
  return { objects, redirectedFrom, stats: batch.stats, merges: batch.merges };
}
