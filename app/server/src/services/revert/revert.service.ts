// Revert (spec 46.3 to 46.7; contracts/revert/revert.contract.ts): the three-way comparison at
// the time of asking, the revert mutation it produces, the conflicts a person decides, then
// approval and execution as for any mutation (the actions service executes it, applying the
// decisions: keep_current drops a field, exclude_record drops a record).
//
// What the receipt holds is the basis: the records the original applied (their verification),
// their post-write state (observed by verification; for a diverged field, the observed
// value), their prior state, and the identifiers creates were given. A purged receipt holds
// no values, so its mutation can no longer be reverted (46.7: undo ends with retention).
//
// The Action type's revert behaviour (42.8) shapes the plan:
// - three_way: each field that differs from its prior state is restored; one that changed
//   since the write is a conflict a person decides;
// - state_only: the stored prior state is written back where it differs, and nothing else
//   is compared: no conflicts;
// - compensating (a custom action): the custom action that undoes it is invoked, with the
//   stored prior state as its inputs and that state as what it is expected to leave in the
//   fields it declares; the fields it does not declare are then restored three-way. A field
//   the person keeps as it is keeps the record out of the compensating action;
// - not_revertible: refused.
// A custom action's fields are restored by the manifest's update; where it declares none,
// the revert is refused rather than planned with a write that does not exist.
//
// A physical command (47.1, 47.6: an OPC UA method call, an MQTT publish) has no state: nothing
// is read or compared, and its revert invokes its inverse, the compensating custom action, which
// must be the inverse command the original's allow-list entry names; a command whose entry names
// none is refused. A dry run wrote nothing to production, so it has nothing to revert.

import type { Preview, PreviewRow } from '../../contracts/actions/mutation.contract.ts';
import { requestApproval } from '../../contracts/approvals/approval.contract.ts';
import { readRecords } from '../../contracts/connect-runtime/write.contract.ts';
import type { RevertView } from '../../contracts/revert/revert.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import {
  actionTypeVersionRepo, mutationRepo, receiptRepo, revertConflictRepo, revertRepo,
} from '../../repos/action/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  callOptions, memberOf, ontologyAt, openValues, permitted, readConnections, sealValues, type Context, type WriteBackDeps,
} from '../actions/deps.service.ts';
import { recordActionEvent, recordMutationStage } from '../actions/events.service.ts';
import { customRows, highest } from '../actions/propose.service.ts';
import { bindings, mutationView, objectIdentity, persistMutation, type PlannedTarget, type RiskClass } from '../actions/store.service.ts';
import { permittedOperationsOf } from '../actions/genericEdit.service.ts';
import { inversesOf, physicalPlan, physicalPreview, recordPhysicalProposed, type PhysicalNode } from '../actions/physical.service.ts';
import { newIdentifierOf, type NotRepointed } from '../actions/repoint.service.ts';
import { blastRadiusResultRepo } from '../../repos/action/index.repo.ts';

interface ReceiptDocument {
  mutationId: string;
  riskClass: RiskClass;
  actionType: { versionId: string };
  objects: {
    targetId: string; objectId: string; connectionId: string | null; reference: string | null; operation: 'create' | 'update_full' | 'update_partial' | 'delete' | 'upsert' | 'custom';
    excluded: boolean; customAction?: string;
  }[];
  priorStates: Record<string, Record<string, unknown>>;
  verifications: { targetId: string; reference: string; field: string | null; intended: unknown; observed: unknown; outcome: 'verified' | 'diverged' | 'failed' }[];
  identifierRemappings: { targetId: string; identifier: string }[];
}

interface Conflict {
  id: string;
  objectId: string;
  entityReference: string;
  field: string | null;
  kind: 'field_changed' | 'record_missing' | 'record_reappeared' | 'created_record_changed';
  postWrite: unknown;
  current: unknown;
  /** Decided at once: a missing record is reported, never recreated by an update's revert. */
  autoDecision: 'exclude_record' | null;
}

const same = (a: unknown, b: unknown): boolean => canonicalJsonBytes({ v: a ?? null }).equals(canonicalJsonBytes({ v: b ?? null }));
const TERMINAL_APPLIED = ['completed', 'completed_with_divergence', 'partially_failed'];

export function createReverts(deps: WriteBackDeps) {
  const control = deps.databases.pool('control');

  async function view(ctx: Context, revertId: string, alreadyReverted?: number): Promise<RevertView> {
    const { revert, conflicts, mutation } = await inTransaction(control, ctx.request, async (db) => {
      const revert = await revertRepo.findById(db, revertId);
      if (!revert) throw new AppError('not_found', 'no such revert', { code: 'revert.not_found' });
      return { revert, conflicts: await revertConflictRepo.listByRevert(db, revertId), mutation: (await mutationRepo.findById(db, revert.newMutationId))! };
    }, { readOnly: true });
    const m = await mutationView(deps, ctx, revert.newMutationId);
    const readable = m.preview !== null;
    const sealed = readable ? conflicts.flatMap((c) => c.postWriteValue === null ? [] : [
      { binding: bindings.revertConflict(c.id, 'post_write_value'), sealed: c.postWriteValue },
      { binding: bindings.revertConflict(c.id, 'current_value'), sealed: c.currentValue! },
    ]) : [];
    const opened = await openValues(deps, ctx, sealed);
    let i = 0;
    return {
      id: revert.id, revertedReceiptId: revert.revertedReceiptId, newMutationId: revert.newMutationId, scope: revert.scope, conflictCount: revert.conflictCount,
      alreadyReverted: alreadyReverted ?? (mutation.manifest as { alreadyReverted?: number }).alreadyReverted ?? 0,
      conflicts: conflicts.map((c) => {
        const values = readable && c.postWriteValue !== null ? { postWriteValue: opened[i++] as never, currentValue: opened[i++] as never } : { postWriteValue: null, currentValue: null };
        return { id: c.id, objectId: c.objectId, entityReference: c.entityReference, field: c.field, kind: c.kind, ...values, changedBy: c.changedBy, decision: c.decision };
      }),
      mutation: m,
    };
  }

  async function requestApprovalIfDecided(ctx: Context, revertId: string): Promise<void> {
    const { undecided, status, mutationId } = await inTransaction(control, ctx.request, async (db) => {
      const revert = (await revertRepo.findById(db, revertId))!;
      const conflicts = await revertConflictRepo.listByRevert(db, revertId);
      const mutation = (await mutationRepo.findById(db, revert.newMutationId))!;
      return { undecided: conflicts.filter((c) => c.decision === null).length, status: mutation.status, mutationId: mutation.id };
    }, { readOnly: true });
    if (undecided === 0 && status === 'previewed') await deps.services.call(requestApproval, { body: { mutationId } }, callOptions(ctx));
  }

  return {
    get: (ctx: Context, revertId: string) => view(ctx, revertId),

    async request(ctx: Context, input: { receiptId: string; scope: 'full' | 'succeeded_half' }): Promise<RevertView> {
      const { organisationId, membershipId } = memberOf(ctx, 'requesting a revert');
      const { receipt, original, version } = await inTransaction(control, ctx.request, async (db) => {
        const receipt = await receiptRepo.findById(db, input.receiptId);
        if (!receipt) throw new AppError('not_found', 'no such receipt', { code: 'receipt.not_found' });
        const original = (await mutationRepo.findById(db, receipt.mutationId))!;
        return { receipt, original, version: (await actionTypeVersionRepo.findById(db, original.actionTypeVersionId))! };
      }, { readOnly: true });
      if (receipt.document === null) throw new AppError('conflict', 'the receipt was purged: its values are gone, so it cannot be reverted', { code: 'revert.receipt_purged' });
      if (!TERMINAL_APPLIED.includes(original.status)) throw new AppError('conflict', `a ${original.status} mutation wrote nothing to revert`, { code: 'revert.nothing_applied' });
      if (version.revertBehaviour === 'not_revertible') throw new AppError('conflict', 'this Action is not reversible (a stateless command)', { code: 'revert.not_revertible' });
      if (original.dryRun) throw new AppError('conflict', 'a dry run wrote nothing to production: there is nothing to revert (47.5)', { code: 'revert.dry_run' });
      const doc = (await openValues(deps, ctx, [{ binding: bindings.receipt(receipt.id), sealed: receipt.document }]))[0] as ReceiptDocument;
      const operations = permittedOperationsOf(original, version);
      const sourceObjectOf = (connectionId: string) => operations[connectionId]!.sourceObject;

      // The records the original applied, with their post-write and prior states.
      const applied = doc.objects.filter((o) => !o.excluded && doc.verifications.some((v) => v.targetId === o.targetId && v.outcome !== 'failed'));
      const connectionIds = [...new Set(applied.map((o) => o.connectionId!))];
      const connections = await readConnections(deps, ctx.request, connectionIds);
      for (const id of connectionIds) {
        if (!await permitted(deps, ctx, 'mutation.revert', connections.get(id)!.connection.owningScopeId)) {
          throw new AppError('forbidden', 'you need mutation.revert on the connection', { code: 'revert.not_permitted' });
        }
      }
      const referenceOf = (o: ReceiptDocument['objects'][number]) =>
        o.operation === 'create' ? doc.identifierRemappings.find((r) => r.targetId === o.targetId)?.identifier ?? null : o.reference;

      const id = uuidv7();
      const revertId = uuidv7();
      const targets: PlannedTarget[] = [];
      const conflicts: Conflict[] = [];
      const expected: Record<string, Record<string, unknown>> = {};
      // Records this revert recreates, by their recreating target (46.6).
      const recreated: { targetId: string; originalTargetId: string; reference: string; connectionId: string }[] = [];
      const threeWay = version.revertBehaviour !== 'state_only';
      let alreadyReverted = 0;
      for (const connectionId of connectionIds) {
        const found = connections.get(connectionId)!;
        const sourceObject = sourceObjectOf(connectionId);
        const object = found.manifest.objects.find((o) => o.name === sourceObject)!;
        const here = applied.filter((o) => o.connectionId === connectionId && referenceOf(o) !== null);
        const allFields = object.fields.map((f) => f.name);
        // How this source restores a field and recreates a record (42.4): a partial update, else a full one, else an upsert; a create, else an upsert.
        const updateOp = object.writes?.update !== undefined ? 'update_partial' as const : object.writes?.updateFull !== undefined ? 'update_full' as const
          : object.writes?.upsert !== undefined ? 'upsert' as const : null;
        const createOp = object.writes?.create !== undefined ? 'create' as const : object.writes?.upsert !== undefined ? 'upsert' as const : null;
        // A physical command has no state (47.1): nothing of its record is read.
        const command = (o: ReceiptDocument['objects'][number]) => o.operation === 'custom' && (found.manifest.protocol.kind === 'opc_ua' || found.manifest.protocol.kind === 'mqtt');
        const stated = here.filter((o) => !command(o));
        const read = stated.length === 0 ? { records: [], connectorVersion: found.manifest.identity.version } : await deps.services.call(readRecords, {
          body: { connectionId, object: sourceObject, identifiers: stated.map((o) => referenceOf(o)!), fields: allFields, reason: 'read_back' },
        }, callOptions(ctx));
        here.forEach((o) => {
          const reference = referenceOf(o)!;
          const base = { objectId: o.objectId, connectionId, sourceObject, connectorVersion: read.connectorVersion, idempotencyKey: '' };
          const targetId = uuidv7();
          if (command(o)) {
            // Its inverse (47.6), the compensating custom action, with no inputs: there is no prior state to send.
            const undo = object.writes?.custom.find((c) => c.name === version.compensatingAction);
            if (version.revertBehaviour !== 'compensating' || undo === undefined) {
              throw new AppError('conflict', 'a command is reverted by its inverse, which this Action type does not name', {
                code: 'revert.compensating_undeclared', details: { connectionId },
              });
            }
            targets.push({
              ...base, id: targetId, entityReference: reference, operation: 'custom', customAction: undo.name, fields: [], properties: [],
              newValues: {}, prior: {}, idempotencyKey: `${id}:${targetId}`,
            });
            return;
          }
          const current = read.records[stated.indexOf(o)]!.values;
          const verified = doc.verifications.filter((v) => v.targetId === o.targetId && v.field !== null);
          const postWrite = Object.fromEntries(verified.map((v) => [v.field!, v.observed]));
          const prior = doc.priorStates[o.targetId] ?? {};
          const conflicted = (f: string) => {
            if (threeWay && !same(current![f], postWrite[f])) {
              conflicts.push({ id: uuidv7(), objectId: o.objectId, entityReference: reference, field: f, kind: 'field_changed', postWrite: postWrite[f] ?? null, current: current![f] ?? null, autoDecision: null });
            }
          };
          const restoreFields = (restore: string[]) => {
            if (restore.length === 0) return;
            if (updateOp === null) {
              throw new AppError('conflict', `the connection's manifest declares no update on ${object.name}, so the fields cannot be restored`, {
                code: 'revert.not_restorable', details: { connectionId },
              });
            }
            for (const f of restore) conflicted(f);
            const restoreId = uuidv7();
            if (updateOp === 'update_full') {
              // The whole record goes back: the restored fields at their prior values, the rest as they are now.
              const sent = allFields.filter((f) => f !== object.identifier[0]);
              targets.push({
                ...base, id: restoreId, entityReference: reference, operation: 'update_full', fields: sent, properties: [],
                newValues: Object.fromEntries(sent.map((f) => [f, restore.includes(f) ? prior[f] ?? null : current![f] ?? null])),
                prior: Object.fromEntries(sent.map((f) => [f, current![f] ?? null])), idempotencyKey: `${id}:${restoreId}`,
              });
              return;
            }
            targets.push({
              ...base, id: restoreId, entityReference: reference, operation: updateOp, fields: restore, properties: [],
              newValues: Object.fromEntries(restore.map((f) => [f, prior[f] ?? null])), prior: Object.fromEntries(restore.map((f) => [f, current![f] ?? null])),
              idempotencyKey: `${id}:${restoreId}`,
            });
          };
          // An upsert that created its record is undone like a create; one that updated, like an update.
          const created = o.operation === 'create' || (o.operation === 'upsert' && doc.priorStates[o.targetId] === undefined);
          if (!created && (o.operation === 'update_partial' || o.operation === 'update_full' || o.operation === 'upsert' || o.operation === 'custom')) {
            if (current === null) {
              conflicts.push({ id: uuidv7(), objectId: o.objectId, entityReference: reference, field: null, kind: 'record_missing', postWrite: null, current: null, autoDecision: 'exclude_record' });
              return;
            }
            const fields = Object.keys(prior);
            if (fields.every((f) => same(current[f], prior[f]))) {
              alreadyReverted += 1;
              return;
            }
            if (o.operation === 'custom' && version.revertBehaviour === 'compensating') {
              const undo = object.writes?.custom.find((c) => c.name === version.compensatingAction);
              if (undo === undefined) {
                throw new AppError('conflict', `the connection's manifest no longer declares ${version.compensatingAction ?? 'the compensating action'}`, {
                  code: 'revert.compensating_undeclared', details: { connectionId },
                });
              }
              for (const f of undo.changes) if (f in prior) conflicted(f);
              targets.push({
                ...base, id: targetId, entityReference: reference, operation: 'custom', customAction: undo.name, fields: undo.changes, properties: [],
                newValues: { ...prior }, prior: Object.fromEntries(undo.changes.map((f) => [f, current[f] ?? null])), idempotencyKey: `${id}:${targetId}`,
              });
              expected[targetId] = Object.fromEntries(undo.changes.filter((f) => f in prior).map((f) => [f, prior[f] ?? null]));
              restoreFields(fields.filter((f) => !undo.changes.includes(f) && !same(current[f], prior[f])));
              return;
            }
            restoreFields(fields.filter((f) => !same(current[f], prior[f])));
          } else if (created) {
            if (current === null) {
              alreadyReverted += 1;
              return;
            }
            if (Object.entries(postWrite).some(([f, v]) => !same(current[f], v))) {
              conflicts.push({ id: uuidv7(), objectId: o.objectId, entityReference: reference, field: null, kind: 'created_record_changed', postWrite: null, current: null, autoDecision: null });
            }
            // Deleting it captures its full readable record, so the revert is revertible.
            targets.push({
              ...base, id: targetId, entityReference: reference, operation: 'delete', fields: [], properties: [], newValues: {},
              prior: Object.fromEntries(allFields.map((f) => [f, current[f] ?? null])), idempotencyKey: `${id}:${targetId}`,
            });
          } else {
            if (current !== null) {
              conflicts.push({ id: uuidv7(), objectId: o.objectId, entityReference: reference, field: null, kind: 'record_reappeared', postWrite: null, current: null, autoDecision: null });
              return;
            }
            // Recreated from the full readable prior record, under its original identifier where the source takes one
            // (an upsert names it).
            if (createOp === null) {
              throw new AppError('conflict', `the connection's manifest declares no create on ${object.name}, so the record cannot be recreated`, {
                code: 'revert.not_restorable', details: { connectionId },
              });
            }
            targets.push({
              ...base, id: targetId, entityReference: createOp === 'upsert' ? reference : `new:${targetId}`, operation: createOp, fields: Object.keys(prior),
              properties: [], newValues: { ...prior }, prior: null, idempotencyKey: `${id}:${targetId}`,
            });
            if (createOp === 'create') recreated.push({ targetId, originalTargetId: o.targetId, reference, connectionId });
          }
        });
      }
      // Links to a recreated record (46.6): each dependent the delete's blast radius recorded on the record's own connection
      // follows it to the identifier the source gives it. One with no writable key, changed since, or of no object type is named.
      const notRepointed: NotRepointed[] = [];
      if (recreated.length > 0) {
        const radius = await inTransaction(control, ctx.request, (db) => blastRadiusResultRepo.listForMutation(db, original.id), { readOnly: true });
        const ontology = await ontologyAt(deps, ctx, version.ontologyVersionId);
        for (const r of recreated) {
          const dependants = radius.filter((b) => b.sourceTargetId === r.originalTargetId && b.connectionId === r.connectionId
            && (b.kind === 'dependent_record' || b.kind === 'ontology_link'));
          for (const b of dependants) {
            const named = (reason: NotRepointed['reason']) => notRepointed.push({ recreatedTargetId: r.targetId, connectionId: b.connectionId, reference: b.dependentReference, via: b.via, reason });
            if (!b.repointable) { named('not_writable'); continue; }
            // The holder and its key: the link's route on this connection, or the declared foreign key named holder.field.
            const route = b.linkTypeId === null ? undefined
              : ontology.linkTypes.find((l) => l.id === b.linkTypeId)?.routes.find((x) => x.connectionId === b.connectionId && x.junctionObject === null);
            const holder = route?.sourceObject ?? b.via.slice(0, b.via.lastIndexOf('.'));
            const key = route?.foreignKeyField ?? b.via.slice(b.via.lastIndexOf('.') + 1);
            const holderType = ontology.objectTypes.find((t) => t.contributingObjects.some((c) => c.connectionId === b.connectionId && c.sourceObject === holder));
            if (holderType === undefined || holder === '' || key === '') { named('no_object_type'); continue; }
            const read = await deps.services.call(readRecords, {
              body: { connectionId: b.connectionId, object: holder, identifiers: [b.dependentReference], fields: [key], reason: 'read_back' },
            }, callOptions(ctx));
            const current = read.records[0]!.values;
            if (current === null) { named('not_found'); continue; }
            if (String(current[key] ?? '') !== r.reference) { named('changed_since'); continue; }
            const followerId = uuidv7();
            targets.push({
              objectId: objectIdentity(organisationId, holderType.id, b.connectionId, holder, b.dependentReference), connectionId: b.connectionId,
              sourceObject: holder, connectorVersion: read.connectorVersion, id: followerId, entityReference: b.dependentReference, operation: 'update_partial',
              fields: [key], properties: [], newValues: { [key]: newIdentifierOf(r.targetId) }, prior: { [key]: current[key] ?? null },
              idempotencyKey: `${id}:${followerId}`,
            });
          }
        }
      }

      if (targets.length === 0 && conflicts.every((c) => c.autoDecision !== null)) {
        throw new AppError('conflict', alreadyReverted > 0 ? 'every record is already in its prior state' : 'nothing the mutation applied can be reverted', {
          code: 'revert.nothing_to_revert', details: { alreadyReverted },
        });
      }

      // The revert's own preview, with the fields in conflict marked by their rows.
      const rows: PreviewRow[] = targets.flatMap((t): PreviewRow[] => {
        const b = { objectId: t.objectId, connectionId: t.connectionId, entityReference: t.entityReference, operation: t.operation };
        if (t.operation === 'delete') return [{ ...b, field: null, prior: t.prior as never, proposed: null, priorAbsent: false, proposedAbsent: true }];
        if (t.operation === 'create' || (t.operation === 'upsert' && t.prior === null)) {
          return t.fields.map((f) => ({ ...b, field: f, prior: null, proposed: (t.newValues[f] ?? null) as never, priorAbsent: true, proposedAbsent: false }));
        }
        if (t.operation === 'custom') return customRows(t);
        return t.fields.map((f) => ({ ...b, field: f, prior: (t.prior?.[f] ?? null) as never, proposed: (t.newValues[f] ?? null) as never, priorAbsent: false, proposedAbsent: false }));
      });
      const riskClass = highest(original.riskClass === 'bulk' ? 'data' : original.riskClass, targets.length >= 100 ? 'bulk' : 'data');
      // A physical setpoint is reverted by writing its stored prior value, a command by its inverse (47.6): checked as any physical
      // Action is, and previewed with the statement. The inverse is the one the original's allow-list entries name.
      let physicalNodes: PhysicalNode[] = [];
      if (riskClass === 'physical') {
        let inverses: Set<string> | undefined;
        // A physical webhook the original sent (47.1) is a command too: its inverse is another target of its connection.
        const named = await inTransaction(control, ctx.request, (db) => inversesOf(db, original.id), { readOnly: true });
        let webhooks: string[] = [];
        if (targets.some((t) => t.operation === 'custom') || named.sentWebhooks) {
          if (named.without.length > 0) {
            throw new AppError('conflict', `the allow-list names no inverse command for ${named.without[0]!}: a command is reverted by its inverse or not at all (47.6)`, {
              code: 'revert.no_inverse',
            });
          }
          inverses = named.inverses;
          webhooks = named.webhookTargets;
        }
        const plan = await physicalPlan(deps, ctx, { organisationId, targets, connections, actionTypeVersionId: version.id, inverses, webhooks });
        if ('refused' in plan) throw new AppError('conflict', plan.refused.reason, { code: 'revert.physical_refused', details: { stage: plan.refused.stage } });
        physicalNodes = plan.nodes;
      }
      const preview: Preview = {
        actionTypeVersionId: version.id, riskClass, rows, excluded: [], nonAtomic: new Set(targets.map((t) => t.connectionId)).size > 1, notRestored: [],
        sideEffects: [], blastRadius: { computed: false, reason: 'the blast radius walk is not built in this release' },
        ...physicalPreview(physicalNodes, { notRevertible: false, dryRun: false }),
      };
      const sealedConflicts = await sealValues(deps, ctx, conflicts.filter((c) => c.kind === 'field_changed').flatMap((c) => [
        { binding: bindings.revertConflict(c.id, 'post_write_value'), value: c.postWrite },
        { binding: bindings.revertConflict(c.id, 'current_value'), value: c.current },
      ]));
      await persistMutation(deps, ctx, {
        id, organisationId, actionTypeVersionId: version.id, objectTypeId: original.objectTypeId, origin: 'revert', proposerMembershipId: membershipId,
        resolutionPolicy: 'strict', riskClass, genericEdit: original.genericEdit,
        manifest: {
          reverts: original.id, revertsReceipt: receipt.id, scope: input.scope, connections: connectionIds, operations: [...new Set(targets.map((t) => t.operation))],
          alreadyReverted, touchedProperties: (original.manifest as { touchedProperties?: string[] }).touchedProperties ?? [],
          // A generic edit's revert writes through the same definition (42.9).
          ...(original.genericEdit ? { edit: (original.manifest as { edit?: unknown }).edit } : {}),
        },
        values: {
          newValues: Object.fromEntries(targets.map((t) => [t.id, t.newValues])), expected,
          recreatedFrom: Object.fromEntries(recreated.map((r) => [r.targetId, { reference: r.reference, connectionId: r.connectionId }])), notRepointed,
        }, intent: undefined, preview, targets, excluded: [],
        executionSeparated: original.executionSeparated,
        also: async (db) => {
          await revertRepo.insert(db, { id: revertId, organisationId, revertedReceiptId: receipt.id, newMutationId: id, scope: input.scope, requestedBy: membershipId });
          if (physicalNodes.length > 0) await recordPhysicalProposed(db, ctx, { organisationId, mutationId: id, nodes: physicalNodes });
          let i = 0;
          const now = new Date().toISOString();
          for (const c of conflicts) {
            const valued = c.kind === 'field_changed';
            await revertConflictRepo.insert(db, {
              id: c.id, organisationId, revertId, objectId: c.objectId, entityReference: c.entityReference, field: c.field, kind: c.kind,
              postWriteValue: valued ? sealedConflicts[i++]! : null, currentValue: valued ? sealedConflicts[i++]! : null,
              ...(c.autoDecision === null ? {} : { decision: c.autoDecision, decidedBy: membershipId, decidedAt: now }),
            });
          }
          await revertRepo.update(db, revertId, { resolvedPerField: conflicts.some((c) => c.kind === 'field_changed') });
          const event = { organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'revert' as const, resource: { type: 'revert' as const, id: revertId } };
          await recordActionEvent(db, { ...event, event: 'revert_requested', detail: { receipt_id: receipt.id, mutation_id: id, scope: input.scope, already_reverted: alreadyReverted } });
          if (conflicts.length > 0) await recordActionEvent(db, { ...event, event: 'revert_conflicted', detail: { conflicts: conflicts.length } });
          await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId: id, stage: 'revert_requested', receiptId: receipt.id, rowCount: targets.length });
        },
      });
      await requestApprovalIfDecided(ctx, revertId);
      return view(ctx, revertId, alreadyReverted);
    },

    async decide(ctx: Context, revertId: string, decisions: { conflictId: string; decision: 'restore_prior' | 'keep_current' | 'exclude_record' }[]): Promise<RevertView> {
      const { organisationId, membershipId } = memberOf(ctx, 'deciding revert conflicts');
      const { revert, conflicts, connections } = await inTransaction(control, ctx.request, async (db) => {
        const revert = await revertRepo.findById(db, revertId);
        if (!revert) throw new AppError('not_found', 'no such revert', { code: 'revert.not_found' });
        const mutation = (await mutationRepo.findById(db, revert.newMutationId))!;
        return { revert, conflicts: await revertConflictRepo.listByRevert(db, revertId), connections: ((mutation.manifest as { connections?: string[] }).connections ?? []) };
      }, { readOnly: true });
      const scopes = await readConnections(deps, ctx.request, connections);
      for (const id of connections) {
        if (!await permitted(deps, ctx, 'mutation.revert', scopes.get(id)!.connection.owningScopeId)) {
          throw new AppError('forbidden', 'you need mutation.revert on the connection', { code: 'revert.not_permitted' });
        }
      }
      for (const d of decisions) {
        const conflict = conflicts.find((c) => c.id === d.conflictId);
        if (conflict === undefined) throw new AppError('not_found', 'no such conflict in this revert', { code: 'revert.conflict_unknown' });
        if (conflict.decision !== null) throw new AppError('conflict', 'that conflict is decided already', { code: 'revert.conflict_decided' });
      }
      await inTransaction(control, ctx.request, async (db) => {
        const now = new Date().toISOString();
        for (const d of decisions) {
          await revertConflictRepo.update(db, d.conflictId, { decision: d.decision, decidedBy: membershipId, decidedAt: now });
          await recordActionEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'revert_conflict_decided', request: ctx.request, service: 'revert',
            resource: { type: 'revert', id: revertId }, detail: { conflict_id: d.conflictId, decision: d.decision },
          });
        }
        await revertRepo.update(db, revertId, { resolvedPerField: true });
      });
      await requestApprovalIfDecided(ctx, revert.id);
      return view(ctx, revertId);
    },
  };
}

export type Reverts = ReturnType<typeof createReverts>;
