// Every place in the client, indexed: which place a page is, where a capability lives, and the
// list search and the help centre read. Built once from the registry files.

import type { RouteName } from '../api/client.api.ts';
import { ACCOUNT, ENTRY_ROUTES, FRAME_ROUTES } from './account.navigation.ts';
import { AREAS } from './areas.navigation.ts';
import { SETTINGS } from './settings.navigation.ts';
import type { Area, Place } from './types.navigation.ts';

export type Where =
  | { kind: 'section'; area: Area; place: Place }
  | { kind: 'settings'; group: string; place: Place }
  | { kind: 'account'; place: Place };

/** Every place with where it sits, in the sidebar's order, then settings, then account. */
export const PLACES: readonly Where[] = [
  ...AREAS.flatMap((area) => area.sections.map((place): Where => ({ kind: 'section', area, place }))),
  ...SETTINGS.flatMap((group) => group.items.map((place): Where => ({ kind: 'settings', group: group.label, place }))),
  ...ACCOUNT.map((place): Where => ({ kind: 'account', place })),
];

/** A place's trail, for search results and breadcrumbs: "Connect › Agents", "Settings › People › Seats". */
export function trailOf(where: Where): string[] {
  switch (where.kind) {
    case 'section': return where.area.sections.length === 1 ? [where.area.label] : [where.area.label, where.place.label];
    case 'settings': return ['Settings', where.group, where.place.label];
    case 'account': return ['Account', where.place.label];
  }
}

const normalise = (path: string): string => (path.endsWith('/') ? path : `${path}/`);

/** The place a page path belongs to: the longest href it starts with. */
export function placeOf(pathname: string): Where | undefined {
  const path = normalise(pathname);
  let best: Where | undefined;
  for (const where of PLACES) {
    const href = where.place.href;
    if ((href === '/' ? path === '/' : path.startsWith(href)) && (best === undefined || href.length > best.place.href.length)) best = where;
  }
  return best;
}

/** The area a page path belongs to, for the sidebar. */
export function areaOf(pathname: string): Area | undefined {
  const where = placeOf(pathname);
  if (where?.kind === 'section') return where.area;
  const path = normalise(pathname);
  return AREAS.find((a) => a.id !== 'home' && path.startsWith(`/${a.id}/`));
}

/** The home of each capability: a place, the workspace frame, or the pages before sign-in. */
export type Home = { kind: 'place'; where: Where } | { kind: 'frame' } | { kind: 'entry' } | { kind: 'support' };

export function homesOf(extra: Partial<Record<'support', readonly RouteName[]>> = {}): Map<RouteName, Home[]> {
  const homes = new Map<RouteName, Home[]>();
  const add = (route: RouteName, home: Home) => homes.set(route, [...(homes.get(route) ?? []), home]);
  for (const where of PLACES) for (const route of where.place.routes) add(route, { kind: 'place', where });
  for (const route of FRAME_ROUTES) add(route, { kind: 'frame' });
  for (const route of ENTRY_ROUTES) add(route, { kind: 'entry' });
  for (const route of extra.support ?? []) add(route, { kind: 'support' });
  return homes;
}
