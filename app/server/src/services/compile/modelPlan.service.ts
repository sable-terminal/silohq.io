// What the model returns, and how it becomes a plan (spec 26.4, 26.5, 26.9).
//
// The model speaks in the vocabulary's names; it never sees an id. Its output is one of a
// plan in names, a clarification among names it was given, or a statement that the
// question cannot be answered from the vocabulary. Compile then applies referential truth:
// every name must be in the reader's vocabulary, on the right type, used as its type allows.
// A name nobody offered is refused by name and never repaired. The question's literal
// values become parameters, so the plan itself holds placeholders only.
//
// Clarification is first-class (26.9): a term two types could match, a period on a type
// with several time fields and no default, a link with several routes and no default.
//
// Where the caller allows it (Ask, 42.9), the model may instead return an intent: a change
// the question asks for (set or clear properties, create a record, delete records), in the
// vocabulary's names, with the values written in the question and filters naming the
// records. Compile checks it against the reader's vocabulary as it checks a plan; the
// records it changes become a plan that finds them.

import { z } from 'zod';
import { FILTER_OPS } from '../../contracts/connect/manifest.contract.ts';
import {
  CALENDAR_UNITS, MEASURE_FUNCTIONS, PLAN_SCHEMA_VERSION, queryPlan, TO_DATE_UNITS, TRAILING_UNITS,
  type Clarification, type PlanParameters, type QueryPlan, type QueryPlanInput, type Refusal,
} from '../../contracts/planner/plan.contract.ts';
import type { PropertyAccess, ReaderAccess, TypeAccess } from '../planner/access.service.ts';
import { interfaceRoots, routeName } from './vocabulary.service.ts';
import { modelScheduleSchema, translateSchedule, type TranslatedSchedule } from './schedule.service.ts';

const literal = z.union([z.string().max(1_000), z.number(), z.boolean()]);
const modelFilter = z.object({
  property: z.string().max(200),
  op: z.enum(FILTER_OPS),
  value: z.union([literal, z.array(literal).max(200)]).optional(),
});
const modelExpression = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('calendar'), unit: z.enum(CALENDAR_UNITS), offset: z.int().min(-120).max(120) }),
  z.object({ kind: z.literal('trailing'), unit: z.enum(TRAILING_UNITS), count: z.int().min(1).max(3_660) }),
  z.object({ kind: z.literal('to_date'), unit: z.enum(TO_DATE_UNITS) }),
  z.object({ kind: z.literal('between'), from: z.string().max(40), to: z.string().max(40) }),
]);
const modelPeriod = z.object({
  /** A time field's name; absent to use the type's default time field. */
  property: z.string().max(200).optional(),
  /** The asker's words for the period. */
  asWritten: z.string().max(200),
  expression: modelExpression,
});
const nodeRef = z.object({ node: z.int().min(0).max(7), property: z.string().max(200) });

export const modelPlanSchema = z.object({
  nodes: z.array(z.object({
    objectType: z.string().max(200),
    filters: z.array(modelFilter).max(20).optional(),
    period: modelPeriod.optional(),
  })).min(1).max(8),
  hops: z.array(z.object({ from: z.int().min(0).max(7), to: z.int().min(1).max(7), link: z.string().max(200), route: z.string().max(200).optional() })).max(7).optional(),
  select: z.array(nodeRef).max(100).optional(),
  aggregate: z.object({
    groupBy: z.array(nodeRef).max(5).optional(),
    measures: z.array(z.object({ fn: z.enum(MEASURE_FUNCTIONS), node: z.int().min(0).max(7), property: z.string().max(200).optional(), as: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/) })).min(1).max(20),
  }).optional(),
  sort: z.array(z.object({ property: z.string().max(200).optional(), measure: z.string().max(63).optional(), direction: z.enum(['asc', 'desc']) })).max(5).optional(),
  limit: z.int().min(1).max(100_000).optional(),
  /** How the root stood at a past moment (69.6): a date (YYYY-MM-DD) or a date and time with its offset, and the asker's words. */
  asOf: z.object({ at: z.string().max(40), asWritten: z.string().max(200) }).optional(),
  /** How the selected root properties changed over a period (69.16), and the asker's words. */
  history: z.object({ expression: modelExpression, asWritten: z.string().max(200) }).optional(),
});

export const UNANSWERABLE = ['outside_vocabulary', 'needs_values', 'cross_system_ordering', 'not_a_question'] as const;

/** A change the question asks for (42.9), in the vocabulary's names. */
export const modelIntentSchema = z.object({
  objectType: z.string().max(200),
  operation: z.enum(['update', 'create', 'delete']),
  /** The properties to set (update) or give (create), each with the value written in the question. */
  set: z.array(z.object({ property: z.string().max(200), value: literal })).max(50).optional(),
  /** The properties to clear (update). */
  clear: z.array(z.string().max(200)).max(50).optional(),
  /** Which records an update or delete changes. */
  filters: z.array(modelFilter).max(20).optional(),
});

const outcomes = [
  z.object({ outcome: z.literal('plan'), plan: modelPlanSchema }),
  z.object({ outcome: z.literal('clarification'), about: z.enum(['object_type', 'property']), options: z.array(z.string().max(200)).min(2).max(10) }),
  z.object({ outcome: z.literal('unanswerable'), reason: z.enum(UNANSWERABLE) }),
] as const;
export const modelOutputSchema = z.discriminatedUnion('outcome', [...outcomes]);
/** Where the caller allows a change to be asked for (Ask, 42.9). */
export const modelOutputWithIntentSchema = z.discriminatedUnion('outcome', [
  ...outcomes, z.object({ outcome: z.literal('intent'), intent: modelIntentSchema }),
  /** A Cron asked for (36.4, 40): how often and when, in words; compile writes the schedule. */
  z.object({ outcome: z.literal('schedule'), schedule: modelScheduleSchema }),
]);
export type ModelOutput = z.infer<typeof modelOutputWithIntentSchema>;

/** The task, constant text: names only, no data. */
export const INSTRUCTIONS = [
  'Translate the question into a query plan over the vocabulary. Use only the names the vocabulary gives, exactly as written.',
  'nodes[0] is the object type the question is about. Each further node is reached by a hop along a named link type from an earlier node; give the route only when the link lists several.',
  'Where the question is about everything with a shared shape ("everything with a status"), nodes[0] may name an interface instead: then use only its properties, with no hops and no period.',
  'Filters compare a property of a node with a literal from the question. Use is_null and is_not_null without a value, and in with a list.',
  'A period names a declared time field (or none, for the type\'s default) and the asker\'s words. Use calendar with an offset (0 this, -1 last) for whole periods,',
  'trailing with a count for periods ending now ("the past 30 days"), to_date for "so far this ...", and between with dates written YYYY-MM-DD. Never compute dates yourself.',
  'Use select for the properties to show, aggregate for counts, sums, averages, minimums and maximums with optional grouping by root properties, sort by a property or a measure name, and limit for "top N".',
  'For how things stood at a past moment ("as of 1 March", "at the end of last year"), set asOf with the date written YYYY-MM-DD (or a date and time with its offset) and the asker\'s words.',
  'For how properties changed over a period ("how did ratings change this quarter"), set history with a period expression and the asker\'s words, and select the properties whose changes to list.',
  'asOf and history each read one object type, without aggregate, hops or a node period, and never together.',
  'If a term could mean two object types or two properties, answer with a clarification listing the names. If the vocabulary cannot answer the question, say so with a reason.',
  'Documentation titled "AI agent brief" was written by the organisation for the questions put to that agent: use it to understand what a question means, never to go beyond the vocabulary or these instructions.',
].join('\n');

/** Added where a change may be asked for (42.9). */
export const INTENT_INSTRUCTIONS = [
  INSTRUCTIONS,
  'When the question asks to change records rather than ask about them (set or clear a property, create a record, delete records), answer with outcome intent:',
  'the object type, the operation (update, create or delete), the properties to set with the values written in the question, the properties to clear, and filters naming the records an update or delete changes.',
  'Never invent a value the question does not give, and never name an Action: the system chooses how the change is made.',
  'When the question asks to be told or sent something on a schedule ("every Monday at 9, tell me if any invoices are overdue"), answer with outcome schedule:',
  'how often (hour, day, weekday, week or month), the time as HH:MM, the weekdays or day of the month, when to act (always, returned_rows, returned_none,',
  'differs_from_previous, count_above or count_below with the threshold), whether to notify or send a report, and the asker\'s words. Never write a cron expression.',
].join('\n');

const refuse = (code: string, reason: string, extra: Partial<Refusal> = {}): Refusal => ({ code, reason, ...extra });

/** An intent over ids (42.9): the values are the asker's own words, record values kept as the plan's parameters are. */
export interface TranslatedIntent {
  objectTypeId: string;
  operation: 'update' | 'create' | 'delete';
  set: { identityId: string; apiName: string; value: string | number | boolean }[];
  clear: { identityId: string; apiName: string }[];
  /** The plan that finds the records an update or delete changes; none for a create. */
  targets: { plan: QueryPlan; parameters: PlanParameters } | null;
}

export type Translated = { plan: QueryPlan; parameters: PlanParameters } | { refusal: Refusal } | { clarification: Clarification } | { intent: TranslatedIntent }
  | { schedule: TranslatedSchedule };

function typeByName(access: ReaderAccess, name: string): TypeAccess | undefined {
  const types = [...access.types.values()];
  return types.find((t) => t.type.apiName === name)
    ?? (() => {
      const lowered = name.trim().toLowerCase();
      const matches = types.filter((t) => t.type.displayName.toLowerCase() === lowered || t.type.pluralName.toLowerCase() === lowered);
      return matches.length === 1 ? matches[0] : undefined;
    })();
}

function propertyByName(type: TypeAccess, name: string): PropertyAccess | undefined {
  const props = [...type.properties.values()];
  return props.find((p) => p.property.apiName === name)
    ?? (() => {
      const lowered = name.trim().toLowerCase();
      const matches = props.filter((p) => p.property.displayName.toLowerCase() === lowered);
      return matches.length === 1 ? matches[0] : undefined;
    })();
}

/** A clarification answered: the element chosen (a time field or route is chosen here; types and properties narrow the vocabulary). */
export interface Chosen { about: 'object_type' | 'time_field' | 'route' | 'property'; elementId: string }

/** Turns the model's output into a plan over ids, or a clarification, or a refusal. */
export function translate(output: ModelOutput, access: ReaderAccess, chosen?: Chosen): Translated {
  if (output.outcome === 'intent') return translateIntent(output.intent, access, chosen);
  if (output.outcome === 'schedule') {
    const translated = translateSchedule(output.schedule);
    return 'code' in translated ? { refusal: translated } : { schedule: translated };
  }
  if (output.outcome === 'unanswerable') {
    const reasons: Record<(typeof UNANSWERABLE)[number], string> = {
      outside_vocabulary: 'the question asks about something that is not in the ontology available to you',
      needs_values: 'the question needs values the system is never told; ask it with the names of what you mean',
      cross_system_ordering: 'which happened first across two systems is not determined: each system keeps its own clock (spec 27.11)',
      not_a_question: 'that is not a question about your data',
    };
    return { refusal: refuse(`compile.${output.reason}`, reasons[output.reason]) };
  }
  if (output.outcome === 'clarification') {
    const options: { id: string; name: string }[] = [];
    if (output.about === 'object_type') {
      for (const name of output.options) {
        const t = typeByName(access, name);
        if (t !== undefined && !options.some((o) => o.id === t.type.id)) options.push({ id: t.type.id, name: t.type.displayName });
      }
    } else {
      for (const t of access.types.values()) {
        for (const name of output.options) {
          const p = propertyByName(t, name);
          if (p !== undefined && !options.some((o) => o.id === p.property.identityId)) options.push({ id: p.property.identityId, name: `${t.type.displayName} ${p.property.displayName}` });
        }
      }
    }
    if (options.length < 2) return { refusal: refuse('compile.could_not_compile', 'the question could not be compiled into a plan') };
    return { clarification: { about: output.about, question: 'Which did you mean?', options: options.slice(0, 20) } };
  }

  const m = output.plan;
  const parameters: PlanParameters = {};
  let next = 1;
  const param = (value: z.infer<typeof literal> | z.infer<typeof literal>[]) => {
    const name = `p${next}`;
    next += 1;
    parameters[name] = value;
    return { param: name };
  };

  const nodes: TypeAccess[] = [];
  // The root may be an interface (21.9), standing alone: its properties are its shared properties.
  const iface = m.nodes.length === 1 && typeByName(access, m.nodes[0]!.objectType) === undefined
    ? interfaceRoots(access).find((i) => i.type.type.apiName === m.nodes[0]!.objectType)?.type : undefined;
  if (iface !== undefined) {
    if ((m.hops ?? []).length > 0 || m.nodes[0]!.period !== undefined || m.asOf !== undefined || m.history !== undefined) {
      return { refusal: refuse('compile.interface_plan', `a question over ${iface.type.displayName} reads its shared properties only: no links, period, as-of or history`, { element: { kind: 'interface', id: iface.type.id, name: iface.type.apiName } }) };
    }
    nodes.push(iface);
  }
  for (const n of iface === undefined ? m.nodes : []) {
    const t = typeByName(access, n.objectType);
    if (t === undefined) return { refusal: refuse('compile.object_type_unknown', `there is no object type called ${n.objectType.slice(0, 100)} available to you`, { element: { kind: 'object_type', name: n.objectType.slice(0, 200) } }) };
    nodes.push(t);
  }
  const prop = (node: number, name: string): PropertyAccess | Refusal => {
    const t = nodes[node];
    if (t === undefined) return refuse('compile.plan_invalid', 'the plan names a node it does not have', { element: { kind: 'plan' } });
    return propertyByName(t, name)
      ?? refuse('compile.property_unknown', `${t.type.displayName} has no property called ${name.slice(0, 100)}`, { element: { kind: 'property', name: name.slice(0, 200) } });
  };
  const isRefusal = (v: unknown): v is Refusal => typeof v === 'object' && v !== null && 'code' in v && 'reason' in v;

  const planNodes: QueryPlanInput['nodes'] = [];
  for (const [i, n] of m.nodes.entries()) {
    const filters = [];
    for (const f of n.filters ?? []) {
      const p = prop(i, f.property);
      if (isRefusal(p)) return { refusal: p };
      const needsValue = f.op !== 'is_null' && f.op !== 'is_not_null';
      if (needsValue && f.value === undefined) return { refusal: refuse('compile.filter_value_missing', `a filter on ${p.property.apiName} has no value`, { element: { kind: 'property', id: p.property.identityId, name: p.property.apiName } }) };
      filters.push({ property: p.property.identityId, op: f.op, ...(needsValue ? { value: param(f.value!) } : {}) });
    }
    let period: QueryPlanInput['nodes'][number]['period'];
    if (n.period !== undefined) {
      const t = nodes[i]!;
      const visibleTimes = t.type.timeFields.filter((f) => t.properties.has(f.propertyIdentityId));
      let fieldId: string | undefined;
      if (n.period.property !== undefined) {
        const p = prop(i, n.period.property);
        if (isRefusal(p)) return { refusal: p };
        if (!visibleTimes.some((f) => f.propertyIdentityId === p.property.identityId)) {
          return { refusal: refuse('compile.period_field', `${p.property.apiName} is not a declared time field of ${t.type.displayName}`, { element: { kind: 'time_field', id: p.property.identityId, name: p.property.apiName } }) };
        }
        fieldId = p.property.identityId;
      } else {
        const fallback = (chosen?.about === 'time_field' ? visibleTimes.find((f) => f.propertyIdentityId === chosen.elementId) : undefined)
          ?? visibleTimes.find((f) => f.isDefault) ?? (visibleTimes.length === 1 ? visibleTimes[0] : undefined);
        if (fallback === undefined && visibleTimes.length > 1) {
          return {
            clarification: {
              about: 'time_field', question: `${t.type.displayName} has several dates. Which one should the period apply to?`,
              options: visibleTimes.map((f) => ({ id: f.propertyIdentityId, name: t.properties.get(f.propertyIdentityId)!.property.displayName })),
            },
          };
        }
        if (fallback === undefined) {
          return { refusal: refuse('compile.no_time_field', `${t.type.displayName} declares no time field a period could apply to`, { element: { kind: 'object_type', id: t.type.id, name: t.type.apiName } }) };
        }
        fieldId = fallback.propertyIdentityId;
      }
      const e = n.period.expression;
      period = {
        property: fieldId, asWritten: n.period.asWritten.trim() || 'the period',
        expression: e.kind === 'between' ? { kind: 'between', from: param(e.from), to: param(e.to) } : e,
      };
    }
    planNodes.push({ ...(iface === undefined ? { objectTypeId: nodes[i]!.type.id } : { interfaceId: iface.type.id }), filters, ...(period === undefined ? {} : { period }) });
  }

  const hops: QueryPlanInput['hops'] = [];
  for (const h of m.hops ?? []) {
    const from = nodes[h.from];
    const to = nodes[h.to];
    if (from === undefined || to === undefined) return { refusal: refuse('compile.plan_invalid', 'the plan joins a node it does not have', { element: { kind: 'plan' } }) };
    const link = [...access.links.values()].find((l) => l.link.apiName === h.link
      && ((l.link.fromTypeId === from.type.id && l.link.toTypeId === to.type.id) || (l.link.fromTypeId === to.type.id && l.link.toTypeId === from.type.id)));
    if (link === undefined) return { refusal: refuse('compile.link_type_unknown', `there is no link called ${h.link.slice(0, 100)} between ${from.type.displayName} and ${to.type.displayName} available to you`, { element: { kind: 'link_type', name: h.link.slice(0, 200) } }) };
    let route = h.route === undefined ? undefined : link.routes.find((r) => routeName(r.position) === h.route);
    if (h.route !== undefined && route === undefined) return { refusal: refuse('compile.route_unknown', `${link.link.apiName} has no route called ${h.route.slice(0, 50)}`, { element: { kind: 'route', name: h.route.slice(0, 200) } }) };
    route ??= (chosen?.about === 'route' ? link.routes.find((r) => r.id === chosen.elementId) : undefined)
      ?? (link.routes.length === 1 ? link.routes[0] : link.routes.find((r) => r.id === link.link.defaultRouteId));
    if (route === undefined) {
      return {
        clarification: {
          about: 'route', question: `${link.link.forwardName} can be followed more than one way. Which route did you mean?`,
          options: link.routes.map((r) => ({ id: r.id, name: `${link.link.apiName} ${routeName(r.position)}` })),
        },
      };
    }
    hops.push({ from: h.from, to: h.to, linkTypeId: link.link.id, routeId: route.id });
  }

  const select = [];
  for (const s of m.select ?? []) {
    const p = prop(s.node, s.property);
    if (isRefusal(p)) return { refusal: p };
    select.push({ node: s.node, property: p.property.identityId });
  }
  let aggregate: QueryPlanInput['aggregate'];
  if (m.aggregate !== undefined) {
    const groupBy = [];
    for (const g of m.aggregate.groupBy ?? []) {
      const p = prop(g.node, g.property);
      if (isRefusal(p)) return { refusal: p };
      groupBy.push({ node: g.node, property: p.property.identityId });
    }
    const measures = [];
    for (const ms of m.aggregate.measures) {
      let property: string | undefined;
      if (ms.property !== undefined) {
        const p = prop(ms.node, ms.property);
        if (isRefusal(p)) return { refusal: p };
        property = p.property.identityId;
      }
      measures.push({ fn: ms.fn, node: ms.node, as: ms.as, ...(property === undefined ? {} : { property }) });
    }
    aggregate = { groupBy, measures };
  }
  const sort = [];
  for (const s of m.sort ?? []) {
    if (s.property !== undefined) {
      const p = prop(0, s.property);
      if (isRefusal(p)) return { refusal: p };
      sort.push({ property: p.property.identityId, direction: s.direction });
    } else if (s.measure !== undefined) {
      sort.push({ measure: s.measure, direction: s.direction });
    }
  }

  // As of a moment (69.6) or over a period (69.16): the moment, or a between's ends, are parameters, never in the plan.
  const asOf = m.asOf === undefined ? undefined : { at: param(m.asOf.at), asWritten: m.asOf.asWritten.trim() || 'then' };
  const history = m.history === undefined ? undefined : {
    asWritten: m.history.asWritten.trim() || 'the period',
    expression: m.history.expression.kind === 'between'
      ? { kind: 'between' as const, from: param(m.history.expression.from), to: param(m.history.expression.to) } : m.history.expression,
  };
  const parsed = queryPlan.safeParse({
    schemaVersion: PLAN_SCHEMA_VERSION, ontologyVersionId: access.manifest.version.id, nodes: planNodes, hops, select,
    ...(aggregate === undefined ? {} : { aggregate }), sort, ...(m.limit === undefined ? {} : { limit: m.limit }),
    ...(asOf === undefined ? {} : { asOf }), ...(history === undefined ? {} : { history }),
  });
  if (!parsed.success) {
    return { refusal: refuse('compile.plan_invalid', 'the question compiled to a plan that does not hold together, and it is refused rather than repaired', { element: { kind: 'plan' } }) };
  }
  return { plan: parsed.data, parameters };
}

/** A stored plan in names, with its placeholders, for an Ask thread's later turn (spec 26.4). */
export function planInNames(plan: QueryPlan, access: ReaderAccess): string | undefined {
  // An interface node is named by its interface, its properties by their shared properties (21.9).
  const typeName = (n: QueryPlan['nodes'][number]) => (n.objectTypeId !== undefined ? access.types.get(n.objectTypeId)?.type.apiName
    : access.interfaces.has(n.interfaceId!) ? access.manifest.interfaces.find((i) => i.id === n.interfaceId)?.apiName : undefined);
  const propName = (node: number, id: string) => {
    const n = plan.nodes[node];
    if (n?.interfaceId !== undefined) return access.manifest.sharedProperties.find((s) => s.id === id)?.apiName;
    return access.types.get(n?.objectTypeId ?? '')?.properties.get(id)?.property.apiName;
  };
  const nodes = plan.nodes.map((n, i) => ({
    objectType: typeName(n),
    filters: n.filters.map((f) => ({ property: propName(i, f.property), op: f.op })),
    ...(n.period ? { period: { property: propName(i, n.period.property), asWritten: n.period.asWritten, expression: n.period.expression.kind } } : {}),
  }));
  if (nodes.some((n) => n.objectType === undefined)) return undefined;
  return JSON.stringify({
    nodes, select: plan.select.map((s) => propName(s.node, s.property)), hops: plan.hops.length,
    ...(plan.asOf === undefined ? {} : { asOf: { asWritten: plan.asOf.asWritten } }),
    ...(plan.history === undefined ? {} : { history: { asWritten: plan.history.asWritten, expression: plan.history.expression.kind } }),
  }).slice(0, 20_000);
}

/**
 * An intent in names to one over ids (42.9), with referential truth as for a plan: every name
 * in the reader's vocabulary, every property one they may see in clear and that is stored,
 * not computed. The records an update or delete changes become a plan that finds them.
 */
function translateIntent(intent: z.infer<typeof modelIntentSchema>, access: ReaderAccess, chosen?: Chosen): Translated {
  const type = typeByName(access, intent.objectType);
  if (type === undefined) return { refusal: refuse('compile.unknown_object_type', `${intent.objectType} is not an object type available to you`) };
  const writable = (name: string): PropertyAccess | Refusal => {
    const p = propertyByName(type, name);
    if (p === undefined) return refuse('compile.unknown_property', `${name} is not a property of ${type.type.displayName} available to you`);
    if (p.computed !== undefined) return refuse('compile.property_computed', `${p.property.displayName} is computed and cannot be changed`);
    if (p.effect !== 'allow') return refuse('compile.property_not_writable', `${p.property.displayName} is not shown to you in clear, so you cannot change it`);
    return p;
  };
  const set: TranslatedIntent['set'] = [];
  for (const s of intent.set ?? []) {
    const p = writable(s.property);
    if ('code' in p) return { refusal: p };
    if (set.some((x) => x.identityId === p.property.identityId)) return { refusal: refuse('compile.property_twice', `${p.property.displayName} is set twice`) };
    set.push({ identityId: p.property.identityId, apiName: p.property.apiName, value: s.value });
  }
  const clear: TranslatedIntent['clear'] = [];
  for (const name of intent.clear ?? []) {
    const p = writable(name);
    if ('code' in p) return { refusal: p };
    if (set.some((x) => x.identityId === p.property.identityId)) return { refusal: refuse('compile.property_twice', `${p.property.displayName} is either set or cleared`) };
    clear.push({ identityId: p.property.identityId, apiName: p.property.apiName });
  }
  const changes = set.length + clear.length;
  if (intent.operation === 'update' && changes === 0) return { refusal: refuse('compile.intent_empty', 'say what the change sets or clears') };
  if (intent.operation === 'create' && (set.length === 0 || clear.length > 0)) return { refusal: refuse('compile.intent_empty', 'say what the new record holds') };
  if (intent.operation === 'delete' && changes > 0) return { refusal: refuse('compile.intent_invalid', 'a delete changes no property') };
  if (intent.operation === 'create') return { intent: { objectTypeId: type.type.id, operation: 'create', set, clear, targets: null } };
  if ((intent.filters ?? []).length === 0) return { refusal: refuse('compile.intent_unbounded', 'say which records the change is to', { remedy: 'name the records, for example by a property\'s value' }) };

  // The records, as a plan over their title (or first) property: the person sees which, and the Action form is pre-filled with them.
  const shown = type.properties.get(type.type.titlePropertyIdentityId) ?? [...type.properties.values()][0];
  if (shown === undefined) return { refusal: refuse('compile.unknown_property', `no property of ${type.type.displayName} is available to you`) };
  const found = translate({
    outcome: 'plan', plan: { nodes: [{ objectType: type.type.apiName, filters: intent.filters }], select: [{ node: 0, property: shown.property.apiName }] },
  }, access, chosen);
  if (!('plan' in found)) return found;
  return { intent: { objectTypeId: type.type.id, operation: intent.operation, set, clear, targets: found } };
}
