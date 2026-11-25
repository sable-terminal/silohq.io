// Proposing a mutation (spec 43.1 to 43.8): every stage up to the preview, then the approval
// request. A stage that refuses records the stage and the check and writes nothing to a
// source; a refusal that needs no read is recorded before anything is read.
//
// intent        parameters: unknown names refused, defaults (CEL), required, types and
//               enumerations, validation (CEL) with its message (42.3).
// resolve       each object is a record on a permitted connection that contributes the type;
//               strict refuses on any unresolved object, partial excludes it (43.3). A record
//               the source does not have is unresolved too. Submission criteria (CEL over the
//               record and the parameters) are checked once the record is read.
// policy gate   mutation.propose; each connection reachable with write access; not halted;
//               writes earned; the transport writes; the Action type version confirmed and
//               every operation still declared by the manifest the connection runs now; every
//               written property and field visible to the proposer; billing permits (43.4).
// plan          per connection, the operations in order, each with an idempotency key; a plan
//               of 10,000 rows or more writes a canary sample first (43.9, 45.4), as the
//               preview says.
// prior state   the touched fields (an update, a link's foreign key, a custom action's declared
//               changes), the full readable record (a delete), recorded absence (a create),
//               read through connect-runtime with reason mutation (43.6).
// blast radius  the records that reference what is deleted or re-keyed, bounded (43.7).
// preview       the diff, computed once, sealed, hashed; the effective risk class (42.7).
// Then approval is requested; nothing is written until the chain is satisfied.
//
// A Cron's mutation (43.11) is proposed by its principal, on behalf of the member who
// authorised it, who is recorded with it. In execute mode it runs without a person present
// only inside every bound set when it was authorised: data risk class, not the generic edit,
// fewer than 100 rows and no more than its maximum, only property writes, only the
// properties and connections it names. Anything outside falls back to propose; 10,000 rows or more is refused outright
// rather than running a canary unattended.

import { webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import type { ActionTypeVersionView, ParameterDefinition, ValueSource } from '../../contracts/actions/actionType.contract.ts';
import type { CheckOutcome, MutationView, ObjectReference, Preview, PreviewRow, Promotion } from '../../contracts/actions/mutation.contract.ts';
import { requestApproval } from '../../contracts/approvals/approval.contract.ts';
import { readRecords } from '../../contracts/connect-runtime/write.contract.ts';
import type { ObjectTypeView } from '../../contracts/ontology/manifest.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { tenantMigrationRepo } from '../../repos/platform/tenantMigration.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import { CEL_TYPE, stillDeclared, WRITING_PROTOCOLS, type ActionTypes } from './actionTypes.service.ts';
import { physicalPlan, physicalPreview, recordPhysicalProposed, type PhysicalNode } from './physical.service.ts';
import { actionTypeVersionRepo, mutationRepo, receiptRepo } from '../../repos/action/index.repo.ts';
import { walkBlastRadius } from './blastRadius.service.ts';
import { prepareGenericEdit, type GenericEdit } from './genericEdit.service.ts';
import { recordActionEvent } from './events.service.ts';
import {
  accessOf, callOptions, CANARY, memberOf, ontologyAt, permitted, readConnections, type ConnectionWithManifest, type Context, type WriteBackDeps,
} from './deps.service.ts';
import {
  mutationView, objectIdentity, persistMutation, persistRefusal, type ExcludedTarget, type Operation, type PlannedTarget, type RiskClass,
} from './store.service.ts';

export const CEL_BOUNDS = { steps: 10_000, timeMs: 10 } as const;
export const BULK_ROWS = 100;

const RISK_RANK: Readonly<Record<RiskClass, number>> = { data: 0, bulk: 1, external: 2, physical: 3 };
export const highest = (...classes: RiskClass[]): RiskClass => classes.reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a), 'data');

class Refusal extends Error {
  readonly stage: 'intent' | 'resolve' | 'policy_gate' | 'plan' | 'read_prior_state';
  constructor(stage: Refusal['stage'], reason: string) {
    super(reason);
    this.stage = stage;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function typed(def: ParameterDefinition, value: unknown): boolean {
  switch (def.type) {
    case 'string': case 'object_reference': case 'attachment_reference': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'decimal': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'date': return typeof value === 'string' && DATE.test(value);
    case 'timestamp': return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'enumeration': return typeof value === 'string' && (def.enumValues ?? []).includes(value);
    case 'object_set_reference': return value !== null && value !== undefined;
  }
}

/** The intent stage's parameter checks (42.3). Returns the parameter values. */
export function resolveParameters(defs: readonly ParameterDefinition[], given: Record<string, unknown>): Record<string, unknown> {
  const known = new Set(defs.map((d) => d.name));
  for (const name of Object.keys(given)) if (!known.has(name)) throw new Refusal('intent', `${name} is not a parameter of this Action type`);
  const inputs = Object.fromEntries(defs.map((d) => [d.name, CEL_TYPE[d.type]]));
  const values: Record<string, unknown> = {};
  for (const def of defs) values[def.name] = given[def.name] ?? null;
  for (const def of defs) {
    if (values[def.name] === null && def.default !== undefined) {
      values[def.name] = compileCel(def.default, inputs).evaluate(values, CEL_BOUNDS);
    }
    if (values[def.name] === null) {
      if (def.required) throw new Refusal('intent', `${def.name} is required`);
      continue;
    }
    if (!typed(def, values[def.name])) throw new Refusal('intent', `${def.name} must be a ${def.type}${def.type === 'enumeration' ? ' value it lists' : ''}`);
  }
  for (const def of defs) {
    if (def.validation === undefined) continue;
    let ok: unknown;
    try {
      ok = compileCel(def.validation, inputs).evaluate(values, CEL_BOUNDS);
    } catch {
      ok = false;
    }
    if (ok !== true) throw new Refusal('intent', def.message ?? `${def.name} failed its validation: ${def.validation}`);
  }
  return values;
}

function valueOf(source: ValueSource, params: Record<string, unknown>, current: Record<string, unknown>): unknown {
  if ('parameter' in source) return params[source.parameter] ?? null;
  return compileCel(source.cel, { params: 'map', current: 'map' }).evaluate({ params, current }, CEL_BOUNDS);
}

/** A custom action's preview rows: the inputs sent, then each field it changes with its prior value, proposed unknown. */
export function customRows(t: PlannedTarget): PreviewRow[] {
  const base = { objectId: t.objectId, connectionId: t.connectionId, entityReference: t.entityReference, operation: 'custom' as const, customAction: t.customAction! };
  return [
    { ...base, field: null, prior: null, proposed: t.newValues as never, priorAbsent: false, proposedAbsent: false },
    ...t.fields.map((f) => ({ ...base, field: f, prior: (t.prior?.[f] ?? null) as never, proposed: null, priorAbsent: false, proposedAbsent: false, proposedUnknown: true })),
  ];
}

const fieldOf = (type: ObjectTypeView, property: string, connectionId: string): string | undefined =>
  type.properties.find((p) => p.apiName === property)?.mappings.find((m) => m.connectionId === connectionId)?.fieldPath;

/** A Cron's proposal (43.11): who authorised it, and, in execute mode, the bounds it must stay within. */
export interface CronProposal {
  authorisingMembershipId: string;
  execute: { maxRows: number; properties: string[]; connectionIds: string[] } | null;
}

function proposerOf(ctx: Context, cron: CronProposal | undefined): { organisationId: string; membershipId: string | null; principalId: string | null } {
  if (cron === undefined) {
    const { organisationId, membershipId } = memberOf(ctx, 'proposing a mutation');
    return { organisationId, membershipId, principalId: null };
  }
  if (ctx.request.organisationId === undefined || ctx.request.servicePrincipalId === undefined) {
    throw new AppError('forbidden', 'a Cron\'s mutation is proposed by its principal', { code: 'mutation.cron_principal_required' });
  }
  return { organisationId: ctx.request.organisationId, membershipId: null, principalId: ctx.request.servicePrincipalId };
}

export interface ProposalInput {
  /** Absent for a generic edit (silo.edit). */
  actionTypeId?: string | undefined; parameters: Record<string, unknown>; objects: ObjectReference[]; createOn?: string | undefined;
  /** The generic governed edit (42.9): what it changes, compiled into its own definition. */
  edit?: GenericEdit | undefined;
  resolutionPolicy: 'strict' | 'partial'; intent?: string | undefined; cron?: CronProposal | undefined;
  /** A scenario branch's staged Action entering the mutation path (39.8): its origin, and the properties a person took as current. */
  promotion?: Promotion | undefined;
  /** A physical Action's dry run against the simulator nodes (47.5); or, where one is required, the dry run's receipt this follows. */
  dryRun?: true | undefined;
  dryRunReceiptId?: string | undefined;
}

/** A promotion as its mutation's manifest records it: references and counts, never a value. */
const promotionManifest = (p: Promotion) => ({
  scenarioId: p.scenarioId, branchId: p.branchId, stagedActionId: p.stagedActionId, rowsTogether: p.rowsTogether, keptCurrent: p.keepCurrent.length,
  simulation: p.simulation,
});

export function createProposals(deps: WriteBackDeps & { actionTypes: ActionTypes; executionSeparated: boolean }) {
  // check: every stage up to the values, nothing written, nothing requested (a staged Action, 39.8).
  async function prepare(ctx: Context, input: ProposalInput, check: boolean): Promise<MutationView | CheckOutcome> {
    const { organisationId, membershipId, principalId } = proposerOf(ctx, input.cron);
    const cronOf = (mode: 'propose' | 'execute_within_bounds') => input.cron === undefined ? undefined
      : { principalId: principalId!, authorisingMembershipId: input.cron.authorisingMembershipId, mode };
    // The generic governed edit (42.9) compiles its own definition under silo.edit; anything else is an Action of a confirmed type.
    const generic = input.edit === undefined ? undefined : await prepareGenericEdit(deps, ctx, input.edit);
    const type = generic === undefined ? await deps.actionTypes.get(ctx, input.actionTypeId!) : { id: generic.type.id, isSystem: true };
    if (generic !== undefined && input.actionTypeId !== undefined && input.actionTypeId !== generic.type.id) {
      throw new AppError('validation', 'an edit is made through the generic governed edit only', { code: 'mutation.edit_not_generic' });
    }
    let version: ActionTypeVersionView;
    if (generic !== undefined) {
      version = generic.version;
    } else {
      const confirmed = type as Awaited<ReturnType<typeof deps.actionTypes.get>>;
      if (confirmed.isSystem) throw new AppError('validation', 'the generic governed edit says what it changes: give the edit', { code: 'mutation.edit_required' });
      if (confirmed.status !== 'confirmed' || confirmed.current === null) {
        throw new AppError('conflict', `the Action type is ${confirmed.status}: only a confirmed type takes new mutations`, { code: 'mutation.type_not_confirmed' });
      }
      // A connection whose manifest no longer declares an operation the version uses blocks the type until a new version is published.
      const gap = await deps.actionTypes.undeclaredOperation(ctx, confirmed);
      if (gap !== undefined) {
        await deps.actionTypes.block(ctx, confirmed.id, gap);
        throw new AppError('conflict', `the source no longer declares ${gap.operation}: the Action type is blocked until a new version is published`, {
          code: 'mutation.type_blocked', details: { connectionId: gap.connectionId, operation: gap.operation },
        });
      }
      version = confirmed.current;
    }
    const id = uuidv7();
    const manifest = {
      actionTypeId: type.id, actionTypeVersionId: version.id, version: version.version, objectTypeId: version.objectTypeId,
      rules: version.rules.map((r) => r.kind), properties: Object.keys(version.properties).sort(), objects: input.objects.length,
      ...(input.createOn === undefined ? {} : { createOn: input.createOn }),
      ...(input.promotion === undefined ? {} : { promotion: promotionManifest(input.promotion) }),
      // A generic edit's own definition: what execution and a revert read the source objects from.
      ...(generic === undefined ? {} : { edit: generic.manifest }),
    };
    const given = generic === undefined ? input.parameters : input.edit!.set;
    const values: Record<string, unknown> = { parameters: given };
    const refuse = async (error: Refusal): Promise<MutationView | CheckOutcome> => {
      if (check) return { outcome: 'refused', stage: error.stage, reason: error.message };
      await persistRefusal(deps, ctx, {
        id, organisationId, actionTypeVersionId: version.id, objectTypeId: version.objectTypeId, proposerMembershipId: membershipId, cron: cronOf('propose'),
        genericEdit: type.isSystem,
        promotion: input.promotion,
        riskClass: version.riskClass, resolutionPolicy: input.resolutionPolicy, manifest, values, intent: input.intent, stage: error.stage,
        reason: error.message, executionSeparated: deps.executionSeparated,
      });
      return mutationView(deps, ctx, id);
    };

    try {
      // intent
      const params = resolveParameters(version.parameters, given);
      values['parameters'] = params;
      // A promotion's decisions: a property taken as current on a conflicted record is not written there (39.8).
      const keptCurrent = (connectionId: string, reference: string, property: string): boolean => (input.promotion?.keepCurrent ?? [])
        .some((k) => k.connectionId === connectionId && k.reference === reference && k.property === property);
      const kinds = new Set(version.rules.map((r) => r.kind));
      const creates = kinds.has('create_object');
      const updates = kinds.has('set_property') || kinds.has('clear_property') || kinds.has('add_link') || kinds.has('remove_link');
      const deletes = kinds.has('delete_object');
      const customRule = version.rules.find((r) => r.kind === 'invoke_custom');
      const custom = customRule?.kind === 'invoke_custom' ? customRule : undefined;
      if ((updates || deletes || custom !== undefined) && input.objects.length === 0) throw new Refusal('intent', 'name the records the Action changes');
      if (!updates && !deletes && custom === undefined && input.objects.length > 0) throw new Refusal('intent', 'this Action creates a record; it names none');

      // resolve (structure)
      const ontology = await ontologyAt(deps, ctx, version.ontologyVersionId);
      const objectType = ontology.objectTypes.find((t) => t.id === version.objectTypeId);
      if (objectType === undefined) throw new Refusal('resolve', 'the Action type\'s object type is not in its ontology version');
      const excluded: ExcludedTarget[] = [];
      const resolved: ObjectReference[] = [];
      const operation: Operation = deletes ? 'delete' : custom !== undefined ? 'custom' : 'update_partial';
      const customAction = custom?.customAction;
      for (const ref of input.objects) {
        const permittedHere = version.permittedConnections.includes(ref.connectionId)
          && objectType.contributingObjects.some((c) => c.connectionId === ref.connectionId);
        if (permittedHere) resolved.push(ref);
        else excluded.push({ objectId: objectIdentity(organisationId, objectType.id, ref.connectionId, version.permittedOperations[ref.connectionId]?.sourceObject ?? objectType.contributingObjects.find((c) => c.connectionId === ref.connectionId)?.sourceObject ?? '', ref.reference), connectionId: ref.connectionId, reference: ref.reference, operation, customAction, reason: 'connection_not_permitted' });
      }
      // A create is a create, or an upsert where the source offers only that (42.4).
      const createsOn = (c: string) => version.permittedOperations[c]?.operations.some((o) => o === 'create' || o === 'upsert') === true;
      const createOn = creates ? input.createOn ?? version.permittedConnections.find(createsOn) : undefined;
      if (creates && (createOn === undefined || !createsOn(createOn))) {
        throw new Refusal('resolve', 'the record cannot be created on that connection');
      }
      if (excluded.length > 0 && input.resolutionPolicy === 'strict') throw new Refusal('resolve', `${excluded.length} object(s) are not on a connection this Action may write`);

      // policy gate
      const connectionIds = [...new Set([...resolved.map((r) => r.connectionId), ...(createOn === undefined ? [] : [createOn])])];
      if (!await permitted(deps, ctx, 'mutation.propose')) throw new Refusal('policy_gate', 'you need mutation.propose');
      const connections = await readConnections(deps, ctx.request, connectionIds);
      const writtenProperties = version.rules.flatMap((r) => r.kind === 'set_property' || r.kind === 'clear_property' ? [r.property]
        : r.kind === 'create_object' ? Object.keys(r.values) : []);
      // A custom action's declared changes, as the manifest the connection runs declares them.
      const changesOf = (connectionId: string): string[] => {
        if (custom === undefined) return [];
        const object = connections.get(connectionId)!.manifest.objects.find((o) => o.name === version.permittedOperations[connectionId]?.sourceObject);
        return object?.writes?.custom.find((c) => c.name === custom.customAction)?.changes ?? [];
      };
      const linkFieldsOf = (connectionId: string): Record<string, string> => version.permittedOperations[connectionId]?.linkFields ?? {};
      const fullOn = (connectionId: string): boolean => version.permittedOperations[connectionId]?.operations.includes('update_full') === true;
      const fieldsFor = (connectionId: string) => [...new Set([
        ...writtenProperties.map((p) => fieldOf(objectType, p, connectionId)).filter((f): f is string => f !== undefined),
        ...Object.values(linkFieldsOf(connectionId)), ...changesOf(connectionId),
      ])];
      const access = await accessOf(deps, ctx, {
        connections: connectionIds, objectTypes: [objectType.id],
        properties: writtenProperties.map((p) => version.properties[p]!).filter((p) => p !== undefined),
        fields: connectionIds.flatMap((c) => fieldsFor(c).map((path) => ({ connectionId: c, path }))),
      });
      await gate(connectionIds, connections, access, version, objectType, writtenProperties, fieldsFor);
      const organisation = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => organisationRepo.findById(db, organisationId), { readOnly: true });
      if (organisation?.billingStatus === 'suspended' || organisation?.billingStatus === 'cancelled') {
        throw new Refusal('policy_gate', `billing status ${organisation.billingStatus} refuses new mutations (reverts are permitted)`);
      }
      if (await inTransaction(deps.databases.pool('control'), ctx.request, (db) => tenantMigrationRepo.writesPaused(db, organisationId), { readOnly: true })) {
        throw new Refusal('policy_gate', 'the organisation is moving cell: Actions are paused until the move completes (spec 6.4)');
      }

      // plan sizes: at the canary's threshold a sample is written and confirmed first (45.4)
      const canary = deps.canary ?? CANARY;

      // read prior state, then the submission criteria and the values
      const targets: PlannedTarget[] = [];
      const notRestored: Preview['notRestored'] = [];
      const byConnection = new Map<string, ObjectReference[]>();
      for (const ref of resolved) byConnection.set(ref.connectionId, [...(byConnection.get(ref.connectionId) ?? []), ref]);
      const currentProps = (connectionId: string, record: Record<string, unknown> | null): Record<string, unknown> => {
        const out: Record<string, unknown> = {};
        if (record === null) return out;
        for (const p of objectType.properties) {
          const field = p.mappings.find((m) => m.connectionId === connectionId)?.fieldPath;
          if (field !== undefined && field in record) out[p.apiName] = record[field];
        }
        return out;
      };
      for (const [connectionId, refs] of byConnection) {
        const found = connections.get(connectionId)!;
        const sourceObject = version.permittedOperations[connectionId]!.sourceObject;
        const object = found.manifest.objects.find((o) => o.name === sourceObject)!;
        const readable = object.fields.map((f) => f.name).filter((f) => access.fieldEffect(connectionId, f) === 'allow');
        const touched = fieldsFor(connectionId);
        // A full update sends the whole record (42.5): every field is touched, so every one is read, and the proposer must be able to.
        const full = updates && fullOn(connectionId);
        if (full && readable.length < object.fields.length) {
          throw new Refusal('policy_gate', 'the source takes only a full update, which sends the whole record, and you cannot read every field of it');
        }
        // A delete reads the full readable record and every mapped field the criteria need; an update its touched fields and the mapped ones.
        const mapped = objectType.properties.map((p) => p.mappings.find((m) => m.connectionId === connectionId)?.fieldPath).filter((f): f is string => f !== undefined);
        const fields = [...new Set(deletes || full ? readable : [...touched, ...mapped.filter((f) => readable.includes(f))])];
        if (deletes) for (const f of object.fields) if (!readable.includes(f.name)) notRestored.push({ connectionId, field: f.name });
        const read = await deps.services.call(readRecords, {
          body: { connectionId, object: sourceObject, identifiers: refs.map((r) => r.reference), fields, reason: 'mutation' },
        }, callOptions(ctx));
        for (const [i, ref] of refs.entries()) {
          const record = read.records[i]!.values;
          const objectId = objectIdentity(organisationId, objectType.id, connectionId, sourceObject, ref.reference);
          if (record === null) {
            excluded.push({ objectId, connectionId, reference: ref.reference, operation, customAction, reason: 'record_not_found' });
            continue;
          }
          const current = currentProps(connectionId, record);
          if (version.submissionCriteria !== null) {
            let ok: unknown;
            try {
              ok = compileCel(version.submissionCriteria, { object: 'map', params: 'map' }).evaluate({ object: current, params }, CEL_BOUNDS);
            } catch {
              ok = false;
            }
            if (ok !== true) throw new Refusal('resolve', `the record does not meet the submission criteria: ${version.submissionCriteria}`);
          }
          const targetId = uuidv7();
          if (deletes) {
            targets.push({
              id: targetId, objectId, connectionId, sourceObject, entityReference: ref.reference, operation: 'delete', fields: [], properties: [],
              newValues: {}, prior: Object.fromEntries(readable.map((f) => [f, record[f] ?? null])), idempotencyKey: `${id}:${targetId}`,
              connectorVersion: read.connectorVersion,
            });
            continue;
          }
          if (custom !== undefined) {
            // The inputs are sent; the declared changes are the prior state, read back after.
            const changes = changesOf(connectionId);
            targets.push({
              id: targetId, objectId, connectionId, sourceObject, entityReference: ref.reference, operation: 'custom', customAction: custom.customAction,
              fields: changes, properties: [], newValues: Object.fromEntries(Object.entries(custom.inputs).map(([k, v]) => [k, valueOf(v, params, current)])),
              prior: Object.fromEntries(changes.map((f) => [f, record[f] ?? null])), idempotencyKey: `${id}:${targetId}`, connectorVersion: read.connectorVersion,
            });
            continue;
          }
          const newValues: Record<string, unknown> = {};
          const properties: string[] = [];
          for (const rule of version.rules) {
            if (rule.kind === 'add_link' || rule.kind === 'remove_link') {
              const field = linkFieldsOf(connectionId)[rule.linkType];
              if (field === undefined || keptCurrent(connectionId, ref.reference, field)) continue;
              newValues[field] = rule.kind === 'remove_link' ? null : params[rule.object.parameter] ?? null;
              if (rule.kind === 'add_link' && newValues[field] === null) throw new Refusal('intent', `${rule.object.parameter} names the record to link`);
              continue;
            }
            if (rule.kind !== 'set_property' && rule.kind !== 'clear_property') continue;
            const field = fieldOf(objectType, rule.property, connectionId);
            if (field === undefined || keptCurrent(connectionId, ref.reference, rule.property)) continue;
            newValues[field] = rule.kind === 'clear_property' ? null : valueOf(rule.value, params, current);
            properties.push(rule.property);
          }
          if (Object.keys(newValues).length === 0) {
            // Every property a promotion would write on this record was taken as current: nothing to write here.
            if (input.promotion !== undefined) {
              excluded.push({ objectId, connectionId, reference: ref.reference, operation, customAction, reason: 'kept_current' });
              continue;
            }
            throw new Refusal('plan', 'the Action writes nothing on that connection');
          }
          if (full) {
            // Every field but the identifier is sent, each the new value or its current one, and each is prior state.
            const sent = object.fields.map((f) => f.name).filter((f) => f !== object.identifier[0]);
            const before = Object.fromEntries(sent.map((f) => [f, record[f] ?? null]));
            targets.push({
              id: targetId, objectId, connectionId, sourceObject, entityReference: ref.reference, operation: 'update_full', fields: sent,
              properties, newValues: { ...before, ...newValues }, prior: before, idempotencyKey: `${id}:${targetId}`, connectorVersion: read.connectorVersion,
            });
            continue;
          }
          targets.push({
            id: targetId, objectId, connectionId, sourceObject, entityReference: ref.reference, operation: 'update_partial', fields: Object.keys(newValues),
            properties, newValues, prior: Object.fromEntries(Object.keys(newValues).map((f) => [f, record[f] ?? null])),
            idempotencyKey: `${id}:${targetId}`, connectorVersion: read.connectorVersion,
          });
        }
      }
      if (excluded.some((e) => e.reason === 'record_not_found') && input.resolutionPolicy === 'strict') {
        throw new Refusal('resolve', `${excluded.filter((e) => e.reason === 'record_not_found').length} record(s) were not found in their source`);
      }
      if (creates) {
        const rule = version.rules.find((r) => r.kind === 'create_object')!;
        if (rule.kind !== 'create_object') throw new Error('unreachable');
        const found = connections.get(createOn!)!;
        const newValues: Record<string, unknown> = {};
        const properties: string[] = [];
        for (const [property, source] of Object.entries(rule.values)) {
          const field = fieldOf(objectType, property, createOn!);
          if (field === undefined) continue;
          newValues[field] = valueOf(source, params, {});
          properties.push(property);
        }
        const targetId = uuidv7();
        const sourceObject = version.permittedOperations[createOn!]!.sourceObject;
        if (version.permittedOperations[createOn!]!.operations.includes('upsert')) {
          // An upsert names its record: it is read first, and is prior state if it exists (48.1).
          const object = found.manifest.objects.find((o) => o.name === sourceObject)!;
          const key = newValues[object.identifier[0]!];
          if (key === undefined || key === null || key === '') throw new Refusal('intent', 'an upsert names the record it creates or updates');
          const reference = String(key);
          const read = await deps.services.call(readRecords, {
            body: { connectionId: createOn!, object: sourceObject, identifiers: [reference], fields: Object.keys(newValues), reason: 'mutation' },
          }, callOptions(ctx));
          const record = read.records[0]!.values;
          targets.push({
            id: targetId, objectId: objectIdentity(organisationId, objectType.id, createOn!, sourceObject, reference), connectionId: createOn!, sourceObject,
            entityReference: reference, operation: 'upsert', fields: Object.keys(newValues), properties, newValues,
            prior: record === null ? null : Object.fromEntries(Object.keys(newValues).map((f) => [f, record[f] ?? null])),
            idempotencyKey: `${id}:${targetId}`, connectorVersion: read.connectorVersion,
          });
        } else {
          const placeholder = `new:${targetId}`;
          targets.push({
            id: targetId, objectId: objectIdentity(organisationId, objectType.id, createOn!, sourceObject, placeholder), connectionId: createOn!,
            sourceObject, entityReference: placeholder, operation: 'create',
            fields: Object.keys(newValues), properties, newValues, prior: null, idempotencyKey: `${id}:${targetId}`, connectorVersion: found.connectorVersion,
          });
        }
      }
      // A check reports every record gone as excluded: for a staged Action that is orphaned, not refused (39.8).
      if (targets.length === 0 && !check) throw new Refusal('resolve', 'no record remains to write');

      // preview
      const physical = connectionIds.some((c) => {
        const object = connections.get(c)!.manifest.objects.find((o) => o.name === version.permittedOperations[c]?.sourceObject);
        return object?.writes?.risk === 'physical';
      });
      const riskClass = highest(version.riskClass, targets.length >= BULK_ROWS ? 'bulk' : 'data', physical ? 'physical' : 'data');
      // Physical (47.3 to 47.5): every node resolved and read now, listed, checked, in range and step, outside its interval, within the rate.
      let physicalNodes: PhysicalNode[] = [];
      if (input.dryRun === true && !physical) throw new Refusal('intent', 'only a physical Action has a dry run (47.5)');
      if (input.dryRun === true && input.dryRunReceiptId !== undefined) throw new Refusal('intent', 'a dry run follows no dry run');
      // A webhook side effect whose target is physical is checked as any physical write (47.1, 47.4).
      const physicalWebhooks = (version.sideEffects as { kind: string; endpointId?: string; physical?: boolean }[])
        .flatMap((e) => (e.kind === 'webhook' && e.physical === true && e.endpointId !== undefined ? [e.endpointId] : []));
      if (physical || physicalWebhooks.length > 0) {
        const plan = await physicalPlan(deps, ctx, {
          organisationId, targets, connections, actionTypeVersionId: version.id, dryRun: input.dryRun === true, webhooks: physicalWebhooks, parameters: params,
        });
        if ('refused' in plan) throw new Refusal(plan.refused.stage, plan.refused.reason);
        physicalNodes = plan.nodes;
      }
      if (physical) {
        // A policy may require a dry run first (47.5): the proposal names the dry run's receipt, of this Action type, completed.
        if (input.dryRun !== true && (organisation?.physicalDryRunRequired === true || input.dryRunReceiptId !== undefined)) {
          if (input.dryRunReceiptId === undefined) throw new Refusal('intent', 'the organisation requires a dry run before a physical Action: name its receipt');
          const dryRun = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
            const receipt = await receiptRepo.findById(db, input.dryRunReceiptId!);
            const ran = receipt === undefined ? undefined : await mutationRepo.findById(db, receipt.mutationId);
            const ranVersion = ran === undefined ? undefined : await actionTypeVersionRepo.findById(db, ran.actionTypeVersionId);
            return { receipt, ran, ranVersion };
          }, { readOnly: true });
          if (dryRun.receipt === undefined || !dryRun.receipt.dryRun || dryRun.ran === undefined || dryRun.ranVersion?.actionTypeId !== type.id) {
            throw new Refusal('intent', 'the receipt named is not a dry run of this Action type');
          }
          if (dryRun.ran.status !== 'completed') throw new Refusal('intent', `the dry run named ended ${dryRun.ran.status}, not verified`);
        }
      }
      if (check) {
        const propertyOf = (connectionId: string, field: string): string | null => objectType.properties
          .find((p) => p.mappings.some((m) => m.connectionId === connectionId && m.fieldPath === field))?.apiName ?? null;
        return {
          outcome: 'checked', actionTypeVersionId: version.id, objectTypeId: objectType.id, riskClass, physical,
          targets: targets.map((t) => ({
            objectId: t.objectId, connectionId: t.connectionId, reference: t.entityReference, operation: t.operation,
            fields: t.operation === 'delete' ? [] : t.fields.map((f) => ({
              field: f, property: propertyOf(t.connectionId, f), current: (t.prior?.[f] ?? null) as never,
              staged: (t.operation === 'custom' ? null : t.newValues[f] ?? null) as never, stagedUnknown: t.operation === 'custom',
            })),
          })),
          excluded: excluded.map((e) => ({ connectionId: e.connectionId, reference: e.reference, reason: e.reason })),
        };
      }
      const previewRows: PreviewRow[] = targets.flatMap((t): PreviewRow[] => {
        const base = { objectId: t.objectId, connectionId: t.connectionId, entityReference: t.entityReference, operation: t.operation };
        if (t.operation === 'delete') return [{ ...base, field: null, prior: t.prior as never, proposed: null, priorAbsent: false, proposedAbsent: true }];
        if (t.operation === 'custom') return customRows(t);
        if (t.operation === 'create' || (t.operation === 'upsert' && t.prior === null)) {
          return t.fields.map((f) => ({ ...base, field: f, prior: null, proposed: t.newValues[f] as never ?? null, priorAbsent: true, proposedAbsent: false }));
        }
        return t.fields.map((f) => ({ ...base, field: f, prior: (t.prior?.[f] ?? null) as never, proposed: (t.newValues[f] ?? null) as never, priorAbsent: false, proposedAbsent: false }));
      });
      // blast radius: what else the change touches, bounded (43.7)
      const blast = await walkBlastRadius(deps, ctx, { organisationId, objectTypeId: objectType.id, targets, connections, ontology });
      const preview: Preview = {
        actionTypeVersionId: version.id, riskClass, rows: previewRows,
        excluded: excluded.map((e) => ({ connectionId: e.connectionId!, reference: e.reference, reason: e.reason })),
        nonAtomic: new Set(targets.map((t) => t.connectionId)).size > 1, notRestored,
        sideEffects: await previewSideEffects(deps, ctx, version.sideEffects as { kind: string; physical: boolean; endpointId?: string }[]),
        blastRadius: blast.summary,
        // The sample is the organisation's where it set one (45.4); the threshold never moves.
        canary: targets.length >= canary.rows ? { sample: Math.min(organisation?.canarySampleRows ?? canary.sample, targets.length) } : null,
        // The nodes, their values now and proposed, their bounds, and the statement no configuration removes (47.3).
        ...physicalPreview(physicalNodes, { notRevertible: version.revertBehaviour === 'not_revertible', dryRun: input.dryRun === true }),
      };
      values['newValues'] = Object.fromEntries(targets.map((t) => [t.id, t.newValues]));
      // The properties it touches, for marking-conditioned approval policies (44.3): those mapped to a field it writes,
      // or, for a delete, every property mapped on the connection.
      const touchedProperties = objectType.properties.filter((p) => p.mappings.some((m) => connectionIds.includes(m.connectionId)
        && (deletes || (updates && fullOn(m.connectionId)) || fieldsFor(m.connectionId).includes(m.fieldPath)))).map((p) => p.identityId).sort();
      // A Cron in execute mode runs unattended only inside every bound (see the header).
      let cronMode: 'propose' | 'execute_within_bounds' = 'propose';
      const bounds = input.cron?.execute ?? null;
      if (bounds !== null) {
        if (targets.length >= canary.rows) throw new Refusal('plan', 'a Cron never runs a canary unattended: 10,000 rows or more is refused');
        const written = [...new Set(targets.flatMap((t) => t.properties))];
        // Only property writes are bounded by the properties named: a delete, a link or a custom action is proposed instead.
        const propertyWrites = targets.every((t) => (t.operation === 'update_partial' || t.operation === 'create') && t.properties.length === t.fields.length);
        const within = riskClass === 'data' && !type.isSystem && propertyWrites && targets.length < BULK_ROWS && targets.length <= bounds.maxRows
          && written.every((p) => bounds.properties.includes(p)) && connectionIds.every((c) => bounds.connectionIds.includes(c));
        if (within) cronMode = 'execute_within_bounds';
      }
      await persistMutation(deps, ctx, {
        id, organisationId, actionTypeVersionId: version.id, objectTypeId: objectType.id,
        origin: input.promotion !== undefined ? 'scenario_promotion' : input.cron === undefined ? 'action' : 'cron', promotion: input.promotion,
        proposerMembershipId: membershipId, cron: cronOf(cronMode), resolutionPolicy: input.resolutionPolicy, riskClass,
        manifest: { ...manifest, connections: connectionIds, operations: [...new Set(targets.map((t) => t.operation))], touchedProperties },
        values, intent: input.intent, preview, targets, excluded, executionSeparated: deps.executionSeparated, blast: blast.rows,
        genericEdit: type.isSystem,
        dryRun: input.dryRun === true, ...(input.dryRunReceiptId === undefined ? {} : { dryRunReceiptId: input.dryRunReceiptId }),
        also: async (db) => {
          // Read first by a reviewer (42.12): a write made outside a confirmed Action type. References and counts only.
          if (generic !== undefined) {
            await recordActionEvent(db, {
              organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'actions', event: 'generic_edit_compiled',
              resource: { type: 'mutation', id }, detail: {
                object_type_id: generic.manifest.objectTypeId, operation: generic.manifest.operation, properties: generic.manifest.properties.length,
                row_count: targets.length, action_type_version_id: version.id,
              },
            });
          }
          if (physicalNodes.length > 0) await recordPhysicalProposed(db, ctx, { organisationId, mutationId: id, nodes: physicalNodes });
        },
      });
    } catch (error) {
      if (error instanceof Refusal) return refuse(error);
      throw error;
    }

      await deps.services.call(requestApproval, { body: { mutationId: id } }, callOptions(ctx));
      return mutationView(deps, ctx, id);
  }

  return {
    propose: (ctx: Context, input: ProposalInput): Promise<MutationView> => prepare(ctx, input, false) as Promise<MutationView>,
    /** Staging (39.8): a refusal is answered, never recorded; the targets come back with the value now and the value staged. */
    check: (ctx: Context, input: ProposalInput): Promise<CheckOutcome> => prepare(ctx, input, true) as Promise<CheckOutcome>,
  };
}

/** The policy gate's checks on each connection (43.4 checks 2 to 8). */
async function gate(connectionIds: readonly string[], connections: ReadonlyMap<string, ConnectionWithManifest>,
  access: Awaited<ReturnType<typeof accessOf>>, version: ActionTypeVersionView, objectType: ObjectTypeView, writtenProperties: readonly string[],
  fieldsFor: (connectionId: string) => string[]): Promise<void> {
  if (!access.objectTypeVisible(objectType.id)) throw new Refusal('policy_gate', 'the object type is not visible to you');
  for (const property of writtenProperties) {
    const identity = version.properties[property];
    if (identity !== undefined && !access.propertyVisible(identity)) throw new Refusal('policy_gate', `${property} is not visible to you, so it cannot be written`);
  }
  for (const connectionId of connectionIds) {
    const found = connections.get(connectionId)!;
    if (access.connections.get(connectionId) !== 'write') throw new Refusal('policy_gate', 'your grants do not reach the connection with write access');
    if (found.connection.status === 'halted') throw new Refusal('policy_gate', 'the connection is halted');
    if (found.connection.status !== 'active') throw new Refusal('policy_gate', `the connection is ${found.connection.status}`);
    if (!found.connection.writesEnabled) throw new Refusal('policy_gate', 'the connection has not earned writes (its write class has not passed)');
    if (!(WRITING_PROTOCOLS as readonly string[]).includes(found.manifest.protocol.kind)) throw new Refusal('policy_gate', `the ${found.manifest.protocol.kind} transport does not write`);
    const declared = version.permittedOperations[connectionId]!;
    const object = found.manifest.objects.find((o) => o.name === declared.sourceObject);
    if (!stillDeclared(object, declared)) {
      throw new Refusal('policy_gate', 'the manifest the connection runs no longer declares an operation this Action uses');
    }
    for (const field of fieldsFor(connectionId)) {
      if (access.fieldEffect(connectionId, field) !== 'allow') throw new Refusal('policy_gate', `the field ${field} is not visible to you, so it cannot be written`);
    }
  }
}

/** The preview's side effects: a webhook says whether its receipt records effect or delivery alone (20.4). */
async function previewSideEffects(deps: { databases: import('../../infra/postgres.infra.ts').Databases }, ctx: { request: import('../../infra/postgres.infra.ts').RequestContext },
  effects: readonly { kind: string; physical: boolean; endpointId?: string }[]) {
  const ids = effects.flatMap((e) => (e.kind === 'webhook' && e.endpointId ? [e.endpointId] : []));
  const withStatus = new Set(ids.length === 0 ? [] : (await inTransaction(deps.databases.pool('control'), ctx.request,
    (db) => Promise.all(ids.map((id) => webhookEndpointRepo.findById(db, id))), { readOnly: true }))
    .flatMap((e) => (e !== undefined && e.statusUrl !== null ? [e.id] : [])));
  return effects.map((e) => ({
    kind: e.kind, physical: e.physical,
    ...(e.kind === 'webhook' ? { records: e.endpointId !== undefined && withStatus.has(e.endpointId) ? 'effect' as const : 'delivery' as const } : {}),
  }));
}
