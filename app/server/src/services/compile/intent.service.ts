// Binding an intent to how it would be made (spec 42.9): "The compile stage binds the intent
// to an existing confirmed Action type where one fits (matching object type, properties and
// operation) and shows which was chosen; where several fit, the person chooses. Where none
// fits, the intent compiles into the generic governed edit" (silo.edit), unless the
// organisation disables it, when the intent is refused with the offer to propose an Action
// type to a holder of action.define.
//
// A confirmed type fits an intent when its current version targets the intent's object type
// and its rules make the change asked for:
// - update: only property and link rules (no create, delete or custom action); every
//   property the intent sets is set from a parameter, every one it clears is cleared;
// - create: a create whose values take every property the intent gives from a parameter;
// - delete: a delete;
// and every parameter it requires without a default is filled from the intent. A type may
// write more than the intent names (a CEL rule over the record): its preview shows it.
// Nothing here reads a record; the values are the asker's own.

import { listActionTypes, type ActionTypeVersionView } from '../../contracts/actions/actionType.contract.ts';
import { getActionSettings } from '../../contracts/actions/settings.contract.ts';
import type { CompiledIntent } from '../../contracts/compile/compile.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { TranslatedIntent } from './modelPlan.service.ts';

type Value = string | number | boolean;

/** The parameters a confirmed version takes for the intent, or undefined when it does not fit. */
export function fit(version: ActionTypeVersionView, intent: Pick<TranslatedIntent, 'objectTypeId' | 'operation' | 'set' | 'clear'>): Record<string, Value> | undefined {
  if (version.objectTypeId !== intent.objectTypeId) return undefined;
  const kinds = new Set(version.rules.map((r) => r.kind));
  const parameters: Record<string, Value> = {};
  const fromParameter = (source: { parameter: string } | { cel: string } | undefined, value: Value): boolean => {
    if (source === undefined || !('parameter' in source)) return false;
    parameters[source.parameter] = value;
    return true;
  };
  if (intent.operation === 'update') {
    if (kinds.has('create_object') || kinds.has('delete_object') || kinds.has('invoke_custom')) return undefined;
    for (const s of intent.set) {
      const rule = version.rules.find((r) => r.kind === 'set_property' && r.property === s.apiName);
      if (rule?.kind !== 'set_property' || !fromParameter(rule.value, s.value)) return undefined;
    }
    for (const c of intent.clear) if (!version.rules.some((r) => r.kind === 'clear_property' && r.property === c.apiName)) return undefined;
  } else if (intent.operation === 'create') {
    const rule = version.rules.find((r) => r.kind === 'create_object');
    if (rule?.kind !== 'create_object') return undefined;
    for (const s of intent.set) if (!fromParameter(rule.values[s.apiName], s.value)) return undefined;
  } else if (!kinds.has('delete_object')) {
    return undefined;
  }
  for (const p of version.parameters) if (p.required && p.default === undefined && !(p.name in parameters)) return undefined;
  return parameters;
}

/** The confirmed types that fit, or the generic edit where none does and it is allowed; null where neither may make it. */
export async function bindIntent(services: ServiceClient, ctx: Pick<HandlerContext, 'request' | 'correlationId'>, intent: TranslatedIntent)
  : Promise<Pick<CompiledIntent, 'candidates' | 'genericEdit'> | null> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const { actionTypes } = await services.call(listActionTypes, { query: { status: 'confirmed', objectTypeId: intent.objectTypeId, limit: 500 } }, options);
  const candidates = actionTypes.flatMap((t) => {
    const parameters = t.current === null ? undefined : fit(t.current, intent);
    return parameters === undefined ? [] : [{ actionTypeId: t.id, actionTypeVersionId: t.current!.id, apiName: t.apiName, displayName: t.displayName, parameters }];
  }).slice(0, 20);
  if (candidates.length > 0) return { candidates, genericEdit: false };
  const settings = await services.call(getActionSettings, {}, options);
  return settings.genericEdit.enabled ? { candidates: [], genericEdit: true } : null;
}
