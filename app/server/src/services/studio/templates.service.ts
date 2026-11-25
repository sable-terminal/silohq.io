// Structural templates (spec 35.9): skeletons bound to placeholders, never to a domain.
// Each binds to the customer's own type (and, where it needs one, an Action type, a Located
// property or a measure) on instantiation, and the result is an ordinary draft validated
// like any other. A template never names a domain type (invariant 3).

import type { TEMPLATES } from '../../contracts/studio/app.contract.ts';
import { APP_SCHEMA_VERSION, type AppDefinitionInput } from '../../contracts/studio/definition.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { AppError } from '../../utils/errors.util.ts';

export type TemplateName = (typeof TEMPLATES)[number];

export interface Bindings {
  objectTypeId: string;
  properties?: string[] | undefined;
  actionTypeId?: string | undefined;
  geoPropertyId?: string | undefined;
  measurePropertyId?: string | undefined;
}

export const TEMPLATE_CATALOGUE: readonly { name: TemplateName; description: string; requires: ('objectTypeId' | 'actionTypeId' | 'geoPropertyId' | 'measurePropertyId')[] }[] = [
  { name: 'inbox_detail', description: 'A list of a type, the selected object\'s view, and an Action button.', requires: ['objectTypeId', 'actionTypeId'] },
  { name: 'triage_queue', description: 'A filtered set, an approval inbox and an Action form.', requires: ['objectTypeId', 'actionTypeId'] },
  { name: 'monitor', description: 'Metrics, a chart and an exceptions table over a type.', requires: ['objectTypeId'] },
  { name: 'map_list', description: 'A map and a list of a located type.', requires: ['objectTypeId', 'geoPropertyId'] },
  { name: 'scenario_workbench', description: 'A scenario control, a canvas, staged Actions and a metric.', requires: ['objectTypeId'] },
];

export function instantiate(name: TemplateName, bindings: Bindings, manifest: OntologyManifest): AppDefinitionInput {
  const type = manifest.objectTypes.find((t) => t.id === bindings.objectTypeId && t.status === 'active');
  if (!type) throw new AppError('validation', 'the template binds to an active object type', { code: 'studio.template_binding' });
  const spec = TEMPLATE_CATALOGUE.find((t) => t.name === name)!;
  for (const required of spec.requires) {
    if (bindings[required] === undefined) {
      throw new AppError('validation', `the ${name} template needs ${required}`, { code: 'studio.template_binding', details: { binding: required } });
    }
  }
  const columns = bindings.properties?.length ? bindings.properties : [type.titlePropertyIdentityId];
  const variables = {
    items: { kind: 'objectSet' as const, objectTypeId: type.id },
    picked: { kind: 'selection' as const, objectTypeId: type.id },
  };
  const actions = bindings.actionTypeId === undefined ? [] : [bindings.actionTypeId];
  const common: Pick<AppDefinitionInput, 'schemaVersion' | 'ontologyVersion' | 'actions'> = {
    schemaVersion: APP_SCHEMA_VERSION, ontologyVersion: manifest.version.sequence, actions,
  };
  switch (name) {
    case 'inbox_detail':
      return {
        ...common, variables,
        pages: [{ id: 'inbox', title: type.pluralName, widgets: [
          { id: 'list', kind: 'objectTable', source: 'items', columns, grid: [1, 1, 8, 8], emits: { selectionChanged: 'picked' } },
          { id: 'detail', kind: 'objectViewEmbed', source: 'picked', grid: [9, 1, 4, 7] },
          { id: 'act', kind: 'actionButton', actionTypeId: bindings.actionTypeId!, params: { target: 'picked' }, label: 'Act', grid: [9, 8, 4, 1] },
        ] }],
      };
    case 'triage_queue':
      return {
        ...common, variables,
        pages: [{ id: 'queue', title: 'Queue', widgets: [
          { id: 'filters', kind: 'filterControls', target: 'items', facets: columns.slice(0, 3), search: true, grid: [1, 1, 12, 1] },
          { id: 'queue', kind: 'objectTable', source: 'items', columns, grid: [1, 2, 7, 8], emits: { selectionChanged: 'picked' } },
          { id: 'inbox', kind: 'approvalInbox', grid: [8, 2, 5, 4] },
          { id: 'form', kind: 'actionForm', actionTypeId: bindings.actionTypeId!, params: { target: 'picked' }, grid: [8, 6, 5, 4] },
        ] }],
      };
    case 'monitor':
      return {
        ...common, variables: { items: variables.items },
        pages: [{ id: 'monitor', title: type.pluralName, widgets: [
          { id: 'count', kind: 'metric', source: 'items', aggregate: 'count', grid: [1, 1, 3, 2] },
          ...(bindings.measurePropertyId === undefined ? [] : [
            { id: 'total', kind: 'metric' as const, source: 'items', aggregate: 'sum' as const, property: bindings.measurePropertyId, grid: [4, 1, 3, 2] as [number, number, number, number] },
          ]),
          { id: 'trend', kind: 'chart', source: 'items', measure: { aggregate: 'count' }, grid: [1, 3, 12, 4] },
          { id: 'exceptions', kind: 'objectTable', source: 'items', columns, grid: [1, 7, 12, 6] },
        ] }],
      };
    case 'map_list':
      return {
        ...common, variables,
        pages: [{ id: 'map', title: type.pluralName, widgets: [
          { id: 'map', kind: 'map', source: 'items', geoPropertyId: bindings.geoPropertyId!, grid: [1, 1, 8, 10] },
          { id: 'list', kind: 'objectList', source: 'items', properties: columns.slice(0, 4), grid: [9, 1, 4, 10], emits: { selectionChanged: 'picked' } },
        ] }],
      };
    case 'scenario_workbench':
      return {
        ...common, variables: { ...variables, scenario: { kind: 'scenario' as const } },
        pages: [{ id: 'workbench', title: 'Scenario', widgets: [
          { id: 'scenario', kind: 'scenarioControl', variable: 'scenario', grid: [1, 1, 12, 1] },
          { id: 'canvas', kind: 'canvasEmbed', source: 'items', layout: 'graph_layered', grid: [1, 2, 8, 9], emits: { selectionChanged: 'picked' } },
          { id: 'count', kind: 'metric', source: 'items', aggregate: 'count', grid: [9, 2, 4, 2] },
          { id: 'inbox', kind: 'approvalInbox', grid: [9, 4, 4, 7] },
        ] }],
      };
  }
}
