// Action types (spec 42): proposed, confirmed by publishing a version bound to an ontology
// version, retired. A version is checked against the ontology version it names and against
// the manifest each permitted connection runs now:
// - the target type exists and is active in that ontology version; each listed property is
//   on it, stored (not computed), and mapped on a permitted connection;
// - parameters are uniquely named and their CEL defaults and validations type check;
// - rules write only listed properties, from parameters or CEL that type checks; a property
//   that may not be null is never cleared;
// - each permitted connection contributes the type, speaks a transport that writes (REST,
//   SQL), and its manifest declares every operation the rules use on the type's source object
//   (spec 42.5: an Action type may use only operations the manifest version declares);
// - add_link and remove_link name an active link type of the target type whose route on each
//   permitted connection is a foreign key the target's source object holds, referencing the
//   other end's identifier: the link is written as an update of that field (42.4). A key the
//   other end holds is written from that end's type; a join record's link by an Action type
//   over the join record's type (create_object, delete_object). add_link takes the linked
//   record from an object_reference parameter of the other end's type; remove_link needs the
//   key nullable;
// - invoke_custom is the type's only rule: a custom action each permitted connection's
//   manifest declares on the source object, with the fields it changes (42.5). A compensating
//   revert (42.8) names the custom action that undoes it, or takes the one the manifest
//   declares (compensatedBy), declared on every permitted connection;
// - the declared risk class is at least what a connection's manifest declares (physical
//   writes, spec 47.7) and what the side effects force (the database checks those too).
// Confirmation is action.define at the owning scope, by a member (42.12: never a service
// principal). The publish is keyed; versions number contiguously.

import { webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import type {
  ActionRule, ActionTypeVersionView, ActionTypeView, ParameterDefinition, ParameterType, SourceOperation, VersionDefinition,
} from '../../contracts/actions/actionType.contract.ts';
import { WRITING_PROTOCOLS } from '../../contracts/actions/actionType.contract.ts';
import type { ManifestObject } from '../../contracts/connect/manifest.contract.ts';
import type { LinkTypeView, ObjectTypeView, OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { ActionParameter } from '../../models/action/actionParameter.model.ts';
import type { ActionType } from '../../models/action/actionType.model.ts';
import type { ActionTypeVersion } from '../../models/action/actionTypeVersion.model.ts';
import { actionParameterRepo, actionTypeRepo, actionTypeVersionRepo } from '../../repos/action/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { compileCel, type CelType } from '../expression-evaluator/cel.service.ts';
import { compileExpression } from '../expression-evaluator/evaluator.service.ts';
import {
  connectionWithManifest, demand, memberOf, ontologyAt, type ConnectionWithManifest, type Context, type WriteBackDeps,
} from './deps.service.ts';
import { recordActionEvent } from './events.service.ts';

/** The CEL type each parameter type is seen as. Decimals are dyn: CEL compares ints and doubles. */
export const CEL_TYPE: Readonly<Record<ParameterType, CelType>> = {
  string: 'string', integer: 'int', decimal: 'dyn', boolean: 'bool', date: 'string', timestamp: 'timestamp', enumeration: 'string',
  object_reference: 'string', object_set_reference: 'dyn', attachment_reference: 'string',
};

/** Operations each rule needs from the source (spec 42.4). */
export function operationsOf(rules: readonly ActionRule[]): SourceOperation[] {
  const ops = new Set<SourceOperation>();
  for (const rule of rules) {
    if (rule.kind === 'set_property' || rule.kind === 'clear_property' || rule.kind === 'add_link' || rule.kind === 'remove_link') ops.add('update_partial');
    if (rule.kind === 'create_object') ops.add('create');
    if (rule.kind === 'delete_object') ops.add('delete');
    if (rule.kind === 'invoke_custom') ops.add('custom');
  }
  return [...ops].sort();
}

/** The manifest's write each source operation needs; a custom operation needs its custom action by name. */
export const MANIFEST_OPERATION: Readonly<Record<Exclude<SourceOperation, 'custom'>, 'create' | 'update' | 'updateFull' | 'delete' | 'upsert'>> = {
  create: 'create', update_full: 'updateFull', update_partial: 'update', delete: 'delete', upsert: 'upsert',
};

/**
 * The operations the rules need, as this source object offers them (42.4): an update is a
 * partial update where declared, else a full one; a create is a create where declared, else
 * an upsert. `missing` is the first the source cannot do.
 */
export function operationsOn(object: ManifestObject, wanted: readonly SourceOperation[]): { operations: SourceOperation[]; missing: SourceOperation | null } {
  const out = new Set<SourceOperation>();
  for (const op of wanted) {
    const declared = (o: Exclude<SourceOperation, 'custom'>) => object.writes?.[MANIFEST_OPERATION[o]] !== undefined;
    const resolved: SourceOperation | undefined = op === 'custom' ? 'custom'
      : op === 'update_partial' ? (declared('update_partial') ? 'update_partial' : declared('update_full') ? 'update_full' : undefined)
        : op === 'create' ? (declared('create') ? 'create' : declared('upsert') ? 'upsert' : undefined)
          : declared(op) ? op : undefined;
    if (resolved === undefined) return { operations: [], missing: op };
    out.add(resolved);
  }
  return { operations: [...out].sort(), missing: null };
}

/** Whether a connection's source object still declares what a version uses (42.5). */
export function stillDeclared(object: ManifestObject | undefined, declared: ActionTypeVersionView['permittedOperations'][string]): boolean {
  if (object === undefined) return false;
  for (const op of declared.operations) {
    if (op === 'custom') continue;
    if (object.writes?.[MANIFEST_OPERATION[op]] === undefined) return false;
  }
  return (declared.customActions ?? []).every((name) => object.writes?.custom.some((c) => c.name === name) === true);
}

/** The route of a link type on a connection that the target's source object holds as a foreign key, if any. */
export function heldRoute(link: LinkTypeView, connectionId: string, sourceObject: string): LinkTypeView['routes'][number] | undefined {
  return link.routes.find((r) => r.connectionId === connectionId && r.sourceObject === sourceObject && r.junctionObject === null);
}

export { WRITING_PROTOCOLS };

function refused(message: string, code: string, details: Record<string, string | number | boolean> = {}): AppError {
  return new AppError('validation', message, { code, details });
}

function checkCel(source: string, inputs: Readonly<Record<string, CelType>>, at: string): void {
  try {
    compileCel(source, inputs);
  } catch (error) {
    throw refused(`the CEL at ${at} does not type check`, 'action_type.expression_invalid', { at });
  }
}

interface CheckedVersion {
  properties: Record<string, string>;
  permittedOperations: ActionTypeVersionView['permittedOperations'];
  riskClass: VersionDefinition['riskClass'];
  /** compensating: the custom action that undoes the one invoked. */
  compensatingAction: string | null;
}

/** Checks a definition against its ontology version and the connections' manifests. */
export function checkDefinition(def: VersionDefinition, ontology: OntologyManifest, connections: ReadonlyMap<string, ConnectionWithManifest>): CheckedVersion {
  const type: ObjectTypeView | undefined = ontology.objectTypes.find((t) => t.id === def.objectTypeId);
  if (type === undefined) throw refused('the object type is not in that ontology version', 'action_type.object_type_unknown');
  if (type.status !== 'active') throw refused('the object type is not active in that ontology version', 'action_type.object_type_inactive');

  // Properties: listed, stored, mapped on a permitted connection.
  const byName = new Map(type.properties.map((p) => [p.apiName, p]));
  const properties: Record<string, string> = {};
  for (const name of new Set(def.properties)) {
    const property = byName.get(name);
    if (property === undefined) throw refused(`${name} is not a property of the type`, 'action_type.property_unknown', { property: name });
    if (property.computedFunctionVersionId !== null) throw refused(`${name} is computed and cannot be written`, 'action_type.property_computed', { property: name });
    if (property.status !== 'active') throw refused(`${name} is not active`, 'action_type.property_inactive', { property: name });
    if (!property.mappings.some((m) => def.permittedConnections.includes(m.connectionId))) {
      throw refused(`${name} is not mapped on any permitted connection`, 'action_type.property_unmapped', { property: name });
    }
    properties[name] = property.identityId;
  }

  // Parameters.
  const names = new Set<string>();
  for (const p of def.parameters) {
    if (names.has(p.name)) throw refused('parameter names are unique', 'action_type.parameter_duplicate', { parameter: p.name });
    names.add(p.name);
    if (p.objectTypeId !== undefined && !ontology.objectTypes.some((t) => t.id === p.objectTypeId)) {
      throw refused(`${p.name} references an object type not in that ontology version`, 'action_type.object_type_unknown', { parameter: p.name });
    }
  }
  const paramInputs = Object.fromEntries(def.parameters.map((p) => [p.name, CEL_TYPE[p.type]]));
  for (const p of def.parameters) {
    if (p.validation !== undefined) checkCel(p.validation, paramInputs, `parameters.${p.name}.validation`);
    if (p.default !== undefined) checkCel(p.default, paramInputs, `parameters.${p.name}.default`);
  }

  // Rules.
  const listed = (property: string, at: string) => {
    if (properties[property] === undefined) throw refused(`${property} is not listed among the properties the type may change`, 'action_type.property_not_listed', { at });
  };
  const source = (value: { parameter: string } | { cel: string }, at: string) => {
    if ('parameter' in value) {
      if (!names.has(value.parameter)) throw refused(`${value.parameter} is not a parameter`, 'action_type.parameter_unknown', { at });
    } else {
      checkCel(value.cel, { params: 'map', current: 'map' }, at);
    }
  };
  def.rules.forEach((rule, i) => {
    const at = `rules.${i}`;
    if (rule.kind === 'set_property') {
      listed(rule.property, at);
      source(rule.value, `${at}.value`);
    } else if (rule.kind === 'clear_property') {
      listed(rule.property, at);
      if (!byName.get(rule.property)!.nullable) throw refused(`${rule.property} may not be null`, 'action_type.property_not_nullable', { at });
    } else if (rule.kind === 'create_object') {
      for (const [property, value] of Object.entries(rule.values)) {
        listed(property, `${at}.values.${property}`);
        source(value, `${at}.values.${property}`);
      }
    } else if (rule.kind === 'add_link' || rule.kind === 'remove_link') {
      const link = ontology.linkTypes.find((l) => l.apiName === rule.linkType);
      if (link === undefined) throw refused(`${rule.linkType} is not a link type in that ontology version`, 'action_type.link_type_unknown', { at });
      if (link.status !== 'active') throw refused(`${rule.linkType} is not active`, 'action_type.link_type_inactive', { at });
      if (link.fromTypeId !== type.id && link.toTypeId !== type.id) throw refused(`${rule.linkType} does not link the target type`, 'action_type.link_type_unrelated', { at });
      if (rule.kind === 'add_link') {
        const other = link.fromTypeId === type.id ? link.toTypeId : link.fromTypeId;
        const p = def.parameters.find((x) => x.name === rule.object.parameter);
        if (p === undefined) throw refused(`${rule.object.parameter} is not a parameter`, 'action_type.parameter_unknown', { at });
        if (p.type !== 'object_reference' || p.objectTypeId !== other) {
          throw refused(`${p.name} must be an object_reference to the other end of ${rule.linkType}`, 'action_type.link_parameter', { at });
        }
      }
    } else if (rule.kind === 'invoke_custom') {
      for (const [input, value] of Object.entries(rule.inputs)) source(value, `${at}.inputs.${input}`);
    }
  });
  const kinds = new Set(def.rules.map((r) => r.kind));
  if (kinds.has('delete_object') && kinds.size > 1) {
    throw refused('a delete is its own Action type', 'action_type.rules_mixed');
  }
  const custom = def.rules.find((r) => r.kind === 'invoke_custom');
  if (custom !== undefined && def.rules.length > 1) {
    throw refused('a custom action is its own Action type: its effect is what the manifest declares', 'action_type.rules_mixed');
  }
  const linked = new Set<string>();
  for (const rule of def.rules) {
    if (rule.kind !== 'add_link' && rule.kind !== 'remove_link') continue;
    if (linked.has(rule.linkType)) throw refused(`${rule.linkType} is linked or unlinked once per Action type`, 'action_type.link_twice');
    linked.add(rule.linkType);
  }
  if (def.submissionCriteria !== undefined) checkCel(def.submissionCriteria, { object: 'map', params: 'map' }, 'submissionCriteria');
  if (def.revertBehaviour === 'compensating' && custom === undefined) {
    throw refused('a compensating revert invokes a custom action that undoes the one this type invokes', 'action_type.revert_unsupported');
  }
  if (def.revertBehaviour !== 'compensating' && def.compensatingAction !== undefined) {
    throw refused('a compensating action is named for a compensating revert only', 'action_type.compensating_unused');
  }
  if (def.revertBehaviour === 'not_revertible' && def.riskClass !== 'physical') {
    throw refused('only a physical command with no state value is not reversible (42.8)', 'action_type.not_revertible_physical_only');
  }

  // Connections and their operations.
  const operations = operationsOf(def.rules);
  const permittedOperations: CheckedVersion['permittedOperations'] = {};
  let physical = false;
  let commands = false;
  let compensatingAction: string | null = null;
  for (const connectionId of new Set(def.permittedConnections)) {
    const contributing = type.contributingObjects.find((c) => c.connectionId === connectionId);
    if (contributing === undefined) {
      throw refused('a permitted connection does not contribute the type', 'action_type.connection_not_contributing', { connectionId });
    }
    const found = connections.get(connectionId);
    if (found === undefined) throw refused('no such connection', 'action_type.connection_unknown', { connectionId });
    if (!(WRITING_PROTOCOLS as readonly string[]).includes(found.manifest.protocol.kind)) {
      throw refused(`the ${found.manifest.protocol.kind} transport does not write yet`, 'action_type.transport_unsupported', { connectionId });
    }
    const object = found.manifest.objects.find((o) => o.name === contributing.sourceObject);
    if (object === undefined) throw refused('the connection no longer declares the source object', 'action_type.source_object_unknown', { connectionId });
    const offered = operationsOn(object, operations);
    if (offered.missing !== null) {
      throw refused(`the connection's manifest declares no ${offered.missing} on ${object.name}`, 'action_type.operation_undeclared', { connectionId, operation: offered.missing });
    }
    if (object.identifier.length !== 1) {
      throw refused('records with a composite identifier are not written yet', 'action_type.composite_identifier', { connectionId });
    }
    if (offered.operations.includes('upsert')) {
      // An upsert names the record it creates or updates: the rule gives the identifier a value.
      const create = def.rules.find((r) => r.kind === 'create_object');
      const idProperty = type.properties.find((p) => p.mappings.some((m) => m.connectionId === connectionId && m.fieldPath === object.identifier[0]));
      if (create?.kind === 'create_object' && (idProperty === undefined || create.values[idProperty.apiName] === undefined)) {
        throw refused(`${object.name} is written by upsert, which names its record: give the identifier a value`, 'action_type.upsert_identifier', { connectionId });
      }
    }
    if (object.writes?.risk === 'physical') physical = true;
    const entry: ActionTypeVersionView['permittedOperations'][string] = { sourceObject: object.name, manifestId: found.manifestId, operations: offered.operations };

    // Links: a foreign key the target holds, referencing the other end's identifier.
    const linkFields: Record<string, string> = {};
    for (const rule of def.rules) {
      if (rule.kind !== 'add_link' && rule.kind !== 'remove_link') continue;
      const link = ontology.linkTypes.find((l) => l.apiName === rule.linkType)!;
      const route = heldRoute(link, connectionId, object.name);
      if (route === undefined) {
        const joined = link.routes.some((r) => r.connectionId === connectionId && r.junctionObject !== null);
        throw refused(joined
          ? `${rule.linkType} is held by a join record: write it with an Action type over the join record's type (create_object, delete_object)`
          : `${rule.linkType} is not a foreign key ${object.name} holds on this connection: write it from the other end's type`,
        joined ? 'action_type.link_join_record' : 'action_type.link_held_elsewhere', { connectionId });
      }
      const key = object.fields.find((f) => f.name === route.foreignKeyField);
      if (key === undefined) throw refused(`${route.foreignKeyField} is not a field of ${object.name}`, 'action_type.link_key_unknown', { connectionId });
      const otherTypeId = link.fromTypeId === type.id ? link.toTypeId : link.fromTypeId;
      // The other end where the route reads it: this system, or the one it names (D248).
      const otherEnd = ontology.objectTypes.find((t) => t.id === otherTypeId)?.contributingObjects.find((c) => route.referencedConnectionId == null
        ? c.connectionId === connectionId : c.connectionId === route.referencedConnectionId && c.sourceObject === route.referencedObject);
      if (otherEnd === undefined || otherEnd.identifierFieldPath !== route.referencedField) {
        throw refused(`${rule.linkType} must reference the other end's identifier on this connection`, 'action_type.link_key_not_identifier', { connectionId });
      }
      if (rule.kind === 'remove_link' && !key.nullable) {
        throw refused(`${route.foreignKeyField} may not be null, so the link cannot be removed`, 'action_type.link_key_not_nullable', { connectionId });
      }
      linkFields[rule.linkType] = route.foreignKeyField;
    }
    if (Object.keys(linkFields).length > 0) entry.linkFields = linkFields;

    // A custom action, and for a compensating revert the one that undoes it.
    if (custom !== undefined && custom.kind === 'invoke_custom') {
      const declared = object.writes?.custom.find((c) => c.name === custom.customAction);
      if (declared === undefined) {
        throw refused(`the connection's manifest declares no custom action ${custom.customAction} on ${object.name}`, 'action_type.operation_undeclared', { connectionId, operation: 'custom' });
      }
      entry.customActions = [declared.name];
      // A physical command (47.1): an OPC UA method, with the input arguments it declares (D245), or an MQTT publish.
      if (declared.opcua !== undefined || declared.mqtt !== undefined) {
        commands = true;
        // Without a body, the custom action's inputs are the method's arguments by name: exactly those it takes.
        if (declared.opcua !== undefined && declared.body === undefined) {
          const takes = declared.opcua.arguments.map((a) => a.input ?? a.name).sort();
          const given = Object.keys(custom.inputs).sort();
          if (takes.join('\n') !== given.join('\n')) {
            throw refused(`the method ${declared.opcua.method} takes ${takes.length === 0 ? 'no input arguments' : `the input arguments ${takes.join(', ')}`}: the custom action's inputs name exactly those`,
              'action_type.inputs_mismatch', { connectionId });
          }
        }
      }
      if (def.revertBehaviour === 'compensating') {
        const undo = def.compensatingAction ?? declared.compensatedBy;
        if (undo === undefined) throw refused(`${declared.name} declares no compensating action; name one`, 'action_type.compensating_unknown', { connectionId });
        if (def.compensatingAction !== undefined && declared.compensatedBy !== undefined && declared.compensatedBy !== def.compensatingAction) {
          throw refused(`the manifest says ${declared.compensatedBy} undoes ${declared.name}`, 'action_type.compensating_mismatch', { connectionId });
        }
        if (!object.writes!.custom.some((c) => c.name === undo) || undo === declared.name) {
          throw refused(`the connection's manifest declares no custom action ${undo} on ${object.name}`, 'action_type.compensating_unknown', { connectionId });
        }
        if (compensatingAction !== null && compensatingAction !== undo) {
          throw refused('every permitted connection compensates with the same custom action', 'action_type.compensating_mismatch', { connectionId });
        }
        compensatingAction = undo;
        entry.customActions.push(undo);
      }
    }
    permittedOperations[connectionId] = entry;
  }
  // A command has no state value (47.1): it is reverted by its inverse, or not at all; and only a command is not_revertible.
  if (commands && def.revertBehaviour !== 'compensating' && def.revertBehaviour !== 'not_revertible') {
    throw refused('a command has no state value: it is reverted by its inverse (compensating) or not at all (not_revertible)', 'action_type.command_revert');
  }
  // A physical webhook (47.1) is a command too: it has no state value.
  if (def.revertBehaviour === 'not_revertible' && !commands && !def.sideEffects.some((e) => e.physical)) {
    throw refused('only a physical command with no state value is not reversible (42.8)', 'action_type.not_revertible_physical_only');
  }
  const forced = physical || def.sideEffects.some((e) => e.physical) ? 'physical' : def.sideEffects.some((e) => e.kind === 'webhook') ? 'external' : 'data';
  const rank = { data: 0, external: 1, physical: 2 } as const;
  if (rank[def.riskClass] < rank[forced]) {
    throw refused(`a connection or side effect makes this type ${forced}; declare it so`, 'action_type.risk_class_low', { required: forced });
  }
  return { properties, permittedOperations, riskClass: def.riskClass, compensatingAction };
}

// ----------------------------------------------------------------------------- views

function parameterView(p: ActionParameter): ParameterDefinition {
  return {
    name: p.name, type: p.paramType, required: p.required,
    ...(p.objectTypeId === null ? {} : { objectTypeId: p.objectTypeId }),
    ...(p.enumValues === null ? {} : { enumValues: p.enumValues }),
    ...(p.defaultExpression === null ? {} : { default: p.defaultExpression }),
    ...(p.validation === null ? {} : { validation: p.validation }),
    ...(p.validationMessage === null ? {} : { message: p.validationMessage }),
  };
}

export function versionView(v: ActionTypeVersion, parameters: readonly ActionParameter[]): ActionTypeVersionView {
  const targets = v.targets as { objectTypeId: string; properties: Record<string, string> };
  return {
    id: v.id, version: v.version, ontologyVersionId: v.ontologyVersionId, objectTypeId: targets.objectTypeId, properties: targets.properties,
    parameters: parameters.map(parameterView), rules: v.rules as ActionRule[], permittedConnections: v.permittedConnections,
    permittedOperations: v.permittedOperations as ActionTypeVersionView['permittedOperations'], riskClass: v.riskClass,
    revertBehaviour: v.revertBehaviour, compensatingAction: v.compensatingAction, submissionCriteria: v.submissionCriteria,
    approvalPolicyId: v.approvalPolicyId, sideEffects: v.sideEffects as ActionTypeVersionView['sideEffects'], description: v.description,
    confirmedBy: v.confirmedBy, confirmedAt: v.confirmedAt,
  };
}

export function typeView(t: ActionType, current: ActionTypeVersionView | null): ActionTypeView {
  return {
    id: t.id, apiName: t.apiName, displayName: t.displayName, status: t.status, owningScopeId: t.owningScopeId, isSystem: t.isSystem,
    createdAt: t.createdAt, retiredAt: t.retiredAt, version: t.version, current,
  };
}

// ----------------------------------------------------------------------------- service

export function createActionTypes(deps: WriteBackDeps) {
  const control = deps.databases.pool('control');

  async function load(ctx: Context, id: string): Promise<ActionTypeView> {
    return inTransaction(control, ctx.request, async (db) => {
      const type = await actionTypeRepo.findById(db, id);
      if (!type) throw new AppError('not_found', 'no such Action type', { code: 'action_type.not_found' });
      // silo.edit's versions carry no content: each edit compiles its own definition (genericEdit.service.ts).
      if (type.currentVersionId === null || type.isSystem) return typeView(type, null);
      const version = (await actionTypeVersionRepo.findById(db, type.currentVersionId))!;
      return typeView(type, versionView(version, await actionParameterRepo.listByVersion(db, version.id)));
    }, { readOnly: true });
  }

  return {
    get: load,

    async list(ctx: Context, status: ActionType['status'] | undefined, limit: number, objectTypeId?: string): Promise<ActionTypeView[]> {
      const types = await inTransaction(control, ctx.request, (db) => actionTypeRepo.list(db, status, limit), { readOnly: true });
      const loaded = await Promise.all(types.map((t) => load(ctx, t.id)));
      return objectTypeId === undefined ? loaded : loaded.filter((t) => t.current?.objectTypeId === objectTypeId);
    },

    async propose(ctx: Context, input: { apiName: string; displayName: string; owningScopeId: string }): Promise<ActionTypeView> {
      const { organisationId, membershipId } = memberOf(ctx, 'proposing an Action type');
      if (input.apiName.startsWith('silo.')) throw refused('silo. names are Silo\'s own', 'action_type.name_reserved');
      await demand(deps, ctx, 'action.define', input.owningScopeId, 'action_type.not_permitted');
      const id = uuidv7();
      try {
        await inTransaction(control, ctx.request, async (db) => {
          await actionTypeRepo.insert(db, {
            id, organisationId, apiName: input.apiName, displayName: input.displayName, owningScopeId: input.owningScopeId,
            proposedByMembershipId: membershipId,
          });
          await recordActionEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'action_type_proposed', request: ctx.request, service: 'actions',
            resource: { type: 'action_type', id }, scopeId: input.owningScopeId,
          });
        });
      } catch (error) {
        if (fromDatabaseError(error).category === 'conflict') {
          throw new AppError('conflict', 'an Action type of that name exists', { code: 'action_type.name_taken' });
        }
        throw error;
      }
      return load(ctx, id);
    },

    async publish(ctx: Context, actionTypeId: string, def: VersionDefinition): Promise<ActionTypeView> {
      const { organisationId, membershipId } = memberOf(ctx, 'confirming an Action type');
      const existing = await load(ctx, actionTypeId);
      if (existing.isSystem) throw refused('the generic governed edit is Silo\'s own', 'action_type.system');
      if (existing.status === 'retired') throw new AppError('conflict', 'a retired Action type takes no new version', { code: 'action_type.retired' });
      await demand(deps, ctx, 'action.define', existing.owningScopeId, 'action_type.not_permitted');

      const ontology = await ontologyAt(deps, ctx, def.ontologyVersionId);
      const connections = await inTransaction(control, ctx.request, async (db) => {
        const out = new Map<string, ConnectionWithManifest>();
        for (const id of new Set(def.permittedConnections)) {
          try {
            out.set(id, await connectionWithManifest(db, id));
          } catch {
            // Reported by the check as an unknown connection.
          }
        }
        return out;
      }, { readOnly: true });
      // A webhook side effect posts to an outbound target that is live; one declared physical makes the type physical (42.6, 20.5).
      const targets = await inTransaction(control, ctx.request, async (db) => Promise.all(def.sideEffects.filter((e) => e.kind === 'webhook')
        .map(async (e) => ({ effect: e, endpoint: await webhookEndpointRepo.findById(db, e.endpointId!) }))), { readOnly: true });
      for (const { effect, endpoint } of targets) {
        if (endpoint === undefined || endpoint.direction !== 'outbound' || endpoint.status !== 'active') {
          throw refused('a webhook side effect posts to an active outbound target', 'action_type.webhook_target', { endpointId: effect.endpointId! });
        }
        if (endpoint.riskClass === 'physical') effect.physical = true;
        if (effect.payload !== undefined) {
          try {
            compileExpression('webhook.payload', 'jsonata', effect.payload.jsonata);
          } catch {
            throw refused('the webhook payload is not valid JSONata', 'action_type.expression_invalid', { at: 'sideEffects.payload' });
          }
        }
      }
      const checked = checkDefinition(def, ontology, connections);

      const versionId = uuidv7();
      await inTransaction(control, ctx.request, async (db) => {
        const type = await actionTypeRepo.findForUpdate(db, actionTypeId);
        if (!type || type.status === 'retired') throw new AppError('conflict', 'the Action type changed; read it again', { code: 'action_type.stale' });
        const next = await actionTypeVersionRepo.latestVersionNumber(db, actionTypeId) + 1;
        await actionTypeVersionRepo.insert(db, {
          id: versionId, organisationId, actionTypeId, version: next, ontologyVersionId: def.ontologyVersionId, description: def.description ?? null,
          targets: { objectTypeId: def.objectTypeId, properties: checked.properties }, rules: def.rules, permittedConnections: [...new Set(def.permittedConnections)],
          permittedOperations: checked.permittedOperations as never, sideEffects: def.sideEffects as never, riskClass: checked.riskClass,
          approvalPolicyId: def.approvalPolicyId ?? null, revertBehaviour: def.revertBehaviour, compensatingAction: checked.compensatingAction,
          submissionCriteria: def.submissionCriteria ?? null, confirmedBy: membershipId,
        });
        let sequence = 0;
        for (const p of def.parameters) {
          await actionParameterRepo.insert(db, {
            id: uuidv7(), organisationId, actionTypeVersionId: versionId, sequence: ++sequence, name: p.name, paramType: p.type,
            objectTypeId: p.objectTypeId ?? null, enumValues: p.enumValues ?? null, required: p.required, defaultExpression: p.default ?? null,
            validation: p.validation ?? null, validationMessage: p.message ?? null,
          });
        }
        const first = type.status === 'proposed';
        await actionTypeRepo.update(db, actionTypeId, {
          currentVersionId: versionId, status: type.status === 'blocked' ? 'confirmed' : first ? 'confirmed' : type.status, version: type.version + 1,
        });
        const event = { organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions' as const,
          resource: { type: 'action_type' as const, id: actionTypeId }, scopeId: type.owningScopeId };
        await recordActionEvent(db, { ...event, event: 'action_type_version_published', detail: { version: next, risk_class: checked.riskClass, action_type_version_id: versionId } });
        // warehouse_target_confirmed (48.1): a SQL table becomes a write target only when a confirmed Action type names it.
        for (const [connectionId, permitted] of Object.entries(checked.permittedOperations)) {
          if (connections.get(connectionId)?.manifest.protocol.kind !== 'sql') continue;
          await recordActionEvent(db, {
            ...event, event: 'warehouse_target_confirmed',
            detail: { connection_id: connectionId, source_object: permitted.sourceObject.slice(0, 200), operations: permitted.operations.join(','), action_type_version_id: versionId },
          });
        }
        if (first) {
          await recordActionEvent(db, { ...event, event: 'action_type_confirmed', detail: { version: next } });
          // The ontology now carries it (21): its object type and risk class.
          await recordActionEvent(db, { ...event, event: 'action_type_defined', detail: { version: next, object_type_id: def.objectTypeId ?? null, risk_class: checked.riskClass } });
        }
      });
      return load(ctx, actionTypeId);
    },

    /** Declines a proposed type, never confirmed (42.10): rejected, with no version, and action_type_rejected says why. */
    async reject(ctx: Context, actionTypeId: string, version: number, reason: string): Promise<ActionTypeView> {
      const { organisationId } = memberOf(ctx, 'rejecting an Action type');
      const existing = await load(ctx, actionTypeId);
      if (existing.isSystem) throw refused('the generic governed edit is Silo\'s own', 'action_type.system');
      await demand(deps, ctx, 'action.define', existing.owningScopeId, 'action_type.not_permitted');
      await inTransaction(control, ctx.request, async (db) => {
        const type = await actionTypeRepo.findForUpdate(db, actionTypeId);
        if (!type || type.version !== version) throw new AppError('conflict', 'the Action type changed; read it again', { code: 'action_type.stale' });
        if (type.status !== 'proposed') throw new AppError('conflict', `a ${type.status} Action type is retired, not rejected`, { code: 'action_type.status_move' });
        await actionTypeRepo.update(db, actionTypeId, { status: 'rejected', rejectedAt: new Date().toISOString(), version: type.version + 1 });
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'action_type_rejected', request: ctx.request, service: 'actions',
          resource: { type: 'action_type', id: actionTypeId }, scopeId: type.owningScopeId, detail: { reason },
        });
      });
      return load(ctx, actionTypeId);
    },

    /**
     * Whether every operation the current version uses is still declared by each permitted
     * connection's manifest as it is now (43: an Action never writes through an operation the
     * source no longer declares). The first that is not, or undefined.
     */
    async undeclaredOperation(ctx: Context, type: ActionTypeView): Promise<{ connectionId: string; operation: string } | undefined> {
      const version = type.current;
      if (version === null) return undefined;
      return inTransaction(control, ctx.request, async (db) => {
        for (const [connectionId, permitted] of Object.entries(version.permittedOperations)) {
          let found: ConnectionWithManifest;
          try {
            found = await connectionWithManifest(db, connectionId);
          } catch {
            return { connectionId, operation: permitted.operations[0] ?? 'update_partial' };
          }
          const object = found.manifest.objects.find((o) => o.name === permitted.sourceObject);
          if (object === undefined) return { connectionId, operation: permitted.operations[0] ?? 'update_partial' };
          const missing = operationsOn(object, permitted.operations).missing;
          if (missing !== null) return { connectionId, operation: missing };
          for (const custom of permitted.customActions ?? []) {
            if (!(object.writes?.custom ?? []).some((c) => c.name === custom)) return { connectionId, operation: 'custom' };
          }
        }
        return undefined;
      }, { readOnly: true });
    },

    /**
     * Blocks a confirmed type whose operations a connection no longer declares (42.11's blocked):
     * no new mutation compiles against it until a new version is published, which unblocks it.
     * Reverts are unaffected: they use the version in the receipt.
     */
    async block(ctx: Context, actionTypeId: string, gap: { connectionId: string; operation: string }): Promise<void> {
      await inTransaction(control, ctx.request, async (db) => {
        const type = await actionTypeRepo.findForUpdate(db, actionTypeId);
        if (!type || type.status !== 'confirmed') return;
        await actionTypeRepo.update(db, actionTypeId, { status: 'blocked', version: type.version + 1 });
        await recordActionEvent(db, {
          organisationId: type.organisationId, correlationId: ctx.correlationId, event: 'action_type_blocked', request: ctx.request, service: 'actions',
          resource: { type: 'action_type', id: actionTypeId }, scopeId: type.owningScopeId,
          detail: { connection_id: gap.connectionId, operation: gap.operation },
        });
      });
    },

    async retire(ctx: Context, actionTypeId: string, version: number): Promise<ActionTypeView> {
      const { organisationId } = memberOf(ctx, 'retiring an Action type');
      const existing = await load(ctx, actionTypeId);
      if (existing.isSystem) throw refused('the generic governed edit is disabled, not retired', 'action_type.system');
      await demand(deps, ctx, 'action.define', existing.owningScopeId, 'action_type.not_permitted');
      await inTransaction(control, ctx.request, async (db) => {
        const type = await actionTypeRepo.findForUpdate(db, actionTypeId);
        if (!type || type.version !== version) throw new AppError('conflict', 'the Action type changed; read it again', { code: 'action_type.stale' });
        if (type.status !== 'confirmed' && type.status !== 'blocked') {
          throw new AppError('conflict', `a ${type.status} Action type cannot be retired`, { code: 'action_type.status_move' });
        }
        await actionTypeRepo.update(db, actionTypeId, { status: 'retired', retiredAt: new Date().toISOString(), version: type.version + 1 });
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'action_type_retired', request: ctx.request, service: 'actions',
          resource: { type: 'action_type', id: actionTypeId }, scopeId: type.owningScopeId,
        });
      });
      return load(ctx, actionTypeId);
    },
  };
}

export type ActionTypes = ReturnType<typeof createActionTypes>;
