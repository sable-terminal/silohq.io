import { z } from 'zod';
import { uuid } from '../utils/schemas.util';

/**
 * `expiresAt` IS A DATE, AND IT IS THE FEATURE. A grant that never expires is
 * the one nobody revokes — the contractor who left in March still holds finance
 * access in November because revoking it was somebody's third priority. Accepting
 * an expiry at grant time makes the temporary grant the easy one to write.
 *
 * COERCED FROM A STRING because JSON has no date type, and validated as a real
 * instant rather than accepted as text: `"tomorrow"` becoming `Invalid Date`
 * would reach the database as `null` and produce a permanent grant, which is the
 * exact opposite of what was asked for.
 */
const futureDate = z.coerce
  .date()
  .refine((d) => d.getTime() > Date.now(), 'An expiry has to be in the future.');

export const grantRole = z
  .object({
    targetMembershipId: uuid,
    roleId: uuid,
    scopeId: uuid.nullable(),
    expiresAt: futureDate.nullish(),
  })
  .strict();

export const assignmentParams = z.object({ assignmentId: uuid }).strict();

export const createMarking = z
  .object({
    name: z.string().min(1).max(64).trim(),
    kind: z.enum(['classification', 'compartment']),
    description: z.string().max(500).trim().nullish(),
  })
  .strict();

export const grantClearance = z
  .object({
    targetMembershipId: uuid,
    markingId: uuid,
    expiresAt: futureDate.nullish(),
  })
  .strict();

export const clearanceParams = z.object({ membershipId: uuid, markingId: uuid }).strict();

export const orphanedParams = z.object({ membershipId: uuid }).strict();

export type GrantRoleBody = z.infer<typeof grantRole>;
export type CreateMarkingBody = z.infer<typeof createMarking>;
export type GrantClearanceBody = z.infer<typeof grantClearance>;

/**
 * `scopeId` IS NOT NULLABLE HERE, unlike a grant to a person.
 *
 * A machine identity cannot hold organisation-wide authority — the service
 * refuses it — so the schema does not offer a way to ask. A nullable field that
 * is always rejected is a worse interface than a required one.
 */
export const grantToPrincipal = z
  .object({
    principalId: uuid,
    roleId: uuid,
    scopeId: uuid,
    expiresAt: futureDate.nullish(),
  })
  .strict();

export type GrantToPrincipalBody = z.infer<typeof grantToPrincipal>;
