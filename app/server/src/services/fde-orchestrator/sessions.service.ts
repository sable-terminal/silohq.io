// Confirmation sessions and escalations (spec 52.3, 53.3, 53.4).
//
// A session works through the current stage's pending proposals in a fixed order: grouped by
// business area (the object type or system a proposal concerns), object types before links,
// links before resolution, resolution before field authority, and within a group by band.
// A workshop has a facilitator (a deployment engineer or the customer's lead); a queue
// session is the deciders working alone. Decisions made in it are counted on it.
//
// An escalation names its cause and path; a person holding fde.engage or fde.supervise raises
// and resolves one. The orchestrator raises repeated stage failure itself.

import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { FdeConfirmationSession, FdeEscalation, FdeProposal } from '../../models/fde/index.model.ts';
import {
  fdeConfirmationParticipantRepo, fdeConfirmationSessionRepo, fdeEscalationRepo, fdeProposalRepo, fdeStageRepo,
} from '../../repos/fde/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { nowOf, recordEvent, STAGES, type Context, type FdeDeps } from './deps.service.ts';
import { holds, loadEngagement } from './engagements.service.ts';

const KIND_ORDER = ['estate_entry', 'discovery_finding', 'connector_manifest', 'connector_mapping', 'object_type', 'interface', 'link_type',
  'field_alias', 'time_field', 'resolution_pair', 'field_authority', 'action_type', 'write_enablement', 'studio_app', 'object_view_layout',
  'dashboard', 'cron_notify', 'detector_configuration', 'dependency_edge', 'heal_review', 'reliability_finding'];
const BAND_ORDER = ['high', 'medium', 'low'];

/** The business area a proposal concerns: its object type or its system. */
function groupOf(p: FdeProposal): string {
  const payload = p.payload as Record<string, unknown>;
  for (const key of ['objectTypeId', 'fromObjectTypeId', 'connectionId']) if (typeof payload[key] === 'string') return `${key.replace(/Id$/, '')}:${String(payload[key])}`;
  if (typeof payload['apiName'] === 'string') return `${p.kind}:${String(payload['apiName'])}`;
  return p.kind;
}

export function agendaOf(pending: FdeProposal[]) {
  const sorted = [...pending].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || groupOf(a).localeCompare(groupOf(b)) || BAND_ORDER.indexOf(a.confidenceBand) - BAND_ORDER.indexOf(b.confidenceBand));
  const items: { group: string; band: 'high' | 'medium' | 'low'; proposalIds: string[] }[] = [];
  for (const p of sorted) {
    const group = `${p.kind} · ${groupOf(p)}`;
    const last = items.at(-1);
    if (last !== undefined && last.group === group && last.band === p.confidenceBand) last.proposalIds.push(p.id);
    else items.push({ group, band: p.confidenceBand, proposalIds: [p.id] });
  }
  return items;
}

export function createSessions(deps: FdeDeps) {
  const pool = deps.databases.pool('control');

  async function sessionView(db: Queryable, s: FdeConfirmationSession) {
    const stage = (await fdeStageRepo.findById(db, s.stageId))!;
    return {
      id: s.id, engagementId: s.engagementId, stageNumber: stage.stageNumber, mode: s.mode, facilitatorMembershipId: s.facilitatorMembershipId,
      participantMembershipIds: await fdeConfirmationParticipantRepo.listForSession(db, s.id),
      agenda: s.agenda as { group: string; band: 'high' | 'medium' | 'low'; proposalIds: string[] }[],
      scheduledAt: s.scheduledAt, startedAt: s.startedAt, endedAt: s.endedAt,
      counts: {
        presented: s.presentedCount, accepted: s.acceptedCount, edited: s.editedCount, rejected: s.rejectedCount,
        deferred: s.deferredCount, escalated: s.escalatedCount,
      },
    };
  }

  const escalationView = (x: FdeEscalation) => ({
    id: x.id, cause: x.cause, path: x.path, status: x.status, proposalId: x.proposalId, taskId: x.taskId, stageId: x.stageId, ticketRef: x.ticketRef,
    raisedByMembershipId: x.raisedByMembershipId, resolvedBy: x.resolvedBy, resolutionNote: x.resolutionNote, createdAt: x.createdAt,
  });

  async function engageOrSupervise(ctx: Context): Promise<void> {
    if (!await holds(deps, ctx, 'fde.engage') && !await holds(deps, ctx, 'fde.supervise')) {
      throw new AppError('forbidden', 'this needs fde.engage or fde.supervise', { code: 'fde.not_permitted' });
    }
  }

  return {
    async start(ctx: Context, engagementId: string, input: { mode: 'queue' | 'workshop'; participantMembershipIds: string[]; scheduledAt?: string | undefined }) {
      await engageOrSupervise(ctx);
      const membershipId = ctx.request.membershipId!;
      return inTransaction(pool, ctx.request, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (e.status !== 'active' && e.status !== 'paused') throw new AppError('conflict', `the engagement is ${e.status}`, { code: 'fde.not_active' });
        const stage = (await fdeStageRepo.latest(db, e.id, e.currentStage))!;
        const kinds = STAGES[e.currentStage]!.kinds;
        const pending = (await fdeProposalRepo.listForEngagement(db, e.id, { status: 'pending' })).filter((p) => kinds.includes(p.kind));
        const agenda = agendaOf(pending);
        const at = nowOf(deps).toISOString();
        const session = await fdeConfirmationSessionRepo.insert(db, {
          id: uuidv7(), organisationId: e.organisationId, engagementId: e.id, stageId: stage.id, mode: input.mode,
          facilitatorMembershipId: input.mode === 'workshop' ? membershipId : null, agenda: agenda as never,
          scheduledAt: input.scheduledAt ?? null, startedAt: at, presentedCount: pending.length,
        });
        for (const participant of new Set(input.participantMembershipIds)) {
          await fdeConfirmationParticipantRepo.insert(db, { organisationId: e.organisationId, sessionId: session.id, membershipId: participant });
        }
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_confirmation_session_started',
          engagementId: e.id, actor: { membershipId }, resource: { type: 'fde_confirmation_session', id: session.id },
          detail: { mode: input.mode, stage: e.currentStage, presented: pending.length, participants: new Set(input.participantMembershipIds).size } });
        return sessionView(db, session);
      });
    },

    async end(ctx: Context, sessionId: string) {
      await engageOrSupervise(ctx);
      return inTransaction(pool, ctx.request, async (db) => {
        const session = await fdeConfirmationSessionRepo.findById(db, sessionId);
        if (session === undefined) throw new AppError('not_found', 'no such session', { code: 'fde.session_not_found' });
        if (session.endedAt !== null) throw new AppError('conflict', 'the session has ended', { code: 'fde.session_closed' });
        const ended = (await fdeConfirmationSessionRepo.update(db, session.id, { endedAt: nowOf(deps).toISOString() }))!;
        await recordEvent(db, { organisationId: session.organisationId, correlationId: ctx.correlationId, event: 'fde_confirmation_session_completed',
          engagementId: session.engagementId, actor: { membershipId: ctx.request.membershipId! }, resource: { type: 'fde_confirmation_session', id: session.id },
          detail: { presented: ended.presentedCount, accepted: ended.acceptedCount, edited: ended.editedCount, rejected: ended.rejectedCount,
            deferred: ended.deferredCount, escalated: ended.escalatedCount } });
        return sessionView(db, ended);
      });
    },

    async raise(ctx: Context, engagementId: string, input: {
      cause: FdeEscalation['cause']; path: FdeEscalation['path']; proposalId?: string | undefined; taskId?: string | undefined; ticketRef?: string | undefined;
    }) {
      await engageOrSupervise(ctx);
      return inTransaction(pool, ctx.request, async (db) => {
        const e = await loadEngagement(db, engagementId);
        if (input.proposalId !== undefined) {
          const p = await fdeProposalRepo.findById(db, input.proposalId);
          if (p === undefined || p.engagementId !== e.id) throw new AppError('not_found', 'no such proposal in this engagement', { code: 'fde.proposal_not_found' });
        }
        const escalation = await fdeEscalationRepo.insert(db, {
          id: uuidv7(), organisationId: e.organisationId, engagementId: e.id, proposalId: input.proposalId ?? null, taskId: input.taskId ?? null,
          cause: input.cause, path: input.path, raisedByMembershipId: ctx.request.membershipId!, ticketRef: input.ticketRef ?? null,
        });
        await recordEvent(db, { organisationId: e.organisationId, correlationId: ctx.correlationId, event: 'fde_escalation_raised', engagementId: e.id,
          actor: { membershipId: ctx.request.membershipId! }, resource: { type: 'fde_escalation', id: escalation.id }, detail: { cause: input.cause, path: input.path } });
        return escalationView(escalation);
      });
    },

    async resolve(ctx: Context, escalationId: string, note: string) {
      await engageOrSupervise(ctx);
      return inTransaction(pool, ctx.request, async (db) => {
        const x = await fdeEscalationRepo.findById(db, escalationId);
        if (x === undefined) throw new AppError('not_found', 'no such escalation', { code: 'fde.escalation_not_found' });
        if (x.status !== 'open') throw new AppError('conflict', 'the escalation is resolved', { code: 'fde.escalation_resolved' });
        const resolved = (await fdeEscalationRepo.update(db, x.id, {
          status: 'resolved', resolvedBy: ctx.request.membershipId!, resolutionNote: note, resolvedAt: nowOf(deps).toISOString(),
        }))!;
        await recordEvent(db, { organisationId: x.organisationId, correlationId: ctx.correlationId, event: 'fde_escalation_resolved', engagementId: x.engagementId,
          actor: { membershipId: ctx.request.membershipId! }, resource: { type: 'fde_escalation', id: x.id }, detail: { cause: x.cause } });
        return escalationView(resolved);
      });
    },

    /** An engagement's sessions, newest first (D263). */
    async listSessions(ctx: Context, engagementId: string) {
      return inTransaction(pool, ctx.request, async (db) => {
        await loadEngagement(db, engagementId);
        const rows = await fdeConfirmationSessionRepo.listForEngagement(db, engagementId);
        const sessions = [];
        for (const s of rows) sessions.push(await sessionView(db, s));
        return { sessions };
      }, { readOnly: true });
    },

    async list(ctx: Context, engagementId: string) {
      return inTransaction(pool, ctx.request, async (db) => {
        await loadEngagement(db, engagementId);
        return { escalations: (await fdeEscalationRepo.listForEngagement(db, engagementId)).map(escalationView) };
      }, { readOnly: true });
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;
