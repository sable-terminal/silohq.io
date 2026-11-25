// Support tickets at the edge (U4, D254): a member raises a ticket, follows its replies, answers
// and closes it. admin-portal decides who sees which ticket (the raiser, or a holder of
// org.operator_access.view), so these routes name no permission; any member may raise one.

import * as t from '../admin-portal/supportTicket.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

const DECIDES = 'admin-portal shows a ticket to the member who raised it and to holders of org.operator_access.view; any member may raise one';

export const raiseSupportTicket = definePublicRoute({
  name: 'raiseSupportTicket', method: 'POST', path: '/support/tickets', session: 'complete', decidedByService: DECIDES,
  body: t.raiseSupportTicket.body, response: t.raiseSupportTicket.response, status: 201, forwards: t.raiseSupportTicket,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listSupportTickets = definePublicRoute({
  name: 'listSupportTickets', method: 'GET', path: '/support/tickets', session: 'complete', decidedByService: DECIDES,
  query: t.listSupportTickets.query, response: t.listSupportTickets.response, forwards: t.listSupportTickets,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const readSupportTicket = definePublicRoute({
  name: 'readSupportTicket', method: 'GET', path: '/support/tickets/:ticketId', session: 'complete', decidedByService: DECIDES,
  params: t.readSupportTicket.params, response: t.readSupportTicket.response, forwards: t.readSupportTicket,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const replyToSupportTicket = definePublicRoute({
  name: 'replyToSupportTicket', method: 'POST', path: '/support/tickets/:ticketId/messages', session: 'complete', decidedByService: DECIDES,
  params: t.replyToSupportTicket.params, body: t.replyToSupportTicket.body, response: t.replyToSupportTicket.response, status: 201,
  forwards: t.replyToSupportTicket,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const closeSupportTicket = definePublicRoute({
  name: 'closeSupportTicket', method: 'POST', path: '/support/tickets/:ticketId/close', session: 'complete', decidedByService: DECIDES,
  params: t.closeSupportTicket.params, body: t.closeSupportTicket.body, response: t.closeSupportTicket.response, forwards: t.closeSupportTicket,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const SUPPORT_ROUTES = [raiseSupportTicket, listSupportTickets, readSupportTicket, replyToSupportTicket, closeSupportTicket] as const;
