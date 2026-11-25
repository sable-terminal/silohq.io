// Time scrubbing and compare (spec 30.8): a type's objects at a past time, over Capture
// history only (siloes-capture reconstructs each captured property's value at the time),
// with states from the type's active rules evaluated at that time. An input that is not
// captured gives no current value: the state says it is not captured. Compare runs the same
// reconstruction at two times and lists changed states, changed properties with both
// values, and objects present at only one time. Values pass through memory only.

import type { CloneState } from '../../contracts/canvas-layout/stateRule.contract.ts';
import { readStateAt } from '../../contracts/siloes/siloes.contract.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { actor, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';
import { compileStateRules, evaluateState, type InputState } from './stateEvaluation.service.ts';
import { active } from './stateRules.service.ts';

interface Timed { value: unknown; observedAt: string }
interface ObjectAt { objectRef: string; observed: boolean; state: { state: CloneState; reason: string } | null; values: Record<string, Timed> }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function clonesAt(deps: CanvasDeps, ctx: Context, input: {
  objectTypeId: string; objectRefs: string[]; properties: string[]; at: string; compareTo?: string | undefined;
}) {
  const who = actor(ctx);
  const [rule] = await active(deps, ctx, [input.objectTypeId]);
  const compiledRule = rule === undefined ? undefined : compileStateRules(rule.inputs, rule.rules, rule.freshnessWindowSeconds);
  if (compiledRule !== undefined && !('compiled' in compiledRule)) throw new AppError('integrity', 'an active state rule does not compile', { code: 'clone.rule_invalid' });
  const compiled = compiledRule?.compiled;
  const inputs = compiled?.inputs ?? [];
  const properties = [...new Set([...inputs.map((i) => i.apiName), ...input.properties])];
  if (properties.length === 0) {
    throw new AppError('validation', 'name the properties to show: the type has no active state rule to read', { code: 'clone.time_nothing_to_show' });
  }
  const read = (at: string) => deps.services.call(readStateAt, { body: { objectTypeId: input.objectTypeId, objectRefs: input.objectRefs, properties, at } },
    { request: ctx.request, correlationId: ctx.correlationId });

  // Siloes switched off for the organisation is Capture absent, answered as such rather than refused (the bar says why).
  const first = await read(input.at).catch((error: unknown) => {
    if (isAppError(error) && error.code === 'siloes.disabled') {
      return { state: 'unavailable' as const, reason: 'Siloes are switched off for this organisation, so there is no Capture history', properties: [], objects: [], historyBegins: null, gaps: [] };
    }
    throw error;
  });
  if (first.state !== 'silo') {
    // Compare two times is Capture only (30.8): refused, and recorded, never offered from what a session saw.
    if (input.compareTo !== undefined) {
      await inTransaction(deps.databases.pool('control'), ctx.request, (db) => recordEvent(db, who, ctx.correlationId, {
        event: 'time_compare_refused_no_capture', resource: { type: 'object_type', id: input.objectTypeId }, detail: { state: first.state, reason: first.reason?.slice(0, 200) ?? null },
      }));
    }
    return { available: false, reason: first.reason, historyBegins: null, gaps: [], properties: first.properties, at: [], compareTo: null, differences: null };
  }
  const notCaptured = new Set(first.properties.filter((p) => p.availability !== 'captured').map((p) => p.property));
  const evaluate = (objects: typeof first.objects, when: string): ObjectAt[] => objects.map((o) => {
    const values = o.values as Record<string, Timed>;
    if (!o.observed) return { objectRef: o.objectRef, observed: false, state: null, values };
    if (compiled === undefined) return { objectRef: o.objectRef, observed: true, state: { state: 'normal', reason: 'no state rule is active for this type' }, values };
    const missing = inputs.find((i) => notCaptured.has(i.apiName));
    if (missing !== undefined) return { objectRef: o.objectRef, observed: true, state: { state: 'unknown', reason: `${missing.apiName} is not captured` }, values };
    const states: Record<string, InputState> = Object.fromEntries(inputs.map((i) => [i.propertyIdentityId, { value: values[i.apiName]?.value ?? null, visible: true }]));
    const evaluated = evaluateState(compiled, states, new Date(when));
    return { objectRef: o.objectRef, observed: true, state: { state: evaluated.state, reason: evaluated.reason }, values };
  });
  const atObjects = evaluate(first.objects, input.at);
  const base = { available: true, reason: first.reason, historyBegins: first.historyBegins, gaps: first.gaps, properties: first.properties, at: atObjects };
  if (input.compareTo === undefined) return { ...base, compareTo: null, differences: null };

  const second = evaluate((await read(input.compareTo)).objects, input.compareTo);
  const differences = {
    states: [] as { objectRef: string; at: CloneState; compareTo: CloneState }[],
    properties: [] as { objectRef: string; property: string; at: Timed; compareTo: Timed }[],
    onlyAt: [] as string[],
    onlyCompareTo: [] as string[],
  };
  for (const a of atObjects) {
    const b = second.find((o) => o.objectRef === a.objectRef)!;
    if (a.observed && !b.observed) differences.onlyAt.push(a.objectRef);
    if (!a.observed && b.observed) differences.onlyCompareTo.push(a.objectRef);
    if (!a.observed || !b.observed) continue;
    if (a.state !== null && b.state !== null && a.state.state !== b.state.state) differences.states.push({ objectRef: a.objectRef, at: a.state.state, compareTo: b.state.state });
    for (const property of new Set([...Object.keys(a.values), ...Object.keys(b.values)])) {
      const x = a.values[property];
      const y = b.values[property];
      if (x !== undefined && y !== undefined && !same(x.value, y.value)) differences.properties.push({ objectRef: a.objectRef, property, at: x, compareTo: y });
    }
  }
  await inTransaction(deps.databases.pool('control'), ctx.request, (db) => recordEvent(db, who, ctx.correlationId, {
    event: 'time_compared', resource: { type: 'object_type', id: input.objectTypeId },
    detail: {
      at: input.at, compare_to: input.compareTo!, objects: atObjects.length, states_changed: differences.states.length,
      properties_changed: differences.properties.length, only_at: differences.onlyAt.length, only_compare_to: differences.onlyCompareTo.length,
    },
  }));
  return { ...base, compareTo: second, differences };
}
