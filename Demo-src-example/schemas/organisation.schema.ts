import { z } from 'zod';

/**
 * §7.3 — the calendar every period is measured against.
 *
 * THE ZONE IS SHAPE-CHECKED HERE AND EXISTENCE-CHECKED IN THE SERVICE. A regex
 * cannot know whether `Europe/Londn` is a zone, and the list that does know is
 * the runtime's own — so this rejects what could never be a zone name at all
 * and the service rejects what merely is not one.
 */
export const setCalendar = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+){0,2}$/, 'That is not a time zone.'),
    /*
     * A MONTH, NOT A DATE. No organisation's reporting year starts on the 6th
     * of April even where its tax year does, and allowing a day would make
     * every quarter boundary a different arithmetic.
     */
    yearStartsInMonth: z.number().int().min(1).max(12),
  })
  .strict();

/**
 * §6.1 — the ceiling on who a view may be shared with.
 *
 * A CLOSED SET, matching the CHECK in 036. The service asks `assertSharingPolicy`
 * as well, because the same value arrives from places this schema does not
 * guard and one of them must not be able to write a policy nothing enforces.
 */
export const setSharingPolicy = z
  .object({
    sharingPolicy: z.enum(['open', 'scope_only', 'explicit_only', 'disabled']),
  })
  .strict();

/**
 * A logo, as JSON rather than as a multipart upload.
 *
 * BASE64 IN THE BODY, BOUNDED BY THE BODY LIMIT. Express is configured for
 * 256kb, which is a generous logo and a useless payload for anything else —
 * so the ceiling is already there and needs no second number that could
 * disagree with it. Adding a multipart parser for one endpoint would put a
 * whole new parsing surface in front of an unauthenticated-adjacent path.
 *
 * THE DECLARED TYPE IS A SUGGESTION AND IS TREATED AS ONE. What the file
 * actually is gets decided from its bytes in the service; this only records
 * what the uploader claimed so the mismatch can be noticed.
 */
export const setLogo = z
  .object({
    filename: z.string().min(1).max(200),
    contentType: z.string().min(1).max(100).optional(),
    /* Base64, so roughly 4/3 of the real size. */
    data: z.string().min(1).max(300_000),
  })
  .strict();

/** §3.7 — prebuilt connectors kept current by themselves, or not. */
export const setConnectorUpdates = z.object({ autoAdoptPrebuilt: z.boolean() }).strict();
