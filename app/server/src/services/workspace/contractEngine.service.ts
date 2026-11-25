// The query engine over the compile and executor services' contracts: what the workspace
// and Ask run on in a cell.
//
// - compile: compileQuestion, keyed by the question's retry key, so a retried question is
//   compiled and charged once. It compiles, bounds, charges and runs in one call (an
//   answer), so the plan is not run a second time. Earlier plans of the thread go as
//   references (priorPlanIds). Refusal codes map onto Ask's closed set of reasons (36.8).
// - run: the stored plan (getCompiledPlan) through runPlan under the caller's own context,
//   triggered as a saved view run, so it is never metered and the executor re-resolves the
//   caller's access (spec 37.5).
//
// - The thread's scope is sent as the question's focus where it names a type; a clarification
//   answered sends the element chosen and the candidates passed over; a rephrase the person
//   marked sends the earlier turn's plan, so metering's window applies (spec 73.2).
// - Values bound at compile are kept under the turn's id (a binding) and replayed with the
//   plan by runCompiledPlan; a view saved from a turn copies the turn's binding.
// - A harder question may compile into a chain of analysis steps (37.8), charged as an advanced
//   compile: Ask keeps it as an answer whose manifest is the chain, its result the last step's.
// - A saved object set runs through the executor's runObjectSet.
// - `reduced` is the executor's: a field policy shaped the answer.

import { compileFailure, compileQuestion, copyPlanBinding, getCompiledPlan, runCompiledPlan } from '../../contracts/compile/compile.contract.ts';
import { runObjectSet, type QueryResult } from '../../contracts/executor/result.contract.ts';
import type { Refusal } from '../../contracts/planner/plan.contract.ts';
import type { RunOutcomeView } from '../../contracts/workspace/view.contract.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { ClarificationOption } from '../../contracts/ask/thread.contract.ts';
import type { CompileOutcome, QueryEngine } from './queryEngine.service.ts';

type AskRefusal = Extract<CompileOutcome, { outcome: 'refusal' }>['reason'];
type RunRefusal = Extract<RunOutcomeView, { outcome: 'refused' }>['reason'];

/** A compile refusal in Ask's closed set (spec 36.8: no_plan, bound_exceeded, capability_missing, unsupported, daily_limit). */
export function askRefusalOf(refusal: Refusal): AskRefusal {
  const code = refusal.code;
  if (code.startsWith('metering.')) return 'daily_limit';
  if (code.startsWith('query.bound_')) return 'bound_exceeded';
  if (code.includes('capability') || code.includes('pushdown')) return 'capability_missing';
  if (code.includes('unsupported') || code.includes('join')) return 'unsupported';
  return 'no_plan';
}

/** A run refusal for a saved view or a re-run. */
export function runRefusalOf(refusal: Refusal): RunRefusal {
  const code = refusal.code;
  if (code.startsWith('query.bound_') || code === 'analysis.step_bound' || code === 'analysis.traversals') return 'bound_exceeded';
  if (code === 'plan.manifest_mismatch' || code === 'plan.ontology_version_unknown' || code === 'compile.plan_not_found') return 'invalid_manifest';
  if (code.includes('capability') || code.includes('pushdown')) return 'capability_missing';
  if (code === 'query.source_unavailable' || code === 'compile.model_unavailable') return 'unavailable';
  return 'unsupported';
}

/** A clarification's kind as compile names it; link types and interfaces are not clarified by compile. */
const COMPILE_CHOICES: Partial<Record<ClarificationOption['kind'], 'object_type' | 'time_field' | 'route' | 'property'>> = {
  object_type: 'object_type', time_field: 'time_field', route: 'route', property: 'property',
};

const resultOf = (result: QueryResult): RunOutcomeView => ({
  outcome: 'result', resultRef: result.queryId, ranAt: result.computedAt, reduced: result.reduced, incompleteSources: [],
});

export function createContractEngine(services: ServiceClient): QueryEngine {
  return {
    async compile(request, caller) {
      const chosenAbout = request.chosen === undefined ? undefined : COMPILE_CHOICES[request.chosen.kind];
      const out = await services.call(compileQuestion, {
        body: {
          question: request.question,
          priorPlanIds: request.priorManifestIds.slice(0, 5),
          execute: true,
          bindingId: request.turnId,
          // A change may be asked for in Ask (42.9); finding objects is never one.
          // An AI agent that proposes neither a change nor a Cron is not offered them (D236).
          intents: request.tool !== 'find_objects' && (request.aiAgent === undefined || request.aiAgent.tools.some((t) => t === 'propose_action' || t === 'propose_cron')),
          // A harder question (36.10) may compile into a chain of steps (37.8): an advanced compile, the asker holding query.advanced.
          chains: request.advanced && request.tool === 'answer',
          ...(request.rephraseOf === undefined ? {} : { rephraseOf: request.rephraseOf }),
          ...(request.aiAgent === undefined ? {} : { aiAgent: request.aiAgent }),
          ...(request.scope?.kind === 'object' ? { focus: { objectTypeId: request.scope.objectTypeId } } : {}),
          ...(request.chosen !== undefined && chosenAbout !== undefined ? {
            chosen: {
              about: chosenAbout, elementId: request.chosen.elementId,
              rejectedIds: (request.rejected ?? []).filter((o) => o.elementId !== request.chosen!.elementId).map((o) => o.elementId).slice(0, 20),
            },
          } : {}),
        },
      }, { request: caller.request, correlationId: caller.correlationId, idempotencyKey: request.chargeKey });
      switch (out.outcome) {
        case 'refusal':
          return { outcome: 'refusal', reason: askRefusalOf(out.refusal), narrowing: out.refusal.remedy ?? null };
        case 'clarification':
          return {
            outcome: 'clarification',
            options: out.clarification.options.map((o) => ({ id: o.id, kind: out.clarification.about, elementId: o.id, label: o.name, source: null })),
          };
        case 'intent': {
          const tokensCharged = out.charge.charged ? Number(out.charge.weight) : 0;
          const rephraseUncharged = !out.charge.charged && out.charge.reason === 'rephrase_window';
          return { outcome: 'intent', intent: out.intent, compileClass: out.compileClass, tokensCharged, rephraseUncharged };
        }
        case 'schedule': {
          const tokensCharged = out.charge.charged ? Number(out.charge.weight) : 0;
          const rephraseUncharged = !out.charge.charged && out.charge.reason === 'rephrase_window';
          return { outcome: 'schedule', schedule: out.schedule, compileClass: out.compileClass, tokensCharged, rephraseUncharged };
        }
        case 'analysis': {
          // A chain answers with its last step (a comparison's first side); it runs again whole, free, and opens in Analysis.
          const tokensCharged = out.charge.charged ? Number(out.charge.weight) : 0;
          const rephraseUncharged = !out.charge.charged && out.charge.reason === 'rephrase_window';
          const refused = out.ran?.find((x) => x.outcome === 'refused');
          const last = out.ran?.at(-1);
          const ran: RunOutcomeView | undefined = refused?.outcome === 'refused'
            ? { outcome: 'refused', reason: runRefusalOf(refused.refusal), invalidSinceVersionId: null }
            : last?.outcome === 'result'
              ? { outcome: 'result', resultRef: last.results[0]!.queryId, ranAt: last.results[0]!.computedAt, reduced: last.results.some((r) => r.reduced), incompleteSources: [] }
              : undefined;
          return { outcome: 'plan', manifestId: out.manifestId, compileClass: out.compileClass, tokensCharged, rephraseUncharged, ran, chain: out.steps };
        }
        case 'plan':
        case 'answer': {
          const tokensCharged = out.charge.charged ? Number(out.charge.weight) : 0;
          const rephraseUncharged = !out.charge.charged && out.charge.reason === 'rephrase_window';
          const ran: RunOutcomeView | undefined = out.outcome === 'answer'
            ? resultOf(out.result)
            : undefined;
          return { outcome: 'plan', manifestId: out.planId, compileClass: out.compileClass, tokensCharged, rephraseUncharged, ran };
        }
      }
    },

    async failure(request, caller) {
      const out = await services.call(compileFailure, { body: { question: request.question, objectTypeId: request.objectTypeId } },
        { request: caller.request, correlationId: caller.correlationId, idempotencyKey: request.chargeKey });
      if (out.outcome === 'refusal') return { outcome: 'refusal', reason: askRefusalOf(out.refusal), narrowing: out.refusal.remedy ?? out.refusal.reason };
      return { outcome: 'failure', failure: out.failure, tokensCharged: out.charge.charged ? Number(out.charge.weight) : 0 };
    },

    async run(target, caller) {
      const options = { request: caller.request, correlationId: caller.correlationId };
      if ('objectSetId' in target) {
        const out = await services.call(runObjectSet, { body: { objectSetId: target.objectSetId, trigger: 'saved_view_run' } }, options);
        return out.outcome === 'refusal' ? { outcome: 'refused', reason: runRefusalOf(out.refusal), invalidSinceVersionId: null } : resultOf(out.result);
      }
      const out = await services.call(runCompiledPlan, {
        params: { planId: target.manifestId },
        body: { trigger: 'saved_view_run', ...(target.bindingId === undefined ? {} : { bindingId: target.bindingId }) },
      }, options);
      if (out.outcome === 'refusal') {
        const reason = runRefusalOf(out.refusal);
        if (reason !== 'invalid_manifest') return { outcome: 'refused', reason, invalidSinceVersionId: null };
        const stored = await services.call(getCompiledPlan, { params: { planId: target.manifestId } }, options).catch(() => undefined);
        return { outcome: 'refused', reason, invalidSinceVersionId: stored?.ontologyVersionId ?? null };
      }
      return resultOf(out.result);
    },

    async bind(fromBindingId, toBindingId, caller) {
      const out = await services.call(copyPlanBinding, { params: { bindingId: fromBindingId }, body: { toBindingId } },
        { request: caller.request, correlationId: caller.correlationId });
      return { planId: out.planId };
    },
  };
}
