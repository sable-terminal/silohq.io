// Resolution proposals (spec 23.2, 24.8): put to a person, decided by a person.
//
// - Deciding needs resolution.confirm on the type and read access to every connection
//   involved ("data owners for both connections involved"), and is never the proposer's.
// - A confirmed normalisation_rule becomes a step of the type's key, after its declared
//   normalisation and the rules confirmed before it, and a run re-keys the type under it.
// - A confirmed pair_list merges each `from` object into its `to` in one transaction: the
//   entries move as confirmed mappings naming the proposal, the old id redirects, and what
//   moved is kept on the proposal for a later split.
// - A confirmed split undoes one such merge: the moved entries are superseded, the original
//   entries restored under the old id, and the redirect undone. The prior state stays in the
//   graph's history (spec 23.3).
// - The preview reads the type's sources live as the reviewer and shows the pairs a rule
//   would make, or the records of the objects a pair list names. Nothing it reads is kept.

import { previewResolutionProposal, type ProposalBody, type ResolutionProposalView } from '../../contracts/resolution/proposal.contract.ts';
import type { CallOutput } from '../../contracts/endpoint.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { ResolutionProposal } from '../../models/ontology/resolutionProposal.model.ts';
import { matchKeyRepo, objectRedirectRepo, resolutionProposalRepo } from '../../repos/ontology/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { judgeRule, type AnalysisRecord } from './analysis.service.ts';
import {
  acting, activeManifest, demand, demandReadAll, hashAll, person, planFor, recordEvent, typeIn, type Context, type ResolutionDeps,
} from './deps.service.ts';
import { GraphBatch } from './graph.service.ts';
import { compositeKey, normalisedComponents } from './identity.service.ts';
import type { Runs } from './runs.service.ts';
import { readContributing, type SourceRecord } from './sources.service.ts';

export const proposalView = (p: ResolutionProposal): ResolutionProposalView => ({
  id: p.id, objectTypeId: p.objectTypeId, kind: p.kind, proposal: p.proposal as ProposalBody, affectedCount: p.affectedCount,
  proposedByMembershipId: p.proposedByMembershipId, proposedByServicePrincipalId: p.proposedByServicePrincipalId, status: p.status,
  decidedBy: p.decidedBy, decidedAt: p.decidedAt, createdAt: p.createdAt,
});

type PreviewOutput = CallOutput<typeof previewResolutionProposal>;

export interface Proposals {
  list(ctx: Context, filter: { status?: 'open' | 'confirmed' | 'rejected' | undefined; objectTypeId?: string | undefined; limit: number }): Promise<ResolutionProposalView[]>;
  get(ctx: Context, id: string): Promise<ResolutionProposalView>;
  preview(ctx: Context, id: string, limit: number): Promise<PreviewOutput>;
  proposePairs(ctx: Context, objectTypeId: string, pairs: readonly { from: string; to: string }[]): Promise<ResolutionProposalView>;
  proposeSplit(ctx: Context, redirectId: string): Promise<ResolutionProposalView>;
  confirm(ctx: Context, id: string): Promise<ResolutionProposalView & { runId: string | null }>;
  reject(ctx: Context, id: string): Promise<ResolutionProposalView>;
}

export function createProposals(deps: ResolutionDeps, runs: Runs): Proposals {
  const pool = deps.databases.pool('control');
  const read = <T>(ctx: Context, work: Parameters<typeof inTransaction<T>>[2]) =>
    inTransaction(pool, { organisationId: ctx.request.organisationId! }, work, { readOnly: true });

  async function load(ctx: Context, id: string): Promise<ResolutionProposal> {
    const found = await read(ctx, (db) => resolutionProposalRepo.findById(db, id));
    if (!found) throw new AppError('not_found', 'no such resolution proposal', { code: 'resolution.proposal_not_found' });
    return found;
  }

  /** The connections a proposal touches: every contributing connection for a rule; the objects' own for pairs and splits. */
  async function connectionsOf(ctx: Context, p: ResolutionProposal): Promise<string[]> {
    const body = p.proposal as ProposalBody;
    if (body.kind === 'normalisation_rule') {
      return typeIn(await activeManifest(deps, ctx), p.objectTypeId).contributingObjects.map((co) => co.connectionId);
    }
    const objects = body.kind === 'pair_list' ? body.pairs.flatMap((pair) => [pair.from, pair.to]) : await read(ctx, async (db) => {
      const redirect = await objectRedirectRepo.findById(db, body.redirectId);
      return redirect ? [redirect.fromSiloObjectId, redirect.toSiloObjectId] : [];
    });
    const entries = await read(ctx, (db) => matchKeyRepo.liveByObjects(db, p.objectTypeId, objects));
    return [...new Set(entries.map((e) => e.connectionId))];
  }

  /** Records of the type read live as this person, keyed as today. */
  async function liveRecords(ctx: Context, objectTypeId: string) {
    const type = typeIn(await activeManifest(deps, ctx), objectTypeId);
    await demandReadAll(deps, ctx, type.contributingObjects.map((co) => co.connectionId));
    const { plan } = await planFor(deps, ctx.request.organisationId!, type);
    const records: (SourceRecord & { components: string[] | undefined })[] = [];
    for (let s = 0; s < type.contributingObjects.length; s += 1) {
      const out = await readContributing(deps, ctx, type, s);
      if (out.note?.startsWith('read_failed')) {
        throw new AppError('unavailable', 'a source could not be read for the preview', { code: 'resolution.preview_unreadable', retryable: true });
      }
      for (const r of out.records) records.push({ ...r, components: normalisedComponents(plan, r.values) });
    }
    return { type, records };
  }

  return {
    async list(ctx, filter) {
      return (await read(ctx, (db) => resolutionProposalRepo.list(db, filter))).map(proposalView);
    },

    async get(ctx, id) {
      return proposalView(await load(ctx, id));
    },

    async preview(ctx, id, limit) {
      const p = await load(ctx, id);
      const body = p.proposal as ProposalBody;
      const { type, records } = await liveRecords(ctx, p.objectTypeId);
      const side = (r: SourceRecord & { components: string[] | undefined }) => ({
        connectionId: type.contributingObjects[r.source]!.connectionId, sourceObject: type.contributingObjects[r.source]!.sourceObject,
        identifier: r.identifier, key: (r.components ?? []).join(' | '),
      });
      if (body.kind === 'normalisation_rule') {
        const keyed = records.filter((r) => r.components !== undefined);
        const analysis: AnalysisRecord[] = keyed.map((r) => ({ source: r.source, components: r.components!, object: compositeKey(r.components!) }));
        const judgement = judgeRule(analysis, body.cel);
        const groups = judgement?.groups ?? [];
        return {
          total: groups.length,
          pairs: groups.slice(0, limit).map((g) => {
            const sides = g.map((i) => side(keyed[i]!));
            return { key: sides[0]?.key ?? '', sides };
          }),
        };
      }
      // Pair lists and splits: the records of the objects named, found through the graph by their hashed identifiers.
      const objects = body.kind === 'pair_list' ? body.pairs.flatMap((pair) => [pair.from, pair.to]) : await read(ctx, async (db) => {
        const redirect = await objectRedirectRepo.findById(db, body.redirectId);
        return redirect ? [redirect.fromSiloObjectId, redirect.toSiloObjectId] : [];
      });
      const ids = await hashAll(deps, ctx, 'source_identifier', records.map((r) => r.identifier));
      const live = await read(ctx, (db) => matchKeyRepo.liveByObjects(db, p.objectTypeId, objects));
      const slot = (c: string, o: string, h: string) => `${c}\u0000${o}\u0000${h}`;
      const objectOf = new Map(live.map((e) => [slot(e.connectionId, e.sourceObject, e.sourceIdentifierHash.toString('hex')), e.siloObjectId]));
      const groups = new Map<string, ReturnType<typeof side>[]>();
      records.forEach((r, i) => {
        const co = type.contributingObjects[r.source]!;
        const object = objectOf.get(slot(co.connectionId, co.sourceObject, ids.hashes[i]!));
        if (object !== undefined) groups.set(object, [...groups.get(object) ?? [], side(r)]);
      });
      const pairs = body.kind === 'pair_list'
        ? body.pairs.map((pair) => ({ key: '', sides: [...groups.get(pair.from) ?? [], ...groups.get(pair.to) ?? []] }))
        : [{ key: '', sides: objects.flatMap((o) => groups.get(o) ?? []) }];
      return { total: pairs.length, pairs: pairs.slice(0, limit) };
    },

    async proposePairs(ctx, objectTypeId, pairs) {
      const actor = acting(ctx);
      await demand(deps, ctx, 'ontology.propose', objectTypeId);
      typeIn(await activeManifest(deps, ctx), objectTypeId);
      const froms = new Set<string>();
      for (const pair of pairs) {
        if (pair.from === pair.to) throw new AppError('validation', 'an object cannot be paired with itself', { code: 'resolution.merge_self' });
        if (froms.has(pair.from)) throw new AppError('validation', 'an object is merged into one target', { code: 'resolution.pair_repeated' });
        froms.add(pair.from);
      }
      return inTransaction(pool, { organisationId: actor.organisationId }, async (db) => {
        const named = [...new Set(pairs.flatMap((pair) => [pair.from, pair.to]))];
        const held = new Set((await matchKeyRepo.liveByObjects(db, objectTypeId, named)).map((e) => e.siloObjectId));
        if (named.some((id) => !held.has(id))) {
          throw new AppError('validation', 'every object named must be a live object of the type', { code: 'resolution.object_unknown' });
        }
        const id = uuidv7();
        const row = await resolutionProposalRepo.insert(db, {
          id, organisationId: actor.organisationId, objectTypeId, kind: 'pair_list', proposal: { kind: 'pair_list', pairs: [...pairs] },
          affectedCount: pairs.length, proposedByMembershipId: actor.membershipId ?? null, proposedByServicePrincipalId: actor.servicePrincipalId ?? null,
        });
        await recordEvent(db, actor, ctx.correlationId, {
          event: 'resolution_proposed', resource: { type: 'resolution_proposal', id }, detail: { object_type_id: objectTypeId, kind: 'pair_list', affected: pairs.length },
        });
        return proposalView(row);
      });
    },

    async proposeSplit(ctx, redirectId) {
      const actor = acting(ctx);
      const redirect = await read(ctx, (db) => objectRedirectRepo.findById(db, redirectId));
      if (!redirect || redirect.undoneAt !== null) throw new AppError('not_found', 'no live redirect with that id', { code: 'resolution.redirect_not_found' });
      await demand(deps, ctx, 'ontology.propose', redirect.objectTypeId);
      const source = redirect.resolutionProposalId === null ? undefined : await read(ctx, (db) => resolutionProposalRepo.findById(db, redirect.resolutionProposalId!));
      // Only a merge a person confirmed as a pair list can be split: an exact merge or a rule's would re-form at once.
      if (source?.kind !== 'pair_list' || source.status !== 'confirmed') {
        throw new AppError('conflict', 'only a merge confirmed from a pair list can be split; revoke a rule instead', { code: 'resolution.split_unsupported' });
      }
      return inTransaction(pool, { organisationId: actor.organisationId }, async (db) => {
        const id = uuidv7();
        const row = await resolutionProposalRepo.insert(db, {
          id, organisationId: actor.organisationId, objectTypeId: redirect.objectTypeId, kind: 'split', proposal: { kind: 'split', redirectId },
          affectedCount: 1, proposedByMembershipId: actor.membershipId ?? null, proposedByServicePrincipalId: actor.servicePrincipalId ?? null,
        });
        await recordEvent(db, actor, ctx.correlationId, {
          event: 'resolution_proposed', resource: { type: 'resolution_proposal', id }, detail: { object_type_id: redirect.objectTypeId, kind: 'split', affected: 1 },
        });
        return proposalView(row);
      });
    },

    async confirm(ctx, id) {
      const actor = person(ctx, 'confirming a resolution');
      const p = await load(ctx, id);
      if (p.status !== 'open') throw new AppError('conflict', 'the proposal is already decided', { code: 'resolution.proposal_decided' });
      if (p.proposedByMembershipId === actor.membershipId) {
        throw new AppError('forbidden', 'a proposal is confirmed by someone other than its proposer', { code: 'resolution.self_confirm' });
      }
      await demand(deps, ctx, 'resolution.confirm', p.objectTypeId);
      await demandReadAll(deps, ctx, await connectionsOf(ctx, p));
      const body = p.proposal as ProposalBody;

      const decided = await inTransaction(pool, { organisationId: actor.organisationId }, async (db) => {
        let proposal: ProposalBody = body;
        if (body.kind === 'pair_list') {
          // Moved rows keep their hashes and the key version each was made under; nothing new is hashed here.
          const batch = new GraphBatch(db, {
            organisationId: actor.organisationId, objectTypeId: p.objectTypeId, keyVersionId: '', proposalId: p.id, touch: 'hourly',
          });
          await matchKeyRepo.lockType(db, p.objectTypeId);
          const merged = [];
          for (const pair of body.pairs) merged.push(await batch.mergeObject(pair.from, pair.to, p.id));
          await batch.flush();
          proposal = { ...body, merged };
          await recordEvent(db, actor, ctx.correlationId, {
            event: 'object_merged_redirect', resource: { type: 'object_type', id: p.objectTypeId }, detail: { objects: merged.length, proposal_id: p.id },
          });
        } else if (body.kind === 'split') {
          const redirect = await objectRedirectRepo.undo(db, body.redirectId);
          if (!redirect) throw new AppError('conflict', 'that redirect was already undone', { code: 'resolution.redirect_not_found' });
          const source = redirect.resolutionProposalId === null ? undefined : await resolutionProposalRepo.findById(db, redirect.resolutionProposalId);
          const record = (source?.proposal as ProposalBody | undefined)?.kind === 'pair_list'
            ? (source!.proposal as Extract<ProposalBody, { kind: 'pair_list' }>).merged?.find((m) => m.redirectId === body.redirectId) : undefined;
          if (record === undefined) throw new AppError('integrity', 'the merge this split undoes left no record', { code: 'resolution.split_record_missing' });
          await matchKeyRepo.lockType(db, redirect.objectTypeId);
          await matchKeyRepo.supersede(db, record.moved);
          const originals = await matchKeyRepo.findMany(db, record.superseded);
          await matchKeyRepo.insertMany(db, originals.map((o) => ({
            id: uuidv7(), organisationId: o.organisationId, objectTypeId: o.objectTypeId, siloObjectId: redirect.fromSiloObjectId,
            connectionId: o.connectionId, sourceObject: o.sourceObject, sourceIdentifierHash: o.sourceIdentifierHash, matchKeyHash: o.matchKeyHash,
            hmacKeyVersionId: o.hmacKeyVersionId, origin: o.origin, resolutionProposalId: o.resolutionProposalId,
          })));
          await recordEvent(db, actor, ctx.correlationId, {
            event: 'object_split', resource: { type: 'object_type', id: redirect.objectTypeId },
            detail: { proposal_id: p.id, restored: originals.length, redirect_id: redirect.id },
          });
        }
        if (proposal !== body) await resolutionProposalRepo.update(db, p.id, { proposal: JSON.parse(JSON.stringify(proposal)) as ResolutionProposal['proposal'] });
        const row = await resolutionProposalRepo.decide(db, p.id, 'confirmed', actor.membershipId);
        if (!row) throw new AppError('conflict', 'the proposal is already decided', { code: 'resolution.proposal_decided' });
        await recordEvent(db, actor, ctx.correlationId, {
          event: 'resolution_confirmed', resource: { type: 'resolution_proposal', id: p.id },
          detail: { object_type_id: p.objectTypeId, kind: p.kind, affected: p.affectedCount },
        });
        return row;
      });
      // A rule changes every key of the type: a run re-keys it, placing what moves as confirmed mappings. The rule is
      // part of the type's key from now on whatever happens to this run: a run already in progress, or the next one,
      // applies it too.
      let runId: string | null = null;
      if (body.kind === 'normalisation_rule') {
        try {
          runId = (await runs.start(ctx, { objectTypeId: p.objectTypeId, analyse: false, proposalId: p.id })).id;
        } catch (error) {
          deps.logger.failure('a confirmed rule\'s run did not start; the next run applies it', error, {
            event: 'resolution.rule_run_deferred', resourceId: p.id,
          });
        }
      }
      return { ...proposalView(decided), runId };
    },

    async reject(ctx, id) {
      const actor = person(ctx, 'rejecting a resolution');
      const p = await load(ctx, id);
      if (p.status !== 'open') throw new AppError('conflict', 'the proposal is already decided', { code: 'resolution.proposal_decided' });
      await demand(deps, ctx, 'resolution.confirm', p.objectTypeId);
      return inTransaction(pool, { organisationId: actor.organisationId }, async (db) => {
        const row = await resolutionProposalRepo.decide(db, p.id, 'rejected', actor.membershipId);
        if (!row) throw new AppError('conflict', 'the proposal is already decided', { code: 'resolution.proposal_decided' });
        await recordEvent(db, actor, ctx.correlationId, {
          event: 'resolution_rejected', resource: { type: 'resolution_proposal', id: p.id }, detail: { object_type_id: p.objectTypeId, kind: p.kind },
        });
        return proposalView(row);
      });
    },
  };
}
