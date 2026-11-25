// Authoring ontology elements on a branch (spec 21.5 to 21.11, 25.3). Every write is a
// commit: a new immutable ontology version on the branch, holding the element as written.
// Main never changes here; a branch reaches main only through a reviewed, merged proposal.
//
// An element is written whole (PUT): the definition replaces what the branch had. Other
// elements are named by API name; the manifest the commit returns gives the ids. A
// property keeps its identity across versions by keeping its API name, or by naming the
// one it was (previousApiName).
//
// expectedHeadVersionId, when sent, refuses the commit if the branch moved since the
// caller read it (someone else committed), rather than silently writing over them.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import {
  apiName, CARDINALITIES, DATA_TYPES, FUNCTION_KINDS, functionView, interfaceView, linkTypeView, objectTypeView, sharedPropertyView,
  versionView,
} from './manifest.contract.ts';

/** The services that author: people through the gateway, the AI FDE as a service principal. */
export const WRITERS = ['gateway', 'fde-orchestrator'] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const description = z.string().trim().max(4_000).optional();
const typeParams = z.record(z.string(), z.json()).default({});
/** A source field path or object as the connector's manifest names it. */
const sourcePath = z.string().min(1).max(512);
/** A CEL expression. */
const cel = z.string().trim().min(1).max(4_000);

const commonCommit = {
  /** Refuse the commit when the branch head is no longer this version. */
  expectedHeadVersionId: z.uuid().optional(),
};

export const objectTypeDefinition = z.strictObject({
  ...commonCommit,
  displayName: text(200),
  pluralName: text(200),
  /** Written or confirmed by a person; never a record value. */
  description,
  /** One for a single-source type; two or more make it resolvable (spec 22.6). */
  contributingObjects: z.array(z.strictObject({
    connectionId: z.uuid(),
    sourceObject: sourcePath,
    identifierFieldPath: sourcePath,
  })).min(1).max(20),
  properties: z.array(z.strictObject({
    apiName,
    /** The API name this property had in the parent version, when it is renamed. */
    previousApiName: apiName.optional(),
    displayName: text(200),
    description,
    dataType: z.enum(DATA_TYPES),
    typeParams,
    nullable: z.boolean().default(true),
    /** An instance of a shared property, by API name (spec 21.10). */
    sharedProperty: apiName.optional(),
    /** A computed property: the function version that computes it. It has no mappings. */
    computedFunctionVersionId: z.uuid().optional(),
    mappings: z.array(z.strictObject({
      connectionId: z.uuid(),
      sourceObject: sourcePath,
      fieldPath: sourcePath,
      valueMap: z.record(z.string().max(200), z.string().max(200)).optional(),
      sourceTimeZone: z.string().max(64).optional(),
    })).max(20).default([]),
  })).min(1).max(500),
  /** single_source: the property holding the source identifier. */
  primaryKey: apiName.optional(),
  title: apiName,
  /** resolvable: the match keys in order, each with its normalisation (spec 23.1). */
  matchKeys: z.array(z.strictObject({ property: apiName, normalisation: cel.optional() })).max(8).default([]),
  /**
   * resolvable: a person's statement that each object is held in exactly one of the type's
   * contributing objects (the systems split the objects between them), so an aggregate may be
   * computed in each system and added (spec 27.7). The engine still checks the entity graph
   * before relying on it: one object bound to records in two systems contradicts it.
   */
  disjointSources: z.boolean().default(false),
  timeFields: z.array(z.strictObject({ property: apiName, meaning: text(100), isDefault: z.boolean().default(false) })).max(20).default([]),
  implements: z.array(z.strictObject({
    interface: apiName,
    /** Shared property API name to this type's property API name. */
    propertyBindings: z.record(apiName, apiName),
    /** Required link name to link type API name. */
    linkBindings: z.record(z.string().max(100), apiName).default({}),
  })).max(20).default([]),
  /** Icon, colour token, layouts, spatial and status properties (spec 21.14). */
  visual: z.record(z.string(), z.json()).default({}),
});
export type ObjectTypeDefinition = z.infer<typeof objectTypeDefinition>;

export const linkTypeDefinition = z.strictObject({
  ...commonCommit,
  forwardName: text(100),
  reverseName: text(100),
  from: apiName,
  to: apiName,
  cardinality: z.enum(CARDINALITIES),
  /** Each system declaring the key is its own route (spec 21.8). */
  routes: z.array(z.strictObject({
    connectionId: z.uuid(),
    sourceObject: sourcePath,
    foreignKeyField: sourcePath,
    referencedField: sourcePath,
    junctionObject: sourcePath.optional(),
    /**
     * The referenced end in another system (spec 66.9: a component in one Silo, its specification in
     * another; D248): the other linked type's contributing object there, its referencedField read
     * there. Both or neither; absent, the route's own system. No manifest declares a key into
     * another system, so a person declares it (or confirms an inferred one).
     */
    referencedConnectionId: z.uuid().optional(),
    referencedObject: sourcePath.optional(),
    /** declared_fk must be a key the connection's manifest declares; otherwise a person declares it. */
    origin: z.enum(['declared_fk', 'person_declared', 'inferred']).default('person_declared'),
  })).min(1).max(10),
  /** Position of the default route, or none (a traversal then asks). */
  defaultRoute: z.int().min(0).max(9).optional(),
});
export type LinkTypeDefinition = z.infer<typeof linkTypeDefinition>;

export const sharedPropertyDefinition = z.strictObject({
  ...commonCommit,
  displayName: text(200),
  description,
  dataType: z.enum(DATA_TYPES),
  typeParams,
});
export type SharedPropertyDefinition = z.infer<typeof sharedPropertyDefinition>;

export const interfaceDefinition = z.strictObject({
  ...commonCommit,
  displayName: text(200),
  description,
  requiredSharedProperties: z.array(apiName).max(50).default([]),
  requiredLinkTypeNames: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
});
export type InterfaceDefinition = z.infer<typeof interfaceDefinition>;

export const functionDefinition = z.strictObject({
  ...commonCommit,
  kind: z.enum(FUNCTION_KINDS),
  description,
  /**
   * CEL over `object` (the object's properties by API name), `links` (linked objects by
   * link type API name), `params` (Action parameters) and `now`. No network, no clock but
   * `now`, no randomness (spec 21.11).
   */
  expression: cel,
  inputs: z.strictObject({
    objectTypes: z.array(apiName).max(20).default([]),
    properties: z.array(z.strictObject({ objectType: apiName, property: apiName })).max(200).default([]),
    linkTypes: z.array(apiName).max(20).default([]),
    parameters: z.record(apiName, z.enum(DATA_TYPES)).default({}),
  }),
  outputType: z.strictObject({ dataType: z.enum(DATA_TYPES), typeParams }),
  /** The CEL runtime's step ceiling for one evaluation. */
  costLimit: z.int().min(1).max(100_000).default(10_000),
});
export type FunctionDefinition = z.infer<typeof functionDefinition>;

const branchElement = z.strictObject({ branchId: z.uuid(), apiName });

const commit = <S extends z.ZodType>(element: S) => z.object({ version: versionView, element });

export const putObjectType = defineContract({
  service: 'ontology', name: 'putObjectType', method: 'PUT', path: '/v1/ontology/branches/:branchId/object-types/:apiName',
  callers: WRITERS, context: 'organisation', idempotency: 'keyed',
  params: branchElement, body: objectTypeDefinition, response: commit(objectTypeView), maxBodyBytes: 512 * 1024,
});

export const putLinkType = defineContract({
  service: 'ontology', name: 'putLinkType', method: 'PUT', path: '/v1/ontology/branches/:branchId/link-types/:apiName',
  callers: WRITERS, context: 'organisation', idempotency: 'keyed',
  params: branchElement, body: linkTypeDefinition, response: commit(linkTypeView), maxBodyBytes: 64 * 1024,
});

export const putSharedProperty = defineContract({
  service: 'ontology', name: 'putSharedProperty', method: 'PUT', path: '/v1/ontology/branches/:branchId/shared-properties/:apiName',
  callers: WRITERS, context: 'organisation', idempotency: 'keyed',
  params: branchElement, body: sharedPropertyDefinition, response: commit(sharedPropertyView), maxBodyBytes: 32 * 1024,
});

export const putInterface = defineContract({
  service: 'ontology', name: 'putInterface', method: 'PUT', path: '/v1/ontology/branches/:branchId/interfaces/:apiName',
  callers: WRITERS, context: 'organisation', idempotency: 'keyed',
  params: branchElement, body: interfaceDefinition, response: commit(interfaceView), maxBodyBytes: 32 * 1024,
});

/** Publishes a new immutable function version on the branch (function.author). */
export const putFunction = defineContract({
  service: 'ontology', name: 'putFunction', method: 'PUT', path: '/v1/ontology/branches/:branchId/functions/:apiName',
  callers: WRITERS, context: 'organisation', idempotency: 'keyed',
  params: branchElement, body: functionDefinition, response: commit(functionView), maxBodyBytes: 64 * 1024,
});
