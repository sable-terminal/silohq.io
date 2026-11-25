// The generic governed edit (spec 42.9): silo.edit, the one system Action type each
// organisation has, so a change no confirmed Action type covers is still a governed write.
//
// It may set or clear properties, create or delete objects, through operations the source's
// manifest declares; it never invokes a custom action, fires a webhook or writes to an
// industrial transport or a physical endpoint. It passes the full mutation path (intent,
// resolve, policy gate, plan, prior state, preview, approval) and is recorded as a generic
// edit (mutations.generic_edit), so it is countable; generic_edit_compiled is the event a
// reviewer reads first. An organisation may disable it: an edit is then refused, and the
// refusal offers to propose an Action type for the change to a holder of action.define.
//
// Silo defines it, not a person: the row has no proposer and its versions no confirming
// member. It is made the first time the organisation needs it. A version carries no content
// of its own: one is published for each ontology version an edit compiles against, so a
// mutation records the version it compiled against (42.10). Each edit compiles its own
// definition (the object type, the properties, the rules and the connections that declare
// the operations), checked exactly as a published version is, and its mutation's manifest
// keeps it, so execution and a revert read the source objects from there.

import type { z } from 'zod';
import {
  versionDefinition, WRITING_PROTOCOLS, type ActionRule, type ActionTypeVersionView, type ParameterDefinition,
} from '../../contracts/actions/actionType.contract.ts';
import type { genericEdit } from '../../contracts/actions/mutation.contract.ts';
import { getActiveVersion, type DataType, type PropertyView } from '../../contracts/ontology/manifest.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { ActionType } from '../../models/action/actionType.model.ts';
import { actionTypeRepo, actionTypeVersionRepo } from '../../repos/action/index.repo.ts';
import { scopeRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { checkDefinition, operationsOf, operationsOn } from './actionTypes.service.ts';
import { callOptions, connectionWithManifest, ontologyAt, type ConnectionWithManifest, type Context, type WriteBackDeps } from './deps.service.ts';

export const GENERIC_EDIT = 'silo.edit';
export type GenericEdit = z.output<typeof genericEdit>;

/** What a generic edit's mutation manifest keeps: references and names, never a value (those are sealed as its parameters). */
export interface GenericEditManifest {
  objectTypeId: string;
  operation: GenericEdit['operation'];
  properties: string[];
  permittedOperations: ActionTypeVersionView['permittedOperations'];
}

/** The organisation's silo.edit row, made the first time it is needed. */
export async function ensureGenericEdit(db: Queryable, organisationId: string): Promise<ActionType> {
  const found = await actionTypeRepo.findSystem(db);
  if (found !== undefined) return found;
  const root = await scopeRepo.root(db);
  if (root === undefined) throw new AppError('integrity', 'the organisation has no root scope', { code: 'action_type.no_root_scope' });
  // A concurrent first use inserts the same row: the second waits on the unique index, then does nothing.
  await actionTypeRepo.insertSystemIfAbsent(db, { id: uuidv7(), organisationId, apiName: GENERIC_EDIT, displayName: 'Generic governed edit', owningScopeId: root.id });
  return (await actionTypeRepo.findSystem(db))!;
}

/** The system version for an ontology version, published the first time an edit compiles against it. */
async function versionFor(db: Queryable, organisationId: string, ontologyVersionId: string): Promise<{ type: ActionType; id: string; version: number }> {
  const type = await ensureGenericEdit(db, organisationId);
  const existing = await actionTypeVersionRepo.findForOntologyVersion(db, type.id, ontologyVersionId);
  if (existing !== undefined) return { type, id: existing.id, version: existing.version };
  const locked = (await actionTypeRepo.findForUpdate(db, type.id))!;
  const raced = await actionTypeVersionRepo.findForOntologyVersion(db, type.id, ontologyVersionId);
  if (raced !== undefined) return { type: locked, id: raced.id, version: raced.version };
  const id = uuidv7();
  const version = await actionTypeVersionRepo.latestVersionNumber(db, type.id) + 1;
  await actionTypeVersionRepo.insert(db, {
    id, organisationId, actionTypeId: type.id, version, ontologyVersionId,
    description: 'The generic governed edit (42.9): each mutation carries the definition compiled from what it changes.',
    targets: { generic: true }, rules: [], permittedConnections: [], permittedOperations: {}, sideEffects: [], riskClass: 'data',
    approvalPolicyId: null, revertBehaviour: 'three_way', compensatingAction: null, submissionCriteria: null, confirmedBy: null,
  });
  const updated = await actionTypeRepo.update(db, type.id, {
    currentVersionId: id, status: locked.status === 'proposed' ? 'confirmed' : locked.status, version: locked.version + 1,
  });
  return { type: updated!, id, version };
}

/** Each plain data type as a parameter; anything richer needs an Action type of its own. */
const PARAMETER_OF: Partial<Record<DataType, ParameterDefinition['type']>> = {
  string: 'string', integer: 'integer', decimal: 'decimal', boolean: 'boolean', date: 'date', timestamp: 'timestamp',
};

function parameterOf(property: PropertyView): ParameterDefinition {
  if (property.dataType === 'enum') {
    const values = property.typeParams['values'];
    const listed = Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string') ? values as string[] : undefined;
    return listed === undefined ? { name: property.apiName, type: 'string', required: true }
      : { name: property.apiName, type: 'enumeration', required: true, enumValues: listed };
  }
  const type = PARAMETER_OF[property.dataType];
  if (type === undefined) {
    throw new AppError('validation', `${property.apiName} is a ${property.dataType}: the generic edit sets plain values, so it needs an Action type`, {
      code: 'mutation.generic_edit_type', details: { property: property.apiName, dataType: property.dataType },
    });
  }
  return { name: property.apiName, type, required: true };
}

const invalid = (message: string, code: string, details: Record<string, string> = {}): AppError =>
  new AppError('validation', message, { code, details });

export interface PreparedGenericEdit {
  type: ActionType;
  version: ActionTypeVersionView;
  manifest: GenericEditManifest;
}

/**
 * The edit compiled into its own definition against main's head, checked as a published
 * version is, under the system version for that ontology version. Refused where the
 * organisation has disabled it.
 */
export async function prepareGenericEdit(deps: WriteBackDeps, ctx: Context, edit: GenericEdit): Promise<PreparedGenericEdit> {
  const organisationId = ctx.request.organisationId!;
  const head = await deps.services.call(getActiveVersion, { query: {} }, callOptions(ctx));
  const control = deps.databases.pool('control');
  const system = await inTransaction(control, ctx.request, (db) => versionFor(db, organisationId, head.id));
  if (system.type.disabledAt !== null) {
    throw new AppError('conflict', 'the generic governed edit is disabled for this organisation: propose an Action type for this change to a holder of action.define', {
      code: 'mutation.generic_edit_disabled', details: { offer: 'propose_action_type', permission: 'action.define' },
    });
  }

  const ontology = await ontologyAt(deps, ctx, head.id);
  const objectType = ontology.objectTypes.find((t) => t.id === edit.objectTypeId);
  if (objectType === undefined || objectType.status !== 'active') {
    throw invalid('the object type is not active on main', 'mutation.generic_edit_object_type');
  }
  const byName = new Map(objectType.properties.map((p) => [p.apiName, p]));
  const named = [...Object.keys(edit.set), ...edit.clear];
  for (const name of named) if (!byName.has(name)) throw invalid(`${name} is not a property of the type`, 'action_type.property_unknown', { property: name });
  const parameters = Object.keys(edit.set).map((name) => parameterOf(byName.get(name)!));
  const rules: ActionRule[] = edit.operation === 'delete' ? [{ kind: 'delete_object' }]
    : edit.operation === 'create' ? [{ kind: 'create_object', values: Object.fromEntries(Object.keys(edit.set).map((p) => [p, { parameter: p }])) }]
      : [
        ...Object.keys(edit.set).map((p): ActionRule => ({ kind: 'set_property', property: p, value: { parameter: p } })),
        ...edit.clear.map((p): ActionRule => ({ kind: 'clear_property', property: p })),
      ];

  // The contributing connections that may take it: a writing transport, never a physical
  // object, declaring the operations the rules need and mapping a property it writes.
  const wanted = operationsOf(rules);
  const connections = new Map<string, ConnectionWithManifest>();
  await inTransaction(control, ctx.request, async (db) => {
    for (const contributing of objectType.contributingObjects) {
      let found: ConnectionWithManifest;
      try {
        found = await connectionWithManifest(db, contributing.connectionId);
      } catch {
        continue;
      }
      if (!(WRITING_PROTOCOLS as readonly string[]).includes(found.manifest.protocol.kind)) continue;
      const object = found.manifest.objects.find((o) => o.name === contributing.sourceObject);
      if (object === undefined || object.writes?.risk === 'physical' || operationsOn(object, wanted).missing !== null) continue;
      if (named.length > 0 && !named.some((n) => byName.get(n)!.mappings.some((m) => m.connectionId === contributing.connectionId))) continue;
      connections.set(contributing.connectionId, found);
    }
  }, { readOnly: true });
  if (connections.size === 0) {
    throw invalid(`no connection the generic edit may write declares a ${edit.operation} of this type`, 'mutation.generic_edit_unwritable');
  }
  const definition = versionDefinition.parse({
    ontologyVersionId: head.id, objectTypeId: objectType.id, properties: named, parameters, rules,
    permittedConnections: [...connections.keys()].slice(0, 20), riskClass: 'data', revertBehaviour: 'three_way', sideEffects: [],
  });
  const checked = checkDefinition(definition, ontology, connections);
  return {
    type: system.type,
    version: {
      id: system.id, version: system.version, ontologyVersionId: head.id, objectTypeId: objectType.id, properties: checked.properties,
      parameters: definition.parameters, rules: definition.rules, permittedConnections: definition.permittedConnections,
      permittedOperations: checked.permittedOperations, riskClass: 'data', revertBehaviour: 'three_way', compensatingAction: null,
      submissionCriteria: null, approvalPolicyId: null, sideEffects: [], description: null, confirmedBy: null, confirmedAt: new Date().toISOString(),
    },
    manifest: { objectTypeId: objectType.id, operation: edit.operation, properties: [...named].sort(), permittedOperations: checked.permittedOperations },
  };
}

/** The operations a mutation writes through: its own definition's for a generic edit, else its version's. */
export function permittedOperationsOf(mutation: { genericEdit: boolean; manifest: unknown }, version: { permittedOperations: unknown })
  : Record<string, { sourceObject: string }> {
  const own = mutation.genericEdit ? (mutation.manifest as { edit?: { permittedOperations?: unknown } }).edit?.permittedOperations : version.permittedOperations;
  return (own ?? {}) as Record<string, { sourceObject: string }>;
}
