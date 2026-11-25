import { z } from 'zod';

/**
 * §6 at the door.
 *
 * NOTHING HERE CARRIES A VALUE, and there is nowhere in a map to put one — §6.1
 * says references, counts and dispositions, and 036 gives the schema no column
 * that could hold anything else. What a caller may send is a name, a grantee and
 * an access level.
 */

export const createMap = z
  .object({
    name: z.string().min(1).max(128),
    /*
     * §6.4 — COPY FORKS. Naming a source here takes a snapshot that then learns
     * independently; the recipient's dismissals never reach the original, which
     * is what makes sharing safe under §6.2's one-map-per-person rule.
     */
    forkFromMapId: z.string().uuid().optional(),
  })
  .strict();

/*
 * ONE GRANTEE, NOT A COMBINATION. The same three `connection_grants` offers — a
 * person, a scope, or everybody — expressed as a union so "a person AND
 * everybody" cannot be typed, rather than as three optional fields checked
 * afterwards.
 */
const grantee = z.union([
  z.object({ membershipId: z.string().uuid() }).strict(),
  z.object({ scopeId: z.string().uuid() }).strict(),
  z.object({ organisationWide: z.literal(true) }).strict(),
]);

export const shareMap = z
  .object({
    grantee,
    /*
     * USE OR COPY, AND THERE IS NO EDIT. A map somebody else's dismissals write
     * into is a map that averages two people, which is what §6.2 refuses.
     */
    access: z.enum(['use', 'copy']),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
