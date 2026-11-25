// Plans Explorer runs (spec 34.1): a type's objects under the person's filters, a facet's
// values with counts, a number facet's range; and the same filters as the CEL predicate a
// saved object set keeps. Values travel as plan parameters, never in the plan itself; a saved
// set's predicate is its definition, as the person wrote it.

import type { Input } from '../api/client.api.ts';
import type { ObjectType, Property } from '../hooks/vocabulary.hook.ts';

type Plan = Input<'runStructuredPlan'>['body']['plan'];
type Parameters = NonNullable<Input<'runStructuredPlan'>['body']['parameters']>;
type Scalar = string | number | boolean;

export type Filter =
  | { property: string; op: 'in'; values: Scalar[] }
  | { property: string; op: 'eq' | 'gte' | 'lte' | 'lt' | 'gt' | 'contains' | 'starts_with'; value: Scalar }
  | { property: string; op: 'is_null' | 'is_not_null' };

export interface Sort { property: string; direction: 'asc' | 'desc' }

const SHOWN_TYPES = new Set(['string', 'integer', 'decimal', 'boolean', 'date', 'timestamp', 'duration', 'money', 'enum']);
export const NUMERIC = new Set(['integer', 'decimal', 'money', 'duration']);
export const TEMPORAL = new Set(['date', 'timestamp']);
export const LISTED = new Set(['string', 'enum', 'boolean']);

/** The properties a table shows: the title first, then the others in order, up to eight in all. */
export function columnsOf(type: ObjectType): Property[] {
  const shown = type.properties.filter((p) => SHOWN_TYPES.has(p.dataType));
  const title = shown.find((p) => p.identityId === type.titleProperty);
  return [...(title === undefined ? [] : [title]), ...shown.filter((p) => p !== title)].slice(0, 8);
}

/** Properties a facet is offered for: read plainly (never masked or redacted, spec 34.1) and of a kind facets show. */
export const facetable = (type: ObjectType): Property[] =>
  type.properties.filter((p) => p.effect === 'allow' && (LISTED.has(p.dataType) || NUMERIC.has(p.dataType) || TEMPORAL.has(p.dataType)));

/** The node's filters, each value a parameter. */
function filtersOf(filters: readonly Filter[], parameters: Parameters) {
  return filters.map((f) => {
    if (f.op === 'is_null' || f.op === 'is_not_null') return { property: f.property, op: f.op };
    const param = `p${Object.keys(parameters).length + 1}`;
    parameters[param] = f.op === 'in' ? f.values : (f as { value: Scalar }).value;
    return { property: f.property, op: f.op, value: { param } };
  });
}

/** The type's objects under the filters, shown by the given columns. */
export function objectsPlan(ontologyVersionId: string, type: ObjectType, filters: readonly Filter[], sort: Sort | undefined): { plan: Plan; parameters: Parameters } {
  const parameters: Parameters = {};
  return {
    plan: {
      schemaVersion: '1', ontologyVersionId,
      nodes: [{ objectTypeId: type.id, filters: filtersOf(filters, parameters) }],
      select: columnsOf(type).map((p) => ({ node: 0, property: p.identityId })),
      ...(sort === undefined ? {} : { sort: [{ property: sort.property, direction: sort.direction }] }),
    },
    parameters,
  };
}

/** A listed facet's values with their counts, the most frequent first, under the other filters. */
export function valuesPlan(ontologyVersionId: string, type: ObjectType, property: string, others: readonly Filter[]): { plan: Plan; parameters: Parameters } {
  const parameters: Parameters = {};
  return {
    plan: {
      schemaVersion: '1', ontologyVersionId,
      nodes: [{ objectTypeId: type.id, filters: filtersOf(others, parameters) }],
      aggregate: { groupBy: [{ node: 0, property }], measures: [{ fn: 'count', node: 0, as: 'n' }] },
      sort: [{ measure: 'n', direction: 'desc' }],
      limit: 20,
    },
    parameters,
  };
}

/** A number or date facet's range, under the other filters. */
export function rangePlan(ontologyVersionId: string, type: ObjectType, property: string, others: readonly Filter[]): { plan: Plan; parameters: Parameters } {
  const parameters: Parameters = {};
  return {
    plan: {
      schemaVersion: '1', ontologyVersionId,
      nodes: [{ objectTypeId: type.id, filters: filtersOf(others, parameters) }],
      aggregate: { measures: [{ fn: 'min', node: 0, property, as: 'low' }, { fn: 'max', node: 0, property, as: 'high' }, { fn: 'count', node: 0, as: 'n' }] },
    },
    parameters,
  };
}

/** A value as a CEL literal: strings and timestamps quoted (JSON's escapes are CEL's), numbers and booleans as they are. */
const literal = (value: Scalar): string => (typeof value === 'string' ? JSON.stringify(value) : String(value));

/**
 * The filters as a saved object set's predicate (CEL over `object`, spec 24.4), with the
 * property identities it reads. Moments compare as their ISO text, as the engine holds them.
 */
export function predicateOf(type: ObjectType, filters: readonly Filter[]): { cel: string; properties: string[] } {
  const name = (id: string) => type.properties.find((p) => p.identityId === id)!.apiName;
  const terms = filters.map((f) => {
    const field = `object.${name(f.property)}`;
    switch (f.op) {
      case 'in': return `${field} in [${f.values.map(literal).join(', ')}]`;
      case 'eq': return `${field} == ${literal(f.value)}`;
      case 'gte': return `${field} >= ${literal(f.value)}`;
      case 'gt': return `${field} > ${literal(f.value)}`;
      case 'lte': return `${field} <= ${literal(f.value)}`;
      case 'lt': return `${field} < ${literal(f.value)}`;
      case 'contains': return `${field}.contains(${literal(f.value)})`;
      case 'starts_with': return `${field}.startsWith(${literal(f.value)})`;
      case 'is_null': return `${field} == null`;
      case 'is_not_null': return `${field} != null`;
    }
  });
  return { cel: terms.length === 0 ? 'true' : terms.join(' && '), properties: [...new Set(filters.map((f) => f.property))] };
}

/** Filters kept in the address, so a result can be linked to and reopened. */
export const filtersToParam = (filters: readonly Filter[]): string => JSON.stringify(filters);
export function filtersFromParam(text: string | null): Filter[] {
  if (text === null || text === '') return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((f): f is Filter => typeof f === 'object' && f !== null && typeof (f as Filter).property === 'string') : [];
  } catch {
    return [];
  }
}
