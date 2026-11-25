import { z } from 'zod';

/**
 * Field policies at the door.
 *
 * A POLICY TARGETS ONE OF A ROLE, A MARKING OR A SCOPE, OR NOBODY IN PARTICULAR,
 * in which case it applies to everybody. Every target is optional and none is
 * defaulted to something broader than was sent.
 */

export const createFieldPolicy = z
  .object({
    connectionId: z.string().uuid(),
    fieldPath: z.string().min(1).max(256),
    effect: z.enum(['deny', 'mask', 'redact']),
    appliesToRoleId: z.string().uuid().nullable().default(null),
    appliesToMarkingId: z.string().uuid().nullable().default(null),
    appliesToScopeId: z.string().uuid().nullable().default(null),
    includeDescendants: z.boolean().default(true),
  })
  .strict();

export const fieldPolicyId = z.object({ id: z.string().uuid() }).strict();
