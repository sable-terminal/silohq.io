'use client';

// The organisation's directory (readDirectory): every member by name and every live scope, for
// naming who did something and for choosing whom to share with. Read once and kept fresh for a
// few minutes; a member who has left is still named in history.

import { useMemo } from 'react';
import type { Output } from '../api/client.api.ts';
import { useQuery } from '../data/query.data.ts';

export type Directory = Output<'readDirectory'>;

export interface People {
  readonly ready: boolean;
  /** A member's name: "a member" while the directory is not read, or if they are unknown. */
  nameOf(membershipId: string | null | undefined): string;
  readonly members: Directory['members'];
  readonly scopes: Directory['scopes'];
  scopeName(scopeId: string | null | undefined): string;
}

export function useDirectory(): People {
  const read = useQuery('readDirectory', {}, { staleMs: 5 * 60_000 });
  return useMemo(() => {
    const members = read.data?.members ?? [];
    const scopes = read.data?.scopes ?? [];
    const names = new Map(members.map((m) => [m.membershipId, m.displayName]));
    const scopeNames = new Map(scopes.map((s) => [s.id, s.name]));
    return {
      ready: read.data !== undefined,
      members,
      scopes,
      nameOf: (id) => (id === null || id === undefined ? 'someone' : names.get(id) ?? 'a member'),
      scopeName: (id) => (id === null || id === undefined ? 'the organisation' : scopeNames.get(id) ?? 'a scope'),
    };
  }, [read.data]);
}
