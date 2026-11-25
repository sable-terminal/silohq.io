// The member's side of support tickets, forwarded by the gateway: thin, over
// services/admin-portal/supportTickets. The service decides who sees which ticket; the member
// comes from the request context.

import type * as t from '../../contracts/admin-portal/supportTicket.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { SupportTickets } from '../../services/admin-portal/supportTickets.service.ts';

export interface SupportTicketHandlers {
  raise: RouteHandlers<typeof t.raiseSupportTicket>;
  list: RouteHandlers<typeof t.listSupportTickets>;
  read: RouteHandlers<typeof t.readSupportTicket>;
  reply: RouteHandlers<typeof t.replyToSupportTicket>;
  close: RouteHandlers<typeof t.closeSupportTicket>;
}

export function supportTicketController(tickets: SupportTickets): SupportTicketHandlers {
  return {
    raise: { handle: (input, ctx) => tickets.raise(ctx, input.body) },
    list: { handle: (input, ctx) => tickets.list(ctx, { state: input.query.state, mine: input.query.mine === 'true', cursor: input.query.cursor, limit: input.query.limit }) },
    read: { handle: (input, ctx) => tickets.read(ctx, input.params.ticketId) },
    reply: { handle: (input, ctx) => tickets.reply(ctx, input.params.ticketId, input.body) },
    close: { handle: (input, ctx) => tickets.close(ctx, input.params.ticketId, input.body) },
  };
}
