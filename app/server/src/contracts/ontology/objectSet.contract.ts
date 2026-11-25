// Saved object sets (spec 21.13, 24.4): definitions only, never members (an explicit set
// stores Silo object ids, nothing else). Evaluation, bounds and pagination belong to the
// query engine; a saved set is re-evaluated on every use under the opener's permissions.
//
// A definition is checked against main's head when it is saved, records the ontology
// version it was checked against, and writes its dependencies (the type or interface, the
// properties its predicate reads, the link types it walks) to the dependency index, so
// impact analysis finds it (spec 25.6).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { WRITERS } from './element.contract.ts';
import { READERS } from './manifest.contract.ts';

/** CEL over `object` (the object's properties by API name) and `now`, declaring the property identities it reads. */
export const setPredicate = z.strictObject({
  cel: z.string().trim().min(1).max(4_000),
  properties: z.array(z.uuid()).max(50),
});

export const setDefinition = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('filter'),
    base: z.union([z.strictObject({ objectTypeId: z.uuid() }), z.strictObject({ interfaceId: z.uuid() })]),
    predicate: setPredicate,
  }),
  z.strictObject({
    kind: z.literal('traversal'),
    start: z.union([z.strictObject({ objectTypeId: z.uuid(), predicate: setPredicate.optional() }), z.strictObject({ objectSetId: z.uuid() })]),
    /** Each hop names its route, or uses the link's default route (spec 24.4). */
    path: z.array(z.strictObject({ linkTypeId: z.uuid(), direction: z.enum(['forward', 'reverse']), routeId: z.uuid().optional() })).min(1).max(5),
  }),
  z.strictObject({ kind: z.literal('explicit'), objectTypeId: z.uuid(), ids: z.array(z.uuid()).min(1).max(10_000) }),
  z.strictObject({ kind: z.literal('composite'), operation: z.enum(['union', 'intersection', 'difference']), operands: z.array(z.uuid()).min(2).max(10) }),
]);
export type SetDefinition = z.infer<typeof setDefinition>;

export const objectSetView = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(['filter', 'traversal', 'explicit', 'composite']),
  baseTypeId: z.uuid().nullable(),
  baseInterfaceId: z.uuid().nullable(),
  definition: setDefinition,
  /** The ontology version the definition was checked against. */
  ontologyVersionId: z.uuid(),
  ownerMembershipId: z.uuid(),
  visibility: z.enum(['private', 'shared']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ObjectSetView = z.infer<typeof objectSetView>;

export const saveObjectSet = defineContract({
  service: 'ontology', name: 'saveObjectSet', method: 'POST', path: '/v1/ontology/object-sets', callers: [...WRITERS, 'workspace', 'studio', 'ask'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000).optional(),
    visibility: z.enum(['private', 'shared']).default('private'),
    definition: setDefinition,
  }),
  response: objectSetView, status: 201, maxBodyBytes: 512 * 1024,
});

export const listObjectSets = defineContract({
  service: 'ontology', name: 'listObjectSets', method: 'GET', path: '/v1/ontology/object-sets', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
  response: z.object({ objectSets: z.array(objectSetView) }),
});

export const getObjectSet = defineContract({
  service: 'ontology', name: 'getObjectSet', method: 'GET', path: '/v1/ontology/object-sets/:objectSetId', callers: READERS,
  context: 'organisation', idempotency: 'none', params: z.strictObject({ objectSetId: z.uuid() }), response: objectSetView,
});

export const archiveObjectSet = defineContract({
  service: 'ontology', name: 'archiveObjectSet', method: 'POST', path: '/v1/ontology/object-sets/:objectSetId/archive',
  callers: [...WRITERS, 'workspace', 'studio'], context: 'organisation', idempotency: 'none',
  params: z.strictObject({ objectSetId: z.uuid() }), response: objectSetView,
});
