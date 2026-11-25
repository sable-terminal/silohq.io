import { z } from 'zod';

/** Raising a ticket: the kind, and the message. Nothing else — see `ticket.service`. */

/**
 * THE FOUR KINDS ARE THE PANEL'S FOUR KINDS, and the same four the migration's
 * CHECK admits. `RAISE` in `ticket-panel.tsx` is the one table the panel and the
 * compose box share; this is the third place those keys appear and the one that
 * refuses a fifth.
 */
export const raiseTicket = z
  .object({
    kind: z.enum(['support', 'feature', 'security', 'partnership']),
    /*
     * 5000 BECAUSE THE BOX IS SIX ROWS AND SOMEBODY WILL PASTE A STACK TRACE
     * INTO IT. Short enough that it is a message rather than a file, long
     * enough that a real description of a real failure fits without being
     * silently cut — which is the failure mode worth avoiding here, because
     * what gets cut is the end, where the question usually is.
     */
    body: z.string().trim().min(1).max(5000),
  })
  .strict();

export const ticketId = z.object({ id: z.string().uuid() }).strict();
