// A Studio chart as the steps of an analysis (spec 37.8; contracts/studio/app.contract.ts
// appChartSteps): its set's type, filtered as the app's filter keeps it for the viewer's values,
// each link the set follows, the viewer's facet narrowing, then the chart's measure by its grouping.
//
// The set's filter is CEL over `object`, `now` and the app's parameters (35.2); a step's filters
// are typed, with values only as placeholders. So the filter is read, not run: every part that does
// not read the object is evaluated with the viewer's values (the "everything until a region is
// chosen" idiom, `region == null || object.region == region`, is everything or one region), and
// what remains must be a conjunction of comparisons of a declared property with a value, which
// become typed filters whose values are the steps' parameters. A part with no typed form (two
// properties compared, arithmetic over a property, a disjunction over different properties) or one
// that reads now (a period is a step's, resolved on every run, 26.8) is said not to be steps,
// naming the part, never approximated. Where a typed filter keeps a different set from the CEL
// one, the difference is a note: CEL's `!=` keeps an object with no value, a step's never does.

import type { z } from 'zod';
import type { AnalysisStepInput } from '../../contracts/compile/analysis.contract.ts';
import type { OntologyManifest, PropertyView } from '../../contracts/ontology/manifest.contract.ts';
import type { PlanFilter, PlanParameters, Refusal } from '../../contracts/planner/plan.contract.ts';
import type { appChartSteps, chartAsViewed } from '../../contracts/studio/app.contract.ts';
import type { AppDefinition } from '../../contracts/studio/definition.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { celSource, celTree, compileCel, type CelNode } from '../expression-evaluator/cel.service.ts';
import { type Context, type StudioDeps, mainManifest } from './deps.service.ts';
import { parameterBindings, runnableVersion } from './runtime.service.ts';

type Scalar = string | number | boolean;
type Viewed = z.output<typeof chartAsViewed>;
type Outcome = z.output<typeof appChartSteps.response>;
type Op = PlanFilter['op'];

/** A typed filter before its value is a parameter. */
interface Leaf { property: PropertyView; op: Op; value?: Scalar | Scalar[] }
/** A part of the filter as read: a value (true, false, anything else), a failure, or typed filters all of which hold. */
type Reading = { kind: 'value'; value: unknown } | { kind: 'fails' } | { kind: 'filters'; leaves: Leaf[] };

class NotSteps extends Error {
  readonly refusal: Refusal;
  constructor(code: string, reason: string) {
    super(code);
    this.refusal = { code, reason };
  }
}

const EVALUATION_BOUNDS = { steps: 10_000, timeMs: 10 };
const TRUE: Reading = { kind: 'value', value: true };
const FALSE: Reading = { kind: 'value', value: false };
const FAILS: Reading = { kind: 'fails' };
const isTrue = (r: Reading) => r.kind === 'value' && r.value === true;
const isFalse = (r: Reading) => r.kind === 'value' && r.value === false;

/** How a property's values compare in a step's filter; types with no entry are not filtered by a step. */
const VALUE_KIND: Partial<Record<PropertyView['dataType'], 'number' | 'string' | 'boolean'>> = {
  integer: 'number', decimal: 'number', string: 'string', enum: 'string', date: 'string', timestamp: 'string', boolean: 'boolean',
};
/** A comparison with its sides swapped: `3 < object.qty` is `object.qty > 3`. */
const FLIPPED: Record<string, Op> = { '==': 'eq', '!=': 'ne', '<': 'gt', '<=': 'gte', '>': 'lt', '>=': 'lte' };
const DIRECT: Record<string, Op> = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };
/** A filter negated, where the negation is typed and keeps the same objects (an empty value fails both). */
const NEGATED: Partial<Record<Op, Op>> = { lt: 'gte', lte: 'gt', gt: 'lte', gte: 'lt', is_null: 'is_not_null', is_not_null: 'is_null', ne: 'eq', eq: 'ne' };

/** The node's operands, whatever its operator. */
function children(n: CelNode): CelNode[] {
  const a = n.args as unknown;
  switch (n.op) {
    case 'value': case 'id': return [];
    case '.': case '.?': return [(a as [CelNode, string])[0]];
    case 'call': return (a as [string, CelNode[]])[1];
    case 'rcall': return [(a as [string, CelNode, CelNode[]])[1], ...(a as [string, CelNode, CelNode[]])[2]];
    case 'list': return a as CelNode[];
    case 'map': return (a as [CelNode, CelNode][]).flat();
    case '!_': case '-_': return [a as CelNode];
    default: return a as CelNode[];
  }
}

function names(n: CelNode, into = new Set<string>()): Set<string> {
  if (n.op === 'id') into.add(n.args as string);
  for (const c of children(n)) names(c, into);
  return into;
}

/** A plain JSON-like value of a CEL result, or undefined for one a step cannot hold (a map, bytes, a timestamp). */
function plain(v: unknown): Scalar | null | Scalar[] | undefined {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) {
    const items = v.map(plain);
    return items.every((i): i is Scalar => i !== null && i !== undefined && !Array.isArray(i)) ? items : undefined;
  }
  return undefined;
}

export interface ChartSteps { steps: AnalysisStepInput[]; parameters: PlanParameters; notes: string[] }

/**
 * The chart's steps for the viewer's values, or why it is not steps. Pure: the definition, main's
 * manifest, and what the viewer has set. Values go into the parameters (p1, p2, ...), never the steps.
 */
export function stepsOfChart(def: AppDefinition, widgetId: string, manifest: OntologyManifest, viewed: Pick<Viewed, 'narrowing'>, bindings: Readonly<Record<string, Scalar | null>>): ChartSteps | Refusal {
  const widget = def.pages.flatMap((p) => p.widgets).find((w) => w.id === widgetId);
  if (widget === undefined || widget.kind !== 'chart') throw new AppError('not_found', 'the app has no chart of that id', { code: 'studio.chart_not_found' });
  const variable = def.variables[widget.source];
  if (variable === undefined || variable.kind !== 'objectSet') throw new AppError('not_found', 'the chart\'s source is not an object set', { code: 'studio.chart_not_found' });
  const types = new Map(manifest.objectTypes.filter((t) => t.status === 'active').map((t) => [t.id, t]));
  const links = new Map(manifest.linkTypes.filter((l) => l.status === 'active').map((l) => [l.id, l]));
  const start = types.get(variable.objectTypeId);
  if (start === undefined) return { code: 'studio.chart_type_gone', reason: 'the chart\'s object type is no longer in the ontology' };

  const parameters: PlanParameters = {};
  const notes: string[] = [];
  let next = 1;
  const param = (value: Scalar | Scalar[]) => {
    const name = `p${next++}`;
    parameters[name] = value;
    return { param: name };
  };
  const typed = (leaves: readonly Leaf[]): PlanFilter[] => leaves.map((l) => l.value === undefined ? { property: l.property.identityId, op: l.op } : { property: l.property.identityId, op: l.op, value: param(l.value) });
  const noteNe = (leaves: readonly Leaf[]) => {
    for (const l of leaves) {
      if (l.op === 'ne') notes.push(`Objects with no ${l.property.displayName} are left out: a step's "is not" keeps only objects with a value, where the app's filter keeps those with none too.`);
    }
  };

  try {
    // ---- The set's own type, as the filter keeps it.
    let filters: PlanFilter[] = [];
    if (variable.filter !== undefined) {
      const declared = new Map(variable.filter.properties.map((id) => start.properties.find((p) => p.identityId === id && p.status === 'active'))
        .filter((p): p is PropertyView => p !== undefined).map((p) => [p.apiName, p]));
      const reading = readFilter(variable.filter.cel, declared, bindings);
      if (reading.kind === 'value' && reading.value !== true) {
        return { code: 'studio.chart_filter_never', reason: 'with the values set, the app\'s filter keeps no object, so there is nothing to analyse' };
      }
      if (reading.kind === 'fails') return { code: 'studio.chart_filter_fails', reason: 'with the values set, the app\'s filter fails for every object; set its parameters and try again' };
      if (reading.kind === 'filters') {
        noteNe(reading.leaves);
        filters = typed(reading.leaves);
      }
    }
    const steps: AnalysisStepInput[] = [{ operation: 'filter', base: { objectTypeId: start.id }, filters }];

    // ---- Each link the set follows, in order.
    let at = start.id;
    for (const hop of variable.traversal ?? []) {
      const link = links.get(hop.linkTypeId);
      if (link === undefined) return { code: 'studio.chart_link_gone', reason: 'a link the chart\'s set follows is no longer in the ontology' };
      // A step follows a link away from its input's type; a link from a type to itself is followed forwards.
      if (link.fromTypeId === link.toTypeId && hop.direction === 'reverse') {
        return { code: 'studio.chart_link_reverse', reason: `the set follows ${link.apiName} backwards, from a type to itself; a step follows such a link forwards only` };
      }
      steps.push({ operation: 'traverse', input: steps.length, linkTypeId: link.id });
      at = hop.direction === 'forward' ? link.toTypeId : link.fromTypeId;
    }

    // ---- The viewer's filter controls: each facet an exact value of the set's own type.
    const facets = Object.entries(viewed.narrowing?.facets ?? {});
    if (facets.length > 0) {
      const type = types.get(at);
      const leaves: Leaf[] = [];
      for (const [id, value] of facets) {
        const property = type?.properties.find((p) => p.identityId === id && p.status === 'active');
        if (property === undefined) return { code: 'studio.chart_facet_unknown', reason: 'a filter control narrows by a property the set\'s objects no longer have' };
        leaves.push({ property, op: 'eq', value: facetValue(property, value) });
      }
      steps.push({ operation: 'filter', input: steps.length, filters: typed(leaves) });
    }
    if (viewed.narrowing?.searched === true) {
      notes.push('The search in the app\'s filter controls is not kept: a step has no search across every value, so the analysis starts from the set before it.');
    }

    // ---- The chart: its measure by its grouping.
    const { aggregate, property } = widget.measure;
    if (aggregate !== 'count' && property === undefined) return { code: 'studio.chart_measure', reason: 'the chart measures no property, so it has no step to make' };
    steps.push({
      operation: 'group', input: steps.length,
      groupBy: widget.groupBy === undefined ? [] : [{ property: widget.groupBy }],
      measures: [aggregate === 'count' ? { fn: 'count', as: 'objects' } : { fn: aggregate, property: property!, as: aggregate === 'avg' ? 'average' : aggregate === 'min' ? 'minimum' : aggregate === 'max' ? 'maximum' : 'total' }],
    });
    return { steps, parameters, notes };
  } catch (error) {
    if (error instanceof NotSteps) return error.refusal;
    throw error;
  }
}

/** A facet's value as the property holds it: the control lists values as text. */
function facetValue(property: PropertyView, value: string): Scalar {
  const kind = VALUE_KIND[property.dataType];
  if (kind === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  if (kind === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}

/** The set's filter read for the viewer's values: a value where it does not read the object, otherwise typed filters. */
export function readFilter(cel: string, declared: ReadonlyMap<string, PropertyView>, bindings: Readonly<Record<string, Scalar | null>>): Reading {
  const inputs = { object: 'map' as const, now: 'timestamp' as const, ...Object.fromEntries(Object.keys(bindings).map((n) => [n, 'dyn' as const])) };
  const tree = celTree(cel, inputs);
  const constants = Object.fromEntries(Object.keys(bindings).map((n) => [n, 'dyn' as const]));
  const part = (n: CelNode) => celSource(n);
  const no = (code: string, reason: string): never => {
    throw new NotSteps(code, reason);
  };

  /** A part that does not read the object, evaluated with the viewer's values. */
  const evaluate = (n: CelNode): Reading => {
    try {
      return { kind: 'value', value: compileCel(part(n), constants).evaluate(bindings, EVALUATION_BOUNDS) };
    } catch {
      return FAILS;
    }
  };

  /** A declared property the node names (`object.region`, `object["region"]`), or undefined if it is not one. */
  const propertyOf = (n: CelNode): PropertyView | undefined => {
    let apiName: string | undefined;
    if (n.op === '.' || n.op === '.?') {
      const [target, field] = n.args as [CelNode, string];
      if (target.op === 'id' && target.args === 'object') apiName = field;
    } else if (n.op === '[]') {
      const [target, key] = n.args as [CelNode, CelNode];
      if (target.op === 'id' && target.args === 'object' && key.op === 'value' && typeof key.args === 'string') apiName = key.args;
    }
    if (apiName === undefined) return undefined;
    const property = declared.get(apiName);
    if (property === undefined) no('studio.chart_filter_property', `the filter reads ${apiName}, which is not a property it declares`);
    return property;
  };

  const reads = (n: CelNode) => names(n).has('object');

  /** A value compared with a property: of the property's kind, or not steps. */
  const valueFor = (property: PropertyView, v: unknown, n: CelNode): Scalar | Scalar[] | null => {
    const kind = VALUE_KIND[property.dataType];
    if (kind === undefined) no('studio.chart_filter_type', `the filter compares ${property.displayName}, a ${property.dataType}, which a step does not filter by`);
    const value = plain(v);
    if (value === undefined) no('studio.chart_filter_value', `${part(n)} is not a value a step can hold`);
    const items = Array.isArray(value) ? value : value === null ? [] : [value];
    if (items.some((i) => typeof i !== kind)) no('studio.chart_filter_mismatch', `${part(n)} compares ${property.displayName}, ${kind === 'number' ? 'a number' : kind === 'boolean' ? 'true or false' : 'text'}, with a value of another kind`);
    return value!;
  };

  const leaf = (property: PropertyView, op: Op, value?: Scalar | Scalar[]): Reading => ({ kind: 'filters', leaves: [value === undefined ? { property, op } : { property, op, value }] });

  const read = (n: CelNode): Reading => {
    const seen = names(n);
    if (seen.has('now')) no('studio.chart_filter_now', `the filter reads now (${part(n)}); a step's time is a period, resolved again on every run, so add one to the analysis instead`);
    if (!seen.has('object')) return evaluate(n);
    switch (n.op) {
      case '&&': {
        const [a, b] = (n.args as [CelNode, CelNode]).map(read) as [Reading, Reading];
        if (isFalse(a) || isFalse(b)) return FALSE;
        if (isTrue(a)) return b;
        if (isTrue(b)) return a;
        if (a.kind === 'filters' && b.kind === 'filters') return { kind: 'filters', leaves: [...a.leaves, ...b.leaves] };
        if (a.kind === 'fails' || b.kind === 'fails') return FAILS;
        return no('studio.chart_filter_shape', `${part(n)} has no typed form`);
      }
      case '||': {
        const [a, b] = (n.args as [CelNode, CelNode]).map(read) as [Reading, Reading];
        if (isTrue(a) || isTrue(b)) return TRUE;
        if (isFalse(a)) return b;
        if (isFalse(b)) return a;
        // A failing side keeps an object only where the other holds, and fails (keeps nothing) where it does not: refused, not guessed.
        if (a.kind === 'fails' || b.kind === 'fails') return no('studio.chart_filter_fails', `${part(n)} fails for the values set on one side`);
        // Either of two values of one property is one "in" filter; anything else is not a conjunction.
        const values = (r: Reading) => r.kind === 'filters' && r.leaves.length === 1 && (r.leaves[0]!.op === 'eq' || r.leaves[0]!.op === 'in') ? r.leaves[0]! : undefined;
        const x = values(a);
        const y = values(b);
        if (x !== undefined && y !== undefined && x.property.identityId === y.property.identityId) {
          const all = [...new Set([...[x.value!].flat(), ...[y.value!].flat()])];
          return leaf(x.property, 'in', all);
        }
        return no('studio.chart_filter_either', `${part(n)} keeps objects that meet either of two conditions; a step's filters must all hold`);
      }
      case '!_': {
        const inner = read(n.args as CelNode);
        if (inner.kind === 'value') return typeof inner.value === 'boolean' ? { kind: 'value', value: !inner.value } : FAILS;
        // CEL's negation of a failure is a failure, not true: refused rather than read as the opposite.
        if (inner.kind === 'fails') return no('studio.chart_filter_fails', `${part(n)} fails for the values set`);
        const only = inner.leaves.length === 1 ? inner.leaves[0]! : undefined;
        const negated = only === undefined ? undefined : NEGATED[only.op];
        if (only === undefined || negated === undefined) return no('studio.chart_filter_not', `${part(n)} has no typed form`);
        // !(object.flag) is the flag false; otherwise the opposite comparison.
        if (only.property.dataType === 'boolean' && only.op === 'eq' && typeof only.value === 'boolean') return leaf(only.property, 'eq', !only.value);
        return leaf(only.property, negated, only.value);
      }
      case '?:': {
        const [condition, then, otherwise] = n.args as [CelNode, CelNode, CelNode];
        const c = read(condition);
        if (isTrue(c)) return read(then);
        if (isFalse(c)) return read(otherwise);
        if (c.kind === 'fails') return FAILS;
        return no('studio.chart_filter_shape', `${part(n)} chooses by a property; a step's filters do not`);
      }
      case '==': case '!=': case '<': case '<=': case '>': case '>=': {
        const [left, right] = n.args as [CelNode, CelNode];
        if (reads(left) && reads(right)) return no('studio.chart_filter_two', `${part(n)} compares the object with itself; a step compares a property with a value`);
        const flipped = !reads(left);
        const side = flipped ? right : left;
        const property = propertyOf(side);
        if (property === undefined) return no('studio.chart_filter_shape', `${part(side)} is not a property; a step compares a property with a value`);
        const other = evaluate(flipped ? left : right);
        if (other.kind !== 'value') return FAILS;
        const op = (flipped ? FLIPPED : DIRECT)[n.op]!;
        if (other.value === null) {
          if (op === 'eq') return leaf(property, 'is_null');
          if (op === 'ne') return leaf(property, 'is_not_null');
          return FAILS;
        }
        const value = valueFor(property, other.value, flipped ? left : right);
        if (Array.isArray(value)) return no('studio.chart_filter_value', `${part(n)} compares ${property.displayName} with a list`);
        return leaf(property, op, value as Scalar);
      }
      case 'in': {
        const [left, right] = n.args as [CelNode, CelNode];
        const property = propertyOf(left);
        if (property === undefined || reads(right)) return no('studio.chart_filter_shape', `${part(n)} has no typed form; a step asks whether a property is one of a list of values`);
        const list = evaluate(right);
        if (list.kind !== 'value') return FAILS;
        if (!Array.isArray(list.value)) return FAILS;
        if (list.value.length === 0) return FALSE;
        const value = valueFor(property, list.value, right);
        return leaf(property, 'in', value as Scalar[]);
      }
      case 'rcall': {
        const [fn, target, args] = n.args as [string, CelNode, CelNode[]];
        const property = propertyOf(target);
        const op = fn === 'contains' ? 'contains' : fn === 'startsWith' ? 'starts_with' : undefined;
        if (property === undefined || op === undefined || args.length !== 1 || reads(args[0]!)) return no('studio.chart_filter_shape', `${part(n)} has no typed form`);
        const arg = evaluate(args[0]!);
        if (arg.kind !== 'value') return FAILS;
        if (VALUE_KIND[property.dataType] !== 'string' || typeof arg.value !== 'string') return no('studio.chart_filter_mismatch', `${part(n)} looks for text in ${property.displayName}, which is not text`);
        return leaf(property, op, arg.value);
      }
      default: {
        // A boolean property standing alone: it is true.
        const property = propertyOf(n);
        if (property !== undefined) {
          if (property.dataType !== 'boolean') return no('studio.chart_filter_mismatch', `${part(n)} stands alone, but ${property.displayName} is not true or false`);
          return leaf(property, 'eq', true);
        }
        return no('studio.chart_filter_shape', `${part(n)} has no typed form`);
      }
    }
  };
  return read(tree);
}

/** The chart of an app the viewer may run, as steps for their values (spec 37.8). */
export async function chartSteps(deps: StudioDeps, ctx: Context, appId: string, widgetId: string, viewed: Viewed): Promise<Outcome> {
  const def = await runnableVersion(deps, ctx, appId, viewed.version);
  const bindings = parameterBindings(def, viewed.parameters);
  const manifest = await mainManifest(deps, ctx);
  const out = stepsOfChart(def, widgetId, manifest, viewed, bindings);
  if ('code' in out) return { outcome: 'not_steps', refusal: out };
  return { outcome: 'steps', steps: out.steps as never, parameters: out.parameters, notes: out.notes };
}
