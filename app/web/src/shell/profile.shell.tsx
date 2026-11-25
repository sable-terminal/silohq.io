'use client';

// The profile menu, at the header's right edge: who is signed in and where, their own pages,
// the theme on this device, keyboard shortcuts, and signing out.

import { IconButton } from '../components/button.component.tsx';
import { Menu, type MenuEntry } from '../components/menu.component.tsx';
import { useTheme } from '../hooks/theme.hook.ts';
import { ACCOUNT } from '../navigation/account.navigation.ts';
import { useWorkspace } from './context.shell.tsx';
import styles from './profile.shell.module.css';

export function ProfileMenu() {
  const workspace = useWorkspace();
  const [theme, setTheme] = useTheme();
  const person = workspace.person;
  const organisation = workspace.memberships.find((m) => m.current)?.organisationName;
  const name = `${person.firstName} ${person.lastName}`.trim() || person.email;
  const items: MenuEntry[] = [
    ...ACCOUNT.map((place): MenuEntry => ({ label: place.label, icon: place.icon, href: place.href })),
    { separator: true },
    { group: 'Theme on this device' },
    { label: 'Match this device', icon: 'globe', checked: theme === 'system', onSelect: () => setTheme('system') },
    { label: 'Light', icon: 'sun', checked: theme === 'light', onSelect: () => setTheme('light') },
    { label: 'Dark', icon: 'moon', checked: theme === 'dark', onSelect: () => setTheme('dark') },
    { separator: true },
    { label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: '?', onSelect: () => workspace.openPanel({ name: 'help', query: 'shortcuts' }) },
    { label: 'Sign out', icon: 'signOut', onSelect: () => void workspace.signOut() },
  ];
  return (
    <Menu label="Your account" items={items} side="bottom" align="end"
      header={(
        <div className={styles.who}>
          <span className={styles.name}>{name}</span>
          {name !== person.email ? <span className={styles.detail}>{person.email}</span> : null}
          {organisation !== undefined ? <span className={styles.detail}>{organisation}</span> : null}
        </div>
      )}
      renderTrigger={(props) => (
        <IconButton {...props} label={`Your account: ${name}`} icon="user" className={styles.avatar} />
      )} />
  );
}
