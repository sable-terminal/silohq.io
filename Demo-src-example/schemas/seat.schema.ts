import { z } from 'zod';
import { uuid } from '../utils/schemas.util';

export const allocate = z.object({ membershipId: uuid }).strict();
export const seatParams = z.object({ seatId: uuid }).strict();

/**
 * Adding licences.
 *
 * BOUNDED AT BOTH ENDS. A batch of zero is a request that did nothing and looks
 * like it worked; an unbounded one is a typo that inserts a million rows and
 * bills for them.
 */
export const add = z.object({ count: z.coerce.number().int().min(1).max(500) }).strict();
