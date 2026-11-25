import { z } from 'zod';
import { uuid } from '../utils/schemas.util';

export const createPrincipal = z
  .object({
    name: z.string().min(1).max(128).trim(),
    description: z.string().max(500).trim().nullish(),
  })
  .strict();

export const principalParams = z.object({ principalId: uuid }).strict();
export const keyParams = z.object({ keyId: uuid }).strict();
export const setDisabled = z.object({ disabled: z.boolean() }).strict();

/**
 * `expiresInDays` IS REQUIRED, with no default.
 *
 * A default would be chosen once, by whoever wrote this line, and then never
 * thought about again — which is how every key in the estate ends up with the
 * same lifetime regardless of what it is for. Making it required forces one
 * decision per key, at the moment somebody actually knows the answer.
 */
export const issueKey = z
  .object({
    name: z.string().min(1).max(128).trim(),
    expiresInDays: z.coerce.number().int().min(1).max(365),
  })
  .strict();
