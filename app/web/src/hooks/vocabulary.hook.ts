'use client';

// The reader's vocabulary (spec 21.2): the object types, properties, link types and interfaces
// this person may see, read through the cache and shared by every page, with lookups by id. What
// is outside it does not exist for them, so a page never names more than this: an id it cannot
// find is "a type you cannot see", never the id itself.

import { useMemo } from 'react';
import type { Output } from '../api/client.api.ts';
import { useQuery, type QueryResult } from '../data/query.data.ts';

export type Vocabulary = Output<'readVocabulary'>;
export type ObjectType = Vocabulary['objectTypes'][number];
export type Property = ObjectType['properties'][number];
export type LinkType = Vocabulary['linkTypes'][number];
export type Interface = Vocabulary['interfaces'][number];

export interface Lookup {
  readonly types: ReadonlyMap<string, ObjectType>;
  readonly properties: ReadonlyMap<string, { type: ObjectType; property: Property }>;
  readonly links: ReadonlyMap<string, LinkType>;
  readonly interfaces: ReadonlyMap<string, Interface>;
  /** A type's display name, or a statement that it is not visible. */
  typeName(id: string, plural?: boolean): string;
  /** A property's display name (by its identity id), or a statement that it is not visible. */
  propertyName(identityId: string): string;
}

export function lookupOf(vocabulary: Vocabulary): Lookup {
  const types = new Map(vocabulary.objectTypes.map((t) => [t.id, t]));
  const properties = new Map(vocabulary.objectTypes.flatMap((type) => type.properties.map((property) => [property.identityId, { type, property }] as const)));
  return {
    types,
    properties,
    links: new Map(vocabulary.linkTypes.map((l) => [l.id, l])),
    interfaces: new Map(vocabulary.interfaces.map((i) => [i.id, i])),
    typeName: (id, plural = false) => {
      const type = types.get(id);
      return type === undefined ? 'a type you cannot see' : plural ? type.pluralName : type.displayName;
    },
    propertyName: (identityId) => properties.get(identityId)?.property.displayName ?? 'a property you cannot see',
  };
}

/** The vocabulary as read now, with its lookups once it has arrived. */
export function useVocabulary(): QueryResult<Vocabulary> & { lookup: Lookup | undefined } {
  const read = useQuery('readVocabulary', { query: {} }, { staleMs: 5 * 60_000 });
  const lookup = useMemo(() => (read.data === undefined ? undefined : lookupOf(read.data)), [read.data]);
  return { ...read, lookup };
}

/** A type's title property, where the reader may see it. */
export const titleOf = (type: ObjectType): Property | undefined => type.properties.find((p) => p.identityId === type.titleProperty);
