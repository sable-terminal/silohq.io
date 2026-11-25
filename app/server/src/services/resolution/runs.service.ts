// Resolution runs (spec 23.2, 23.3, 24.8): over a type's contributing objects, as the person
// or principal who asked.
//
// 1. Each contributing object is read through connect-runtime (identifier and match key
//    fields only) and resolved into the entity graph in batches of BATCH rows, one
//    transaction each. After a complete read, live entries it no longer returned are
//    superseded (the record is gone, or its identifier was reassigned).
// 2. With analysis on, what did not resolve across systems is analysed (analysis.service):
//    deterministic rules first, the model for what they leave; each workable rule becomes an
//    open normalisation_rule proposal.
// A run answers at once (202) and carries on here. One run per type at a time: a Redis lock,
// renewed while the run lives. Its status and counts are in redis-data (resolutionRunKeys); a
// run that stops heartbeating for a minute reads as abandoned. A confirmed rule starts a run
// without analysis that re-keys the type under it: what it moves is a confirmed mapping,
// naming the proposal.

import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { comparable, evidenceFrom, inferPairs, PROPOSE_AT, type InferenceRecord } from './inference.service.ts';
import { lockKeys, resolutionRunKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { ObjectTypeView } from '../../contracts/ontology/manifest.contract.ts';
import type { ResolutionRunView } from '../../contracts/resolution/proposal.contract.ts';
import { matchKeyRepo, resolutionProposalRepo } from '../../repos/ontology/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { bestCandidate, deterministicCandidates, judgeRule, modelCandidates, unmatched, type AnalysisRecord, type Candidate } from './analysis.service.ts';
import { acting, activeManifest, planFor, recordEvent, typeIn, type Acting, type Context, type ResolutionDeps } from './deps.service.ts';
import { resolveBatch } from './resolve.service.ts';
import { readContributing } from './sources.service.ts';

const BATCH = 500;
const HEARTBEAT_MS = 10_000;
const ABANDONED_AFTER_MS = 60_000;
/** Entries seen by the answering path shortly before a run started are not retired by it. */
const RETIRE_MARGIN_MS = 60_000;

type RunState = ResolutionRunView & { heartbeatAt: string };

export interface Runs {
  start(ctx: Context, input: { objectTypeId: string; analyse: boolean; proposalId?: string }): Promise<ResolutionRunView>;
  get(ctx: Context, runId: string): Promise<ResolutionRunView>;
  /** Stops new batches and waits for runs in flight (shutdown). */
  drain(): Promise<void>;
}

const view = (state: RunState): ResolutionRunView => {
  const { heartbeatAt: _beat, ...rest } = state;
  return rest;
};

export function createRuns(deps: ResolutionDeps): Runs {
  const inflight = new Set<Promise<void>>();
  const stopping = new AbortController();

  const save = (organisationId: string, state: RunState) =>
    deps.data.put(resolutionRunKeys, resolutionRunKeys.key(organisationId, { runId: state.id }), state).catch((error: unknown) => {
      deps.logger.failure('a resolution run status was not saved', error, { event: 'resolution.run_status_unsaved', resourceId: state.id });
    });

  async function execute(ctx: Context, actor: Acting, type: ObjectTypeView, state: RunState, analyse: boolean, proposalId: string | undefined) {
    const startedAt = Date.parse(state.startedAt);
    const { plan } = await planFor(deps, actor.organisationId, type);
    const records: AnalysisRecord[] = [];
    const recordObjects: { source: number; object: string; values: Record<string, unknown> }[] = [];
    // Probabilistic matching (D74) where the organisation turned it on: the properties every system of the type maps, other than the keys.
    const inferring = analyse && type.resolutionClass === 'resolvable' && type.contributingObjects.length > 1
      && (await inTransaction(deps.databases.pool('control'), { organisationId: actor.organisationId }, (db) => organisationRepo.findById(db, actor.organisationId),
        { readOnly: true }))?.inferenceResolution === true;
    const keys = new Set(type.matchKeys.map((k) => k.propertyIdentityId));
    const compare = !inferring ? [] : type.properties.filter((p) => !keys.has(p.identityId)
      && type.contributingObjects.every((co) => p.mappings.some((m) => m.connectionId === co.connectionId && m.sourceObject === co.sourceObject)))
      .map((p) => p.identityId);
    for (let s = 0; s < type.contributingObjects.length; s += 1) {
      if (stopping.signal.aborted) throw new AppError('unavailable', 'the service is stopping', { code: 'resolution.stopping' });
      const co = type.contributingObjects[s]!;
      const read = await readContributing(deps, ctx, type, s, compare);
      if (read.note !== undefined) state.notes.push(`${co.sourceObject}:${read.note}`);
      for (let i = 0; i < read.records.length; i += BATCH) {
        if (stopping.signal.aborted) throw new AppError('unavailable', 'the service is stopping', { code: 'resolution.stopping' });
        const slice = read.records.slice(i, i + BATCH);
        const outcome = await resolveBatch(deps, ctx, actor, type, plan, slice.map((r) => ({
          connectionId: co.connectionId, sourceObject: co.sourceObject, identifier: r.identifier, values: r.values,
        })), { touch: 'always', proposalId });
        state.entries.added += outcome.stats.added;
        state.entries.remapped += outcome.stats.remapped;
        state.entries.merged += outcome.stats.merged;
        state.unkeyed += outcome.unkeyed;
        slice.forEach((r, j) => {
          const object = outcome.objects[j]!;
          recordObjects.push({ source: s, object, values: r.values });
          const components = outcome.components[j];
          if (components !== undefined) records.push({ source: s, components, object });
        });
      }
      state.sources.push({ connectionId: co.connectionId, sourceObject: co.sourceObject, records: read.records.length, unmatched: 0 });
      if (read.complete) {
        const retired = await inTransaction(deps.databases.pool('control'), { organisationId: actor.organisationId }, (db) =>
          matchKeyRepo.retireUnseen(db, type.id, co.connectionId, co.sourceObject, new Date(startedAt - RETIRE_MARGIN_MS).toISOString()));
        state.entries.retired += retired.length;
      }
    }
    // Objects as this run saw them: an object one system alone holds is unmatched.
    const objectSources = new Map<string, Set<number>>();
    for (const r of recordObjects) (objectSources.get(r.object) ?? objectSources.set(r.object, new Set()).get(r.object)!).add(r.source);
    state.objects = objectSources.size;
    for (const r of recordObjects) {
      if (objectSources.get(r.object)!.size === 1) state.sources[r.source]!.unmatched += 1;
    }
    if (analyse && type.resolutionClass === 'resolvable' && type.contributingObjects.length > 1) {
      await analyseRecords(ctx, actor, type, state, records);
    }
    if (inferring && compare.length > 0) {
      const loose = recordObjects.filter((r) => objectSources.get(r.object)!.size === 1)
        .map((r) => ({ object: r.object, source: r.source, values: compare.map((p) => comparable(r.values[p])) }));
      await inferMatches(ctx, actor, type, state, loose, compare);
    }
  }

  /** Inferred pairs (D74): proposed as one pair list for a person to decide; one open at a time. */
  async function inferMatches(ctx: Context, actor: Acting, type: ObjectTypeView, state: RunState, loose: InferenceRecord[], compare: string[]) {
    if (new Set(loose.map((r) => r.source)).size < 2) return;
    const pool = deps.databases.pool('control');
    const decided = await inTransaction(pool, { organisationId: actor.organisationId }, (db) => resolutionProposalRepo.decidedInferredPairs(db, type.id),
      { readOnly: true });
    // Earlier decisions on the same fields teach each field's agreement rates.
    const history = decided.flatMap((p) => {
      const body = p.proposal as { inference?: { fields: string[]; agreement: (boolean | null)[][] } };
      if (body.inference === undefined) return [];
      return body.inference.agreement.map((pattern) => ({
        confirmed: p.status === 'confirmed', agreement: compare.map((f) => pattern[body.inference!.fields.indexOf(f)] ?? null),
      }));
    });
    const { pairs, compared } = inferPairs(loose, evidenceFrom(history, compare.length));
    state.notes.push(`inference_compared:${compared}`, `inference_pairs:${pairs.length}`);
    if (pairs.length === 0) return;
    const id = await inTransaction(pool, { organisationId: actor.organisationId }, async (db) => {
      if (await resolutionProposalRepo.openInferredPairsExist(db, type.id)) return undefined;
      const proposalId = uuidv7();
      await resolutionProposalRepo.insert(db, {
        id: proposalId, organisationId: actor.organisationId, objectTypeId: type.id, kind: 'pair_list',
        proposal: {
          kind: 'pair_list', pairs: pairs.map((p) => ({ from: p.from, to: p.to })),
          inference: {
            fields: compare, probabilities: pairs.map((p) => p.probability), agreement: pairs.map((p) => p.agreement),
            statement: `Inferred, because your organisation turned resolution inference on: these records share no key, but agree on `
              + `${compare.length} compared propert${compare.length === 1 ? 'y' : 'ies'} often enough that each pair is at least ${PROPOSE_AT * 100}% likely to be one `
              + `thing (agreement rates learnt from ${history.length} earlier decided pair${history.length === 1 ? '' : 's'}). Nothing merges until you confirm.`,
          },
        },
        affectedCount: pairs.length, proposedByMembershipId: actor.membershipId ?? null, proposedByServicePrincipalId: actor.servicePrincipalId ?? null,
      });
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'resolution_proposed', resource: { type: 'resolution_proposal', id: proposalId },
        detail: { object_type_id: type.id, kind: 'pair_list', basis: 'inferred', affected: pairs.length },
      });
      return proposalId;
    });
    if (id !== undefined) state.proposals.push(id);
  }

  async function analyseRecords(ctx: Context, actor: Acting, type: ObjectTypeView, state: RunState, records: AnalysisRecord[]) {
    const loose = unmatched(records);
    if (new Set(loose.map((r) => r.source)).size < 2) return;
    const proposed: { candidate: Candidate; pairs: number }[] = [];
    const best = bestCandidate(records, deterministicCandidates(loose));
    if (best) proposed.push({ candidate: best.candidate, pairs: best.judgement.pairs });
    // What the best deterministic rule leaves, the model is asked about, with shapes and counts only.
    const residual = best === undefined ? loose : unmatched(records.map((r, i) => {
      const group = best.judgement.groups.findIndex((g) => g.includes(i));
      return group < 0 ? r : { ...r, object: `merged:${group}` };
    }));
    if (new Set(residual.map((r) => r.source)).size > 1) {
      try {
        state.modelConsulted = true;
        for (const candidate of await modelCandidates(deps, ctx, type, residual)) {
          const judgement = judgeRule(records, candidate.cel);
          if (judgement === undefined) state.notes.push('model_rule_invalid');
          else if (judgement.ambiguous || judgement.lost > 0) state.notes.push('model_rule_unsafe');
          else if (judgement.pairs > 0 && !proposed.some((p) => p.candidate.cel === candidate.cel)) proposed.push({ candidate, pairs: judgement.pairs });
        }
      } catch (error) {
        state.notes.push(`model_unavailable:${isAppError(error) ? error.code : 'unknown'}`);
      }
    }
    for (const { candidate, pairs } of proposed) {
      const id = await inTransaction(deps.databases.pool('control'), { organisationId: actor.organisationId }, async (db) => {
        if (await resolutionProposalRepo.openRuleExists(db, type.id, candidate.cel)) return undefined;
        const proposalId = uuidv7();
        await resolutionProposalRepo.insert(db, {
          id: proposalId, organisationId: actor.organisationId, objectTypeId: type.id, kind: 'normalisation_rule',
          proposal: { kind: 'normalisation_rule', cel: candidate.cel, basis: candidate.basis, steps: candidate.steps, unmatchedBefore: loose.length, pairs, runId: state.id },
          affectedCount: pairs, proposedByMembershipId: actor.membershipId ?? null, proposedByServicePrincipalId: actor.servicePrincipalId ?? null,
        });
        await recordEvent(db, actor, ctx.correlationId, {
          event: 'resolution_proposed', resource: { type: 'resolution_proposal', id: proposalId },
          detail: { object_type_id: type.id, kind: 'normalisation_rule', basis: candidate.basis, affected: pairs },
        });
        return proposalId;
      });
      if (id !== undefined) state.proposals.push(id);
    }
  }

  return {
    async start(ctx, input) {
      const actor = acting(ctx);
      const type = typeIn(await activeManifest(deps, ctx), input.objectTypeId);
      const lockKey = lockKeys.key(actor.organisationId, { purpose: 'resolution', resourceId: type.id });
      const token = await deps.data.acquireLock(lockKeys, lockKey, 30);
      if (token === undefined) {
        throw new AppError('conflict', 'a resolution run of this type is already in progress', { code: 'resolution.run_in_progress', retryable: true, retryAfterSeconds: 30 });
      }
      const now = new Date().toISOString();
      const state: RunState = {
        id: uuidv7(), objectTypeId: type.id, status: 'running', startedAt: now, finishedAt: null, heartbeatAt: now,
        entries: { added: 0, remapped: 0, merged: 0, retired: 0 }, sources: [], objects: 0, unkeyed: 0, proposals: [], modelConsulted: false,
        notes: [],
      };
      await save(actor.organisationId, state);
      await inTransaction(deps.databases.pool('control'), { organisationId: actor.organisationId }, (db) => recordEvent(db, actor, ctx.correlationId, {
        event: 'resolution_run_started', resource: { type: 'object_type', id: type.id },
        detail: { run_id: state.id, analyse: input.analyse, ...(input.proposalId ? { proposal_id: input.proposalId } : {}) },
      }));
      const beat = setInterval(() => {
        state.heartbeatAt = new Date().toISOString();
        void save(actor.organisationId, state);
        deps.data.renewLock(lockKeys, lockKey, token, 30).catch(() => undefined);
      }, HEARTBEAT_MS);
      const work = execute(ctx, actor, type, state, input.analyse, input.proposalId).then(
        () => { state.status = 'completed'; },
        (error: unknown) => {
          state.status = stopping.signal.aborted ? 'abandoned' : 'failed';
          state.notes.push(`failed:${isAppError(error) ? error.code : 'unknown'}`);
          deps.logger.failure('a resolution run failed', error, { event: 'resolution.run_failed', resourceId: state.id });
        },
      ).then(async () => {
        clearInterval(beat);
        state.finishedAt = new Date().toISOString();
        state.heartbeatAt = state.finishedAt;
        await save(actor.organisationId, state);
        await inTransaction(deps.databases.pool('control'), { organisationId: actor.organisationId }, (db) => recordEvent(db, actor, ctx.correlationId, {
          event: 'resolution_run_completed', resource: { type: 'object_type', id: type.id },
          detail: {
            run_id: state.id, status: state.status, added: state.entries.added, remapped: state.entries.remapped, merged: state.entries.merged,
            retired: state.entries.retired, objects: state.objects, unkeyed: state.unkeyed, proposals: state.proposals.length,
          },
        })).catch((error: unknown) => deps.logger.failure('a resolution run end was not audited', error, { event: 'resolution.run_unaudited' }));
      }).finally(async () => {
        await deps.data.releaseLock(lockKeys, lockKey, token).catch(() => undefined);
        inflight.delete(work);
      });
      inflight.add(work);
      return view(state);
    },

    async get(ctx, runId) {
      const organisationId = ctx.request.organisationId!;
      const state = await deps.data.read(resolutionRunKeys, resolutionRunKeys.key(organisationId, { runId }));
      if (!state) throw new AppError('not_found', 'no such run, or it has expired', { code: 'resolution.run_not_found' });
      if (state.status === 'running' && Date.now() - Date.parse(state.heartbeatAt) > ABANDONED_AFTER_MS) {
        return view({ ...state, status: 'abandoned' });
      }
      return view(state);
    },

    async drain() {
      stopping.abort();
      await Promise.allSettled([...inflight]);
    },
  };
}
