// Where an Action from the canvas lands (spec 29.6, 34.5): each selected object's record the
// Action type writes, by the object view's rule (the record in the first system the type may
// write through), read now under the caller's access with the records each object was merged
// from. An object the read did not return (gone, or not the caller's to see) and one with no
// record the type writes are excluded with why; the mutation path checks everything again.

import { createHash } from 'node:crypto';
import { listActionTypes } from '../../contracts/actions/actionType.contract.ts';
import type { ResultObject } from '../../contracts/executor/result.contract.ts';
import { PLAN_SCHEMA_VERSION, queryPlan } from '../../contracts/planner/plan.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { callOptions, type PlanCall } from '../planner/deps.service.ts';
import { activeVersion } from '../planner/manifests.service.ts';
import { readPage, runPlan, type ExecutorDeps } from './execute.service.ts';

export async function resolveActionTargets(deps: ExecutorDeps, call: PlanCall & { signal: AbortSignal }, input: { objectTypeId: string; actionTypeId: string; objectIds: string[] }) {
  const options = callOptions(call);
  const unknown = () => new AppError('not_found', 'no such Action type for these objects', { code: 'actions.action_type_not_found' });
  const { actionTypes } = await deps.services.call(listActionTypes, { query: { status: 'confirmed', objectTypeId: input.objectTypeId, limit: 500 } }, options);
  const type = actionTypes.find((t) => t.id === input.actionTypeId && !t.isSystem && t.current !== null && t.current.objectTypeId === input.objectTypeId);
  if (type === undefined) throw unknown();
  const access = await deps.services.call(resolveAccess, { body: { actionTypes: [type.id] } }, options);
  if (access.decision !== 'allow' || !access.actionTypes.some((a) => a.id === type.id && a.visible)) throw unknown();
  const v = type.current!;
  if (v.rules.some((r) => r.kind === 'create_object')) {
    throw new AppError('validation', 'an Action that creates objects acts on the type, not on a selection', { code: 'actions.creates_objects' });
  }

  const ids = new Set(input.objectIds);
  const version = await activeVersion(deps, call);
  const plan = queryPlan.parse({ schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: version.id, nodes: [{ objectTypeId: input.objectTypeId }], select: [] });
  const hash = createHash('sha256').update([...ids].sort().join(',')).digest('hex');
  const outcome = await runPlan(deps, call, {
    plan, parameters: {}, trigger: 'structured', useCache: false, references: true,
    keep: { hash, properties: [], test: (_subject, objectId) => ids.has(objectId) },
  });
  if (outcome.outcome === 'refusal') {
    return { targets: [], excluded: input.objectIds.map((objectId) => ({ objectId, reason: outcome.refusal.reason })) };
  }
  const objects: ResultObject[] = [...outcome.result.page.objects];
  for (let page = 1; page < outcome.result.page.count; page += 1) {
    objects.push(...(await readPage(deps, call, outcome.result.queryId, page)).objects);
  }

  const read = new Map(objects.map((o) => [o.id, o]));
  const targets: { objectId: string; connectionId: string; reference: string }[] = [];
  const excluded: { objectId: string; reason: string }[] = [];
  for (const objectId of input.objectIds) {
    const object = read.get(objectId);
    if (object === undefined) { excluded.push({ objectId, reason: 'it was not read just now: gone, or not yours to see' }); continue; }
    // The record it writes: the object's record in the first system the type may write through.
    const record = v.permittedConnections
      .map((c) => (object.records ?? []).find((r) => r.connectionId === c && r.sourceObject === v.permittedOperations[c]?.sourceObject))
      .find((r) => r !== undefined);
    if (record === undefined) { excluded.push({ objectId, reason: 'it has no record in a system this Action writes through' }); continue; }
    targets.push({ objectId, connectionId: record.connectionId, reference: record.reference });
  }
  return { targets, excluded };
}
