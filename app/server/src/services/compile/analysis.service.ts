// Analysis over object sets (spec 37.8; contracts/compile/analysis.contract.ts): a chain of typed
// steps compiled into plans the federated engine runs, kept as an analysis manifest, and run step
// by step under each step's bound.
//
// Every object-set step is "the objects of this type reaching those": a plan rooted at the step's
// own type, with each earlier type as a linked node it must reach (required) carrying that step's
// filters, so the executor narrows the root to the objects that reach a filtered or required node
// (spec 26.11). A result step is the same plan with its aggregate. A refusal, from the chain or the
// planner, names the step it stopped at; a run stops at the first refused step and keeps the rest.

import type { z } from 'zod';
import {
  analysisStep, ANALYSIS_SCHEMA_VERSION, keptStep, SET_OPERATIONS, type AnalysisStep, type AnalysisStepInput, type analysisFromPlan as fromPlanContract, type compileAnalysis as compileContract, type getAnalysis, type KeptStep, type runAnalysis, type StepOutcome,
} from '../../contracts/compile/analysis.contract.ts';
import type { getVocabulary } from '../../contracts/compile/compile.contract.ts';
import { MAX_HOPS, queryPlan, type PlanFilter, type PlanPeriod, type QueryPlan, type QueryPlanInput, type Refusal } from '../../contracts/planner/plan.contract.ts';
import type { QueryResult } from '../../contracts/executor/result.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { compiledManifestRepo, planBindingRepo } from '../../repos/ontology/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { isRefusal } from '../planner/access.service.ts';
import { bound, boundParameters, compiledPlan, execute, keepAnalysis, keepBinding, vocabularyOf, type CompileDeps } from './compile.service.ts';

type Vocabulary = z.output<typeof getVocabulary.response>;
type Refused = { position: number; operation: AnalysisStep['operation']; refusal: Refusal };

/** A set as a path: its first type, then each type reached by a link, with the filters at each. */
interface SetPath {
  nodes: { objectTypeId: string; filters: PlanFilter[]; period?: PlanPeriod | undefined; via?: { linkTypeId: string; routeId: string } }[];
  show: string[];
}

const refusalAt = (step: AnalysisStep, position: number, refusal: Refusal): Refused => ({ position, operation: step.operation, refusal });
const isSet = (step: AnalysisStep) => SET_OPERATIONS.includes(step.operation);

/** The plan of a set: rooted at its last type, each earlier type a required linked node with its own filters. */
function setPlan(path: SetPath, ontologyVersionId: string, select: string[]): QueryPlanInput {
  const n = path.nodes.length;
  const nodes = path.nodes.map((_, j) => {
    const at = path.nodes[n - 1 - j]!;
    return { objectTypeId: at.objectTypeId, filters: at.filters, ...(at.period !== undefined ? { period: at.period } : {}), ...(j > 0 ? { required: true } : {}) };
  });
  const hops = path.nodes.slice(1).map((_, i) => {
    const via = path.nodes[n - 1 - i]!.via!;
    return { from: i, to: i + 1, linkTypeId: via.linkTypeId, routeId: via.routeId };
  });
  return { schemaVersion: '1', ontologyVersionId, nodes, hops, select: [...new Set(select)].map((property) => ({ node: 0, property })), sort: [] };
}

/** Every step's plans, or a refusal naming the step (spec 37.8: inputs at earlier positions only). */
export function chainOf(steps: readonly AnalysisStep[], vocabulary: Vocabulary): KeptStep[] | Refused {
  const version = vocabulary.ontologyVersionId;
  const types = new Map(vocabulary.objectTypes.map((t) => [t.id, t]));
  const links = new Map(vocabulary.linkTypes.map((l) => [l.id, l]));
  const paths = new Map<number, SetPath>();
  const kept: KeptStep[] = [];
  for (const [index, step] of steps.entries()) {
    const position = index + 1;
    const refuse = (code: string, reason: string, extra: Partial<Refusal> = {}) => refusalAt(step, position, { code, reason, ...extra });
    const inputs = step.operation === 'compare' ? [...step.inputs] : step.operation === 'filter' ? (step.input === undefined ? [] : [step.input]) : [step.input];
    for (const i of inputs) {
      if (i >= position) return refuse('analysis.input_later', `step ${position} reads step ${i}; a step reads earlier steps only`);
    }
    const setOf = (i: number): SetPath | Refused => {
      const earlier = steps[i - 1]!;
      if (!isSet(earlier)) return refuse('analysis.input_not_set', `step ${position} needs a set of objects, and step ${i} makes a result; Select turns a group back into a set`);
      return paths.get(i)!;
    };
    const titleOf = (typeId: string) => {
      const title = types.get(typeId)?.titleProperty;
      return title === null || title === undefined ? [] : [title];
    };
    const keep = (outputKind: 'object_set' | 'result', plans: QueryPlanInput[]): Refused | undefined => {
      const parsed: QueryPlan[] = [];
      for (const p of plans) {
        const out = queryPlan.safeParse(p);
        if (!out.success) return refuse('analysis.plan_invalid', `step ${position} does not make a valid plan: ${out.error.issues[0]?.message ?? 'invalid'}`);
        parsed.push(out.data);
      }
      kept.push(keptStep.parse({ position, operation: step.operation, inputSteps: inputs, outputKind, bound: step.bound, step, plans: parsed }));
      return undefined;
    };

    switch (step.operation) {
      case 'filter': {
        if ((step.base === undefined) === (step.input === undefined)) return refuse('analysis.filter_source', `step ${position} filters an earlier set or a fresh set of a type: one of them`);
        let path: SetPath;
        if (step.base !== undefined) {
          if (!types.has(step.base.objectTypeId)) return refuse('analysis.type_unknown', 'no such object type you may see', { element: { kind: 'object_type', id: step.base.objectTypeId } });
          path = { nodes: [{ objectTypeId: step.base.objectTypeId, filters: step.filters, period: step.period }], show: step.show };
        } else {
          const from = setOf(step.input!);
          if ('refusal' in from) return from;
          const last = from.nodes.at(-1)!;
          if (step.period !== undefined && last.period !== undefined) return refuse('analysis.period_twice', `step ${step.input} already has a period; one period to a set`);
          path = { nodes: [...from.nodes.slice(0, -1), { ...last, filters: [...last.filters, ...step.filters], period: step.period ?? last.period }], show: [...from.show, ...step.show] };
        }
        paths.set(position, path);
        const r = keep('object_set', [setPlan(path, version, [...titleOf(path.nodes.at(-1)!.objectTypeId), ...path.show])]);
        if (r !== undefined) return r;
        break;
      }
      case 'traverse': {
        const from = setOf(step.input);
        if ('refusal' in from) return from;
        const link = links.get(step.linkTypeId);
        if (link === undefined) return refuse('analysis.link_unknown', 'no such link type you may follow', { element: { kind: 'link_type', id: step.linkTypeId } });
        const at = from.nodes.at(-1)!.objectTypeId;
        const target = link.fromTypeId === at ? link.toTypeId : link.toTypeId === at ? link.fromTypeId : undefined;
        if (target === undefined) return refuse('analysis.link_not_from_set', `${link.apiName} does not link the objects of step ${step.input}`, { element: { kind: 'link_type', id: link.id, name: link.apiName } });
        const routeId = step.routeId ?? link.defaultRouteId ?? link.routes[0]?.id;
        if (routeId === undefined || !link.routes.some((r) => r.id === routeId)) {
          return refuse('analysis.no_route', `${link.apiName} has no route through a connection you hold`, { element: { kind: 'link_type', id: link.id, name: link.apiName } });
        }
        if (from.nodes.length >= MAX_HOPS + 1) {
          return refuse('analysis.traversals', `step ${position} would follow ${from.nodes.length} links from its first set, over the bound of ${MAX_HOPS}`,
            { bound: { name: 'traversals', limit: MAX_HOPS, observed: from.nodes.length } });
        }
        const path: SetPath = { nodes: [...from.nodes, { objectTypeId: target, filters: step.filters, period: step.period, via: { linkTypeId: link.id, routeId } }], show: step.show };
        paths.set(position, path);
        const r = keep('object_set', [setPlan(path, version, [...titleOf(target), ...path.show])]);
        if (r !== undefined) return r;
        break;
      }
      case 'derive': {
        const from = setOf(step.input);
        if ('refusal' in from) return from;
        const typeId = from.nodes.at(-1)!.objectTypeId;
        const known = new Set(types.get(typeId)?.properties.map((p) => p.identityId) ?? []);
        const missing = step.properties.find((p) => !known.has(p));
        if (missing !== undefined) return refuse('analysis.property_unknown', 'that property is not one of these objects\' you may see', { element: { kind: 'property', id: missing } });
        const path: SetPath = { nodes: from.nodes, show: [...from.show, ...step.properties] };
        paths.set(position, path);
        const r = keep('object_set', [setPlan(path, version, [...titleOf(typeId), ...path.show])]);
        if (r !== undefined) return r;
        break;
      }
      case 'select': {
        const grouped = steps[step.input - 1]!;
        if (grouped.operation !== 'group' && grouped.operation !== 'time_series' && grouped.operation !== 'pivot') {
          return refuse('analysis.select_source', `step ${position} selects a group of a group, time series or pivot step, and step ${step.input} is a ${grouped.operation.replace('_', ' ')}`);
        }
        const keys = grouped.operation === 'group' ? grouped.groupBy.map((g) => g.property) : grouped.operation === 'time_series' ? [grouped.property] : [grouped.rows, grouped.columns];
        const behind = paths.get(grouped.input)!;
        const added: PlanFilter[] = [];
        for (const k of step.key) {
          if (!keys.includes(k.property)) return refuse('analysis.select_key', `step ${step.input} is not grouped by that property`, { element: { kind: 'property', id: k.property } });
          if (k.value === null) added.push({ property: k.property, op: 'is_null' });
          else if (k.to !== undefined) added.push({ property: k.property, op: 'gte', value: k.value }, { property: k.property, op: 'lt', value: k.to });
          else added.push({ property: k.property, op: 'eq', value: k.value });
        }
        const last = behind.nodes.at(-1)!;
        const path: SetPath = { nodes: [...behind.nodes.slice(0, -1), { ...last, filters: [...last.filters, ...added] }], show: [...behind.show, ...step.show] };
        paths.set(position, path);
        const r = keep('object_set', [setPlan(path, version, [...titleOf(last.objectTypeId), ...path.show])]);
        if (r !== undefined) return r;
        break;
      }
      case 'group': case 'time_series': case 'pivot': case 'compare': {
        const sources = step.operation === 'compare' ? step.inputs.map(setOf) : [setOf(step.input)];
        const failed = sources.find((s): s is Refused => 'refusal' in s);
        if (failed !== undefined) return failed;
        const groupBy = step.operation === 'group' || step.operation === 'compare' ? step.groupBy
          : step.operation === 'time_series' ? [{ property: step.property, bucket: step.unit }] : [{ property: step.rows }, { property: step.columns }];
        const measures = step.operation === 'pivot' ? [step.measure] : step.measures;
        const timeKey = groupBy.find((g) => g.bucket !== undefined);
        const plans = (sources as SetPath[]).map((path) => ({
          ...setPlan(path, version, []),
          aggregate: {
            groupBy: groupBy.map((g) => ({ node: 0, property: g.property, ...(g.bucket !== undefined ? { bucket: g.bucket } : {}) })),
            measures: measures.map((m) => ({ fn: m.fn, node: 0, as: m.as, ...(m.property !== undefined ? { property: m.property } : {}) })),
          },
          // A series in time order; anything else with its largest first.
          sort: timeKey !== undefined ? [{ property: timeKey.property, direction: 'asc' as const }]
            : groupBy.length > 0 ? [{ measure: measures[0]!.as, direction: 'desc' as const }] : [],
        }));
        const r = keep('result', plans);
        if (r !== undefined) return r;
        break;
      }
    }
  }
  return kept;
}

/**
 * A stored plan as steps (spec 37.8): its deepest filtered type first, each link followed back to the
 * answer's own objects (each linked node's conditions kept on its step), then its aggregate. Only a
 * chain becomes steps; anything else is said not to be one, with why. Values are not touched: the
 * steps keep the plan's own placeholders, so its binding's values stand for them.
 */
export function stepsOfPlan(plan: QueryPlan): { steps: AnalysisStepInput[]; notes: string[] } | Refusal {
  const no = (code: string, reason: string): Refusal => ({ code, reason });
  if (plan.asOf !== undefined) return no('analysis.from_plan_as_of', 'an answer as of a moment cannot become steps, which read what is true now');
  if (plan.history !== undefined) return no('analysis.from_plan_history', 'a history of changes cannot become steps over sets of objects');
  if (plan.nodes[0]!.interfaceId !== undefined) return no('analysis.from_plan_interface', 'an answer over an interface cannot become steps yet: a step reads one type');
  const childOf = new Map(plan.hops.map((h) => [h.from, h]));
  if (plan.hops.some((h) => plan.hops.filter((x) => x.from === h.from).length > 1)) {
    return no('analysis.from_plan_branches', 'the answer follows two links from one type; steps follow one link at a time');
  }
  // The path from the answer's objects outwards: node 0, then each node its one hop reaches.
  const order = [0];
  while (childOf.has(order.at(-1)!)) order.push(childOf.get(order.at(-1)!)!.to);
  for (const n of order.slice(1)) {
    const node = plan.nodes[n]!;
    if (node.filters.length === 0 && node.period === undefined) {
      return no('analysis.from_plan_unconditioned', 'the answer shows linked objects it does not narrow by; as steps they would have to be linked');
    }
  }
  if (plan.aggregate?.measures.some((m) => m.node !== 0) === true) return no('analysis.from_plan_linked_measure', 'the answer measures linked objects; a step measures its own');
  const steps: AnalysisStepInput[] = [];
  const conditions = (n: number) => ({ filters: plan.nodes[n]!.filters, ...(plan.nodes[n]!.period !== undefined ? { period: plan.nodes[n]!.period } : {}) });
  const deepest = order.at(-1)!;
  steps.push({ operation: 'filter', base: { objectTypeId: plan.nodes[deepest]!.objectTypeId! }, ...conditions(deepest) });
  for (let i = order.length - 2; i >= 0; i -= 1) {
    const n = order[i]!;
    const hop = childOf.get(n)!;
    steps.push({ operation: 'traverse', input: steps.length, linkTypeId: hop.linkTypeId, routeId: hop.routeId, ...conditions(n) });
  }
  const show = plan.select.filter((s) => s.node === 0).map((s) => s.property);
  if (show.length > 0) (steps.at(-1) as { show?: string[] }).show = show.slice(0, 20);
  const notes: string[] = [];
  if (plan.aggregate !== undefined) {
    steps.push({
      operation: 'group', input: steps.length,
      groupBy: plan.aggregate.groupBy.map((g) => ({ property: g.property, ...(g.bucket !== undefined ? { bucket: g.bucket } : {}) })),
      measures: plan.aggregate.measures.map((m) => ({ fn: m.fn, as: m.as, ...(m.property !== undefined ? { property: m.property } : {}) })),
    });
  }
  if (plan.limit !== undefined) notes.push(`The answer showed the first ${plan.limit}; the steps keep every ${plan.aggregate !== undefined ? 'group, largest first' : 'object'}, within each step's bound.`);
  return { steps, notes };
}

/** An answer continued as an analysis (spec 37.8): its plan made steps, its values kept under the new binding. */
export async function analysisFromPlan(deps: CompileDeps, ctx: HandlerContext, input: z.output<typeof fromPlanContract.body>)
  : Promise<z.output<typeof fromPlanContract.response>> {
  // An answer that is a chain already (a harder question, 37.8): the same chain, its values copied under the new binding.
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => compiledManifestRepo.findById(db, input.planId), { readOnly: true });
  if (row?.kind === 'analysis') {
    const values = await boundParameters(deps, ctx, input.planId, input.fromBindingId);
    if (isRefusal(values)) return { outcome: 'not_steps', refusal: values };
    const { steps } = await stepsOf(deps, ctx, input.planId);
    await keepBinding(deps, ctx, input.bindingId, input.planId, values);
    return { outcome: 'analysis', manifestId: input.planId, ontologyVersionId: row.ontologyVersionId, steps, notes: [] };
  }
  const stored = await compiledPlan(deps, ctx, input.planId);
  const parameters = await boundParameters(deps, ctx, input.planId, input.fromBindingId);
  if (isRefusal(parameters)) return { outcome: 'not_steps', refusal: parameters };
  const converted = stepsOfPlan(stored.plan);
  if ('code' in converted) return { outcome: 'not_steps', refusal: converted };
  const parsed = analysisStep.array().safeParse(converted.steps);
  if (!parsed.success) return { outcome: 'not_steps', refusal: { code: 'analysis.from_plan_invalid', reason: parsed.error.issues[0]?.message ?? 'the steps are not valid' } };
  const kept = await compileChain(deps, ctx, { steps: parsed.data, parameters, bindingId: input.bindingId });
  return kept.outcome === 'analysis' ? { ...kept, notes: converted.notes } : kept;
}

/**
 * Compiles and keeps a chain (spec 37.8), against main's head or the version a question was
 * compiled against. By hand, no model and never metered; from a question, compile charges it.
 */
export async function compileChain(deps: CompileDeps, ctx: HandlerContext, input: z.output<typeof compileContract.body>, ontologyVersionId?: string)
  : Promise<z.output<typeof compileContract.response>> {
  const vocabulary = await vocabularyOf(deps, ctx, ontologyVersionId);
  const chain = chainOf(input.steps, vocabulary);
  if (!Array.isArray(chain)) return { outcome: 'refusal', refused: chain };
  // Each plan against the reader's vocabulary and bounds now, so a step that could never run is refused at once.
  for (const step of chain) {
    for (const plan of step.plans) {
      const checked = await bound(deps, ctx, plan, input.parameters);
      if (isRefusal(checked)) return { outcome: 'refusal', refused: { position: step.position, operation: step.operation, refusal: checked } };
    }
  }
  const manifestId = await keepAnalysis(deps, ctx, { schemaVersion: ANALYSIS_SCHEMA_VERSION, ontologyVersionId: vocabulary.ontologyVersionId, steps: chain });
  await keepBinding(deps, ctx, input.bindingId, manifestId, input.parameters);
  return { outcome: 'analysis', manifestId, ontologyVersionId: vocabulary.ontologyVersionId, steps: chain };
}

async function stepsOf(deps: CompileDeps, ctx: HandlerContext, manifestId: string) {
  const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => compiledManifestRepo.findById(db, manifestId), { readOnly: true });
  const parsed = row?.kind === 'analysis' ? keptStep.array().safeParse((row.manifest as { steps?: unknown }).steps) : undefined;
  if (!row || !parsed?.success) throw new AppError('not_found', 'no such analysis', { code: 'compile.analysis_not_found' });
  return { row, steps: parsed.data };
}

/** How a chain is run: with whose values, why, and how far. */
export interface ChainRun {
  bindingId?: string | undefined;
  upTo?: number | undefined;
  trigger: string;
  purposeSessionIds?: readonly string[] | undefined;
}

/**
 * Runs a chain step by step (spec 37.8): each under its own bound, members for a set and groups for a
 * result; the first step refused, by the engine or by its bound, names the step, the bound and the
 * count, and every step after it is not run. Earlier steps keep their results. Never metered. The
 * last step's results come back whole, for a caller that answers with them (an Ask turn, a re-run).
 */
export async function runChainSteps(deps: CompileDeps, ctx: HandlerContext, manifestId: string, input: ChainRun)
  : Promise<{ steps: StepOutcome[]; last: QueryResult[] }> {
  const { steps } = await stepsOf(deps, ctx, manifestId);
  const parameters = await boundParameters(deps, ctx, manifestId, input.bindingId);
  const out: StepOutcome[] = [];
  let last: QueryResult[] = [];
  let stopped = isRefusal(parameters);
  for (const step of steps) {
    if (input.upTo !== undefined && step.position > input.upTo) break;
    if (stopped) {
      out.push(isRefusal(parameters) && out.length === 0
        ? { outcome: 'refused', position: step.position, operation: step.operation, refusal: parameters }
        : { outcome: 'not_run', position: step.position, operation: step.operation });
      continue;
    }
    const results: QueryResult[] = [];
    let refusal: Refusal | undefined;
    for (const plan of step.plans) {
      const ran = await execute(deps, ctx, plan, parameters as Exclude<typeof parameters, Refusal>, manifestId, input.trigger, input.purposeSessionIds);
      if ('refusal' in ran) {
        refusal = ran.refusal;
        break;
      }
      const count = ran.result.total;
      if (count > step.bound) {
        const what = step.outputKind === 'object_set' ? 'members' : 'groups';
        refusal = {
          code: 'analysis.step_bound',
          reason: `step ${step.position} (${step.operation.replace('_', ' ')}) has ${count} ${what}, over its bound of ${step.bound}; refused rather than continued on part of it`,
          bound: { name: step.outputKind === 'object_set' ? 'step_members' : 'step_groups', limit: step.bound, observed: count },
          remedy: step.outputKind === 'object_set' ? 'narrow the step with a filter' : 'group by fewer values',
        };
        break;
      }
      results.push(ran.result);
    }
    if (refusal !== undefined) {
      out.push({ outcome: 'refused', position: step.position, operation: step.operation, refusal });
      stopped = true;
    } else {
      last = results;
      out.push({
        outcome: 'result', position: step.position, operation: step.operation, outputKind: step.outputKind,
        results: results.map((r) => ({ queryId: r.queryId, kind: r.kind, total: r.total, population: r.population, computedAt: r.computedAt, reduced: r.reduced })),
      });
    }
  }
  return { steps: out, last: stopped ? [] : last };
}

export async function runChain(deps: CompileDeps, ctx: HandlerContext, manifestId: string, input: z.output<typeof runAnalysis.body>)
  : Promise<z.output<typeof runAnalysis.response>> {
  const { steps } = await runChainSteps(deps, ctx, manifestId, input);
  return { manifestId, steps };
}

/** A chain's steps, and its values for the person who bound them (and nobody else). */
export async function analysisOf(deps: CompileDeps, ctx: HandlerContext, manifestId: string, bindingId: string | undefined)
  : Promise<z.output<typeof getAnalysis.response>> {
  const { row, steps } = await stepsOf(deps, ctx, manifestId);
  let parameters: z.output<typeof getAnalysis.response>['parameters'] = null;
  if (bindingId !== undefined) {
    const binding = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => planBindingRepo.findById(db, bindingId), { readOnly: true });
    if (binding !== undefined && binding.createdByMembershipId !== null && binding.createdByMembershipId === ctx.request.membershipId) {
      const opened = await boundParameters(deps, ctx, manifestId, bindingId);
      parameters = isRefusal(opened) ? null : opened;
    }
  }
  return { manifestId, ontologyVersionId: row.ontologyVersionId, createdAt: row.createdAt, steps, parameters };
}
