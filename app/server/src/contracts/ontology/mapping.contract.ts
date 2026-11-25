// The source fields an object type's properties map on main, as the rows a field marking names
// (spec 58.3: a field's marking is on its field map entry). Read with ontology.view; the paths
// are the manifest's, never record values.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const propertyMappingRow = z.object({
  id: z.uuid(),
  propertyIdentityId: z.uuid(),
  apiName: z.string(),
  connectionId: z.uuid(),
  sourceObject: z.string(),
  fieldPath: z.string(),
});

export const listPropertyMappings = defineContract({
  service: 'ontology', name: 'listPropertyMappings', method: 'GET', path: '/v1/ontology/object-types/:objectTypeId/mappings', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ objectTypeId: z.uuid() }),
  response: z.object({ objectTypeId: z.uuid(), typeVersionId: z.uuid(), mappings: z.array(propertyMappingRow) }),
});
