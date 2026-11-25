'use client';

// The header. From the left: search (/ or Cmd-K), the + menu, the Lens chip (spec 38.9). On the
// right, from the outside in: Profile at the edge, then Tickets, Help, Notifications and Settings.
// Below 900 px wide the sidebar becomes a drawer, opened from the menu button at the far left.

import { IconButton, LinkButton } from '../components/button.component.tsx';
import { Icon } from '../components/icon.component.tsx';
import { Popover } from '../components/popover.component.tsx';
import { useQuery } from '../data/query.data.ts';
import { CreateMenu } from './create.shell.tsx';
import { useWorkspace, type PanelName } from './context.shell.tsx';
import { HelpPanel } from './help.shell.tsx';
import { LensChip } from './lens.shell.tsx';
import { NotificationsPanel } from './notifications.shell.tsx';
import { ProfileMenu } from './profile.shell.tsx';
import { TicketsPanel } from './tickets.shell.tsx';
import { useTicketsWaiting } from '../views/support/tickets.view.tsx';
import styles from './header.shell.module.css';

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** A header panel opened from its icon, or from anywhere through the workspace (a shortcut, a link in another panel). */
function HeaderPanel({ name, label, icon, badge, children, wide }: {
  name: PanelName;
  label: string;
  icon: 'bell' | 'help' | 'ticket';
  badge?: number | undefined;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const workspace = useWorkspace();
  return (
    <Popover label={label} open={workspace.panel?.name === name} side="bottom" align="end" initialFocus="first"
      className={wide ? styles.widePanel : styles.panel}
      onOpenChange={(open) => (open ? workspace.panel?.name !== name && workspace.openPanel(name) : workspace.panel?.name === name && workspace.closePanel())}
      renderTrigger={(props) => <IconButton {...props} label={label} icon={icon} badge={badge} />}>
      {children}
    </Popover>
  );
}

export function Header({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const workspace = useWorkspace();
  const unread = useQuery('listNotifications', { query: { unread: 'true', limit: 50 } }, { refreshMs: 60_000, staleMs: 30_000 });
  const unreadCount = unread.data?.notifications.length;
  const ticketsWaiting = useTicketsWaiting();
  return (
    <header className={styles.header}>
      <div className={styles.start}>
        <IconButton className={styles.menuButton} label="Open the menu" icon="sidebarExpand" onClick={onOpenSidebar} />
        <button type="button" className={styles.search} onClick={() => workspace.openPanel('search')} aria-keyshortcuts="/ Control+K Meta+K"
          aria-label="Search objects, apps, pages and commands">
          <Icon name="search" size={16} />
          <span className={styles.searchText}>Search objects, apps, pages and commands</span>
          <kbd className={styles.kbd}>/</kbd>
          <kbd className={styles.kbdWide}>{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <CreateMenu />
        <LensChip />
      </div>
      <div className={styles.end}>
        <LinkButton href="/settings/" variant="ghost" icon="settings" label="Settings" />
        <HeaderPanel name="notifications" label="Notifications" icon="bell" badge={unreadCount}>
          <NotificationsPanel />
        </HeaderPanel>
        <HeaderPanel name="help" label="Help centre" icon="help" wide>
          <HelpPanel />
        </HeaderPanel>
        <HeaderPanel name="tickets" label="Support tickets" icon="ticket" badge={ticketsWaiting} wide>
          <TicketsPanel />
        </HeaderPanel>
        <ProfileMenu />
      </div>
    </header>
  );
}
