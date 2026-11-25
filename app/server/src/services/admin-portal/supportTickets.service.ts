// Support tickets (U4, D254): members ask Silo support for help from inside Silo; Silo staff
// answer from the staff console. See contracts/admin-portal/supportTicket.contract.ts.
//
// - References and the person's own words only, never a record value (spec 8.5): a subject or
//   message matching a value pattern is refused, naming the kinds matched, never the text.
// - A member sees the tickets they raised; a holder of org.operator_access.view sees every
//   ticket of the organisation (listing asks policy without recording a refusal; opening
//   another's ticket is a decision, and a refusal is recorded).
// - Each change is a version: two people replying at once never overwrite each other.
// - Every raise, reply and change is an event in the organisation's audit log; a staff reply
//   tells the raiser (support_replied), in the product and by email.
// - Staff read a ticket's own words without break-glass: they are what the customer chose to
//   send. Anything inside the organisation still takes a session (13.3), naming the ticket.

import { randomInt } from 'node:crypto';
import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import { raiseNotification } from '../../contracts/notify/notification.contract.ts';
import { authorise, listHeldPermissions } from '../../contracts/policy/decision.contract.ts';
import {
  SEE_ALL_TICKETS, type SupportMessageView, type SupportRef, type SupportTicketView,
} from '../../contracts/admin-portal/supportTicket.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { SupportTicket } from '../../models/platform/supportTicket.model.ts';
import type { SupportTicketMessage } from '../../models/platform/supportTicketMessage.model.ts';
import { membershipRepo, organisationRepo } from '../../repos/iam/index.repo.ts';
import { outboxRepo, supportTicketMessageRepo, supportTicketRepo } from '../../repos/platform/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { findValuePatterns } from '../../utils/redaction.util.ts';
import { nowOf, type AdminPortalDeps, type StaffContext } from './deps.service.ts';

const notFound = (): AppError => new AppError('not_found', 'no such ticket', { code: 'support.ticket_not_found' });
const stale = (): AppError => new AppError('conflict', 'the ticket changed since you read it: read it again', { code: 'support.ticket_stale' });
const closed = (): AppError => new AppError('conflict', 'the ticket is closed: raise a new one', { code: 'support.ticket_closed' });

/** Refuses text that looks like it carries a record value: the kinds are named, never the text. */
function refuseValues(text: string, field: string): void {
  const kinds = findValuePatterns(text);
  if (kinds.length === 0) return;
  throw new AppError('validation', `the ${field} looks like it holds a value (${kinds.map((k) => k.replaceAll('_', ' ')).join(', ')}): describe it, and refer to things by choosing them`, {
    code: 'support.value_pattern', details: { field, kinds: kinds.join(',') },
  });
}

/** SUP- and eight Crockford base-32 characters: about a trillion, read aloud without confusion. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newReference = (): string => `SUP-${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;

const encodeCursor = (t: SupportTicket): string => Buffer.from(`${t.lastMessageAt}|${t.id}`, 'utf8').toString('base64url');
function decodeCursor(cursor: string | undefined): { lastMessageAt: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const [lastMessageAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!lastMessageAt || !id || Number.isNaN(Date.parse(lastMessageAt)) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new AppError('validation', 'the cursor is not one this service issued', { code: 'support.cursor_invalid' });
  }
  return { lastMessageAt, id };
}

export function ticketView(t: SupportTicket): SupportTicketView {
  return {
    id: t.id, reference: t.reference, subject: t.subject, category: t.category, severity: t.severity, status: t.status, place: t.place,
    correlationIds: t.correlationIds, refs: (t.refs as SupportRef[] | null) ?? [], raisedByMembershipId: t.raisedByMembershipId,
    assignedTo: t.assignedOperatorDisplayName, lastMessageAt: t.lastMessageAt, createdAt: t.createdAt, resolvedAt: t.resolvedAt,
    closedAt: t.closedAt, version: t.version,
  };
}

export const messageView = (m: SupportTicketMessage): SupportMessageView => ({
  id: m.id, authorKind: m.authorKind, authorMembershipId: m.authorMembershipId, authorName: m.authorDisplayName, body: m.body, createdAt: m.createdAt,
});

async function recordSupportEvent(db: Queryable, e: {
  organisationId: string; correlationId: string; event: 'support_ticket_raised' | 'support_ticket_replied' | 'support_ticket_updated';
  actor: AuditActor; ticketId: string; detail?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor: e.actor, subjectMembershipId: null, scopeId: null, resource: { type: 'support_ticket', id: e.ticketId },
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: e.organisationId, topic: auditEventMessage.topic, orderingKey: e.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: e.correlationId,
  });
}

/** Staff act as admin-portal in the customer's log, naming the member of staff. */
const staffActor: AuditActor = { kind: 'service', service: 'admin-portal' };

interface Member { organisationId: string; membershipId: string; correlationId: string; request: HandlerContext['request'] }

function memberOf(ctx: HandlerContext): Member {
  const { organisationId, membershipId } = ctx.request;
  if (organisationId === undefined || membershipId === undefined) {
    throw new AppError('forbidden', 'support tickets are a member\'s', { code: 'support.member_required' });
  }
  return { organisationId, membershipId, correlationId: ctx.correlationId, request: ctx.request };
}

export function createSupportTickets(deps: AdminPortalDeps) {
  const control = deps.databases.pool('control');
  const tx = <T>(organisationId: string, work: (db: Queryable) => Promise<T>, membershipId?: string) =>
    inTransaction(control, { organisationId, ...(membershipId === undefined ? {} : { membershipId }) }, work);
  const read = <T>(organisationId: string, work: (db: Queryable) => Promise<T>) => inTransaction(control, { organisationId }, work, { readOnly: true });

  /** Whether the member sees every ticket: asked of policy without recording a refusal. */
  const seesAll = async (member: Member): Promise<boolean> => {
    const { held } = await deps.services.call(listHeldPermissions, { body: { permissions: [SEE_ALL_TICKETS] } },
      { request: member.request, correlationId: member.correlationId });
    return held.includes(SEE_ALL_TICKETS);
  };

  /** A ticket the member may open: their own, or any where they hold the permission (a decision, recorded when refused). */
  const visible = async (member: Member, ticket: SupportTicket | undefined): Promise<SupportTicket> => {
    if (ticket === undefined) throw notFound();
    if (ticket.raisedByMembershipId === member.membershipId) return ticket;
    const decision = await deps.services.call(authorise, { body: { permission: SEE_ALL_TICKETS } }, { request: member.request, correlationId: member.correlationId });
    if (decision.decision !== 'allow') throw notFound();
    return ticket;
  };

  const detail = async (db: Queryable, ticket: SupportTicket) => ({
    ticket: ticketView(ticket), messages: (await supportTicketMessageRepo.listForTicket(db, ticket.id)).map(messageView),
  });

  /** Tells the raiser that support replied: in the product and by email. Best effort: the ticket is the record. */
  const tellRaiser = async (ticket: SupportTicket, messageId: string, correlationId: string): Promise<void> => {
    try {
      await deps.services.call(raiseNotification, {
        body: { recipientMembershipId: ticket.raisedByMembershipId, kind: 'support_replied', source: { supportTicketMessageId: messageId, supportTicketId: ticket.id },
          channels: ['in_app', 'email'] },
      }, { request: { organisationId: ticket.organisationId }, correlationId });
    } catch (error) {
      deps.logger.failure('a support reply notification was not raised', error, {
        event: 'support.notify_failed', resourceType: 'support_ticket', resourceId: ticket.id, correlationId,
      });
    }
  };

  /** A staff-side view: the organisation and the raiser by name. */
  const staffView = async (db: Queryable, ticket: SupportTicket, withMessages: boolean) => {
    const organisation = await organisationRepo.findById(db, ticket.organisationId);
    const [raiser] = await membershipRepo.listWithScopes(db, { membershipId: ticket.raisedByMembershipId, limit: 1 });
    return {
      ticket: ticketView(ticket),
      organisation: { id: ticket.organisationId, name: organisation?.name ?? '', slug: organisation?.slug ?? '' },
      raisedByName: raiser?.displayName ?? 'a member',
      ...(withMessages ? { messages: (await supportTicketMessageRepo.listForTicket(db, ticket.id)).map(messageView) } : {}),
    };
  };

  /** A ticket found by its reference, across organisations, with its organisation's context. */
  const locate = async (reference: string): Promise<{ organisationId: string; id: string }> => {
    const found = await inTransaction(control, {}, (db) => supportTicketRepo.locateByReference(db, reference), { readOnly: true });
    if (found === undefined) throw notFound();
    return found;
  };

  return {
    // ------------------------------------------------------------------------- members

    async raise(ctx: HandlerContext, input: {
      subject: string; category: SupportTicket['category']; severity: SupportTicket['severity']; body: string;
      place?: string | undefined; correlationIds: string[]; refs: SupportRef[];
    }) {
      const member = memberOf(ctx);
      refuseValues(input.subject, 'subject');
      refuseValues(input.body, 'message');
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await tx(member.organisationId, async (db) => {
            const ticket = await supportTicketRepo.insert(db, {
              id: uuidv7(), organisationId: member.organisationId, reference: newReference(), raisedByMembershipId: member.membershipId,
              subject: input.subject, category: input.category, severity: input.severity, place: input.place ?? null,
              correlationIds: [...new Set(input.correlationIds)],
              refs: input.refs.map((r) => ({ kind: r.kind, id: r.id, ...(r.objectTypeId === undefined ? {} : { objectTypeId: r.objectTypeId }) })),
            });
            await supportTicketMessageRepo.insert(db, {
              id: uuidv7(), organisationId: member.organisationId, ticketId: ticket.id, authorKind: 'member', authorMembershipId: member.membershipId, body: input.body,
            });
            await recordSupportEvent(db, {
              organisationId: member.organisationId, correlationId: member.correlationId, event: 'support_ticket_raised',
              actor: { kind: 'membership', membershipId: member.membershipId }, ticketId: ticket.id,
              detail: { category: input.category, severity: input.severity, references: input.refs.length, requests: input.correlationIds.length },
            });
            return detail(db, ticket);
          }, member.membershipId);
        } catch (error) {
          // A reference already taken (one in a trillion): another is drawn.
          if (attempt < 3 && isAppError(error) && error.details['sqlstate'] === '23505') continue;
          throw error;
        }
      }
    },

    async list(ctx: HandlerContext, query: { state?: 'open' | 'done' | undefined; mine: boolean; cursor?: string | undefined; limit: number }) {
      const member = memberOf(ctx);
      const all = await seesAll(member);
      const raisedBy = all && !query.mine ? undefined : member.membershipId;
      return read(member.organisationId, async (db) => {
        const rows = await supportTicketRepo.list(db, { raisedBy, state: query.state, before: decodeCursor(query.cursor), limit: query.limit + 1 });
        const page = rows.slice(0, query.limit);
        return {
          tickets: page.map(ticketView), nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null,
          waitingOnYou: await supportTicketRepo.waitingOnCustomer(db, all ? undefined : member.membershipId), seesAll: all,
        };
      });
    },

    async read(ctx: HandlerContext, ticketId: string) {
      const member = memberOf(ctx);
      const ticket = await visible(member, await read(member.organisationId, (db) => supportTicketRepo.findById(db, ticketId)));
      return read(member.organisationId, (db) => detail(db, ticket));
    },

    async reply(ctx: HandlerContext, ticketId: string, input: { body: string; version: number }) {
      const member = memberOf(ctx);
      refuseValues(input.body, 'message');
      await visible(member, await read(member.organisationId, (db) => supportTicketRepo.findById(db, ticketId)));
      return tx(member.organisationId, async (db) => {
        const ticket = await supportTicketRepo.lock(db, ticketId);
        if (ticket === undefined) throw notFound();
        if (ticket.status === 'closed') throw closed();
        if (ticket.version !== input.version) throw stale();
        const at = nowOf(deps).toISOString();
        await supportTicketMessageRepo.insert(db, {
          id: uuidv7(), organisationId: member.organisationId, ticketId, authorKind: 'member', authorMembershipId: member.membershipId, body: input.body,
        });
        // The customer's word puts it back with Silo, a resolved ticket included.
        const updated = (await supportTicketRepo.update(db, ticketId, {
          status: 'waiting_on_silo', resolvedAt: null, lastMessageAt: at, version: ticket.version + 1,
        }))!;
        await recordSupportEvent(db, {
          organisationId: member.organisationId, correlationId: member.correlationId, event: 'support_ticket_replied',
          actor: { kind: 'membership', membershipId: member.membershipId }, ticketId, detail: { by: 'member', reopened: ticket.status === 'resolved' },
        });
        return detail(db, updated);
      }, member.membershipId);
    },

    async close(ctx: HandlerContext, ticketId: string, input: { version: number }) {
      const member = memberOf(ctx);
      await visible(member, await read(member.organisationId, (db) => supportTicketRepo.findById(db, ticketId)));
      return tx(member.organisationId, async (db) => {
        const ticket = await supportTicketRepo.lock(db, ticketId);
        if (ticket === undefined) throw notFound();
        if (ticket.status === 'closed') return detail(db, ticket);
        if (ticket.version !== input.version) throw stale();
        const at = nowOf(deps).toISOString();
        const updated = (await supportTicketRepo.update(db, ticketId, {
          status: 'closed', closedAt: at, resolvedAt: ticket.resolvedAt ?? at, version: ticket.version + 1,
        }))!;
        await recordSupportEvent(db, {
          organisationId: member.organisationId, correlationId: member.correlationId, event: 'support_ticket_updated',
          actor: { kind: 'membership', membershipId: member.membershipId }, ticketId, detail: { status: 'closed' },
        });
        return detail(db, updated);
      }, member.membershipId);
    },

    // ------------------------------------------------------------------------- Silo staff

    async queue(ctx: StaffContext, limit: number) {
      const ids = await inTransaction(control, {}, (db) => supportTicketRepo.waitingAcrossOrganisations(db, limit), { readOnly: true });
      const tickets = [];
      for (const { organisationId, id } of ids) {
        const one = await read(organisationId, async (db) => {
          const ticket = await supportTicketRepo.findById(db, id);
          return ticket === undefined ? undefined : staffView(db, ticket, false);
        });
        if (one !== undefined) tickets.push(one);
      }
      deps.logger.info('support queue read', { event: 'support.queue_read', correlationId: ctx.correlationId });
      return { tickets };
    },

    async readForStaff(ctx: StaffContext, reference: string) {
      const { organisationId, id } = await locate(reference);
      deps.logger.info('support ticket read', { event: 'support.ticket_read', correlationId: ctx.correlationId, resourceType: 'support_ticket', resourceId: id });
      return read(organisationId, async (db) => staffView(db, (await supportTicketRepo.findById(db, id))!, true));
    },

    async replyAsStaff(ctx: StaffContext, reference: string, input: { body: string; status: 'waiting_on_customer' | 'resolved' }) {
      refuseValues(input.body, 'message');
      const { organisationId, id } = await locate(reference);
      const operator = ctx.staff.operator;
      const { view, ticket, messageId } = await tx(organisationId, async (db) => {
        const locked = await supportTicketRepo.lock(db, id);
        if (locked === undefined) throw notFound();
        if (locked.status === 'closed') throw closed();
        const at = nowOf(deps).toISOString();
        const message = await supportTicketMessageRepo.insert(db, {
          id: uuidv7(), organisationId, ticketId: id, authorKind: 'staff', authorOperatorId: operator.id, authorDisplayName: operator.displayName, body: input.body,
        });
        const updated = (await supportTicketRepo.update(db, id, {
          status: input.status, resolvedAt: input.status === 'resolved' ? at : null, lastMessageAt: at, version: locked.version + 1,
          ...(locked.assignedOperatorId === null ? { assignedOperatorId: operator.id, assignedOperatorDisplayName: operator.displayName } : {}),
        }))!;
        await recordSupportEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'support_ticket_replied', actor: staffActor, ticketId: id,
          detail: { by: 'staff', operator_id: operator.id, status: input.status },
        });
        return { view: await staffView(db, updated, true), ticket: updated, messageId: message.id };
      });
      await tellRaiser(ticket, messageId, ctx.correlationId);
      return view;
    },

    async updateAsStaff(ctx: StaffContext, reference: string, input: {
      status?: 'waiting_on_silo' | 'waiting_on_customer' | 'resolved' | undefined; severity?: SupportTicket['severity'] | undefined; take?: true | undefined;
    }) {
      const { organisationId, id } = await locate(reference);
      const operator = ctx.staff.operator;
      return tx(organisationId, async (db) => {
        const locked = await supportTicketRepo.lock(db, id);
        if (locked === undefined) throw notFound();
        if (locked.status === 'closed') throw closed();
        const at = nowOf(deps).toISOString();
        const updated = (await supportTicketRepo.update(db, id, {
          ...(input.status === undefined ? {} : { status: input.status, resolvedAt: input.status === 'resolved' ? locked.resolvedAt ?? at : null }),
          ...(input.severity === undefined ? {} : { severity: input.severity }),
          ...(input.take === true ? { assignedOperatorId: operator.id, assignedOperatorDisplayName: operator.displayName } : {}),
          version: locked.version + 1,
        }))!;
        await recordSupportEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'support_ticket_updated', actor: staffActor, ticketId: id,
          detail: { by: 'staff', operator_id: operator.id, status: input.status ?? null, severity: input.severity ?? null, taken: input.take === true },
        });
        return staffView(db, updated, true);
      });
    },
  };
}

export type SupportTickets = ReturnType<typeof createSupportTickets>;
