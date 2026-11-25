import { z } from 'zod';

/**
 * SS10 at the door.
 *
 * -- NOTHING HERE CARRIES A VALUE --------------------------------------------
 *
 * A Silo is configured with NAMES: which concept, which fields of it, how long
 * to keep the result. The values themselves arrive through the capture path,
 * which rides on queries and has no HTTP surface of its own -- there is no
 * endpoint on this router that a caller could post customer data to, and that
 * is a property worth being able to check by reading one file.
 *
 * -- THE PURPOSE IS REQUIRED AND IT IS NOT DECORATION ------------------------
 *
 * SS10 makes a Silo something switched on DELIBERATELY, FOR A STATED PURPOSE.
 * A stated purpose that the schema treats as optional is a purpose nobody
 * states. It appears on the disclosure, in the audit trail, and on the screen
 * that asks a second person to approve a wipe.
 */

const purpose = z.string().trim().min(10).max(500);

/**
 * THE CEILING IS A SCHEMA CONSTRAINT, NOT A SETTING.
 *
 * The product's claim is that it stores nothing permanently. A retention window
 * a customer could type 36500 into makes that claim false while every screen
 * continues to display it, so the bound lives here where it cannot be
 * configured away. Two years is the longest any of the three detectors has a
 * use for; drift asks for the most and asks for 180 days.
 */
export const RETENTION_MAX_DAYS = 730;

const retentionDays = z.number().int().min(1).max(RETENTION_MAX_DAYS);

export const createSilo = z
  .object({
    name: z.string().trim().min(1).max(120),
    purpose,
    retentionDays,
  })
  .strict();

export const addConcept = z
  .object({
    conceptId: z.string().uuid(),
    /*
     * NOMINATED ONE AT A TIME, WHICH IS WHY THIS IS BOUNDED AND REQUIRED.
     * An empty array would mean "every field", and every field of a concept is
     * the copy of somebody's database this architecture exists to avoid.
     */
    fields: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  })
  .strict();

export const setRetention = z.object({ retentionDays }).strict();

/**
 * §3 and §11 — the switch, and the version of the disclosure that was read.
 *
 * OPTIONAL HERE, REQUIRED TO SWITCH ON. Switching off needs nobody to read
 * anything; switching on is refused by the service without the current
 * version, because only the service knows what the current version is.
 */
export const setStorage = z
  .object({
    enabled: z.boolean(),
    acknowledgedDisclosure: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();

const nominatedFields = z.array(z.string().trim().min(1).max(200)).min(1).max(50);

/** §4 — replacing the fields a concept captures. Same bounds as nominating them. */
export const setFields = z.object({ fields: nominatedFields }).strict();

/**
 * SS9 -- the wipe, and the three scopes are deliberately not one button.
 *
 * A DISCRIMINATED UNION, BECAUSE THE SCOPE IS THE DELETE. The first version took
 * `scope` plus two optional targets and let the service work out which applied,
 * so `{ scope: 'silo', conceptId }` deleted one concept, disabled the whole Silo
 * and issued a whole-Silo receipt. Each scope now accepts exactly its own
 * target and nothing else.
 *
 * AN ENTITY IS NAMED WITHIN A CONCEPT. The same identifier in two concepts is
 * two different records.
 */
export const purge = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('silo') }).strict(),
  z.object({ scope: z.literal('concept'), conceptId: z.string().uuid() }).strict(),
  z
    .object({
      scope: z.literal('entity'),
      conceptId: z.string().uuid(),
      entityRef: z.string().trim().min(1).max(512),
    })
    .strict(),
  /* Import §11 — one file with everything read out of it; one imported object. */
  z.object({ scope: z.literal('file'), fileId: z.string().uuid() }).strict(),
  z
    .object({
      scope: z.literal('object'),
      sourceId: z.string().uuid(),
      objectName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
    })
    .strict(),
]);
