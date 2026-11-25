import { z } from 'zod';
import { uuid } from '../utils/schemas.util';

/**
 * `parentId` IS `null`, NEVER ABSENT. A missing key and an explicit null mean
 * different things here — "leave it where it is" and "make this a root" — and a
 * `.optional()` would make the second unsayable. Creating a root scope and moving
 * a scope to the root are both super-admin operations precisely because they
 * change who administers a whole subtree, so the request has to be able to ask
 * for it unambiguously.
 */

export const createScopeType = z
  .object({
    name: z.string().min(1).max(64).trim(),
    icon: z.string().max(64).nullish(),
    colour: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour, like #4C1D95.')
      .nullish(),
  })
  .strict();

export const createScope = z
  .object({
    name: z.string().min(1).max(128).trim(),
    scopeTypeId: uuid,
    parentId: uuid.nullable(),
  })
  .strict();

export const moveScope = z.object({ newParentId: uuid.nullable() }).strict();

export const scopeParams = z.object({ scopeId: uuid }).strict();

export const addScopeMember = z
  .object({ membershipId: uuid, isPrimary: z.boolean().optional() })
  .strict();

export const scopeMemberParams = z.object({ scopeId: uuid, membershipId: uuid }).strict();

export type CreateScopeTypeBody = z.infer<typeof createScopeType>;
export type CreateScopeBody = z.infer<typeof createScope>;
export type MoveScopeBody = z.infer<typeof moveScope>;
export type AddScopeMemberBody = z.infer<typeof addScopeMember>;
