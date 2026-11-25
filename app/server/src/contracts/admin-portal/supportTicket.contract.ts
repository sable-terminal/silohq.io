// Support tickets (U4, D254): a member asks Silo support for help from inside Silo, and follows
// the replies. Owned by admin-portal, where Silo staff answer them (the staff side is in
// staffApi.contract.ts).
//
// - A ticket holds references and the person's own words, never a record value (spec 8.5). Its
//   subject and every message are refused when they match a value pattern (an address, a card
//   or account number, a National Insurance number, a long run of digits, a Silo token); the
//   person is asked to refer to things by choosing them instead (refs), and to quote failures by
//   their correlation id.
// - Who sees a ticket: the member who raised it, and holders of org.operator_access.view, who
//   oversee the organisation's dealings with Silo staff. Any member may raise one.
// - Its life: waiting on Silo when raised or replied to by the customer; waiting on the customer
//   when staff reply asking something; resolved by staff (a reply from the customer reopens it);
//   closed by the customer, for good.
// - A Silo staff access request (13.3) names the ticket it serves by its reference.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const SUPPORT_CATEGORIES = ['question', 'problem', 'access', 'billing', 'feature', 'security'] as const;
export const SUPPORT_SEVERITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const SUPPORT_STATUSES = ['waiting_on_silo', 'waiting_on_customer', 'resolved', 'closed'] as const;
/** What a ticket may be about, by reference. */
export const SUPPORT_REF_KINDS = [
  'connection', 'connector', 'object_type', 'object', 'action_type', 'receipt', 'approval_chain', 'cron', 'app', 'view', 'ask_thread',
  'scenario', 'pipeline', 'notebook', 'workbook', 'report', 'ml_model', 'ai_agent', 'silo', 'file', 'media_set', 'finding', 'ontology_proposal',
  'agent_pool', 'fde_engagement', 'operator_access_session',
] as const;

export const supportRef = z.strictObject({
  kind: z.enum(SUPPORT_REF_KINDS),
  id: z.uuid(),
  /** An object's type, where the reference is an object. */
  objectTypeId: z.uuid().optional(),
});
export type SupportRef = z.infer<typeof supportRef>;

export const SUPPORT_REFERENCE = /^SUP-[0-9A-HJKMNP-TV-Z]{8}$/;

export const supportTicketView = z.object({
  id: z.uuid(),
  reference: z.string().regex(SUPPORT_REFERENCE),
  subject: z.string(),
  category: z.enum(SUPPORT_CATEGORIES),
  severity: z.enum(SUPPORT_SEVERITIES),
  status: z.enum(SUPPORT_STATUSES),
  /** The page it was raised from. */
  place: z.string().nullable(),
  correlationIds: z.array(z.uuid()),
  refs: z.array(supportRef),
  raisedByMembershipId: z.uuid(),
  /** The member of staff looking after it, by name; null until one takes it. */
  assignedTo: z.string().nullable(),
  lastMessageAt: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  version: z.int().min(1),
});
export type SupportTicketView = z.infer<typeof supportTicketView>;

export const supportMessageView = z.object({
  id: z.uuid(),
  authorKind: z.enum(['member', 'staff']),
  /** A member's message: who wrote it (named from the organisation's directory). */
  authorMembershipId: z.uuid().nullable(),
  /** A staff message: the member of staff's name. */
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export type SupportMessageView = z.infer<typeof supportMessageView>;

export const supportTicketDetail = z.object({ ticket: supportTicketView, messages: z.array(supportMessageView) });

const subject = z.string().trim().min(1).max(200);
const body = z.string().trim().min(1).max(4000);
const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const ticketId = z.strictObject({ ticketId: z.uuid() });

export const raiseSupportTicket = defineContract({
  service: 'admin-portal', name: 'raiseSupportTicket', method: 'POST', path: '/v1/support/tickets', callers: ['gateway'],
  // Each call raises a ticket; the client keeps the form until the reply, so a retry is the person's.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    subject,
    category: z.enum(SUPPORT_CATEGORIES),
    severity: z.enum(SUPPORT_SEVERITIES).default('normal'),
    body,
    place: z.string().regex(/^\/[a-z0-9/_-]{0,199}$/).optional(),
    correlationIds: z.array(z.uuid()).max(10).default([]),
    refs: z.array(supportRef).max(20).default([]),
  }),
  response: supportTicketDetail, status: 201, maxBodyBytes: 16 * 1024,
});

export const listSupportTickets = defineContract({
  service: 'admin-portal', name: 'listSupportTickets', method: 'GET', path: '/v1/support/tickets', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    /** Open: waiting on Silo or on the customer. Done: resolved or closed. Both when absent. */
    state: z.enum(['open', 'done']).optional(),
    /** Only the member's own, even for one who may see every ticket. */
    mine: z.enum(['true', 'false']).default('false'),
    cursor: cursor.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }),
  response: z.object({
    tickets: z.array(supportTicketView),
    nextCursor: cursor.nullable(),
    /** Tickets the member can see that wait on the customer: the header's count. */
    waitingOnYou: z.int(),
    /** Whether the member sees every ticket of the organisation, or only their own. */
    seesAll: z.boolean(),
  }),
});

export const readSupportTicket = defineContract({
  service: 'admin-portal', name: 'readSupportTicket', method: 'GET', path: '/v1/support/tickets/:ticketId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: ticketId,
  response: supportTicketDetail,
});

export const replyToSupportTicket = defineContract({
  service: 'admin-portal', name: 'replyToSupportTicket', method: 'POST', path: '/v1/support/tickets/:ticketId/messages', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: ticketId,
  body: z.strictObject({ body, version: z.int().min(1) }),
  response: supportTicketDetail, status: 201, maxBodyBytes: 16 * 1024,
});

export const closeSupportTicket = defineContract({
  service: 'admin-portal', name: 'closeSupportTicket', method: 'POST', path: '/v1/support/tickets/:ticketId/close', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: ticketId,
  body: z.strictObject({ version: z.int().min(1) }),
  response: supportTicketDetail,
});

/** The permission that sees every ticket of the organisation, besides each raiser seeing their own. */
export const SEE_ALL_TICKETS = 'org.operator_access.view';
