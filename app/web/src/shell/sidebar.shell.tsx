'use client';

// The sidebar: the organisation and cell at its head (switching organisation from there), spec
// 33.3's eleven areas in their fixed order, each opening into its sections, and the collapse
// control at its foot. Collapsed, it shows the areas' icons, each opening its sections in a
// flyout. An area or section the person may not use is shown disabled with what it needs, never
// hidden; Siloes alone is absent until the organisation switches Siloes on.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { permissionOf, routeInfo } from '../api/client.api.ts';
import { Icon } from '../components/icon.component.tsx';
import { Menu, type MenuEntry } from '../components/menu.component.tsx';
import { Tooltip } from '../components/tooltip.component.tsx';
import { useQuery } from '../data/query.data.ts';
import { useStored } from '../hooks/storage.hook.ts';
import { AREAS } from '../navigation/areas.navigation.ts';
import { useOrganisationLogo } from '../hooks/organisationLogo.hook.ts';
import { areaOf, placeOf } from '../navigation/places.navigation.ts';
import type { Area, Place } from '../navigation/types.navigation.ts';
import { useWorkspace } from './context.shell.tsx';
import styles from './sidebar.shell.module.css';

/** Why a section cannot be used: none of the permissions its reads need is held anywhere. */
function useSectionGate(): (place: Place) => string | undefined {
  const held = useQuery('readMyPermissions', {}, { staleMs: 5 * 60_000 });
  return useMemo(() => {
    const index = new Map((held.data?.permissions ?? []).map((p) => [p.id, p]));
    return (place: Place) => {
      if (held.data === undefined) return undefined;
      const reads = place.routes.filter((r) => routeInfo(r).method === 'GET');
      const gated = (reads.length > 0 ? reads : place.routes).map(permissionOf).filter((p): p is string => p !== undefined);
      if (gated.length === 0 || gated.length < (reads.length > 0 ? reads : place.routes).length) return undefined;
      if (gated.some((p) => index.get(p)?.held !== false)) return undefined;
      const first = index.get(gated[0]!);
      return `Needs ${gated[0]}${first === undefined ? '' : `: ${first.description}`}`;
    };
  }, [held.data]);
}

export function Sidebar({ mobileOpen, onNavigate }: { mobileOpen: boolean; onNavigate: () => void }) {
  const workspace = useWorkspace();
  const pathname = usePathname();
  const collapsed = workspace.preferences.railCollapsed && !mobileOpen;
  const current = areaOf(pathname);
  const currentPlace = placeOf(pathname);
  const gate = useSectionGate();
  const [open, setOpen] = useStored<string[]>('silo.sidebar.open', []);
  const rail = new Map(workspace.rail.map((r) => [r.item, r]));
  const areas = AREAS.filter((area) => area.needsSiloes !== true || rail.has('siloes'));

  const isOpen = (area: Area) => area.id === current?.id || open.includes(area.id);
  const toggle = (area: Area) => setOpen(open.includes(area.id) ? open.filter((id) => id !== area.id) : [...open, area.id]);

  return (
    <nav className={[styles.sidebar, collapsed ? styles.collapsed : '', mobileOpen ? styles.mobileOpen : ''].join(' ')} aria-label="Main">
      <OrganisationSwitcher collapsed={collapsed} />
      <ul className={styles.areas}>
        {areas.map((area) => {
          const item = rail.get(area.id as never);
          const needs = item !== undefined && !item.available && item.needs !== null
            ? `Needs the ${item.needs.class} permission class (${item.needs.permissions.join(', ')})` : undefined;
          const active = area.id === current?.id;
          if (collapsed) return <CollapsedArea key={area.id} area={area} active={active} needs={needs} gate={gate} currentPlace={currentPlace?.place} />;
          const single = area.sections.length === 1;
          const expanded = !single && isOpen(area);
          return (
            <li key={area.id} className={styles.area}>
              <div className={[styles.areaRow, active ? styles.activeArea : ''].join(' ')}>
                {needs !== undefined ? (
                  <Tooltip content={needs} side="right">
                    <span className={styles.areaLink} aria-disabled="true" tabIndex={0} aria-describedby={`needs-${area.id}`}>
                      <Icon name={area.icon} size={18} />
                      <span className={styles.areaLabel}>{area.label}</span>
                      <span id={`needs-${area.id}`} className="visually-hidden">{needs}</span>
                    </span>
                  </Tooltip>
                ) : (
                  <Link href={area.href as never} className={styles.areaLink} aria-current={single && active ? 'page' : undefined} title={area.tip}
                    onClick={() => {
                      if (!single && !open.includes(area.id)) setOpen([...open, area.id]);
                      onNavigate();
                    }}>
                    <Icon name={area.icon} size={18} />
                    <span className={styles.areaLabel}>{area.label}</span>
                  </Link>
                )}
                {!single && needs === undefined ? (
                  <button type="button" className={styles.disclose} aria-expanded={expanded} aria-controls={expanded ? `sections-${area.id}` : undefined}
                    aria-label={`${expanded ? 'Hide' : 'Show'} ${area.label} sections`} onClick={() => toggle(area)}>
                    <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
                  </button>
                ) : null}
              </div>
              {expanded ? (
                <ul id={`sections-${area.id}`} className={styles.sections}>
                  {area.sections.map((place) => {
                    const blocked = gate(place);
                    const here = currentPlace?.place === place;
                    return (
                      <li key={place.id}>
                        {blocked !== undefined ? (
                          <Tooltip content={blocked} side="right">
                            <span className={styles.section} aria-disabled="true" tabIndex={0}>
                              {place.label}
                              <span className="visually-hidden">: {blocked}</span>
                            </span>
                          </Tooltip>
                        ) : (
                          <Link href={place.href as never} className={styles.section} aria-current={here ? 'page' : undefined} onClick={onNavigate}>
                            {place.label}
                          </Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className={styles.foot}>
        <button type="button" className={styles.collapse} onClick={() => workspace.setPreferences({ railCollapsed: !workspace.preferences.railCollapsed })}
          aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} aria-keyshortcuts="Control+B Meta+B" title={collapsed ? 'Expand the sidebar (Ctrl B)' : 'Collapse the sidebar (Ctrl B)'}>
          <Icon name={collapsed ? 'sidebarExpand' : 'sidebarCollapse'} size={18} />
          {collapsed ? null : <span>Collapse</span>}
        </button>
      </div>
    </nav>
  );
}

function CollapsedArea({ area, active, needs, gate, currentPlace }: { area: Area; active: boolean; needs: string | undefined; gate: (place: Place) => string | undefined; currentPlace: Place | undefined }) {
  if (needs !== undefined) {
    return (
      <li className={styles.area}>
        <Tooltip content={`${area.label}: ${needs}`} side="right">
          <span className={[styles.iconLink, active ? styles.activeArea : ''].join(' ')} aria-disabled="true" tabIndex={0} aria-label={`${area.label}: ${needs}`}>
            <Icon name={area.icon} size={18} />
          </span>
        </Tooltip>
      </li>
    );
  }
  if (area.sections.length === 1) {
    return (
      <li className={styles.area}>
        <Tooltip content={area.label} side="right">
          <Link href={area.href as never} className={[styles.iconLink, active ? styles.activeArea : ''].join(' ')} aria-label={area.label} aria-current={active ? 'page' : undefined}>
            <Icon name={area.icon} size={18} />
          </Link>
        </Tooltip>
      </li>
    );
  }
  const items: MenuEntry[] = [
    { group: area.label },
    ...area.sections.map((place): MenuEntry => ({
      label: place.label, href: place.href, blocked: gate(place), checked: undefined,
      description: currentPlace === place ? 'You are here' : undefined,
    })),
  ];
  return (
    <li className={styles.area}>
      <Menu label={area.label} items={items} side="right" align="start" renderTrigger={(props) => (
        <Tooltip content={area.label} side="right">
          <button type="button" {...props} className={[styles.iconLink, active ? styles.activeArea : ''].join(' ')} aria-label={area.label}>
            <Icon name={area.icon} size={18} />
          </button>
        </Tooltip>
      )} />
    </li>
  );
}

function OrganisationSwitcher({ collapsed }: { collapsed: boolean }) {
  const workspace = useWorkspace();
  const current = workspace.memberships.find((m) => m.current);
  const others = workspace.memberships.filter((m) => !m.current && m.status === 'active');
  const name = current?.organisationName ?? 'Your organisation';
  const cell = workspace.residency?.location;
  const logo = useOrganisationLogo();
  const items: MenuEntry[] = [
    { group: 'Organisations' },
    { label: name, description: cell, checked: true },
    ...others.map((m): MenuEntry => ({ label: m.organisationName, checked: false, onSelect: () => void workspace.switchOrganisation(m.organisationId) })),
    { separator: true },
    { label: 'All organisations', icon: 'building', href: '/account/organisations/' },
  ];
  return (
    <div className={styles.head}>
      <Menu label="Switch organisation" items={items} side={collapsed ? 'right' : 'bottom'} align="start" renderTrigger={(props) => (
        <button type="button" {...props} className={styles.org} aria-label={`${name}${cell === undefined ? '' : `, cell ${cell}`}. Switch organisation`}>
          {logo.url !== undefined
            ? <img src={logo.url} alt="" className={styles.orgLogo} />
            : <span className={styles.orgMark} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
          {collapsed ? null : (
            <>
              <span className={styles.orgText}>
                <span className={styles.orgName}>{name}</span>
                {cell !== undefined ? <span className={styles.orgCell}>{cell}</span> : null}
              </span>
              <Icon name="chevronDown" size={14} />
            </>
          )}
        </button>
      )} />
    </div>
  );
}
