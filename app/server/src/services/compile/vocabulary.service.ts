// The vocabulary as the model is told it (spec 26.4, 62.1): names, descriptions, types,
// declared time fields and link routes, from the reader's own vocabulary only. No sample,
// no value, no row. Names are API names, so what the model says back resolves exactly;
// display names go in the descriptions, in the organisation's own words.

import type { z } from 'zod';
import type { getVocabulary } from '../../contracts/compile/compile.contract.ts';
import type { vocabulary } from '../../contracts/model-gateway/call.contract.ts';
import type { LinkAccess, ReaderAccess, TypeAccess } from '../planner/access.service.ts';

/** How a route is named to the model, when a link has more than one. */
export const routeName = (position: number): string => `route_${position}`;

const describe = (displayName: string, description: string | null): string =>
  (description === null ? displayName : `${displayName}: ${description}`).slice(0, 2_000);

/** The organisation's aliases by column (spec 21.6), as compile reads them for the vocabulary. */
export type ColumnAliases = ReadonlyMap<string, string>;
export const columnKey = (connectionId: string, fieldPath: string): string => `${connectionId}\u0000${fieldPath}`;

/** A property's names besides its API name: its display name, and its columns' aliases (26.7: an alias is inherited everywhere). */
function aliasesOf(p: { displayName: string; apiName: string; mappings: readonly { connectionId: string; fieldPath: string }[] }, columns: ColumnAliases): string[] {
  const names = new Set<string>();
  if (p.displayName.toLowerCase() !== p.apiName.replaceAll('_', ' ')) names.add(p.displayName.slice(0, 200));
  for (const m of p.mappings) {
    const alias = columns.get(columnKey(m.connectionId, m.fieldPath));
    if (alias !== undefined && alias.toLowerCase() !== p.displayName.toLowerCase()) names.add(alias.slice(0, 200));
  }
  return [...names].slice(0, 20);
}

export function modelVocabulary(access: ReaderAccess, columns: ColumnAliases = new Map()): z.input<typeof vocabulary> {
  const types = [...access.types.values()];
  const nameOf = new Map(types.map((t) => [t.type.id, t.type.apiName]));
  return {
    objectTypes: types.map((t) => ({
      name: t.type.apiName,
      description: describe(t.type.displayName, t.type.description),
      properties: [...t.properties.values()].map((p) => ({
        name: p.property.apiName, type: p.property.dataType,
        description: describe(p.property.displayName, p.property.description),
        ...(() => {
          const names = aliasesOf(p.property, columns);
          return names.length === 0 ? {} : { aliases: names };
        })(),
      })),
      timeFields: t.type.timeFields.filter((f) => t.properties.has(f.propertyIdentityId))
        .map((f) => t.properties.get(f.propertyIdentityId)!.property.apiName),
    })),
    linkTypes: [...access.links.values()].flatMap((l: LinkAccess) => {
      const base = { name: l.link.apiName, from: nameOf.get(l.link.fromTypeId)!, to: nameOf.get(l.link.toTypeId)!,
        description: `${l.link.forwardName} / ${l.link.reverseName}`.slice(0, 2_000) };
      return l.routes.length === 1 ? [base] : l.routes.map((r) => ({ ...base, route: routeName(r.position) }));
    }),
    ...(() => {
      const interfaces = interfaceRoots(access);
      return interfaces.length === 0 ? {} : {
        interfaces: interfaces.map((i) => ({
          name: i.type.type.apiName, description: describe(i.type.type.displayName, i.type.type.description),
          properties: [...i.type.properties.values()].map((p) => ({ name: p.property.apiName, type: p.property.dataType, description: describe(p.property.displayName, p.property.description) })),
          implementedBy: i.implementedBy,
        })),
      };
    })(),
  };
}

/**
 * The interfaces the reader may stand a plan on (21.9): those they may see that a type they may
 * see implements, each as a type-shaped vocabulary entry whose properties are its shared
 * properties (an identity id here is the shared property's id).
 */
export function interfaceRoots(access: ReaderAccess): { type: TypeAccess; implementedBy: string[] }[] {
  const types = [...access.types.values()];
  return access.manifest.interfaces.filter((i) => access.interfaces.has(i.id)).flatMap((i) => {
    const implementedBy = types.filter((t) => t.type.implements.some((x) => x.interfaceId === i.id)).map((t) => t.type.apiName);
    if (implementedBy.length === 0) return [];
    const properties = new Map(access.manifest.sharedProperties.filter((s) => i.requiredSharedPropertyIds.includes(s.id)).map((s) => [s.id, {
      property: {
        identityId: s.id, apiName: s.apiName, displayName: s.displayName, description: s.description, dataType: s.dataType, typeParams: {},
        nullable: true, isMatchKey: false, sharedPropertyId: s.id, computedFunctionVersionId: null, status: 'active' as const, mappings: [],
      },
      effect: 'allow' as const,
    }]));
    const type = {
      id: i.id, apiName: i.apiName, displayName: i.displayName, pluralName: i.displayName, description: i.description, timeFields: [], implements: [],
    } as unknown as TypeAccess['type'];
    return [{ type: { type, properties, withheld: [] } as TypeAccess, implementedBy }];
  });
}

export function vocabularyView(access: ReaderAccess): z.output<typeof getVocabulary.response> {
  const implemented = new Set([...access.types.values()].flatMap((t) => t.type.implements.map((i) => i.interfaceId)));
  return {
    ontologyVersionId: access.manifest.version.id,
    objectTypes: [...access.types.values()].map((t) => {
      const times = new Set(t.type.timeFields.map((f) => f.propertyIdentityId));
      const fallback = t.type.defaultTimeFieldPropertyIdentityId;
      return {
        id: t.type.id, apiName: t.type.apiName, displayName: t.type.displayName, pluralName: t.type.pluralName, description: t.type.description,
        resolutionClass: t.type.resolutionClass,
        titleProperty: t.properties.has(t.type.titlePropertyIdentityId) ? t.type.titlePropertyIdentityId : null,
        // The identifying property, where the reader may see it unshaped: one object can then be named in a filter (37.8).
        primaryKey: t.type.primaryKeyPropertyIdentityId !== null && t.properties.get(t.type.primaryKeyPropertyIdentityId)?.effect === 'allow' ? t.type.primaryKeyPropertyIdentityId : null,
        interfaces: t.type.implements.map((i) => i.interfaceId).filter((id) => access.interfaces.has(id)),
        properties: [...t.properties.values()].map((p) => ({
          identityId: p.property.identityId, apiName: p.property.apiName, displayName: p.property.displayName, dataType: p.property.dataType,
          description: p.property.description ?? null, effect: p.effect, isTimeField: times.has(p.property.identityId),
        })),
        defaultTimeField: fallback !== null && t.properties.has(fallback) ? fallback : null,
      };
    }),
    linkTypes: [...access.links.values()].map((l) => ({
      id: l.link.id, apiName: l.link.apiName, forwardName: l.link.forwardName, reverseName: l.link.reverseName,
      fromTypeId: l.link.fromTypeId, toTypeId: l.link.toTypeId,
      routes: l.routes.map((r) => ({ id: r.id, position: r.position })),
      defaultRouteId: l.routes.some((r) => r.id === l.link.defaultRouteId) ? l.link.defaultRouteId : null,
    })),
    interfaces: access.manifest.interfaces.filter((i) => implemented.has(i.id) && access.interfaces.has(i.id))
      .map((i) => ({ id: i.id, apiName: i.apiName, displayName: i.displayName, description: i.description })),
  };
}
