// Support tickets and the help centre (the header's ticket and question-mark icons): the homes of
// the support routes, which are neither a sidebar section nor a setting.

import type { RouteName } from '../api/client.api.ts';

export const SUPPORT_ROUTES: readonly RouteName[] = [
  'raiseSupportTicket', 'listSupportTickets', 'readSupportTicket', 'replyToSupportTicket', 'closeSupportTicket',
];
