// The confirmation queue (spec 49.6, 52.2 to 52.4, 53.2). Every AI FDE output is a proposal
// with typed evidence (the database refuses one without), a confidence and its band, the
// existing permission its decider must hold, and the markings of everything it touches.
//
// A decision needs fde.confirm, the kind's mapped permission and every marking, decided by
// policy in the decider's own session. A deployment engineer decides technical kinds only.
// High-confidence proposals may be accepted together by an explicit action naming the
// count, except the kinds that change what a value is, what can be written or what every
// simulation concludes; each is still recorded alone. Accepting applies the proposal
// through its target system as the decider (apply.service.ts); the decision is recorded
// once that has succeeded.

import { bandFor } from './bands.service.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { KIND_PERMISSION, NEVER_GROUP_ACCEPTED, TECHNICAL_KINDS, type ProposalKind } from '../../contracts/fde-orchestrator/events.contract.ts';
import type { ProposalView } from '../../contracts/fde-orchestrator/engagement.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { FdeEngagement, FdeProposal, FdeTask } from '../../models/fde/index.model.ts';
import {
  fdeConfirmationSessionRepo, fdePrincipalRepo, fdeProposalMarkingRepo, fdeProposalRepo, fdeProposalTargetRepo,
} from '../../repos/fde/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { applyDecision, EDITABLE, type Applied, type Decision } from './apply.service.ts';
import { nowOf, proposalView, recordEvent, type Context, type FdeDeps } from './deps.service.ts';
import { holds, loadEngagement } from './engagements.service.ts';

export interface Evidence { type: string; [key: string]: unknown }

export interface NewProposal {
  kind: ProposalKind;
  payload: Record<string, unknown>;
  evidence: Evidence[];
  confidence: number;
  verification: Record<string, unknown>;
  markings: readonly string[];
}

/** Creates a proposal from a task's verified output (49.6). */
export async function createProposal(db: Queryable, e: FdeEngagement, task: FdeTask, input: NewProposal, correlationId: string): Promise<FdeProposal> {
  const confidence = Math.max(0, Math.min(1, input.confidence));
  const proposal = await fdeProposalRepo.insert(db, {
    id: uuidv7(), organisationId: e.organisationId, engagementId: e.id, taskId: task.id, kind: input.kind, payload: input.payload as never,
    evidence: input.evidence as never, confidence: confidence.toFixed(3), confidenceBand: await bandFor(db, input.kind, confidence), verification: input.verification as never,
    requiredPermission: KIND_PERMISSION[input.kind],
  });
  for (const markingId of new Set(input.markings)) {
    await fdeProposalMarkingRepo.insert(db, { organisationId: e.organisationId, proposalId: proposal.id, markingId });
  }
  const principal = await fdePrincipalRepo.findById(db, task.principalId);
  await recordEvent(db, { organisationId: e.organisationId, correlationId, event: 'fde_proposal_created', engagementId: e.id,
    actor: principal === undefined ? 'orchestrator' : { servicePrincipalId: principal.servicePrincipalId }, resource: { type: 'fde_proposal', id: proposal.id },
    detail: { kind: input.kind, band: proposal.confidenceBand, task_id: task.id, markings: new Set(input.markings).size } });
  return proposal;
}

const TARGET_COLUMN: Record<string, string> = {
  objectTypeId: 'objectTypeId', linkTypeId: 'linkTypeId', resolutionProposalId: 'resolutionProposalId',
  detectorConfigurationId: 'detectorConfigurationId', dependencyEdgeId: 'dependencyEdgeId',
};

export function createProposals(deps: FdeDeps) {
  const pool = deps.databases.pool('control');

  async function views(db: Queryable, list: FdeProposal[]): Promise<ProposalView[]> {
    const ids = list.map((p) => p.id);
    const markings = await fdeProposalMarkingRepo.listFor(db, ids);
    const applied = new Map((await fdeProposalTargetRepo.appliedFor(db, ids)).map((t) => {
      const ref = Object.keys(TARGET_COLUMN).map((k) => (t as unknown as Record<string, string | null>)[k]).find((v) => v != null) ?? null;
      return [t.proposalId, ref];
    }));
    return list.map((p) => proposalView(p, { markings: markings.filter((m) => m.proposalId === p.id).map((m) => m.markingId), appliedRef: applied.get(p.id) ?? null }));
  }

  async function load(ctx: Context, proposalId: string) {
    return inTransaction(pool, ctx.request, async (db) => {
      const p = await fdeProposalRepo.findById(db, proposalId);
      if (p === undefined) throw new AppError('not_found', 'no such proposal', { code: 'fde.proposal_not_found' });
      const markings = (await fdeProposalMarkingRepo.listFor(db, [p.id])).map((m) => m.markingId);
      const e = await loadEngagement(db, p.engagementId);
      const ontology = await fdePrincipalRepo.liveForRole(db, e.id, 'ontology');
      return { p, e, markings, ontologyPrincipal: ontology?.servicePrincipalId };
    }, { readOnly: true });
  }

  /** 52.2 and 53.2: may this person decide this proposal? */
  async function eligible(ctx: Context, e: FdeEngagement, p: FdeProposal, markings: readonly string[]): Promise<void> {
    if (ctx.request.membershipId === e.supervisingEngineerMembershipId && !TECHNICAL_KINDS.has(p.kind)) {
      throw new AppError('forbidden', 'a deployment engineer decides technical proposals only (spec 53.2)', { code: 'fde.engineer_not_permitted' });
    }
    for (const permission of ['fde.confirm', p.requiredPermission]) {
      if (!await holds(deps, ctx, permission, { scopeId: e.scopeId })) {
        throw new AppError('forbidden', `deciding this proposal needs ${permission}`, { code: 'fde.not_permitted', details: { permission } });
      }
    }
    if (markings.length > 0) {
      const access = await deps.services.call(resolveAccess, { body: { markings: [...markings] } }, { request: ctx.request, correlationId: ctx.correlationId });
      if (access.decision !== 'allow' || access.markings.some((m) => !m.satisfied)) {
        throw new AppError('forbidden', 'you do not hold every marking on this proposal', { code: 'fde.marking_unsatisfied' });
      }
    }
  }

  /** What the person changed on acceptance, field by field: the edit diff (52.2, 54.1). */
  function edit(p: FdeProposal, edits: Record<string, unknown> | undefined): { payload: Record<string, unknown>; diff: Record<string, unknown> | null } {
    const before = p.payload as Record<string, unknown>;
    if (edits === undefined || Object.keys(edits).length === 0) return { payload: before, diff: null };
    const allowed = EDITABLE[p.kind] ?? [];
    const refused = Object.keys(edits).filter((k) => !allowed.includes(k));
    if (refused.length > 0) {
      throw new AppError('validation', `${p.kind} proposals may change only ${allowed.join(', ') || 'nothing'}`, { code: 'fde.edit_not_allowed', details: { field: refused[0]! } });
    }
    const diff: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(edits)) if (JSON.stringify(before[k]) !== JSON.stringify(v)) diff[k] = { before: before[k] ?? null, after: v };
    return { payload: { ...before, ...edits }, diff: Object.keys(diff).length > 0 ? diff : null };
  }

  async function record(ctx: Context, e: FdeEngagement, p: FdeProposal, outcome: {
    decision: Decision; diff: Record<string, unknown> | null; reason?: string | undefined; note?: string | undefined; sessionId?: string | undefined; applied?: Applied | undefined;
  }): Promise<FdeProposal> {
    const membershipId = ctx.request.membershipId!;
    return inTransaction(pool, ctx.request, async (db) => {
      const status = outcome.decision === 'defer' ? 'deferred' : outcome.decision === 'reject' ? 'rejected' : outcome.diff !== null ? 'accepted_edited' : 'accepted';
      const updated = await fdeProposalRepo.update(db, p.id, {
        status, decidedBy: membershipId, decidedAt: nowOf(deps).toISOString(), editDiff: outcome.diff as never,
        rejectionReason: outcome.decision === 'reject' ? `${outcome.reason}${outcome.note ? `:${outcome.note}` : ''}` : null,
        confirmationSessionId: outcome.sessionId ?? null,
      });
      if (updated === undefined) throw new AppError('conflict', 'the proposal changed', { code: 'fde.proposal_changed' });
      if (outcome.applied !== undefined) {
        await fdeProposalTargetRepo.insert(db, {
          id: uuidv7(), organisationId: e.organisationId, proposalId: p.id, proposalKind: p.kind, relation: 'applied', [outcome.applied.column]: outcome.applied.id,
        } as never);
      }
      if (outcome.sessionId !== undefined) {
        const session = await fdeConfirmationSessionRepo.findById(db, outcome.sessionId);
        if (session === undefined || session.engagementId !== e.id || session.endedAt !== null) {
          throw new AppError('conflict', 'that confirmation session is not open for this engagement', { code: 'fde.session_closed' });
        }
        const counts = {
          accepted: { acceptedCount: session.acceptedCount + 1 }, accepted_edited: { editedCount: session.editedCount + 1 },
          rejected: { rejectedCount: session.rejectedCount + 1 }, deferred: { deferredCount: session.deferredCount + 1 },
        }[status];
        await fdeConfirmationSessionRepo.update(db, session.id, counts as never);
      }
      const event = ({ accepted: 'fde_proposal_accepted', accepted_edited: 'fde_proposal_edited', rejected: 'fde_proposal_rejected', deferred: 'fde_proposal_deferred' } as const)[status];
      await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event, engagementId: e.id, actor: { membershipId },
        resource: { type: 'fde_proposal', id: p.id }, detail: { kind: p.kind, band: p.confidenceBand, session: outcome.sessionId !== undefined } });
      return updated;
    });
  }

  async function decideOne(ctx: Context, proposalId: string, input: {
    decision: Decision; edits?: Record<string, unknown> | undefined; reason?: string | undefined; note?: string | undefined; sessionId?: string | undefined;
  }): Promise<FdeProposal> {
    const { p, e, markings, ontologyPrincipal } = await load(ctx, proposalId);
    if (p.status !== 'pending') throw new AppError('conflict', `the proposal is ${p.status}`, { code: 'fde.proposal_decided' });
    if (e.status !== 'active' && e.status !== 'paused') throw new AppError('conflict', `the engagement is ${e.status}`, { code: 'fde.not_active' });
    await eligible(ctx, e, p, markings);
    const { payload, diff } = input.decision === 'accept' ? edit(p, input.edits) : { payload: p.payload as Record<string, unknown>, diff: null };
    const applied = await applyDecision(deps, ctx, e, p, input.decision, payload, ontologyPrincipal);
    return record(ctx, e, p, { ...input, diff, applied });
  }

  return {
    views: (db: Queryable, list: FdeProposal[]) => views(db, list),

    async list(ctx: Context, engagementId: string, filter: { status?: string | undefined; kind?: string | undefined; mine?: string | undefined }) {
      return inTransaction(pool, ctx.request, async (db) => {
        await loadEngagement(db, engagementId);
        const list = await fdeProposalRepo.listForEngagement(db, engagementId, {
          ...(filter.status ? { status: filter.status } : {}), ...(filter.kind ? { kind: filter.kind } : {}),
          ...(filter.mine === 'true' ? { assigned: ctx.request.membershipId! } : {}),
        });
        return { proposals: await views(db, list) };
      }, { readOnly: true });
    },

    async get(ctx: Context, proposalId: string) {
      return inTransaction(pool, ctx.request, async (db) => {
        const p = await fdeProposalRepo.findById(db, proposalId);
        if (p === undefined) throw new AppError('not_found', 'no such proposal', { code: 'fde.proposal_not_found' });
        return (await views(db, [p]))[0]!;
      }, { readOnly: true });
    },

    async decide(ctx: Context, proposalId: string, input: Parameters<typeof decideOne>[2]) {
      const decided = await decideOne(ctx, proposalId, input);
      return inTransaction(pool, ctx.request, async (db) => (await views(db, [decided]))[0]!, { readOnly: true });
    },

    /** 52.3: an explicit action naming the count; every item high band, of a kind that may be grouped, recorded alone. */
    async acceptGroup(ctx: Context, engagementId: string, input: { proposalIds: string[]; count: number; sessionId?: string | undefined }) {
      const list = await inTransaction(pool, ctx.request, async (db) => {
        await loadEngagement(db, engagementId);
        return Promise.all(input.proposalIds.map((id) => fdeProposalRepo.findById(db, id)));
      }, { readOnly: true });
      for (const p of list) {
        if (p === undefined || p.engagementId !== engagementId) throw new AppError('not_found', 'a proposal is not in this engagement', { code: 'fde.proposal_not_found' });
        if (p.status !== 'pending') throw new AppError('conflict', 'a proposal in the group is decided', { code: 'fde.proposal_decided' });
        if (p.confidenceBand !== 'high') throw new AppError('validation', 'only high-confidence proposals are accepted as a group', { code: 'fde.group_not_high' });
        if (NEVER_GROUP_ACCEPTED.has(p.kind)) {
          throw new AppError('validation', `${p.kind} proposals are decided one by one (spec 52.3)`, { code: 'fde.group_kind_refused', details: { kind: p.kind } });
        }
      }
      // The whole group is checked before any of it is applied: a group is accepted whole or not at all.
      for (const p of list) {
        const { e, markings } = await load(ctx, p!.id);
        await eligible(ctx, e, p!, markings);
      }
      const accepted: FdeProposal[] = [];
      for (const p of list) accepted.push(await decideOne(ctx, p!.id, { decision: 'accept', sessionId: input.sessionId }));
      return inTransaction(pool, ctx.request, async (db) => {
        const e = await loadEngagement(db, engagementId);
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_proposals_group_accepted', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! }, detail: { count: accepted.length } });
        return { accepted: await views(db, accepted) };
      });
    },

    /** Routes proposals to a decider (fde.engage or fde.supervise); never a non-technical kind to the deployment engineer. */
    async assign(ctx: Context, engagementId: string, input: { proposalIds: string[]; membershipId: string }) {
      if (!await holds(deps, ctx, 'fde.engage') && !await holds(deps, ctx, 'fde.supervise')) {
        throw new AppError('forbidden', 'routing proposals needs fde.engage or fde.supervise', { code: 'fde.not_permitted' });
      }
      return inTransaction(pool, ctx.request, async (db) => {
        const e = await loadEngagement(db, engagementId);
        let assigned = 0;
        for (const id of input.proposalIds) {
          const p = await fdeProposalRepo.findById(db, id);
          if (p === undefined || p.engagementId !== e.id || p.status !== 'pending') continue;
          if (input.membershipId === e.supervisingEngineerMembershipId && !TECHNICAL_KINDS.has(p.kind)) {
            throw new AppError('validation', `${p.kind} proposals are never routed to a deployment engineer (spec 53.2)`, { code: 'fde.engineer_not_permitted' });
          }
          await fdeProposalRepo.update(db, p.id, { assignedMembershipId: input.membershipId });
          assigned += 1;
        }
        return { assigned };
      });
    },
  };
}

export type Proposals = ReturnType<typeof createProposals>;
