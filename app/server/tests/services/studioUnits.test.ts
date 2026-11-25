// The app definition validator (spec 35.1 to 35.5) and the structural templates (35.9),
// over a hand-built manifest: refused, never repaired, with every finding's path.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { OntologyManifest } from '../../src/contracts/ontology/manifest.contract.ts';
import { instantiate, type Bindings, type TemplateName } from '../../src/services/studio/templates.service.ts';
import { validate, type ActionTypeFact } from '../../src/services/studio/validator.service.ts';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PUMP = u(1);
const SITE = u(2);
const NAME = u(11);
const PRESSURE = u(12);
const LOCATION = u(13);
const SERVICED = u(14);
const SITE_NAME = u(21);
const LINK = u(31);
const FN = u(41);
const ACT = u(51);
const DRAFT_ACT = u(52);

const property = (identityId: string, apiName: string, dataType: string) => ({
  identityId, apiName, displayName: apiName, description: null, dataType, typeParams: {}, nullable: true, isMatchKey: false,
  sharedPropertyId: null, computedFunctionVersionId: null, status: 'active', mappings: [],
});
const type = (id: string, apiName: string, properties: ReturnType<typeof property>[]) => ({
  id, typeVersionId: u(900 + Number(id.slice(-2))), apiName, status: 'active', displayName: apiName, pluralName: `${apiName}s`, description: null,
  resolutionClass: 'single_source', matchKeys: [], primaryKeyPropertyIdentityId: properties[0]!.identityId, titlePropertyIdentityId: properties[0]!.identityId,
  defaultTimeFieldPropertyIdentityId: null, contributingObjects: [], properties, timeFields: [], implements: [], visual: {},
});
const manifest = {
  schemaVersion: '1', organisationId: u(99),
  version: { id: u(98), branchId: u(97), branchKind: 'main', sequence: 7, parentVersionId: null, kind: 'merge', manifestHash: 'a'.repeat(64), createdAt: '' },
  objectTypes: [
    type(PUMP, 'pump', [property(NAME, 'name', 'string'), property(PRESSURE, 'pressure', 'decimal'), property(LOCATION, 'location', 'geopoint'),
      property(SERVICED, 'last_service', 'timestamp')]),
    type(SITE, 'site', [property(SITE_NAME, 'name', 'string')]),
  ],
  linkTypes: [{ id: LINK, apiName: 'site_pumps', status: 'active', forwardName: 'houses', reverseName: 'sits at', fromTypeId: SITE, toTypeId: PUMP,
    cardinality: 'one_to_many', routes: [], defaultRouteId: null }],
  sharedProperties: [], interfaces: [],
  functions: [{ id: FN, apiName: 'risk', status: 'active', kind: 'computed_property', description: null,
    version: { id: u(42), version: 1, expression: 'object.pressure * 2.0', inputs: {}, outputType: { dataType: 'decimal', typeParams: {} }, costLimit: 100 } }],
} as unknown as OntologyManifest;

const facts = new Map<string, ActionTypeFact>([
  [ACT, { id: ACT, status: 'confirmed', objectTypeId: PUMP }],
  [DRAFT_ACT, { id: DRAFT_ACT, status: 'proposed', objectTypeId: PUMP }],
]);

const good = (): { variables: Record<string, unknown>; pages: ({ widgets: Record<string, unknown>[] } & Record<string, unknown>)[]; events: unknown[]; functions: string[]; actions: string[] } & Record<string, unknown> => ({
  schemaVersion: '1', ontologyVersion: 7,
  variables: {
    pumps: { kind: 'objectSet', objectTypeId: SITE, traversal: [{ linkTypeId: LINK, direction: 'forward' }] },
    picked: { kind: 'selection', objectTypeId: PUMP },
  },
  pages: [{ id: 'p1', title: 'Pumps', widgets: [
    { id: 'table', kind: 'objectTable', source: 'pumps', columns: [NAME, PRESSURE], grid: [1, 1, 8, 6], emits: { selectionChanged: 'picked' } },
    { id: 'detail', kind: 'propertyList', source: 'picked', properties: [NAME, SERVICED], grid: [9, 1, 4, 6] },
    { id: 'risk', kind: 'metric', source: 'pumps', aggregate: 'max', property: PRESSURE, functionId: FN, grid: [1, 7, 3, 2] },
    { id: 'map', kind: 'map', source: 'pumps', geoPropertyId: LOCATION, grid: [4, 7, 9, 6] },
    { id: 'act', kind: 'actionButton', actionTypeId: ACT, params: { target: 'picked' }, label: 'Reset', grid: [1, 9, 3, 1] },
    { id: 'note', kind: 'markdown', text: '{{count:pumps}} {{label:' + PUMP + '}}', grid: [1, 13, 12, 1] },
  ] }],
  events: [{ source: { widget: 'table', event: 'selectionChanged' }, effects: [{ kind: 'openObjectView', variable: 'picked' }] }],
  functions: [FN], actions: [ACT],
});

const codes = (raw: unknown) => validate(raw, manifest, facts).findings.map((f) => `${f.path}:${f.code}`);

describe('the validator (spec 35.1, 35.2)', () => {
  test('a valid definition passes, and its references name the widgets that use each element', () => {
    const out = validate(good(), manifest, facts);
    assert.deepEqual(out.findings, []);
    assert.deepEqual([...out.references.property.get(PRESSURE)!].sort(), ['map', 'risk', 'table'].filter((w) => w !== 'map').sort());
    assert.deepEqual([...out.references.objectType.get(SITE)!].sort(), ['map', 'note', 'risk', 'table']);
    assert.deepEqual([...out.references.linkType.get(LINK)!].sort(), ['map', 'note', 'risk', 'table']);
    assert.deepEqual([...out.references.actionType.get(ACT)!], ['act']);
    assert.deepEqual([...out.references.function.get(FN)!], ['risk']);
  });

  test('what the schema does not allow is a finding, not a repair: no code widget exists', () => {
    const raw = good();
    (raw.pages[0]!.widgets as unknown[]).push({ id: 'js', kind: 'script', source: 'alert(1)', grid: [1, 20, 1, 1] });
    assert.ok(codes(raw).every((c) => c.endsWith(':schema')));
    assert.ok(codes(raw).length > 0);
  });

  test('an element the bound version does not hold is refused: type, property, link, Function, Action', () => {
    const raw = good();
    raw.variables.picked = { kind: 'selection', objectTypeId: u(500) };
    (raw.pages[0]!.widgets[0] as { columns: string[] }).columns.push(SITE_NAME);
    raw.functions = [u(600)];
    raw.actions = [ACT, u(700), DRAFT_ACT];
    const found = codes(raw);
    for (const expected of ['variables.picked:object_type_unknown', 'pages.0.widgets.0.columns.2:property_unknown', 'functions.0:function_unknown',
      'actions.1:action_unknown', 'actions.2:action_unconfirmed', 'pages.0.widgets.2.functionId:function_undeclared']) {
      assert.ok(found.includes(expected), expected);
    }
    assert.notEqual(validate(good(), undefined, facts).findings[0]!.code, undefined, 'an unknown ontology version is a finding');
  });

  test('the grid has twelve columns; a selection is of the source\'s type; a Located property is geographic', () => {
    const raw = good();
    (raw.pages[0]!.widgets[0] as { grid: number[] }).grid = [6, 1, 8, 6];
    raw.variables.picked = { kind: 'selection', objectTypeId: SITE };
    (raw.pages[0]!.widgets[3] as { geoPropertyId: string }).geoPropertyId = NAME;
    const found = codes(raw);
    for (const expected of ['pages.0.widgets.0.grid:grid_overflow', 'pages.0.widgets.0.emits.selectionChanged:selection_type',
      'pages.0.widgets.3.geoPropertyId:property_type']) {
      assert.ok(found.includes(expected), expected);
    }
  });

  test('markdown inserts labels and counts, never a value', () => {
    const raw = good();
    (raw.pages[0]!.widgets[5] as { text: string }).text = 'Pressure is {{value:pressure}}';
    assert.ok(codes(raw).includes('pages.0.widgets.5.text:interpolation'));
  });

  test('events name real widgets, their events and pages; a variable that ends up setting itself is a cycle', () => {
    const raw = good();
    raw.variables = { ...raw.variables, other: { kind: 'selection', objectTypeId: PUMP } };
    raw.events = [
      { source: { widget: 'detail', event: 'selectionChanged' }, effects: [{ kind: 'navigate', pageId: 'nowhere' }] },
      { source: { widget: 'table', event: 'selectionChanged' }, effects: [{ kind: 'setVariable', variable: 'other', from: 'picked' }] },
      { source: { widget: 'act', event: 'clicked' }, effects: [{ kind: 'setVariable', variable: 'picked', from: 'other' }] },
      { source: { widget: 'act', event: 'clicked' }, effects: [{ kind: 'setVariable', variable: 'other', from: 'other' }] },
    ] as unknown as typeof raw.events;
    const found = codes(raw);
    for (const expected of ['events.0.source.event:event_unknown', 'events.0.effects.0.pageId:page_unknown', 'events:event_cycle']) {
      assert.ok(found.includes(expected), expected);
    }
  });
});

describe('templates (spec 35.9)', () => {
  test('each binds to the customer\'s own type and validates as any draft does; a missing binding is refused', () => {
    for (const [name, bindings] of ([
      ['monitor', { objectTypeId: PUMP, measurePropertyId: PRESSURE }],
      ['inbox_detail', { objectTypeId: PUMP, actionTypeId: ACT, properties: [NAME, PRESSURE] }],
      ['triage_queue', { objectTypeId: PUMP, actionTypeId: ACT }],
      ['map_list', { objectTypeId: PUMP, geoPropertyId: LOCATION }],
      ['scenario_workbench', { objectTypeId: PUMP }],
    ] as [TemplateName, Bindings][])) {
      const definition = instantiate(name, bindings, manifest);
      assert.deepEqual(validate(definition, manifest, facts).findings, [], name);
    }
    assert.throws(() => instantiate('inbox_detail', { objectTypeId: PUMP }, manifest), { code: 'studio.template_binding' });
  });
});
