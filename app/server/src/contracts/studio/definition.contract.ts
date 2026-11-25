// A Studio app definition (spec 35.2): data, not code. One JSON document of pages on a
// 12-column grid, widgets from a closed catalogue, variables that hold definitions and
// references (never values), events with a closed set of effects, and the ontology
// Functions and Action types the app may use. Executed by one generic runtime under the
// viewer's permissions.
//
// Every reference is an id, as in plans and the manifest: object types, property
// identities, link types and functions of the bound ontology version (ontologyVersion is
// main's sequence), Action types by id. This schema is the shape; the validator
// (services/studio/validator.service.ts) checks references, kinds, the grid and the event
// graph, and refuses rather than repairs.
//
// There is no code widget, script, iframe or user JavaScript (35.4): logic is an ontology
// Function, and inline logic only a CEL predicate on an event condition or a visibility
// rule, over the app's variables.

import { z } from 'zod';
import { ARCHETYPES, CANVAS_LAYOUTS } from '../canvas-layout/layout.contract.ts';

export const APP_SCHEMA_VERSION = '1';

const id = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'lower snake case, at most 40 characters');
const variableName = z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/, 'a variable name: letters, digits, underscores');
const cel = z.string().trim().min(1).max(2_000);
const ids = (max: number) => z.array(z.uuid()).max(max);

/** Column, row, column span, row span on the 12-column grid; no absolute positioning (35.2). */
export const gridPlacement = z.tuple([z.int().min(1).max(12), z.int().min(1).max(200), z.int().min(1).max(12), z.int().min(1).max(50)]);

export const variable = z.discriminatedUnion('kind', [
  /** A definition of type, filter and traversal: members are never stored (35.2). */
  z.strictObject({
    kind: z.literal('objectSet'),
    objectTypeId: z.uuid(),
    /** CEL over `object` and parameters, declaring the property identities it reads. */
    filter: z.strictObject({ cel, properties: ids(50) }).optional(),
    traversal: z.array(z.strictObject({ linkTypeId: z.uuid(), direction: z.enum(['forward', 'reverse']) })).max(5).optional(),
  }),
  /** Object references a widget emits. */
  z.strictObject({ kind: z.literal('selection'), objectTypeId: z.uuid() }),
  /** A typed scalar. */
  z.strictObject({
    kind: z.literal('parameter'),
    type: z.enum(['text', 'number', 'date', 'period', 'boolean', 'enumeration']),
    options: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  }),
  /** A scenario branch reference. */
  z.strictObject({ kind: z.literal('scenario') }),
]);
export type AppVariable = z.infer<typeof variable>;

const base = { id, grid: gridPlacement, visibleWhen: cel.optional() };
const emits = z.strictObject({ selectionChanged: variableName }).partial().optional();

export const WIDGET_KINDS = [
  'objectTable', 'objectList', 'propertyList', 'objectViewEmbed', 'canvasEmbed', 'chart', 'metric', 'filterControls', 'actionForm',
  'actionButton', 'askPanel', 'approvalInbox', 'scenarioControl', 'map', 'timeline', 'markdown',
] as const;

export const widget = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('objectTable'), source: variableName, columns: ids(30).min(1), emits }),
  z.strictObject({ ...base, kind: z.literal('objectList'), source: variableName, properties: ids(4), emits }),
  z.strictObject({ ...base, kind: z.literal('propertyList'), source: variableName, properties: ids(50).min(1) }),
  z.strictObject({ ...base, kind: z.literal('objectViewEmbed'), source: variableName }),
  z.strictObject({ ...base, kind: z.literal('canvasEmbed'), source: variableName, layout: z.enum(CANVAS_LAYOUTS), emits }),
  z.strictObject({
    ...base, kind: z.literal('chart'), source: variableName,
    measure: z.strictObject({ aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max']), property: z.uuid().optional() }),
    groupBy: z.uuid().optional(),
    /** The author's override of the archetype chosen by structure (31.4), recorded. */
    archetype: z.enum(ARCHETYPES).optional(),
  }),
  z.strictObject({
    ...base, kind: z.literal('metric'), source: variableName,
    aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max']), property: z.uuid().optional(), functionId: z.uuid().optional(),
  }),
  z.strictObject({ ...base, kind: z.literal('filterControls'), target: variableName, facets: ids(20), search: z.boolean().default(false), period: z.uuid().optional() }),
  z.strictObject({ ...base, kind: z.literal('actionForm'), actionTypeId: z.uuid(), params: z.record(z.string(), variableName).default({}) }),
  z.strictObject({
    ...base, kind: z.literal('actionButton'), actionTypeId: z.uuid(), params: z.record(z.string(), variableName).default({}),
    label: z.string().trim().min(1).max(60),
  }),
  z.strictObject({ ...base, kind: z.literal('askPanel'), scope: z.array(variableName).max(10).default([]) }),
  z.strictObject({ ...base, kind: z.literal('approvalInbox') }),
  z.strictObject({ ...base, kind: z.literal('scenarioControl'), variable: variableName }),
  z.strictObject({ ...base, kind: z.literal('map'), source: variableName, geoPropertyId: z.uuid() }),
  z.strictObject({ ...base, kind: z.literal('timeline'), source: variableName }),
  /** Static text; interpolation inserts skin labels and counts, never property values: {{label:<objectTypeId>}}, {{count:<variable>}}. */
  z.strictObject({ ...base, kind: z.literal('markdown'), text: z.string().max(4_000) }),
]);
export type AppWidget = z.infer<typeof widget>;

/** Each widget kind's events (the only sources an event binding may name). */
export const WIDGET_EVENTS: Readonly<Record<AppWidget['kind'], readonly string[]>> = {
  objectTable: ['selectionChanged'], objectList: ['selectionChanged'], propertyList: [], objectViewEmbed: [], canvasEmbed: ['selectionChanged'],
  chart: ['elementSelected'], metric: [], filterControls: ['changed'], actionForm: ['submitted'], actionButton: ['clicked'], askPanel: [],
  approvalInbox: ['decided'], scenarioControl: ['changed'], map: ['selectionChanged'], timeline: [], markdown: [],
};

/** The closed set of effects (35.2). An event cannot call an endpoint. */
export const effect = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('setVariable'), variable: variableName, from: variableName }),
  z.strictObject({ kind: z.literal('clearVariable'), variable: variableName }),
  z.strictObject({ kind: z.literal('navigate'), pageId: id }),
  z.strictObject({ kind: z.literal('openObjectView'), variable: variableName }),
  z.strictObject({ kind: z.literal('openActionForm'), actionTypeId: z.uuid(), params: z.record(z.string(), variableName).default({}) }),
  z.strictObject({ kind: z.literal('openAsk'), scope: z.array(variableName).max(10).default([]) }),
  z.strictObject({ kind: z.literal('refreshWidget'), widget: id }),
]);

export const eventBinding = z.strictObject({
  source: z.strictObject({ widget: id, event: z.string().regex(/^[a-z][A-Za-z]{0,39}$/) }),
  condition: cel.optional(),
  /** At most eight effects (35.2). */
  effects: z.array(effect).min(1).max(8),
});

export const appPage = z.strictObject({
  id,
  title: z.string().trim().min(1).max(120),
  widgets: z.array(widget).max(60),
});

export const appDefinition = z.strictObject({
  schemaVersion: z.literal(APP_SCHEMA_VERSION),
  /** Main's sequence the definition is validated against. */
  ontologyVersion: z.int().min(1),
  variables: z.record(variableName, variable).default({}),
  pages: z.array(appPage).min(1).max(20),
  events: z.array(eventBinding).max(200).default([]),
  /** The ontology Functions the app uses, by id. */
  functions: z.array(z.uuid()).max(100).default([]),
  /** The Action types the app may open, by id. */
  actions: z.array(z.uuid()).max(100).default([]),
  /** Optional mobile settings (35.11): page order and subset. */
  mobile: z.strictObject({ pages: z.array(id).max(20) }).optional(),
});
export type AppDefinition = z.infer<typeof appDefinition>;
export type AppDefinitionInput = z.input<typeof appDefinition>;

/** A validator finding: where, what, in words. An invalid draft saves with them and cannot be submitted. */
export const validationFinding = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});
export type ValidationFinding = z.infer<typeof validationFinding>;
