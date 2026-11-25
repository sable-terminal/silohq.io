import { z } from 'zod';

/**
 * §1 — what an administrator may say about SCIM.
 *
 * THE PROVISIONING ENDPOINTS ARE NOT VALIDATED HERE. A provider sends RFC 7643
 * documents whose shape varies between Entra and Okta in ways the standard
 * permits, and refusing one for a field this product does not read would break
 * a sync over something irrelevant. Those are read defensively in the
 * controller instead; these are the endpoints a person uses.
 */

const uuid = z.string().uuid();

export const issueToken = z.object({ name: z.string().min(1).max(128).trim() }).strict();

export const tokenParams = z.object({ id: uuid }).strict();

/**
 * What a directory group is authorised to carry.
 *
 * A ROLE REQUIRES A SCOPE, refused here and again in the service and again by a
 * CHECK constraint in 059. A role with no scope is an organisation-wide grant —
 * a super admin — and that is never something a directory group may confer.
 */
export const declareGroupGrant = z
  .object({
    groupId: uuid,
    scopeId: uuid.nullish(),
    roleId: uuid.nullish(),
  })
  .strict()
  .refine((value) => value.scopeId || value.roleId, {
    message: 'A mapping has to carry a scope, a role, or both.',
  })
  .refine((value) => !value.roleId || value.scopeId, {
    message: 'A directory group cannot carry an organisation-wide role. Name a scope.',
  });

export const grantParams = z.object({ id: uuid }).strict();
