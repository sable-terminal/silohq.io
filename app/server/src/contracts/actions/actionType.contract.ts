// Action types (spec 42): the ontology objects that each declare one permitted kind of
// change. A person confirms the type in advance; each mutation of it is approved when it is
// written (42.1). Every write in Silo is an Action of a confirmed type (the binding rule).
//
// A type is proposed (a name, an owning scope), then confirmed by publishing a version: an
// immutable definition bound to one ontology version. Each later change publishes a new
// version; a mutation keeps the version it compiled against (42.10).
//
// This release's definition:
// - one target object type and the properties it may change (42.2 targets), by API name
//   in the ontology version, recorded with their property identities;
// - parameters (42.3) with CEL defaults and validation over the parameter values;
// - rules (42.4): set_property and clear_property (update), create_object (create),
//   delete_object (delete), add_link and remove_link (an update of the foreign key the target
//   holds), invoke_custom (a custom action the manifest declares, with parameters mapped to
//   its inputs; the type's only rule);
// - the connections it may write through (42.5): each a contributing connection of the type,
//   whose current manifest declares every operation the rules need;
// - the risk class (42.7), the revert behaviour (42.8), an optional extra approval policy,
//   and optional submission criteria (CEL over the target's current state and the
//   parameters, evaluated at resolve).
// Confirmation is action.define at the owning scope, by a member: never a service principal.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

export const PARAMETER_TYPES = [
  'string', 'integer', 'decimal', 'boolean', 'date', 'timestamp', 'enumeration', 'object_reference', 'object_set_reference',
  'attachment_reference',
] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

const apiName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'lower snake case, starting with a letter, at most 63 characters');
const cel = z.string().trim().min(1).max(2_000);

export const parameterDefinition = z.strictObject({
  name: apiName,
  type: z.enum(PARAMETER_TYPES),
  required: z.boolean().default(false),
  /** object_reference and object_set_reference: the object type referenced. */
  objectTypeId: z.uuid().optional(),
  enumValues: z.array(z.string().min(1).max(200)).min(1).max(200).optional(),
  /** CEL over the other parameters, giving the value when none is supplied. */
  default: cel.optional(),
  /** CEL predicate over the parameter values (each by its name). */
  validation: cel.optional(),
  message: z.string().trim().min(1).max(300).optional(),
}).superRefine((p, ctx) => {
  const referencing = p.type === 'object_reference' || p.type === 'object_set_reference';
  if (referencing !== (p.objectTypeId !== undefined)) ctx.addIssue({ code: 'custom', path: ['objectTypeId'], message: 'given exactly for object references' });
  if ((p.type === 'enumeration') !== (p.enumValues !== undefined)) ctx.addIssue({ code: 'custom', path: ['enumValues'], message: 'given exactly for an enumeration' });
  if (p.message !== undefined && p.validation === undefined) ctx.addIssue({ code: 'custom', path: ['message'], message: 'a message explains a validation' });
});
export type ParameterDefinition = z.output<typeof parameterDefinition>;

/** Where a written value comes from: a parameter, or CEL over params and current (the target's properties). */
export const valueSource = z.union([
  z.strictObject({ parameter: apiName }),
  z.strictObject({ cel }),
]);
export type ValueSource = z.infer<typeof valueSource>;

export const actionRule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('set_property'), property: apiName, value: valueSource }),
  z.strictObject({ kind: z.literal('clear_property'), property: apiName }),
  z.strictObject({ kind: z.literal('create_object'), values: z.record(apiName, valueSource) }),
  z.strictObject({ kind: z.literal('delete_object') }),
  /** Link the target to the record an object_reference parameter names, through the foreign key the target holds. */
  z.strictObject({ kind: z.literal('add_link'), linkType: apiName, object: z.strictObject({ parameter: apiName }) }),
  /** Unlink: the foreign key the target holds is cleared. */
  z.strictObject({ kind: z.literal('remove_link'), linkType: apiName }),
  /** A custom action endpoint (42.5), its inputs from parameters or CEL over params and current. */
  z.strictObject({ kind: z.literal('invoke_custom'), customAction: apiName, inputs: z.record(apiName, valueSource).default({}) }),
]);
export type ActionRule = z.infer<typeof actionRule>;

export const SIDE_EFFECT_RECIPIENTS = ['proposer', 'approvers', 'executor'] as const;

export const sideEffect = z.strictObject({
  kind: z.enum(['notification', 'webhook']),
  /** A webhook: the outbound target it posts to (connect-registry's registerOutboundWebhook, spec 20.4). */
  endpointId: z.uuid().optional(),
  /**
   * A webhook: the body, JSONata over the executed Action ($.mutationId, receiptId, actionTypeId,
   * objectTypeId, origin, objects[{objectId, connectionId, reference}], parameters). Without one
   * the body is the references alone.
   */
  payload: z.strictObject({ jsonata: z.string().trim().min(1).max(10_000) }).optional(),
  /** An endpoint declared physical (spec 20.5) makes the type physical. */
  physical: z.boolean().default(false),
  /** A notification: who is told (spec 42.6). Default the proposer. */
  recipients: z.array(z.enum(SIDE_EFFECT_RECIPIENTS)).min(1).max(SIDE_EFFECT_RECIPIENTS.length).optional(),
  /** A notification: where, in the product (Home) and by email. Default Home. Mobile push waits on a push provider. */
  channels: z.array(z.enum(['home', 'email'])).min(1).max(2).optional(),
}).refine((e) => e.kind === 'notification' || e.recipients === undefined, { message: 'only a notification has recipients', path: ['recipients'] })
  .refine((e) => e.kind === 'notification' || e.channels === undefined, { message: 'only a notification has channels', path: ['channels'] })
  .refine((e) => (e.kind === 'webhook') === (e.endpointId !== undefined), { message: 'a webhook names its target, and only a webhook', path: ['endpointId'] })
  .refine((e) => e.kind === 'webhook' || e.payload === undefined, { message: 'only a webhook has a payload', path: ['payload'] });

export const RISK_CLASSES = ['data', 'external', 'physical'] as const;

/** The transports an Action type writes through (spec 43.4 check 6): REST, SQL, OPC UA setpoints and methods, MQTT commands (physical, 47.1). */
export const WRITING_PROTOCOLS = ['rest', 'sql', 'opc_ua', 'mqtt'] as const;
export const REVERT_BEHAVIOURS = ['three_way', 'compensating', 'state_only', 'not_revertible'] as const;

export const versionDefinition = z.strictObject({
  ontologyVersionId: z.uuid(),
  objectTypeId: z.uuid(),
  /** The properties the type may change, by API name. An unlisted property cannot be written by it. */
  properties: z.array(apiName).max(200).default([]),
  parameters: z.array(parameterDefinition).max(50).default([]),
  rules: z.array(actionRule).min(1).max(50),
  permittedConnections: z.array(z.uuid()).min(1).max(20),
  riskClass: z.enum(RISK_CLASSES).default('data'),
  revertBehaviour: z.enum(REVERT_BEHAVIOURS).default('three_way'),
  /** compensating: the custom action that undoes the one invoked; default the one its manifest declares (compensatedBy). */
  compensatingAction: apiName.optional(),
  submissionCriteria: cel.optional(),
  approvalPolicyId: z.uuid().optional(),
  sideEffects: z.array(sideEffect).max(20).default([]),
  description: z.string().trim().min(1).max(2_000).optional(),
});
export type VersionDefinition = z.output<typeof versionDefinition>;
export type VersionDefinitionInput = z.input<typeof versionDefinition>;

export const SOURCE_OPERATIONS = ['create', 'update_full', 'update_partial', 'delete', 'upsert', 'custom'] as const;
export type SourceOperation = (typeof SOURCE_OPERATIONS)[number];

export const actionTypeVersionView = z.object({
  id: z.uuid(),
  version: z.int().min(1),
  ontologyVersionId: z.uuid(),
  objectTypeId: z.uuid(),
  /** API name to property identity id. */
  properties: z.record(z.string(), z.uuid()),
  parameters: z.array(parameterDefinition),
  rules: z.array(actionRule),
  permittedConnections: z.array(z.uuid()),
  /** Per connection: the source object written and the operations the rules use, as the manifest version declared them. */
  permittedOperations: z.record(z.string(), z.object({
    sourceObject: z.string(), manifestId: z.uuid(), operations: z.array(z.enum(SOURCE_OPERATIONS)),
    /** The custom actions used: the one invoked and, for a compensating revert, the one that undoes it. */
    customActions: z.array(z.string()).optional(),
    /** add_link and remove_link: link type API name to the foreign key field the target holds. */
    linkFields: z.record(z.string(), z.string()).optional(),
  })),
  riskClass: z.enum(RISK_CLASSES),
  revertBehaviour: z.enum(REVERT_BEHAVIOURS),
  compensatingAction: z.string().nullable(),
  submissionCriteria: z.string().nullable(),
  approvalPolicyId: z.uuid().nullable(),
  sideEffects: z.array(sideEffect),
  description: z.string().nullable(),
  /** The member who confirmed it; null for a generic edit's own definition, which Silo compiles (42.9). */
  confirmedBy: z.uuid().nullable(),
  confirmedAt: z.string(),
});
export type ActionTypeVersionView = z.infer<typeof actionTypeVersionView>;

export const actionTypeView = z.object({
  id: z.uuid(),
  apiName: z.string(),
  displayName: z.string(),
  status: z.enum(['proposed', 'confirmed', 'blocked', 'retired', 'rejected']),
  owningScopeId: z.uuid(),
  isSystem: z.boolean(),
  createdAt: z.string(),
  retiredAt: z.string().nullable(),
  version: z.int(),
  current: actionTypeVersionView.nullable(),
});
export type ActionTypeView = z.infer<typeof actionTypeView>;

const CALLERS = ['gateway', 'fde-orchestrator'] as const;
const actionTypeId = z.strictObject({ actionTypeId: z.uuid() });

export const proposeActionType = defineContract({
  service: 'actions', name: 'proposeActionType', method: 'POST', path: '/v1/action-types', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    apiName: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).max(120),
    displayName: z.string().trim().min(1).max(200),
    owningScopeId: z.uuid(),
  }),
  response: actionTypeView,
  status: 201,
});

export const publishActionTypeVersion = defineContract({
  service: 'actions', name: 'publishActionTypeVersion', method: 'POST', path: '/v1/action-types/:actionTypeId/versions', callers: CALLERS,
  context: 'organisation', idempotency: 'keyed',
  params: actionTypeId,
  body: versionDefinition,
  response: actionTypeView,
  status: 201,
  maxBodyBytes: 256 * 1024,
});

export const getActionType = defineContract({
  service: 'actions', name: 'getActionType', method: 'GET', path: '/v1/action-types/:actionTypeId',
  callers: [...CALLERS, 'approvals', 'revert', 'compile', 'ask', 'scheduler', 'studio'],
  context: 'organisation', idempotency: 'none',
  params: actionTypeId,
  response: actionTypeView,
});

export const listActionTypes = defineContract({
  service: 'actions', name: 'listActionTypes', method: 'GET', path: '/v1/action-types',
  // The executor: the object view's Actions section (34.5).
  callers: [...CALLERS, 'compile', 'ask', 'studio', 'executor'],
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    status: z.enum(['proposed', 'confirmed', 'blocked', 'retired', 'rejected']).optional(),
    /** Those whose current version targets this object type. */
    objectTypeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: z.object({ actionTypes: z.array(actionTypeView) }),
});

/** Retired: no new mutations; reverts still use the version in their receipt (42.10). */
/** A proposal (an AI FDE's or a person's) a holder of action.define declines (42.10): it never takes a mutation. */
export const rejectActionType = defineContract({
  service: 'actions', name: 'rejectActionType', method: 'POST', path: '/v1/action-types/:actionTypeId/rejection', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: actionTypeId,
  body: z.strictObject({ version: z.int().min(1), reason: z.enum(['wrong', 'duplicate', 'out_of_scope', 'not_needed', 'unclear', 'other']) }),
  response: actionTypeView,
});

export const retireActionType = defineContract({
  service: 'actions', name: 'retireActionType', method: 'POST', path: '/v1/action-types/:actionTypeId/retire', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: actionTypeId,
  body: z.strictObject({ version: z.int().min(1) }),
  response: actionTypeView,
});
