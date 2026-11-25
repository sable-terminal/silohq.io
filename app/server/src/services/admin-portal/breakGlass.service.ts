// Break-glass (spec 13.3, 13.5, 63.6): Silo staff have no standing access to a tenant.
//
//   request (reason, ticket, scope, duration) → second staff approval → customer approval
//   (where required; always on sovereign) → start → recorded session → expiry → the
//   customer's audit log
//
// - A session names one organisation, a purpose and a level. Staff can never approve an
//   Action, unwrap a credential or read a record value outside one; no level does either of
//   the first two.
// - Customer approval is required when the organisation's policy says so
//   (org.operator_access.policy) and always in the sovereign cell. It comes after the
//   staff approval, from a holder of org.operator_access.approve, who is notified.
// - An emergency session (63.6) takes two staff approvers instead of the customer and is
//   disclosed to the customer at once (operator_access_emergency, and a notification). It
//   never acts (tenant_act).
// - Only the requester starts, uses and ends their session. It runs for the minutes asked,
//   at most 4 hours; the sweep expires it. The customer may revoke it at any moment.
// - Every request made under it is counted on the session and recorded in the customer's
//   audit log before it is made (operator_access_resource_touched), and carries the session
//   to the service that serves it, which checks it again (sessionCheck.service). The audit
//   events are the session's recording, kept 12 months at least.
// - Reasons and scope notes are free text: a value pattern in them is refused.

import { levelCovers, MAX_SESSION_MINUTES, RECORDING_RETENTION_MONTHS, type AccessLevel, type AccessPurpose }
  from '../../contracts/admin-portal/capability.contract.ts';
import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import { raiseNotification } from '../../contracts/notify/notification.contract.ts';
import { inTransaction, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { OperatorAccessSession } from '../../models/platform/operatorAccessSession.model.ts';
import { organisationRepo, roleAssignmentRepo } from '../../repos/iam/index.repo.ts';
import { operatorAccessSessionRepo, outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { assertNoValuePatterns } from '../../utils/redaction.util.ts';
import { nowOf, recordAccessEvent, type AdminPortalDeps, type StaffContext } from './deps.service.ts';

/** Who the customer asks: the holders of the approving permission (13.5). */
export const APPROVE_PERMISSION = 'org.operator_access.approve';

const notFound = (): AppError => new AppError('not_found', 'no such operator session', { code: 'operator_access.not_found' });
const conflict = (code: string, message: string): AppError => new AppError('conflict', message, { code: `operator_access.${code}` });
const notYours = (): AppError => new AppError('forbidden', 'only the member of staff who asked for this session may do that', {
  code: 'operator_access.not_requester',
});

type Session = OperatorAccessSession;
export type SessionView = Omit<Session, 'updatedAt' | 'version'>;
const view = ({ updatedAt: _u, version: _v, ...rest }: Session): SessionView => rest;
const customerView = ({ organisationId: _o, ...rest }: SessionView) => rest;

const encodeCursor = (s: Session): string => Buffer.from(`${s.requestedAt}|${s.id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string | undefined): { requestedAt: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const [requestedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!requestedAt || !id || Number.isNaN(Date.parse(requestedAt)) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new AppError('validation', 'the cursor is not one this service issued', { code: 'operator_access.cursor_invalid' });
  }
  return { requestedAt, id };
}

const operatorActor = (operatorId: string, sessionId: string): AuditActor => ({ kind: 'operator', operatorId, operatorAccessSessionId: sessionId });

export function createBreakGlass(deps: AdminPortalDeps) {
  const control = deps.databases.pool('control');
  const tx = <T>(organisationId: string, work: (db: Queryable) => Promise<T>, extra: Partial<RequestContext> = {}) =>
    inTransaction(control, { organisationId, ...extra }, work);
  const read = <T>(organisationId: string, work: (db: Queryable) => Promise<T>) =>
    inTransaction(control, { organisationId }, work, { readOnly: true });

  const locked = async (db: Queryable, sessionId: string): Promise<Session> => {
    const row = await operatorAccessSessionRepo.lock(db, sessionId);
    if (row === undefined) throw notFound();
    return row;
  };
  const save = async (db: Queryable, id: string, changes: Parameters<typeof operatorAccessSessionRepo.update>[2]): Promise<Session> =>
    (await operatorAccessSessionRepo.update(db, id, changes))!;

  /** Tells the customer's approvers, after the transaction that made the change. Best effort: the audit event is the record. */
  const tellApprovers = async (organisationId: string, sessionId: string, kind: 'operator_access_waiting' | 'operator_access_emergency',
    correlationId: string): Promise<void> => {
    const recipients = await read(organisationId, (db) => roleAssignmentRepo.holdersOf(db, APPROVE_PERMISSION));
    for (const recipientMembershipId of recipients) {
      try {
        await deps.services.call(raiseNotification, { body: { recipientMembershipId, kind, source: { operatorAccessSessionId: sessionId } } },
          { request: { organisationId }, correlationId });
      } catch (error) {
        deps.logger.failure('a break-glass notification was not raised', error, {
          event: 'operator_access.notify_failed', resourceType: 'operator_access_session', resourceId: sessionId, correlationId,
        });
      }
    }
  };

  const expiryFor = (session: Session, startedAt: Date): string =>
    new Date(startedAt.getTime() + Math.min(session.requestedMinutes, MAX_SESSION_MINUTES) * 60_000).toISOString();
  const retainedUntil = (endedAt: Date): string => {
    const until = new Date(endedAt);
    until.setUTCMonth(until.getUTCMonth() + RECORDING_RETENTION_MONTHS);
    return until.toISOString();
  };

  return {
    // ------------------------------------------------------------------------- staff

    async request(ctx: StaffContext, input: {
      organisationId: string; purpose: AccessPurpose; level: AccessLevel; reason: string; ticketReference: string;
      scopeNote?: string | undefined; minutes: number; emergency: boolean;
    }): Promise<SessionView> {
      assertNoValuePatterns(input.reason, 'reason');
      if (input.scopeNote !== undefined) assertNoValuePatterns(input.scopeNote, 'scopeNote');
      assertNoValuePatterns(input.ticketReference, 'ticketReference');
      if (input.emergency && input.level === 'tenant_act') {
        throw new AppError('validation', 'an emergency session reads; acting needs the customer\'s approval', { code: 'operator_access.emergency_acts' });
      }
      const operator = ctx.staff.operator;
      return tx(input.organisationId, async (db) => {
        const organisation = await organisationRepo.findById(db, input.organisationId);
        if (organisation === undefined || organisation.isSystem) throw new AppError('not_found', 'no such organisation', { code: 'operator_access.organisation_unknown' });
        const id = uuidv7();
        const row = await operatorAccessSessionRepo.insert(db, {
          id, organisationId: input.organisationId, operatorId: operator.id, operatorDisplayName: operator.displayName, purpose: input.purpose,
          accessLevel: input.level, reason: input.reason, ticketReference: input.ticketReference, scopeNote: input.scopeNote ?? null,
          requestedMinutes: input.minutes, emergency: input.emergency,
          customerApprovalRequired: deps.cell.sovereign || organisation.operatorAccessApprovalRequired,
        });
        await recordAccessEvent(db, {
          organisationId: input.organisationId, correlationId: ctx.correlationId, sessionId: id, event: 'operator_access_requested',
          actor: operatorActor(operator.id, id),
          detail: { purpose: input.purpose, access_level: input.level, minutes: input.minutes, emergency: input.emergency,
            customer_approval_required: row.customerApprovalRequired },
        });
        return view(row);
      });
    },

    /**
     * The second staff approval. A normal request then waits for the customer where their
     * approval is required; an emergency one takes a second approver and is disclosed.
     */
    async approve(ctx: StaffContext, organisationId: string, sessionId: string): Promise<SessionView> {
      const approver = ctx.staff.operator;
      let tell: 'operator_access_waiting' | 'operator_access_emergency' | undefined;
      const result = await tx(organisationId, async (db) => {
        const s = await locked(db, sessionId);
        if (s.status !== 'requested') throw conflict('not_awaiting_staff', 'this session is not waiting for a staff approval');
        if (approver.id === s.operatorId) throw new AppError('forbidden', 'a second member of staff approves (two-person rule)', { code: 'operator_access.two_person' });
        if (approver.id === s.staffApproverOperatorId) throw conflict('already_approved', 'you have approved this session already');
        const at = nowOf(deps).toISOString();
        const event = { organisationId, correlationId: ctx.correlationId, sessionId, actor: operatorActor(approver.id, sessionId) };
        if (s.staffApproverOperatorId === null) {
          const first = await save(db, sessionId, {
            staffApproverOperatorId: approver.id, staffApproverDisplayName: approver.displayName, staffApprovedAt: at,
            ...(s.emergency || s.customerApprovalRequired ? {} : { status: 'approved' }),
          });
          await recordAccessEvent(db, { ...event, event: 'operator_access_approved', detail: { by: 'staff', approval: 'first',
            awaiting: s.emergency ? 'second_staff_approval' : s.customerApprovalRequired ? 'customer' : 'none' } });
          if (!s.emergency && s.customerApprovalRequired) tell = 'operator_access_waiting';
          return first;
        }
        if (!s.emergency) throw conflict('awaiting_customer', 'this session is waiting for the customer\'s approval');
        if (s.staffSecondApproverOperatorId !== null) throw conflict('already_approved', 'this session has both its staff approvals');
        const second = await save(db, sessionId, {
          staffSecondApproverOperatorId: approver.id, staffSecondApproverDisplayName: approver.displayName, status: 'approved',
        });
        await recordAccessEvent(db, { ...event, event: 'operator_access_approved', detail: { by: 'staff', approval: 'second', awaiting: 'none' } });
        // 63.6: "disclosed to super admins at once"; the event a customer reads first.
        await recordAccessEvent(db, { ...event, event: 'operator_access_emergency', detail: {
          purpose: s.purpose, access_level: s.accessLevel, requested_by: s.operatorId, approvers: [s.staffApproverOperatorId, approver.id],
        } });
        tell = 'operator_access_emergency';
        return second;
      });
      if (tell !== undefined) await tellApprovers(organisationId, sessionId, tell, ctx.correlationId);
      return view(result);
    },

    async start(ctx: StaffContext, organisationId: string, sessionId: string): Promise<SessionView> {
      return view(await tx(organisationId, async (db) => {
        const s = await locked(db, sessionId);
        if (s.operatorId !== ctx.staff.operator.id) throw notYours();
        if (s.status !== 'approved') throw conflict('not_approved', 'this session is not approved to start');
        const now = nowOf(deps);
        const started = await save(db, sessionId, {
          status: 'active', startsAt: now.toISOString(), expiresAt: expiryFor(s, now), recordingReference: `audit:operator_access_session:${sessionId}`,
        });
        // 13.5: "operator_access_started is read first: it names the person, purpose and approvers."
        await recordAccessEvent(db, {
          organisationId, correlationId: ctx.correlationId, sessionId, event: 'operator_access_started', actor: operatorActor(s.operatorId, sessionId),
          detail: {
            purpose: s.purpose, access_level: s.accessLevel, emergency: s.emergency, expires_at: started.expiresAt,
            approvers: [s.staffApproverOperatorId, s.staffSecondApproverOperatorId].filter((x): x is string => x !== null),
            customer_approver: s.approvedByMembershipId,
          },
        });
        return started;
      }));
    },

    async end(ctx: StaffContext, organisationId: string, sessionId: string): Promise<SessionView> {
      return view(await tx(organisationId, async (db) => {
        const s = await locked(db, sessionId);
        if (s.operatorId !== ctx.staff.operator.id) throw notYours();
        if (s.status !== 'active') throw conflict('not_running', 'this session is not running');
        const now = nowOf(deps);
        const ended = await save(db, sessionId, {
          status: 'ended', endedAt: now.toISOString(), endedReason: 'ended', recordingRetainedUntil: retainedUntil(now),
        });
        await recordAccessEvent(db, { organisationId, correlationId: ctx.correlationId, sessionId, event: 'operator_access_ended',
          actor: operatorActor(s.operatorId, sessionId), detail: { reason: 'ended', resources_touched: s.resourcesTouchedCount } });
        return ended;
      }));
    },

    /** The requester withdraws a request or an approved session that has not started. */
    async cancel(ctx: StaffContext, organisationId: string, sessionId: string): Promise<SessionView> {
      return view(await tx(organisationId, async (db) => {
        const s = await locked(db, sessionId);
        if (s.operatorId !== ctx.staff.operator.id) throw notYours();
        if (s.status !== 'requested' && s.status !== 'approved') throw conflict('not_cancellable', 'only a session that has not started is withdrawn');
        const cancelled = await save(db, sessionId, { status: 'cancelled' });
        await recordAccessEvent(db, { organisationId, correlationId: ctx.correlationId, sessionId, event: 'operator_access_ended',
          actor: operatorActor(s.operatorId, sessionId), detail: { reason: 'withdrawn_before_start' } });
        return cancelled;
      }));
    },

    /**
     * Before a request under a session: the requester's own session, running, at a level
     * that covers the request. The touch is counted and recorded in the customer's audit
     * log first; the context returned carries the session to the serving service.
     */
    async use(ctx: StaffContext, organisationId: string, sessionId: string, level: AccessLevel, touched: { type: string; id: string; route: string })
      : Promise<RequestContext> {
      await tx(organisationId, async (db) => {
        const s = await operatorAccessSessionRepo.findLive(db, sessionId, organisationId);
        if (s === undefined) throw conflict('not_running', 'this session is not running; start it, or ask for another');
        if (s.operatorId !== ctx.staff.operator.id) throw notYours();
        if (!levelCovers(s.accessLevel, level)) {
          throw new AppError('forbidden', `this needs a session at ${level} or above`, { code: 'operator_access.level_too_low', details: { level } });
        }
        const counted = await operatorAccessSessionRepo.touch(db, sessionId);
        // operator_access_used (63.6): the session's first use, in its lifecycle beside requested, approved and ended.
        if (counted?.resourcesTouchedCount === 1) {
          await recordAccessEvent(db, { organisationId, correlationId: ctx.correlationId, sessionId, event: 'operator_access_used',
            actor: operatorActor(s.operatorId, sessionId), resource: { type: 'operator_access_session', id: sessionId }, detail: { access_level: s.accessLevel } });
        }
        await recordAccessEvent(db, { organisationId, correlationId: ctx.correlationId, sessionId, event: 'operator_access_resource_touched',
          actor: operatorActor(s.operatorId, sessionId), resource: { type: touched.type, id: touched.id }, detail: { route: touched.route } });
      });
      return { organisationId, operatorSessionId: sessionId };
    },

    async get(organisationId: string, sessionId: string): Promise<SessionView> {
      const row = await read(organisationId, (db) => operatorAccessSessionRepo.findById(db, sessionId));
      if (row === undefined) throw notFound();
      return view(row);
    },

    /** Requested, approved and running sessions across organisations, oldest first, for staff. */
    async listOpen(limit: number): Promise<SessionView[]> {
      const ids = await inTransaction(control, {}, (db) => operatorAccessSessionRepo.openAcrossOrganisations(db, limit), { readOnly: true });
      const rows: SessionView[] = [];
      for (const { organisationId, id } of ids) {
        const row = await read(organisationId, (db) => operatorAccessSessionRepo.findById(db, id));
        if (row !== undefined) rows.push(view(row));
      }
      return rows;
    },

    /** Expires running sessions past their time (13.3). Returns how many. */
    async sweep(correlationId: string): Promise<number> {
      const due = await inTransaction(control, {}, (db) => operatorAccessSessionRepo.dueAcrossOrganisations(db, 100), { readOnly: true });
      let expired = 0;
      for (const { organisationId, id } of due) {
        await tx(organisationId, async (db) => {
          const s = await locked(db, id);
          if (s.status !== 'active' || Date.parse(s.expiresAt!) > nowOf(deps).getTime()) return;
          const now = nowOf(deps);
          await save(db, id, { status: 'expired', endedAt: now.toISOString(), endedReason: 'expired', recordingRetainedUntil: retainedUntil(now) });
          await recordAccessEvent(db, { organisationId, correlationId, sessionId: id, event: 'operator_access_expired',
            actor: { kind: 'service', service: 'admin-portal' }, detail: { resources_touched: s.resourcesTouchedCount } });
          expired += 1;
        });
      }
      return expired;
    },

    // ------------------------------------------------------------------------- the customer

    async customerList(request: RequestContext, query: { status?: Session['status'] | undefined; cursor?: string | undefined; limit: number }) {
      const rows = await inTransaction(control, request, (db) => operatorAccessSessionRepo.listForOrganisation(db, {
        status: query.status, before: decodeCursor(query.cursor), limit: query.limit + 1,
      }), { readOnly: true });
      const page = rows.slice(0, query.limit);
      return { sessions: page.map((r) => customerView(view(r))), nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
    },

    async customerGet(request: RequestContext, sessionId: string) {
      const row = await inTransaction(control, request, (db) => operatorAccessSessionRepo.findById(db, sessionId), { readOnly: true });
      if (row === undefined) throw notFound();
      return customerView(view(row));
    },

    /** The customer's approval or denial, after the staff approval (13.3). An emergency session takes none. */
    async customerDecide(request: RequestContext, correlationId: string, sessionId: string, input: { decision: 'approve' | 'deny'; reason?: string | undefined }) {
      const membershipId = request.membershipId!;
      if (input.reason !== undefined) assertNoValuePatterns(input.reason, 'reason');
      return customerView(view(await inTransaction(control, request, async (db) => {
        const s = await locked(db, sessionId);
        if (s.emergency) throw conflict('emergency', 'an emergency session is approved by two members of staff; revoke it to end it');
        if (s.status !== 'requested') throw conflict('decided', 'this session has been decided');
        if (s.staffApproverOperatorId === null) throw conflict('awaiting_staff', 'Silo has not approved this request yet; it reaches you after');
        const at = nowOf(deps).toISOString();
        const actor: AuditActor = { kind: 'membership', membershipId };
        if (input.decision === 'deny') {
          const denied = await save(db, sessionId, { status: 'denied', customerDecidedAt: at, deniedReason: input.reason! });
          await recordAccessEvent(db, { organisationId: s.organisationId, correlationId, sessionId, event: 'operator_access_denied', actor, detail: { by: 'customer' } });
          return denied;
        }
        const approved = await save(db, sessionId, { status: 'approved', approvedByMembershipId: membershipId, customerDecidedAt: at });
        await recordAccessEvent(db, { organisationId: s.organisationId, correlationId, sessionId, event: 'operator_access_approved', actor,
          detail: { by: 'customer' } });
        return approved;
      })));
    },

    /** Ends a running session at once, or withdraws one not yet started. */
    async customerRevoke(request: RequestContext, correlationId: string, sessionId: string) {
      const membershipId = request.membershipId!;
      return customerView(view(await inTransaction(control, request, async (db) => {
        const s = await locked(db, sessionId);
        const actor: AuditActor = { kind: 'membership', membershipId };
        if (s.status === 'active') {
          const now = nowOf(deps);
          const ended = await save(db, sessionId, {
            status: 'ended', endedAt: now.toISOString(), endedReason: 'revoked', endedByMembershipId: membershipId, recordingRetainedUntil: retainedUntil(now),
          });
          await recordAccessEvent(db, { organisationId: s.organisationId, correlationId, sessionId, event: 'operator_access_ended', actor,
            detail: { reason: 'revoked', resources_touched: s.resourcesTouchedCount } });
          return ended;
        }
        if (s.status === 'requested' || s.status === 'approved') {
          const withdrawn = await save(db, sessionId, { status: 'cancelled' });
          await recordAccessEvent(db, { organisationId: s.organisationId, correlationId, sessionId, event: 'operator_access_ended', actor,
            detail: { reason: 'revoked_before_start' } });
          return withdrawn;
        }
        throw conflict('finished', 'this session has finished');
      })));
    },

    async policy(request: RequestContext) {
      const organisation = await inTransaction(control, request, (db) => organisationRepo.findById(db, request.organisationId!), { readOnly: true });
      return { approvalRequired: organisation!.operatorAccessApprovalRequired, requiredByCell: deps.cell.sovereign };
    },

    async setPolicy(request: RequestContext, correlationId: string, approvalRequired: boolean) {
      const organisation = await inTransaction(control, request, async (db) => {
        const current = (await organisationRepo.findById(db, request.organisationId!))!;
        if (current.operatorAccessApprovalRequired === approvalRequired) return current;
        const updated = (await organisationRepo.update(db, current.id, { operatorAccessApprovalRequired: approvalRequired }))!;
        const payload = auditEventMessage.schema.parse({
          event: 'operator_access_policy_changed', actor: { kind: 'membership', membershipId: request.membershipId! }, subjectMembershipId: null,
          scopeId: null, resource: { type: 'organisation', id: current.id }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
          detail: { approval_required: approvalRequired },
        });
        await outboxRepo.insert(db, {
          id: uuidv7(), organisationId: current.id, topic: auditEventMessage.topic, orderingKey: current.id, event: auditEventMessage.name,
          schemaVersion: auditEventMessage.version, payload, correlationId,
        });
        return updated;
      });
      return { approvalRequired: organisation.operatorAccessApprovalRequired, requiredByCell: deps.cell.sovereign };
    },
  };
}

export type BreakGlass = ReturnType<typeof createBreakGlass>;
