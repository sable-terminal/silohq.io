// An analysis being built (spec 37.8): its steps as the person sees them, values in place, turned
// into the typed steps compile keeps (values as placeholders, sealed apart) and back. Also what each
// step's objects are, and each step in words. No React here, so it is tested on its own.

import type { Input } from '../../api/client.api.ts';
import type { Lookup } from '../../hooks/vocabulary.hook.ts';

export type StepInput = NonNullable<Input<'createWorkspaceAnalysis'>['body']>['steps'][number];
export type Operation = StepInput['operation'];
export type Scalar = string | number | boolean;
export type FilterOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'contains' | 'starts_with' | 'is_null' | 'is_not_null';
export type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'financial_quarter' | 'financial_year';
export type MeasureFn = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';

export interface FilterDraft { property: string; op: FilterOp; value?: Scalar | Scalar[] }
export interface MeasureDraft { fn: MeasureFn; property?: string | undefined; as: string }
export interface KeyDraft { property: string; value: Scalar | null; to?: Scalar | undefined }

export type StepDraft =
  | { operation: 'filter'; input?: number | undefined; base?: string | undefined; filters: FilterDraft[]; bound?: number | undefined }
  | { operation: 'traverse'; input: number; linkTypeId: string; filters: FilterDraft[]; bound?: number | undefined }
  | { operation: 'derive'; input: number; properties: string[]; bound?: number | undefined }
  | { operation: 'select'; input: number; key: KeyDraft[]; bound?: number | undefined }
  | { operation: 'group'; input: number; groupBy: { property: string; bucket?: Unit | undefined }[]; measures: MeasureDraft[]; bound?: number | undefined }
  | { operation: 'time_series'; input: number; property: string; unit: Unit; measures: MeasureDraft[]; bound?: number | undefined }
  | { operation: 'pivot'; input: number; rows: string; columns: string; measure: MeasureDraft; bound?: number | undefined }
  | { operation: 'compare'; inputs: [number, number]; measures: MeasureDraft[]; bound?: number | undefined };

export const SET_STEPS: readonly Operation[] = ['filter', 'traverse', 'derive', 'select'];
export const isSet = (step: StepDraft): boolean => SET_STEPS.includes(step.operation);
const NO_VALUE: readonly FilterOp[] = ['is_null', 'is_not_null'];

/** The typed steps and their values apart: every literal becomes a placeholder (p1, p2, …). */
export function requestOf(steps: readonly StepDraft[]): { steps: StepInput[]; parameters: Record<string, Scalar | Scalar[]> } {
  const parameters: Record<string, Scalar | Scalar[]> = {};
  const param = (value: Scalar | Scalar[]) => {
    const name = `p${Object.keys(parameters).length + 1}`;
    parameters[name] = value;
    return { param: name };
  };
  const filters = (list: readonly FilterDraft[]) => list.map((f) => (NO_VALUE.includes(f.op) || f.value === undefined
    ? { property: f.property, op: f.op } : { property: f.property, op: f.op, value: param(f.value) }));
  const measures = (list: readonly MeasureDraft[]) => list.map((m) => ({ fn: m.fn, as: m.as, ...(m.property !== undefined && m.fn !== 'count' ? { property: m.property } : {}) }));
  const bound = (b: number | undefined) => (b === undefined ? {} : { bound: b });
  const out = steps.map((s): StepInput => {
    switch (s.operation) {
      case 'filter': return { operation: 'filter', ...(s.base !== undefined ? { base: { objectTypeId: s.base } } : { input: s.input! }), filters: filters(s.filters), ...bound(s.bound) };
      case 'traverse': return { operation: 'traverse', input: s.input, linkTypeId: s.linkTypeId, filters: filters(s.filters), ...bound(s.bound) };
      case 'derive': return { operation: 'derive', input: s.input, properties: s.properties, ...bound(s.bound) };
      case 'select': return {
        operation: 'select', input: s.input,
        key: s.key.map((k) => ({ property: k.property, value: k.value === null ? null : param(k.value), ...(k.to !== undefined ? { to: param(k.to) } : {}) })), ...bound(s.bound),
      };
      case 'group': return { operation: 'group', input: s.input, groupBy: s.groupBy.map((g) => ({ property: g.property, ...(g.bucket !== undefined ? { bucket: g.bucket } : {}) })), measures: measures(s.measures), ...bound(s.bound) };
      case 'time_series': return { operation: 'time_series', input: s.input, property: s.property, unit: s.unit, measures: measures(s.measures), ...bound(s.bound) };
      case 'pivot': return { operation: 'pivot', input: s.input, rows: s.rows, columns: s.columns, measure: measures([s.measure])[0]!, ...bound(s.bound) };
      case 'compare': return { operation: 'compare', inputs: s.inputs, measures: measures(s.measures), ...bound(s.bound) };
    }
  });
  return { steps: out, parameters };
}

type Kept = { step: StepInput; bound: number };
type ParamRef = { param: string };
const valueOf = (ref: ParamRef | null | undefined, parameters: Record<string, unknown> | null): Scalar | Scalar[] | undefined =>
  ref === null || ref === undefined || parameters === null ? undefined : parameters[ref.param] as Scalar | Scalar[] | undefined;

/** A kept chain back as drafts, its values in place where the reader bound them (otherwise left empty). */
export function draftsOf(kept: readonly Kept[], parameters: Record<string, unknown> | null): StepDraft[] {
  const filters = (list: readonly { property: string; op: string; value?: ParamRef | undefined }[]) =>
    list.map((f) => ({ property: f.property, op: f.op as FilterOp, ...(f.value !== undefined ? { value: valueOf(f.value, parameters) ?? '' } : {}) }));
  return kept.map(({ step: s, bound }): StepDraft => {
    switch (s.operation) {
      case 'filter': return { operation: 'filter', input: s.input, base: s.base?.objectTypeId, filters: filters(s.filters ?? []), bound };
      case 'traverse': return { operation: 'traverse', input: s.input, linkTypeId: s.linkTypeId, filters: filters(s.filters ?? []), bound };
      case 'derive': return { operation: 'derive', input: s.input, properties: s.properties, bound };
      case 'select': return {
        operation: 'select', input: s.input, bound,
        key: s.key.map((k) => ({ property: k.property, value: k.value === null ? null : (valueOf(k.value, parameters) as Scalar | undefined) ?? '', to: valueOf(k.to, parameters) as Scalar | undefined })),
      };
      case 'group': return { operation: 'group', input: s.input, groupBy: (s.groupBy ?? []).map((g) => ({ property: g.property, bucket: g.bucket })), measures: s.measures, bound };
      case 'time_series': return { operation: 'time_series', input: s.input, property: s.property, unit: s.unit, measures: s.measures, bound };
      case 'pivot': return { operation: 'pivot', input: s.input, rows: s.rows, columns: s.columns, measure: s.measure, bound };
      case 'compare': return { operation: 'compare', inputs: s.inputs, measures: s.measures, bound };
    }
  });
}

/** The type of a set step's objects, or of the set a result step reads; undefined where a link or type is not visible. */
export function typeAt(steps: readonly StepDraft[], position: number, lookup: Lookup): string | undefined {
  const step = steps[position - 1];
  if (step === undefined) return undefined;
  switch (step.operation) {
    case 'filter': return step.base ?? (step.input !== undefined ? typeAt(steps, step.input, lookup) : undefined);
    case 'traverse': {
      const from = typeAt(steps, step.input, lookup);
      const link = lookup.links.get(step.linkTypeId);
      if (from === undefined || link === undefined) return undefined;
      return link.fromTypeId === from ? link.toTypeId : link.toTypeId === from ? link.fromTypeId : undefined;
    }
    case 'derive': return typeAt(steps, step.input, lookup);
    case 'select': {
      const grouped = steps[step.input - 1];
      return grouped !== undefined && 'input' in grouped && grouped.input !== undefined ? typeAt(steps, grouped.input, lookup) : undefined;
    }
    case 'compare': return typeAt(steps, step.inputs[0], lookup);
    default: return typeAt(steps, step.input, lookup);
  }
}

const OP_WORDS: Readonly<Record<FilterOp, string>> = {
  eq: 'is', ne: 'is not', lt: 'is below', lte: 'is at most', gt: 'is above', gte: 'is at least', in: 'is one of', contains: 'contains', starts_with: 'starts with',
  is_null: 'is empty', is_not_null: 'is not empty',
};
const FN_WORDS: Readonly<Record<MeasureFn, string>> = { count: 'number', sum: 'total', avg: 'average', min: 'lowest', max: 'highest', count_distinct: 'distinct' };
export const OPERATION_LABEL: Readonly<Record<Operation, string>> = {
  filter: 'Filter', traverse: 'Follow a link', derive: 'Add computed values', select: 'The objects behind a group', group: 'Group',
  time_series: 'Over time', pivot: 'Pivot', compare: 'Compare two sets',
};

const filterWords = (f: FilterDraft, lookup: Lookup) => `${lookup.propertyName(f.property).toLowerCase()} ${OP_WORDS[f.op]}${f.value === undefined ? '' : ` ${Array.isArray(f.value) ? f.value.join(', ') : String(f.value)}`}`;
const measureWords = (m: MeasureDraft, lookup: Lookup) => (m.fn === 'count' ? 'how many' : `${FN_WORDS[m.fn]} ${m.property !== undefined ? lookup.propertyName(m.property).toLowerCase() : ''}`.trim());

/** A step in words: "Suppliers whose region is north", "Their orders", "Total units by supplier". */
export function stepWords(steps: readonly StepDraft[], position: number, lookup: Lookup): string {
  const step = steps[position - 1]!;
  const typeId = typeAt(steps, position, lookup);
  const plural = typeId !== undefined ? lookup.typeName(typeId, true) : 'Objects';
  const where = (filters: readonly FilterDraft[]) => (filters.length === 0 ? '' : ` whose ${filters.map((f) => filterWords(f, lookup)).join(' and ')}`);
  switch (step.operation) {
    case 'filter': return step.base !== undefined ? `${plural}${where(step.filters)}` : `Step ${step.input}, narrowed to those${where(step.filters)}`;
    case 'traverse': return `The ${plural.toLowerCase()} of step ${step.input}${where(step.filters)}`;
    case 'derive': return `Step ${step.input} with ${step.properties.map((p) => lookup.propertyName(p).toLowerCase()).join(', ')}`;
    case 'select': return `The ${plural.toLowerCase()} behind ${step.key.map((k) => `${lookup.propertyName(k.property).toLowerCase()} ${k.value === null ? 'empty' : String(k.value)}`).join(', ')} in step ${step.input}`;
    case 'group': return `${step.measures.map((m) => measureWords(m, lookup)).join(', ')} of step ${step.input}${step.groupBy.length > 0 ? ` by ${step.groupBy.map((g) => `${lookup.propertyName(g.property).toLowerCase()}${g.bucket !== undefined ? ` (${g.bucket.replace('_', ' ')})` : ''}`).join(', ')}` : ''}`;
    case 'time_series': return `${step.measures.map((m) => measureWords(m, lookup)).join(', ')} of step ${step.input} by ${step.unit.replace('_', ' ')} of ${lookup.propertyName(step.property).toLowerCase()}`;
    case 'pivot': return `${measureWords(step.measure, lookup)} of step ${step.input} by ${lookup.propertyName(step.rows).toLowerCase()} and ${lookup.propertyName(step.columns).toLowerCase()}`;
    case 'compare': return `${step.measures.map((m) => measureWords(m, lookup)).join(', ')}: step ${step.inputs[0]} against step ${step.inputs[1]}`;
  }
}

/** The last step that makes a set, where a new step starts by default. */
export const lastSet = (steps: readonly StepDraft[]): number | undefined => {
  for (let i = steps.length; i >= 1; i -= 1) if (isSet(steps[i - 1]!)) return i;
  return undefined;
};
