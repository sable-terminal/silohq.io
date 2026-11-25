// Field aliases (spec 21.6): the organisation's own name for a source column, declared once per
// connection and inherited by every object type built over it. Derivation names a property
// from its column's alias, and compile hears the alias as a name for every property mapped
// from that column (26.7). Declared and removed under ontology.confirm (the permission an AI
// FDE's field_alias proposal maps to); an alias is the organisation's words, never a value.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { READERS } from './manifest.contract.ts';
import { WRITERS } from './element.contract.ts';

export const fieldAliasView = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  fieldPath: z.string(),
  alias: z.string(),
  declaredBy: z.uuid(),
  declaredAt: z.string(),
});
export type FieldAliasView = z.infer<typeof fieldAliasView>;

/** Declares a column's alias; one already declared for the column is replaced. */
export const setFieldAlias = defineContract({
  service: 'ontology', name: 'setFieldAlias', method: 'PUT', path: '/v1/ontology/field-aliases', callers: WRITERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    connectionId: z.uuid(),
    /** The column as the connection's manifest names its field. */
    fieldPath: z.string().min(1).max(500),
    alias: z.string().trim().min(1).max(200),
  }),
  response: fieldAliasView,
});

export const removeFieldAlias = defineContract({
  service: 'ontology', name: 'removeFieldAlias', method: 'DELETE', path: '/v1/ontology/field-aliases/:aliasId', callers: WRITERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ aliasId: z.uuid() }),
  response: z.object({ removed: z.boolean() }),
});

export const listFieldAliases = defineContract({
  service: 'ontology', name: 'listFieldAliases', method: 'GET', path: '/v1/ontology/field-aliases', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ connectionId: z.uuid().optional() }),
  response: z.object({ aliases: z.array(fieldAliasView) }),
});
