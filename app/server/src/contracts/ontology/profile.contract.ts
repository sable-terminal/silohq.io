// ontology: field profiles (spec 22.3), the counts derivation reads and a confirming person
// sees. Profiling reaches the source through connect-runtime, which returns counts only;
// nothing here can hold a value.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { WRITERS } from './element.contract.ts';

const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const fieldProfileView = z.object({
  sourceObject: z.string(),
  fieldPath: z.string(),
  rowCount: z.int(),
  /** Exact, or null when the object had more rows than were examined. */
  distinctCount: z.int().nullable(),
  nullCount: z.int(),
  emptyCount: z.int(),
  minLength: z.int().nullable(),
  maxLength: z.int().nullable(),
  typeConformanceCount: z.int(),
  profiledAt: z.string(),
  connectorVersion: z.string(),
});

export const profileConnection = defineContract({
  service: 'ontology', name: 'profileConnection', method: 'POST', path: '/v1/ontology/connections/:connectionId/profiles', callers: WRITERS,
  // Profiling again records a new profile; the latest is what derivation reads.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectionId: z.uuid() }),
  /** The objects to profile; every declared object (at most 50) when absent. */
  body: z.strictObject({ objects: z.array(name).min(1).max(50).optional() }),
  response: z.object({ profiled: z.array(z.string()), failed: z.array(z.object({ object: z.string(), code: z.string() })) }),
  maxBodyBytes: 4_096,
});

export const listFieldProfiles = defineContract({
  service: 'ontology', name: 'listFieldProfiles', method: 'GET', path: '/v1/ontology/connections/:connectionId/profiles',
  callers: [...WRITERS],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ connectionId: z.uuid() }),
  /** 1: each field's latest profile; 2: also the one before it, to compare (drift, 51.11). Newest first per field. */
  query: z.strictObject({ depth: z.coerce.number().int().min(1).max(2).default(1) }),
  response: z.object({ profiles: z.array(fieldProfileView) }),
});
