'use client';

// Search (spec 33.5's Cmd-K, opened by / as well): one field from anywhere. Its list mixes, in
// order: objects matching their title or search properties (pushed down to each source, bounded,
// or read from the Object Index; the method is stated and any source that did not answer is
// named); object types; the saved views, apps, scenarios and threads the person owns or holds a
// share on; every page and setting in Silo; things to create; commands, the page's own first;
// and always last, "Ask: typed text", sent to the Ask panel scoped to this page.
//
// Object search is a typed filter, never a compile: it makes no model call and is never metered.
// Only the last entry invokes Ask.

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../components/icon.component.tsx';
import { Spinner } from '../components/spinner.component.tsx';
import type { Input } from '../api/client.api.ts';
import { useBlocked, useMutation, usePermits, useQuery } from '../data/query.data.ts';
import { readStored, writeStored } from '../hooks/storage.hook.ts';
import { useVocabulary } from '../hooks/vocabulary.hook.ts';
import { useTheme } from '../hooks/theme.hook.ts';
import { CREATE } from '../navigation/create.navigation.ts';
import { PLACES, trailOf } from '../navigation/places.navigation.ts';
import { appHref, hitHref, scenarioHref, threadHref, typeHref, viewHref } from '../navigation/links.navigation.ts';
import { useWorkspace } from './context.shell.tsx';
import styles from './search.shell.module.css';

type Interaction = Extract<NonNullable<Input<'recordWorkspaceInteraction'>['body']>, { event: 'palette_command_run' }>;
const PAGE_COMMANDS: readonly string[] = ['favourite', 'share', 'export', 'switch_representation', 'open_action_form', 'new_app'];

/** What a chosen entry did, in the closed set the workspace records (spec 33.5); undefined for going to a page or a setting. */
function commandOf(entry: { key: string; label: string; detail?: string | undefined }): Interaction['command'] | undefined {
  if (entry.key === 'ask') return 'ask';
  if (entry.key.startsWith('o:')) return 'open_object';
  if (entry.key.startsWith('t:')) return 'open_type';
  if (entry.key.startsWith('Saved view:') || entry.key.startsWith('Saved object set:')) return 'open_view';
  if (entry.key.startsWith('App:')) return 'open_app';
  if (entry.key.startsWith('Scenario:')) return 'open_scenario';
  if (entry.key.startsWith('Ask thread:')) return 'open_thread';
  if (entry.key === 'n:App') return 'new_app';
  const own = entry.key.startsWith('pc:') ? entry.key.slice(3) : undefined;
  return own !== undefined && PAGE_COMMANDS.includes(own) ? own as Interaction['command'] : undefined;
}

/** Where the palette was opened, in the same closed set. */
function pageOf(pathname: string, search: string): Interaction['page'] {
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  if (path === '/' || path === '/home/') return 'home';
  if (path.startsWith('/explorer/object/')) return 'object_view';
  if (path.startsWith('/explorer/')) return 'explorer';
  if (path.startsWith('/ask/views/') && new URLSearchParams(search).has('view')) return 'view';
  if (path.startsWith('/ask/')) return 'ask';
  if (path.startsWith('/clones/canvas/')) return 'canvas';
  if (path.startsWith('/studio/')) return 'studio';
  if (path.startsWith('/settings/')) return 'settings';
  return 'other';
}

interface Entry {
  key: string;
  group: string;
  label: string;
  detail?: string | undefined;
  icon: IconName;
  href?: string | undefined;
  run?: (() => void) | undefined;
  disabled?: string | undefined;
}

export interface Recent { href: string; label: string }
const RECENT_KEY = 'silo.search.recent';

/** Remembers a place the person opened, for the empty search. */
export function rememberPlace(href: string, label: string): void {
  const recent = readStored<Recent[]>(RECENT_KEY, []).filter((r) => r.href !== href);
  writeStored(RECENT_KEY, [{ href, label }, ...recent].slice(0, 6));
}

const matches = (words: readonly string[], ...texts: (string | undefined | readonly string[])[]): boolean => {
  const text = texts.flat().filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
};

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function SearchPalette() {
  const workspace = useWorkspace();
  const open = workspace.panel?.name === 'search';
  const dialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  useEffect(() => {
    const el = dialog.current;
    if (el === null) return undefined;
    const closed = () => {
      if (workspace.panel?.name === 'search') workspace.closePanel();
    };
    const away = (event: MouseEvent) => {
      if (event.target === el) workspace.closePanel();
    };
    el.addEventListener('close', closed);
    el.addEventListener('click', away);
    return () => {
      el.removeEventListener('close', closed);
      el.removeEventListener('click', away);
    };
  }, [workspace]);
  return (
    <dialog ref={dialog} className={styles.dialog} aria-label="Search">
      {open ? <Palette initial={workspace.panel?.query ?? ''} /> : null}
    </dialog>
  );
}

function Palette({ initial }: { initial: string }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [, setTheme] = useTheme();
  const listId = useId();
  const [text, setText] = useState(initial);
  const [active, setActive] = useState(0);
  const typed = text.trim();
  const words = useMemo(() => typed.toLowerCase().split(/\s+/).filter(Boolean), [typed]);
  const query = useDebounced(typed, 200);
  const blockedOf = usePermits();
  const pathname = usePathname();
  const record = useMutation('recordWorkspaceInteraction', { refresh: false });
  const searchBlocked = useBlocked('searchObjects');
  const canSearch = searchBlocked === undefined && query.length >= 2;

  const objects = useQuery('searchObjects', canSearch ? { body: { text: query, surface: 'cmdk', perSourceLimit: 5 } } : null, { keepPrevious: true });
  const types = useQuery('searchVocabulary', canSearch ? { body: { text: query, kinds: ['object_type'], limit: 5, surface: 'cmdk' } } : null, { keepPrevious: true });
  const views = useQuery('listWorkspaceViews', blockedOf('listWorkspaceViews') === undefined && typed !== '' ? {} : null, { staleMs: 60_000 });
  const apps = useQuery('listApps', blockedOf('listApps') === undefined && typed !== '' ? {} : null, { staleMs: 60_000 });
  const scenarios = useQuery('listSimulationScenarios', blockedOf('listSimulationScenarios') === undefined && typed !== '' ? {} : null, { staleMs: 60_000 });
  const threads = useQuery('listAskThreads', typed !== '' ? { query: {} } : null, { staleMs: 60_000 });
  // The types the person may see are already in the browser: matched here at once, without the search index.
  const { data: vocabulary } = useVocabulary();

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    if (typed === '') {
      for (const r of readStored<Recent[]>(RECENT_KEY, [])) list.push({ key: `r:${r.href}`, group: 'Recent', label: r.label, icon: 'clock', href: r.href });
    }
    if (typed.length >= 2) {
      for (const r of objects.data?.results ?? []) {
        list.push({
          key: `o:${r.objectTypeId}:${r.identifier}`, group: 'Objects', icon: 'object',
          label: r.title ?? `${r.objectTypeId.slice(0, 8)} · ${r.identifier}`,
          detail: r.refreshedAt === null ? undefined : 'From the Object Index',
          href: hitHref(r),
        });
      }
      const typeIds = new Set<string>();
      for (const t of vocabulary?.objectTypes ?? []) {
        if (typeIds.size < 5 && matches(words, t.displayName, t.pluralName, t.apiName)) {
          typeIds.add(t.id);
          list.push({ key: `t:${t.id}`, group: 'Object types', icon: 'table', label: t.displayName, detail: 'Open in Explorer', href: typeHref(t.id) });
        }
      }
      for (const h of types.data?.hits ?? []) {
        if (typeIds.has(h.id)) continue;
        typeIds.add(h.id);
        list.push({ key: `t:${h.id}`, group: 'Object types', icon: 'table', label: h.displayName, detail: 'Open in Explorer', href: typeHref(h.id) });
      }
      const saved = (rows: readonly { id: string; name: string; archived: boolean }[], group: string, icon: IconName, href: (id: string) => string) => {
        for (const row of rows) {
          if (!row.archived && matches(words, row.name)) list.push({ key: `${group}:${row.id}`, group: 'Your work', icon, label: row.name, detail: group, href: href(row.id) });
        }
      };
      for (const kind of ['object_set', 'other'] as const) {
        saved((views.data?.views ?? []).filter((v) => (v.kind === 'object_set') === (kind === 'object_set')).map((v) => ({ id: v.id, name: v.name, archived: v.archivedAt !== null })),
          kind === 'object_set' ? 'Saved object set' : 'Saved view', 'star', (id) => viewHref(id, kind));
      }
      saved((apps.data?.apps ?? []).map((a) => ({ id: a.id, name: a.name, archived: a.archivedAt !== null })), 'App', 'studio', (id) => appHref(id));
      saved((scenarios.data?.scenarios ?? []).map((c) => ({ id: c.id, name: c.name, archived: false })), 'Scenario', 'scenarios', scenarioHref);
      saved((threads.data?.threads ?? []).map((t) => ({ id: t.id, name: t.title, archived: t.archivedAt !== null })), 'Ask thread', 'ask', threadHref);
    }
    if (typed !== '') {
      for (const where of PLACES) {
        const p = where.place;
        if (matches(words, p.label, p.purpose, p.keywords ?? [], p.does, trailOf(where))) {
          list.push({ key: `p:${p.href}`, group: 'Pages and settings', icon: p.icon ?? 'arrowRight', label: trailOf(where).join(' › '), detail: p.purpose, href: p.href });
        }
      }
    }
    for (const group of CREATE) {
      for (const item of group.items) {
        if (typed === '' ? group.label !== 'Connect' && group.label !== 'Analyse' : !matches(words, 'new create add', item.label, item.description, item.keywords ?? [])) continue;
        list.push({ key: `n:${item.label}`, group: 'Create', icon: 'plus', label: `New ${item.label.toLowerCase()}`, detail: item.description, href: item.href, disabled: blockedOf(item.route)?.message });
      }
    }
    const commands: Entry[] = [
      ...(workspace.page.commands ?? []).map((c): Entry => ({ key: `pc:${c.id}`, group: 'Commands', icon: 'play', label: c.label, run: c.run, disabled: c.disabled })),
      { key: 'c:sidebar', group: 'Commands', icon: 'sidebarCollapse', label: workspace.preferences.railCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar',
        run: () => workspace.setPreferences({ railCollapsed: !workspace.preferences.railCollapsed }) },
      { key: 'c:ask', group: 'Commands', icon: 'ask', label: workspace.preferences.askPanelOpen ? 'Close the Ask panel' : 'Open the Ask panel',
        run: () => workspace.setPreferences({ askPanelOpen: !workspace.preferences.askPanelOpen }) },
      { key: 'c:light', group: 'Commands', icon: 'sun', label: 'Use the light theme', run: () => setTheme('light') },
      { key: 'c:dark', group: 'Commands', icon: 'moon', label: 'Use the dark theme', run: () => setTheme('dark') },
      { key: 'c:system', group: 'Commands', icon: 'globe', label: 'Match this device\'s theme', run: () => setTheme('system') },
      ...workspace.memberships.filter((m) => !m.current && m.status === 'active').map((m): Entry => ({
        key: `c:org:${m.organisationId}`, group: 'Commands', icon: 'building', label: `Switch to ${m.organisationName}`, run: () => void workspace.switchOrganisation(m.organisationId),
      })),
      { key: 'c:shortcuts', group: 'Commands', icon: 'keyboard', label: 'Show keyboard shortcuts', run: () => workspace.openPanel({ name: 'help', query: 'shortcuts' }) },
      { key: 'c:support', group: 'Commands', icon: 'ticket', label: 'Contact support', run: () => workspace.openPanel({ name: 'tickets', query: 'new' }) },
      { key: 'c:signout', group: 'Commands', icon: 'signOut', label: 'Sign out', run: () => void workspace.signOut() },
    ];
    list.push(...commands.filter((c) => typed === '' ? c.key.startsWith('pc:') : matches(words, c.label)));
    if (typed !== '') {
      const scope = workspace.page.scopeLabel;
      list.push({ key: 'ask', group: 'Ask', icon: 'ask', label: `Ask: ${typed}`, detail: scope === undefined ? 'Answered by Ask, scoped to this page' : `Answered by Ask, scoped to ${scope}`,
        run: () => workspace.askAboutPage(typed), disabled: blockedOf('createAskThread')?.message });
    }
    return list;
  }, [typed, words, objects.data, types.data, vocabulary, views.data, apps.data, scenarios.data, threads.data, workspace, blockedOf, setTheme]);

  useEffect(() => setActive(0), [typed]);
  const activeEntry = entries[Math.min(active, entries.length - 1)];

  const choose = (entry: Entry | undefined, newTab = false) => {
    if (entry === undefined || entry.disabled !== undefined) return;
    const command = commandOf(entry);
    // Reported once chosen, closed sets only; a report that fails changes nothing for the person.
    if (command !== undefined) void record.run({ body: { event: 'palette_command_run', command, page: pageOf(pathname, window.location.search) } });
    if (entry.href !== undefined) {
      if (newTab) {
        window.open(entry.href, '_blank', 'noopener');
        return;
      }
      workspace.closePanel();
      router.push(entry.href as never);
      return;
    }
    workspace.closePanel();
    entry.run?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((a) => Math.min(a + 1, entries.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === 'Home' && event.ctrlKey) {
      setActive(0);
    } else if (event.key === 'End' && event.ctrlKey) {
      setActive(entries.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeEntry, event.metaKey || event.ctrlKey);
    }
  };

  useEffect(() => {
    document.getElementById(`${listId}-${activeEntry?.key ?? ''}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeEntry?.key, listId]);

  const notAnswered = objects.data?.notSearched.filter((n) => n.reason === 'source_unreachable' || n.reason === 'over_bound') ?? [];
  const groups = [...new Set(entries.map((e) => e.group))];
  const searching = canSearch && (objects.fetching || types.fetching);

  return (
    <div className={styles.palette}>
      <div className={styles.field}>
        <Icon name="search" size={18} className={styles.fieldIcon} />
        <input autoFocus className={styles.input} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
          placeholder="Search objects, apps, pages, settings and commands" role="combobox" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={activeEntry === undefined ? undefined : `${listId}-${activeEntry.key}`} aria-autocomplete="list" aria-label="Search" />
        {searching ? <Spinner size={16} /> : null}
        <kbd className={styles.esc}>Esc</kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Results" className={styles.list}>
        {groups.map((group) => (
          <div key={group} role="group" aria-label={group} className={styles.group}>
            <div className={styles.groupLabel} aria-hidden="true">{group}</div>
            {entries.filter((e) => e.group === group).map((entry) => {
              const index = entries.indexOf(entry);
              return (
                <div key={entry.key} id={`${listId}-${entry.key}`} role="option" aria-selected={index === active} aria-disabled={entry.disabled !== undefined || undefined}
                  className={styles.option} onMouseMove={() => setActive(index)} onClick={(e) => choose(entry, e.metaKey || e.ctrlKey)}>
                  <Icon name={entry.icon} size={16} className={styles.optionIcon} />
                  <span className={styles.optionText}>
                    <span className={styles.optionLabel}>{entry.label}</span>
                    {entry.disabled !== undefined || entry.detail !== undefined ? <span className={styles.optionDetail}>{entry.disabled ?? entry.detail}</span> : null}
                  </span>
                  {index === active && entry.disabled === undefined ? <Icon name="arrowRight" size={14} className={styles.optionGo} /> : null}
                </div>
              );
            })}
          </div>
        ))}
        {entries.length === 0 ? <p className={styles.none}>Nothing matches.</p> : null}
      </div>
      <div className={styles.foot} role="status" aria-live="polite">
        {searchBlocked !== undefined && typed.length >= 2 ? <span>Objects are not searched: {searchBlocked.message}</span>
          : objects.data !== undefined && typed.length >= 2 ? (
            <span>
              Objects {objects.data.method === 'index' ? 'from the Object Index' : objects.data.method === 'mixed' ? 'from the sources and the Object Index' : 'searched in each source'}
              {notAnswered.length > 0 ? ` · ${notAnswered.length} source${notAnswered.length === 1 ? '' : 's'} did not answer in time or had too many matches` : ''}
            </span>
          ) : <span>Type to search. ↑↓ to move, Enter to open, Ctrl Enter for a new tab.</span>}
      </div>
    </div>
  );
}
