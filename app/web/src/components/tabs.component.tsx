'use client';

// Tabs within a page, kept in the URL (?tab=), so a tab can be linked to and Back returns to the
// last one. Arrow keys move between tabs (the tab list is one stop for Tab); a tab the person
// cannot use is shown disabled with the reason. What the current tab shows sits in its TabPanel,
// which the tab controls; `group` keeps the ids of two tab lists on one page apart.

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useParam } from '../hooks/params.hook.ts';
import styles from './tabs.component.module.css';

export interface TabDef<K extends string = string> {
  id: K;
  label: string;
  count?: number | undefined;
  disabled?: string | undefined;
}

export function useTab<K extends string>(tabs: readonly TabDef<K>[], param = 'tab'): [K, (tab: K) => void] {
  const [value, set] = useParam(param);
  const current = tabs.find((t) => t.id === value && t.disabled === undefined)?.id ?? tabs.find((t) => t.disabled === undefined)?.id ?? tabs[0]!.id;
  return [current, (tab: K) => set(tab === tabs[0]!.id ? undefined : tab)];
}

export function Tabs<K extends string>({ tabs, current, onChange, label, group = '' }: {
  tabs: readonly TabDef<K>[]; current: K; onChange: (tab: K) => void; label: string; group?: string;
}) {
  const list = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    const enabled = tabs.filter((t) => t.disabled === undefined);
    const at = enabled.findIndex((t) => t.id === current);
    let next: TabDef<K> | undefined;
    if (event.key === 'ArrowRight') next = enabled[(at + 1) % enabled.length];
    else if (event.key === 'ArrowLeft') next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled[enabled.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    onChange(next.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  return (
    <div ref={list} role="tablist" aria-label={label} className={styles.tabs} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" id={`tab-${group}${tab.id}`} data-tab={tab.id} aria-selected={tab.id === current}
          aria-controls={tab.id === current ? `panel-${group}${tab.id}` : undefined} tabIndex={tab.id === current ? 0 : -1} aria-disabled={tab.disabled !== undefined || undefined}
          title={tab.disabled} className={styles.tab} onClick={() => {
            if (tab.disabled === undefined) onChange(tab.id);
          }}>
          {tab.label}
          {tab.count !== undefined ? <span className={styles.count}>{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** What the current tab shows. `untabbed`: the tab list is not shown (one tab only), so it is not a panel of one. */
export function TabPanel({ id, group = '', untabbed = false, children }: { id: string; group?: string; untabbed?: boolean; children: ReactNode }) {
  if (untabbed) return <>{children}</>;
  return <div role="tabpanel" id={`panel-${group}${id}`} aria-labelledby={`tab-${group}${id}`} className={styles.panel}>{children}</div>;
}
