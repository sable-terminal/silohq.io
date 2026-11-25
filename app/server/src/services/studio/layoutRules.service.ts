// Object view layouts (spec 34.6): what a layout is, without any I/O.
//
// Every object type has a generated default, produced from its structure alone: its
// properties in declaration order with the primary first, one link group per link type it
// takes part in (each direction its own group), then the fixed sections. A custom layout is a
// single-page Studio app definition bound to an object variable (`object`, a selection of
// the type). It may reorder, group and hide sections and add widgets. It cannot remove
// lineage or flags from a visible property, nor hide the markings banner: the schema has no
// way to say so, because those are drawn by the object view around every property row.

import type { ObjectTypeView, OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { APP_SCHEMA_VERSION, type AppDefinitionInput, type ValidationFinding } from '../../contracts/studio/definition.contract.ts';
import { LAYOUT_SECTIONS } from '../../contracts/studio/layout.contract.ts';

export interface GeneratedLayout {
  properties: string[];
  linkGroups: { linkTypeId: string; direction: 'outgoing' | 'incoming' }[];
  sections: (typeof LAYOUT_SECTIONS)[number][];
}

/** The generated default: deterministic from the type and its link types. */
export function generatedLayout(type: ObjectTypeView, manifest: OntologyManifest): GeneratedLayout {
  const active = type.properties.filter((p) => p.status === 'active');
  const primary = type.primaryKeyPropertyIdentityId ?? type.titlePropertyIdentityId;
  const properties = [...active.filter((p) => p.identityId === primary), ...active.filter((p) => p.identityId !== primary)].map((p) => p.identityId);
  const linkGroups = manifest.linkTypes.filter((l) => l.status === 'active' && (l.fromTypeId === type.id || l.toTypeId === type.id))
    .flatMap((l) => [
      ...(l.fromTypeId === type.id ? [{ linkTypeId: l.id, direction: 'outgoing' as const }] : []),
      ...(l.toTypeId === type.id ? [{ linkTypeId: l.id, direction: 'incoming' as const }] : []),
    ]);
  return { properties, linkGroups, sections: [...LAYOUT_SECTIONS] };
}

/**
 * A custom layout's starting point: the generated property order on one page bound to the
 * object, its timeline, an Action button where an Action type is given, and Ask scoped to it.
 * Identity (the primary and title) is grouped apart from the rest.
 */
export function layoutDefinition(type: ObjectTypeView, manifest: OntologyManifest, actionTypeId?: string): AppDefinitionInput {
  const { properties } = generatedLayout(type, manifest);
  const identity = properties.filter((p) => p === type.primaryKeyPropertyIdentityId || p === type.titlePropertyIdentityId);
  const details = properties.filter((p) => !identity.includes(p)).slice(0, 50);
  return {
    schemaVersion: APP_SCHEMA_VERSION, ontologyVersion: manifest.version.sequence,
    variables: { object: { kind: 'selection', objectTypeId: type.id } },
    pages: [{ id: 'object', title: type.displayName.slice(0, 120), widgets: [
      { id: 'identity', kind: 'propertyList', source: 'object', properties: identity, grid: [1, 1, 8, 2] },
      ...(details.length === 0 ? [] : [{ id: 'details', kind: 'propertyList' as const, source: 'object', properties: details, grid: [1, 3, 8, 8] as [number, number, number, number] }]),
      { id: 'timeline', kind: 'timeline', source: 'object', grid: [9, 1, 4, 10] },
      ...(actionTypeId === undefined ? [] : [{
        id: 'act', kind: 'actionButton' as const, actionTypeId, params: { target: 'object' }, label: 'Update', grid: [1, 11, 4, 1] as [number, number, number, number],
      }]),
      { id: 'ask', kind: 'askPanel', scope: ['object'], grid: [1, 12, 12, 3] },
    ] }],
    events: [], functions: [], actions: actionTypeId === undefined ? [] : [actionTypeId],
  };
}

/** The type a layout definition is for: its `object` variable's. */
export function layoutTypeOf(definition: Record<string, unknown>): string | undefined {
  const object = (definition['variables'] as Record<string, { kind?: unknown; objectTypeId?: unknown }> | undefined)?.['object'];
  return object?.kind === 'selection' && typeof object.objectTypeId === 'string' ? object.objectTypeId : undefined;
}

/** What makes a definition a layout for this type, beyond what every app definition must be. */
export function layoutFindings(definition: Record<string, unknown>, objectTypeId: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const pages = Array.isArray(definition['pages']) ? definition['pages'] : [];
  if (pages.length !== 1) findings.push({ path: 'pages', code: 'layout.single_page', message: 'a layout is a single page' });
  if (layoutTypeOf(definition) !== objectTypeId) {
    findings.push({ path: 'variables.object', code: 'layout.object_variable', message: 'a layout binds the variable object, a selection of its type' });
  }
  return findings;
}
