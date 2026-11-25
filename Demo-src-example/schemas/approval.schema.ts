import { z } from 'zod';

/**
 * The approval chain at the door.
 *
 * A REJECTION CARRIES ITS REASON. The person who asked needs to know what to
 * change, and "no" with nothing after it is a decision nobody can act on. An
 * approval may carry one.
 */

const reason = z.string().trim().min(1).max(1000);

export const action = z.object({ action: z.enum(['silo.purge', 'mutation.purge']) }).strict();

export const setPolicy = z
  .object({ approvalsRequired: z.number().int().min(1).max(5) })
  .strict();

export const requestId = z.object({ id: z.string().uuid() }).strict();

export const approve = z.object({ reason: reason.optional() }).strict();

export const reject = z.object({ reason }).strict();

export const listRequests = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed', 'failed']).optional(),
  })
  .strict();
