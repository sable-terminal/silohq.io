import { z } from 'zod';
import { email, uuid } from '../utils/schemas.util';

export const listMembers = z
  .object({ status: z.enum(['invited', 'active', 'suspended', 'removed']).optional() })
  .strict();

export const memberParams = z.object({ membershipId: uuid }).strict();

export const invite = z
  .object({
    email,
    roleId: uuid.nullish(),
    scopeId: uuid.nullish(),
    seatId: uuid.nullish(),
  })
  .strict();

/**
 * Accepting an invitation.
 *
 * THE NAME AND PASSWORD ARE OPTIONAL BECAUSE TWO DIFFERENT PEOPLE USE THIS. A
 * new person is creating an account and must supply both; an existing Silo user
 * invited into a second organisation already has both, and asking them to set a
 * password again would either overwrite the one they have or create a second
 * credential for the same identity. The service decides which case it is from
 * whether the address is already known.
 */
export const acceptInvitation = z
  .object({
    token: z.string().min(20).max(500),
    email,
    password: z.string().min(12).max(200).optional(),
    firstName: z.string().min(1).max(100).trim().optional(),
    lastName: z.string().min(1).max(100).trim().optional(),
    // See `auth.schema` — declared because the object is strict.
    turnstileToken: z.string().max(4096).optional(),
  })
  .strict();

export const previewInvitation = z.object({ token: z.string().min(20).max(500) }).strict();

export type ListMembersQuery = z.infer<typeof listMembers>;
export type InviteBody = z.infer<typeof invite>;
export type AcceptInvitationBody = z.infer<typeof acceptInvitation>;
