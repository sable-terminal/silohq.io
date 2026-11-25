// The ontology manifest: the whole content of one immutable ontology version (spec 25.1),
// as the ontology service serves it to compile, planner, executor, resolution, ask, Studio
// and the rest. It is the one artefact those services read to know what exists.
//
// Shape (OntologyManifest):
//   schemaVersion          '1'; a reader refuses a manifest whose schema it does not know.
//   organisationId
//   version                { id, branchId, branchKind, sequence, parentVersionId, kind, manifestHash }
//                          manifestHash is SHA-256 (hex) over the canonical JSON of
//                          { schemaVersion, objectTypes, linkTypes, sharedProperties,
//                          interfaces, functions }: equal content, equal hash.
//   objectTypes[]          sorted by apiName. Each: id (stable), typeVersionId (the row
//                          lineage records), apiName, status, display and plural names,
//                          description, resolutionClass, matchKeys (ordered, each a
//                          property identity and its CEL normalisation; empty for
//                          single_source), primaryKey / title / defaultTimeField as
//                          property identity ids, contributingObjects (connection, source
//                          object, identifier field, connector version), properties
//                          (sorted by apiName, each keyed by its stable identityId, with
//                          its mappings per contributing object), timeFields, implements
//                          (interface bindings by shared property and property identity),
//                          visual metadata.
//   linkTypes[]            sorted by apiName: endpoints by object type id, cardinality,
//                          routes (each a connection, source object, foreign key and
//                          referenced field, junction object for many-to-many, origin),
//                          defaultRouteId or null.
//   sharedProperties[]     sorted by apiName.
//   interfaces[]           sorted by apiName: required shared properties and link names.
//   functions[]            sorted by apiName: the version the ontology version holds
//                          (expression, declared inputs, output type, cost limit).
//
// Status is where the element stands in this version: 'active' once it is on main,
// 'proposed' while it exists only on the branch the version belongs to.
//
// Every reference is an id: a property is named by its identity id, stable across type
// versions; a plan, a function or an Action records identity ids and the ontology version.
// No field holds a record value: names, types, source field paths and declared code maps
// (value maps) are schema vocabulary (spec 21.6, 25.1).
//
// The manifest is the organisation's whole ontology. A caller that answers a person
// applies that person's vocabulary (spec 21.2, 26.3: markings, clearances, connection
// grants, field policies) before anything is shown or planned; elements outside it do not
// exist for them. Through the gateway, ontology.view is required as well.
//
// ontology.compiled_manifests is a different thing: compile's validated query plans (spec
// 26), written by compile, not here.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const MANIFEST_SCHEMA_VERSION = '1';

export const DATA_TYPES = [
  'string', 'integer', 'decimal', 'boolean', 'date', 'timestamp', 'duration', 'money', 'enum', 'geopoint', 'geoshape', 'struct', 'array',
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export const ELEMENT_STATUSES = ['proposed', 'active', 'deprecated', 'retired'] as const;
export const CARDINALITIES = ['one_to_one', 'one_to_many', 'many_to_many'] as const;
export const FUNCTION_KINDS = ['computed_property', 'validation', 'ranking'] as const;
export const RESOLUTION_CLASSES = ['resolvable', 'single_source'] as const;

/** An element's API name: stable once confirmed, used in plans, functions and apps. */
export const apiName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'lower snake case, starting with a letter, at most 63 characters');
const text = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const typeParams = z.record(z.string(), z.json());

export const propertyMappingView = z.object({
  connectionId: z.uuid(),
  sourceObject: z.string(),
  fieldPath: z.string(),
  /** Declared code map (source code to the enum or boolean value): vocabulary, never record values. */
  valueMap: z.record(z.string(), z.string()).nullable(),
  /** IANA zone, where the source stores local time without an offset. */
  sourceTimeZone: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const propertyView = z.object({
  /** Stable across type versions: what plans, functions, authorities and dependants name. */
  identityId: z.uuid(),
  apiName,
  displayName: z.string(),
  description: z.string().nullable(),
  dataType: z.enum(DATA_TYPES),
  typeParams,
  nullable: z.boolean(),
  isMatchKey: z.boolean(),
  sharedPropertyId: z.uuid().nullable(),
  /** Set for a computed property, which has no mappings. */
  computedFunctionVersionId: z.uuid().nullable(),
  status: z.enum(['active', 'deprecated', 'retired']),
  mappings: z.array(propertyMappingView),
});
export type PropertyView = z.infer<typeof propertyView>;

export const matchKeyView = z.object({
  propertyIdentityId: z.uuid(),
  /** CEL over `value` (the key as a string), deterministic; null keeps the value as it is. */
  normalisation: z.string().nullable(),
});

export const contributingObjectView = z.object({
  connectionId: z.uuid(),
  sourceObject: z.string(),
  identifierFieldPath: z.string(),
  connectorVersion: z.string(),
});

export const objectTypeView = z.object({
  id: z.uuid(),
  /** The object type version: what lineage on every figure records (spec 27.10). */
  typeVersionId: z.uuid(),
  apiName,
  status: z.enum(ELEMENT_STATUSES),
  /** Deprecated (spec 25.7): the element that replaces it, if any, and the earliest day it may be retired. */
  replacedById: z.uuid().nullable().optional(),
  retireAfter: z.iso.date().optional(),
  displayName: z.string(),
  pluralName: z.string(),
  description: z.string().nullable(),
  resolutionClass: z.enum(RESOLUTION_CLASSES),
  matchKeys: z.array(matchKeyView),
  /** resolvable: declared to hold each object in exactly one contributing object (27.7). Absent: not declared. */
  disjointSources: z.boolean().optional(),
  /** single_source: the property identity of the source identifier. Null for resolvable (the Silo object id). */
  primaryKeyPropertyIdentityId: z.uuid().nullable(),
  titlePropertyIdentityId: z.uuid(),
  defaultTimeFieldPropertyIdentityId: z.uuid().nullable(),
  contributingObjects: z.array(contributingObjectView),
  properties: z.array(propertyView),
  timeFields: z.array(z.object({ propertyIdentityId: z.uuid(), meaning: z.string(), isDefault: z.boolean() })),
  implements: z.array(z.object({
    interfaceId: z.uuid(),
    /** Shared property id to this type's property identity id. */
    propertyBindings: z.record(z.string(), z.uuid()),
    /** Required link name to link type id. */
    linkBindings: z.record(z.string(), z.uuid()),
  })),
  visual: z.record(z.string(), z.json()),
});
export type ObjectTypeView = z.infer<typeof objectTypeView>;

export const linkRouteView = z.object({
  id: z.uuid(),
  position: z.int().min(0),
  connectionId: z.uuid(),
  sourceObject: z.string(),
  foreignKeyField: z.string(),
  referencedField: z.string(),
  junctionObject: z.string().nullable(),
  /** The referenced end in another system (D248); absent or null, the route's own system. */
  referencedConnectionId: z.uuid().nullable().optional(),
  referencedObject: z.string().nullable().optional(),
  origin: z.enum(['declared_fk', 'person_declared', 'inferred']),
});

export const linkTypeView = z.object({
  id: z.uuid(),
  apiName,
  status: z.enum(ELEMENT_STATUSES),
  /** Deprecated (spec 25.7): the element that replaces it, if any, and the earliest day it may be retired. */
  replacedById: z.uuid().nullable().optional(),
  retireAfter: z.iso.date().optional(),
  forwardName: z.string(),
  reverseName: z.string(),
  fromTypeId: z.uuid(),
  toTypeId: z.uuid(),
  cardinality: z.enum(CARDINALITIES),
  routes: z.array(linkRouteView),
  /** When null and more than one route exists, compile asks which (spec 26.9). */
  defaultRouteId: z.uuid().nullable(),
});
export type LinkTypeView = z.infer<typeof linkTypeView>;

export const sharedPropertyView = z.object({
  id: z.uuid(),
  apiName,
  status: z.enum(ELEMENT_STATUSES),
  /** Deprecated (spec 25.7): the element that replaces it, if any, and the earliest day it may be retired. */
  replacedById: z.uuid().nullable().optional(),
  retireAfter: z.iso.date().optional(),
  displayName: z.string(),
  description: z.string().nullable(),
  dataType: z.enum(DATA_TYPES),
  typeParams,
});
export type SharedPropertyView = z.infer<typeof sharedPropertyView>;

export const interfaceView = z.object({
  id: z.uuid(),
  apiName,
  status: z.enum(ELEMENT_STATUSES),
  /** Deprecated (spec 25.7): the element that replaces it, if any, and the earliest day it may be retired. */
  replacedById: z.uuid().nullable().optional(),
  retireAfter: z.iso.date().optional(),
  displayName: z.string(),
  description: z.string().nullable(),
  requiredSharedPropertyIds: z.array(z.uuid()),
  requiredLinkTypeNames: z.array(z.string()),
});
export type InterfaceView = z.infer<typeof interfaceView>;

export const functionInputs = z.strictObject({
  objectTypeIds: z.array(z.uuid()).max(20).default([]),
  propertyIdentityIds: z.array(z.uuid()).max(200).default([]),
  linkTypeIds: z.array(z.uuid()).max(20).default([]),
  /** Validation functions over Action parameters: name to data type. */
  parameters: z.record(apiName, z.enum(DATA_TYPES)).default({}),
});

export const functionView = z.object({
  id: z.uuid(),
  apiName,
  status: z.enum(ELEMENT_STATUSES),
  /** Deprecated (spec 25.7): the element that replaces it, if any, and the earliest day it may be retired. */
  replacedById: z.uuid().nullable().optional(),
  retireAfter: z.iso.date().optional(),
  kind: z.enum(FUNCTION_KINDS),
  description: z.string().nullable(),
  version: z.object({
    id: z.uuid(),
    version: z.int().min(1),
    expression: z.string(),
    inputs: functionInputs,
    outputType: z.object({ dataType: z.enum(DATA_TYPES), typeParams }),
    costLimit: z.int().min(1),
  }),
});
export type FunctionView = z.infer<typeof functionView>;

export const ontologyContent = z.object({
  objectTypes: z.array(objectTypeView),
  linkTypes: z.array(linkTypeView),
  sharedProperties: z.array(sharedPropertyView),
  interfaces: z.array(interfaceView),
  functions: z.array(functionView),
});
export type OntologyContent = z.infer<typeof ontologyContent>;

export const versionView = z.object({
  id: z.uuid(),
  branchId: z.uuid(),
  branchKind: z.enum(['main', 'working', 'derivation', 'scenario']),
  /** Monotonic per branch. */
  sequence: z.int().min(1),
  parentVersionId: z.uuid().nullable(),
  kind: z.enum(['change', 'merge', 'rollback', 'migration']),
  manifestHash: sha256Hex,
  createdAt: z.string(),
});
export type VersionView = z.infer<typeof versionView>;

export const ontologyManifest = ontologyContent.extend({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  organisationId: z.uuid(),
  version: versionView,
});
export type OntologyManifest = z.infer<typeof ontologyManifest>;

/** The services that read the ontology. Through the gateway, ontology.view is decided first. */
export const READERS = [
  'gateway', 'compile', 'planner', 'executor', 'resolution', 'ask', 'workspace', 'studio', 'search', 'lineage', 'actions',
  // revert: the link routes a recreated record's dependants are re-pointed along (spec 46.6).
  'revert', 'approvals', 'recognition', 'simulation', 'scheduler', 'state-plane', 'canvas-layout', 'fde-orchestrator', 'siloes-capture',
  'siloes-import', 'siloes-capture', 'warehouse-schema', 'warehouse-provisioner', 'warehouse-sync', 'warehouse-reconcile', 'index-builder', 'admin-portal',
  // change-stream: which single-source types a change belongs to, for Capture (spec 30.7).
  'change-stream',
  // discovery: a finding's tables matched to existing object types (spec 19.4).
  'discovery',
  // files: a media set's link rule names a type and property (D238).
  'files',
] as const;

export const getVersionManifest = defineContract({
  service: 'ontology', name: 'getVersionManifest', method: 'GET', path: '/v1/ontology/versions/:versionId/manifest', callers: READERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ versionId: z.uuid() }),
  response: ontologyManifest,
});

/**
 * The manifest of main's head, or of a branch's head for a holder of ontology.branch on it.
 * The head moves with every merge; a caller that must not see it move pins the version id
 * it was given and reads by version.
 */
export const getManifest = defineContract({
  service: 'ontology', name: 'getManifest', method: 'GET', path: '/v1/ontology/manifest', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ branchId: z.uuid().optional() }),
  response: ontologyManifest,
});

/** Just the head: cheap, for a reader that caches manifests by version id. */
export const getActiveVersion = defineContract({
  service: 'ontology', name: 'getActiveVersion', method: 'GET', path: '/v1/ontology/active', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ branchId: z.uuid().optional() }),
  response: versionView,
});

export const listVersions = defineContract({
  service: 'ontology', name: 'listVersions', method: 'GET', path: '/v1/ontology/versions', callers: READERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({ branchId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
  response: z.object({ versions: z.array(versionView) }),
});
