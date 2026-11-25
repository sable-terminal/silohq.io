'use client';

// Settings and the account pages sit outside the sidebar's areas (spec 33.4): their own list of
// pages runs down the left of the page, grouped as an administrator thinks of them. A page the
// person may not use is shown disabled with what it needs.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { permissionOf, routeInfo } from '../../api/client.api.ts';
import { Icon } from '../../components/icon.component.tsx';
import { useQuery } from '../../data/query.data.ts';
import type { Place } from '../../navigation/types.navigation.ts';
import styles from './frame.view.module.css';

export interface NavGroup { label: string; items: readonly Place[] }

export function usePlaceGate(): (place: Place) => string | undefined {
  const held = useQuery('readMyPermissions', {}, { staleMs: 5 * 60_000 });
  return useMemo(() => {
    const index = new Map((held.data?.permissions ?? []).map((p) => [p.id, p]));
    return (place: Place) => {
      if (held.data === undefined) return undefined;
      const reads = place.routes.filter((r) => routeInfo(r).method === 'GET');
      const routes = reads.length > 0 ? reads : place.routes;
      const gated = routes.map(permissionOf).filter((p): p is string => p !== undefined);
      if (gated.length === 0 || gated.length < routes.length || gated.some((p) => index.get(p)?.held !== false)) return undefined;
      return `Needs ${gated[0]}: ${index.get(gated[0]!)?.description ?? ''}`.replace(/: $/, '');
    };
  }, [held.data]);
}

export function SettingsFrame({ title, groups, children }: { title: string; groups: readonly NavGroup[]; children: ReactNode }) {
  const pathname = usePathname();
  const gate = usePlaceGate();
  const here = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return (
    <div className={styles.frame}>
      <nav className={styles.nav} aria-label={title}>
        <Link href={title === 'Settings' ? '/settings/' : '/account/'} className={styles.title}>{title}</Link>
        {groups.map((group) => (
          <div key={group.label} className={styles.group}>
            {groups.length > 1 ? <h2 className={styles.groupLabel}>{group.label}</h2> : null}
            <ul className={styles.items}>
              {group.items.map((place) => {
                const blocked = gate(place);
                return (
                  <li key={place.href}>
                    {blocked !== undefined ? (
                      <span className={styles.item} aria-disabled="true" title={blocked}>
                        {place.icon !== undefined ? <Icon name={place.icon} size={16} /> : null}
                        {place.label}
                        <span className="visually-hidden">: {blocked}</span>
                      </span>
                    ) : (
                      <Link href={place.href as never} className={styles.item} aria-current={here.startsWith(place.href) ? 'page' : undefined}>
                        {place.icon !== undefined ? <Icon name={place.icon} size={16} /> : null}
                        {place.label}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
