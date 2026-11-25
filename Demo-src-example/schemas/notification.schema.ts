import { z } from 'zod';

/** One of this person's own notifications. */
export const notificationId = z.object({ id: z.string().uuid() }).strict();
