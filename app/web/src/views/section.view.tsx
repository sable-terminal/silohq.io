'use client';

// One place's page: its view, or what the place will hold. Every place in the registry has a
// page, so every path in the sidebar, search and the + menu leads somewhere.

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, type ComponentType } from 'react';
import { Loading } from '../components/states.component.tsx';
import { PLACES } from '../navigation/places.navigation.ts';
import { Planned } from './planned.view.tsx';
import { VIEWS } from './views.view.tsx';

export function SectionPage({ href }: { href: string }) {
  const where = PLACES.find((w) => w.place.href === href);
  if (where === undefined) throw new Error(`no place at ${href}`);
  const View: ComponentType | undefined = VIEWS[href];
  return View !== undefined ? <View /> : <Planned where={where} />;
}

/** An old area address (/governance/?tab=crons): sent on to the section that holds it now, its other parameters kept. */
export function AreaRedirect({ area, tabs, fallback, param = 'tab', byParam = {} }: {
  area: string;
  tabs: Readonly<Record<string, string>>;
  fallback: string;
  param?: string;
  /** A parameter that names the section by itself being present: ?workbook= is a workbook's. */
  byParam?: Readonly<Record<string, string>>;
}) {
  const params = useSearchParams();
  const router = useRouter();
  // The maps are written inline by their pages: compared by content, so the redirect runs once.
  const maps = JSON.stringify([tabs, byParam]);
  useEffect(() => {
    const [tabsNow, byParamNow] = JSON.parse(maps) as [Record<string, string>, Record<string, string>];
    const next = new URLSearchParams(params.toString());
    const tab = next.get(param);
    next.delete(param);
    const named = Object.entries(byParamNow).find(([name]) => next.has(name))?.[1];
    const section = tab === null ? named ?? fallback : tabsNow[tab] ?? fallback;
    const [path, extra] = section.split('?');
    for (const [k, v] of new URLSearchParams(extra ?? '')) next.set(k, v);
    const query = next.toString();
    router.replace(`/${area}/${path}${query === '' ? '' : `?${query}`}` as never);
  }, [area, maps, fallback, param, params, router]);
  return <Loading label="Opening" />;
}
