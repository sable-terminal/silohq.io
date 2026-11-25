'use client';

// The status line (spec 33.2), at the foot of every page: the page's freshness and
// incompleteness as the page states it, then the connection and the Lens in use.

import { useClientStatus } from '../data/query.data.ts';
import { useWorkspace } from './context.shell.tsx';
import styles from './status.shell.module.css';

export function StatusLine() {
  const workspace = useWorkspace();
  const status = useClientStatus();
  return (
    <footer className={styles.status}>
      <span role="status" aria-live="polite" className={styles.page}>{workspace.page.status ?? 'Ready'}</span>
      <span className={styles.facts}>
        {workspace.lens !== undefined ? <span>Lens: {workspace.lens.name}</span> : null}
        {status.paused ? <span>Changes paused</span> : null}
        <span>{status.offline ? 'Offline' : 'Connected'}</span>
        {workspace.residency !== undefined ? <span>Cell: {workspace.residency.location}</span> : null}
      </span>
    </footer>
  );
}
