'use client';

// The workspace frame: the sidebar, the header, the organisation's banners, the page, the Ask
// panel and the status line (spec 33.2's five regions), with the keyboard shortcuts, toasts, and
// the search palette. Each region fails on its own: a fault in the page leaves the frame working.

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Boundary } from '../components/boundary.component.tsx';
import { ErrorState, Loading } from '../components/states.component.tsx';
import { ToastProvider } from '../components/toast.component.tsx';
import { useClientStatus } from '../data/query.data.ts';
import { placeOf, trailOf } from '../navigation/places.navigation.ts';
import { AskPanel } from './ask.shell.tsx';
import { Banners } from './banners.shell.tsx';
import { useWorkspace, WorkspaceProvider } from './context.shell.tsx';
import { Header } from './header.shell.tsx';
import { rememberPlace, SearchPalette } from './search.shell.tsx';
import { typing } from './shortcuts.shell.ts';
import { Sidebar } from './sidebar.shell.tsx';
import { StatusLine } from './status.shell.tsx';
import styles from './workspace.shell.module.css';

function Frame({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Places opened, for search's recent list.
  useEffect(() => {
    const where = placeOf(pathname);
    if (where !== undefined) rememberPlace(where.place.href, trailOf(where).join(' › '));
    setMobileOpen(false);
  }, [pathname]);

  // A failure anywhere asked to contact support: open a ticket quoting it.
  useEffect(() => {
    const support = (event: Event) => {
      const detail = (event as CustomEvent<{ correlationId?: string; route?: string }>).detail ?? {};
      workspace.openPanel({ name: 'tickets', query: 'new', correlationId: detail.correlationId, route: detail.route });
    };
    window.addEventListener('silo:support', support);
    return () => window.removeEventListener('silo:support', support);
  }, [workspace]);

  // Keyboard shortcuts (shortcuts.shell.ts).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'k') {
        event.preventDefault();
        workspace.openPanel('search');
        return;
      }
      if (mod && key === 'b') {
        event.preventDefault();
        workspace.setPreferences({ railCollapsed: !workspace.preferences.railCollapsed });
        return;
      }
      if (mod && key === 'j') {
        event.preventDefault();
        workspace.setPreferences({ askPanelOpen: !workspace.preferences.askPanelOpen });
        return;
      }
      if (mod || event.altKey || typing(event.target) || document.querySelector('dialog[open]') !== null) return;
      if (event.key === '/') {
        event.preventDefault();
        workspace.openPanel('search');
      } else if (event.key === '?') {
        event.preventDefault();
        workspace.openPanel({ name: 'help', query: 'shortcuts' });
      } else if (key === 'n') {
        event.preventDefault();
        workspace.openPanel('create');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspace]);

  return (
    <div className={styles.frame}>
      <a href="#main" className="skip-link">Skip to the page</a>
      <Boundary what="The sidebar">
        <Sidebar mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />
      </Boundary>
      {mobileOpen ? <button type="button" className={styles.scrim} aria-label="Close the menu" onClick={() => setMobileOpen(false)} /> : null}
      <div className={styles.column}>
        <Boundary what="The header">
          <Header onOpenSidebar={() => setMobileOpen(true)} />
        </Boundary>
        <Banners />
        <div className={styles.row}>
          <main id="main" className={styles.main} tabIndex={-1}>
            <Boundary what="This page" resetKey={pathname}>{children}</Boundary>
          </main>
          <Boundary what="The Ask panel">
            <AskPanel />
          </Boundary>
        </div>
        <StatusLine />
      </div>
      <SearchPalette />
    </div>
  );
}

/** Opening, and why it is taking a while when the reason is known: offline, or asked to wait. */
function Opening() {
  const status = useClientStatus();
  const label = status.offline ? 'Opening Silo: waiting for the network' : status.overloadedUntil !== undefined ? 'Opening Silo: it asked us to wait a moment, and will be tried again' : 'Opening Silo';
  return <Loading label={label} delayMs={0} />;
}

export function Workspace({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <WorkspaceProvider fallback={(opening) => (
        <main id="main" className={styles.opening}>
          {opening.state === 'opening' ? <Opening /> : <ErrorState error={opening.error} what="Silo" onRetry={opening.retry} />}
        </main>
      )}>
        <Frame>{children}</Frame>
      </WorkspaceProvider>
    </ToastProvider>
  );
}
