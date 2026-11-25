// KEK rotation (spec 61.1, 61.2; key.rotate: a Silo operator role in the cell, never a tenant
// permission). Started through the admin portal by a member of staff holding key.rotate,
// naming the new key in the cell's provider; the credential service re-wraps every sealed
// row under it and retires the old version once nothing references it.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const startKeyRotation = defineContract({
  service: 'credential', name: 'startKeyRotation', method: 'POST', path: '/v1/key-rotations', callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  body: z.strictObject({
    /** The new key's reference in the cell's provider (created there by Terraform): never key material. */
    keyUri: z.string().min(1).max(1024),
    operatorId: z.uuid(),
  }),
  response: z.object({ keyVersionId: z.uuid(), previousKeyVersionId: z.uuid().nullable() }),
  status: 201,
});

/** The cell's key versions in use, and how many sealed rows a draining one still wraps. */
export const readKeyRotation = defineContract({
  service: 'credential', name: 'readKeyRotation', method: 'GET', path: '/v1/key-rotations', callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  response: z.object({
    versions: z.array(z.object({ id: z.uuid(), keyUri: z.string(), version: z.int(), status: z.enum(['active', 'decrypt_only', 'retired']), references: z.int() })),
  }),
});
