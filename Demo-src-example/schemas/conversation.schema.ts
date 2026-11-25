import { z } from 'zod';

/** PRODUCT §2.2 — a thread, kept: the words, never the answer's data. */

const title = z.string().trim().min(1).max(120);

export const createConversation = z
  .object({ title, asked: z.string().trim().min(1).max(2000).optional() })
  .strict();

export const conversationId = z.object({ id: z.string().uuid() }).strict();

export const renameConversation = z.object({ title }).strict();

/**
 * One exchange.
 *
 * `said` IS A LINE, NOT AN ANSWER. The prose's first sentence, a refusal in the
 * model's words, or a change's intent — never rows, readings or a plan, which
 * is what makes this a thread rather than a cache of somebody's data.
 */
export const addTurn = z
  .object({
    asked: z.string().trim().min(1).max(2000),
    said: z.string().max(2000).default(''),
    kind: z.enum(['answered', 'refused', 'ambiguous', 'change', 'view']),
  })
  .strict();
