// Running a saved object set (spec 24.4): a definition, never members, re-evaluated now
// against main's head under the caller's own access. A Studio app's object set variable (35.2)
// is run the same way from its definition as given, with its parameter variables' values bound
// as names its predicate reads, never written into the predicate.
//
// - filter (on a type): the base type is read and merged as any plan's root, then kept where
//   the set's CEL predicate holds over the object's decided values (an undecided value is
//   null to the predicate). The predicate's properties are read plainly or the run is
//   refused, as a filter on a masked value is.
// - explicit: the listed Silo object ids of the type, kept from the type's population.
// - over an interface, traversal and composite: walked by setMembers.service.ts, one answer.

import { createHash } from 'node:crypto';
import type { RunOutcome } from '../../contracts/executor/result.contract.ts';
import { getObjectSet, type SetDefinition } from '../../contracts/ontology/objectSet.contract.ts';
import { PLAN_SCHEMA_VERSION, queryPlan } from '../../contracts/planner/plan.contract.ts';
import { callOptions, type PlanCall } from '../planner/deps.service.ts';
import { activeVersion } from '../planner/manifests.service.ts';
import { runPlan, type ExecutorDeps } from './execute.service.ts';
import { predicateTest, runWalkedSet, type SetBindings } from './setMembers.service.ts';

export interface SetRunInput {
  /** A saved set, or a definition given whole (an app's variable), exactly one. */
  objectSetId?: string | undefined;
  definition?: SetDefinition | undefined;
  bindings?: SetBindings | undefined;
  select: readonly string[];
  trigger: string;
  useCache: boolean;
}

export async function runObjectSet(deps: ExecutorDeps, call: PlanCall & { signal: AbortSignal }, input: SetRunInput): Promise<RunOutcome> {
  const bindings = input.bindings ?? {};
  const set = input.definition !== undefined ? { id: 'definition', definition: input.definition }
    : await deps.services.call(getObjectSet, { params: { objectSetId: input.objectSetId! } }, callOptions(call));
  const definition = set.definition;
  let typeId: string;
  let properties: string[] = [];
  let test: (subject: Record<string, unknown>, objectId: string) => boolean;
  if (definition.kind === 'filter' && 'objectTypeId' in definition.base) {
    typeId = definition.base.objectTypeId;
    properties = [...definition.predicate.properties];
    const holds = predicateTest(definition.predicate.cel, bindings);
    test = (subject) => holds(subject);
  } else if (definition.kind === 'explicit') {
    typeId = definition.objectTypeId;
    const ids = new Set(definition.ids);
    test = (_subject, objectId) => ids.has(objectId);
  } else {
    return runWalkedSet(deps, call, definition, { setId: set.id, select: input.select, trigger: input.trigger, useCache: input.useCache, bindings });
  }
  const version = await activeVersion(deps, call);
  const plan = queryPlan.parse({
    schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: version.id,
    nodes: [{ objectTypeId: typeId }],
    select: [...new Set([...input.select, ...properties])].map((property) => ({ node: 0, property })),
  });
  const hash = createHash('sha256').update(JSON.stringify(Object.keys(bindings).length === 0 ? definition : { definition, bindings })).digest('hex');
  return runPlan(deps, call, {
    plan, parameters: {}, trigger: input.trigger, useCache: input.useCache,
    keep: { hash, properties, test: (subject, objectId) => test(subject, objectId) },
  });
}
